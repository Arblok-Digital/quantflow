import React from "react";
import { 
  Play, 
  Square, 
  Zap, 
  ShieldAlert, 
  Layers, 
  FileText, 
  Lock, 
  PlugZap, 
  Crosshair,
  TrendingUp,
  Radio,
  Boxes,
  Calendar,
  RefreshCw,
  DollarSign,
  Cpu
} from "lucide-react";
import { MarketType, Timeframe, ExchangeFeedStatus } from "../types";

interface HeaderProps {
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
  onOpenArchitecture: () => void;
  onOpenAuditLedger: () => void;
  onOpenKeyVault: () => void;
  onOpenBroker: () => void;
  isAnalyzing: boolean;
  geminiActive: boolean;
  currentPrice: number;
  priceDelta: number;
  exchangeStatus?: ExchangeFeedStatus;
  onSyncLiveExchange?: () => void;
  isSyncingFeed?: boolean;
  activeTab?: "overview" | "paper" | "stream1s" | "onchain" | "macro";
  onSelectTab?: (tab: "overview" | "paper" | "stream1s" | "onchain" | "macro") => void;
  openPositionsCount?: number;
  floatingPnl?: number;
  tickCount?: number;
  isLiveArmed?: boolean;
  liveMode?: "paper" | "live";
  liveEquity?: number;
  onLogout?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
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
  onOpenArchitecture,
  onOpenAuditLedger,
  onOpenKeyVault,
  onOpenBroker,
  isAnalyzing,
  geminiActive,
  currentPrice,
  priceDelta,
  exchangeStatus,
  onSyncLiveExchange,
  isSyncingFeed,
  activeTab = "overview",
  onSelectTab,
  openPositionsCount = 0,
  floatingPnl = 0,
  tickCount = 0,
  isLiveArmed = false,
  liveMode = "paper",
  liveEquity,
  onLogout,
}) => {
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

  return (
    <header className="border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md px-4 py-3 sm:px-6 sticky top-0 z-30">
      <div className="max-w-7xl mx-auto flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Left: Bento Brand & Exchange Feed Indicator */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-500 rounded-xl flex items-center justify-center shadow-lg shadow-amber-500/20 shrink-0">
            <Crosshair className="w-5 h-5 text-zinc-950 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight text-zinc-100 font-sans">
                NEURAL-SWING
              </h1>
              <span className="text-zinc-500 font-mono text-xs">v4.6-QUANT</span>
              <span className="px-2 py-0.5 bg-amber-500/10 text-amber-400 text-[10px] font-mono font-bold rounded border border-amber-500/20 uppercase">
                {geminiActive ? "GEMINI 3.8 FLASH" : "MTF HUNTER ALGO"}
              </span>

              {/* Real Exchange Feed Status */}
              <div 
                className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-semibold border ${badge.className}`}
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
            </div>
            <p className="text-xs text-zinc-500 uppercase tracking-widest flex items-center gap-2 mt-0.5">
              <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse"></span>
              MTF Liquidation Hunt &bull; On-Chain Whale Radar &bull; Macro Calendar
            </p>
          </div>
        </div>

        {/* Center: Module View Tabs + Market Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Module Navigation Tabs */}
          {onSelectTab && (
            <div className="flex flex-wrap bg-zinc-900/90 border border-zinc-800 rounded-xl p-1 shadow-sm font-mono text-xs gap-0.5">
              <button
                onClick={() => onSelectTab("overview")}
                className={`px-2.5 py-1 rounded-lg transition-all font-semibold flex items-center gap-1.5 ${
                  activeTab === "overview"
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Radio className="w-3 h-3" />
                <span>Overview & MTF</span>
              </button>

              <button
                onClick={() => onSelectTab("paper")}
                className={`px-2.5 py-1 rounded-lg transition-all font-semibold flex items-center gap-1.5 ${
                  activeTab === "paper"
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <DollarSign className="w-3 h-3 text-amber-400" />
                <span>Paper / Simulasi</span>
                {openPositionsCount > 0 && (
                  <span
                    className={`ml-0.5 px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                      floatingPnl >= 0 ? "bg-emerald-500/30 text-emerald-300" : "bg-rose-500/30 text-rose-300"
                    }`}
                  >
                    {openPositionsCount} ({floatingPnl >= 0 ? "+" : ""}${floatingPnl.toFixed(0)})
                  </span>
                )}
              </button>

              <button
                onClick={() => onSelectTab("stream1s")}
                className={`px-2.5 py-1 rounded-lg transition-all font-semibold flex items-center gap-1.5 ${
                  activeTab === "stream1s"
                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                <span>1s Feed (ML)</span>
              </button>

              <button
                onClick={() => onSelectTab("onchain")}
                className={`px-2.5 py-1 rounded-lg transition-all font-semibold flex items-center gap-1.5 ${
                  activeTab === "onchain"
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Boxes className="w-3 h-3 text-emerald-400" />
                <span>On-Chain</span>
              </button>

              <button
                onClick={() => onSelectTab("macro")}
                className={`px-2.5 py-1 rounded-lg transition-all font-semibold flex items-center gap-1.5 ${
                  activeTab === "macro"
                    ? "bg-blue-500/20 text-blue-300 border border-blue-500/40"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Calendar className="w-3 h-3 text-blue-400" />
                <span>Macro</span>
              </button>
            </div>
          )}

          {/* Market Type Selector */}
          <div className="flex bg-zinc-900 border border-zinc-800 rounded-xl p-1 shadow-sm font-mono text-xs">
            <button
              onClick={() => {
                onSelectMarketType("FUTURES");
                onSelectTimeframe("15m");
              }}
              className={`px-2.5 py-1 rounded-lg transition-all font-bold flex items-center gap-1.5 ${
                marketType === "FUTURES"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Zap className="w-3 h-3" />
              <span>FUTURES (15m)</span>
            </button>
            <button
              onClick={() => {
                onSelectMarketType("SPOT");
                onSelectTimeframe("4h");
              }}
              className={`px-2.5 py-1 rounded-lg transition-all font-bold flex items-center gap-1.5 ${
                marketType === "SPOT"
                  ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <TrendingUp className="w-3 h-3" />
              <span>SPOT (4h)</span>
            </button>
          </div>

          {/* Timeframe quick select */}
          <div className="flex bg-zinc-900 border border-zinc-800 rounded-xl p-1 shadow-sm font-mono text-xs overflow-x-auto max-w-[320px] sm:max-w-none">
            {(["1s", "1m", "5m", "15m", "1h", "4h", "1D", "1W"] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => onSelectTimeframe(tf)}
                className={`px-2 py-1 rounded-lg transition-all font-semibold whitespace-nowrap flex items-center gap-1 ${
                  timeframe === tf
                    ? "bg-amber-500/20 text-amber-300 font-bold border border-amber-500/50 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tf === "1s" && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />}
                <span>{tf}</span>
              </button>
            ))}
          </div>

          {/* Pair Selector & Price */}
          <div className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-1.5 shadow-sm">
            <div className="flex gap-1">
              {["BTC/USDT", "ETH/USDT", "SOL/USDT"].map((pair) => (
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

            <div className="h-4 w-px bg-zinc-800" />

            <div className="flex items-baseline gap-1.5 font-mono">
              <span className="text-sm font-semibold text-zinc-100">
                ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className={`text-xs font-bold ${priceDelta >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {priceDelta >= 0 ? "+" : ""}{priceDelta.toFixed(2)}%
              </span>
            </div>
          </div>
        </div>

        {/* Right: Modal triggers & Execution Actions */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          {/* Modal triggers */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={onOpenArchitecture}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white border border-zinc-800 transition-colors"
              title="Lihat Penjelasan Modular Arsitektur & MTF Liquidation Hunt"
            >
              <Layers className="h-3.5 w-3.5 text-amber-400" />
              <span className="hidden sm:inline">Modular</span>
            </button>

            <button
              onClick={onOpenAuditLedger}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white border border-zinc-800 transition-colors"
              title="Buka Cryptographic Audit Trail & Verifikasi Hash"
            >
              <FileText className="h-3.5 w-3.5 text-sky-400" />
              <span className="hidden sm:inline">Audit</span>
            </button>

            <button
              onClick={onOpenBroker}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white border border-zinc-800 transition-colors"
              title="Broker Connection - Colok API key exchange, tes koneksi & live-readiness"
            >
              <PlugZap className="h-3.5 w-3.5 text-cyan-400" />
              <span className="hidden md:inline">Broker</span>
            </button>

            <button
              onClick={onOpenKeyVault}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white border border-zinc-800 transition-colors"
              title="Enkripsi End-to-End & Manajemen API Key"
            >
              <Lock className="h-3.5 w-3.5 text-emerald-400" />
              <span className="hidden md:inline">Vault</span>
            </button>
          </div>

          {/* Trigger AI Manual */}
          <button
            onClick={onTriggerManualCycle}
            disabled={isAnalyzing || isEmergencyStop}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-medium transition-all ${
              isAnalyzing
                ? "bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700"
                : "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30"
            }`}
          >
            <Zap className={`h-3.5 w-3.5 ${isAnalyzing ? "animate-spin text-amber-400" : ""}`} />
            <span>{isAnalyzing ? "SCANNING..." : "SCAN AGENT"}</span>
          </button>

          {/* Auto Pilot Toggle */}
          <button
            onClick={onToggleAutoPilot}
            disabled={isEmergencyStop}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-mono font-bold transition-all ${
              isEmergencyStop
                ? "bg-zinc-800 text-zinc-600 cursor-not-allowed border border-zinc-700"
                : isAutoPilot
                ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20"
                : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800 border border-zinc-800"
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

          {/* LIVE / PAPER mode badge + equity, non-dismissable */}
          <div className="flex items-center gap-1.5">
            {isLiveArmed ? (
              <span className="px-2.5 py-1 rounded-lg bg-rose-600 text-white font-mono font-black text-[11px] border border-rose-500 shadow shadow-rose-600/20 animate-pulse">
                LIVE ARMED
              </span>
            ) : (
              <span className="px-2.5 py-1 rounded-lg bg-zinc-800 text-zinc-400 font-mono font-bold text-[11px] border border-zinc-700">PAPER</span>
            )}
            {liveEquity !== undefined && (
              <span className="hidden sm:inline-flex px-2 py-1 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-zinc-300" title={liveMode === "live" ? "Live balance equity (real)" : "Paper equity"}>
                {liveMode === "live" ? "LIVE" : "PAPER"} ${liveEquity.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            )}
          </div>

          {onLogout && (
            <button
              onClick={onLogout}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 text-xs font-mono transition"
              title="Logout — hapus token & kembali ke unlock screen"
            >
              <Lock className="h-3.5 w-3.5" />
              <span>Logout</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
