import { createHmac, createHash } from "node:crypto";
import { getExchange, ensureMarketsLoaded } from "./broker";
import { fetchTickerPrice } from "./src/data/marketFetcher";
import {
  initDb,
  getDb,
  beginTx,
  commitTx,
  rollbackTx,
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

// Paper mode env config (TODO 6.1) — semua bisa dioverride via .env, default
// mengikuti tarif Binance USDT-M VIP0 (taker 0.04%, maker 0.02%).
const envPositiveInt = (v: string | undefined, def: number): number => {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const envPositiveNum = (v: string | undefined, def: number): number => {
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
};

export const TAKER_FEE_RATE = envPositiveNum(process.env.PAPER_FEE_TAKER_BPS, 4) / 10000;
export const MAKER_FEE_RATE = envPositiveNum(process.env.PAPER_FEE_MAKER_BPS, 2) / 10000;

let warnedDefaultSecret = false;
export const INITIAL_PAPER_CASH = envPositiveInt(process.env.PAPER_INITIAL_CASH, 10000);
export const MAINTENANCE_MARGIN_RATE = 0.004;
export const MAX_LEVERAGE = envPositiveInt(process.env.PAPER_LEVERAGE_MAX, 50);
export const ORDERBOOK_LEVELS = 20;
export const EVENT_RING_SIZE = 200;
export const MARK_TTL_MS = 3000;
export const ERROR_LOG_THROTTLE_MS = 30000;

// Simulated exchange latency range (ms)
export const EXCHANGE_LATENCY_MS_MIN = 5;
export const EXCHANGE_LATENCY_MS_MAX = 50;

export type PaperSide = "LONG" | "SHORT";
export type PaperPositionStatus = "OPEN" | "CLOSED";
export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL" | "LIQUIDATED";
export type PaperOrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED" | "CANCELLED";
export type PaperEventType =
  | "ORDER_FILLED"
  | "POSITION_CLOSED"
  | "BRACKET_MONITOR_ACTION"
  | "POSITION_UPDATED"
  | "ORDER_NEW"
  | "ORDER_PARTIAL"
  | "ORDER_REJECTED"
  | "ORDER_CANCELLED"
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
  maintenanceMarginRate: number;
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
  type: "market" | "limit";
  amount: number;
  fillPrice?: number;
  slippageBps?: number;
  feeUSD: number;
  qty: number;
  notional?: number;
  limitPrice?: number;
  leverage?: number;
  marginRequired?: number;
  executionLatencyMs?: number;
  timestamp: number;
  status: PaperOrderStatus;
  positionId?: string;
  reason?: string;
  signature: string;
  payloadHash: string;
  // Lifecycle timestamps
  submittedAt?: number;
  filledAt?: number;
  cancelledAt?: number;
  // For partial fills
  filledQty?: number;
  remainingQty?: number;
  stopLoss?: number;
  takeProfit?: number;
  meta?: PaperOrderMeta;
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
const r8 = (n: number) => roundTo(Number(n), 8);

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

// Shared mark cache dari server tick (task 6.3): satu sumber kebenaran harga
// untuk posisi/margin. Diisi oleh WS Binance proxy (server.ts) atau REST,
// dikonsumsi refreshPaperMarks & bracket monitor sebelum turun ke ccxt.
// F-02/P1: selain mark, cache juga jendela range 1m (high/low rolling 60 detik)
// dari setiap tick WS — jadi bracket SL/TP/liq dievaluasi terhadap range asli,
// bukan last-price doang (wick yang tembus lalu balik tetap ter-catch).
interface MarkCacheEntry {
  mark: number;
  ts: number;
  bucketStart: number;
  high: number;
  low: number;
}
const MARK_BUCKET_MS = 60_000; // jendela 1 menit
const sharedMarkCache = new Map<string, MarkCacheEntry>();

export function updatePaperMarkCache(symbol: string, mark: number): void {
  if (!isFinite(mark) || mark <= 0) return;
  const now = Date.now();
  const cached = sharedMarkCache.get(symbol);
  if (cached && now - cached.bucketStart < MARK_BUCKET_MS) {
    // masih dalam bucket 1m yang sama → update rolling high/low + mark
    cached.mark = mark;
    cached.ts = now;
    cached.high = Math.max(cached.high, mark);
    cached.low = Math.min(cached.low, mark);
    return;
  }
  // bucket baru (atau symbol baru): reset jendela high/low ke tick ini
  sharedMarkCache.set(symbol, { mark, ts: now, bucketStart: now, high: mark, low: mark });
}

function freshMarkFromCache(symbol: string, maxAgeMs = MARK_TTL_MS): { mark: number; ts: number; high: number; low: number } | null {
  const cached = sharedMarkCache.get(symbol);
  if (cached && Date.now() - cached.ts < maxAgeMs) {
    return { mark: cached.mark, ts: cached.ts, high: cached.high, low: cached.low };
  }
  return null;
}

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
// F-01 (P1): writer DB helpers bersifat fail-closed — error menulis DILONTAR
// (tidak diswallow), sehingga pemanggil dalam beginTx() bisa rollbackTx()
// seluruh transaksi. Pemanggil luar transaksi wajib menangkapnya secara toleran.
function persistSnapshot(): void {
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
}

function dbSavePosition(pos: PaperPosition): void {
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
}

function dbSaveOrder(order: PaperOrderReceipt): void {
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
  // also save fills row (amount = filledQty terukur; sisa unfilled TIDAK pernah jadi fill)
  if (order.fillPrice != null) {
    const fillId = `fill-${order.id}`;
    saveFillDb({
      id: fillId,
      order_id: order.id,
      symbol: order.symbol,
      side: order.side,
      price: order.fillPrice,
      amount: order.filledQty ?? order.amount,
      fee_usd: order.feeUSD,
      created_at: order.timestamp,
    });
  }
}

// F-01: pemanggil di LUAR transaksi (startup, bracket monitor, update posisi)
// memakai varian toleran — kalau persist gagal, warn & lanjut, karena di luar
// beginTx() tidak ada rollback; error tidak boleh membawa crash startup/loop.
function persistSnapshotTolerant(): void {
  try {
    persistSnapshot();
  } catch (err) {
    console.warn(`[paperBook] Gagal persist snapshot (non-tx): ${(err as Error).message}`);
  }
}

function dbSavePositionTolerant(pos: PaperPosition): void {
  try {
    dbSavePosition(pos);
  } catch (err) {
    console.warn(`[paperBook] Gagal save position (non-tx) ${pos.id}: ${(err as Error).message}`);
  }
}

function dbSaveOrderTolerant(order: PaperOrderReceipt): void {
  try {
    dbSaveOrder(order);
  } catch (err) {
    console.warn(`[paperBook] Gagal save order (non-tx) ${order.id}: ${(err as Error).message}`);
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
      type: (String(r.type) === "limit" ? "limit" : "market") as "market" | "limit",
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
      status: (String(r.status).toUpperCase() === "REJECTED" ? "REJECTED" : String(r.status).toUpperCase() === "CANCELLED" ? "CANCELLED" : String(r.status).toUpperCase() === "PARTIALLY_FILLED" ? "PARTIALLY_FILLED" : String(r.status).toUpperCase() === "NEW" ? "NEW" : "FILLED") as PaperOrderStatus,
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
        // Posisi lama (sebelum kolom ini ada) fallback ke tier-1 MMR sekarang.
        maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
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
    if (!latestSnap) persistSnapshotTolerant();
  } catch (err) {
    console.warn(`[paperBook] Gagal rehydrate dari DB, mulai dari state kosong: ${(err as Error).message}`);
    state = freshState();
    persistSnapshotTolerant();
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

export function getPaperOrders(): PaperOrderReceipt[] {
  return state.orders.map((o) => ({ ...o }));
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
  // F-06: fail-closed di production — jangan pernah default ke secret dev saat NODE_ENV=production.
  const rawSecret = process.env.BROKER_EVENT_SECRET;
  if (!rawSecret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "BROKER_EVENT_SECRET wajib disetel di production — menolak menandatangani event broker (fail-closed)."
      );
    }
    if (!warnedDefaultSecret) {
      console.warn("[paperBook] BROKER_EVENT_SECRET belum disetel — memakai default 'paper-dev-secret' (DEV ONLY).");
      warnedDefaultSecret = true;
    }
  }
  const secret = rawSecret || "paper-dev-secret";
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
  method: "ORDERBOOK" | "TICKER" | "LIQUIDATION";
  latencyMs: number;
  /** Qty yang benar-benar bisa didukung orderbook top-20 (sisa = partial). */
  filledQty: number;
  /** Qty yang tidak kebagian depth (0 = full fill). */
  unfilledQty: number;
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
  try {
    await ensureMarketsLoaded(exchange);
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
        // Versi 2026-09-10: JANGAN extrapolate fill di luar visible depth.
        // Order yang melebihi kedalaman top-20 difill PARSIAL atas qty yang
        // kebagian book; sisanya diteruskan sebagai PARTIALLY_FILLED.
        // Extrapolate dengan penalty spread (logika lama, dihapus) justru
        // mengada-ada: harga fill bagian unfilled tidak terukur → tidak boleh
        // diproduksi sebagai fill.
        const filledQty = r8(qty - remaining);
        if (filledQty <= 0) {
          throw new PaperOrderError("NO_DEPTH", `Orderbook tidak cukup likuid untuk ${symbol} ${side}. Depth top-20 habis.`);
        }
        let fillPrice = weightedSum / filledQty;
        if (bracketMode !== "none" && triggerPrice !== undefined && triggerPrice > 0) {
          fillPrice = side === "buy" ? Math.max(triggerPrice, fillPrice) : Math.min(triggerPrice, fillPrice);
        }
        const slippageBps = (Math.abs(fillPrice - mid) / mid) * 10000;
        return {
          fillPrice: r6(fillPrice),
          slippageBps: r2(slippageBps),
          feeUSD: r4(fillPrice * filledQty * TAKER_FEE_RATE),
          method: "ORDERBOOK",
          latencyMs: Date.now() - t0,
          filledQty,
          unfilledQty: r8(remaining),
        };
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
        filledQty: qty,
        unfilledQty: 0,
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
      filledQty: qty,
      unfilledQty: 0,
    };
  } catch (err) {
    // CCXT exchange (Binance) tidak terjangkau / kena blokir ISP.
    // Fallback: pakai market-fetcher chain (Binance Vision → Gate.io → Bybit → Synthetic)
    // supaya open/close posisi paper tetap jalan tanpa bergantung pada api.binance.com.
    try {
      const tp = await fetchTickerPrice(symbol);
      if (tp.ok && isFinite(tp.price) && tp.price > 0) {
        const fillPrice = (bracketMode !== "none" && triggerPrice !== undefined && triggerPrice > 0)
          ? (side === "buy" ? Math.max(triggerPrice, tp.price) : Math.min(triggerPrice, tp.price))
          : tp.price;
        const slip = Math.max(0, (Math.abs(fillPrice - tp.price) / tp.price) * 10000);
        return {
          fillPrice: r6(fillPrice),
          slippageBps: r2(slip),
          feeUSD: r4(fillPrice * qty * TAKER_FEE_RATE),
          method: "TICKER",
          latencyMs: Date.now() - t0,
          filledQty: qty,
          unfilledQty: 0,
        };
      }
    } catch (chainErr) {
      // fallthrough
    }
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
  /** AI decision id yang memicu order (untuk training join decision → fill). */
  decisionId?: string;
}

export interface OpenPaperPositionInput {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  orderType?: "market" | "limit";
  limitPrice?: number;
  /**
   * Versi 2026-09-10: order yang orderbook depth-nya tidak cukup untuk full
   * qty difill PARSIAL — tidak lagi all-or-nothing. JANGAN pernah simulasikan
   * partial di client; seluruh state (NEW → PARTIALLY_FILLED → FILLED) hanya
   * diproduksi di sini dan disiarkan lewat ORDER_PARTIAL / ORDER_FILLED.
   */
  allowPartialFill?: boolean;
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

  const orderType = input.orderType || "market";
  const limitPrice = input.limitPrice ? Number(input.limitPrice) : undefined;
  
  // Validate limit order
  if (orderType === "limit" && (!limitPrice || !isFinite(limitPrice) || limitPrice <= 0)) {
    throw new PaperOrderError("INVALID_LIMIT_PRICE", "limitPrice wajib diisi untuk limit order.");
  }

  const positionId = newId("pos");
  const orderId = newId("ord");
  const now = Date.now();
  
  // Simulate exchange latency (5-50ms)
  const exchangeLatency = Math.floor(Math.random() * (EXCHANGE_LATENCY_MS_MAX - EXCHANGE_LATENCY_MS_MIN + 1)) + EXCHANGE_LATENCY_MS_MIN;
  const submittedAt = now + exchangeLatency;

  // Initial order payload + signature
  const payload = JSON.stringify({
    symbol,
    side: direction,
    type: orderType,
    amount: qty,
    leverage,
    stopLoss,
    takeProfit,
    ...(orderType === "limit" && limitPrice ? { limitPrice } : {}),
    meta: input.meta || {},
    timestamp: now,
    orderId,
  });
  const signed = signPayload(payload);

  const initialOrder: PaperOrderReceipt = {
    id: orderId,
    mode: "paper",
    symbol,
    side: direction,
    type: orderType,
    amount: qty,
    limitPrice,
    feeUSD: 0,
    qty,
    notional: 0,
    leverage: r2(leverage),
    marginRequired: 0,
    executionLatencyMs: exchangeLatency,
    timestamp: now,
    status: "NEW",
    positionId,
    submittedAt,
    stopLoss,
    takeProfit,
    meta: input.meta,
    signature: signed.signature,
    payloadHash: signed.payloadHash,
  };

  // Emit ORDER_NEW so FE sees the lifecycle start
  appendEvent("ORDER_NEW", {
    orderId,
    positionId,
    symbol,
    side: direction,
    type: orderType,
    amount: qty,
    limitPrice,
    leverage,
    stopLoss,
    takeProfit,
    submittedAt,
  });

  if (orderType !== "market") {
    // Limit order: reserve margin, store pending; filled later via bracket monitor
    const estimatedNotional = limitPrice! * qty;
    const estimatedMargin = estimatedNotional / leverage;
    if (estimatedMargin > state.cash) {
      throw new PaperOrderError("INSUFFICIENT_CASH", `Estimated margin ${r2(estimatedMargin)} melebihi cash paper ${r2(state.cash)}.`);
    }
    state.cash = r2(state.cash - estimatedMargin);
    state.orders.push(initialOrder);
    return { position: null as any, order: initialOrder, account: getPaperAccount() };
  }
  return handleMarketOpenFill(
    input, symbol, side, direction, qty, leverage, stopLoss, takeProfit,
    orderType, initialOrder, positionId, now, submittedAt, signed
  );
}

async function handleMarketOpenFill(
  input: OpenPaperPositionInput, symbol: string, side: PaperSide, direction: "buy" | "sell",
  qty: number, leverage: number, stopLoss: number, takeProfit: number,
  orderType: "market" | "limit", initialOrder: PaperOrderReceipt,
  positionId: string, now: number, submittedAt: number,
  signed: { signature: string; payloadHash: string }
): Promise<OpenPaperPositionResult> {
  const fill = await marketFill(symbol, direction, qty, undefined, "none");
  const entryPrice = fill.fillPrice;

  if (side === "LONG" && !(stopLoss < entryPrice && entryPrice < takeProfit)) {
    throw new PaperOrderError("INVALID_STOP", "Untuk LONG: stopLoss harus < entryPrice < takeProfit.");
  }
  if (side === "SHORT" && !(takeProfit < entryPrice && entryPrice < stopLoss)) {
    throw new PaperOrderError("INVALID_STOP", "Untuk SHORT: takeProfit harus < entryPrice < stopLoss.");
  }

  // Depth > top-20 didukung penuh → full fill. Depth habis → emit PARTIAL:
  // posisi dibuka HANYA atas filledQty (terukur), sisa unfilledQty TIDAK
  // di-fill. Tanpa allowPartialFill eksplisit → REJECT (fail-closed, bukan
  // fake full fill).
  const filledQty = fill.filledQty > 0 ? fill.filledQty : qty;
  const unfilledQty = fill.unfilledQty > 0 ? fill.unfilledQty : 0;
  const isPartial = unfilledQty > 0;
  if (isPartial && !input.allowPartialFill) {
    appendEvent("ORDER_REJECTED", {
      orderId: initialOrder.id,
      symbol,
      side: direction,
      type: orderType,
      amount: qty,
      filledQty,
      unfilledQty,
      reason: "INSUFFICIENT_DEPTH",
      message: `Orderbook top-20 hanya mendukung ${filledQty}/${qty}. Kirim ulang dengan allowPartialFill=true untuk partial, atau kecilkan qty.`,
    });
    throw new PaperOrderError(
      "INSUFFICIENT_DEPTH",
      `Orderbook top-20 hanya mendukung ${filledQty}/${qty} ${symbol}. Kirim ulang dengan allowPartialFill=true untuk partial, atau kecilkan qty.`
    );
  }

  const notional = entryPrice * filledQty;
  const marginUSD = notional / leverage;
  if (marginUSD > state.cash) {
    throw new PaperOrderError("INSUFFICIENT_CASH", `Margin ${r2(marginUSD)} melebihi cash paper ${r2(state.cash)}.`);
  }

  const feeUSD = r4(fill.feeUSD); // market order => taker fee

  const position: PaperPosition = {
    id: positionId,
    symbol,
    side,
    qty: filledQty,
    entryPrice,
    notionalUSD: r2(notional),
    leverage: r2(leverage),
    marginUSD: r2(marginUSD),
    stopLoss,
    takeProfit,
    liquidationPrice: liquidationPrice(entryPrice, leverage, side),
    maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
    openedAt: now,
    status: "OPEN",
    entryReasoning: input.meta?.reasoning,
    confidence: input.meta?.confidence,
    timeframe: input.meta?.timeframe,
    marketType: input.meta?.marketType,
    targetPool: input.meta?.targetPool,
    sourceOrderId: initialOrder.id,
    lastMark: entryPrice,
    lastMarkUpdatedAt: now,
    feesPaidUSD: feeUSD,
  };

  const filledAt = submittedAt + Math.floor(Math.random() * 10) + 1; // 1-10ms additional fill time

  const order: PaperOrderReceipt = {
    ...initialOrder,
    fillPrice: entryPrice,
    slippageBps: fill.slippageBps,
    feeUSD,
    qty: filledQty,
    notional: r2(notional),
    marginRequired: r2(marginUSD),
    executionLatencyMs: filledAt - now,
    timestamp: filledAt,
    status: isPartial ? "PARTIALLY_FILLED" : "FILLED",
    filledAt,
    filledQty,
    remainingQty: unfilledQty,
  };
  state.positions.push(position);
  state.orders.push(order);
  state.cash = r2(state.cash - marginUSD - feeUSD);

  if (isPartial) {
    appendEvent("ORDER_PARTIAL", {
      orderId: initialOrder.id,
      positionId,
      symbol,
      side: direction,
      type: orderType,
      fillPrice: entryPrice,
      filledQty,
      remainingQty: unfilledQty,
      slippageBps: fill.slippageBps,
      feeUSD,
      latencyMs: filledAt - now,
      method: fill.method,
    });
  }
  appendEvent("ORDER_FILLED", {
    orderId: initialOrder.id,
    positionId,
    symbol,
    side: direction,
    type: orderType,
    fillPrice: entryPrice,
    qty: filledQty,
    remainingQty: unfilledQty,
    slippageBps: fill.slippageBps,
    feeUSD,
    latencyMs: filledAt - now,
    method: fill.method,
  });

  // P1: atomic — position + order + snapshot + audit dalam satu transaksi
  try {
    beginTx();
    dbSavePosition(position);
    dbSaveOrder(order);
    persistSnapshot();
    appendAudit("order", {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      amount: order.amount,
      fillPrice: order.fillPrice,
      status: order.status,
      reason: "PAPER_OPEN",
      timestamp: Date.now(),
    });
    commitTx();
  } catch (err) {
    rollbackTx();
    throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis posisi/order ke DB: ${(err as Error).message}`);
  }

  return { position, order, account: getPaperAccount() };
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

  // Task 6.2: likuidasi jujur — saat mark menyentuh liquidationPrice, posisi
  // di-close paksa di harga likuidasi dengan PnL terhitung (bukan hardcode).
  let fill: FillResult;
  if (exitReason === "LIQUIDATED") {
    const liqPrice = pos.liquidationPrice > 0 ? pos.liquidationPrice : liquidationPrice(pos.entryPrice, pos.leverage, pos.side);
    const exitFee = r4(liqPrice * pos.qty * TAKER_FEE_RATE);
    fill = {
      fillPrice: r6(liqPrice),
      slippageBps: 0,
      feeUSD: exitFee,
      method: "LIQUIDATION",
      latencyMs: 0,
      filledQty: pos.qty,
      unfilledQty: 0,
    };
  } else {
    if (exitReason === "STOP_LOSS") {
      triggerPrice = pos.stopLoss;
      bracketMode = "stop";
    } else if (exitReason === "TAKE_PROFIT") {
      triggerPrice = pos.takeProfit;
      bracketMode = "profit";
    }
    fill = await marketFill(pos.symbol, closingSide, pos.qty, triggerPrice, bracketMode);
  }

  const exitPrice = fill.fillPrice;
  const grossPnl = pos.side === "LONG" ? (exitPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPrice) * pos.qty;
  const totalFees = pos.feesPaidUSD + fill.feeUSD;
  let realizedPnl = grossPnl - totalFees;
  let effectiveExitPrice = exitPrice;
  let effectiveExitReason = exitReason;

  if (realizedPnl <= -pos.marginUSD) {
    // Gap parah (SL tersentuh jauh di bawah/atas liq): realitasnya itu
    // likuidasi — catat jujur sebagai LIQUIDATED dengan max loss = margin.
    effectiveExitPrice = pos.liquidationPrice;
    effectiveExitReason = "LIQUIDATED";
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

  // P1: atomic close — posisi + order + snapshot + audit dalam satu transaksi.
  try {
    beginTx();
    dbSavePosition(pos);
    dbSaveOrder(result.order);
    // also need to update the open position row's status already via dbSavePosition, and ensure fill for exit
    persistSnapshot();
    // F-01: jangan swallow error audit di dalam tx — error apa pun (termasuk
    // appendAudit) → rollbackTx() seluruh transaksi (fail-closed).
    appendAudit("order", {
      id: result.order.id,
      symbol: result.order.symbol,
      side: result.order.side,
      amount: result.order.amount,
      fillPrice: result.order.fillPrice,
      status: result.order.status,
      realizedPnlUSD: r2(realizedPnl),
      reason: "PAPER_CLOSE",
      timestamp: Date.now(),
    });
    commitTx();
  } catch (err) {
    rollbackTx();
    console.error(`[paperBook] Gagal menulis close ke DB: ${(err as Error).message}`);
    throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis close ke DB: ${(err as Error).message}`);
  }

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
    // Break-even sejati harus selalu dalam kondisi NET PROFIT setelah fee.
    // Taruh SL sedikit di bawah/atas entry sebesar ~2x taker fee (entry+exit)
    // supaya exit di BE bukan rugi kecil gara-gara fee. (F7)
    const beOffsetPct = 0.0008; // 0.08% ≈ 2 * takerFee (0.04%) + buffer
    pos.stopLoss =
      pos.side === "LONG" ? pos.entryPrice * (1 - beOffsetPct) : pos.entryPrice * (1 + beOffsetPct);
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
  // F-01: di luar transaksi — pakai varian toleran (update SL/TP di memori tetap
  // berlaku walau persist ke SQLite gagal; log warning, bukan crash).
  dbSavePositionTolerant(pos);
  persistSnapshotTolerant();
  return { ...pos };
}

// ------------------------------------------------------------------
// Mark price refresh and bracket monitor
// ------------------------------------------------------------------
async function fetchMarkTicker(symbol: string): Promise<{
  mark: number;
  high1m: number;
  low1m: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
  source?: "WS_CACHE" | "FALLBACK_CHAIN";
}> {
  const t0 = Date.now();
  // Preferensi WS cache (server tick = single source of truth, task 6.3).
  // Kalau cache fresh, pakai langsung — harga real dari Binance WS, bukan
  // round-trip ccxt tambahan. F-02/P1: high1m/low1m = jendela range 1m rolling
  // dari tick WS (bukan alias mark), sehingga bracket SL/TP/liq dinilai jujur.
  const cached = freshMarkFromCache(symbol);
  if (cached) {
    const hasRealWindow = isFinite(cached.high) && isFinite(cached.low) && cached.high > 0 && cached.low > 0;
    return {
      mark: cached.mark,
      high1m: hasRealWindow ? cached.high : cached.mark,
      low1m: hasRealWindow ? cached.low : cached.mark,
      ok: true,
      latencyMs: Date.now() - t0,
      source: "WS_CACHE",
    };
  }
  // Use robust fallback chain: Binance Vision → Gate.io → Bybit → Binance → CCXT → Synthetic
  const result = await fetchTickerPrice(symbol);
  if (result.ok && isFinite(result.price) && result.price > 0) {
    // Prefer window asli dari cache (jika ada) vs mark approx — jangan pernah
    // mengecilkan range: wick yang menembus SL/TP harus tetap ter-catch.
    const cachedWin = freshMarkFromCache(symbol, MARK_TTL_MS);
    const winHigh =
      cachedWin && isFinite(cachedWin.high) && cachedWin.high > 0 ? Math.max(cachedWin.high, result.price) : result.price;
    const winLow =
      cachedWin && isFinite(cachedWin.low) && cachedWin.low > 0 ? Math.min(cachedWin.low, result.price) : result.price;
    return {
      mark: result.price,
      high1m: winHigh,
      low1m: winLow,
      ok: true,
      latencyMs: Date.now() - t0,
      source: "FALLBACK_CHAIN",
    };
  }
  return { mark: 0, high1m: 0, low1m: 0, ok: false, error: "All price sources failed", latencyMs: Date.now() - t0, source: "FALLBACK_CHAIN" };
}

export async function refreshPaperMarks(force = false): Promise<void> {
  const open = state.positions.filter((p) => p.status === "OPEN");
  if (open.length === 0) return;
  const now = Date.now();
  const staleSymbols = new Set<string>();
  let changed = false;
  for (const pos of open) {
    const age = now - (pos.lastMarkUpdatedAt || 0);
    const cached = freshMarkFromCache(pos.symbol);
    if (cached) {
      if (pos.lastMark !== cached.mark) {
        pos.lastMark = cached.mark;
        pos.lastMarkUpdatedAt = now;
        changed = true;
      }
      continue;
    }
    if (force || age >= MARK_TTL_MS) staleSymbols.add(pos.symbol);
  }
  if (staleSymbols.size === 0) {
    if (changed) persistSnapshotTolerant();
    return;
  }
  const results = await Promise.all([...staleSymbols].map(async (symbol) => ({ symbol, ...(await fetchMarkTicker(symbol)) })));
  const marks = new Map(results.map((r) => [r.symbol, r]));
  for (const pos of open) {
    const entry = marks.get(pos.symbol);
    if (entry && entry.ok) {
      pos.lastMark = entry.mark;
      pos.lastMarkUpdatedAt = now;
      changed = true;
    }
  }
  if (changed) persistSnapshotTolerant();
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
    const pendingLimits = state.orders.filter((o) => o.status === "NEW" && o.type === "limit" && o.limitPrice && o.limitPrice > 0);
    if (open.length === 0 && pendingLimits.length === 0) return;

    const symbols = [...new Set([...open.map((p) => p.symbol), ...pendingLimits.map((o) => o.symbol)])];
    const results = await Promise.all(symbols.map(async (symbol) => ({ symbol, ...(await fetchMarkTicker(symbol)) })));
    const marks = new Map(results.map((r) => [r.symbol, r]));

    // Fill pending limit orders whose price threshold has been hit (maker fill)
    await fillPendingLimitOrders(marks);

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

      // Deteksi exit terhadap RANGE 1m (high/low), bukan last price doang —
      // wick yang menembus SL/TP lalu balik tetap ke-catch (jujur, tidak
      // over-optimistic). Konservatif: jika dalam satu candle SL & TP
      // dua-duanya kena, anggap SL kena dulu.
      const rangeHigh = Number.isFinite(entry.high1m) && entry.high1m > 0 ? entry.high1m : entry.mark;
      const rangeLow = Number.isFinite(entry.low1m) && entry.low1m > 0 ? entry.low1m : entry.mark;
      // Task 6.2: simulasikan margin call — mark menyentuh liquidationPrice
      // (range wick ikut diperhitungkan) => auto-close LIQUIDATED, prioritas
      // di atas SL/TP brackets.
      const hitLiq =
        pos.liquidationPrice > 0
          ? pos.side === "LONG"
            ? rangeLow <= pos.liquidationPrice
            : rangeHigh >= pos.liquidationPrice
          : false;
      const hitStop = pos.side === "LONG" ? rangeLow <= pos.stopLoss : rangeHigh >= pos.stopLoss;
      const hitProfit = pos.side === "LONG" ? rangeHigh >= pos.takeProfit : rangeLow <= pos.takeProfit;
      let triggered: ExitReason | null = null;
      if (hitLiq) triggered = "LIQUIDATED";
      else if (hitStop && hitProfit) triggered = "STOP_LOSS";
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
          // F-01: jangan swallow error audit — kalau appendAudit gagal, warn &
          // catat event ERROR (closePaperPosition sudah sukses & ter-audit di
          // dalam tx-nya sendiri, jadi ini cuma audit pelengkap non-fatal).
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
          } catch (auditErr) {
            console.warn(`[paperBook] Bracket monitor gagal audit exit ${pos.id}: ${(auditErr as Error).message}`);
          }
        } catch (err) {
          console.warn(`[paperBook] Bracket monitor gagal menutup ${pos.id}: ${(err as Error).message}`);
          appendEvent("ERROR", { positionId: pos.id, symbol: pos.symbol, message: (err as Error).message, source: "bracket-monitor-close" });
        }
      }
    }
    if (persisted) persistSnapshotTolerant();
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

