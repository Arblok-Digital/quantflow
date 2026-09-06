import { createHmac, createHash } from "node:crypto";
import { getExchange, ensureMarketsLoaded } from "./broker";
import {
  initDb,
  getDb,
  savePositionDb,
  saveOrderDb,
  saveFillDb,
  saveSnapshotDb,
  loadOpenPositionsDb,
  loadAllOrdersDb,
  getLatestSnapshotDb,
  getDbFilePath,
  appendAudit,
} from "./db";

// ================= PAPER POSITION BOOK =================
// Source of truth for PAPER trading. Persisted to SQLite (trading.db) via db.ts.
// Init rehydrates OPEN positions from DB. All fills measured against real ccxt data.

export const TAKER_FEE_RATE = 0.0004;
export const INITIAL_PAPER_CASH = 10000;
export const MAINTENANCE_MARGIN_RATE = 0.005;
export const MAX_LEVERAGE = 50;
export const ORDERBOOK_LEVELS = 20;
export const EVENT_RING_SIZE = 200;
export const MARK_TTL_MS = 3000;
export const ERROR_LOG_THROTTLE_MS = 30000;

export type PaperSide = "LONG" | "SHORT";
export type PaperPositionStatus = "OPEN" | "CLOSED";
export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL";
export type PaperEventType =
  | "ORDER_FILLED"
  | "POSITION_CLOSED"
  | "BRACKET_MONITOR_ACTION"
  | "POSITION_UPDATED"
  | "ERROR";

export interface PaperPosition {
  id: string;
  symbol: string;
  side: PaperSide;
  qty: number;
  entryPrice: number;
  notionalUSD: number;
  leverage: number;
  marginUSD: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  openedAt: number;
  status: PaperPositionStatus;
  entryReasoning?: string;
  confidence?: number;
  timeframe?: string;
  marketType?: string;
  targetPool?: string;
  sourceOrderId: string;
  lastMark?: number;
  lastMarkUpdatedAt?: number;
  closedAt?: number;
  exitPrice?: number;
  exitReason?: ExitReason;
  realizedPnlUSD?: number;
  feesPaidUSD: number;
}

export interface PaperOrderReceipt {
  id: string;
  mode: "paper";
  symbol: string;
  side: "buy" | "sell";
  type: string;
  amount: number;
  fillPrice?: number;
  slippageBps?: number;
  feeUSD: number;
  qty: number;
  notional?: number;
  leverage?: number;
  marginRequired?: number;
  executionLatencyMs?: number;
  timestamp: number;
  status: "FILLED" | "REJECTED";
  positionId?: string;
  reason?: string;
  signature: string;
  payloadHash: string;
}

export interface PaperEvent {
  seq: number;
  timestamp: number;
  type: PaperEventType;
  payload: Record<string, unknown>;
}

export interface PaperAccountSnapshot {
  cash: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openCount: number;
  marginLocked: number;
}

export interface PaperBalanceEntry {
  currency: string;
  free: number;
  used: number;
  total: number;
}

interface PaperBookState {
  positions: PaperPosition[];
  orders: PaperOrderReceipt[];
  events: PaperEvent[];
  seq: number;
  idSeq: number;
  cash: number;
  realizedPnl: number;
}

export class PaperOrderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PaperOrderError";
    this.code = code;
  }
}

function roundTo(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}
const r2 = (n: number) => roundTo(Number(n), 2);
const r3 = (n: number) => roundTo(Number(n), 3);
const r4 = (n: number) => roundTo(Number(n), 4);
const r6 = (n: number) => roundTo(Number(n), 6);

let state: PaperBookState = {
  positions: [],
  orders: [],
  events: [],
  seq: 0,
  idSeq: 0,
  cash: INITIAL_PAPER_CASH,
  realizedPnl: 0,
};
let bookInitialized = false;

function freshState(): PaperBookState {
  return {
    positions: [],
    orders: [],
    events: [],
    seq: 0,
    idSeq: 0,
    cash: INITIAL_PAPER_CASH,
    realizedPnl: 0,
  };
}

// ------------------------------------------------------------------
// DB helpers
// ------------------------------------------------------------------
function persistSnapshot(): void {
  try {
    const open = state.positions.filter((p) => p.status === "OPEN");
    const marginLocked = open.reduce((sum, p) => sum + p.marginUSD, 0);
    const unrealized = open.reduce((sum, p) => sum + unrealizedPnlFor(p), 0);
    const equity = state.cash + marginLocked + unrealized;
    saveSnapshotDb({
      ts: Date.now(),
      cash: r2(state.cash),
      margin_used: r2(marginLocked),
      equity: r2(equity),
      unrealized_pnl: r2(unrealized),
    });
  } catch (err) {
    console.warn(`[paperBook] Gagal persist snapshot: ${(err as Error).message}`);
  }
}

