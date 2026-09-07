import React, { useEffect, useRef, useState } from "react";
import { MTFLiquidityAnalysis, OrderBook } from "../types";
import { analyzeWallDynamics, WallDynamicsVerdict } from "../logic/wallDynamics";
import { 
  Crosshair, 
  Target, 
  Layers, 
  Flame, 
  ArrowUpRight, 
  ArrowDownRight, 
  CheckCircle2, 
  AlertCircle,
  Waves,
  ShieldX,
  ShieldCheck,
  Activity
} from "lucide-react";

interface LiquidityHuntPanelProps {
  mtfLiquidity: MTFLiquidityAnalysis;
  currentPrice: number;
  /** Real order book from SSE/WS feed — drives live WallDynamics. */
  orderBook?: OrderBook;
}

export const LiquidityHuntPanel: React.FC<LiquidityHuntPanelProps> = ({
  mtfLiquidity,
  currentPrice,
  orderBook,
}) => {
  const isSweepActive = Boolean(mtfLiquidity.recentSweep);
  const nearestBSL = mtfLiquidity.nearestBSL;
  const nearestSSL = mtfLiquidity.nearestSSL;

  // --- Live Wall Dynamics (ported from Keel wall-dynamics.ts) ---
  // Compare consecutive order book snapshots to detect sell-wall pulls,
  // bid-support shifts, and wall additions.
  const [wall, setWall] = useState<WallDynamicsVerdict | null>(null);
  const prevBookRef = useRef<OrderBook | null>(null);

  useEffect(() => {
    if (!orderBook || orderBook.asks.length === 0) return;
    const verdict = analyzeWallDynamics(prevBookRef.current, orderBook);
    if (prevBookRef.current) {
      // Only update when a meaningful change happened to avoid noisy re-renders
      if (verdict.action !== "NONE" || verdict.sellWallUsd > 0) {
        setWall(verdict);
      }
    } else {
      setWall(verdict); // baseline
    }
    prevBookRef.current = orderBook;
  }, [orderBook]);

  const bslDistPercent = nearestBSL
    ? (((nearestBSL.midPrice - currentPrice) / currentPrice) * 100).toFixed(2)
    : "+0.00";

  const sslDistPercent = nearestSSL
    ? (((currentPrice - nearestSSL.midPrice) / currentPrice) * 100).toFixed(2)
    : "-0.00";

  const wallBadge = (action?: string) => {
    switch (action) {
      case "PULLED_SELL_WALL":
        return { cls: "bg-rose-500/15 text-rose-400 border-rose-500/30", label: "SELL WALL PULLED", icon: <ShieldX className="w-3 h-3" /> };
      case "BID_SUPPORT_UP":
        return { cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", label: "BID SUPPORT UP", icon: <ArrowUpRight className="w-3 h-3" /> };
      case "WALL_ADDED":
        return { cls: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30", label: "WALL ADDED", icon: <Activity className="w-3 h-3" /> };
      default:
        return { cls: "bg-zinc-800 text-zinc-400 border-zinc-700", label: "NO WALL MOVE", icon: <Waves className="w-3 h-3" /> };
    }
  };
  const badge = wallBadge(wall?.action);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 relative overflow-hidden shadow-sm flex flex-col justify-between">
      {/* Ambient Bento Dot Grid */}
      <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />

      <div className="relative z-10 flex flex-col h-full justify-between space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-400">
              <Crosshair className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-semibold text-zinc-200 uppercase tracking-wider font-mono">
                  MTF Liquidation Hunt Engine
                </h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30 uppercase tracking-wider">
                  {mtfLiquidity.primaryTimeframe} Futures &bull; {mtfLiquidity.macroTimeframe} Spot
                </span>
              </div>
              <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-wide">
                Smart Money Stop-Loss Sweeps &bull; High-Leverage Liquidation Clusters
              </p>
            </div>
          </div>

          <span
            className={`px-2.5 py-1 text-[10px] font-mono font-bold rounded-lg border uppercase tracking-wider flex items-center gap-1.5 ${
              isSweepActive
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30 animate-pulse"
                : mtfLiquidity.activeState.startsWith("HUNTING")
                ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                : "bg-zinc-800 text-zinc-300 border-zinc-700"
            }`}
          >
            <Flame className="w-3 h-3" />
            {mtfLiquidity.activeState.replace("_", " ")}
          </span>
        </div>

        {/* Liquidity Hunt 2-Pool Radar (Upper BSL vs Lower SSL) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 font-mono">
          {/* Upper Buy-Side Liquidity Pool (Short Stops) */}
          <div className="p-3.5 bg-zinc-950/80 rounded-xl border border-rose-950/50 relative overflow-hidden">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <div className="flex items-center gap-1.5 text-rose-400 font-bold">
                <ArrowUpRight className="w-4 h-4" />
                <span>UPPER BSL POOL (Short Stops)</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                {nearestBSL ? `${nearestBSL.timeframe} TF` : "Range High"}
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-lg font-black text-zinc-100">
                ${nearestBSL ? nearestBSL.midPrice.toFixed(2) : (currentPrice * 1.025).toFixed(2)}
              </span>
              <span className="text-xs font-bold text-rose-400">
                +{bslDistPercent}% ({nearestBSL ? `$${nearestBSL.estimatedVolumeUSD}M` : "$14.2M"} Liq)
              </span>
            </div>
            <div className="mt-2 text-[10px] text-zinc-500 flex justify-between border-t border-zinc-900 pt-1.5">
              <span>Cluster Leverage: 50x - 100x</span>
              <span className="text-zinc-400">
                Target: {nearestBSL?.status === "FULLY_SWEPT" ? "Swept" : "Unswept Liquidity"}
              </span>
            </div>
          </div>

          {/* Lower Sell-Side Liquidity Pool (Long Stops) */}
          <div className="p-3.5 bg-zinc-950/80 rounded-xl border border-emerald-950/50 relative overflow-hidden">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <div className="flex items-center gap-1.5 text-emerald-400 font-bold">
                <ArrowDownRight className="w-4 h-4" />
                <span>LOWER SSL POOL (Long Stops)</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {nearestSSL ? `${nearestSSL.timeframe} TF` : "Range Low"}
              </span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-lg font-black text-zinc-100">
                ${nearestSSL ? nearestSSL.midPrice.toFixed(2) : (currentPrice * 0.975).toFixed(2)}
              </span>
              <span className="text-xs font-bold text-emerald-400">
                -{sslDistPercent}% ({nearestSSL ? `$${nearestSSL.estimatedVolumeUSD}M` : "$18.5M"} Liq)
              </span>
            </div>
            <div className="mt-2 text-[10px] text-zinc-500 flex justify-between border-t border-zinc-900 pt-1.5">
              <span>Cluster Leverage: 20x - 50x</span>
              <span className="text-zinc-400">
                Target: {nearestSSL?.status === "FULLY_SWEPT" ? "Swept" : "Unswept Liquidity"}
              </span>
            </div>
          </div>
        </div>

        {/* MTF Confluence & Sweep Status */}
        <div className="bg-zinc-950/90 rounded-xl p-3 border border-zinc-800 font-mono text-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-[11px] font-bold text-zinc-300">
                MTF CONFLUENCE & SWEEP STATUS:
              </span>
            </div>
            <span className="text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              Confluence: {mtfLiquidity.confluenceScore}%
            </span>
          </div>

          <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 rounded-full transition-all duration-300"
              style={{ width: `${mtfLiquidity.confluenceScore}%` }}
            />
          </div>

          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {mtfLiquidity.confluenceSummary}
          </p>

          {/* Recent Sweep Details */}
          {mtfLiquidity.recentSweep ? (
            <div className="mt-2 flex items-center justify-between p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-[10px] text-emerald-300">
              <span className="flex items-center gap-1.5 font-bold">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                {mtfLiquidity.recentSweep.type.replace(/_/g, " ")} ({mtfLiquidity.recentSweep.wickRejectionPercent}% WICK ABSORPTION)
              </span>
              <span>Invalidation Stop: ${mtfLiquidity.recentSweep.invalidationPrice}</span>
            </div>
          ) : (
            <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
              <span className="flex items-center gap-1">
                <AlertCircle className="w-3 h-3 text-zinc-500" />
                No active sweep in latest 3 candles. Monitoring range expansion.
              </span>
              <span>Scanning 15m & 4H High/Low wicks</span>
            </div>
          )}
        </div>

        {/* Live Wall Dynamics (real order book from WS feed) */}
        <div className="bg-zinc-950/90 rounded-xl p-3 border border-zinc-800 font-mono text-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Waves className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-[11px] font-bold text-zinc-300">LIVE WALL DYNAMICS:</span>
            </div>
            <span className={`text-[10px] px-2 py-0.5 rounded border font-bold flex items-center gap-1 ${badge.cls}`}>
              {badge.icon} {badge.label}
            </span>
          </div>

          <p className="text-[11px] text-zinc-400 leading-relaxed">
            {wall?.detail ?? "Menunggu snapshot order book berikutnya untuk analisis dinding likuiditas."}
          </p>

          <div className="grid grid-cols-3 gap-2 text-[10px]">
            <div className="bg-zinc-900 rounded-lg p-2 border border-zinc-800">
              <span className="text-zinc-500 block">SELL WALL</span>
              <span className="text-rose-400 font-bold">${((wall?.sellWallUsd ?? 0) / 1_000).toFixed(0)}K</span>
            </div>
            <div className="bg-zinc-900 rounded-lg p-2 border border-zinc-800">
              <span className="text-zinc-500 block">BID WALL</span>
              <span className="text-emerald-400 font-bold">${((wall?.bidWallUsd ?? 0) / 1_000).toFixed(0)}K</span>
            </div>
            <div className="bg-zinc-900 rounded-lg p-2 border border-zinc-800">
              <span className="text-zinc-500 block">BID SHIFT</span>
              <span className="text-cyan-400 font-bold">
                {wall?.bidSupportShiftBps != null ? `${wall.bidSupportShiftBps >= 0 ? "+" : ""}${wall.bidSupportShiftBps} bps` : "–"}
              </span>
            </div>
          </div>
          <div className="text-[9px] text-zinc-600 flex items-center gap-1">
            <ShieldCheck className="w-2.5 h-2.5 text-emerald-500" />
            {wall?.pulledNotionalUsd ? `Pulled: $${(wall.pulledNotionalUsd / 1_000).toFixed(0)}K` : "No pull detected"}
            <span className="ml-auto">Sumber: {orderBook && orderBook.asks.length > 0 ? "REAL ORDER BOOK (WS)" : "menunggu depth..."}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
