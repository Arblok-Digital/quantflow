import React, { useState, useRef, useEffect } from "react";
import { Crosshair, RefreshCw, MoreVertical, Layers, FileText, Lock, PlugZap, LogOut } from "lucide-react";
import { ModuleTab, MODULE_TABS, MODULE_TAB_LABELS, ExchangeFeedStatus } from "../types";

interface HeaderProps {
  geminiActive: boolean;
  currentPrice: number;
  priceDelta: number;
  exchangeStatus?: ExchangeFeedStatus;
  onSyncLiveExchange?: () => void;
  isSyncingFeed?: boolean;
  activeTab?: ModuleTab;
  onSelectTab?: (tab: ModuleTab) => void;
  openPositionsCount?: number;
  floatingPnl?: number;
  tickCount?: number;
  isLiveArmed?: boolean;
  liveMode?: "paper" | "live";
  liveEquity?: number;
  onOpenArchitecture?: () => void;
  onOpenAuditLedger?: () => void;
  onOpenKeyVault?: () => void;
  onOpenBroker?: () => void;
  onLogout?: () => void;
}

const TAB_ACCENT: Record<ModuleTab, string> = {
  dashboard: "bg-amber-500/20 text-amber-300 border border-amber-500/40",
  paper: "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
  analytics: "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40",
  feed: "bg-purple-500/20 text-purple-300 border border-purple-500/40",
  advisor: "bg-teal-500/20 text-teal-300 border border-teal-500/40",
};

