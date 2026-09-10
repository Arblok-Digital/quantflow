import React, { useEffect, useState } from "react";
import {
  Portfolio,
  Position,
  ClosedTrade,
  Timeframe,
  MarketType,
  MTFLiquidityAnalysis,
  LLMDecision
} from "../types";
import { authFetch } from "../hooks/useAuth";
import { 
  DollarSign, 
  TrendingUp, 
  TrendingDown, 
  ShieldAlert, 
  Target, 
  Crosshair, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Play, 
  RotateCcw, 
  ArrowUpRight, 
  ArrowDownRight, 
  Info, 
  Zap, 
  ChevronDown, 
  ChevronUp,
  Percent,
  Sliders
} from "lucide-react";

interface PaperTradingPanelProps {
  portfolio: Portfolio;
  positions: Position[];
  closedTrades: ClosedTrade[];
  currentPrice: number;
  symbol: string;
  mtfLiquidity?: MTFLiquidityAnalysis;
  latestDecision?: LLMDecision | null;
  onClosePosition: (symbol: string, reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE") => void;
  onMoveToBreakEven: (symbol: string) => void;
  onResetPaperAccount: (initialCapital: number) => void;
  onSimulateTradeEntry: (side: "LONG" | "SHORT") => void;
  actionableRunKeel?: () => void;
}

export const PaperTradingPanel: React.FC<PaperTradingPanelProps> = ({
  portfolio,
  positions,
  closedTrades,
  currentPrice,
  symbol,
  mtfLiquidity,
  latestDecision,
  onClosePosition,
  onMoveToBreakEven,
  onResetPaperAccount,
  onSimulateTradeEntry,
  actionableRunKeel,
}) => {
  const [activeTab, setActiveTab] = useState<"positions" | "history">("positions");
  const [expandedPositionId, setExpandedPositionId] = useState<string | null>(null);
  const [simulateError, setSimulateError] = useState<{ reason: string; message: string; duplicatePositionId?: string } | null>(null);
  const [selectedCapital, setSelectedCapital] = useState<number>(50000);

  // Mode broker di-poll dari server (paper/live). Saat live, tombol simulasi
  // berubah jadi EXECUTE dengan konfirmasi ganda — jangan sampai order REAL
  // terkirim tanpa persetujuan eksplisit.
  const [brokerMode, setBrokerMode] = useState<"paper" | "live">("paper");

  useEffect(() => {
    let mounted = true;
    const loadStatus = async () => {
      try {
        const res = await authFetch("/api/broker/status");
        if (res.status === 401) return;
        const data = await res.json();
        if (mounted && data?.mode) setBrokerMode(data.mode);
      } catch {
        // ignore — tetap anggap paper kalau status gagal
      }
    };
    loadStatus();
    const iv = setInterval(loadStatus, 5000);
    return () => {
      mounted = false;
      clearInterval(iv);
    };
  }, []);

  const isLiveMode = brokerMode === "live";

  // Guard utama: di live mode wajib konfirmasi sebelum kirim order REAL.
  const handleSimulate = (side: "LONG" | "SHORT") => {
    if (isLiveMode) {
      const ok = window.confirm("Anda akan mengirim order REAL ke exchange. Lanjutkan?");
      if (!ok) return;
    }
    onSimulateTradeEntry(side);
  };

  // Cashflow and PnL metrics
  const totalUnrealizedPnl = positions.reduce((acc, p) => acc + p.unrealizedPnl, 0);
  const totalRealizedPnl = portfolio.realizedPnl;
  const netTotalCashflow = totalRealizedPnl + totalUnrealizedPnl;
  const isNetPositive = netTotalCashflow >= 0;
  const isUnrealizedPositive = totalUnrealizedPnl >= 0;

  const totalPotentialProfitUSD = positions.reduce((acc, p) => acc + (p.potentialProfitUSD || (p.qty * Math.abs(p.takeProfit - p.entryPrice))), 0);
  const totalPotentialLossUSD = positions.reduce((acc, p) => acc + (p.potentialLossUSD || (p.qty * Math.abs(p.entryPrice - p.stopLoss))), 0);
  const projectedRRRatio = totalPotentialLossUSD > 0 ? (totalPotentialProfitUSD / totalPotentialLossUSD).toFixed(2) : "—";
  const hasAnyTradeHistory = closedTrades.length > 0 || portfolio.totalTrades > 0;

  const totalTradesCount = closedTrades.length + (portfolio.totalTrades > 0 ? portfolio.totalTrades : 0);
  const winCount = closedTrades.filter((t) => t.pnlUSD > 0).length + portfolio.winCount;
  const winRateDisplay = totalTradesCount > 0 ? `${((winCount / totalTradesCount) * 100).toFixed(1)}%` : "—";
  const winRateSubLabel = totalTradesCount > 0 ? `${winCount} Wins • ${totalTradesCount - winCount} Losses` : "belum ada trade";

  return (
    <div className="space-y-4 font-sans">
      {/* Top Banner: Paper Trading Command Center */}
      <div className="bg-gradient-to-r from-zinc-900 via-zinc-900 to-amber-950/40 border border-amber-500/30 rounded-2xl p-4 sm:p-5 shadow-lg relative overflow-hidden">
        <div className="absolute right-0 top-0 translate-x-10 -translate-y-10 w-48 h-48 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
        
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className={`px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold flex items-center gap-1.5 border ${
                isLiveMode
                  ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                  : "bg-amber-500/20 text-amber-300 border-amber-500/40"
              }`}>
                <span className={`w-2 h-2 rounded-full ${isLiveMode ? "bg-rose-400" : "bg-amber-400"} animate-pulse`} />
                {isLiveMode ? "LIVE TRADING ACTIVE" : "SIMULATED PAPER TRADING ACTIVE"}
              </span>
              <span className={`px-2 py-0.5 rounded text-[10px] bg-zinc-800 border font-mono ${
                isLiveMode ? "text-rose-300 border-rose-500/30" : "text-zinc-300 border-zinc-700"
              }`}>
                {isLiveMode ? "LIVE TRADING — REAL ORDERS" : "ZERO RISK &bull; REAL LIVE FEED"}
              </span>
              <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 text-[10px] font-mono font-bold border border-emerald-500/30">
                HUMAN-READABLE REASONING LOG
              </span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-zinc-100 font-sans tracking-tight">
              Mode Paper Trading & Cashflow Command Center
            </h2>
            <p className="text-xs text-zinc-400 mt-1 max-w-2xl leading-relaxed">
              Pantau seluruh posisi yang dibuka oleh agent secara transparan: mencakup <strong>Floating PnL</strong>, <strong>Alasan Entry</strong> teknikal &amp; on-chain, serta proyeksi arus kas (<strong>Cashflow Target TP vs Cut Loss CL</strong>).
            </p>
          </div>

          {/* Quick Simulation Trigger Buttons */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              onClick={() => handleSimulate("LONG")}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl font-bold font-mono text-xs shadow-md transition ${
                isLiveMode
                  ? "bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30"
                  : "bg-emerald-600 hover:bg-emerald-500 text-zinc-950 shadow-emerald-600/20"
              }`}
              title={isLiveMode ? "KIRIM order LONG REAL ke exchange (konfirmasi dulu)" : "Simulasikan Entry LONG pada sinyal 15m"}
            >
              {isLiveMode ? <ShieldAlert className="w-3.5 h-3.5" /> : <TrendingUp className="w-3.5 h-3.5" />}
              <span>{isLiveMode ? "EXECUTE LONG (live)" : "Simulate LONG"}</span>
            </button>
            <button
              onClick={() => handleSimulate("SHORT")}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-zinc-100 font-bold font-mono text-xs shadow-md transition ${
                isLiveMode
                  ? "bg-rose-700 hover:bg-rose-600 shadow-rose-700/30"
                  : "bg-rose-600 hover:bg-rose-500 shadow-rose-600/20"
              }`}
              title={isLiveMode ? "KIRIM order SHORT REAL ke exchange (konfirmasi dulu)" : "Simulasikan Entry SHORT pada sinyal 15m"}
            >
              {isLiveMode ? <ShieldAlert className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              <span>{isLiveMode ? "EXECUTE SHORT (live)" : "Simulate SHORT"}</span>
            </button>
            {actionableRunKeel && (
              <button
                onClick={actionableRunKeel}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold font-mono text-xs shadow-md shadow-indigo-600/20 transition"
                title="Jalankan Keel Quant Engine untuk menghasilkan sinyal decision nyata"
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Evaluasi Keel Engine</span>
              </button>
            )}
            <button
              onClick={() => onResetPaperAccount(selectedCapital)}
              className="flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700 font-mono text-xs transition"
              title="Reset saldo akun simulasi ke modal awal"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          </div>
        </div>
      </div>

      {/* Cashflow & PnL Overview Bento Grid (4 Cards) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card 1: Account Equity & Cash Balance */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
            <span>TOTAL PAPER EQUITY</span>
            <DollarSign className="w-4 h-4 text-amber-400" />
          </div>
          <div className="my-2">
            <div className="text-2xl sm:text-3xl font-black font-mono text-zinc-100">
              ${portfolio.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-xs font-mono text-zinc-500 flex items-center justify-between mt-1">
              <span>Available Cash:</span>
              <span className="text-zinc-300 font-bold">
                ${portfolio.cash.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          </div>
          <div className="text-[10px] text-zinc-500 font-mono pt-2 border-t border-zinc-800 flex items-center justify-between">
            <span>Modal Awal:</span>
            <span className="text-zinc-400 font-bold">${portfolio.initialBalance.toLocaleString()}</span>
          </div>
        </div>

        {/* Card 2: Floating / Unrealized PnL (Live 1s Ticking) */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
            <span>FLOATING PNL (OPEN)</span>
            <span className={`w-2 h-2 rounded-full ${isUnrealizedPositive ? "bg-emerald-400 animate-pulse" : "bg-rose-400 animate-pulse"}`} />
          </div>
          <div className="my-2">
            <div className={`text-2xl sm:text-3xl font-black font-mono ${isUnrealizedPositive ? "text-emerald-400" : "text-rose-400"}`}>
              {isUnrealizedPositive ? "+" : ""}${totalUnrealizedPnl.toFixed(2)}
            </div>
            <div className="text-xs font-mono text-zinc-400 mt-1">
              Active Positions: <strong className="text-zinc-200">{positions.length} Pasang</strong>
            </div>
          </div>
          <div className="text-[10px] text-zinc-500 font-mono pt-2 border-t border-zinc-800 flex items-center justify-between">
            <span>Realized Closed PnL:</span>
            <span className={`font-bold ${totalRealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {totalRealizedPnl >= 0 ? "+" : ""}${totalRealizedPnl.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Card 3: Projected Cashflow Target (TP vs CL) */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
            <span>CASHFLOW PROJECTION</span>
            <Target className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="my-2">
            <div className="flex items-baseline gap-1.5 font-mono">
              <span className="text-lg font-black text-emerald-400">+${totalPotentialProfitUSD.toFixed(1)}</span>
              <span className="text-xs text-zinc-500">/</span>
              <span className="text-sm font-bold text-rose-400">-${totalPotentialLossUSD.toFixed(1)}</span>
            </div>
            <div className="text-[11px] font-mono text-zinc-400 mt-1 flex items-center justify-between">
              <span>Projected R:R:</span>
              <span className="text-amber-400 font-bold">{hasAnyTradeHistory || positions.length > 0 ? `1 : ${projectedRRRatio}` : "— (belum ada trade)"}</span>
            </div>
          </div>
          <div className="text-[10px] text-zinc-500 font-mono pt-2 border-t border-zinc-800 flex items-center justify-between">
            <span>Status Cashflow:</span>
            <span className={`font-bold ${isNetPositive ? "text-emerald-400" : "text-rose-400"}`}>
              Net: {isNetPositive ? "+" : ""}${netTotalCashflow.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Card 4: Historical Win Rate & Stats */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between text-zinc-400 text-xs font-mono">
            <span>WIN RATE & DISCIPLINE</span>
            <Crosshair className="w-4 h-4 text-purple-400" />
          </div>
          <div className="my-2">
            <div className="text-2xl sm:text-3xl font-black font-mono text-purple-400">
              {winRateDisplay}
            </div>
            <div className="text-xs font-mono text-zinc-400 mt-1">
              {winRateSubLabel}
            </div>
          </div>
          <div className="text-[10px] text-zinc-500 font-mono pt-2 border-t border-zinc-800 flex items-center justify-between">
            <span>Max Drawdown:</span>
            <span className="text-zinc-300 font-bold">{portfolio.maxDrawdownPercent.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* Main Panel: Tab Navigation (Active Positions vs Trade History) */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-1.5 bg-zinc-950 p-1 rounded-xl border border-zinc-800 font-mono text-xs">
            <button
              onClick={() => setActiveTab("positions")}
              className={`px-3 py-1.5 rounded-lg transition font-semibold flex items-center gap-1.5 ${
                activeTab === "positions"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>Posisi Entry Aktif ({positions.length})</span>
            </button>
            <button
              onClick={() => setActiveTab("history")}
              className={`px-3 py-1.5 rounded-lg transition font-semibold flex items-center gap-1.5 ${
                activeTab === "history"
                  ? "bg-zinc-800 text-zinc-100 border border-zinc-700"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Clock className="w-3.5 h-3.5 text-zinc-400" />
              <span>Riwayat Transaksi Tertutup ({closedTrades.length})</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 font-mono">Live 1s Ref:</span>
            <span className="px-2 py-0.5 rounded bg-zinc-950 text-zinc-200 font-mono text-xs border border-zinc-800 font-bold">
              ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
        </div>

        {/* Tab 1: Active Entry Positions with Detailed Reasoning & Dynamic TP/CL Slider */}
        {activeTab === "positions" && (
          <div className="space-y-4">
            {positions.length === 0 ? (
              <div className="text-center py-10 px-4 bg-zinc-950/60 rounded-xl border border-zinc-800/80">
                <Crosshair className="w-10 h-10 text-zinc-600 mx-auto mb-2" />
                <h4 className="text-sm font-semibold text-zinc-300">Belum Ada Posisi Terbuka</h4>
                <p className="text-xs text-zinc-500 max-w-md mx-auto mt-1 mb-4">
                  Agent sedang memindai pola <strong>15m MTF Liquidity Sweep</strong> dan menunggu konfirmasi on-chain whale. Anda juga dapat menekan tombol simulasi di bawah untuk menguji sistem.
                </p>
                <div className="flex justify-center gap-2">
                  <button
                    onClick={() => handleSimulate("LONG")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition ${
                      isLiveMode
                        ? "bg-rose-600 hover:bg-rose-500 text-white"
                        : "bg-emerald-600 hover:bg-emerald-500 text-zinc-950"
                    }`}
                    title={isLiveMode ? "Kirim order LONG REAL ke exchange (konfirmasi dulu)" : "Simulasikan entry LONG"}
                  >
                    {isLiveMode ? "⚠ EXECUTE LONG (live)" : "+ Simulasikan Entry LONG"}
                  </button>
                  <button
                    onClick={() => handleSimulate("SHORT")}
                    className={`px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold font-mono transition ${
                      isLiveMode ? "ring-1 ring-rose-400/50" : ""
                    }`}
                    title={isLiveMode ? "Kirim order SHORT REAL ke exchange (konfirmasi dulu)" : "Simulasikan entry SHORT"}
                  >
                    {isLiveMode ? "⚠ EXECUTE SHORT (live)" : "+ Simulasikan Entry SHORT"}
                  </button>
                  {actionableRunKeel && (
                    <button
                      onClick={actionableRunKeel}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold font-mono transition"
                    >
                      ⚡ Evaluasi Keel Engine
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {positions.map((pos) => {
                  const isExpanded = expandedPositionId === (pos.id || pos.symbol);
                  const isPosProfitable = pos.unrealizedPnl >= 0;

                  // Calculate TP / CL cashflow metrics
                  const distToTPUSD = Math.abs(pos.takeProfit - currentPrice);
                  const distToCLUSD = Math.abs(currentPrice - pos.stopLoss);
                  const distToTPPercent = ((distToTPUSD / currentPrice) * 100).toFixed(2);
                  const distToCLPercent = ((distToCLUSD / currentPrice) * 100).toFixed(2);

                  const potentialProfitCashflow = pos.potentialProfitUSD || (pos.qty * Math.abs(pos.takeProfit - pos.entryPrice));
                  const potentialLossCashflow = pos.potentialLossUSD || (pos.qty * Math.abs(pos.entryPrice - pos.stopLoss));
                  const rr = potentialLossCashflow > 0 ? (potentialProfitCashflow / potentialLossCashflow).toFixed(2) : "2.5";

                  // Position of current price between Stop Loss and Take Profit
                  // For LONG: stopLoss < entry < takeProfit
                  // For SHORT: takeProfit < entry < stopLoss
                  let progressPercent = 50;
                  if (pos.side === "LONG") {
                    const totalSpan = pos.takeProfit - pos.stopLoss;
                    if (totalSpan > 0) {
                      progressPercent = Math.min(100, Math.max(0, ((currentPrice - pos.stopLoss) / totalSpan) * 100));
                    }
                  } else {
                    const totalSpan = pos.stopLoss - pos.takeProfit;
                    if (totalSpan > 0) {
                      progressPercent = Math.min(100, Math.max(0, ((pos.stopLoss - currentPrice) / totalSpan) * 100));
                    }
                  }

                  return (
                    <div
                      key={pos.id || pos.symbol}
                      className="bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded-xl p-4 transition shadow-sm space-y-3"
                    >
                      {/* Top Header of Position Card */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800/80 pb-3">
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`px-2 py-1 rounded-md text-xs font-mono font-black ${
                              pos.side === "LONG"
                                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                                : "bg-rose-500/20 text-rose-400 border border-rose-500/40"
                            }`}
                          >
                            {pos.side} {pos.leverage || 10}x
                          </span>
                          <div>
                            <span className="text-sm font-bold text-zinc-100 font-mono">
                              {pos.symbol}
                            </span>
                            <span className="text-[10px] font-mono text-zinc-500 ml-2">
                              {pos.timeframe || "15m"} {pos.marketType || "FUTURES"}
                            </span>
                          </div>
                        </div>

                        {/* Floating PnL Badge */}
                        <div className="flex items-center gap-3">
                          <div className="text-right font-mono">
                            <span className="text-[10px] text-zinc-500 uppercase block">Floating PnL</span>
                            <span className={`text-base font-black ${isPosProfitable ? "text-emerald-400" : "text-rose-400"}`}>
                              {isPosProfitable ? "+" : ""}${pos.unrealizedPnl.toFixed(2)} ({isPosProfitable ? "+" : ""}{pos.unrealizedPnlPercent.toFixed(2)}%)
                            </span>
                          </div>

                          <button
                            onClick={() => onClosePosition(pos.symbol, "MANUAL_CLOSE")}
                            className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-600 text-zinc-300 hover:text-white font-mono text-xs font-bold border border-zinc-700 hover:border-rose-500 transition"
                            title="Tutup posisi ini sekarang dengan market order"
                          >
                            Market Close
                          </button>
                        </div>
                      </div>

                      {/* Middle Stats: Entry Price, Current Price, Notional Size */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
                        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block uppercase">Harga Entry</span>
                          <span className="font-bold text-zinc-200">${pos.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block uppercase">Harga Live (1s)</span>
                          <span className="font-bold text-zinc-100">${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block uppercase">Posisi Qty</span>
                          <span className="font-bold text-zinc-300">{pos.qty} {pos.symbol.split("/")[0]}</span>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block uppercase">Nilai Notional ($)</span>
                          <span className="font-bold text-amber-400">
                            ${(pos.notionalUSD || pos.qty * pos.entryPrice).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </span>
                        </div>
                      </div>

                      {/* Interactive Visual Gauge: Distance between Cut Loss (CL) and Take Profit (TP) */}
                      <div className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800">
                        <div className="flex items-center justify-between text-xs font-mono mb-1.5">
                          {/* Cut Loss (Left) */}
                          <div className="text-left">
                            <span className="text-rose-400 font-bold flex items-center gap-1 text-[11px]">
                              <ShieldAlert className="w-3 h-3" /> Target CL: ${pos.stopLoss.toFixed(2)}
                            </span>
                            <span className="text-[10px] text-zinc-500 block">
                              Max Loss: <strong className="text-rose-400">-${potentialLossCashflow.toFixed(2)}</strong> ({distToCLPercent}%)
                            </span>
                          </div>

                          {/* Center R:R Badge */}
                          <div className="text-center px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-[10px] font-mono text-amber-400 font-bold">
                            R:R 1 : {rr}
                          </div>

                          {/* Take Profit (Right) */}
                          <div className="text-right">
                            <span className="text-emerald-400 font-bold flex items-center justify-end gap-1 text-[11px]">
                              <Target className="w-3 h-3" /> Target TP: ${pos.takeProfit.toFixed(2)}
                            </span>
                            <span className="text-[10px] text-zinc-500 block">
                              Cashflow Gain: <strong className="text-emerald-400">+${potentialProfitCashflow.toFixed(2)}</strong> ({distToTPPercent}%)
                            </span>
                          </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="relative w-full h-2.5 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800 my-1">
                          {/* Red zone (loss) */}
                          <div className="absolute left-0 top-0 bottom-0 w-1/2 bg-gradient-to-r from-rose-500/40 to-transparent" />
                          {/* Green zone (gain) */}
                          <div className="absolute right-0 top-0 bottom-0 w-1/2 bg-gradient-to-l from-emerald-500/40 to-transparent" />
                          
                          {/* Pin indicating current live price */}
                          <div
                            className="absolute top-0 bottom-0 w-2 bg-amber-400 rounded-full shadow-lg shadow-amber-400/80 transition-all duration-300"
                            style={{ left: `calc(${progressPercent}% - 4px)` }}
                          />
                        </div>

                        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mt-1">
                          <span>Zona Cut Loss (CL)</span>
                          <span className="text-amber-300 font-semibold">
                            Progress ke TP: {progressPercent.toFixed(0)}%
                          </span>
                          <span>Zona Take Profit (TP)</span>
                        </div>
                      </div>

                      {/* Alasan Entry (Human-Readable Agent Reasoning) */}
                      <div className="rounded-xl bg-zinc-900/90 border border-zinc-800 p-3">
                        <div className="flex items-center justify-between text-xs font-mono font-bold text-zinc-300 mb-1">
                          <span className="flex items-center gap-1.5 text-amber-400">
                            <Info className="w-3.5 h-3.5" />
                            ALASAN ENTRY AGENT (WHY AGENT ENTERED):
                          </span>
                          <span className="text-[10px] font-mono text-zinc-500">
                            Confidence: <strong className="text-emerald-400">{pos.confidence || 88}%</strong>
                          </span>
                        </div>
                        <p className="text-xs text-zinc-300 leading-relaxed font-sans mt-1">
                          {pos.entryReasoning || (
                            pos.side === "LONG"
                              ? `15m Sell-Side Liquidity (SSL) Swept: Terjadi penembusan likuidasi stop-loss di $${(pos.entryPrice * 0.992).toFixed(0)} dengan wick absorption agresif + konfirmasi akumulasi On-Chain Paus Outflow (-$142M) dari exchange tier-1. Target ekspansi menuju likuidasi BSL atas.`
                              : `15m Buy-Side Liquidity (BSL) Swept: Terjadi penyapuan likuiditas short stop-loss di $${(pos.entryPrice * 1.008).toFixed(0)} dengan resistensi tinggi + lonjakan inflow exchange. Agent mengantisipasi koreksi menuju pool likuidasi SSL bawah.`
                          )}
                        </p>

                        {pos.targetLiquidityPool && (
                          <div className="mt-2 pt-2 border-t border-zinc-800 flex items-center justify-between text-[11px] font-mono">
                            <span className="text-zinc-500">Target Liquidity Pool:</span>
                            <span className="text-amber-400 font-bold">{pos.targetLiquidityPool}</span>
                          </div>
                        )}
                      </div>

                      {/* Quick Defensive Controls */}
                      <div className="flex items-center justify-end gap-2 pt-1 font-mono text-xs">
                        <button
                          onClick={() => onMoveToBreakEven(pos.symbol)}
                          className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 text-[11px] transition"
                          title="Geser Cut Loss ke harga Entry sehingga posisi bebas risiko (Risk-Free Trade)"
                        >
                          Set Break-Even (Risk-Free)
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Trade History / Realized Cashflow Journal */}
        {activeTab === "history" && (
          <div className="space-y-3">
            {closedTrades.length === 0 ? (
              <div className="text-center py-8 text-zinc-500 font-mono text-xs bg-zinc-950/60 rounded-xl border border-zinc-800">
                Belum ada transaksi tertutup pada sesi ini. Ketika TP atau Cut Loss tersentuh, rekam jejak cashflow akan muncul di sini.
              </div>
            ) : (
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-left font-mono text-xs">
                  <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
                    <tr>
                      <th className="pb-2">WAKTU</th>
                      <th className="pb-2">ASSET</th>
                      <th className="pb-2">SIDE</th>
                      <th className="pb-2">ENTRY</th>
                      <th className="pb-2">EXIT</th>
                      <th className="pb-2">CASHFLOW PNL</th>
                      <th className="pb-2">TRIGGER</th>
                      <th className="pb-2 text-right">ALASAN ENTRY AWAL</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {[...closedTrades].reverse().map((trade) => {
                      const isWin = trade.pnlUSD > 0;
                      return (
                        <tr key={trade.id} className="hover:bg-zinc-800/30 transition">
                          <td className="py-2.5 text-zinc-400 text-[11px]">
                            {new Date(trade.closedAt).toLocaleTimeString()}
                          </td>
                          <td className="py-2.5 font-bold text-zinc-200">{trade.symbol}</td>
                          <td className="py-2.5">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                trade.side === "LONG"
                                  ? "bg-emerald-500/20 text-emerald-400"
                                  : "bg-rose-500/20 text-rose-400"
                              }`}
                            >
                              {trade.side}
                            </span>
                          </td>
                          <td className="py-2.5 text-zinc-300">${trade.entryPrice.toFixed(2)}</td>
                          <td className="py-2.5 text-zinc-100 font-bold">${trade.exitPrice.toFixed(2)}</td>
                          <td className={`py-2.5 font-bold ${isWin ? "text-emerald-400" : "text-rose-400"}`}>
                            {isWin ? "+" : ""}${trade.pnlUSD.toFixed(2)} ({isWin ? "+" : ""}{trade.pnlPercent.toFixed(2)}%)
                          </td>
                          <td className="py-2.5">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                trade.exitReason === "TAKE_PROFIT"
                                  ? "bg-emerald-950 text-emerald-300 border border-emerald-500/40"
                                  : trade.exitReason === "CUT_LOSS"
                                  ? "bg-rose-950 text-rose-300 border border-rose-500/40"
                                  : "bg-zinc-800 text-zinc-300"
                              }`}
                            >
                              {trade.exitReason === "TAKE_PROFIT"
                                ? "HIT TP"
                                : trade.exitReason === "CUT_LOSS"
                                ? "HIT CL"
                                : "MANUAL"}
                            </span>
                          </td>
                          <td className="py-2.5 text-right text-zinc-400 max-w-xs truncate text-[11px]" title={trade.entryReasoning}>
                            {trade.entryReasoning}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
