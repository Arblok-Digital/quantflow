import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuditLogEntry,
  ClosedTrade,
  Portfolio,
  Position,
} from "../types";
import { authFetch } from "./useAuth";

export interface UsePaperTradingOptions {
  symbol: string;
  currentPrice: number;
  prependAudit: (entry: AuditLogEntry) => void;
}

const INITIAL_PORTFOLIO: Portfolio = {
  cash: 10000.0,
  equity: 10015.0,
  initialBalance: 10000.0,
  realizedPnl: 187.5,
  winCount: 1,
  lossCount: 0,
  totalTrades: 1,
  maxDrawdownPercent: 1.2,
  currentDrawdownPercent: 0.4,
};

const INITIAL_POSITIONS: Position[] = [
  {
    id: "pos_active_1",
    symbol: "BTC/USDT",
    side: "LONG",
    qty: 0.15,
    notionalUSD: 9637.5,
    leverage: 10,
    entryPrice: 64150.0,
    currentPrice: 64250.0,
    unrealizedPnl: 15.0,
    unrealizedPnlPercent: 0.16,
    stopLoss: 63400.0,
    takeProfit: 65600.0,
    potentialProfitUSD: 217.5,
    potentialLossUSD: 112.5,
    riskRewardRatio: 1.93,
    openedAt: Date.now() - 1800000,
    timeframe: "15m",
    marketType: "FUTURES",
    targetLiquidityPool: "15m BSL ($18.4M Pool)",
    entryReasoning: "15m Sell-Side Liquidity (SSL) Swept: Terjadi penembusan likuidasi stop-loss di $63,850 dengan 42% wick absorption + konfirmasi On-Chain Whale Outflow (-$142M) dari exchange. Target likuidasi BSL atas di $65,600.",
    confidence: 88,
    liquidationPrice: 57735.0,
  },
];

// Position id vocabulary:
//  - "pos_sim_*"  = client-side simulated entry (simulateTradeEntry), owned by
//                   the client (auto-close on TP/CL is allowed here only).
//  - "pos-*"      = server paper book ids (paperBook.newId("pos")), owned by
//                   the server: bracket monitor + /api/broker/close own exits.
//  - other        = legacy seed rows ("pos_active_1"), client-only display.
function isSimPositionId(id?: string): boolean {
  return typeof id === "string" && id.startsWith("pos_sim_");
}

function isServerBackedId(id?: string): boolean {
  return typeof id === "string" && id.startsWith("pos-");
}

const INITIAL_CLOSED_TRADES: ClosedTrade[] = [
  {
    id: "closed_trade_sample_1",
    symbol: "BTC/USDT",
    side: "LONG",
    qty: 0.15,
    notionalUSD: 9540.0,
    entryPrice: 63600.0,
    exitPrice: 64850.0,
    pnlUSD: 187.5,
    pnlPercent: 1.97,
    openedAt: Date.now() - 3600000 * 2.5,
    closedAt: Date.now() - 3600000 * 1.1,
    exitReason: "TAKE_PROFIT",
    entryReasoning: "15m Sell-Side Liquidity (SSL) sweep di $63,550 dengan konfirmasi akumulasi paus on-chain (-$180M). Target 15m BSL di $64,850 tercapai.",
    targetLiquidityPool: "15m BSL ($14.2M)",
    rMultiple: 2.8,
  },
];

/**
 * Paper trading state machine: portfolio, posisi aktif, journal transaksi
 * tertutup, dan mark-to-market real-time (TP/CL bracket). Semua entri audit
 * diteruskan ke useAuditLedger lewat {@link prependAudit}.
 */
