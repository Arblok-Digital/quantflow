import { getDb, initDb, loadAllOrdersDb, loadOpenPositionsDb, getLatestSnapshotDb, savePositionDb, saveOrderDb, saveFillDb, saveSnapshotDb, beginTx, commitTx, rollbackTx, appendAudit } from "../../db";
import { INITIAL_PAPER_CASH, MAINTENANCE_MARGIN_RATE, EVENT_RING_SIZE, MARK_TTL_MS, TAKER_FEE_RATE } from "./config";
import { getBootId } from "./bootId";
import { withPaperMutationLock } from "./mutex";
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
import { normalizeExitConfig, slTightens, slOnSaneSide, feeAwareBreakEvenStop } from "./exitEngine";
import { r2, r3, r4, r6, r8 } from "../lib/round";

export { r2, r3, r4, r6, r8 };

export interface PaperBookState {
  positions: PaperPosition[];
  orders: PaperOrderReceipt[];
  events: PaperEvent[];
  seq: number;
  idSeq: number;
  cash: number;
  realizedPnl: number;
}

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
/**
 * P0-01: SATU hitungan account — dipakai bersama oleh snapshot, account dan
 * balance. Equity = free cash + seluruh margin (posisi OPEN + cadangan limit
 * NEW) + uPnL. Margin limit NEW adalah cadangan (bagian equity), bukan loss:
 * cash sudah dipotong saat NEW (fill.ts), jadi reserved dikembalikan ke equity
 * agar pasang limit tidak menurunkan equity semu (F9). Snapshot sebelumnya
 * mengabaikan reservedMargin → equity curve/maxDrawdown menampilkan drawdown
 * semu; margin_used snapshots juga under-report.
 */
function computeAccountMetrics() {
  const open = state.positions.filter((p) => p.status === "OPEN");
  const marginLocked = open.reduce((sum, p) => sum + p.marginUSD, 0);
  const reservedMargin = state.orders
    .filter((o) => o.status === "NEW" && o.type === "limit" && o.limitPrice && o.limitPrice > 0)
    .reduce((sum, o) => sum + (o.limitPrice! * o.amount) / (o.leverage || 1), 0);
  const unrealized = open.reduce((sum, p) => sum + unrealizedPnlFor(p), 0);
  const equity = state.cash + marginLocked + reservedMargin + unrealized;
  return { marginLocked, reservedMargin, unrealized, equity };
}

