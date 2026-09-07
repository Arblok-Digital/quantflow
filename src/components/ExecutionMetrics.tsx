import React from "react";
import { Portfolio, Position, LatencyBreakdown, ClosedTrade } from "../types";
import { 
  Zap, 
  TrendingUp, 
  Clock, 
  Target,
  Crosshair,
  ShieldCheck
} from "lucide-react";

interface ExecutionMetricsProps {
  portfolio: Portfolio;
  positions: Position[];
  latestLatency: LatencyBreakdown;
  onClosePosition: (symbol: string) => void;
  averageSlippageBps: number;
  /** Trade tertutup (riwayat) untuk metrik Profit Factor & R:R yang jujur. */
  closedTrades?: ClosedTrade[];
}

const fmtMs = (v: number) => (v > 0 ? `${v}ms` : "-");

export const ExecutionMetrics: React.FC<ExecutionMetricsProps> = ({
  portfolio,
  positions,
  latestLatency,
  onClosePosition,
  averageSlippageBps,
  closedTrades,
}) => {
  const winRate =
    portfolio.totalTrades > 0
      ? ((portfolio.winCount / portfolio.totalTrades) * 100).toFixed(1)
      : "-";

  const totalPnl = portfolio.realizedPnl;
  const isPnlPositive = totalPnl >= 0;
  const roiPercent = ((totalPnl / portfolio.initialBalance) * 100).toFixed(2);

  const closed = closedTrades || [];
  const wins = closed.filter((t) => t.pnlUSD > 0);
  const losses = closed.filter((t) => t.pnlUSD < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUSD, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
  const rMultiples = closed.filter((t) => t.rMultiple !== 0);
  const profitFactor =
    closed.length > 0
      ? grossLoss > 0
        ? (grossWin / grossLoss).toFixed(2)
        : grossWin > 0
        ? "∞"
        : "0.00"
      : "-";
  const avgRR =
    rMultiples.length > 0
      ? (rMultiples.reduce((s, t) => s + t.rMultiple, 0) / rMultiples.length).toFixed(2)
      : "-";

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

            <div className="mt-4 pt-3 border-t border-zinc-200 grid grid-cols-4 gap-2 font-mono">
              <div>
                <p className="text-[10px] uppercase font-bold text-zinc-500">Win Rate</p>
                <p className="text-base font-black text-zinc-900">{winRate}%</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-zinc-500">Profit Fac</p>
                <p className="text-base font-black text-zinc-900">{profitFactor}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold text-zinc-500">Avg R:R</p>
                <p className="text-base font-black text-zinc-900">{avgRR === "-" ? "-" : `1:${avgRR}`}</p>
              </div>
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

      {/* Active Positions Table Bento Card */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 relative overflow-hidden shadow-sm">
        <div className="flex items-center justify-between mb-3 border-b border-zinc-800 pb-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider font-mono">
              Active Swing Positions ({positions.length})
            </h3>
            <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[10px] font-mono">
              MTF LIQUIDATION TARGETS
            </span>
          </div>
          <span className="text-[11px] font-mono text-zinc-400">
            Realized PnL: <strong className={isPnlPositive ? "text-emerald-400" : "text-rose-400"}>${totalPnl.toFixed(2)}</strong>
          </span>
        </div>

        {positions.length === 0 ? (
          <div className="text-center py-5 text-zinc-500 font-mono text-xs bg-zinc-950/60 rounded-xl border border-zinc-800/60">
            Belum ada posisi terbuka. Agent sedang memindai area swing high/low untuk sinyal Liquidation Hunt.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
                  <th className="pb-2">ASSET</th>
                  <th className="pb-2">HORIZON</th>
                  <th className="pb-2">SIDE</th>
                  <th className="pb-2">ENTRY</th>
                  <th className="pb-2">TARGET LIQ POOL</th>
                  <th className="pb-2">STOP LOSS</th>
                  <th className="pb-2">PNL ($ / %)</th>
                  <th className="pb-2 text-right">ACTION</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {positions.map((pos) => {
                  const isPosProfitable = pos.unrealizedPnl >= 0;
                  return (
                    <tr key={pos.symbol} className="hover:bg-zinc-800/40 transition-colors">
                      <td className="py-2.5 font-bold text-zinc-200">{pos.symbol}</td>
                      <td className="py-2.5">
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                          {pos.timeframe || "15m"} {pos.marketType || "FUTURES"}
                        </span>
                      </td>
                      <td className="py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            pos.side === "LONG"
                              ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                              : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                          }`}
                        >
                          {pos.side}
                        </span>
                      </td>
                      <td className="py-2.5 text-zinc-300">${pos.entryPrice.toFixed(2)}</td>
                      <td className="py-2.5 text-amber-300 font-semibold">
                        ${pos.takeProfit.toFixed(2)} ({pos.targetLiquidityPool || "Opposite Pool"})
                      </td>
                      <td className="py-2.5 text-rose-400">${pos.stopLoss.toFixed(2)}</td>
                      <td className={`py-2.5 font-bold ${isPosProfitable ? "text-emerald-400" : "text-rose-400"}`}>
                        {isPosProfitable ? "+" : ""}${pos.unrealizedPnl.toFixed(2)} ({isPosProfitable ? "+" : ""}{pos.unrealizedPnlPercent.toFixed(2)}%)
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          onClick={() => onClosePosition(pos.symbol)}
                          className="rounded bg-zinc-800 hover:bg-rose-500 text-zinc-300 hover:text-white px-2.5 py-1 text-[10px] transition-colors border border-zinc-700 hover:border-rose-500"
                        >
                          CLOSE
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
