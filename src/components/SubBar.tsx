import React from "react";
import { Play, Square, Zap, ShieldAlert, TrendingUp } from "lucide-react";
import { MarketType, Timeframe } from "../types";

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT"] as const;
const TIMEFRAMES: Timeframe[] = ["1s", "1m", "5m", "15m", "1h", "4h", "1D", "1W"];

interface SubBarProps {
  symbol: string;
  onSelectSymbol: (symbol: string) => void;
  marketType: MarketType;
  onSelectMarketType: (m: MarketType) => void;
  timeframe: Timeframe;
  onSelectTimeframe: (tf: Timeframe) => void;
  isAutoPilot: boolean;
  onToggleAutoPilot: () => void;
  onTriggerManualCycle: () => void;
  isEmergencyStop: boolean;
  onToggleEmergencyStop: () => void;
  isAnalyzing?: boolean;
}

/** Contextual market controls: pair, market type, timeframe, scan/auto/kill.
 *  Slim horizontal bar rendered directly below the Header. */
export const SubBar: React.FC<SubBarProps> = ({
  symbol,
  onSelectSymbol,
  marketType,
  onSelectMarketType,
  timeframe,
  onSelectTimeframe,
  isAutoPilot,
  onToggleAutoPilot,
  onTriggerManualCycle,
  isEmergencyStop,
  onToggleEmergencyStop,
  isAnalyzing = false,
}) => {
  return (
    <div className="bg-zinc-900 border-b border-zinc-800/80 px-4 py-2 sticky top-0 z-20">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center gap-2 sm:gap-3">
        {/* Pair selector */}
        <div className="flex items-center gap-1 bg-zinc-950/60 border border-zinc-800 rounded-lg px-1.5 py-1">
          {PAIRS.map((pair) => (
            <button
              key={pair}
              onClick={() => onSelectSymbol(pair)}
              className={`px-2 py-0.5 text-xs font-mono rounded transition-all ${
                symbol === pair
                  ? "bg-zinc-800 text-amber-400 font-bold border border-zinc-700"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {pair.split("/")[0]}
            </button>
          ))}
        </div>

        {/* Market type toggle */}
        <div className="flex bg-zinc-950/60 border border-zinc-800 rounded-lg p-1 font-mono text-xs">
          <button
            onClick={() => onSelectMarketType("FUTURES")}
            className={`px-2.5 py-1 rounded-md transition-all font-bold flex items-center gap-1 ${
              marketType === "FUTURES"
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Zap className="w-3 h-3" />
            <span>FUTURES</span>
          </button>
          <button
            onClick={() => onSelectMarketType("SPOT")}
            className={`px-2.5 py-1 rounded-md transition-all font-bold flex items-center gap-1 ${
              marketType === "SPOT"
                ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <TrendingUp className="w-3 h-3" />
            <span>SPOT</span>
          </button>
        </div>

        {/* Timeframe quick select */}
        <div className="flex bg-zinc-950/60 border border-zinc-800 rounded-lg p-1 font-mono text-xs overflow-x-auto">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => onSelectTimeframe(tf)}
              className={`px-1.5 py-1 rounded-md transition-all font-semibold whitespace-nowrap ${
                timeframe === tf
                  ? "bg-amber-500/20 text-amber-300 font-bold border border-amber-500/50"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Execution controls */}
        <div className="flex items-center gap-2">
          {/* AI Manual / SCAN */}
          <button
            onClick={onTriggerManualCycle}
            disabled={isAnalyzing || isEmergencyStop}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-medium transition-all ${
              isAnalyzing
                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700"
                : "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30"
            }`}
            title="Trigger manual AI analysis cycle"
          >
            <Zap className={`h-3.5 w-3.5 ${isAnalyzing ? "animate-spin text-amber-400" : ""}`} />
            <span>{isAnalyzing ? "SCANNING..." : "SCAN AGENT"}</span>
          </button>

          {/* Auto Pilot toggle */}
          <button
            onClick={onToggleAutoPilot}
            disabled={isEmergencyStop}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-bold transition-all ${
              isEmergencyStop
                ? "bg-zinc-800 text-zinc-600 cursor-not-allowed border border-zinc-700"
                : isAutoPilot
                ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20"
                : "bg-zinc-950/60 text-zinc-300 hover:bg-zinc-800 border border-zinc-800"
            }`}
          >
            {isAutoPilot ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />}
            <span>AUTO: {isAutoPilot ? "ON" : "OFF"}</span>
          </button>

          {/* Emergency Kill Switch */}
          <button
            onClick={onToggleEmergencyStop}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-bold transition-all ${
              isEmergencyStop
                ? "bg-rose-500 text-white animate-pulse shadow-lg shadow-rose-500/30"
                : "bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/30"
            }`}
            title="Emergency Kill Switch - Hentikan seluruh eksekusi secara instan"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            <span>{isEmergencyStop ? "KILL ACTIVE" : "KILL SWITCH"}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