function dbSavePosition(pos: PaperPosition): void {
  try {
    savePositionDb({
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entry_price: pos.entryPrice,
      amount: pos.qty,
      leverage: pos.leverage,
      stop_loss: pos.stopLoss ?? null,
      take_profit: pos.takeProfit ?? null,
      liq_price: pos.liquidationPrice ?? null,
      status: pos.status,
      opened_at: pos.openedAt,
      closed_at: pos.closedAt ?? null,
      close_price: pos.exitPrice ?? null,
      realized_pnl_usd: pos.realizedPnlUSD ?? null,
      fees_usd: pos.feesPaidUSD ?? null,
    });
  } catch (err) {
    console.warn(`[paperBook] Gagal save position ${pos.id}: ${(err as Error).message}`);
  }
}

function dbSaveOrder(order: PaperOrderReceipt): void {
  try {
    // price = fillPrice, stop_loss/take_profit not directly in receipt — try to find linked position
    let sl: number | null = null;
    let tp: number | null = null;
    if (order.positionId) {
      const linked = state.positions.find((p) => p.id === order.positionId);
      if (linked) {
        sl = linked.stopLoss ?? null;
        tp = linked.takeProfit ?? null;
      }
    }
    saveOrderDb({
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: order.status,
      amount: order.amount,
      price: order.fillPrice ?? null,
      stop_loss: sl,
      take_profit: tp,
      leverage: order.leverage ?? null,
      slippage_bps: order.slippageBps ?? null,
      mode: order.mode ?? null,
      created_at: order.timestamp,
      closed_at: null,
      realized_pnl_usd: null,
    });
    // also save fills row
    if (order.fillPrice != null) {
      const fillId = `fill-${order.id}`;
      saveFillDb({
        id: fillId,
        order_id: order.id,
        symbol: order.symbol,
        side: order.side,
        price: order.fillPrice,
        amount: order.amount,
        fee_usd: order.feeUSD,
        created_at: order.timestamp,
      });
    }
  } catch (err) {
    console.warn(`[paperBook] Gagal save order ${order.id}: ${(err as Error).message}`);
  }
}

function deriveIdSeqFromRows(): number {
  let max = 0;
  const extract = (id: string) => {
    const parts = id.split("-");
    const last = parts[parts.length - 1];
    const n = parseInt(last, 10);
    if (isFinite(n) && n > max) max = n;
  };
  for (const p of state.positions) extract(p.id);
  for (const o of state.orders) extract(o.id);
  return max;
}

