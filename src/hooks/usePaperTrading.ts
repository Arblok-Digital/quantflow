import { useCallback, useEffect, useRef, useState } from "react";
import { ClosedTrade, Portfolio, Position, MarketType, Timeframe } from "../types";
import { authFetch } from "./useAuth";

// ---------------------------------------------------------------------------
// usePaperTrading — reader murni dari BE (roadmap 3.6)
// Sumber kebenaran: server paper book + ledger DB.
// - positions dari GET /api/broker/positions (polling 3.5s, pause saat hidden)
// - closedTrades + stats dari GET /api/ledger/stats
// - equity/PnL dari server account (cash/equity/unrealized/realized)
// TIDAK ada seed data palsu, TIDAK ada mark-to-market ganda di client.
// Kompat shape: tetap expose addPosition/commitPortfolio/etc. sebagai no-op
// yang memicu refresh, agar PaperTradingPanel & pipeline tetap kompak.
// ---------------------------------------------------------------------------

export interface UsePaperTradingOptions {
  symbol?: string;
  currentPrice?: number;
  prependAudit?: (entry: any) => void;
}

const INITIAL_PAPER_CASH = 10000;
const POLL_MS = 3500;

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
  // attempt to derive R multiple if stopLoss available
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

const EMPTY_PORTFOLIO: Portfolio = {
  cash: 0,
  equity: 0,
  initialBalance: INITIAL_PAPER_CASH,
  realizedPnl: 0,
  winCount: 0,
  lossCount: 0,
  totalTrades: 0,
  maxDrawdownPercent: 0,
  currentDrawdownPercent: 0,
};

