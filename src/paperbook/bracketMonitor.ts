import { fetchTickerPrice } from "../data/marketFetcher";
import {
  state,
  appendEvent,
  persistSnapshotTolerant,
  cancelPaperOrder,
  r2,
  newId,
  dbSavePosition,
  dbSaveOrder,
  persistSnapshot,
} from "./store";
import { freshMarkFromCache } from "./markCache";
import { MAINTENANCE_MARGIN_RATE, ERROR_LOG_THROTTLE_MS, TAKER_FEE_RATE, MAKER_FEE_RATE, MARK_TTL_MS } from "./config";
import { PaperSide, PaperPosition, ExitReason } from "./types";
import { appendAudit, beginTx, commitTx, rollbackTx } from "../../db";
import { closePaperPosition, liquidationPrice } from "./fill";

function roundTo(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}

export async function fetchMarkTicker(symbol: string): Promise<{
  mark: number;
  high1m: number;
  low1m: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
  source?: "WS_CACHE" | "FALLBACK_CHAIN";
}> {
  const t0 = Date.now();
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
  const result = await fetchTickerPrice(symbol);
  if (result.ok && isFinite(result.price) && result.price > 0) {
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
  const marks = new Map(results.map((result) => [result.symbol, result]));
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

export function logThrottledError(symbol: string, message: string): void {
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
    const marks = new Map(results.map((result) => [result.symbol, result]));

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

      const rangeHigh = Number.isFinite(entry.high1m) && entry.high1m > 0 ? entry.high1m : entry.mark;
      const rangeLow = Number.isFinite(entry.low1m) && entry.low1m > 0 ? entry.low1m : entry.mark;
      // SPOT: tanpa liquidation (aset beneran). liq_price 0 dari fill.ts juga
      // sudah membuat hitLiq false, tapi cek marketType eksplisit agar tahan
      // terhadap posisi lama/korup yang liq_price-nya tidak nol.
      const isSpotPos = String((pos as any).marketType || "").toUpperCase() === "SPOT";
      const hitLiq =
        !isSpotPos && pos.liquidationPrice > 0
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

export function stopBracketMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    console.log("[paperBook] Bracket monitor stopped");
  }
}

export async function fillPendingLimitOrders(
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

    // Limit order SPOT sell (SHORT) tidak boleh lolos walau meta diisi manual —
    // fail-closed di titik fill, bukan cuma di openPaperPosition.
    const limitMarketType = String(order.meta?.marketType || "FUTURES").toUpperCase();
    if (limitMarketType === "SPOT" && order.side === "sell") {
      cancelPaperOrder(order.id);
      appendEvent("ORDER_REJECTED", {
        orderId: order.id,
        symbol: order.symbol,
        side: order.side,
        type: "limit",
        reason: "SPOT_SHORT_NOT_ALLOWED",
        message: "SPOT hanya bisa BUY/LONG.",
      });
      changed = true;
      continue;
    }

    const side: PaperSide = order.side === "sell" ? "SHORT" : "LONG";
    const dup = state.positions.find((p) => p.symbol === order.symbol && p.side === side && p.status === "OPEN");
    const now = Date.now();
    const notional = limit * order.amount;
    const leverage = order.leverage && order.leverage > 0 ? order.leverage : 1;
    const marginUSD = notional / leverage;
    const feeUSD = roundTo(notional * MAKER_FEE_RATE, 4);
    void TAKER_FEE_RATE;

    if (dup) {
      cancelPaperOrder(order.id);
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
      notionalUSD: roundTo(notional, 2),
      leverage: roundTo(leverage, 2),
      marginUSD: roundTo(marginUSD, 2),
      stopLoss: order.stopLoss || 0,
      takeProfit: order.takeProfit || 0,
      // SPOT limit fill: sama seperti market — tanpa liquidation.
      liquidationPrice: (() => {
        const mt = String(order.meta?.marketType || "").toUpperCase();
        if (mt === "SPOT") return 0;
        return liquidationPrice(limit, leverage, side);
      })(),
      maintenanceMarginRate: String(order.meta?.marketType || "").toUpperCase() === "SPOT" ? 0 : MAINTENANCE_MARGIN_RATE,
      openedAt: now,
      status: "OPEN",
      entryReasoning: order.meta?.reasoning,
      confidence: order.meta?.confidence,
      timeframe: order.meta?.timeframe,
      marketType: order.meta?.marketType,
      targetPool: order.meta?.targetPool,
      entrySource: order.meta?.entrySource || "MANUAL",
      sourceOrderId: order.id,
      lastMark: entry.mark,
      lastMarkUpdatedAt: now,
      feesPaidUSD: feeUSD,
    };

    order.status = "FILLED";
    order.filledAt = now;
    order.fillPrice = limit;
    order.slippageBps = 0;
    order.feeUSD = feeUSD;
    order.notional = roundTo(notional, 2);
    order.marginRequired = roundTo(marginUSD, 2);
    order.filledQty = order.amount;
    order.remainingQty = 0;
    order.positionId = positionId;
    order.executionLatencyMs = now - (order.submittedAt || order.timestamp);

    state.positions.push(position);
    state.cash = r2(state.cash - feeUSD);

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