export function initPaperBook(): void {
  if (bookInitialized) return;
  bookInitialized = true;
  initDb();
  try {
    const db = getDb();
    // Load OPEN positions
    const openRows = loadOpenPositionsDb();
    const latestSnap = getLatestSnapshotDb();

    // Load orders (for getPaperOrder)
    const orderRows = loadAllOrdersDb();

    // Reconstruct orders -> PaperOrderReceipt (minimal)
    const orders: PaperOrderReceipt[] = orderRows.map((r: any) => ({
      id: String(r.id),
      mode: (r.mode as "paper") || "paper",
      symbol: String(r.symbol),
      side: (String(r.side).toLowerCase() === "sell" ? "sell" : "buy") as "buy" | "sell",
      type: String(r.type),
      amount: Number(r.amount),
      fillPrice: r.price != null ? Number(r.price) : undefined,
      slippageBps: r.slippage_bps != null ? Number(r.slippage_bps) : undefined,
      feeUSD: 0, // fee stored in fills, fallback 0; try to fetch from fills
      qty: Number(r.amount),
      notional: r.price != null ? r2(Number(r.price) * Number(r.amount)) : undefined,
      leverage: r.leverage != null ? Number(r.leverage) : undefined,
      marginRequired: undefined,
      executionLatencyMs: undefined,
      timestamp: Number(r.created_at),
      status: (String(r.status).toUpperCase() === "REJECTED" ? "REJECTED" : "FILLED") as "FILLED" | "REJECTED",
      positionId: undefined,
      signature: "",
      payloadHash: "",
    }));
    // Enrich feeUSD from fills table if available
    try {
      const fills = db.prepare("SELECT order_id, fee_usd FROM fills").all() as any[];
      const fillMap = new Map<string, number>();
      for (const f of fills) fillMap.set(String(f.order_id), Number(f.fee_usd));
      for (const o of orders) {
        const fee = fillMap.get(o.id);
        if (fee != null) (o as any).feeUSD = fee;
      }
    } catch {}

    // Reconstruct positions
    const positions: PaperPosition[] = openRows.map((r: any) => {
      const entryPrice = Number(r.entry_price);
      const qty = Number(r.amount);
      const leverage = Number(r.leverage);
      const notional = entryPrice * qty;
      const marginUSD = notional / (leverage || 1);
      return {
        id: String(r.id),
        symbol: String(r.symbol),
        side: String(r.side) as PaperSide,
        qty,
        entryPrice,
        notionalUSD: r2(notional),
        leverage: r2(leverage),
        marginUSD: r2(marginUSD),
        stopLoss: r.stop_loss != null ? Number(r.stop_loss) : 0,
        takeProfit: r.take_profit != null ? Number(r.take_profit) : 0,
        liquidationPrice: r.liq_price != null ? Number(r.liq_price) : liquidationPrice(entryPrice, leverage, String(r.side) as PaperSide),
        openedAt: Number(r.opened_at),
        status: String(r.status) as PaperPositionStatus,
        sourceOrderId: String(r.id),
        lastMark: entryPrice,
        lastMarkUpdatedAt: Date.now(),
        feesPaidUSD: r.fees_usd != null ? Number(r.fees_usd) : r4(entryPrice * qty * TAKER_FEE_RATE),
      };
    });

    // Derive cash & realizedPnl
    let cash: number;
    let realizedPnl = 0;
    if (latestSnap) {
      cash = Number(latestSnap.cash);
    } else {
      // No snapshot yet: cash = initial - locked margin
      const locked = positions.reduce((s, p) => s + p.marginUSD, 0);
      cash = r2(INITIAL_PAPER_CASH - locked);
    }
    // Realized PnL = sum of closed positions
    try {
      const closedSum = db.prepare("SELECT SUM(realized_pnl_usd) as sumReal FROM positions WHERE status='CLOSED'").get() as any;
      if (closedSum?.sumReal != null) realizedPnl = r2(Number(closedSum.sumReal));
    } catch {}

    state = {
      positions,
      orders,
      events: [],
      seq: 0,
      idSeq: 0,
      cash,
      realizedPnl,
    };
    state.idSeq = deriveIdSeqFromRows();
    // seq for events: start from 0 (volatile); could also set to max audit seq for continuity but not required
    try {
      const auditMax = db.prepare("SELECT MAX(seq) as m FROM audit_ledger").get() as any;
      if (auditMax?.m != null) state.seq = Number(auditMax.m) || 0;
    } catch {}

    console.log(`[paperBook] Rehydrated ${state.positions.length} OPEN positions, ${state.orders.length} orders dari SQLite (cash ${state.cash}, realized ${state.realizedPnl})`);
    // Ensure at least one snapshot exists for stats
    if (!latestSnap) persistSnapshot();
  } catch (err) {
    console.warn(`[paperBook] Gagal rehydrate dari DB, mulai dari state kosong: ${(err as Error).message}`);
    state = freshState();
    persistSnapshot();
  }
}

function appendEvent(type: PaperEventType, payload: Record<string, unknown>): void {
  state.seq += 1;
  state.events.push({ seq: state.seq, timestamp: Date.now(), type, payload });
  if (state.events.length > EVENT_RING_SIZE) {
    state.events.shift();
  }
}

function newId(prefix: string): string {
  state.idSeq += 1;
  return `${prefix}-${Date.now()}-${state.idSeq}`;
}

// ------------------------------------------------------------------
// Data access (read-only)
// ------------------------------------------------------------------
export function getPaperPositions(): PaperPosition[] {
  return state.positions.map((p) => ({ ...p }));
}

export function getPaperOrder(orderId: string): PaperOrderReceipt | undefined {
  const order = state.orders.find((o) => o.id === orderId);
  return order ? { ...order } : undefined;
}

export function getPaperEvents(sinceSeq: number): PaperEvent[] {
  return state.events.filter((e) => e.seq > sinceSeq).map((e) => ({ ...e, payload: { ...e.payload } }));
}

export function getLatestEventSeq(): number {
  return state.seq;
}

function unrealizedPnlFor(pos: PaperPosition): number {
  const mark = pos.lastMark ?? pos.entryPrice;
  return pos.side === "LONG" ? (mark - pos.entryPrice) * pos.qty : (pos.entryPrice - mark) * pos.qty;
}