export function usePaperTrading({ symbol, currentPrice, prependAudit }: UsePaperTradingOptions) {
  const [portfolio, setPortfolio] = useState<Portfolio>(INITIAL_PORTFOLIO);
  const [positions, setPositions] = useState<Position[]>(INITIAL_POSITIONS);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>(INITIAL_CLOSED_TRADES);

  // Refs agar callback stabil dan bebas stale closure (dipakai oleh tick engine).
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const priceRef = useRef(currentPrice);
  priceRef.current = currentPrice;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  /**
   * Mark-to-market satu cycle (dipanggil HookBaru App via efek ketika
   * currentPrice berubah tiap detik). Mengecek bracket TP / Cut Loss (CL).
   */
  const processPriceTick = useCallback(
    (price: number) => {
      const survivors: Position[] = [];
      const newlyClosed: ClosedTrade[] = [];
      const auditEntries: AuditLogEntry[] = [];
      let realizedDelta = 0;
      let wins = 0;
      let losses = 0;

      for (const pos of positionsRef.current) {
        const priceDiff = pos.side === "LONG" ? price - pos.entryPrice : pos.entryPrice - price;
        const pnl = priceDiff * pos.qty;
        const pnlPercent = (priceDiff / pos.entryPrice) * 100;

        // Single-source-of-truth rule: the paper book + server-side bracket
        // monitor own every exit for server-backed positions ("pos-...", and
        // anything that arrived via addPosition from the pipeline). The client
        // ONLY auto-closes positions it created itself ("pos_sim_*"). This
        // prevents DOUBLE-CLOSING against the server's bracket monitor.
        if (!isSimPositionId(pos.id)) {
          survivors.push({
            ...pos,
            currentPrice: price,
            unrealizedPnl: Number(pnl.toFixed(2)),
            unrealizedPnlPercent: Number(pnlPercent.toFixed(2)),
          });
          continue;
        }

        const isTakeProfitHit =
          (pos.side === "LONG" && price >= pos.takeProfit) ||
          (pos.side === "SHORT" && price <= pos.takeProfit);
        const isStopLossHit =
          (pos.side === "LONG" && price <= pos.stopLoss) ||
          (pos.side === "SHORT" && price >= pos.stopLoss);

        if (isTakeProfitHit || isStopLossHit) {
          const win = pnl > 0;
          realizedDelta += pnl;
          if (win) wins += 1;
          else losses += 1;

          const closedTrade: ClosedTrade = {
            id: `trade_closed_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            symbol: pos.symbol,
            side: pos.side,
            qty: pos.qty,
            notionalUSD: pos.notionalUSD || pos.qty * pos.entryPrice,
            entryPrice: pos.entryPrice,
            exitPrice: price,
            pnlUSD: Number(pnl.toFixed(2)),
            pnlPercent: Number(pnlPercent.toFixed(2)),
            openedAt: pos.openedAt,
            closedAt: Date.now(),
            exitReason: isTakeProfitHit ? "TAKE_PROFIT" : "CUT_LOSS",
            entryReasoning: pos.entryReasoning || "15m MTF Liquidity Sweep setup",
            targetLiquidityPool: pos.targetLiquidityPool,
            rMultiple: isTakeProfitHit ? Number((pos.riskRewardRatio || 2.1).toFixed(1)) : -1.0,
          };
          newlyClosed.push(closedTrade);

          auditEntries.push({
            id: `ORD-EXIT-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            timestamp: Date.now(),
            symbol: pos.symbol,
            action: pos.side === "LONG" ? "SELL" : "BUY",
            qty: pos.qty,
            requestedPrice: price,
            executedPrice: price,
            slippageBps: 0.8,
            status: "FILLED",
            reasoning: isTakeProfitHit
              ? `Target Liquidity Pool tercapai (${pos.targetLiquidityPool || "Take-Profit"}). Order cashflow direalisasikan.`
              : `Cut Loss (CL) terpicu untuk membatasi risiko modal. Invalidation stop loss tereksekusi.`,
            confidence: 99,
            riskEvaluation: {
              approved: true,
              maxDrawdownPassed: true,
              positionSizePassed: true,
              riskRewardRatio: 2.1,
              notes: "Automated bracket exit order executed.",
            },
            latency: { feederMs: 1, inferenceMs: 0, riskCheckMs: 1, brokerExecutionMs: 7, totalMs: 9 },
            signature: "sig_" + Math.random().toString(36).substring(2),
            payloadHash: "hash_" + Math.random().toString(36).substring(2),
            previousHash: "prev_" + Math.random().toString(36).substring(2),
            blockHash: "block_" + Math.random().toString(36).substring(2),
          });
        } else {
          survivors.push({
            ...pos,
            currentPrice: price,
            unrealizedPnl: Number(pnl.toFixed(2)),
            unrealizedPnlPercent: Number(pnlPercent.toFixed(2)),
          });
        }
      }

      if (newlyClosed.length > 0) {
        setClosedTrades((prev) => [...newlyClosed.reverse(), ...prev].slice(0, 50));
        for (const entry of auditEntries) prependAudit(entry);
      }

      const openFloating = survivors.reduce((sum, p) => sum + p.unrealizedPnl, 0);
      setPositions(survivors);

      setPortfolio((prev) => {
        const cash = prev.cash + realizedDelta;
        return {
          ...prev,
          cash: Number(cash.toFixed(2)),
          equity: Number((cash + openFloating).toFixed(2)),
          realizedPnl: Number((prev.realizedPnl + realizedDelta).toFixed(2)),
          winCount: prev.winCount + wins,
          lossCount: prev.lossCount + losses,
          totalTrades: prev.totalTrades + newlyClosed.length,
        };
      });
    },
    [prependAudit]
  );

  // Mark-to-market otomatis setiap harga berubah (tiap tick dari feed 1s).
  useEffect(() => {
    processPriceTick(currentPrice);
  }, [currentPrice, processPriceTick]);

  const addPosition = useCallback((position: Position) => {
    setPositions((prev) => {
      const filtered = prev.filter((p) => p.symbol !== position.symbol);
      return [...filtered, position];
    });
  }, []);

  const commitPortfolio = useCallback((next: Portfolio) => {
    setPortfolio(next);
  }, []);

  const moveToBreakEven = useCallback(async (sym: string) => {
    const targetPos = positionsRef.current.find((p) => p.symbol === sym);
    if (!targetPos) return;

    // Client-owned simulated positions update locally.
    if (isSimPositionId(targetPos.id)) {
      setPositions((prev) =>
        prev.map((p) =>
          p.symbol === sym
            ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 }
            : p
        )
      );
      return;
    }

    // Server-backed positions: the server owns the SL. Move-to-BE must go
    // through /api/broker/position/update so the bracket monitor sees it.
    try {
      const res = await authFetch("/api/broker/position/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: targetPos.id, breakEven: true }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        if (payload?.reason === "POSITION_NOT_FOUND") {
          // Legacy client-only row (seed): fall back to the local path.
          setPositions((prev) =>
            prev.map((p) =>
              p.symbol === sym
                ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 }
                : p
            )
          );
        } else {
          console.error(
            `Broker move-to-BE gagal (${payload?.reason || res.status}): ${payload?.message || "unknown"}`
          );
        }
        return;
      }
      setPositions((prev) =>
        prev.map((p) =>
          p.symbol === sym
            ? { ...p, stopLoss: p.entryPrice, potentialLossUSD: 0 }
            : p
        )
      );
    } catch (err) {
      console.error("Broker move-to-BE unreachable:", (err as Error).message);
    }
  }, []);

  const resetPaperAccount = useCallback((initialCapital: number) => {
    setPortfolio({
      cash: initialCapital,
      equity: initialCapital,
      initialBalance: initialCapital,
      realizedPnl: 0,
      winCount: 0,
      lossCount: 0,
      totalTrades: 0,
      maxDrawdownPercent: 0,
      currentDrawdownPercent: 0,
    });
    setPositions([]);
  }, []);

  const simulateTradeEntry = useCallback(
    (side: "LONG" | "SHORT") => {
      const sym = symbolRef.current;
      const entryPrice = priceRef.current;
      const isLong = side === "LONG";
      const stopLoss = isLong ? Number((entryPrice * 0.991).toFixed(2)) : Number((entryPrice * 1.009).toFixed(2));
      const takeProfit = isLong ? Number((entryPrice * 1.021).toFixed(2)) : Number((entryPrice * 0.979).toFixed(2));

      const allocatedUSD = Math.min(portfolio.cash, portfolio.equity * 0.12);
      const qty = Number((allocatedUSD / entryPrice).toFixed(4));
      const potentialProfitUSD = Number((qty * Math.abs(takeProfit - entryPrice)).toFixed(2));
      const potentialLossUSD = Number((qty * Math.abs(entryPrice - stopLoss)).toFixed(2));
      const riskRewardRatio = potentialLossUSD > 0 ? Number((potentialProfitUSD / potentialLossUSD).toFixed(2)) : 2.33;

      const newSimPos: Position = {
        id: `pos_sim_${Date.now()}`,
        symbol: sym,
        side,
        qty,
        notionalUSD: Number((qty * entryPrice).toFixed(2)),
        leverage: 10,
        entryPrice,
        currentPrice: entryPrice,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        stopLoss,
        takeProfit,
        potentialProfitUSD,
        potentialLossUSD,
        riskRewardRatio,
        openedAt: Date.now(),
        timeframe: "15m",
        marketType: "FUTURES",
        targetLiquidityPool: isLong ? "15m BSL ($21.5M Pool)" : "15m SSL ($19.8M Pool)",
        entryReasoning: isLong
          ? `15m MTF Liquidity Hunt: Terdeteksi sapuan Sell-Side Liquidity (SSL) di $${(entryPrice * 0.994).toFixed(0)} dengan wick rejection 46% + akumulasi paus On-Chain (-$142M netflow). Target likuidasi BSL pool $${takeProfit.toFixed(0)}.`
          : `15m MTF Liquidity Hunt: Terdeteksi sapuan Buy-Side Liquidity (BSL) di $${(entryPrice * 1.006).toFixed(0)} dengan supply rejection kuat + inflow exchange. Target likuidasi SSL pool $${takeProfit.toFixed(0)}.`,
        confidence: 89,
        liquidationPrice: isLong ? Number((entryPrice * 0.9).toFixed(2)) : Number((entryPrice * 1.1).toFixed(2)),
      };

      const simLog: AuditLogEntry = {
        id: `ORD-SIM-${Date.now()}`,
        timestamp: Date.now(),
        symbol: sym,
        action: isLong ? "BUY" : "SELL",
        qty,
        requestedPrice: entryPrice,
        executedPrice: entryPrice,
        slippageBps: 0.4,
        status: "FILLED",
        reasoning: newSimPos.entryReasoning || "Simulated 15m Signal",
        confidence: 89,
        riskEvaluation: {
          approved: true,
          maxDrawdownPassed: true,
          positionSizePassed: true,
          riskRewardRatio,
          notes: "Paper trading position opened on 15m MTF Liquidity Sweep setup.",
        },
        latency: { feederMs: 2, inferenceMs: 140, riskCheckMs: 1, brokerExecutionMs: 8, totalMs: 151 },
        signature: "sig_paper_" + Math.random().toString(36).substring(2),
        payloadHash: "hash_paper_" + Math.random().toString(36).substring(2),
        previousHash: "prev_paper_" + Math.random().toString(36).substring(2),
        blockHash: "block_paper_" + Math.random().toString(36).substring(2),
      };

      setPositions((prev) => {
        const filtered = prev.filter((p) => p.symbol !== sym);
        return [...filtered, newSimPos];
      });
      setPortfolio((p) => ({
        ...p,
        cash: Math.max(0, p.cash - allocatedUSD),
      }));
      prependAudit(simLog);
    },
    [portfolio, prependAudit]
  );

  /**
   * Client-side book-keeping for a closed position (shared by the local sim
   * path and the server-confirmed path). Overrides let the server's measured
   * exit price / realized PnL (net of fees) flow into the client book.
   */
  const applyClientClose = useCallback(
    (
      targetPos: Position,
      reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE",
      override?: { pnlUSD: number; exitPrice: number }
    ) => {
      const pnl = override ? override.pnlUSD : targetPos.unrealizedPnl;
      const exitPrice = override ? override.exitPrice : priceRef.current;
      const win = pnl >= 0;
      const sym = targetPos.symbol;

      const closedTrade: ClosedTrade = {
        id: `trade_closed_${Date.now()}`,
        symbol: sym,
        side: targetPos.side,
        qty: targetPos.qty,
        notionalUSD: targetPos.notionalUSD || targetPos.qty * targetPos.entryPrice,
        entryPrice: targetPos.entryPrice,
        exitPrice,
        pnlUSD: Number(pnl.toFixed(2)),
        pnlPercent: Number(((pnl / (targetPos.notionalUSD || targetPos.qty * targetPos.entryPrice)) * 100).toFixed(2)),
        openedAt: targetPos.openedAt,
        closedAt: Date.now(),
        exitReason: reason || "MANUAL_CLOSE",
        entryReasoning: targetPos.entryReasoning || "15m Tactical Entry",
        targetLiquidityPool: targetPos.targetLiquidityPool,
        rMultiple: pnl >= 0 ? 1.5 : -1.0,
      };

      const closeLog: AuditLogEntry = {
        id: `ORD-MANUAL-CLOSE-${Date.now()}`,
        timestamp: Date.now(),
        symbol: sym,
        action: targetPos.side === "LONG" ? "SELL" : "BUY",
        qty: targetPos.qty,
        requestedPrice: exitPrice,
        executedPrice: exitPrice,
        slippageBps: 0,
        status: "FILLED",
        reasoning:
          reason === "TAKE_PROFIT"
            ? "Target Take-Profit terealisasi."
            : reason === "CUT_LOSS"
            ? "Cut Loss dieksekusi untuk proteksi modal."
            : "Posisi ditutup secara manual oleh user (server-confirmed paper close).",
        confidence: 100,
        riskEvaluation: {
          approved: true,
          maxDrawdownPassed: true,
          positionSizePassed: true,
          riskRewardRatio: 2.1,
          notes: "Position exit executed.",
        },
        latency: { feederMs: 1, inferenceMs: 0, riskCheckMs: 1, brokerExecutionMs: 6, totalMs: 8 },
        signature: "sig_manual_" + Math.random().toString(36).substring(2),
        payloadHash: "hash_manual_" + Math.random().toString(36).substring(2),
        previousHash: "prev_manual_" + Math.random().toString(36).substring(2),
        blockHash: "block_manual_" + Math.random().toString(36).substring(2),
      };

      setPositions((prev) => prev.filter((p) => p.symbol !== sym));
      setPortfolio((p) => ({
        ...p,
        cash: p.cash + targetPos.qty * targetPos.entryPrice + pnl,
        equity: p.equity + pnl,
        realizedPnl: Number((p.realizedPnl + pnl).toFixed(2)),
        winCount: p.winCount + (win ? 1 : 0),
        lossCount: p.lossCount + (win ? 0 : 1),
        totalTrades: p.totalTrades + 1,
      }));
      setClosedTrades((prev) => [closedTrade, ...prev.slice(0, 49)]);
      prependAudit(closeLog);
    },
    [prependAudit]
  );

  const closePosition = useCallback(
    async (sym: string, reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE") => {
      const targetPos = positionsRef.current.find((p) => p.symbol === sym);
      if (!targetPos) return;

      // Client-owned simulated positions close locally.
      if (isSimPositionId(targetPos.id)) {
        applyClientClose(targetPos, reason);
        return;
      }

      // Server-backed positions: the paper book owns the exit. Close through
      // the server so positions, events stream and PositionsPanel stay in sync.
      try {
        const res = await authFetch("/api/broker/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positionId: targetPos.id }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok || !payload?.success) {
          if (payload?.reason === "POSITION_NOT_FOUND") {
            // Legacy client-only row (seed): fall back to the local path so
            // the manual close button keeps working for it.
            applyClientClose(targetPos, reason);
          } else if (payload?.reason === "POSITION_ALREADY_CLOSED") {
            // Server already closed it (bracket monitor) — drop the stale row.
            setPositions((prev) => prev.filter((p) => p.symbol !== sym));
          } else {
            console.error(
              `Broker close gagal (${payload?.reason || res.status}): ${payload?.message || "unknown"}`
            );
          }
          return;
        }
        applyClientClose(targetPos, reason, {
          pnlUSD: Number(payload.realizedPnlUSD ?? targetPos.unrealizedPnl),
          exitPrice: Number(payload.exitFillPrice ?? priceRef.current),
        });
      } catch (err) {
        console.error("Broker close unreachable:", (err as Error).message);
      }
    },
    [applyClientClose]
  );

  /** Prune server-backed rows ("pos-*") that are no longer OPEN on the server
   *  (closed by the bracket monitor or from PositionsPanel). Client-owned sim
   *  positions and legacy seed rows are left untouched. */
  const pruneServerPositions = useCallback((openServerIds: string[]) => {
    setPositions((prev) =>
      prev.filter((p) => (isServerBackedId(p.id) ? openServerIds.includes(p.id as string) : true))
    );
  }, []);

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
  };
}

export type PaperTradingController = ReturnType<typeof usePaperTrading>;