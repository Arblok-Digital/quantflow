import React from "react";

interface EnvironmentBarProps {
  liveMode: "paper" | "live";
  isLiveArmed: boolean;
  exchangeId?: string;
  testnet?: boolean;
  equity?: number;
}

/**
 * Zone 1 — Environment bar (top, sticky). Single source of truth untuk
 * status paper/live. Tiga state: paper (zinc), live+armed (merah), live
 * belum armed (amber). Menampilkan exchange/testnet/equity sebagai konteks.
 */
export const EnvironmentBar: React.FC<EnvironmentBarProps> = ({ liveMode, isLiveArmed, exchangeId, testnet, equity }) => {
  const ctxRight = (
    <span className="opacity-80 font-normal">
      {exchangeId ? ` • ${exchangeId.toUpperCase()}${testnet ? " TESTNET" : ""}` : ""}
      {typeof equity === "number" && equity > 0
        ? ` • Equity $${equity.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        : ""}
    </span>
  );

  if (liveMode === "live" && isLiveArmed) {
    return (
      <div className="sticky top-0 z-50 bg-rose-600 text-white border-b border-rose-500">
        <div className="max-w-[1920px] mx-auto px-4 py-1.5 flex items-center gap-2 text-xs font-mono font-bold tracking-wide">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          LIVE — REAL ORDERS {testnet ? "(TESTNET)" : "MAINNET"}
          {ctxRight}
        </div>
      </div>
    );
  }

  if (liveMode === "live" && !isLiveArmed) {
    return (
      <div className="sticky top-0 z-50 bg-amber-500 text-zinc-950 border-b border-amber-400">
        <div className="max-w-[1920px] mx-auto px-4 py-1.5 flex items-center gap-2 text-xs font-mono font-bold tracking-wide">
          <span className="w-2 h-2 rounded-full bg-zinc-950" />
          LIVE MODE — BELUM ARMED, order baru ditolak server
          {ctxRight}
        </div>
      </div>
    );
  }

  return (
    <div className="sticky top-0 z-50 bg-zinc-800/70 text-zinc-400 border-b border-zinc-800/60 backdrop-blur-sm">
      <div className="max-w-[1920px] mx-auto px-4 py-1.5 flex items-center gap-2 text-xs font-mono tracking-wide">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        Paper Trading — no real funds at risk
        {ctxRight}
      </div>
    </div>
  );
};