export function getPaperAccount(): PaperAccountSnapshot {
  const open = state.positions.filter((p) => p.status === "OPEN");
  const marginLocked = open.reduce((sum, p) => sum + p.marginUSD, 0);
  const unrealized = open.reduce((sum, p) => sum + unrealizedPnlFor(p), 0);
  const equity = state.cash + marginLocked + unrealized;
  return {
    cash: r2(state.cash),
    equity: r2(equity),
    unrealizedPnl: r2(unrealized),
    realizedPnl: r2(state.realizedPnl),
    openCount: open.length,
    marginLocked: r2(marginLocked),
  };
}

export function getPaperBalance(): PaperBalanceEntry[] {
  const account = getPaperAccount();
  return [
    {
      currency: "USDT",
      free: account.cash,
      used: account.marginLocked,
      total: r2(account.cash + account.marginLocked),
    },
  ];
}

// ------------------------------------------------------------------
// Symbol normalization
// ------------------------------------------------------------------
const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "FDUSD", "BTC", "ETH", "EUR", "USD"];

export function normalizeSymbol(rawSymbol: string): string {
  const s = String(rawSymbol || "").trim().toUpperCase();
  if (!s) throw new PaperOrderError("INVALID_SYMBOL", "symbol wajib diisi.");
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    return parts.slice(0, 2).join("/");
  }
  for (const quote of KNOWN_QUOTES) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return `${s.slice(0, -quote.length)}/${quote}`;
    }
  }
  throw new PaperOrderError("INVALID_SYMBOL", `Format symbol tidak dikenal: ${s} (harap pakai BASE/QUOTE).`);
}

export function signPayload(payload: string): { signature: string; payloadHash: string } {
  const secret = process.env.BROKER_EVENT_SECRET || "paper-dev-secret";
  const payloadHash = createHash("sha256").update(payload, "utf-8").digest("hex");
  const signature = createHmac("sha256", secret).update(payload, "utf-8").digest("hex");
  return { signature, payloadHash };
}

// ------------------------------------------------------------------
// Fill engine
// ------------------------------------------------------------------
interface FillResult {
  fillPrice: number;
  slippageBps: number;
  feeUSD: number;
  method: "ORDERBOOK" | "TICKER";
  latencyMs: number;
}

async function marketFill(
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  triggerPrice?: number,
  bracketMode: "none" | "stop" | "profit" = "none"
): Promise<FillResult> {
  const t0 = Date.now();
  const exchange = getExchange();
  await ensureMarketsLoaded(exchange);

  try {
    const book = await exchange.fetchOrderBook(symbol, ORDERBOOK_LEVELS);
    const asks: number[][] = book.asks || [];
    const bids: number[][] = book.bids || [];
    if (asks.length > 0 && bids.length > 0) {
      const bestAsk = Number(asks[0][0]);
      const bestBid = Number(bids[0][0]);
      const mid = (bestAsk + bestBid) / 2;
      const ladder = side === "buy" ? asks : bids;
      let remaining = qty;
      let weightedSum = 0;
      for (const level of ladder) {
        if (remaining <= 0) break;
        const price = Number(level[0]);
        const size = Number(level[1]);
        const take = Math.min(remaining, size);
        weightedSum += price * take;
        remaining -= take;
      }
      if (remaining > 0) {
        const worst = ladder.length > 0 ? Number(ladder[ladder.length - 1][0]) : mid;
        weightedSum += worst * remaining;
      }
      let fillPrice = weightedSum / qty;
      if (bracketMode !== "none" && triggerPrice !== undefined && triggerPrice > 0) {
        fillPrice = side === "buy" ? Math.max(triggerPrice, fillPrice) : Math.min(triggerPrice, fillPrice);
      }
      const slippageBps = (Math.abs(fillPrice - mid) / mid) * 10000;
      return {
        fillPrice: r6(fillPrice),
        slippageBps: r2(slippageBps),
        feeUSD: r4(fillPrice * qty * TAKER_FEE_RATE),
        method: "ORDERBOOK",
        latencyMs: Date.now() - t0,
      };
    }
  } catch {}

  try {
    const ticker = await exchange.fetchTicker(symbol);
    const bid = Number(ticker.bid);
    const ask = Number(ticker.ask);
    if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) {
      throw new PaperOrderError("NO_PRICE", `Tidak ada harga (bid/ask) untuk ${symbol}.`);
    }
    const mid = (bid + ask) / 2;
    let fillPrice = side === "buy" ? ask : bid;
    if (bracketMode !== "none" && triggerPrice !== undefined && triggerPrice > 0) {
      fillPrice = side === "buy" ? Math.max(triggerPrice, fillPrice) : Math.min(triggerPrice, fillPrice);
    }
    const slippageBps = (Math.abs(fillPrice - mid) / mid) * 10000;
    return {
      fillPrice: r6(fillPrice),
      slippageBps: r2(slippageBps),
      feeUSD: r4(fillPrice * qty * TAKER_FEE_RATE),
      method: "TICKER",
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    if (err instanceof PaperOrderError) throw err;
    throw new PaperOrderError("NO_PRICE", `Tidak ada harga untuk ${symbol}: ${(err as Error).message}`);
  }
}

