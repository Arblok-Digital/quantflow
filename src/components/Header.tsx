import React, { useState, useRef, useEffect } from "react";
import { Crosshair, MoreVertical, Layers, FileText, Lock, PlugZap, LogOut, Info } from "lucide-react";
import { ModuleTab, MODULE_TABS, MODULE_TAB_LABELS, ExchangeFeedStatus } from "../types";

interface HeaderProps {
  geminiActive: boolean;
  currentPrice: number;
  priceDelta: number;
  exchangeStatus?: ExchangeFeedStatus;
  activeTab?: ModuleTab;
  onSelectTab?: (tab: ModuleTab) => void;
  openPositionsCount?: number;
  floatingPnl?: number;
  liveEquity?: number;
  onOpenArchitecture?: () => void;
  onOpenAuditLedger?: () => void;
  onOpenKeyVault?: () => void;
  onOpenBroker?: () => void;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  geminiActive,
  currentPrice,
  priceDelta,
  exchangeStatus,
  activeTab = "dashboard",
  onSelectTab,
  openPositionsCount = 0,
  floatingPnl = 0,
  liveEquity,
  onOpenArchitecture,
  onOpenAuditLedger,
  onOpenKeyVault,
  onOpenBroker,
  onLogout,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!infoOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) setInfoOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [infoOpen]);

  const src = exchangeStatus?.source || "SIMULATED";
  const isLiveFeed = src === "BINANCE_LIVE";

  const modalItems = [
    { key: "arch", label: "Architecture", icon: Layers, onClick: onOpenArchitecture },
    { key: "audit", label: "Audit Ledger", icon: FileText, onClick: onOpenAuditLedger },
    { key: "broker", label: "Broker Config", icon: PlugZap, onClick: onOpenBroker },
    { key: "vault", label: "Key Vault", icon: Lock, onClick: onOpenKeyVault },
  ];

  return (
    <header className="bg-zinc-900 border-b border-zinc-800 sticky top-0 z-30">
      <div className="px-4 py-2">
        <div className="max-w-7xl mx-auto flex items-center gap-4">
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <Crosshair className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-sm font-bold text-zinc-100 tracking-tight">NEURAL-SWING</span>
            <div className="relative" ref={infoRef}>
              <button onClick={() => setInfoOpen((v) => !v)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition" title="System info">
                <Info className="w-3.5 h-3.5" />
              </button>
              {infoOpen && (
                <div className="absolute left-0 mt-2 w-56 rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40 p-3 z-40">
                  <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider mb-2">System Info</div>
                  <div className="space-y-1.5 text-xs font-mono">
                    <div className="flex justify-between"><span className="text-zinc-500">Version</span><span className="text-zinc-300">v4.6-QUANT</span></div>
                    <div className="flex justify-between"><span className="text-zinc-500">AI Model</span><span className={geminiActive ? "text-amber-400" : "text-zinc-500"}>{geminiActive ? "Gemini 3.8" : "Offline"}</span></div>
                    <div className="flex justify-between"><span className="text-zinc-500">Feed</span><span className={isLiveFeed ? "text-emerald-400" : "text-zinc-400"}>{src.replace("_", " ")}</span></div>
                    {exchangeStatus?.latencyMs !== undefined && <div className="flex justify-between"><span className="text-zinc-500">Latency</span><span className="text-zinc-300">{exchangeStatus.latencyMs}ms</span></div>}
                    {exchangeStatus?.tickCount !== undefined && exchangeStatus.tickCount > 0 && <div className="flex justify-between"><span className="text-zinc-500">Ticks</span><span className="text-zinc-300">{exchangeStatus.tickCount}</span></div>}
                  </div>
                </div>
              )}
            </div>
            <div className={`w-2 h-2 rounded-full ${isLiveFeed ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} title={isLiveFeed ? "Live feed connected" : "Synthetic feed"} />
          </div>
          <div className="w-px h-5 bg-zinc-700/50 shrink-0" />
          <div className="w-px h-5 bg-zinc-700/50 shrink-0" />
          <nav className="flex items-center gap-0.5 overflow-x-auto flex-1 min-w-0">
            {MODULE_TABS.map((tab) => (
              <button key={tab} onClick={() => onSelectTab?.(tab)} className={`px-3 py-1 rounded-md text-xs font-mono font-medium transition-all whitespace-nowrap ${activeTab === tab ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"}`}>
                {MODULE_TAB_LABELS[tab]}
              </button>
            ))}
          </nav>
          <div className="w-px h-5 bg-zinc-700/50 shrink-0" />
          <div className="flex items-center gap-3 shrink-0">
            <div className="text-right">
              <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Equity</div>
              <div className="text-xs font-mono font-bold text-zinc-100">${liveEquity?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">BTC</div>
              <div className="flex items-baseline gap-1 justify-end">
                <span className="text-xs font-mono font-bold text-zinc-100">${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <span className={`text-[10px] font-mono font-medium ${priceDelta >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{priceDelta >= 0 ? "+" : ""}{priceDelta.toFixed(2)}%</span>
              </div>
            </div>
            {openPositionsCount > 0 && (
              <>
                <div className="text-right">
                  <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">P&L</div>
                  <div className={`text-xs font-mono font-bold ${floatingPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{floatingPnl >= 0 ? "+" : ""}${floatingPnl.toFixed(2)}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Pos</div>
                  <div className="text-xs font-mono font-bold text-zinc-300">{openPositionsCount}</div>
                </div>
              </>
            )}
            <div className="relative" ref={menuRef}>
              <button onClick={() => setMenuOpen((v) => !v)} className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700 transition" title="Menu">
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40 p-1 z-40">
                  {modalItems.map((item) => (
                    <button key={item.key} onClick={() => { item.onClick?.(); setMenuOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-2 text-xs text-zinc-300 hover:bg-zinc-800 rounded-lg text-left transition">
                      <item.icon className="h-3.5 w-3.5 text-zinc-500" /><span>{item.label}</span>
                    </button>
                  ))}
                  {onLogout && (
                    <button onClick={() => { onLogout(); setMenuOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-2 text-xs text-rose-300 hover:bg-rose-500/10 rounded-lg text-left transition border-t border-zinc-800 mt-1">
                      <LogOut className="h-3.5 w-3.5" /><span>Logout</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};