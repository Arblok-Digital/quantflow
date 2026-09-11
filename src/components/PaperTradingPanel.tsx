import React, { useEffect, useState } from "react";
import {
  Portfolio,
  Position,
  MTFLiquidityAnalysis,
  LLMDecision,
} from "../types";
import { authFetch } from "../hooks/useAuth";
import { OrderEntryPanel } from "./OrderEntryPanel";
import { PositionCard } from "./PositionCard";
import {
  Crosshair,
} from "lucide-react";

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
  currentPrice: number;
  symbol: string;
  mtfLiquidity?: MTFLiquidityAnalysis;
  latestDecision?: LLMDecision | null;
  onClosePosition: (positionId: string, reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE") => void;
  onMoveToBreakEven: (positionId: string) => void;
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

      {/* Main Panel: Active Positions */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-1.5 font-mono text-xs text-zinc-300 font-semibold">
            <span>Posisi Entry Aktif ({positions.length})</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 font-mono">Live 1s Ref:</span>
            <span className="px-2 py-0.5 rounded bg-zinc-950 text-zinc-200 font-mono text-xs border border-zinc-800 font-bold">
              ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </div>
        </div>

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
              {positions.map((pos) => (
                <PositionCard
                  key={pos.id}
                  pos={pos}
                  currentPrice={currentPrice}
                  isExpanded={expandedPositionId === pos.id}
                  onToggleExpand={() => setExpandedPositionId(expandedPositionId === pos.id ? null : pos.id)}
                  onClosePosition={onClosePosition}
                  onMoveToBreakEven={onMoveToBreakEven}
                  actionableRunKeel={actionableRunKeel}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