export function liquidationPrice(entryPrice: number, leverage: number, side: PaperSide): number {
  const lev = leverage > 0 ? leverage : 1;
  if (side === "LONG") {
    return r6(entryPrice * (1 - 1 / lev + MAINTENANCE_MARGIN_RATE));
  }
  return r6(entryPrice * (1 + 1 / lev - MAINTENANCE_MARGIN_RATE));
}

// ------------------------------------------------------------------
// Open / close / update
// ------------------------------------------------------------------
export interface PaperOrderMeta {
  reasoning?: string;
  confidence?: number;
  timeframe?: string;
  marketType?: string;
  targetPool?: string;
}

export interface OpenPaperPositionInput {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  meta?: PaperOrderMeta;
}

export interface OpenPaperPositionResult {
  position: PaperPosition;
  order: PaperOrderReceipt;
  account: PaperAccountSnapshot;
}

export async function openPaperPosition(input: OpenPaperPositionInput): Promise<OpenPaperPositionResult> {
  const qty = Number(input.qty);
  if (!isFinite(qty) || qty <= 0) {
    throw new PaperOrderError("INVALID_QTY", "qty harus angka positif.");
  }
  const side: PaperSide = input.side === "sell" ? "SHORT" : "LONG";
  const direction = input.side === "sell" ? "sell" : "buy";
  const leverage = input.leverage && input.leverage > 0 ? Math.min(MAX_LEVERAGE, Number(input.leverage)) : 1;
  const symbol = normalizeSymbol(input.symbol);
  const stopLoss = Number(input.stopLoss);
  const takeProfit = Number(input.takeProfit);
  if (!isFinite(stopLoss) || stopLoss <= 0 || !isFinite(takeProfit) || takeProfit <= 0) {
    throw new PaperOrderError("MISSING_STOP", "stopLoss dan takeProfit wajib diisi untuk posisi baru.");
  }

  const duplicate = state.positions.find((p) => p.symbol === symbol && p.side === side && p.status === "OPEN");
  if (duplicate) {
    throw new PaperOrderError(
      "DUPLICATE_POSITION_DIRECTION",
      `Sudah ada posisi ${side} ${symbol} yang masih OPEN (${duplicate.id}). Tutup atau jangan duplikat arah.`
    );
  }

  const fill = await marketFill(symbol, direction, qty);
  const entryPrice = fill.fillPrice;

  if (side === "LONG" && !(stopLoss < entryPrice && entryPrice < takeProfit)) {
    throw new PaperOrderError("INVALID_STOP", "Untuk LONG: stopLoss harus < entryPrice < takeProfit.");
  }
  if (side === "SHORT" && !(takeProfit < entryPrice && entryPrice < stopLoss)) {
    throw new PaperOrderError("INVALID_STOP", "Untuk SHORT: takeProfit harus < entryPrice < stopLoss.");
  }

  const notional = entryPrice * qty;
  const marginUSD = notional / leverage;
  if (marginUSD > state.cash) {
    throw new PaperOrderError("INSUFFICIENT_CASH", `Margin ${r2(marginUSD)} melebihi cash paper ${r2(state.cash)}.`);
  }

  const positionId = newId("pos");
  const orderId = newId("ord");
  const now = Date.now();
  const payload = JSON.stringify({
    symbol,
    side: direction,
    type: "market",
    amount: qty,
    leverage,
    stopLoss,
    takeProfit,
    meta: input.meta || {},
    timestamp: now,
    orderId,
  });
  const signed = signPayload(payload);

  const position: PaperPosition = {
    id: positionId,
    symbol,
    side,
    qty,
    entryPrice,
    notionalUSD: r2(notional),
    leverage: r2(leverage),
    marginUSD: r2(marginUSD),
    stopLoss,
    takeProfit,
    liquidationPrice: liquidationPrice(entryPrice, leverage, side),
    openedAt: now,
    status: "OPEN",
    entryReasoning: input.meta?.reasoning,
    confidence: input.meta?.confidence,
    timeframe: input.meta?.timeframe,
    marketType: input.meta?.marketType,
    targetPool: input.meta?.targetPool,
    sourceOrderId: orderId,
    lastMark: entryPrice,
    lastMarkUpdatedAt: now,
    feesPaidUSD: fill.feeUSD,
  };

  const order: PaperOrderReceipt = {
    id: orderId,
    mode: "paper",
    symbol,
    side: direction,
    type: "market",
    amount: qty,
    fillPrice: entryPrice,
    slippageBps: fill.slippageBps,
    feeUSD: fill.feeUSD,
    qty,
    notional: r2(notional),
    leverage: r2(leverage),
    marginRequired: r2(marginUSD),
    executionLatencyMs: fill.latencyMs,
    timestamp: now,
    status: "FILLED",
    positionId,
    signature: signed.signature,
    payloadHash: signed.payloadHash,
  };

  state.positions.push(position);
  state.orders.push(order);
  state.cash -= marginUSD;
  state.cash = r2(state.cash);
  appendEvent("ORDER_FILLED", {
    orderId,
    positionId,
    symbol,
    side: direction,
    qty,
    fillPrice: entryPrice,
    slippageBps: fill.slippageBps,
    feeUSD: fill.feeUSD,
    notional: r2(notional),
    leverage: r2(leverage),
    marginRequired: r2(marginUSD),
    executionLatencyMs: fill.latencyMs,
    fillMethod: fill.method,
    signature: signed.signature,
    payloadHash: signed.payloadHash,
  });

  dbSavePosition(position);
  dbSaveOrder(order);
  persistSnapshot();

  return { position: { ...position }, order: { ...order }, account: getPaperAccount() };
}

