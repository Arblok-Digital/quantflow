import React, { useEffect, useState } from "react";
import { ProbResult, ProbInput, calibratedProb, coldProb } from "../logic/probabilityEngine";
import { bracketDefaultsForTf } from "../logic/bracketDefaults";
import type { Timeframe } from "../types";
import { Percent, Target, Shield, TrendingUp, TrendingDown, Info, Sparkles } from "lucide-react";

interface ProbabilityBadgeProps {
  currentPrice: number;
  probInput?: Partial<ProbInput>;
  entryPrice?: number;
  side?: "LONG" | "SHORT";
  compact?: boolean;
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** TF konteks (chart aktif) — untuk skala default est bila tak ada level real. */
  timeframe?: Timeframe;
  /** Posisi aktual terbuka (dipakai untuk TP/SL + side real, bukan default). */
  livePosition?: {
    side: string;
    entryPrice?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
  } | null;
  /** Keputusan pipeline terakhir (fallback side/entry bila belum ada posisi). */
  liveDecision?: {
    action?: string;
    targetPrice?: number | null;
    stopLoss?: number | null;
    takeProfit?: number | null;
  } | null;
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
  stopLoss = null,
  takeProfit = null,
  timeframe = "15m",
  livePosition = null,
  liveDecision = null,
}) => {
  // Resolusi side/entry/TP/SL: posisi aktual > decision pipeline > default est.
  // Sebelumnya side selalu LONG + TP/SL default — probabilitas bukan milik setup real.
  const posSideRaw = String(livePosition?.side || "").toUpperCase();
  const decActionRaw = String(liveDecision?.action || "").toUpperCase();
  const sideFallback: "LONG" | "SHORT" = side === "SHORT" ? "SHORT" : "LONG";
  const resolvedSide: "LONG" | "SHORT" =
    posSideRaw.includes("SHORT") || posSideRaw === "SELL"
      ? "SHORT"
      : posSideRaw.includes("LONG") || posSideRaw === "BUY"
        ? "LONG"
        : decActionRaw === "SELL" || decActionRaw === "SHORT"
          ? "SHORT"
          : decActionRaw === "BUY" || decActionRaw === "LONG"
            ? "LONG"
            : sideFallback;
  const resolvedEntry =
    (livePosition?.entryPrice != null && isFinite(livePosition.entryPrice) && livePosition.entryPrice > 0
      ? livePosition.entryPrice
      : liveDecision?.targetPrice != null && isFinite(liveDecision.targetPrice) && liveDecision.targetPrice > 0
        ? liveDecision.targetPrice
        : entryPrice) || currentPrice;
  const resolvedSL =
    livePosition?.stopLoss != null && isFinite(livePosition.stopLoss) && livePosition.stopLoss > 0
      ? livePosition.stopLoss
      : stopLoss != null && isFinite(stopLoss) && stopLoss > 0
        ? stopLoss
        : liveDecision?.stopLoss != null && isFinite(liveDecision.stopLoss) && liveDecision.stopLoss > 0
          ? liveDecision.stopLoss
          : null;
  const resolvedTP =
    livePosition?.takeProfit != null && isFinite(livePosition.takeProfit) && livePosition.takeProfit > 0
      ? livePosition.takeProfit
      : takeProfit != null && isFinite(takeProfit) && takeProfit > 0
        ? takeProfit
        : liveDecision?.takeProfit != null && isFinite(liveDecision.takeProfit) && liveDecision.takeProfit > 0
          ? liveDecision.takeProfit
          : null;
  // Default est diskala TF konteks bila tak ada level real (bracketDefaultsForTf).
  const estDefaults = bracketDefaultsForTf(timeframe);
  const [result, setResult] = useState<ProbResult | null>(() =>
    coldProb(resolvedEntry, estDefaults.tpPct / 100, estDefaults.slPct / 100)
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setLoading(true);
      try {
        // TP/SL real dari posisi/decision bila ada; fallback default est
        // diskala TF (bracketDefaultsForTf — intraday 1.2/0.8, bukan 3.5/1.5).
        const tpPct =
          resolvedTP != null && resolvedEntry > 0
            ? Math.abs(resolvedTP - resolvedEntry) / resolvedEntry
            : estDefaults.tpPct / 100;
        const slPctAbs =
          resolvedSL != null && resolvedEntry > 0
            ? Math.abs(resolvedEntry - resolvedSL) / resolvedEntry
            : estDefaults.slPct / 100;
        const input: ProbInput = {
          flow: resolvedSide === "LONG" ? "BULLISH" : "BEARISH",
          confluenceScore: probInput?.confluenceScore ?? 0.6,
          absorptionScore: probInput?.absorptionScore ?? 50,
          wallAction: probInput?.wallAction ?? "NONE",
          spreadPct: probInput?.spreadPct ?? 0.02,
          imbalance: probInput?.imbalance ?? 1.0,
        };
        const res = await calibratedProb(input, resolvedEntry, tpPct, slPctAbs);
        if (alive) setResult(res);
      } catch {
        if (alive) setResult(coldProb(resolvedEntry, 0.035, 0.015));
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
  }, [resolvedEntry, resolvedSide, resolvedTP, resolvedSL, probInput?.confluenceScore, probInput?.absorptionScore, probInput?.wallAction]);

  if (!result) return null;

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const isLong = resolvedSide === "LONG";
  // Live bila TP/SL berasal dari posisi/decision real (bukan default est).
  const hasLiveLevels = resolvedTP != null && resolvedSL != null;
  const levelSource = livePosition
    ? `posisi ${livePosition.side} @ ${resolvedEntry.toFixed(2)}`
    : liveDecision?.action
      ? `decision ${liveDecision.action}`
      : "default est.";
  const pctLabel = (absPrice: number): string => {
    if (!isFinite(absPrice) || resolvedEntry === 0) return "–";
    return `${(((absPrice - resolvedEntry) / resolvedEntry) * 100).toFixed(2)}%`;
  };

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

      <div className="grid grid-cols-3 gap-2 mt-2.5">
        <div className="bg-zinc-950/80 rounded-lg p-2 border border-emerald-500/20">
          <div className="flex items-center gap-1 text-[9px] text-emerald-400 font-bold uppercase">
            <TrendingUp className="w-2.5 h-2.5" /> {hasLiveLevels ? `TP (${resolvedSide})` : "TP1 — default est."}
          </div>
          <div className="text-xs font-bold text-emerald-300 mt-0.5">
            ${hasLiveLevels ? Number(resolvedTP).toFixed(2) : isLong ? Math.max(result.tp1, result.tp2 * 0.98).toFixed(2) : Math.min(result.tp1 / 1.5, result.tp2).toFixed(2)}</div>
          <div className="text-[9px] text-zinc-500">{hasLiveLevels ? pctLabel(Number(resolvedTP)) : `+${estDefaults.tpPct}% default est.`}</div>
        </div>
        <div className="bg-zinc-950/80 rounded-lg p-2 border border-amber-500/20">
          <div className="flex items-center gap-1 text-[9px] text-amber-400 font-bold uppercase">
            <Target className="w-2.5 h-2.5" /> TP2 — default est.
          </div>
          <div className="text-xs font-bold text-amber-300 mt-0.5">
            ${isLong ? result.tp2.toFixed(2) : result.tp1.toFixed(2)}</div>
          <div className="text-[9px] text-zinc-500">+3.15% default est.</div>
        </div>
        <div className="bg-zinc-950/80 rounded-lg p-2 border border-rose-500/20">
          <div className="flex items-center gap-1 text-[9px] text-rose-400 font-bold uppercase">
            <Shield className="w-2.5 h-2.5" /> {hasLiveLevels ? `SL (${resolvedSide})` : "SL — default est."}
          </div>
          <div className="text-xs font-bold text-rose-300 mt-0.5">
            ${hasLiveLevels ? Number(resolvedSL).toFixed(2) : (resolvedEntry * (1 - estDefaults.slPct / 100)).toFixed(2)}</div>
          <div className="text-[9px] text-zinc-500">{hasLiveLevels ? pctLabel(Number(resolvedSL)) : `-${estDefaults.slPct}% default est.`}</div>
        </div>
      </div>

      <div className="mt-2 text-[9px] text-zinc-600 border-t border-zinc-800 pt-1.5 flex items-center gap-1">
        <Info className="w-2.5 h-2.5" />
        {result.prior
          ? `Belum ada riwayat outcome — memakai prior Laplace (P=0.52). prior (${result.bucket}) • ${levelSource}`
          : `Calibrated ${result.bucket} • ${levelSource}`}
      </div>
    </div>
  );

  function isLoading() {
    // placeholder to avoid unused
    return loading;
  }
};

export default ProbabilityBadge;
