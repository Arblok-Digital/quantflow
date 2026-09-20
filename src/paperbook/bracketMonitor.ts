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
  dbSavePositionTolerant,
  persistSnapshot,
} from "./store";
import { freshMarkFromCache } from "./markCache";
import { MAINTENANCE_MARGIN_RATE, ERROR_LOG_THROTTLE_MS, TAKER_FEE_RATE, MAKER_FEE_RATE, MARK_TTL_MS } from "./config";
import { PaperSide, PaperPosition, ExitReason } from "./types";
import { appendAudit, beginTx, commitTx, rollbackTx } from "../../db";
import { closePaperPosition, liquidationPrice } from "./fill";
import { evaluatePositionExits } from "./exitEngine";
import { roundTo } from "../lib/round";

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

    // Evaluate deadlines BEFORE price fetching; a failed mark must not hide expiry.
    const expired = new Set<string>();
    for (const pos of open) {
      const ev = evaluatePositionExits(pos, { mark: 0, high1m: 0, low1m: 0, now: Date.now() });
      if (ev.fullCloseReason !== "TIMEOUT" || !pos.exitPlan) continue;
      expired.add(pos.id);
      const attemptedAt = Date.now();
      try {
        const result = await closePaperPosition(pos.id, "TIMEOUT");
        pos.exitPlan.state.deadlineAttempt = { status: result.partial ? "PARTIAL" : "CLOSED", attemptedAt };
        appendEvent("EXIT_ENGINE_ACTION", { positionId: pos.id, action: "DEADLINE_RESULT", ...pos.exitPlan.state.deadlineAttempt, remainingQty: result.remainingQty ?? 0 });
      } catch (err) {
        const message = (err as Error).message;
        pos.exitPlan.state.deadlineAttempt = { status: "FAILED", attemptedAt, message };
        appendEvent("ERROR", { positionId: pos.id, source: "deadline-close", message });
      }
      // Failure remains OPEN and will be retried on the next server pass.
      dbSavePositionTolerant(pos);
    }
    const symbols = [...new Set([...open.filter(p => !expired.has(p.id)).map((p) => p.symbol), ...pendingLimits.map((o) => o.symbol)])];
    const results = await Promise.all(symbols.map(async (symbol) => ({ symbol, ...(await fetchMarkTicker(symbol)) })));
    const marks = new Map(results.map((result) => [result.symbol, result]));

    await fillPendingLimitOrders(marks);

    let persisted = false;
    for (const pos of open) {
      if (expired.has(pos.id) || pos.status !== "OPEN") continue;
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

      // -----------------------------------------------------------------
      // F3 — Exit engine (opt-in): BE otomatis / trailing / partial TP /
      // time-stop dievaluasi SEBELUM cek bracket statis. Tanpa exitPlan =
      // tidak ada perubahan perilaku (posisi lama aman).
      // -----------------------------------------------------------------
      if (pos.exitPlan) {
        try {
          const ev = evaluatePositionExits(pos, {
            mark: entry.mark,
            high1m: rangeHigh,
            low1m: rangeLow,
            now: Date.now(),
          });
          if (ev.statePatch) {
            pos.exitPlan = { config: pos.exitPlan.config, state: { ...pos.exitPlan.state, ...ev.statePatch } };
          }
          if (ev.newStopLoss !== undefined) {
            const oldSl = pos.stopLoss;
            pos.stopLoss = roundTo(ev.newStopLoss, 6);
            dbSavePositionTolerant(pos);
            appendEvent("EXIT_ENGINE_ACTION", {
              positionId: pos.id,
              symbol: pos.symbol,
              action: "SL_TIGHTENED",
              oldSl,
              newSl: pos.stopLoss,
              notes: ev.notes,
            });
          }
          if (ev.partialCloseQty != null && ev.partialCloseQty > 0) {
            appendEvent("EXIT_ENGINE_ACTION", {
              positionId: pos.id,
              symbol: pos.symbol,
              action: "PARTIAL_TP",
              qty: ev.partialCloseQty,
              notes: ev.notes,
            });
            await closePaperPosition(pos.id, ev.partialReason || "PARTIAL_TAKE_PROFIT", ev.partialCloseQty);
            continue; // posisi berubah (qty) — bracket statis dievaluasi pass berikutnya
          }
          if (ev.fullCloseReason) {
            appendEvent("EXIT_ENGINE_ACTION", {
              positionId: pos.id,
              symbol: pos.symbol,
              action: "FULL_CLOSE",
              reason: ev.fullCloseReason,
              notes: ev.notes,
            });
            await closePaperPosition(pos.id, ev.fullCloseReason);
            continue;
          }
        } catch (err) {
          console.warn(`[paperBook] Exit engine gagal untuk ${pos.id}: ${(err as Error).message}`);
          appendEvent("ERROR", { positionId: pos.id, symbol: pos.symbol, message: (err as Error).message, source: "exit-engine" });
        }
      }
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
      // P0-04: cancel could throw DB_TX_FAILED; catch + continue (order retried next pass).
      try {
        await cancelPaperOrder(order.id);
      } catch (cancelErr) {
        console.warn(`[paperBook] Gagal cancel SPOT SHORT limit ${order.id}: ${(cancelErr as Error).message}`);
        continue;
      }
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
      // P0-04: cancel could throw DB_TX_FAILED; catch + continue (order retried next pass).
      try {
        await cancelPaperOrder(order.id);
      } catch (cancelErr) {
        console.warn(`[paperBook] Gagal cancel duplikat limit ${order.id}: ${(cancelErr as Error).message}`);
      }
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
      openQty: order.amount,
      feesTotalUSD: feeUSD,
    };

    // P0-04 snapshot SEBELUM mutasi agar DB gagal → rollback paritas.
    const cashSnap = state.cash;
    const ordersSnapLen = state.orders.length;
    const positionsSnapLen = state.positions.length;
    const orderSnap = {
      status: order.status as string,
      filledAt: order.filledAt,
      fillPrice: order.fillPrice,
      slippageBps: order.slippageBps,
      feeUSD: order.feeUSD,
      notional: order.notional,
      marginRequired: order.marginRequired,
      filledQty: order.filledQty,
      remainingQty: order.remainingQty,
      positionId: order.positionId,
      executionLatencyMs: order.executionLatencyMs,
    };

    // Mutate in-memory (speculatively — rolled back on DB failure)
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
      // P0-04: rollback in-memory MENYELURUH — memori dan DB harus sama setelah gagal
      // (posisi tidak ada di memori, order tetap NEW, cash tidak berkurang → retry aman).
      state.cash = cashSnap;
      state.orders.length = ordersSnapLen;
      state.positions.length = positionsSnapLen;
      Object.assign(order, orderSnap);
      rollbackTx();
      console.error(`[paperBook] Gagal persist limit fill ${order.id}: ${(err as Error).message}`);
      appendEvent("ERROR", { symbol: order.symbol, orderId: order.id, source: "limit-fill", message: (err as Error).message });
      // Don't touch `changed` here — an earlier success in this pass still needs
      // the end-of-pass snapshot persist; a fully-failed pass simply emits ERROR.
      continue;
    }
    // P0-04: success event SESUDAH commit — DB gagal tidak memancarkan
    // ORDER_FILLED palsu (order tetap NEW, retry aman).
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
    changed = true;
  }
  if (changed) persistSnapshotTolerant();
}