export interface ClosePaperPositionResult {
  position: PaperPosition;
  order: PaperOrderReceipt;
  realizedPnlUSD: number;
  cashAfter: number;
  exitFillPrice: number;
  exitSlippageBps: number;
  exitFeeUSD: number;
  exitReason: ExitReason;
}

export async function closePaperPosition(positionId: string, reason?: ExitReason): Promise<ClosePaperPositionResult> {
  const pos = state.positions.find((p) => p.id === positionId);
  if (!pos) throw new PaperOrderError("POSITION_NOT_FOUND", `Posisi ${positionId} tidak ditemukan.`);
  if (pos.status !== "OPEN") {
    throw new PaperOrderError("POSITION_ALREADY_CLOSED", `Posisi ${positionId} sudah ${pos.status}.`);
  }

  const exitReason: ExitReason = reason || "MANUAL";
  const closingSide = pos.side === "LONG" ? "sell" : "buy";
  let triggerPrice: number | undefined;
  let bracketMode: "none" | "stop" | "profit" = "none";
  if (exitReason === "STOP_LOSS") {
    triggerPrice = pos.stopLoss;
    bracketMode = "stop";
  } else if (exitReason === "TAKE_PROFIT") {
    triggerPrice = pos.takeProfit;
    bracketMode = "profit";
  }

  const fill = await marketFill(pos.symbol, closingSide, pos.qty, triggerPrice, bracketMode);
  const exitPrice = fill.fillPrice;
  const grossPnl = pos.side === "LONG" ? (exitPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPrice) * pos.qty;
  const totalFees = pos.feesPaidUSD + fill.feeUSD;
  let realizedPnl = grossPnl - totalFees;
  let effectiveExitPrice = exitPrice;
  let effectiveExitReason = exitReason;

  if (realizedPnl <= -pos.marginUSD) {
    effectiveExitPrice = pos.liquidationPrice;
    effectiveExitReason = "STOP_LOSS";
    realizedPnl = -pos.marginUSD;
  }

  const now = Date.now();
  const orderId = newId("ord");
  const payload = JSON.stringify({
    symbol: pos.symbol,
    side: closingSide,
    type: "market",
    amount: pos.qty,
    positionId,
    exitReason: effectiveExitReason,
    timestamp: now,
    orderId,
  });
  const signed = signPayload(payload);

  const result: ClosePaperPositionResult = {
    position: { ...pos },
    order: {
      id: orderId,
      mode: "paper",
      symbol: pos.symbol,
      side: closingSide,
      type: "market",
      amount: pos.qty,
      fillPrice: r6(effectiveExitPrice),
      slippageBps: fill.slippageBps,
      feeUSD: r4(fill.feeUSD),
      qty: pos.qty,
      notional: r2(effectiveExitPrice * pos.qty),
      leverage: pos.leverage,
      marginRequired: pos.marginUSD,
      executionLatencyMs: fill.latencyMs,
      timestamp: now,
      status: "FILLED",
      positionId: pos.id,
      signature: signed.signature,
      payloadHash: signed.payloadHash,
    },
    realizedPnlUSD: r2(realizedPnl),
    cashAfter: r2(state.cash + pos.marginUSD + realizedPnl),
    exitFillPrice: r6(effectiveExitPrice),
    exitSlippageBps: fill.slippageBps,
    exitFeeUSD: r4(fill.feeUSD),
    exitReason: effectiveExitReason,
  };

  state.cash += pos.marginUSD + realizedPnl;
  state.cash = r2(state.cash);
  state.realizedPnl += realizedPnl;
  state.realizedPnl = r2(state.realizedPnl);

  pos.status = "CLOSED";
  pos.closedAt = now;
  pos.exitPrice = r6(effectiveExitPrice);
  pos.exitReason = effectiveExitReason;
  pos.realizedPnlUSD = r2(realizedPnl);
  pos.feesPaidUSD = r4(totalFees);
  pos.lastMark = effectiveExitPrice;
  pos.lastMarkUpdatedAt = now;

  state.orders.push(result.order);
  appendEvent("POSITION_CLOSED", {
    orderId,
    positionId: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    qty: pos.qty,
    entryPrice: pos.entryPrice,
    exitPrice: r6(effectiveExitPrice),
    exitReason: effectiveExitReason,
    realizedPnlUSD: r2(realizedPnl),
    feesPaidUSD: r4(totalFees),
    slippageBps: fill.slippageBps,
    fillMethod: fill.method,
    cashAfter: result.cashAfter,
  });

  dbSavePosition(pos);
  dbSaveOrder(result.order);
  // also need to update the open position row's status already via dbSavePosition, and ensure fill for exit
  persistSnapshot();

  result.position = { ...pos };
  return result;
}

