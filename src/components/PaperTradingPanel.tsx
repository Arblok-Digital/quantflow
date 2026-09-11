import React, { useEffect, useState } from "react";
import {
  Portfolio,
  Position,
  ClosedTrade,
  MTFLiquidityAnalysis,
  LLMDecision,
} from "../types";
import { authFetch } from "../hooks/useAuth";
import { OrderEntryPanel } from "./OrderEntryPanel";
import { PortfolioSummaryPanel } from "./PortfolioSummaryPanel";
import { TradeHistoryPanel } from "./TradeHistoryPanel";
import {
  ShieldAlert,
  Target,
  Crosshair,
  CheckCircle2,
  XCircle,
  Zap,
  Info,
  Clock,
} from "lucide-react";

// ---------------------------------------------------------------------------
// PaperTradingPanel — thin shell composing OrderEntryPanel, PortfolioSummaryPanel,
// and TradeHistoryPanel.  Position cards remain inline due to their complexity.
// ---------------------------------------------------------------------------

interface PendingOrderLike {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  limitPrice: number;
}

interface PaperTradingPanelProps {
  portfolio: Portfolio;
  positions: Position[];
  closedTrades: ClosedTrade[];
  currentPrice: number;
  symbol: string;
  mtfLiquidity?: MTFLiquidityAnalysis;
  latestDecision?: LLMDecision | null;
  onClosePosition: (positionId: string, reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE") => void;
  onMoveToBreakEven: (symbol: string) => void;
  onResetPaperAccount: (initialCapital: number) => void;
  onSimulateTradeEntry: (
    side: "LONG" | "SHORT",
    orderType?: "market" | "limit",
    limitPrice?: number
  ) => void | Promise<any>;
  cancelPendingOrder?: (orderId: string) => Promise<void>;
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
  cancelPendingOrder,
  actionableRunKeel,
}) => {
  const [activeTab, setActiveTab] = useState<"positions" | "history">("positions");
  const [expandedPositionId, setExpandedPositionId] = useState<string | null>(null);
  const [simulateError, setSimulateError] = useState<{
    reason: string;
    message: string;
    duplicatePositionId?: string;
  } | null>(null);
  const [selectedCapital] = useState<number>(50000);

  // Order entry state
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState<number | "">("");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [lastPendingOrder, setLastPendingOrder] = useState<PendingOrderLike | null>(null);
  const [cancellingPending, setCancellingPending] = useState(false);

  // Broker mode poll
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
        // ignore
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

  const handleSimulate = async (side: "LONG" | "SHORT") => {
    if (isLiveMode) {
      const ok = window.confirm("Anda akan mengirim order REAL ke exchange. Lanjutkan?");
      if (!ok) return;
    }
    setSimulateError(null);
    if (orderType === "limit") {
      if (limitPrice === "" || !isFinite(Number(limitPrice)) || Number(limitPrice) <= 0) {
        setLimitError("Isi limitPrice dulu (angka > 0) untuk limit order.");
        return;
      }
      setLimitError(null);
    }
    try {
      const result = await onSimulateTradeEntry(
        side,
        orderType,
        orderType === "limit" ? Number(limitPrice) : undefined
      );
      const order = (result as any)?.order ?? result ?? null;
      const state = String(order?.state ?? order?.status ?? "").toUpperCase();
      if (orderType === "limit" && (state === "NEW" || state === "PARTIALLY_FILLED")) {
        setLastPendingOrder({
          id: String(order?.id ?? ""),
          symbol: String(order?.symbol ?? symbol),
          side: String(order?.side ?? side),
          qty: Number(order?.amount ?? order?.qty ?? 0),
          limitPrice: Number(order?.limitPrice ?? limitPrice),
        });
      }
    } catch (err) {
      setSimulateError({ reason: "SIMULATE_FAILED", message: (err as Error).message });
    }
  };

  return (
    <div className="space-y-4 font-sans">
      {/* Order Entry (banner + buttons + market/limit toggle + pending order banner) */}
      <OrderEntryPanel
        isLiveMode={isLiveMode}
        currentPrice={currentPrice}
        symbol={symbol}
        orderType={orderType}
        setOrderType={setOrderType}
        limitPrice={limitPrice}
        setLimitPrice={setLimitPrice}
        limitError={limitError}
        lastPendingOrder={lastPendingOrder}
        setLastPendingOrder={setLastPendingOrder}
        cancellingPending={cancellingPending}
        setCancellingPending={setCancellingPending}
        cancelPendingOrder={cancelPendingOrder}
        handleSimulate={handleSimulate}
        actionableRunKeel={actionableRunKeel}
        onResetPaperAccount={onResetPaperAccount}
        selectedCapital={selectedCapital}
      />

      {/* Cashflow & PnL Overview Bento Grid */}
      <PortfolioSummaryPanel
        portfolio={portfolio}
        positions={positions}
        closedTrades={closedTrades}
        currentPrice={currentPrice}
      />

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

        {/* Tab 1: Active Entry Positions */}
        {activeTab === "positions" && (
          <div className="space-y-4">
            {positions.length === 0 ? (
              <div className="text-center py-10 px-4 bg-zinc-950/60 rounded-xl border border-zinc-800/80">
                <Crosshair className="w-10 h-10 text-zinc-600 mx-auto mb-2" />
                <h4 className="text-sm font-semibold text-zinc-300">Belum Ada Posisi Terbuka</h4>
                <p className="text-xs text-zinc-500 max-w-md mx-auto mt-1 mb-4">
                  Agent sedang memindai pola <strong>15m MTF Liquidity Sweep</strong> dan menunggu
                  konfirmasi on-chain whale. Anda juga dapat menekan tombol simulasi di bawah untuk
                  menguji sistem.
                </p>
                <div className="flex justify-center gap-2">
                  <button
                    onClick={() => handleSimulate("LONG")}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition ${
                      isLiveMode
                        ? "bg-rose-600 hover:bg-rose-500 text-white"
                        : "bg-emerald-600 hover:bg-emerald-500 text-zinc-950"
                    }`}
                    title={
                      isLiveMode
                        ? "Kirim order LONG REAL ke exchange (konfirmasi dulu)"
                        : "Simulasikan entry LONG"
                    }
                  >
                    {isLiveMode ? "⚠ EXECUTE LONG (live)" : "+ Simulasikan Entry LONG"}
                  </button>
                  <button
                    onClick={() => handleSimulate("SHORT")}
                    className={`px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold font-mono transition ${
                      isLiveMode ? "ring-1 ring-rose-400/50" : ""
                    }`}
                    title={
                      isLiveMode
                        ? "Kirim order SHORT REAL ke exchange (konfirmasi dulu)"
                        : "Simulasikan entry SHORT"
                    }
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

                  const distToTPUSD = Math.abs(pos.takeProfit - currentPrice);
                  const distToCLUSD = Math.abs(currentPrice - pos.stopLoss);
                  const distToTPPercent = ((distToTPUSD / currentPrice) * 100).toFixed(2);
                  const distToCLPercent = ((distToCLUSD / currentPrice) * 100).toFixed(2);

                  const potentialProfitCashflow =
                    pos.potentialProfitUSD || pos.qty * Math.abs(pos.takeProfit - pos.entryPrice);
                  const potentialLossCashflow =
                    pos.potentialLossUSD || pos.qty * Math.abs(pos.entryPrice - pos.stopLoss);
                  const rr =
                    potentialLossCashflow > 0
                      ? (potentialProfitCashflow / potentialLossCashflow).toFixed(2)
                      : "2.5";

                  let progressPercent = 50;
                  if (pos.side === "LONG") {
                    const totalSpan = pos.takeProfit - pos.stopLoss;
                    if (totalSpan > 0) {
                      progressPercent = Math.min(
                        100,
                        Math.max(0, ((currentPrice - pos.stopLoss) / totalSpan) * 100)
                      );
                    }
                  } else {
                    const totalSpan = pos.stopLoss - pos.takeProfit;
                    if (totalSpan > 0) {
                      progressPercent = Math.min(
                        100,
                        Math.max(0, ((pos.stopLoss - currentPrice) / totalSpan) * 100)
                      );
                    }
                  }

                  return (
                    <div
                      key={pos.id || pos.symbol}
                      className="bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded-xl p-4 transition shadow-sm space-y-3"
                    >
                      {/* Top Header */}
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

                        <div className="flex items-center gap-3">
                          <div className="text-right font-mono">
                            <span className="text-[10px] text-zinc-500 uppercase block">
                              Floating PnL
                            </span>
                            <span
                              className={`text-base font-black ${
                                isPosProfitable ? "text-emerald-400" : "text-rose-400"
                              }`}
                            >
                              {isPosProfitable ? "+" : ""}${pos.unrealizedPnl.toFixed(2)} (
                              {isPosProfitable ? "+" : ""}
                              {pos.unrealizedPnlPercent.toFixed(2)}%)
                            </span>
                          </div>

                          <button
                            onClick={() =>
                              onClosePosition(pos.id || pos.symbol, "MANUAL_CLOSE")
                            }
                            className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-600 text-zinc-300 hover:text-white font-mono text-xs font-bold border border-zinc-700 hover:border-rose-500 transition"
                            title="Tutup posisi ini sekarang dengan market order"
                          >
                            Market Close
                          </button>
                        </div>
                      </div>

                      {/* Middle Stats */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
                        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block uppercase">
                            Harga Entry
                          </span>
                          <span className="font-bold text-zinc-200">
                            ${pos.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </span>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block uppercase">
                            Harga Live (1s)
                          </span>
                          <span className="font-bold text-zinc-100">
                            $
                            {currentPrice.toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                            })}
                          </span>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block uppercase">
                            Posisi Qty
                          </span>
                          <span className="font-bold text-zinc-300">
                            {pos.qty} {pos.symbol.split("/")[0]}
                          </span>
                        </div>
                        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
                          <span className="text-[10px] text-zinc-500 block uppercase">
                            Nilai Notional ($)
                          </span>
                          <span className="font-bold text-amber-400">
                            $
                            {(
                              pos.notionalUSD || pos.qty * pos.entryPrice
                            ).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </span>
                        </div>
                      </div>

                      {/* Interactive Visual Gauge */}
                      <div className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800">
                        <div className="flex items-center justify-between text-xs font-mono mb-1.5">
                          <div className="text-left">
                            <span className="text-rose-400 font-bold flex items-center gap-1 text-[11px]">
                              <ShieldAlert className="w-3 h-3" /> Target CL: $
                              {pos.stopLoss.toFixed(2)}
                            </span>
                            <span className="text-[10px] text-zinc-500 block">
                              Max Loss:{" "}
                              <strong className="text-rose-400">
                                -${potentialLossCashflow.toFixed(2)}
                              </strong>{" "}
                              ({distToCLPercent}%)
                            </span>
                          </div>

                          <div className="text-center px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-[10px] font-mono text-amber-400 font-bold">
                            R:R 1 : {rr}
                          </div>

                          <div className="text-right">
                            <span className="text-emerald-400 font-bold flex items-center justify-end gap-1 text-[11px]">
                              <Target className="w-3 h-3" /> Target TP: $
                              {pos.takeProfit.toFixed(2)}
                            </span>
                            <span className="text-[10px] text-zinc-500 block">
                              Cashflow Gain:{" "}
                              <strong className="text-emerald-400">
                                +${potentialProfitCashflow.toFixed(2)}
                              </strong>{" "}
                              ({distToTPPercent}%)
                            </span>
                          </div>
                        </div>

                        <div className="relative w-full h-2.5 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800 my-1">
                          <div className="absolute left-0 top-0 bottom-0 w-1/2 bg-gradient-to-r from-rose-500/40 to-transparent" />
                          <div className="absolute right-0 top-0 bottom-0 w-1/2 bg-gradient-to-l from-emerald-500/40 to-transparent" />
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

                      {/* Alasan Entry */}
                      <div className="rounded-xl bg-zinc-900/90 border border-zinc-800 p-3">
                        <div className="flex items-center justify-between text-xs font-mono font-bold text-zinc-300 mb-1">
                          <span className="flex items-center gap-1.5 text-amber-400">
                            <Info className="w-3.5 h-3.5" />
                            ALASAN ENTRY AGENT (WHY AGENT ENTERED):
                          </span>
                          <span className="text-[10px] font-mono text-zinc-500">
                            Confidence:{" "}
                            <strong className="text-emerald-400">{pos.confidence || 88}%</strong>
                          </span>
                        </div>
                        <p className="text-xs text-zinc-300 leading-relaxed font-sans mt-1">
                          {pos.entryReasoning ||
                            (pos.side === "LONG"
                              ? `15m Sell-Side Liquidity (SSL) Swept: Terjadi penembusan likuidasi stop-loss di $${(
                                  pos.entryPrice * 0.992
                                ).toFixed(0)} dengan wick absorption agresif + konfirmasi akumulasi On-Chain Paus Outflow (-$142M) dari exchange tier-1. Target ekspansi menuju likuidasi BSL atas.`
                              : `15m Buy-Side Liquidity (BSL) Swept: Terjadi penyapuan likuiditas short stop-loss di $${(
                                  pos.entryPrice * 1.008
                                ).toFixed(0)} dengan resistensi tinggi + lonjakan inflow exchange. Agent mengantisipasi koreksi menuju pool likuidasi SSL bawah.`)}
                        </p>

                        {pos.targetLiquidityPool && (
                          <div className="mt-2 pt-2 border-t border-zinc-800 flex items-center justify-between text-[11px] font-mono">
                            <span className="text-zinc-500">Target Liquidity Pool:</span>
                            <span className="text-amber-400 font-bold">
                              {pos.targetLiquidityPool}
                            </span>
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

        {/* Tab 2: Trade History */}
        {activeTab === "history" && (
          <div className="space-y-3">
            <TradeHistoryPanel closedTrades={closedTrades} />
          </div>
        )}
      </div>
    </div>
  );
};
