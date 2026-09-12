import { useCallback, useEffect, useRef, useState } from "react";
import { ClosedTrade, Portfolio, Position, MarketType, Timeframe } from "../types";
import { authFetch, useAuth } from "./useAuth";
import { useBrokerPositions, ServerPosition } from "./useBrokerPositions";
import { useLedgerStats, LedgerClosedTrade } from "./useLedgerStats";
import { derivePortfolio, INITIAL_PAPER_CASH } from "./usePaperPortfolio";

// ---------------------------------------------------------------------------
// usePaperTrading — reader murni dari BE (roadmap 3.6)
// Composes shared domain hooks: useBrokerPositions + useLedgerStats.
// Sumber kebenaran: server paper book + ledger DB.
// TIDAK ada seed data palsu, TIDAK ada mark-to-market ganda di client.
// Kompat shape: tetap expose addPosition/commitPortfolio/etc. sebagai no-op
// yang memicu refresh, agar PaperTradingPanel & pipeline tetap kompak.
// ---------------------------------------------------------------------------

export interface UsePaperTradingOptions {
  symbol?: string;
  currentPrice?: number;
  prependAudit?: (entry: any) => void;
}

function isSimPositionId(id?: string): boolean {
  return typeof id === "string" && id.startsWith("pos_sim_");
}
function isServerBackedId(id?: string): boolean {
  return typeof id === "string" && id.startsWith("pos-");
}

function mapServerPosition(p: any): Position {
  const entryPrice = Number(p.entryPrice ?? p.entry_price ?? 0);
  const qty = Number(p.qty ?? p.amount ?? 0);
  const mark = p.lastMark != null ? Number(p.lastMark) : entryPrice;
  const notionalUSD = Number(p.notionalUSD ?? p.notional_usd ?? entryPrice * qty);
  const side = String(p.side) as "LONG" | "SHORT";
  const pnl = side === "LONG" ? (mark - entryPrice) * qty : (entryPrice - mark) * qty;
  const pnlPct = notionalUSD > 0 ? (pnl / notionalUSD) * 100 : 0;
  const sl = p.stopLoss != null ? Number(p.stopLoss) : Number(p.stop_loss ?? 0);
  const tp = p.takeProfit != null ? Number(p.takeProfit) : Number(p.take_profit ?? 0);
  const potentialProfitUSD = tp ? Math.abs(tp - entryPrice) * qty : undefined;
  const potentialLossUSD = sl ? Math.abs(entryPrice - sl) * qty : undefined;
  return {
    id: String(p.id),
    symbol: String(p.symbol),
    side,
    qty,
    notionalUSD: Number(notionalUSD.toFixed(2)),
    leverage: p.leverage != null ? Number(p.leverage) : 10,
    entryPrice,
    currentPrice: mark,
    unrealizedPnl: Number(pnl.toFixed(2)),
    unrealizedPnlPercent: Number(pnlPct.toFixed(2)),
    stopLoss: sl,
    takeProfit: tp,
    potentialProfitUSD: potentialProfitUSD != null ? Number(potentialProfitUSD.toFixed(2)) : undefined,
    potentialLossUSD: potentialLossUSD != null ? Number(potentialLossUSD.toFixed(2)) : undefined,
    riskRewardRatio: potentialLossUSD && potentialLossUSD > 0 && potentialProfitUSD ? Number((potentialProfitUSD / potentialLossUSD).toFixed(2)) : undefined,
    openedAt: Number(p.openedAt ?? p.opened_at ?? Date.now()),
    timeframe: (p.timeframe as Timeframe) || "15m",
    marketType: (p.marketType as MarketType) || "FUTURES",
    targetLiquidityPool: p.targetPool || p.target_pool || undefined,
    entryReasoning: p.entryReasoning || p.entry_reasoning || undefined,
    confidence: p.confidence != null ? Number(p.confidence) : undefined,
    liquidationPrice: p.liquidationPrice != null ? Number(p.liquidationPrice) : p.liq_price != null ? Number(p.liq_price) : undefined,
  };
}