export interface UpdatePaperPositionInput {
  stopLoss?: number;
  takeProfit?: number;
  breakEven?: boolean;
}

export function updatePaperPosition(positionId: string, input: UpdatePaperPositionInput): PaperPosition {
  const pos = state.positions.find((p) => p.id === positionId);
  if (!pos) throw new PaperOrderError("POSITION_NOT_FOUND", `Posisi ${positionId} tidak ditemukan.`);
  if (pos.status !== "OPEN") {
    throw new PaperOrderError("POSITION_ALREADY_CLOSED", `Posisi ${positionId} sudah ${pos.status}; update tidak berlaku.`);
  }

  if (input.breakEven === true) {
    pos.stopLoss = pos.entryPrice;
  }
  if (input.stopLoss !== undefined) {
    const sl = Number(input.stopLoss);
    if (!isFinite(sl) || sl <= 0) throw new PaperOrderError("INVALID_STOPLOSS", "stopLoss harus angka positif.");
    pos.stopLoss = sl;
  }
  if (input.takeProfit !== undefined) {
    const tp = Number(input.takeProfit);
    if (!isFinite(tp) || tp <= 0) throw new PaperOrderError("INVALID_TAKEPROFIT", "takeProfit harus angka positif.");
    pos.takeProfit = tp;
  }

  appendEvent("POSITION_UPDATED", {
    positionId: pos.id,
    symbol: pos.symbol,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    breakEven: input.breakEven === true,
  });
  dbSavePosition(pos);
  persistSnapshot();
  return { ...pos };
}

// ------------------------------------------------------------------
// Mark price refresh and bracket monitor
// ------------------------------------------------------------------
async function fetchMarkTicker(symbol: string): Promise<{ mark: number; ok: boolean; error?: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    const exchange = getExchange();
    await ensureMarketsLoaded(exchange);
    const ticker = await exchange.fetchTicker(symbol);
    const mark = Number(ticker.last);
    if (!isFinite(mark) || mark <= 0) {
      return { mark: 0, ok: false, error: `Ticker tidak berisi harga untuk ${symbol}.`, latencyMs: Date.now() - t0 };
    }
    return { mark, ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { mark: 0, ok: false, error: `${(err as Error).message}`, latencyMs: Date.now() - t0 };
  }
}

