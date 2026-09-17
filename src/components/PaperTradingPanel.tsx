import React, { useState } from "react";
import { Portfolio, Timeframe } from "../types";
import { OrderEntryPanel } from "./OrderEntryPanel";

interface PendingOrderLike {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  limitPrice: number;
}

interface PaperTradingPanelProps {
  portfolio?: Portfolio;
  currentPrice: number;
  symbol: string;
  brokerMode?: "paper" | "live";
  entryTimeframe?: Timeframe;
  onResetPaperAccount: (initialCapital: number) => void;
  onSimulateTradeEntry: (
    side: "LONG" | "SHORT",
    orderType?: "market" | "limit",
    limitPrice?: number,
    opts?: { stopLoss?: number; takeProfit?: number; sizePct?: number; leverage?: number }
  ) => void | Promise<any>;
  cancelPendingOrder?: (orderId: string) => Promise<void>;
  marketType?: string;
}

export const PaperTradingPanel: React.FC<PaperTradingPanelProps> = ({
  currentPrice,
  symbol,
  brokerMode = "paper",
  entryTimeframe = "15m",
  onResetPaperAccount,
  onSimulateTradeEntry,
  cancelPendingOrder,
  marketType = "FUTURES",
}) => {
  const [simulateError, setSimulateError] = useState<{
    reason: string;
    message: string;
    duplicatePositionId?: string;
  } | null>(null);
  const [selectedCapital] = useState<number>(50000);

  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState<number | "">("");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [lastPendingOrder, setLastPendingOrder] = useState<PendingOrderLike | null>(null);
  const [cancellingPending, setCancellingPending] = useState(false);

  const isLiveMode = brokerMode === "live";

  const handleSimulate = async (
    side: "LONG" | "SHORT",
    opts?: { stopLoss?: number; takeProfit?: number; sizePct?: number; leverage?: number }
  ) => {
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
        orderType === "limit" ? Number(limitPrice) : undefined,
        opts
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
      <OrderEntryPanel
        isLiveMode={isLiveMode}
        currentPrice={currentPrice}
        symbol={symbol}
        entryTimeframe={entryTimeframe}
        marketType={marketType}
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
        onResetPaperAccount={onResetPaperAccount}
        selectedCapital={selectedCapital}
      />

      {simulateError && (
        <p className="text-[11px] font-mono text-rose-400 bg-rose-950/30 border border-rose-500/30 rounded-lg px-2.5 py-1.5">
          Simulate gagal ({simulateError.reason}) — {simulateError.message}
        </p>
      )}
    </div>
  );
};
