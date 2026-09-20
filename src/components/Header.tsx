import React, { useState, useRef, useEffect } from "react";
import { Crosshair, MoreVertical, Layers, FileText, Lock, PlugZap, LogOut, Info, LayoutDashboard, BarChart3, Radar, History, Search } from "lucide-react";
import { ModuleTab, MODULE_TABS, MODULE_TAB_LABELS, ExchangeFeedStatus } from "../types";
import { useBrokerPositions } from "../hooks/useBrokerPositions";

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
    { key: "arch", label: "Architecture", icon: Layers, onClick: onOpenArchitecture, group: "System" },
    { key: "audit", label: "Audit Ledger", icon: FileText, onClick: onOpenAuditLedger, group: "System" },
    { key: "broker", label: "Broker Config", icon: PlugZap, onClick: onOpenBroker, group: "Configuration" },
    { key: "vault", label: "Key Vault", icon: Lock, onClick: onOpenKeyVault, group: "Configuration" },
  ];
  const groups = ["System", "Configuration"] as const;

  const TAB_ICONS: Record<ModuleTab, React.ReactNode> = {
    dashboard: <LayoutDashboard className="h-3.5 w-3.5" />,
    analytics: <BarChart3 className="h-3.5 w-3.5" />,
    pump: <Radar className="h-3.5 w-3.5" />,
    replay: <History className="h-3.5 w-3.5" />,
    scout: <Search className="h-3.5 w-3.5" />,
  };

  // Akun server (shared hook, dedup polling global 15s — tidak menambah request).
  const { account } = useBrokerPositions();
  const equity = account?.equity ?? liveEquity;
  const cash = account?.cash;
  const unrealizedPnl = account?.unrealizedPnl ?? floatingPnl;
  const marginLocked = account?.marginLocked;
  const realizedPnl = account?.realizedPnl;
  const posCount = Math.max(account?.openCount ?? 0, openPositionsCount ?? 0);
  const fmt = (v?: number) => (v === undefined ? "—" : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const signedFmt = (v: number | undefined) => (v === undefined ? "—" : `${v >= 0 ? "+" : "-"}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  return (
    <header className="bg-zinc-900 border-b border-zinc-800 sticky top-0 z-30">
      <div className="px-4 py-2">
        <div className="max-w-[1920px] mx-auto flex items-center gap-4">
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
              <Crosshair className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-sm font-bold text-zinc-100 tracking-tight">NEURAL-SWING</span>
            <div className="relative" ref={infoRef}>
              <button type="button" onClick={() => setInfoOpen((v) => !v)} className="p-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition" title="System info">
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
          <nav className="flex items-center gap-0.5 overflow-x-auto flex-1 min-w-0 py-0.5">
            {MODULE_TABS.map((tab) => (
              <button type="button"
                key={tab}
                onClick={() => onSelectTab?.(tab)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-mono font-semibold transition-all whitespace-nowrap ${
                  activeTab === tab
                    ? "bg-amber-500/10 text-amber-300 border border-amber-500/30 shadow-[0_0_12px_-4px_rgba(245,158,11,0.5)]"
                    : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 border border-transparent"
                }`}
              >
                {TAB_ICONS[tab]}
                {MODULE_TAB_LABELS[tab]}
              </button>
            ))}
          </nav>
          <div className="w-px h-5 bg-zinc-700/50 shrink-0" />
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-3 shrink-0 overflow-x-auto">
              <div className="text-right shrink-0">
                <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">BTC</div>
                <div className="flex items-baseline gap-1 justify-end">
                  <span className="text-xs font-mono font-bold text-zinc-100">${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  <span className={`text-[10px] font-mono font-medium ${priceDelta >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{priceDelta >= 0 ? "+" : ""}{priceDelta.toFixed(2)}%</span>
                </div>
              </div>
              <div className="h-5 w-px bg-zinc-800 shrink-0" />
              {[
                { label: "Equity", value: fmt(equity), cls: "text-zinc-100", show: equity !== undefined },
                { label: "Cash", value: fmt(cash), cls: "text-zinc-100", show: cash !== undefined },
                { label: "uPnL", value: signedFmt(unrealizedPnl), cls: (unrealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400", show: unrealizedPnl !== undefined },
                { label: "Margin", value: fmt(marginLocked), cls: "text-amber-400", show: marginLocked !== undefined },
                { label: "Realized", value: signedFmt(realizedPnl), cls: (realizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400", show: realizedPnl !== undefined },
              ].map((m) =>
                m.show ? (
                  <div key={m.label} className="text-right shrink-0">
                    <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">{m.label}</div>
                    <div className={`text-xs font-mono font-bold ${m.cls}`}>{m.value}</div>
                  </div>
                ) : null
              )}
              <div className="h-5 w-px bg-zinc-800 shrink-0" />
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-zinc-700 bg-zinc-800/60 shrink-0" title="Open positions">
                <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-wider">Pos</span>
                <span className={`text-xs font-mono font-bold ${posCount > 0 ? "text-amber-300" : "text-zinc-500"}`}>{posCount}</span>
              </div>
            </div>
            <div className="relative" ref={menuRef}>
              <button type="button" onClick={() => setMenuOpen((v) => !v)} className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700 transition" title="Menu">
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 mt-2 w-52 rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl shadow-black/40 p-1 z-40">
                  {groups.map((g, gi) => (
                    <div key={g}>
                      {gi > 0 && <div className="h-px bg-zinc-800 my-1 mx-1" />}
                      <div className="px-2.5 pt-1.5 pb-0.5 text-[9px] font-mono text-zinc-500 uppercase tracking-widest">{g}</div>
                      {modalItems.filter((i) => i.group === g).map((item) => (
                        <button type="button" key={item.key} onClick={() => { item.onClick?.(); setMenuOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-2 text-xs text-zinc-300 hover:bg-zinc-800 rounded-lg text-left transition">
                          <item.icon className="h-3.5 w-3.5 text-zinc-500" /><span>{item.label}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {onLogout && (
                    <button type="button" onClick={() => { onLogout(); setMenuOpen(false); }} className="w-full flex items-center gap-2 px-2.5 py-2 text-xs text-rose-300 hover:bg-rose-500/10 rounded-lg text-left transition border-t border-zinc-800 mt-1">
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