export function persistSnapshot(): void {
  const { marginLocked, reservedMargin, unrealized, equity } = computeAccountMetrics();
  saveSnapshotDb({
    ts: Date.now(),
    cash: r2(state.cash),
    margin_used: r2(marginLocked + reservedMargin),
    equity: r2(equity),
    unrealized_pnl: r2(unrealized),
    // F5: tandai penulis — kalau dua proses menulis DB yang sama, lineage
    // bercabang akan terlihat sebagai dua writer_id bergantian (forensik $123).
    writer_id: getBootId(),
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
    // P0-05: qty asal (ukuran trade) + fee kumulatif hidup posisi (rekonsiliasi vs fills).
    open_qty: pos.openQty ?? pos.qty,
    fees_total_usd: pos.feesTotalUSD ?? pos.feesPaidUSD ?? null,
    entry_source: pos.entrySource || "MANUAL",
    decision_id: pos.decisionId ?? null,
    // F3: exit plan (BE/trailing/partial/time-stop) — JSON atau NULL.
    exit_config: pos.exitPlan ? JSON.stringify(pos.exitPlan) : null,
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
    decision_id: order.meta?.decisionId ?? null,
    position_id: order.positionId ?? null,
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
      // F3: rehydrate exit plan (JSON di kolom exit_config) — posisi lama NULL.
      let exitPlan: PaperPosition["exitPlan"] | undefined;
      try {
        exitPlan = r.exit_config != null && String(r.exit_config).trim() !== "" ? JSON.parse(String(r.exit_config)) : undefined;
      } catch {
        exitPlan = undefined;
      }
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
        ...(exitPlan ? { exitPlan } : {}),
        sourceOrderId: String(r.id),
        lastMark: entryPrice,
        lastMarkUpdatedAt: Date.now(),
        feesPaidUSD: r.fees_usd != null ? Number(r.fees_usd) : r4(entryPrice * qty * TAKER_FEE_RATE),
        // P0-05: openQty = qty asal; feesTotalUSD = fee kumulatif hidup posisi
        // (fallback jujur untuk baris lama: qty/fees saat ini, bukan backfill asal).
        openQty: r.open_qty != null ? Number(r.open_qty) : qty,
        feesTotalUSD: r.fees_total_usd != null ? Number(r.fees_total_usd) : r.fees_usd != null ? Number(r.fees_usd) : r4(entryPrice * qty * TAKER_FEE_RATE),
        realizedPnlUSD: r.realized_pnl_usd != null ? Number(r.realized_pnl_usd) : 0,
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
    // Each position stores cumulative realized PnL, including partial exits while OPEN.
    try {
      const closedSum = db.prepare("SELECT SUM(realized_pnl_usd) as sumReal FROM positions").get() as any;
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
  const { marginLocked, reservedMargin, unrealized, equity } = computeAccountMetrics();
  return {
    cash: r2(state.cash),
    equity: r2(equity),
    unrealizedPnl: r2(unrealized),
    realizedPnl: r2(state.realizedPnl),
    openCount: state.positions.filter((p) => p.status === "OPEN").length,
    marginLocked: r2(marginLocked),
    reservedMargin: r2(reservedMargin),
  };
}

export function getPaperBalance(): PaperBalanceEntry[] {
  const account = getPaperAccount();
  // P0-01: used = margin posisi OPEN + cadangan limit NEW; free = cash (sudah
  // dipotong cadangan saat limit NEW). total = free + used, konsisten dengan
  // equity minus uPnL — bukan cash + marginLocked saja.
  const used = account.marginLocked + account.reservedMargin;
  return [
    {
      currency: "USDT",
      free: account.cash,
      used: r2(used),
      total: r2(account.cash + used),
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

  // Hasil break-even yang DITERAPKAN/diSKIP — untuk respons HTTP yang jujur
  // (FE tidak boleh menampilkan "SL digeser" bila sebenarnya di-skip).
  let breakEven: { applied: boolean; reason?: string; note?: string } | undefined;

  // P0-04: snapshot in-memory SEBELUM mutasi apa pun agar DB gagal → rollback
  // paritas MENYELURUH (memori dan DB harus sama setelah gagal, exit-plan / SL
  // / TP turut dikembalikan ke nilai SEMULA — bukan nilai hasil mutasi).
  const posSnap = {
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    exitPlan: pos.exitPlan,
  };

  // P0-04: kumpulkan event sukses untuk dipancarkan SESUDAH commit (DB gagal →
  // mutasi in-memory di-rollback + tidak ada event hantu POSITION_UPDATED dkk).
  const deferredEvents: Array<{ type: PaperEventType; payload: Record<string, unknown> }> = [];
  const emit = (type: PaperEventType, payload: Record<string, unknown>) => deferredEvents.push({ type, payload });

  if (input.breakEven === true) {
    // P0-03: BE manual sadar-fee memakai fee ENTRY aktual pada sisa posisi +
    // estimasi exit taker — maker vs taker membedakan titik BE.
    // Dua guard penting:
    //  1. RATCHET: jangan MELONGGARKAN SL (kalau SL sekarang sudah lebih ketat
    //     dari titik BE, biarkan — proteksi existing dipakai).
    //  2. SIDE + FRESHNESS: jangan menaruh stop di sisi salah terhadap mark,
    //     dan jangan menerapkan BE dengan mark basi/tidak ada (mark < BE pada
    //     LONG justru langsung mentriger stop). Mark basi → skip + event.
    const beSl = feeAwareBreakEvenStop(pos);
    const now = Date.now();
    const markFresh =
      pos.lastMark != null &&
      Number.isFinite(pos.lastMark) &&
      pos.lastMark > 0 &&
      pos.lastMarkUpdatedAt != null &&
      now - pos.lastMarkUpdatedAt <= MARK_TTL_MS;
    if (slTightens(pos, beSl)) {
      if (markFresh && slOnSaneSide(pos, beSl, pos.lastMark!)) {
        pos.stopLoss = beSl;
        breakEven = { applied: true, note: "sadar-fee entry aktual + exit taker" };
        emit("EXIT_ENGINE_ACTION", {
          positionId: pos.id,
          symbol: pos.symbol,
          action: "MANUAL_BE_APPLIED",
          newSl: pos.stopLoss,
          note: "sadar-fee entry aktual + exit taker",
        });
      } else {
        breakEven = {
          applied: false,
          reason: markFresh ? "WRONG_SIDE_VS_MARK" : "MARK_STALE",
          note: markFresh
            ? `BE ${beSl} di sisi salah terhadap mark ${pos.lastMark} — tidak diterapkan`
            : `Mark basi/tidak tersedia (lastMark ${pos.lastMark ?? "-"}) — BE tidak diterapkan`,
        };
        emit("EXIT_ENGINE_ACTION", {
          positionId: pos.id,
          symbol: pos.symbol,
          action: "MANUAL_BE_SKIPPED",
          reason: breakEven.reason,
          note: breakEven.note,
        });
      }
    } else {
      // RATCHET: SL sekarang sudah lebih ketat daripada BE → tidak longgarkan.
      breakEven = {
        applied: false,
        reason: "ALREADY_TIGHTER",
        note: `SL ${pos.stopLoss} sudah lebih ketat dari BE ${beSl} — tidak melonggarkan`,
      };
      emit("EXIT_ENGINE_ACTION", {
        positionId: pos.id,
        symbol: pos.symbol,
        action: "MANUAL_BE_SKIPPED",
        reason: breakEven.reason,
        note: breakEven.note,
      });
    }
  }
  // F3: exit plan opt-in (BE otomatis/trailing/partial/time-stop).
  // undefined = tidak mengubah; null = hapus; objek = pasang/update.
  // Risiko awal (anchor R) DIBEKUKAN dari SL saat plan PERTAMA dipasang.
  if (input.exitConfig !== undefined) {
    if (input.exitConfig === null) {
      if (pos.exitPlan) {
        delete pos.exitPlan;
        emit("EXIT_ENGINE_ACTION", { positionId: pos.id, symbol: pos.symbol, action: "PLAN_REMOVED" });
      }
    } else {
      const cfg = normalizeExitConfig(input.exitConfig);
      if (!cfg) {
        throw new PaperOrderError(
          "INVALID_EXIT_CONFIG",
          "exitConfig tidak berisi komponen valid (breakEvenTriggerR / trailingPct / partialLevels / maxHoldMs)."
        );
      }
      const fresh = pos.exitPlan == null;
      pos.exitPlan = {
        config: cfg,
        state: fresh
          ? {
              initialRiskPerUnit: Math.abs(pos.entryPrice - pos.stopLoss),
              breakevenArmed: false,
              takenPartialR: [],
              peakMark: pos.lastMark && pos.lastMark > 0 ? pos.lastMark : pos.entryPrice,
            }
          : { ...pos.exitPlan.state },
      };
      emit("EXIT_ENGINE_ACTION", {
        positionId: pos.id,
        symbol: pos.symbol,
        action: fresh ? "PLAN_SET" : "PLAN_UPDATED",
        config: cfg,
      });
    }
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

  emit("POSITION_UPDATED", {
    positionId: pos.id,
    symbol: pos.symbol,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    breakEven: input.breakEven === true,
  });

  try {
    beginTx();
    dbSavePosition(pos);
    persistSnapshot();
    commitTx();
  } catch (err) {
    // Rollback in-memory MENYELURUH — memori dan DB harus sama setelah gagal.
    pos.stopLoss = posSnap.stopLoss;
    pos.takeProfit = posSnap.takeProfit;
    pos.exitPlan = posSnap.exitPlan;
    rollbackTx();
    console.error(`[paperBook] Gagal persist update ${positionId}: ${(err as Error).message}`);
    throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis update ke DB: ${(err as Error).message}`);
  }
  // P0-04: success events SESUDAH commit — DB gagal tidak memancarkan
  // POSITION_UPDATED / EXIT_ENGINE_ACTION palsu (mutasi di-rollback).
  for (const { type, payload } of deferredEvents) appendEvent(type, payload);
  const snap = { ...pos } as PaperPosition & { breakEven?: typeof breakEven };
  if (breakEven) snap.breakEven = breakEven;
  return snap;
}

export async function cancelPaperOrder(orderId: string): Promise<PaperOrderReceipt> {
  return withPaperMutationLock(async () => {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new PaperOrderError("ORDER_NOT_FOUND", `Order ${orderId} tidak ditemukan.`);
    if (order.status !== "NEW") {
      throw new PaperOrderError("ORDER_NOT_CANCELLABLE", `Order ${orderId} berstatus ${order.status}; hanya NEW yang bisa dibatalkan.`);
    }
    const now = Date.now();
    // P0-04 snapshot in-memory SEBELUM mutasi agar DB gagal → rollback paritas
    // (cash tidak ter-refund, order tetap NEW, retry aman, event tidak hantu).
    const cancelSnap = {
      cash: state.cash,
      status: order.status,
      cancelledAt: order.cancelledAt,
      reason: order.reason,
    };

    order.status = "CANCELLED";
    order.cancelledAt = now;
    order.reason = "MANUAL_CANCEL";
    if (order.limitPrice && order.limitPrice > 0) {
      const margin = (order.limitPrice * order.amount) / (order.leverage || 1);
      state.cash = r2(state.cash + margin);
    }
    try {
      beginTx();
      dbSaveOrder(order);
      persistSnapshot();
      commitTx();
    } catch (err) {
      // P0-04: rollback in-memory MENYELURUH — memori dan DB harus sama setelah gagal.
      state.cash = cancelSnap.cash;
      order.status = cancelSnap.status;
      order.cancelledAt = cancelSnap.cancelledAt;
      order.reason = cancelSnap.reason;
      rollbackTx();
      console.error(`[paperBook] Gagal persist cancel ${orderId}: ${(err as Error).message}`);
      throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis cancel ke DB: ${(err as Error).message}`);
    }
    // P0-04: success event SESUDAH commit — DB gagal TIDAK memancarkan
    // ORDER_CANCELLED palsu (order tetap NEW, bisa dibatalkan lagi → retry aman).
    appendEvent("ORDER_CANCELLED", { orderId: order.id, symbol: order.symbol, reason: "MANUAL_CANCEL", cancelledAt: now });
    return { ...order };
  });
}

