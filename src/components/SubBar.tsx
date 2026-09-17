import React from "react";
import { Play, Square, Zap, ShieldAlert } from "lucide-react";
import { MarketType, Timeframe, ModuleTab } from "../types";

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
  activeTab?: ModuleTab;
}

/**
 * Zone 3 — Toolbar persisten (selalu tampil, semua tab), persis mockup:
 * BTC/ETH/SOL · FUTURES/SPOT · 1s–1W · [_spacer_] SCAN AGENT · AUTO · KILL SWITCH.
 * Simbol, market type & timeframe menggerakkan state app → chart dashboard ikut.
 */
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
  const segCls = "flex items-center gap-1 bg-zinc-950/70 border border-zinc-800 rounded-lg px-1 py-1 font-mono text-xs";
  const btnOn = "bg-zinc-800 text-amber-300 font-bold";
  const btnOff = "text-zinc-400 hover:text-zinc-200";

  return (
    <div className="bg-zinc-900/50 border-b border-zinc-800/60 px-4 py-1.5 sticky top-[48px] z-20 backdrop-blur-sm">
      <div className="max-w-[1920px] mx-auto flex flex-wrap items-center gap-3">
        {/* Symbol seg — BTC / ETH / SOL */}
        <div className={segCls}>
          {PAIRS.map((pair) => (
            <button
              key={pair}
              onClick={() => onSelectSymbol(pair)}
              className={`px-2.5 py-1 rounded-md transition-all ${symbol === pair ? btnOn : btnOff}`}
              title={pair}
            >
              {pair.split("/")[0]}
            </button>
          ))}
        </div>

        {/* Market type seg — FUTURES / SPOT */}
        <div className={segCls}>
          <button
            onClick={() => onSelectMarketType("FUTURES")}
            className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1 ${marketType === "FUTURES" ? btnOn : btnOff}`}
          >
            <Zap className="w-3 h-3" /><span>FUTURES</span>
          </button>
          <button
            onClick={() => onSelectMarketType("SPOT")}
            className={`px-2.5 py-1 rounded-md transition-all ${marketType === "SPOT" ? btnOn : btnOff}`}
          >
            SPOT
          </button>
        </div>

        {/* Timeframe seg — 1s 1m 5m 15m 1h 4h 1D 1W */}
        <div className={`${segCls} overflow-x-auto`}>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => onSelectTimeframe(tf)}
              className={`px-1.5 py-1 rounded-md transition-all whitespace-nowrap ${timeframe === tf ? btnOn : btnOff}`}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-2" />

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onTriggerManualCycle}
            disabled={isAnalyzing || isEmergencyStop}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-bold transition-all ${
              isAnalyzing
                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700"
                : "bg-zinc-950/70 border border-zinc-800 text-amber-300 hover:border-zinc-600"
            }`}
            title="Trigger manual AI analysis cycle"
          >
            <Zap className={`h-3.5 w-3.5 ${isAnalyzing ? "animate-spin text-amber-400" : ""}`} />
            <span>{isAnalyzing ? "SCANNING..." : "SCAN AGENT"}</span>
          </button>
          <button
            onClick={onToggleAutoPilot}
            disabled={isEmergencyStop}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-bold transition-all ${
              isEmergencyStop
                ? "bg-zinc-800 text-zinc-600 cursor-not-allowed border border-zinc-700"
                : isAutoPilot
                ? "bg-amber-500 text-zinc-950 hover:bg-amber-400 shadow-lg shadow-amber-500/20"
                : "bg-zinc-950/70 text-zinc-300 hover:bg-zinc-800 border border-zinc-800"
            }`}
          >
            {isAutoPilot ? <Square className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />}
            <span>AUTO: {isAutoPilot ? "ON" : "OFF"}</span>
          </button>
          <button
            onClick={onToggleEmergencyStop}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-black transition-all border-2 ${
              isEmergencyStop
                ? "bg-rose-600 text-white border-rose-400 animate-pulse shadow-lg shadow-rose-600/40"
                : "bg-zinc-950/70 text-rose-400 border-rose-500/40 hover:bg-rose-500/10 hover:border-rose-500/60"
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