export function usePaperTrading(options: UsePaperTradingOptions) {
  const { symbol, currentPrice } = options;
  const [portfolio, setPortfolio] = useState<Portfolio>(EMPTY_PORTFOLIO);
  const [positions, setPositions] = useState<Position[]>([]);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>([]);

  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const priceRef = useRef(currentPrice);
  priceRef.current = currentPrice;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  const mountedRef = useRef(false);
  // Running peak equity (untuk currentDrawdown yang jujur — bukan max hist
  // yang bikin gate lock permanen. F10)
  const runningPeakRef = useRef<number>(INITIAL_PAPER_CASH);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const [posRes, statsRes] = await Promise.all([
        authFetch("/api/broker/positions").then((r) => r.json().catch(() => null)),
        authFetch("/api/ledger/stats").then((r) => r.json().catch(() => null)),
      ]);

      // positions + account
      if (posRes && posRes.success) {
        const rawPositions: any[] = Array.isArray(posRes.positions) ? posRes.positions : [];
        const openOnly = rawPositions.filter((p) => (p.status || "OPEN") === "OPEN");
        const mapped = openOnly.map(mapServerPosition);
        if (mountedRef.current) setPositions(mapped);

        const acc = posRes.account as any | null;
        const stats = statsRes && statsRes.success ? statsRes : null;

        // derive portfolio from account + stats
        const cash = acc ? Number(acc.cash ?? 0) : 0;
        const equity = acc ? Number(acc.equity ?? cash) : cash;
        const realizedPnl = acc ? Number(acc.realizedPnl ?? 0) : stats ? Number(stats.realizedPnlUSD ?? 0) : 0;
        const totalTrades = stats ? Number(stats.totalTrades ?? 0) : 0;
        const maxDD = stats ? Number(stats.maxDrawdownPct ?? 0) : 0;
        // win/loss from stats closedTrades
        let winCount = 0;
        let lossCount = 0;
        if (stats && Array.isArray(stats.closedTrades)) {
          for (const ct of stats.closedTrades as any[]) {
            const pnl = Number(ct.realizedPnlUsd ?? ct.realized_pnl_usd ?? 0);
            if (pnl > 0) winCount++;
            else if (pnl < 0) lossCount++;
          }
          // if some trades have 0 pnl (breakeven), count as not win nor loss but include in total
          // ensure win+loss <= total
          if (winCount + lossCount > totalTrades) {
            lossCount = Math.max(0, totalTrades - winCount);
          }
        } else {
          // fallback from closedTrades state already mapped
          winCount = 0;
          lossCount = 0;
        }

        if (mountedRef.current) {
          // Current drawdown jujur: dari running peak equity, bukan max
          // historis — supaya gate bisa unlock setelah equity pulih (F10).
          const ec = Number(equity) || 0;
          runningPeakRef.current = Math.max(runningPeakRef.current, ec);
          const currentDD = runningPeakRef.current > 0 ? ((runningPeakRef.current - ec) / runningPeakRef.current) * 100 : 0;
          setPortfolio({
            cash: Number(cash.toFixed(2)),
            equity: ec,
            initialBalance: INITIAL_PAPER_CASH,
            realizedPnl: Number(realizedPnl.toFixed(2)),
            winCount,
            lossCount,
            totalTrades,
            maxDrawdownPercent: Number(maxDD.toFixed(2)),
            currentDrawdownPercent: Number(Math.max(0, currentDD).toFixed(2)),
          });
        }
      }

      // closed trades from stats
      if (statsRes && statsRes.success && Array.isArray(statsRes.closedTrades)) {
        const mappedClosed = (statsRes.closedTrades as any[]).map(mapClosedTrade);
        if (mountedRef.current) setClosedTrades(mappedClosed);
      }
    } catch {
      // keep previous state, don't fabricate
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const iv = setInterval(load, POLL_MS);
    const onVis = () => {
      if (!document.hidden) load();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    return () => {
      mountedRef.current = false;
      clearInterval(iv);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // No-op mark-to-market: server is source of truth
  const processPriceTick = useCallback((_price: number) => {}, []);

  const addPosition = useCallback(
    (_position: Position) => {
      // reader mode: just refresh from server
      load();
    },
    [load]
  );

  const commitPortfolio = useCallback(
    (_next: Portfolio) => {
      load();
    },
    [load]
  );

  const pruneServerPositions = useCallback((openServerIds: string[]) => {
    // server is already truth; no client rows to prune except legacy sim.
    // Keep guard for any local sim that slipped in.
    setPositions((prev) => prev.filter((p) => (isServerBackedId(p.id) ? openServerIds.includes(p.id as string) : !isSimPositionId(p.id) ? true : false)));
    // also trigger reload to stay sync
    load();
  }, [load]);

  const closePosition = useCallback(
    async (sym: string, _reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE") => {
      const targetPos = positionsRef.current.find((p) => p.symbol === sym);
      if (!targetPos) return;
      // sim guard: if somehow sim position exists locally (should not happen), just drop it
      if (isSimPositionId(targetPos.id)) {
        setPositions((prev) => prev.filter((p) => p.symbol !== sym));
        return;
      }
      try {
        const res = await authFetch("/api/broker/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positionId: targetPos.id }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          if (payload?.reason === "POSITION_NOT_FOUND") {
            setPositions((prev) => prev.filter((p) => p.symbol !== sym));
            await load();
            return;
          }
          if (payload?.reason === "POSITION_ALREADY_CLOSED") {
            setPositions((prev) => prev.filter((p) => p.symbol !== sym));
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
    async (sym: string) => {
      const targetPos = positionsRef.current.find((p) => p.symbol === sym);
      if (!targetPos) return;
      if (isSimPositionId(targetPos.id)) {
        // sim: just update locally
        setPositions((prev) => prev.map((p) => (p.symbol === sym ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 } : p)));
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
            setPositions((prev) => prev.map((p) => (p.symbol === sym ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 } : p)));
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
      // No server reset endpoint — just refresh to show honest empty state.
      // Keep compat: do not fabricate cash.
      console.warn("[usePaperTrading] resetPaperAccount di mode reader: tidak ada endpoint reset server; melakukan refresh saja.");
      load();
    },
    [load]
  );

  const simulateTradeEntry = useCallback(
    async (side: "LONG" | "SHORT") => {
      const sym = symbolRef.current || "BTC/USDT";
      const entryPrice = priceRef.current ?? 0;
      if (!entryPrice || entryPrice <= 0) {
        console.warn("[usePaperTrading] simulateTradeEntry: currentPrice tidak tersedia, batal.");
        return;
      }
      // allocate similar to before but honest via server order
      // need cash/equity from current portfolio (server truth)
      // fallback to 10000 if not yet loaded -> keep honest by using whatever cash is
      let cash = portfolio.cash;
      let equity = portfolio.equity;
      // If still 0 (initial load not done), fetch synchronously via positions endpoint to get real cash
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
      const stopLoss = isLong ? Number((entryPrice * 0.991).toFixed(2)) : Number((entryPrice * 1.009).toFixed(2));
      const takeProfit = isLong ? Number((entryPrice * 1.021).toFixed(2)) : Number((entryPrice * 0.979).toFixed(2));
      try {
        const res = await authFetch("/api/broker/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: sym,
            side: isLong ? "buy" : "sell",
            type: "market",
            amount: qty,
            leverage: 10,
            stopLoss,
            takeProfit,
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
          console.error(`Simulate order ditolak (${payload?.reason || res.status}): ${payload?.message || "unknown"}`);
          return;
        }
        await load();
      } catch (err) {
        console.error("Simulate order unreachable:", (err as Error).message);
      }
    },
    [portfolio.cash, portfolio.equity, load]
  );

  return {
    portfolio,
    positions,
    closedTrades,
    processPriceTick,
    addPosition,
    commitPortfolio,
    moveToBreakEven,
    resetPaperAccount,
    simulateTradeEntry,
    closePosition,
    pruneServerPositions,
    refresh: load,
  };
}

export type PaperTradingController = ReturnType<typeof usePaperTrading>;