/**
 * Fill pending NEW limit orders when the 1m range crosses the limit price.
 * - buy limit fills when rangeLow <= limitPrice (maker fill at limit price)
 * - sell limit fills when rangeHigh >= limitPrice
 * Maker fee (0.02%) applies; reserved margin is converted to position margin.
 */
async function fillPendingLimitOrders(
  marks: Map<string, { mark: number; high1m: number; low1m: number; ok: boolean }>
): Promise<void> {
  const pending = state.orders.filter((o) => o.status === "NEW" && o.type === "limit" && o.limitPrice && o.limitPrice > 0);
  let changed = false;
  for (const order of pending) {
    const entry = marks.get(order.symbol);
    if (!entry || !entry.ok) continue;
    const rangeHigh = Number.isFinite(entry.high1m) && entry.high1m > 0 ? entry.high1m : entry.mark;
    const rangeLow = Number.isFinite(entry.low1m) && entry.low1m > 0 ? entry.low1m : entry.mark;
    const limit = order.limitPrice!;
    const crossed = order.side === "buy" ? rangeLow <= limit : rangeHigh >= limit;
    if (!crossed) continue;

    const side: PaperSide = order.side === "sell" ? "SHORT" : "LONG";
    const dup = state.positions.find((p) => p.symbol === order.symbol && p.side === side && p.status === "OPEN");
    const now = Date.now();
    const notional = limit * order.amount;
    const leverage = order.leverage && order.leverage > 0 ? order.leverage : 1;
    const marginUSD = notional / leverage;
    const feeUSD = r4(notional * MAKER_FEE_RATE);

    if (dup) {
      // Duplicate direction at fill time → cancel + refund reserved margin.
      order.status = "CANCELLED";
      order.cancelledAt = now;
      order.reason = "DUPLICATE_POSITION_DIRECTION_ON_FILL";
      state.cash = r2(state.cash + marginUSD);
      appendEvent("ORDER_CANCELLED", { orderId: order.id, symbol: order.symbol, reason: "DUPLICATE_POSITION_DIRECTION_ON_FILL" });
      changed = true;
      continue;
    }

    const positionId = newId("pos");
    const position: PaperPosition = {
      id: positionId,
      symbol: order.symbol,
      side,
      qty: order.amount,
      entryPrice: limit,
      notionalUSD: r2(notional),
      leverage: r2(leverage),
      marginUSD: r2(marginUSD),
      stopLoss: order.stopLoss || 0,
      takeProfit: order.takeProfit || 0,
      liquidationPrice: liquidationPrice(limit, leverage, side),
      maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
      openedAt: now,
      status: "OPEN",
      entryReasoning: order.meta?.reasoning,
      confidence: order.meta?.confidence,
      timeframe: order.meta?.timeframe,
      marketType: order.meta?.marketType,
      targetPool: order.meta?.targetPool,
      sourceOrderId: order.id,
      lastMark: entry.mark,
      lastMarkUpdatedAt: now,
      feesPaidUSD: feeUSD,
    };

    order.status = "FILLED";
    order.filledAt = now;
    order.fillPrice = limit;
    order.slippageBps = 0; // maker fill at limit — no slippage
    order.feeUSD = feeUSD;
    order.notional = r2(notional);
    order.marginRequired = r2(marginUSD);
    order.filledQty = order.amount;
    order.remainingQty = 0;
    order.positionId = positionId;
    order.executionLatencyMs = now - (order.submittedAt || order.timestamp);

    state.positions.push(position);
    state.cash = r2(state.cash - feeUSD); // margin already reserved at submit

    appendEvent("ORDER_FILLED", {
      orderId: order.id,
      positionId,
      symbol: order.symbol,
      side: order.side,
      type: "limit",
      fillPrice: limit,
      qty: order.amount,
      slippageBps: 0,
      feeUSD,
      latencyMs: order.executionLatencyMs,
      method: "LIMIT_MAKER",
    });

    try {
      beginTx();
      dbSavePosition(position);
      dbSaveOrder(order);
      persistSnapshot();
      appendAudit("order", {
        id: order.id,
        symbol: order.symbol,
        side: order.side,
        amount: order.amount,
        fillPrice: limit,
        status: "FILLED",
        reason: "PAPER_LIMIT_FILL",
        timestamp: now,
      });
      commitTx();
    } catch (err) {
      rollbackTx();
      console.error(`[paperBook] Gagal persist limit fill ${order.id}: ${(err as Error).message}`);
    }
    changed = true;
  }
  if (changed) persistSnapshotTolerant();
}

/**
 * Cancel a pending (NEW) limit order and refund its reserved margin.
 */
export function cancelPaperOrder(orderId: string): PaperOrderReceipt {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new PaperOrderError("ORDER_NOT_FOUND", `Order ${orderId} tidak ditemukan.`);
  if (order.status !== "NEW") {
    throw new PaperOrderError("ORDER_NOT_CANCELLABLE", `Order ${orderId} berstatus ${order.status}; hanya NEW yang bisa dibatalkan.`);
  }
  const now = Date.now();
  order.status = "CANCELLED";
  order.cancelledAt = now;
  order.reason = "MANUAL_CANCEL";
  if (order.limitPrice && order.limitPrice > 0) {
    const margin = (order.limitPrice * order.amount) / (order.leverage || 1);
    state.cash = r2(state.cash + margin);
  }
  appendEvent("ORDER_CANCELLED", { orderId: order.id, symbol: order.symbol, reason: "MANUAL_CANCEL", cancelledAt: now });
  dbSaveOrderTolerant(order);
  persistSnapshotTolerant();
  return { ...order };
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
