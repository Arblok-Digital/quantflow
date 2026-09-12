import React from "react";
import { ClosedTrade, Portfolio, LatencyBreakdown } from "../types";
import {
  Clock,
  Crosshair
} from "lucide-react";

interface ExecutionMetricsProps {
  portfolio: Portfolio;
  latestLatency: LatencyBreakdown;
  averageSlippageBps: number;
  /** Closed trades dari ledger (opsional) — dipakai untuk win-rate jujur. */
  closedTrades?: ClosedTrade[];
}

const fmtMs = (v: number) => (v > 0 ? `${v}ms` : "-");

export const ExecutionMetrics: React.FC<ExecutionMetricsProps> = ({
  portfolio,
  latestLatency,
  averageSlippageBps,
  closedTrades,
}) => {
  // Win-rate jujur: prioritas closedTrades ledger bila tersedia, fallback ke portfolio.
  const ledgerWins = Array.isArray(closedTrades)
    ? closedTrades.filter((t) => t.pnlUSD > 0).length
    : null;
  const ledgerTotal = Array.isArray(closedTrades) ? closedTrades.length : 0;
  const winRate =
    ledgerWins != null && ledgerTotal > 0
      ? ((ledgerWins / ledgerTotal) * 100).toFixed(1)
      : portfolio.totalTrades > 0
        ? ((portfolio.winCount / portfolio.totalTrades) * 100).toFixed(1)
        : "-";

  const totalPnl = portfolio.realizedPnl;
  const isPnlPositive = totalPnl >= 0;
  const roiPercent = ((totalPnl / portfolio.initialBalance) * 100).toFixed(2);
  
  return (
    <div className="space-y-4">
      {/* Top Bento Grid: High-contrast Bento Performance Card + Pipeline Telemetry Card */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Bento Signature: High-contrast Performance Metrics Card (lg:col-span-7) */}
        <div className="lg:col-span-7 bg-zinc-100 text-zinc-900 rounded-2xl p-5 flex flex-col sm:flex-row gap-6 justify-between items-stretch shadow-md">
          <div className="flex-1 sm:border-r sm:border-zinc-300 sm:pr-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-wider font-mono">
                  Swing Performance Metrics
                </h2>
                <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">
                  MTF LIQUIDITY ALPHA
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl sm:text-4xl font-extrabold tracking-tight font-sans text-zinc-950">
                  {isPnlPositive ? "+" : ""}{roiPercent}%
                </span>
                <span className="text-xs font-bold text-amber-600 font-mono">
                  Realized Return
                </span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-zinc-200 grid grid-cols-1 gap-2 font-mono">
              <div>
                <p className="text-[10px] uppercase font-bold text-zinc-500">Avg Slip</p>
                <p className="text-base font-black text-zinc-900">{averageSlippageBps.toFixed(2)} bps</p>
              </div>
            </div>
          </div>

          {/* Right pulse circle from Bento design */}
          <div className="sm:w-1/3 flex flex-col justify-center items-center text-center py-2 shrink-0">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border-2 border-amber-500 mb-2.5 flex items-center justify-center shadow-inner">
              <Crosshair className="w-7 h-7 text-amber-600" />
            </div>
            <p className="text-[11px] font-bold uppercase tracking-wider text-zinc-900 font-mono">MTF Swing Pulse</p>
            <p className="text-[10px] font-mono text-zinc-500">15m Futures / 4h Spot</p>
            <p className="text-[10px] font-mono text-zinc-700 font-bold mt-1">
              Eq: ${portfolio.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {/* Pipeline Telemetry Bento Card (lg:col-span-5) */}
        <div className="lg:col-span-5 bg-zinc-900 border border-zinc-800 rounded-2xl p-5 relative overflow-hidden shadow-sm flex flex-col justify-between">
          <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />
          <div className="relative z-10">
            <div className="flex items-center justify-between mb-3 border-b border-zinc-800/80 pb-2">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 bg-zinc-800 rounded flex items-center justify-center text-amber-400">
                  <Clock className="w-3.5 h-3.5" />
                </div>
                <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider font-mono">
                  Modular Pipeline Telemetry
                </h3>
              </div>
              <span className="text-xs font-mono font-bold text-amber-400 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">
                Cycle: {fmtMs(latestLatency.totalMs)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 font-mono text-xs">
              <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">1. MTF Feeder</div>
                <div className="text-emerald-400 font-bold mt-0.5">{fmtMs(latestLatency.feederMs)}</div>
                <div className="text-[9px] text-zinc-500">15m & 4h Ring Buffer</div>
              </div>

              <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">2. MTF Decision</div>
                <div className="text-sky-400 font-bold mt-0.5">{fmtMs(latestLatency.inferenceMs)}</div>
                <div className="text-[9px] text-zinc-500">Gemini / Quant CoT</div>
              </div>

              <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">3. Risk Gatekeeper</div>
                <div className="text-emerald-400 font-bold mt-0.5">{fmtMs(latestLatency.riskCheckMs)}</div>
                <div className="text-[9px] text-zinc-500">Deterministic Rules</div>
              </div>

              <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800">
                <div className="text-[10px] text-zinc-500 uppercase">4. Broker Gateway</div>
                <div className="text-amber-400 font-bold mt-0.5">{fmtMs(latestLatency.brokerExecutionMs)}</div>
                <div className="text-[9px] text-zinc-500">HMAC-Signed FIX Order</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
