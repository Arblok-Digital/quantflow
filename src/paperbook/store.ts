import { getDb, initDb, loadAllOrdersDb, loadOpenPositionsDb, getLatestSnapshotDb, savePositionDb, saveOrderDb, saveFillDb, saveSnapshotDb, beginTx, commitTx, rollbackTx, appendAudit } from "../../db";
import { INITIAL_PAPER_CASH, MAINTENANCE_MARGIN_RATE, EVENT_RING_SIZE, TAKER_FEE_RATE } from "./config";
import {
  PaperAccountSnapshot,
  PaperBalanceEntry,
  PaperEvent,
  PaperEventType,
  PaperOrderReceipt,
  PaperOrderStatus,
  PaperPosition,
  PaperPositionStatus,
  PaperSide,
  UpdatePaperPositionInput,
} from "./types";
import { PaperOrderError } from "./errors";

export interface PaperBookState {
  positions: PaperPosition[];
  orders: PaperOrderReceipt[];
  events: PaperEvent[];
  seq: number;
  idSeq: number;
  cash: number;
  realizedPnl: number;
}

function roundTo(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}
export const r2 = (n: number) => roundTo(Number(n), 2);
export const r3 = (n: number) => roundTo(Number(n), 3);
export const r4 = (n: number) => roundTo(Number(n), 4);
export const r6 = (n: number) => roundTo(Number(n), 6);
export const r8 = (n: number) => roundTo(Number(n), 8);

export let state: PaperBookState = {
  positions: [],
  orders: [],
  events: [],
  seq: 0,
  idSeq: 0,
  cash: INITIAL_PAPER_CASH,
  realizedPnl: 0,
};
export let bookInitialized = false;

export function freshState(): PaperBookState {
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
export function persistSnapshot(): void {
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

export function dbSavePosition(pos: PaperPosition): void {
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
    entry_source: pos.entrySource || "MANUAL",
  });
}

export function dbSaveOrder(order: PaperOrderReceipt): void {
  // price = fillPrice, stop_loss/take_profit: prefer receipt fields (limit NEW
  // menyimpan SL/TP langsung), fallback ke posisi tertaut (market FILLED).
  let sl: number | null = order.stopLoss ?? null;
  let tp: number | null = order.takeProfit ?? null;
  if ((sl == null || tp == null) && order.positionId) {
    const linked = state.positions.find((p) => p.id === order.positionId);
    if (linked) {
      if (sl == null) sl = linked.stopLoss ?? null;
      if (tp == null) tp = linked.takeProfit ?? null;
    }
  }
  saveOrderDb({
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    amount: order.amount,
    price: order.fillPrice ?? order.limitPrice ?? null,
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
export function persistSnapshotTolerant(): void {
  try {
    persistSnapshot();
  } catch (err) {
    console.warn(`[paperBook] Gagal persist snapshot (non-tx): ${(err as Error).message}`);
  }
}

export function dbSavePositionTolerant(pos: PaperPosition): void {
  try {
    dbSavePosition(pos);
  } catch (err) {
    console.warn(`[paperBook] Gagal save position (non-tx) ${pos.id}: ${(err as Error).message}`);
  }
}

export function dbSaveOrderTolerant(order: PaperOrderReceipt): void {
  try {
    dbSaveOrder(order);
  } catch (err) {
    console.warn(`[paperBook] Gagal save order (non-tx) ${order.id}: ${(err as Error).message}`);
  }
}

export function deriveIdSeqFromRows(): number {
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
      // Limit NEW tersimpan dengan price=limitPrice (lihat dbSaveOrder).
      // Rehydrate kembali agar bracket monitor bisa fill setelah restart.
      limitPrice: String(r.type) === "limit" && r.price != null ? Number(r.price) : undefined,
      stopLoss: r.stop_loss != null ? Number(r.stop_loss) : undefined,
      takeProfit: r.take_profit != null ? Number(r.take_profit) : undefined,
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
        liquidationPrice: r.liq_price != null ? Number(r.liq_price) : 0, // Liquidation price will be calculated when needed
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

export function appendEvent(type: PaperEventType, payload: Record<string, unknown>): void {
  state.seq += 1;
  state.events.push({ seq: state.seq, timestamp: Date.now(), type, payload });
  if (state.events.length > EVENT_RING_SIZE) {
    state.events.shift();
  }
}

export function newId(prefix: string): string {
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

export function unrealizedPnlFor(pos: PaperPosition): number {
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