function mapClosedTrade(t: any): ClosedTrade {
  const entryPrice = Number(t.entryPrice ?? 0);
  const closePrice = t.closePrice != null ? Number(t.closePrice) : t.close_price != null ? Number(t.close_price) : entryPrice;
  const amount = Number(t.amount ?? 0);
  const notionalUSD = Number((entryPrice * amount).toFixed(2));
  const pnlUSD = t.realizedPnlUsd != null ? Number(t.realizedPnlUsd) : t.realized_pnl_usd != null ? Number(t.realized_pnl_usd) : Number(t.realizedPnlUSD ?? 0);
  const pnlPercent = notionalUSD > 0 ? (pnlUSD / notionalUSD) * 100 : 0;
  let rMultiple = 0;
  const sl = t.stopLoss != null ? Number(t.stopLoss) : t.stop_loss != null ? Number(t.stop_loss) : 0;
  if (sl > 0 && amount > 0) {
    const riskAmt = Math.abs(entryPrice - sl) * amount;
    if (riskAmt > 1e-9) rMultiple = Number((pnlUSD / riskAmt).toFixed(2));
  }
  return {
    id: String(t.id),
    symbol: String(t.symbol),
    side: String(t.side) as "LONG" | "SHORT",
    qty: amount,
    notionalUSD,
    entryPrice,
    exitPrice: closePrice,
    pnlUSD: Number(pnlUSD.toFixed(2)),
    pnlPercent: Number(pnlPercent.toFixed(2)),
    openedAt: Number(t.openedAt ?? t.opened_at ?? 0),
    closedAt: Number(t.closedAt ?? t.closed_at ?? Date.now()),
    exitReason: (t.exitReason as any) || "MANUAL_CLOSE",
    entryReasoning: String(t.entryReasoning || t.entry_reasoning || ""),
    targetLiquidityPool: t.targetLiquidityPool || undefined,
    rMultiple,
  };
}

export type OrderTypeInput = "market" | "limit";

export interface PendingOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell" | "LONG" | "SHORT";
  type: "limit";
  qty: number;
  filledQty?: number;
  remainingQty?: number;
  limitPrice: number;
  state: "NEW" | "PARTIALLY_FILLED" | "CANCELED" | "REJECTED";
  createdAt?: number;
}

function mapPendingOrder(o: any): PendingOrder | null {
  if (!o) return null;
  const id = String(o.id ?? o.orderId ?? "");
  if (!id) return null;
  const qty = Number(o.qty ?? o.amount ?? o.quantity ?? 0);
  const limitPrice = Number(o.limitPrice ?? o.limit_price ?? o.price ?? 0);
  if (!limitPrice || limitPrice <= 0) return null;
  const rawState = String(o.state ?? o.status ?? "NEW").toUpperCase();
  if (rawState === "FILLED") return null;
  const state: PendingOrder["state"] =
    rawState === "PARTIALLY_FILLED" || rawState === "PARTIAL"
      ? "PARTIALLY_FILLED"
      : rawState === "CANCELED" || rawState === "CANCELLED"
      ? "CANCELED"
      : rawState === "REJECTED"
      ? "REJECTED"
      : "NEW";
  return {
    id,
    symbol: String(o.symbol ?? "?"),
    side: (o.side as PendingOrder["side"]) ?? "buy",
    type: "limit",
    qty,
    filledQty: o.filledQty != null ? Number(o.filledQty) : o.filled_qty != null ? Number(o.filled_qty) : undefined,
    remainingQty: o.remainingQty != null ? Number(o.remainingQty) : o.remaining_qty != null ? Number(o.remaining_qty) : undefined,
    limitPrice,
    state,
    createdAt: o.createdAt != null ? Number(o.createdAt) : o.created_at != null ? Number(o.created_at) : undefined,
  };
}

