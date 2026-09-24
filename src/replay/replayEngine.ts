/**
 * src/replay/replayEngine.ts
 * REPLAY / FORWARD-TEST ENGINE — isolated paper book driven by REAL historical
 * candles (Binance Vision klines). Tujuan: training AI dengan data real tanpa
 * menyentuh akun paper live. Book replay 100% terpisah dari paper book utama.
 *
 * Setiap candle diproses deterministik:
 *  1. mark = close candle
 *  2. pending limit order dicek terhadap range (high/low) candle
 *  3. posisi terbuka dicek terhadap SL/TP/liq menggunakan range candle
 *  4. event dicatat ke log replay sendiri
 */

import { calculateRSI, calculateEMA, calculateMACD, calculateATR } from "../logic/indicators";
import { roundTo } from "../lib/round";
// P1-03: kontrak biaya/margin SATU SUMBER (paperbook/config) — replay & paper
// tidak boleh drift nilainya. Nilai dari env PAPER_FEE_TAKER_BPS / MMR 0.4%.
// Import + re-export: binding lokal DIPAKAI di dalam modul ini juga.
import { TAKER_FEE_RATE, MAKER_FEE_RATE, MAINTENANCE_MARGIN_RATE, MAX_LEVERAGE } from "../paperbook/config";
export { TAKER_FEE_RATE, MAKER_FEE_RATE, MAINTENANCE_MARGIN_RATE, MAX_LEVERAGE };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ReplayCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ReplaySide = "LONG" | "SHORT";
export type ReplayExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL" | "LIQUIDATED";

/**
 * Parameter strategi AUTO (backtest deterministik, tanpa LLM — murni teknikal).
 * Sinyal: RSI oversold/overbought + konfirmasi trend (EMA50) ATAU volume surge.
 * SL/TP dari ATR.
 */
export interface ReplayAutoParams {
  /** RSI ≤ ini → sinyal LONG (oversold). Default 35. */
  rsiLong: number;
  /** RSI ≥ ini → sinyal SHORT (overbought). Default 65. */
  rsiShort: number;
  /** SL = entry ∓ slAtrMult × ATR(14). Default 1.2. */
  slAtrMult: number;
  /** TP = entry ± tpAtrMult × ATR(14). Default 2.4 (R:R 2:1). */
  tpAtrMult: number;
  /** Jumlah candle minimum sebelum sinyal boleh muncul. Default 30. */
  minCandles: number;
  /** Cooldown (candle) setelah posisi ditutup sebelum masuk lagi. Default 3. */
  cooldownCandles: number;
  /** Risiko per trade (% equity) untuk sizing qty. Default 2. */
  riskPct: number;
  /** Leverage untuk posisi auto. Default 10. */
  leverage: number;
}

export const DEFAULT_AUTO_PARAMS: ReplayAutoParams = {
  rsiLong: 35,
  rsiShort: 65,
  slAtrMult: 1.2,
  tpAtrMult: 2.4,
  minCandles: 30,
  cooldownCandles: 3,
  riskPct: 2,
  leverage: 10,
};

export interface ReplayPosition {
  id: string;
  symbol: string;
  side: ReplaySide;
  qty: number;
  entryPrice: number;
  notionalUSD: number;
  leverage: number;
  marginUSD: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  openedAt: number;
  openedCandleIndex: number;
  status: "OPEN" | "CLOSED";
  lastMark?: number;
  closedAt?: number;
  exitPrice?: number;
  exitReason?: ReplayExitReason;
  realizedPnlUSD?: number;
  feesPaidUSD: number;
  maintenanceMarginRate: number;
  decisionId?: string;
  /** P1-03b: asal entry — "MANUAL" (klik user) | "AUTOPILOT" | "replay-auto" (RSI-EMA-VOL-ATR). */
  entrySource?: string;
  strategy?: string;
}

export interface ReplayOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage: number;
  status: "NEW" | "FILLED" | "CANCELLED" | "REJECTED";
  createdAt: number;
  fillPrice?: number;
  feeUSD?: number;
  positionId?: string;
  reason?: string;
  meta?: Record<string, unknown>;
  decisionId?: string;
}

export type ReplayEventType =
  | "ORDER_NEW"
  | "ORDER_FILLED"
  | "ORDER_CANCELLED"
  | "POSITION_CLOSED"
  | "LIQUIDATED"
  | "AUTO_SIGNAL"
  | "REPLAY_AMBIGUITY"
  | "REPLAY_STEP"
  | "REPLAY_START"
  | "REPLAY_DONE"
  | "ERROR";

export interface ReplayEvent {
  seq: number;
  timestamp: number;
  candleIndex: number;
  type: ReplayEventType;
  payload: Record<string, unknown>;
}

export interface ReplayTrade {
  id: string;
  symbol: string;
  side: ReplaySide;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: ReplayExitReason;
  openedAt: number;
  openedCandleIndex: number;
  openedCandleTs?: number;
  closedAt: number;
  closedCandleIndex: number;
  closedCandleTs?: number;
  pnlUSD: number;
  pnlPercent: number;
  feesPaidUSD: number;
  leverage: number;
  decisionId?: string;
  /** P1-03b: asal entry (MANUAL/AUTOPILOT/replay-auto) + strategi (RSI-EMA-VOL-ATR dst). */
  entrySource?: string;
  strategy?: string;
  /**
   * P1-03: true bila dalam SATU candle tersentuh level sisi-laba (TP) DAN
   * sisi-rugi (SL/liq) sekaligus — urutan aktual tidak diketahui dari OHLC.
   * Replay memakai urutan worst-case deterministik, dan flag ini TIDAK
   * mengklaim tahu urutan sebenarnya (jujur terhadap data candle).
   */
  ambiguousExit?: boolean;
}