export const Header: React.FC<HeaderProps> = ({
  geminiActive,
  currentPrice,
  priceDelta,
  exchangeStatus,
  onSyncLiveExchange,
  isSyncingFeed,
  activeTab = "dashboard",
  onSelectTab,
  openPositionsCount = 0,
  floatingPnl = 0,
  tickCount = 0,
  isLiveArmed = false,
  liveMode = "paper",
  liveEquity,
  onOpenArchitecture,
  onOpenAuditLedger,
  onOpenKeyVault,
  onOpenBroker,
  onLogout,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const getSourceBadge = () => {
    const src = exchangeStatus?.source || "SIMULATED";
    if (src === "BINANCE_LIVE") {
      return {
        label: "BINANCE LIVE",
        className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        dot: "bg-emerald-400 animate-pulse",
      };
    }
    if (src === "BYBIT_FALLBACK") {
      return {
        label: "BYBIT FALLBACK",
        className: "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
        dot: "bg-cyan-400",
      };
    }
    if (src === "KRAKEN_FALLBACK") {
      return {
        label: "KRAKEN FALLBACK",
        className: "bg-purple-500/15 text-purple-400 border-purple-500/30",
        dot: "bg-purple-400",
      };
    }
    return {
      label: "SYNTHETIC FEED",
      className: "bg-slate-800 text-slate-400 border-slate-700",
      dot: "bg-slate-500",
    };
  };

  const badge = getSourceBadge();

  const modalItems = [
    { key: "arch", label: "Modular", icon: Layers, onClick: onOpenArchitecture, cls: "text-amber-400" },
    { key: "audit", label: "Audit", icon: FileText, onClick: onOpenAuditLedger, cls: "text-sky-400" },
    { key: "broker", label: "Broker", icon: PlugZap, onClick: onOpenBroker, cls: "text-cyan-400" },
    { key: "vault", label: "Vault", icon: Lock, onClick: onOpenKeyVault, cls: "text-emerald-400" },
  ].filter((i) => i.onClick);

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md px-4 py-2.5 sm:px-6 sticky top-0 z-30">
      <div className="max-w-7xl mx-auto flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        {/* LEFT: Brand + Exchange status + tabs */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Brand */}
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-amber-500 rounded-xl flex items-center justify-center shadow-lg shadow-amber-500/20 shrink-0">
              <Crosshair className="w-5 h-5 text-zinc-950 stroke-[2.5]" />
            </div>
            <div className="leading-tight">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base sm:text-lg font-bold tracking-tight text-zinc-100 font-sans">NEURAL-SWING</h1>
                <span className="text-zinc-500 font-mono text-[10px]">v4.6-QUANT</span>
                <span className="px-1.5 py-0.5 bg-amber-500/10 text-amber-400 text-[9px] font-mono font-bold rounded border border-amber-500/20 uppercase">
                  {geminiActive ? "GEMINI 3.8" : "MTF HUNTER"}
                </span>
              </div>
            </div>
          </div>

          {/* Exchange Feed Status */}
          <div
            className={`flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono font-semibold border ${badge.className}`}
            title={`Endpoint: ${exchangeStatus?.activeEndpoint || "auto"} | Ping: ${exchangeStatus?.latencyMs || 0}ms`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
            <span>{badge.label}</span>
            {exchangeStatus?.latencyMs !== undefined && (
              <span className="text-[9px] opacity-70">({exchangeStatus.latencyMs}ms)</span>
            )}
          </div>

          {onSyncLiveExchange && (
            <button
              onClick={onSyncLiveExchange}
              disabled={isSyncingFeed}
              className="p-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
              title="Sinkronisasi Ulang Real Market Data (Binance & Bybit)"
            >
              <RefreshCw className={`w-3 h-3 ${isSyncingFeed ? "animate-spin text-amber-400" : ""}`} />
            </button>
          )}

          {/* Slim 4-tab navigation */}
          {onSelectTab && (
            <div className="flex bg-zinc-900/90 border border-zinc-800 rounded-xl p-1 shadow-sm font-mono text-xs gap-0.5">
              {MODULE_TABS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => onSelectTab(tab)}
                  className={`px-2.5 py-1 rounded-lg transition-all font-semibold ${
                    activeTab === tab ? TAB_ACCENT[tab] : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {MODULE_TAB_LABELS[tab]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT: Price badges + modal menu + live badge + logout */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {/* Price */}
          <div className="flex items-center gap-1.5 font-mono">
            <span className="text-sm font-semibold text-zinc-100">
              ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className={`text-xs font-bold ${priceDelta >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {priceDelta >= 0 ? "+" : ""}
              {priceDelta.toFixed(2)}%
            </span>
          </div>

          {/* Status badges: open positions / ticks */}
          {openPositionsCount > 0 && (
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                floatingPnl >= 0 ? "bg-emerald-500/30 text-emerald-300" : "bg-rose-500/30 text-rose-300"
              }`}
              title="Open paper positions & floating PnL"
            >
              {openPositionsCount} ({floatingPnl >= 0 ? "+" : ""}${floatingPnl.toFixed(0)})
            </span>
          )}
          {tickCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-cyan-500/20 text-cyan-300" title="Micro ticks">
              {tickCount} ticks
            </span>
          )}

          {/* LIVE / PAPER badge */}
          <div className="flex items-center gap-1.5">
            {isLiveArmed ? (
              <span className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-mono font-black text-[11px] border border-rose-500 shadow shadow-rose-600/20 animate-pulse">
                LIVE ARMED
              </span>
            ) : (
              <span className="px-2.5 py-1 rounded-lg bg-zinc-800 text-zinc-400 font-mono font-bold text-[11px] border border-zinc-700">PAPER</span>
            )}
            {liveEquity !== undefined && (
              <span className="hidden sm:inline-flex px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-zinc-300">
                {liveMode === "live" ? "LIVE" : "PAPER"} ${liveEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            )}
          </div>

          {/* Modal dropdown menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition"
              title="Menu"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 mt-2 w-44 rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40 p-1 z-40">
                {modalItems.map((item) => (
                  <button
                    key={item.key}
                    onClick={() => {
                      item.onClick?.();
                      setMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-2 text-xs text-zinc-300 hover:bg-zinc-800 rounded-lg text-left transition"
                  >
                    <item.icon className={`h-3.5 w-3.5 ${item.cls}`} />
                    <span>{item.label}</span>
                  </button>
                ))}
                {onLogout && (
                  <button
                    onClick={() => {
                      onLogout();
                      setMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-2.5 py-2 text-xs text-rose-300 hover:bg-rose-500/10 rounded-lg text-left transition border-t border-zinc-800 mt-1"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    <span>Logout</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