export function usePaperTrading(options: UsePaperTradingOptions) {
  const { symbol, currentPrice } = options;

  // Compose shared domain hooks
  const brokerPositions = useBrokerPositions();
  const ledgerStats = useLedgerStats();

  const [portfolio, setPortfolio] = useState<Portfolio>({
    cash: 0, equity: 0, initialBalance: INITIAL_PAPER_CASH,
    realizedPnl: 0, winCount: 0, lossCount: 0,
    totalTrades: 0, maxDrawdownPercent: 0, currentDrawdownPercent: 0,
  });
  const [positions, setPositions] = useState<Position[]>([]);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>([]);
  const [pendingOrders, setPendingOrders] = useState<PendingOrder[]>([]);

  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const priceRef = useRef(currentPrice);
  priceRef.current = currentPrice;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  const mountedRef = useRef(false);
  const runningPeakRef = useRef<number>(INITIAL_PAPER_CASH);

  // Re-derive portfolio when broker/ledger data changes
  useEffect(() => {
    if (brokerPositions.loading || ledgerStats.loading) return;
    const pnlList = ledgerStats.closedTrades.map((t) =>
      Number(t.realizedPnlUsd ?? t.realized_pnl_usd ?? 0)
    );
    const { portfolio: newPortfolio, newPeak } = derivePortfolio({
      account: brokerPositions.account,
      totalTrades: ledgerStats.totalTrades,
      closedTradesPnl: pnlList,
      maxDrawdownPct: ledgerStats.maxDrawdownPct,
      runningPeak: runningPeakRef.current,
    });
    runningPeakRef.current = newPeak;
    setPortfolio(newPortfolio);
  }, [brokerPositions.account, brokerPositions.loading, ledgerStats.totalTrades, ledgerStats.realizedPnlUSD, ledgerStats.maxDrawdownPct, ledgerStats.loading, ledgerStats.closedTrades]);

  // Map positions from broker hook
  useEffect(() => {
    if (brokerPositions.loading) return;
    const openOnly = brokerPositions.positions.filter(
      (p: ServerPosition) => (p.status || "OPEN") === "OPEN"
    );
    setPositions(openOnly.map(mapServerPosition));
  }, [brokerPositions.positions, brokerPositions.loading]);

  // Map closed trades from ledger hook
  useEffect(() => {
    if (ledgerStats.loading) return;
    setClosedTrades(ledgerStats.closedTrades.map(mapClosedTrade));
  }, [ledgerStats.closedTrades, ledgerStats.loading]);

  // Map pending orders from broker hook
  useEffect(() => {
    setPendingOrders(
      brokerPositions.pendingOrders
        .map(mapPendingOrder)
        .filter((o): o is PendingOrder => o !== null)
    );
  }, [brokerPositions.pendingOrders]);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // No-op mark-to-market: server is source of truth
  const processPriceTick = useCallback((_price: number) => {}, []);

  const load = useCallback(async () => {
    await Promise.all([brokerPositions.refresh(), ledgerStats.refresh()]);
  }, [brokerPositions.refresh, ledgerStats.refresh]);

  const addPosition = useCallback(
    (_position: Position) => { load(); },
    [load]
  );

  /** Auto-pilot limit NEW: masukkan ke pending list lalu refresh server. */
  const addPendingOrder = useCallback(
    (order: {
      id: string;
      symbol: string;
      side: string;
      type: string;
      status: string;
      amount: number;
      limitPrice?: number;
      leverage?: number;
    }) => {
      const mapped = mapPendingOrder({
        id: order.id,
        symbol: order.symbol,
        side: order.side,
        qty: order.amount,
        limitPrice: order.limitPrice ?? 0,
        state: order.status,
        createdAt: Date.now(),
      });
      if (mapped) {
        setPendingOrders((prev) =>
          prev.some((o) => o.id === mapped.id) ? prev : [...prev, mapped]
        );
      }
      load();
    },
    [load]
  );

  const commitPortfolio = useCallback(
    (_next: Portfolio) => { load(); },
    [load]
  );

  const pruneServerPositions = useCallback((openServerIds: string[]) => {
    setPositions((prev) =>
      prev.filter((p) =>
        isServerBackedId(p.id)
          ? openServerIds.includes(p.id as string)
          : !isSimPositionId(p.id)
          ? true
          : false
      )
    );
    load();
  }, [load]);

  // Close position — now uses positionId directly (TASK 2)
  const closePosition = useCallback(
    async (positionId: string, _reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE") => {
      // If it looks like a symbol (no "pos-" prefix), find the position by symbol
      // for backwards compat with callers that still pass symbol
      let targetId = positionId;
      if (!positionId.startsWith("pos-")) {
        const targetPos = positionsRef.current.find((p) => p.symbol === positionId);
        if (!targetPos) return;
        if (isSimPositionId(targetPos.id)) {
          setPositions((prev) => prev.filter((p) => p.symbol !== positionId));
          return;
        }
        targetId = targetPos.id as string;
      }
      try {
        const res = await authFetch("/api/broker/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positionId: targetId }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          if (payload?.reason === "POSITION_NOT_FOUND" || payload?.reason === "POSITION_ALREADY_CLOSED") {
            await load();
            return;
          }
          console.error(`Broker close gagal (${payload?.reason || res.status}): ${payload?.message || "unknown"}`);
          return;
        }
        await load();
      } catch (err) {
        console.error("Broker close unreachable:", (err as Error).message);
      }
    },
    [load]
  );

  const moveToBreakEven = useCallback(
    async (positionId: string) => {
      const targetPos = positionsRef.current.find((p) => p.id === positionId);
      if (!targetPos) return;
      if (isSimPositionId(targetPos.id)) {
        setPositions((prev) => prev.map((p) => (p.id === positionId ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 } : p)));
        return;
      }
      try {
        const res = await authFetch("/api/broker/position/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positionId: targetPos.id, breakEven: true }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          if (payload?.reason === "POSITION_NOT_FOUND") {
            setPositions((prev) => prev.map((p) => (p.id === positionId ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 } : p)));
          } else {
            console.error(`Broker move-to-BE gagal (${payload?.reason || res.status}): ${payload?.message || "unknown"}`);
          }
          return;
        }
        await load();
      } catch (err) {
        console.error("Broker move-to-BE unreachable:", (err as Error).message);
      }
    },
    [load]
  );

  const resetPaperAccount = useCallback(
    (_initialCapital: number) => {
      console.warn("[usePaperTrading] resetPaperAccount di mode reader: tidak ada endpoint reset server; melakukan refresh saja.");
      load();
    },
    [load]
  );

  const cancelPendingOrder = useCallback(
    async (orderId: string) => {
      try {
        const res = await authFetch("/api/broker/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          console.error(`Cancel order ditolak (${payload?.reason || res.status}): ${payload?.message || "unknown"}`);
          return;
        }
        setPendingOrders((prev) => prev.filter((o) => o.id !== orderId));
        await load();
      } catch (err) {
        console.error("Cancel order unreachable:", (err as Error).message);
      }
    },
    [load]
  );

  const simulateTradeEntry = useCallback(
    async (side: "LONG" | "SHORT", orderType: OrderTypeInput = "market", limitPrice?: number) => {
      const sym = symbolRef.current || "BTC/USDT";
      const entryPrice = priceRef.current ?? 0;
      if (!entryPrice || entryPrice <= 0) {
        console.warn("[usePaperTrading] simulateTradeEntry: currentPrice tidak tersedia, batal.");
        return;
      }
      let cash = portfolio.cash;
      let equity = portfolio.equity;
      if (cash === 0 && equity === 0) {
        try {
          const posRes = await authFetch("/api/broker/positions").then((r) => r.json().catch(() => null));
          if (posRes?.account) {
            cash = Number(posRes.account.cash ?? 0);
            equity = Number(posRes.account.equity ?? 0);
          }
        } catch {}
      }
      const basis = equity > 0 ? equity : cash > 0 ? cash : INITIAL_PAPER_CASH;
      const allocatedUSD = Math.min(cash > 0 ? cash : basis, basis * 0.12);
      if (allocatedUSD <= 0) {
        console.warn("[usePaperTrading] simulateTradeEntry: insufficient cash (server).");
        return;
      }
      const qty = Number((allocatedUSD / entryPrice).toFixed(4));
      if (qty <= 0) {
        console.warn("[usePaperTrading] simulateTradeEntry: qty invalid.");
        return;
      }
      const isLong = side === "LONG";
      const dupSameSide = positions.find((p) => p.symbol === sym && p.side === side);
      if (dupSameSide) {
        console.warn(
          `[usePaperTrading] Simulate ${side} ${sym} di-skip: posisi ${side} sudah OPEN (${dupSameSide.id}). Tutup dulu.`
        );
        return null;
      }
      const stopLoss = isLong ? Number((entryPrice * 0.991).toFixed(2)) : Number((entryPrice * 1.009).toFixed(2));
      const takeProfit = isLong ? Number((entryPrice * 1.021).toFixed(2)) : Number((entryPrice * 0.979).toFixed(2));
      const effectiveType: OrderTypeInput = orderType === "limit" ? "limit" : "market";
      if (effectiveType === "limit" && (!limitPrice || !isFinite(limitPrice) || limitPrice <= 0)) {
        console.warn("[usePaperTrading] simulateTradeEntry: limitPrice wajib diisi untuk limit order.");
        return null;
      }
      try {
        const res = await authFetch("/api/broker/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: sym,
            side: isLong ? "buy" : "sell",
            type: effectiveType,
            amount: qty,
            leverage: 10,
            stopLoss,
            takeProfit,
            ...(effectiveType === "limit" ? { limitPrice: Number(limitPrice) } : {}),
            meta: {
              reasoning: isLong
                ? `Simulated LONG via paper book: 15m SSL sweep @ ${(entryPrice * 0.994).toFixed(0)}`
                : `Simulated SHORT via paper book: 15m BSL sweep @ ${(entryPrice * 1.006).toFixed(0)}`,
              confidence: 89,
              timeframe: "15m",
              marketType: "FUTURES",
              targetPool: isLong ? "15m BSL ($21.5M Pool)" : "15m SSL ($19.8M Pool)",
            },
          }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          console.warn(
            `Simulate order ditolak (${payload?.reason || res.status}): ${payload?.message || "unknown"}`
          );
          return null;
        }
        const order = payload?.order as any | undefined;
        const orderState = String(order?.state ?? order?.status ?? "").toUpperCase();
        if (effectiveType === "limit" && (orderState === "NEW" || orderState === "PARTIALLY_FILLED")) {
          const mapped = mapPendingOrder({
            id: order?.id,
            symbol: order?.symbol ?? sym,
            side: order?.side ?? (isLong ? "buy" : "sell"),
            qty: order?.amount ?? order?.qty ?? qty,
            limitPrice: order?.limitPrice ?? limitPrice,
            state: orderState,
            createdAt: Date.now(),
          });
          if (mapped) {
            setPendingOrders((prev) =>
              prev.some((o) => o.id === mapped.id) ? prev : [...prev, mapped]
            );
          }
        }
        await load();
        return order ?? null;
      } catch (err) {
        console.error("Simulate order unreachable:", (err as Error).message);
        return null;
      }
    },
    [portfolio.cash, portfolio.equity, positions, load]
  );

  return {
    portfolio,
    positions,
    closedTrades,
    pendingOrders,
    processPriceTick,
    addPosition,
    addPendingOrder,
    commitPortfolio,
    moveToBreakEven,
    resetPaperAccount,
    simulateTradeEntry,
    cancelPendingOrder,
    closePosition,
    pruneServerPositions,
    refresh: load,
  };
}

export type PaperTradingController = ReturnType<typeof usePaperTrading>;