export type ReplayStatus = "idle" | "running" | "paused" | "done";

export interface ReplaySession {
  id: string;
  symbol: string;
  timeframe: string;
  candles: ReplayCandle[];
  /** Sumber candle: "binance" (Binance Vision) | "mql5" (file CSV MT5). */
  dataSource: string;
  /** Jumlah total candle (FE tidak boleh pakai candles.length — status endpoint
   *  memotong candles ke 10 utk polling ringan). */
  totalCandles?: number;
  /** Candle yang sedang aktif (posisi currentIndex). Dikirim server karena
   *  list candles dipotong — FE wajib pakai ini untuk entry price & timestamp. */
  currentCandle?: ReplayCandle | null;
  currentIndex: number;
  status: ReplayStatus;
  speedMs: number;
  startedAt: number;
  initialCash: number;
  cash: number;
  realizedPnl: number;
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  events: ReplayEvent[];
  trades: ReplayTrade[];
  peakEquity: number;
  maxDrawdownPct: number;
  seq: number;
  idSeq: number;
  /** "auto" = strategi teknikal dieksekusi otomatis per candle; "manual" = user klik. */
  mode: "manual" | "auto";
  autoParams: ReplayAutoParams;
  /** Index candle terakhir saat posisi (mana pun) ditutup — cooldown re-entry auto. */
  lastAutoExitCandle: number | null;
  /** Sinyal auto terakhir (untuk ditampilkan FE). */
  lastAutoSignal: {
    index: number;
    action: "BUY" | "SELL" | "HOLD";
    reason: string;
    candleClose: number;
  } | null;
  error?: string;
}
// ---------------------------------------------------------------------------
// Constants (env-configurable, sinkron dengan paperBook.ts)
// ---------------------------------------------------------------------------
const envPositiveInt = (v: string | undefined, def: number): number => {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

export const DEFAULT_INITIAL_CASH = envPositiveInt(process.env.PAPER_INITIAL_CASH, 10000);
export const DEFAULT_SPEED_MS = 100;
export const MAX_EVENTS = 500;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let session: ReplaySession | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function newId(prefix: string): string {
  const n = (session?.idSeq ?? 0) + 1;
  if (session) session.idSeq = n;
  return `${prefix}-replay-${Date.now().toString(36)}-${n}`;
}

export function r2(v: number): number {
  return roundTo(v, 2);
}
export function r4(v: number): number {
  return roundTo(v, 4);
}
export function r6(v: number): number {
  return roundTo(v, 6);
}

function clampLeverage(leverage: number): number {
  if (!Number.isFinite(leverage) || leverage <= 0) return 1;
  return Math.min(leverage, MAX_LEVERAGE);
}

/** P1-03b: formula likuidasi — di-export agar parity dgn paperbook/fill bisa
 *  diuji permanen (matriks tests/paperContractConsistency.test.ts). */
export function liquidationPrice(entry: number, leverage: number, side: ReplaySide): number {
  const lev = clampLeverage(leverage);
  if (side === "LONG") return r6(entry * (1 - 1 / lev + MAINTENANCE_MARGIN_RATE));
  return r6(entry * (1 + 1 / lev - MAINTENANCE_MARGIN_RATE));
}

function freshSession(symbol: string, timeframe: string, candles: ReplayCandle[], initialCash: number, dataSource: string): ReplaySession {
  return {
    id: `replay-${Date.now().toString(36)}`,
    symbol,
    timeframe,
    candles,
    dataSource,
    currentIndex: -1,
    status: "idle",
    speedMs: DEFAULT_SPEED_MS,
    startedAt: Date.now(),
    initialCash,
    cash: initialCash,
    realizedPnl: 0,
    positions: [],
    orders: [],
    events: [],
    trades: [],
    peakEquity: initialCash,
    maxDrawdownPct: 0,
    seq: 0,
    idSeq: 0,
    mode: "manual",
    autoParams: { ...DEFAULT_AUTO_PARAMS },
    lastAutoExitCandle: null,
    lastAutoSignal: null,
  };
}

function pushEvent(type: ReplayEventType, payload: Record<string, unknown>): void {
  if (!session) return;
  session.seq += 1;
  session.events.push({ seq: session.seq, timestamp: Date.now(), candleIndex: session.currentIndex, type, payload });
  if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
}

// ---------------------------------------------------------------------------
// Historical candle fetching (Binance Vision, paginated by startTime)
// ---------------------------------------------------------------------------
function parseSymbol(symbol: string): string {
  return symbol.toUpperCase().replace("/", "");
}

export async function fetchHistoricalCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number
): Promise<{ candles: ReplayCandle[]; error?: string }> {
  const rawSymbol = parseSymbol(symbol);
  const intervalMap: Record<string, string> = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "8h": "8h",
    "12h": "12h", "1D": "1d", "1W": "1w",
  };
  const interval = intervalMap[timeframe] || "15m";
  const candles: ReplayCandle[] = [];
  let cursor = startMs;
  const MAX_PER_CALL = 1500;

  while (cursor < endMs) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${rawSymbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=${MAX_PER_CALL}`;
    let rows: any[] = [];
    try {
      const res = await fetch(url);
      if (!res.ok) return { candles, error: `Binance Vision HTTP ${res.status}` };
      rows = await res.json();
    } catch (err) {
      return { candles, error: `Binance Vision fetch gagal: ${(err as Error).message}` };
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const k of rows) {
      candles.push({
        timestamp: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }
    const lastTs = Number(rows[rows.length - 1][0]);
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
  }

  if (candles.length === 0) return { candles, error: "Tidak ada data historis untuk rentang tersebut." };
  return { candles };
}

// ---------------------------------------------------------------------------
// Replay book logic (isolated)
// ---------------------------------------------------------------------------
function equity(): number {
  if (!session) return 0;
  const marginLocked = session.positions.filter((p) => p.status === "OPEN").reduce((s, p) => s + p.marginUSD, 0);
  const unrealized = session.positions
    .filter((p) => p.status === "OPEN")
    .reduce((s, p) => {
      const mark = p.lastMark ?? p.entryPrice;
      const pnl = p.side === "LONG" ? (mark - p.entryPrice) * p.qty : (p.entryPrice - mark) * p.qty;
      return s + pnl;
    }, 0);
  return session.cash + marginLocked + unrealized;
}
// ---------------------------------------------------------------------------
// Candle processing — deterministic bracket + limit fill logic
// ---------------------------------------------------------------------------
function closeReplayPosition(pos: ReplayPosition, exitPrice: number, reason: ReplayExitReason, candleIndex: number, opts?: CloseReplayOpts): void {
  if (!session) return;
  const now = Date.now();
  pos.status = "CLOSED";
  pos.closedAt = now;
  pos.exitPrice = exitPrice;
  pos.exitReason = reason;
  // Cooldown untuk mode auto: jangan langsung re-entry setelah exit.
  session.lastAutoExitCandle = candleIndex;
  const grossPnl = pos.side === "LONG" ? (exitPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPrice) * pos.qty;
  const exitFee = r4(exitPrice * pos.qty * TAKER_FEE_RATE);
  let netPnl = r2(grossPnl - exitFee - pos.feesPaidUSD);
  let cashRelease = pos.marginUSD + grossPnl - exitFee;
  if (netPnl <= -pos.marginUSD) {
    pos.exitPrice = pos.liquidationPrice;
    pos.exitReason = "LIQUIDATED";
    netPnl = -pos.marginUSD;
    cashRelease = pos.feesPaidUSD;
  }
  pos.realizedPnlUSD = netPnl;
  session.cash = r2(session.cash + cashRelease);
  session.realizedPnl = r2(session.realizedPnl + netPnl);
  const closeCandle = session.candles[candleIndex];
  session.trades.push({
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    qty: pos.qty,
    entryPrice: pos.entryPrice,
    exitPrice: pos.exitPrice,
    exitReason: pos.exitReason,
    openedAt: pos.openedAt,
    openedCandleIndex: pos.openedCandleIndex,
    openedCandleTs: session.candles[pos.openedCandleIndex]?.timestamp,
    closedAt: now,
    closedCandleIndex: candleIndex,
    closedCandleTs: closeCandle?.timestamp,
    pnlUSD: netPnl,
    pnlPercent: r2((netPnl / pos.marginUSD) * 100),
    feesPaidUSD: r2(pos.feesPaidUSD + exitFee),
    leverage: pos.leverage,
    decisionId: pos.decisionId,
    entrySource: pos.entrySource,
    strategy: pos.strategy,
    ...(opts?.ambiguous ? { ambiguousExit: true } : {}),
  });
  pushEvent(pos.exitReason === "LIQUIDATED" ? "LIQUIDATED" : "POSITION_CLOSED", {
    positionId: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    qty: pos.qty,
    exitPrice: pos.exitPrice,
    exitReason: pos.exitReason,
    realizedPnlUSD: netPnl,
    feesPaidUSD: r2(pos.feesPaidUSD + exitFee),
    candleIndex,
    openedCandleIndex: pos.openedCandleIndex,
    decisionId: pos.decisionId,
    ambiguousExit: opts?.ambiguous ? true : undefined,
  });
}

interface CloseReplayOpts {
  /** P1-03: beberapa level exit tersentuh dalam candle yang sama → urutan tidak diketahui. */
  ambiguous?: boolean;
}

function processCandle(candle: ReplayCandle): void {
  if (!session) return;
  session.currentIndex += 1;
  const idx = session.currentIndex;

  // 1. Update marks on open positions
  for (const pos of session.positions.filter((p) => p.status === "OPEN")) {
    pos.lastMark = candle.close;
  }

  // 2. Fill pending limit orders against candle range
  for (const order of session.orders.filter((o) => o.status === "NEW" && o.type === "limit" && o.limitPrice)) {
    const limit = order.limitPrice!;
    const crossed = order.side === "buy" ? candle.low <= limit : candle.high >= limit;
    if (!crossed) continue;
    const side: ReplaySide = order.side === "sell" ? "SHORT" : "LONG";
    const dup = session.positions.find((p) => p.symbol === order.symbol && p.side === side && p.status === "OPEN");
    const notional = limit * order.amount;
    const marginUSD = notional / order.leverage;
    const feeUSD = r4(notional * MAKER_FEE_RATE);
    if (dup) {
      order.status = "CANCELLED";
      order.reason = "DUPLICATE_POSITION_DIRECTION_ON_FILL";
      session.cash = r2(session.cash + marginUSD);
      pushEvent("ORDER_CANCELLED", { orderId: order.id, symbol: order.symbol, reason: "DUPLICATE_POSITION_DIRECTION_ON_FILL" });
      continue;
    }
    const positionId = newId("pos");
    order.status = "FILLED";
    order.fillPrice = limit;
    order.feeUSD = feeUSD;
    order.positionId = positionId;
    order.decisionId = order.decisionId ?? (order.meta as any)?.decisionId;
    session.cash = r2(session.cash - feeUSD);
    const metaObj = order.meta && typeof order.meta === "object" ? (order.meta as Record<string, any>) : {};
    // P1-03b: provenance entry — sama dengan jalur market (jujur).
    const entrySource = metaObj?.source ? String(metaObj.source) : order.decisionId != null ? "AUTOPILOT" : "MANUAL";
    const strategy = metaObj?.strategy ? String(metaObj.strategy) : undefined;
    const position: ReplayPosition = {
      id: positionId,
      symbol: order.symbol,
      side,
      qty: order.amount,
      entryPrice: limit,
      notionalUSD: r2(notional),
      leverage: order.leverage,
      marginUSD: r2(marginUSD),
      stopLoss: order.stopLoss || 0,
      takeProfit: order.takeProfit || 0,
      liquidationPrice: liquidationPrice(limit, order.leverage, side),
      maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
      decisionId: order.decisionId,
      entrySource,
      strategy,
      openedAt: Date.now(),
      openedCandleIndex: idx,
      status: "OPEN",
      lastMark: candle.close,
      feesPaidUSD: feeUSD,
    };
    session.positions.push(position);
    pushEvent("ORDER_FILLED", { orderId: order.id, positionId, symbol: order.symbol, side: order.side, type: "limit", fillPrice: limit, qty: order.amount, feeUSD, method: "LIMIT_MAKER", entrySource, strategy, decisionId: order.decisionId });
  }

  // 3. Bracket checks (SL/TP/liq) using candle range
  // Auditor WARN-3 (documented, disengaja): dalam candle yang SAMA terjadi
  // LIQ > STOP_LOSS > TAKE_PROFIT — urutan worst-case (conservative loss-first).
  // P1-03: (a) posisi yang BARU dibuka di candle ini (openedCandleIndex === idx)
  // TIDAK dicek terhadap range candle yang sama — high/low itu terjadi SEBELUM
  // entry (belum semua pengamat tahu kapan dalam candle), jadi tidak boleh
  // mengeksekusi stop dari rentang pre-entry; (b) bila dalam SATU candle
  // tersentuh level sisi-rugi (liq/SL) DAN sisi-laba (TP) sekaligus, urutan
  // aktual tidak dapat ditentukan dari OHLC → tandai `ambiguousExit` (jujur),
  // bukan mengklaim urutan.
  const open = session.positions.filter((p) => p.status === "OPEN");
  for (const pos of open) {
    if (pos.openedCandleIndex === idx) continue; // P1-03a: jangan pakai high/low pre-entry
    if (pos.side === "LONG") {
      const touchedLiq = candle.low <= pos.liquidationPrice;
      const touchedSL = pos.stopLoss > 0 && candle.low <= pos.stopLoss;
      const touchedTP = pos.takeProfit > 0 && candle.high >= pos.takeProfit;
      if (touchedLiq) {
        if (touchedTP) {
          pushEvent("REPLAY_AMBIGUITY", { positionId: pos.id, symbol: pos.symbol, side: pos.side, candleIndex: idx, touched: ["LIQUIDATION", "TAKE_PROFIT"] });
          closeReplayPosition(pos, pos.liquidationPrice, "LIQUIDATED", idx, { ambiguous: true });
        } else {
          closeReplayPosition(pos, pos.liquidationPrice, "LIQUIDATED", idx);
        }
      } else if (touchedSL) {
        if (touchedTP) {
          pushEvent("REPLAY_AMBIGUITY", { positionId: pos.id, symbol: pos.symbol, side: pos.side, candleIndex: idx, touched: ["STOP_LOSS", "TAKE_PROFIT"] });
          closeReplayPosition(pos, pos.stopLoss, "STOP_LOSS", idx, { ambiguous: true });
        } else {
          closeReplayPosition(pos, pos.stopLoss, "STOP_LOSS", idx);
        }
      } else if (touchedTP) {
        closeReplayPosition(pos, pos.takeProfit, "TAKE_PROFIT", idx);
      }
    } else {
      const touchedLiq = candle.high >= pos.liquidationPrice;
      const touchedSL = pos.stopLoss > 0 && candle.high >= pos.stopLoss;
      const touchedTP = pos.takeProfit > 0 && candle.low <= pos.takeProfit;
      if (touchedLiq) {
        if (touchedTP) {
          pushEvent("REPLAY_AMBIGUITY", { positionId: pos.id, symbol: pos.symbol, side: pos.side, candleIndex: idx, touched: ["LIQUIDATION", "TAKE_PROFIT"] });
          closeReplayPosition(pos, pos.liquidationPrice, "LIQUIDATED", idx, { ambiguous: true });
        } else {
          closeReplayPosition(pos, pos.liquidationPrice, "LIQUIDATED", idx);
        }
      } else if (touchedSL) {
        if (touchedTP) {
          pushEvent("REPLAY_AMBIGUITY", { positionId: pos.id, symbol: pos.symbol, side: pos.side, candleIndex: idx, touched: ["STOP_LOSS", "TAKE_PROFIT"] });
          closeReplayPosition(pos, pos.stopLoss, "STOP_LOSS", idx, { ambiguous: true });
        } else {
          closeReplayPosition(pos, pos.stopLoss, "STOP_LOSS", idx);
        }
      } else if (touchedTP) {
        closeReplayPosition(pos, pos.takeProfit, "TAKE_PROFIT", idx);
      }
    }
  }

  // 3b. AUTO-EXECUTE: kalau mode "auto", jalankan strategi teknikal
  // deterministik pada candle ini (alpha = up-to-now, tanpa lookahead).
  if (session.mode === "auto") {
    maybeAutoExecute(idx);
  }

  // 4. Track peak equity / max drawdown
  const eq = equity();
  session.peakEquity = Math.max(session.peakEquity, eq);
  if (session.peakEquity > 0) {
    session.maxDrawdownPct = Math.max(session.maxDrawdownPct, ((session.peakEquity - eq) / session.peakEquity) * 100);
  }

  pushEvent("REPLAY_STEP", { candleIndex: idx, timestamp: candle.timestamp, close: candle.close, equity: r2(eq) });

  // 5. Done?
  if (idx >= session.candles.length - 1) {
    session.status = "done";
    stopTimer();
    pushEvent("REPLAY_DONE", { totalCandles: session.candles.length, trades: session.trades.length, realizedPnl: session.realizedPnl, finalEquity: r2(eq) });
  }
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function getReplayStatus(): { active: boolean; session: ReplaySession | null } {
  return {
    active: !!session,
    session: session
      ? {
          ...session,
          // Polling 1.5s harus ringan: kirim 10 candle + currentCandle (1 objek)
          // + totalCandles (angka). FE JANGAN pakai candles[currentIndex] —
          // cukup currentCandle (server-truth) untuk harga & timestamp.
          candles: session.candles.slice(0, 10),
          totalCandles: session.candles.length,
          currentCandle: session.currentIndex >= 0 ? session.candles[session.currentIndex] : null,
        }
      : null,
  };
}

export function startReplay(symbol: string, timeframe: string, candles: ReplayCandle[], initialCash: number, dataSource = "binance"): ReplaySession {
  stopTimer();
  session = freshSession(symbol, timeframe, candles, initialCash, dataSource);
  pushEvent("REPLAY_START", { symbol, timeframe, candles: candles.length, initialCash, dataSource });
  return { ...session };
}

export function stepReplay(): ReplaySession {
  if (!session) throw new Error("Tidak ada sesi replay aktif. Mulai replay dulu.");
  if (session.status === "done") return { ...session };
  session.status = "running";
  const candle = session.candles[session.currentIndex + 1];
  if (!candle) {
    session.status = "done";
    return { ...session };
  }
  processCandle(candle);
  return { ...session };
}

export function runReplay(): ReplaySession {
  if (!session) return { ...session! };
  if (session.status === "done") return { ...session };
  session.status = "running";
  stopTimer();
  timer = setInterval(() => {
    if (!session) return stopTimer();
    if (session.status !== "running") return;
    stepReplay();
  }, Math.max(1, session.speedMs));
  return { ...session };
}

export function pauseReplay(): ReplaySession {
  stopTimer();
  if (session && session.status === "running") session.status = "paused";
  return session ? { ...session } : null as any;
}

export function resetReplay(): ReplaySession {
  stopTimer();
  const prev = session;
  if (prev) {
    session = freshSession(prev.symbol, prev.timeframe, prev.candles, prev.initialCash, prev.dataSource);
  }
  return session ? { ...session } : null as any;
}

export function setReplaySpeed(speedMs: number): ReplaySession {
  if (!session) throw new Error("Tidak ada sesi replay aktif.");
  session.speedMs = Math.max(1, Math.min(60000, Math.floor(speedMs)));
  return { ...session };
}

// ---------------------------------------------------------------------------
// Auto-execute strategy — backtest deterministik (tanpa LLM, alpha = up-to-now)
// Sinyal: RSI oversold/overbought + konfirmasi trend EMA50 ATAU volume surge.
// SL/TP dari ATR(14). Tanpa lookahead: hanya pakai candle 0..currentIndex.
// ---------------------------------------------------------------------------
export function setReplayMode(mode: "manual" | "auto", params?: Partial<ReplayAutoParams>): ReplaySession {
  if (!session) throw new Error("Tidak ada sesi replay aktif.");
  session.mode = mode;
  if (params) session.autoParams = { ...session.autoParams, ...params };
  pushEvent("REPLAY_START", { kind: "mode_change", mode, params: params ? { ...params } : undefined });
  return { ...session };
}

export function evaluateAutoStrategy(idx: number): {
  action: "BUY" | "SELL" | "HOLD";
  sl?: number;
  tp?: number;
  reason: string;
  candleClose: number;
} {
  const s = session!;
  const p = s.autoParams;
  const candle = s.candles[idx];
  const closes = s.candles.slice(0, idx + 1).map((c) => c.close);
  if (!candle || closes.length < p.minCandles) {
    return { action: "HOLD", reason: `belum cukup data (${closes.length}/${p.minCandles})`, candleClose: candle?.close ?? 0 };
  }
  const rsi = calculateRSI(closes, 14);
  const ema50 = calculateEMA(closes, 50);
  const macd = calculateMACD(closes);
  const atr = calculateATR(s.candles.slice(0, idx + 1), 14);
  // Volume surge 20-candle (konfirmasi partisipasi besar = "smart money").
  const volWindow = s.candles.slice(Math.max(0, idx - 19), idx + 1);
  const avgVol = volWindow.reduce((a, c) => a + c.volume, 0) / Math.max(1, volWindow.length);
  const volSurge = avgVol > 0 && candle.volume > avgVol * 1.4;

  const price = candle.close;
  const bullTrend = price > ema50 && macd.histogram >= 0;
  const bearTrend = price < ema50 && macd.histogram <= 0;

  if (rsi <= p.rsiLong && (bullTrend || volSurge)) {
    return {
      action: "BUY",
      sl: Number((price - atr * p.slAtrMult).toFixed(2)),
      tp: Number((price + atr * p.tpAtrMult).toFixed(2)),
      reason: `RSI ${rsi} oversold${bullTrend ? " + trend EMA50" : ""}${volSurge ? " + volume surge" : ""}`,
      candleClose: price,
    };
  }
  if (rsi >= p.rsiShort && (bearTrend || volSurge)) {
    return {
      action: "SELL",
      sl: Number((price + atr * p.slAtrMult).toFixed(2)),
      tp: Number((price - atr * p.tpAtrMult).toFixed(2)),
      reason: `RSI ${rsi} overbought${bearTrend ? " + trend EMA50" : ""}${volSurge ? " + volume surge" : ""}`,
      candleClose: price,
    };
  }
  return {
    action: "HOLD",
    reason: `RSI ${rsi} netral${bullTrend ? " (bullish)" : bearTrend ? " (bearish)" : ""}${volSurge ? " + volume surge" : ""}`,
    candleClose: price,
  };
}

function maybeAutoExecute(idx: number): void {
  if (!session) return;
  const p = session.autoParams;
  if (idx < p.minCandles) return;
  // Satu posisi per simbol pada satu waktu (mode auto) + jangan ada pending order.
  if (session.positions.some((pos) => pos.status === "OPEN")) return;
  if (session.orders.some((o) => o.status === "NEW")) return;
  if (session.lastAutoExitCandle != null && idx - session.lastAutoExitCandle < p.cooldownCandles) return;

  const signal = evaluateAutoStrategy(idx);
  const s = session;
  s.lastAutoSignal = { index: idx, action: signal.action, reason: signal.reason, candleClose: signal.candleClose };
  pushEvent("AUTO_SIGNAL", { index: idx, action: signal.action, reason: signal.reason, candleClose: signal.candleClose });
  if (signal.action === "HOLD" || !signal.sl || !signal.tp) return;

  // Sizing berbasis risiko: risk% equity / (|entry - SL|).
  const entry = signal.candleClose;
  const riskUsd = (equity() * p.riskPct) / 100;
  const riskPerUnit = Math.abs(entry - signal.sl);
  let qty = riskPerUnit > 1e-9 ? riskUsd / riskPerUnit : 0;
  const maxQtyByMargin = (s.cash * p.leverage) / entry;
  qty = Math.min(qty, maxQtyByMargin * 0.9);
  qty = Number(qty.toFixed(6));
  if (qty <= 0) return;

  const decisionId = `auto-${idx}-${signal.action}-${s.idSeq}`;
  try {
    placeReplayOrder({
      symbol: s.symbol,
      side: signal.action === "BUY" ? "buy" : "sell",
      type: "market",
      amount: qty,
      leverage: p.leverage,
      stopLoss: signal.sl,
      takeProfit: signal.tp,
      decisionId,
      meta: { source: "replay-auto", strategy: "RSI-EMA-VOL-ATR", reason: signal.reason, candleIndex: idx },
    });
  } catch (err) {
    // Order auto ditolak (duplicate / invalid stop) — aman, terekam via event.
    pushEvent("ERROR", { source: "auto-execute", message: (err as Error).message, index: idx });
  }
}
export interface ReplayOrderInput {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  meta?: Record<string, unknown>;
  /** AI decision id — ikut di event ORDER_NEW/ORDER_FILLED replay (training join). */
  decisionId?: string;
}

export function placeReplayOrder(input: ReplayOrderInput): ReplayOrder {
  if (!session) throw new Error("Tidak ada sesi replay aktif.");
  const qty = Number(input.amount);
  if (!isFinite(qty) || qty <= 0) throw new Error("amount harus angka positif.");
  const leverage = input.leverage && input.leverage > 0 ? Math.min(MAX_LEVERAGE, Number(input.leverage)) : 1;
  const symbol = input.symbol.toUpperCase().replace("/", "");
  const stopLoss = Number(input.stopLoss);
  const takeProfit = Number(input.takeProfit);
  if (!isFinite(stopLoss) || stopLoss <= 0 || !isFinite(takeProfit) || takeProfit <= 0) {
    throw new Error("stopLoss dan takeProfit wajib diisi untuk posisi baru.");
  }
  const orderId = newId("ord");
  const decisionId = input.decisionId ?? ((input.meta as any)?.decisionId ? String((input.meta as any).decisionId) : undefined);
  const metaObj = input.meta && typeof input.meta === "object" ? (input.meta as Record<string, any>) : {};
  // P1-03b: provenance entry — jujur: replay-auto (RSI), AUTOPILOT (decisionId
  // dari luar), selain itu MANUAL. Bukan dibuat-buat.
  const entrySource = metaObj?.source ? String(metaObj.source) : decisionId != null ? "AUTOPILOT" : "MANUAL";
  const strategy = metaObj?.strategy ? String(metaObj.strategy) : undefined;
  const order: ReplayOrder = {
    id: orderId,
    symbol,
    side: input.side === "sell" ? "sell" : "buy",
    type: input.type === "limit" ? "limit" : "market",
    amount: qty,
    limitPrice: input.limitPrice ? Number(input.limitPrice) : undefined,
    stopLoss,
    takeProfit,
    leverage,
    status: "NEW",
    createdAt: Date.now(),
    meta: input.meta,
    decisionId,
  };
  pushEvent("ORDER_NEW", { orderId, symbol, side: order.side, type: order.type, amount: qty, limitPrice: order.limitPrice, leverage, decisionId });

  if (order.type === "market") {
    const candle = session.candles[session.currentIndex];
    if (!candle) throw new Error("Belum ada candle — jalankan step dulu.");
    const fillPrice = candle.close;
    const side: ReplaySide = order.side === "sell" ? "SHORT" : "LONG";
    const dup = session.positions.find((p) => p.symbol === symbol && p.side === side && p.status === "OPEN");
    if (dup) {
      order.status = "REJECTED";
      order.reason = "DUPLICATE_POSITION_DIRECTION";
      pushEvent("ORDER_CANCELLED", { orderId, symbol, reason: "DUPLICATE_POSITION_DIRECTION" });
      return { ...order };
    }
    if (side === "LONG" && !(stopLoss < fillPrice && fillPrice < takeProfit)) {
      order.status = "REJECTED";
      order.reason = "INVALID_STOP";
      pushEvent("ORDER_CANCELLED", { orderId, symbol, reason: "INVALID_STOP" });
      return { ...order };
    }
    if (side === "SHORT" && !(takeProfit < fillPrice && fillPrice < stopLoss)) {
      order.status = "REJECTED";
      order.reason = "INVALID_STOP";
      pushEvent("ORDER_CANCELLED", { orderId, symbol, reason: "INVALID_STOP" });
      return { ...order };
    }
    const notional = fillPrice * qty;
    const marginUSD = notional / leverage;
    if (marginUSD > session.cash) {
      order.status = "REJECTED";
      order.reason = "INSUFFICIENT_CASH";
      pushEvent("ORDER_CANCELLED", { orderId, symbol, reason: "INSUFFICIENT_CASH" });
      return { ...order };
    }
    const feeUSD = r4(notional * TAKER_FEE_RATE);
    const positionId = newId("pos");
    order.status = "FILLED";
    order.fillPrice = fillPrice;
    order.feeUSD = feeUSD;
    order.positionId = positionId;
    session.cash = r2(session.cash - marginUSD - feeUSD);
    session.positions.push({
      id: positionId,
      symbol,
      side,
      qty,
      entryPrice: fillPrice,
      notionalUSD: r2(notional),
      leverage,
      marginUSD: r2(marginUSD),
      stopLoss,
      takeProfit,
      liquidationPrice: liquidationPrice(fillPrice, leverage, side),
maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
      decisionId,
      entrySource,
      strategy,
      openedAt: Date.now(),
      openedCandleIndex: session.currentIndex,
      status: "OPEN",
      lastMark: candle.close,
      feesPaidUSD: feeUSD,
    });
    pushEvent("ORDER_FILLED", { orderId, positionId, symbol, side: order.side, type: "market", fillPrice, qty, feeUSD, method: "MARKET_TAKER", decisionId });
    return { ...order };
  }

  // Limit order: reserve margin, wait for candle range to cross.
  // Validasi konsistensi bracket SEBELUM reserve margin: LONG stopLoss < limit <
  // takeProfit ; SHORT takeProfit < limit < stopLoss (sama seperti market).
  const limitSide: ReplaySide = order.side === "sell" ? "SHORT" : "LONG";
  const limitEntry = order.limitPrice!;
  if (limitSide === "LONG" && !(stopLoss < limitEntry && limitEntry < takeProfit)) {
    order.status = "REJECTED";
    order.reason = "INVALID_STOP";
    pushEvent("ORDER_CANCELLED", { orderId, symbol, reason: "INVALID_STOP" });
    return { ...order };
  }
  if (limitSide === "SHORT" && !(takeProfit < limitEntry && limitEntry < stopLoss)) {
    order.status = "REJECTED";
    order.reason = "INVALID_STOP";
    pushEvent("ORDER_CANCELLED", { orderId, symbol, reason: "INVALID_STOP" });
    return { ...order };
  }
  const estimatedMargin = (order.limitPrice! * qty) / leverage;
  if (estimatedMargin > session.cash) {
    order.status = "REJECTED";
    order.reason = "INSUFFICIENT_CASH";
    pushEvent("ORDER_CANCELLED", { orderId, symbol, reason: "INSUFFICIENT_CASH" });
    return { ...order };
  }
  session.cash = r2(session.cash - estimatedMargin);
  session.orders.push(order);
  return { ...order };
}

export function closeReplayPositionManual(positionId: string): ReplayPosition {
  if (!session) throw new Error("Tidak ada sesi replay aktif.");
  const pos = session.positions.find((p) => p.id === positionId && p.status === "OPEN");
  if (!pos) throw new Error(`Posisi ${positionId} tidak ditemukan / sudah tertutup.`);
  const candle = session.candles[session.currentIndex];
  const exitPrice = candle ? candle.close : pos.lastMark ?? pos.entryPrice;
  closeReplayPosition(pos, exitPrice, "MANUAL", session.currentIndex);
  return { ...pos };
}

export function cancelReplayOrder(orderId: string): ReplayOrder {
  if (!session) throw new Error("Tidak ada sesi replay aktif.");
  const order = session.orders.find((o) => o.id === orderId);
  if (!order) throw new Error(`Order ${orderId} tidak ditemukan.`);
  if (order.status !== "NEW") throw new Error(`Order ${orderId} berstatus ${order.status}; hanya NEW yang bisa dibatalkan.`);
  order.status = "CANCELLED";
  order.reason = "MANUAL_CANCEL";
  if (order.limitPrice) {
    session.cash = r2(session.cash + (order.limitPrice * order.amount) / order.leverage);
  }
  pushEvent("ORDER_CANCELLED", { orderId, symbol: order.symbol, reason: "MANUAL_CANCEL" });
  return { ...order };
}

// ---------------------------------------------------------------------------
// Training dataset export — deterministic join decisionId → trade untuk ML
// ---------------------------------------------------------------------------
export interface ReplayDataset {
  kind: "replay-training-dataset";
  version: 1;
  runId: string;
  symbol: string;
  timeframe: string;
  /** Sumber candle: "binance" | "mql5" — jangan campur dua bucket dalam satu walk-forward. */
  dataSource: string;
  startTs: number;
  endTs: number;
  totalCandles: number;
  initialCash: number;
  finalEquity: number;
  realizedPnl: number;
  maxDrawdownPct: number;
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number;
    avgR: number;
    expectancy: number;
    avgFeesUSD: number;
  };
  trades: Array<ReplayTrade & { riskR: number | null; holdCandles: number }>;
  savedAt: number;
}

function computeStats(): ReplayDataset["stats"] {
  if (!session) {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, avgR: 0, expectancy: 0, avgFeesUSD: 0 };
  }
  const trades = session.trades;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let rSum = 0;
  let rCount = 0;
  let feesSum = 0;
  for (const t of trades) {
    feesSum += t.feesPaidUSD;
    if (t.pnlUSD > 0) {
      wins += 1;
      grossProfit += t.pnlUSD;
    } else if (t.pnlUSD < 0) {
      losses += 1;
      grossLoss += Math.abs(t.pnlUSD);
    }
    // R = pnl / risk (|entry - SL| * qty); SL 0 → skip
    if (t.entryPrice > 0 && t.qty > 0) {
      const sl = session.positions.find((p) => p.id === t.id)?.stopLoss ?? 0;
      if (sl > 0) {
        const riskAmt = Math.abs(t.entryPrice - sl) * t.qty;
        if (riskAmt > 1e-9) {
          rSum += t.pnlUSD / riskAmt;
          rCount += 1;
        }
      }
    }
  }
  const total = trades.length;
  const winRate = total > 0 ? Number(((wins / total) * 100).toFixed(2)) : 0;
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : 0;
  const avgR = rCount > 0 ? Number((rSum / rCount).toFixed(3)) : 0;
  const expectancy = total > 0 ? Number(((grossProfit - grossLoss) / total).toFixed(2)) : 0;
  const avgFeesUSD = total > 0 ? Number((feesSum / total).toFixed(4)) : 0;
  return { totalTrades: total, wins, losses, winRate, profitFactor, avgR, expectancy, avgFeesUSD };
}

/**
 * Snapshot lengkap sesi replay aktif — dipakai untuk persist ke SQLite.
 * Return null kalau tidak ada sesi.
 */
export function getReplaySessionFull(): ReplaySession | null {
  return session ? JSON.parse(JSON.stringify(session)) : null;
}

export function buildReplayTrainingDataset(): ReplayDataset {
  if (!session) throw new Error("Tidak ada sesi replay aktif.");
  const stats = computeStats();
  const trades = session.trades.map((t) => {
    const pos = session!.positions.find((p) => p.id === t.id);
    const sl = pos?.stopLoss ?? 0;
    const riskAmt = sl > 0 ? Math.abs(t.entryPrice - sl) * t.qty : 0;
    return {
      ...t,
      riskR: riskAmt > 1e-9 ? Number((t.pnlUSD / riskAmt).toFixed(3)) : null,
      holdCandles: Math.max(0, t.closedCandleIndex - t.openedCandleIndex),
    };
  });
  const firstCandle = session.candles[0];
  const lastCandle = session.candles[session.candles.length - 1];
  return {
    kind: "replay-training-dataset",
    version: 1,
    runId: session.id,
    symbol: session.symbol,
    timeframe: session.timeframe,
    dataSource: String(session.dataSource || "binance"),
    startTs: firstCandle?.timestamp ?? session.startedAt,
    endTs: lastCandle?.timestamp ?? Date.now(),
    totalCandles: session.candles.length,
    initialCash: session.initialCash,
    finalEquity: r2(equity()),
    realizedPnl: session.realizedPnl,
    maxDrawdownPct: Number(session.maxDrawdownPct.toFixed(2)),
    stats,
    trades,
    savedAt: Date.now(),
  };
}

const CSV_HEADER = [
  "trade_id", "symbol", "side", "qty", "leverage",
  "entry_price", "entry_candle_index", "entry_candle_ts",
  "exit_price", "exit_candle_index", "exit_candle_ts",
  "exit_reason", "pnl_usd", "pnl_percent", "risk_r", "fees_usd",
  "hold_candles", "decision_id", "entry_source", "strategy", "ambiguous_exit", "data_source",
].join(",");

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildReplayTrainingCsv(): string {
  const ds = buildReplayTrainingDataset();
  const lines = [CSV_HEADER];
  for (const t of ds.trades) {
    lines.push([
      csvEscape(t.id),
      csvEscape(t.symbol),
      csvEscape(t.side),
      csvEscape(t.qty),
      csvEscape(t.leverage),
      csvEscape(t.entryPrice),
      csvEscape(t.openedCandleIndex),
      csvEscape(t.openedCandleTs ?? ""),
      csvEscape(t.exitPrice),
      csvEscape(t.closedCandleIndex),
      csvEscape(t.closedCandleTs ?? ""),
      csvEscape(t.exitReason),
      csvEscape(t.pnlUSD),
      csvEscape(t.pnlPercent),
      csvEscape(t.riskR ?? ""),
      csvEscape(t.feesPaidUSD),
      csvEscape(t.holdCandles),
      csvEscape(t.decisionId ?? ""),
      csvEscape(t.entrySource ?? ""),
      csvEscape(t.strategy ?? ""),
      csvEscape(t.ambiguousExit ? "1" : "0"),
      csvEscape(ds.dataSource),
    ].join(","));
  }
  return lines.join("\n");
}