import React from "react";
import { Portfolio, Position, ClosedTrade } from "../types";
import { DollarSign, Target, Crosshair } from "lucide-react";

// ---------------------------------------------------------------------------
// PortfolioSummaryPanel — 4-card bento grid showing equity, PnL, cashflow
// projection, and win rate.  Extracted from PaperTradingPanel.
// ---------------------------------------------------------------------------

interface PortfolioSummaryPanelProps {
  portfolio: Portfolio;
  positions: Position[];
  closedTrades: ClosedTrade[];
  currentPrice: number;
}

export const PortfolioSummaryPanel: React.FC<PortfolioSummaryPanelProps> = ({
  portfolio,
  positions,
  closedTrades,
}) => {
  const totalUnrealizedPnl = positions.reduce((acc, p) => acc + p.unrealizedPnl, 0);
  const totalRealizedPnl = portfolio.realizedPnl;
  const netTotalCashflow = totalRealizedPnl + totalUnrealizedPnl;
  const isNetPositive = netTotalCashflow >= 0;
  const isUnrealizedPositive = totalUnrealizedPnl >= 0;

  const totalPotentialProfitUSD = positions.reduce(
    (acc, p) => acc + (p.potentialProfitUSD || p.qty * Math.abs(p.takeProfit - p.entryPrice)),
    0
  );
  const totalPotentialLossUSD = positions.reduce(
    (acc, p) => acc + (p.potentialLossUSD || p.qty * Math.abs(p.entryPrice - p.stopLoss)),
    0
  );
  const projectedRRRatio =
    totalPotentialLossUSD > 0 ? (totalPotentialProfitUSD / totalPotentialLossUSD).toFixed(2) : "—";
  const hasAnyTradeHistory = closedTrades.length > 0 || portfolio.totalTrades > 0;

  const totalTradesCount =
    closedTrades.length + (portfolio.totalTrades > 0 ? portfolio.totalTrades : 0);
  const winCount =
    closedTrades.filter((t) => t.pnlUSD > 0).length + portfolio.winCount;
  const winRateDisplay =
    totalTradesCount > 0
      ? `${((winCount / totalTradesCount) * 100).toFixed(1)}%`
      : "—";
  const winRateSubLabel =
    totalTradesCount > 0
      ? `${winCount} Wins • ${totalTradesCount - winCount} Losses`
      : "belum ada trade";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {/* Card 1: Account Equity & Cash Balance */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
        <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
          <span>TOTAL PAPER EQUITY</span>
          <DollarSign className="w-4 h-4 text-amber-400" />
        </div>
        <div className="my-2">
          <div className="text-2xl sm:text-3xl font-black font-mono text-zinc-100">
            $
            {portfolio.equity.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </div>
          <div className="text-xs font-mono text-zinc-500 flex items-center justify-between mt-1">
            <span>Available Cash:</span>
            <span className="text-zinc-300 font-bold">
              $
              {portfolio.cash.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>
        </div>
        <div className="text-[10px] text-zinc-500 font-mono pt-2 border-t border-zinc-800 flex items-center justify-between">
          <span>Modal Awal:</span>
          <span className="text-zinc-400 font-bold">
            ${portfolio.initialBalance.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Card 2: Floating / Unrealized PnL */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
        <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
          <span>FLOATING PNL (OPEN)</span>
          <span
            className={`w-2 h-2 rounded-full ${
              isUnrealizedPositive ? "bg-emerald-400 animate-pulse" : "bg-rose-400 animate-pulse"
            }`}
          />
        </div>
        <div className="my-2">
          <div
            className={`text-2xl sm:text-3xl font-black font-mono ${
              isUnrealizedPositive ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {isUnrealizedPositive ? "+" : ""}${totalUnrealizedPnl.toFixed(2)}
          </div>
          <div className="text-xs font-mono text-zinc-400 mt-1">
            Active Positions:{" "}
            <strong className="text-zinc-200">{positions.length} Pasang</strong>
          </div>
        </div>
        <div className="text-[10px] text-zinc-500 font-mono pt-2 border-t border-zinc-800 flex items-center justify-between">
          <span>Realized Closed PnL:</span>
          <span
            className={`font-bold ${
              totalRealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            {totalRealizedPnl >= 0 ? "+" : ""}${totalRealizedPnl.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Card 3: Projected Cashflow Target (TP vs CL) */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
        <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
          <span>CASHFLOW PROJECTION</span>
          <Target className="w-4 h-4 text-cyan-400" />
        </div>
        <div className="my-2">
          <div className="flex items-baseline gap-1.5 font-mono">
            <span className="text-lg font-black text-emerald-400">
              +${totalPotentialProfitUSD.toFixed(1)}
            </span>
            <span className="text-xs text-zinc-500">/</span>
            <span className="text-sm font-bold text-rose-400">
              -${totalPotentialLossUSD.toFixed(1)}
            </span>
          </div>
          <div className="text-[11px] font-mono text-zinc-400 mt-1 flex items-center justify-between">
            <span>Projected R:R:</span>
            <span className="text-amber-400 font-bold">
              {hasAnyTradeHistory || positions.length > 0
                ? `1 : ${projectedRRRatio}`
                : "— (belum ada trade)"}
            </span>
          </div>
        </div>
        <div className="text-[10px] text-zinc-500 font-mono pt-2 border-t border-zinc-800 flex items-center justify-between">
          <span>Status Cashflow:</span>
          <span className={`font-bold ${isNetPositive ? "text-emerald-400" : "text-rose-400"}`}>
            Net: {isNetPositive ? "+" : ""}${netTotalCashflow.toFixed(2)}
          </span>
        </div>
      </div>

      {/* Card 4: Historical Win Rate & Stats */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
        <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
          <span>WIN RATE & DISCIPLINE</span>
          <Crosshair className="w-4 h-4 text-purple-400" />
        </div>
        <div className="my-2">
          <div className="text-2xl sm:text-3xl font-black font-mono text-purple-400">
            {winRateDisplay}
          </div>
          <div className="text-xs font-mono text-zinc-400 mt-1">{winRateSubLabel}</div>
        </div>
        <div className="text-[10px] text-zinc-500 font-mono pt-2 border-t border-zinc-800 flex items-center justify-between">
          <span>Max Drawdown:</span>
          <span className="text-zinc-300 font-bold">
            {portfolio.maxDrawdownPercent.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
};