export async function refreshPaperMarks(force = false): Promise<void> {
  const open = state.positions.filter((p) => p.status === "OPEN");
  if (open.length === 0) return;
  const now = Date.now();
  const staleSymbols = new Set<string>();
  for (const pos of open) {
    const age = now - (pos.lastMarkUpdatedAt || 0);
    if (force || age >= MARK_TTL_MS) staleSymbols.add(pos.symbol);
  }
  if (staleSymbols.size === 0) return;
  const results = await Promise.all([...staleSymbols].map(async (symbol) => ({ symbol, ...(await fetchMarkTicker(symbol)) })));
  const marks = new Map(results.map((r) => [r.symbol, r]));
  let changed = false;
  for (const pos of open) {
    const entry = marks.get(pos.symbol);
    if (entry && entry.ok) {
      pos.lastMark = entry.mark;
      pos.lastMarkUpdatedAt = now;
      changed = true;
    }
  }
  if (changed) persistSnapshot();
}

const lastErrorLoggedAt = new Map<string, number>();

function logThrottledError(symbol: string, message: string): void {
  const last = lastErrorLoggedAt.get(symbol) || 0;
  const now = Date.now();
  if (now - last >= ERROR_LOG_THROTTLE_MS) {
    lastErrorLoggedAt.set(symbol, now);
    console.warn(`[paperBook] Bracket monitor: fetch ${symbol} gagal: ${message}`);
    appendEvent("ERROR", { symbol, message, source: "bracket-monitor" });
  }
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorPassRunning = false;

export async function runBracketMonitorPass(): Promise<void> {
  if (monitorPassRunning) return;
  monitorPassRunning = true;
  try {
    const open = state.positions.filter((p) => p.status === "OPEN");
    if (open.length === 0) return;

    const symbols = [...new Set(open.map((p) => p.symbol))];
    const results = await Promise.all(symbols.map(async (symbol) => ({ symbol, ...(await fetchMarkTicker(symbol)) })));
    const marks = new Map(results.map((r) => [r.symbol, r]));

    let persisted = false;
    for (const pos of open) {
      const entry = marks.get(pos.symbol);
      if (!entry || !entry.ok) {
        logThrottledError(pos.symbol, entry?.error || "unknown");
        continue;
      }
      pos.lastMark = entry.mark;
      pos.lastMarkUpdatedAt = Date.now();
      persisted = true;

      const hitStop = pos.side === "LONG" ? entry.mark <= pos.stopLoss : entry.mark >= pos.stopLoss;
      const hitProfit = pos.side === "LONG" ? entry.mark >= pos.takeProfit : entry.mark <= pos.takeProfit;
      let triggered: ExitReason | null = null;
      if (hitStop && hitProfit) triggered = "STOP_LOSS";
      else if (hitStop) triggered = "STOP_LOSS";
      else if (hitProfit) triggered = "TAKE_PROFIT";

      if (triggered) {
        appendEvent("BRACKET_MONITOR_ACTION", {
          positionId: pos.id,
          symbol: pos.symbol,
          mark: entry.mark,
          markLatencyMs: entry.latencyMs,
          triggered,
        });
        try {
          const result = await closePaperPosition(pos.id, triggered);
          console.log(`[paperBook] Bracket monitor closed ${pos.id} (${pos.symbol} ${triggered}) @ ${result.exitFillPrice}, realized ${result.realizedPnlUSD}`);
          try {
            appendAudit("exit", {
              positionId: pos.id,
              symbol: pos.symbol,
              side: pos.side,
              exitReason: triggered,
              exitPrice: result.exitFillPrice,
              realizedPnlUSD: result.realizedPnlUSD,
              source: "bracket-monitor",
            });
          } catch {}
        } catch (err) {
          console.warn(`[paperBook] Bracket monitor gagal menutup ${pos.id}: ${(err as Error).message}`);
          appendEvent("ERROR", { positionId: pos.id, symbol: pos.symbol, message: (err as Error).message, source: "bracket-monitor-close" });
        }
      }
    }
    if (persisted) persistSnapshot();
  } finally {
    monitorPassRunning = false;
  }
}

export function startBracketMonitor(intervalMs = 3000): void {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => {
    runBracketMonitorPass().catch((err) => {
      console.warn(`[paperBook] Bracket monitor pass error: ${(err as Error).message}`);
    });
  }, intervalMs);
  console.log(`[paperBook] Bracket monitor started (interval ${intervalMs}ms)`);
}

export function stopBracketMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    console.log("[paperBook] Bracket monitor stopped");
  }
}

export function getBookFilePath(): string {
  try {
    return getDbFilePath();
  } catch {
    return "trading.db";
  }
}
