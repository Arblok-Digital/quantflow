import React, { useEffect, useState } from "react";
import { ProbResult, ProbInput, calibratedProb, coldProb } from "../logic/probabilityEngine";
import { Percent, Target, Shield, TrendingUp, TrendingDown, Info, Sparkles } from "lucide-react";

interface ProbabilityBadgeProps {
  currentPrice: number;
  /** Optional precomputed input for calibrated probability. */
  probInput?: Partial<ProbInput>;
  /** Entry price to compute TP1/TP2/SL from (defaults to currentPrice). */
  entryPrice?: number;
  side?: "LONG" | "SHORT";
  compact?: boolean;
}

/**
 * Probability Badge — TP1 / TP2 / SL probabilities from the probability engine.
 * Port of Keel's probability-engine calibrated P(TP before SL).
 */
export const ProbabilityBadge: React.FC<ProbabilityBadgeProps> = ({
  currentPrice,
  probInput,
  entryPrice = currentPrice,
  side = "LONG",
  compact = false,
}) => {
  const [result, setResult] = useState<ProbResult | null>(() =>
    coldProb(entryPrice, 0.021, 0.009)
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setLoading(true);
      try {
        const tpPct = 0.021;
        const slPctAbs = 0.009;
        const input: ProbInput = {
          flow: side === "LONG" ? "BULLISH" : "BEARISH",
          confluenceScore: probInput?.confluenceScore ?? 0.6,
          absorptionScore: probInput?.absorptionScore ?? 50,
          wallAction: probInput?.wallAction ?? "NONE",
          spreadPct: probInput?.spreadPct ?? 0.02,
          imbalance: probInput?.imbalance ?? 1.0,
        };
        const res = await calibratedProb(input, entryPrice, tpPct, slPctAbs);
        if (alive) setResult(res);
      } catch {
        if (alive) setResult(coldProb(entryPrice, 0.021, 0.009));
      } finally {
        if (alive) setLoading(false);
      }
    };
    run();
    const iv = setInterval(run, 30_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [entryPrice, side, probInput?.confluenceScore, probInput?.absorptionScore, probInput?.wallAction]);

  if (!result) return null;

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const isLong = side === "LONG";

  if (compact) {
    return (
      <div className="inline-flex items-center gap-2 font-mono text-xs">
        <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300">
          <Target className="w-3 h-3" /> P(TP) {pct(result.p)}
        </span>
        {result.prior && (
          <span title="Cold-start prior — belum ada riwayat trade" className="text-[10px] text-zinc-500 flex items-center gap-0.5">
            <Sparkles className="w-2.5 h-2.5" /> prior
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 font-mono">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-zinc-400 font-bold flex items-center gap-1.5">
          <Percent className="w-3 h-3 text-cyan-400" /> PROBABILITY ENGINE
        </div>
        <span className="text-[10px] text-zinc-500">
          {isLoading() ? "loading..." : result.prior ? "COLD PRIOR" : `${result.n} samples`}
        </span>
      </div>

      {/* Main probability gauge */}
      <div className="flex items-center gap-3">
        <div
          className={`text-2xl font-black ${
            result.p >= 0.6 ? "text-emerald-400" : result.p >= 0.5 ? "text-amber-400" : "text-rose-400"
          }`}
        >
          {pct(result.p)}
        </div>
        <div className="flex-1">
          <div className="text-[9px] text-zinc-500 uppercase">P(TP sebelum SL)</div>
          <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden mt-0.5">
            <div
              className="h-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 rounded-full transition-all"
              style={{ width: `${result.p * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* EV */}
      <div className={`mt-1.5 text-[11px] ${result.ev >= 0 ? "text-emerald-400" : "text-rose-400"} font-bold`}>
        {result.ev >= 0 ? "+" : ""}{(result.ev * 100).toFixed(2)}% EV
      </div>

      {/* TP1 / TP2 / SL grid */}
      <div className="grid grid-cols-3 gap-2 mt-2.5">
        <div className="bg-zinc-950/80 rounded-lg p-2 border border-emerald-500/20">
          <div className="flex items-center gap-1 text-[9px] text-emerald-400 font-bold uppercase">
            <TrendingUp className="w-2.5 h-2.5" /> TP1
          </div>
          <div className="text-xs font-bold text-emerald-300 mt-0.5">
            ${isLong ? Math.max(result.tp1, result.tp2 * 0.98) : Math.min(result.tp1 / 1.5, result.tp2)}</div>
          <div className="text-[9px] text-zinc-500">+2.1%</div>
        </div>
        <div className="bg-zinc-950/80 rounded-lg p-2 border border-amber-500/20">
          <div className="flex items-center gap-1 text-[9px] text-amber-400 font-bold uppercase">
            <Target className="w-2.5 h-2.5" /> TP2
          </div>
          <div className="text-xs font-bold text-amber-300 mt-0.5">
            ${isLong ? result.tp2 : result.tp1}</div>
          <div className="text-[9px] text-zinc-500">+3.15%</div>
        </div>
        <div className="bg-zinc-950/80 rounded-lg p-2 border border-rose-500/20">
          <div className="flex items-center gap-1 text-[9px] text-rose-400 font-bold uppercase">
            <Shield className="w-2.5 h-2.5" /> SL
          </div>
          <div className="text-xs font-bold text-rose-300 mt-0.5">
            ${isLong ? result.sl : entryPrice * 1.009}</div>
          <div className="text-[9px] text-zinc-500">-0.9%</div>
        </div>
      </div>

      <div className="mt-2 text-[9px] text-zinc-600 border-t border-zinc-800 pt-1.5 flex items-center gap-1">
        <Info className="w-2.5 h-2.5" />
        {result.prior
          ? "Belum ada riwayat outcome — memakai prior Laplace (P=0.52)."
          : `Calibrated dari ${result.n} outcome trade.`}
      </div>
    </div>
  );

  function isLoading() {
    // placeholder to avoid unused
    return loading;
  }
};

export default ProbabilityBadge;
