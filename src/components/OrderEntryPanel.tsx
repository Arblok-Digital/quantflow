import React, { useState } from "react";
import { authFetch } from "../hooks/useAuth";
import { useToast } from "./ExecutionToasts";
import { ConfirmOrderModal } from "./ConfirmOrderModal";
import {
  TrendingUp,
  TrendingDown,
  ShieldAlert,
  RotateCcw,
  Zap,
} from "lucide-react";

// ---------------------------------------------------------------------------
// OrderEntryPanel — Top banner with buy/sell buttons, market/limit toggle,
// and pending order status banner.  Extracted from PaperTradingPanel.
// ---------------------------------------------------------------------------

interface PendingOrderLike {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  limitPrice: number;
}

interface OrderEntryPanelProps {
  isLiveMode: boolean;
  currentPrice: number;
  symbol: string;
  orderType: "market" | "limit";
  setOrderType: (t: "market" | "limit") => void;
  limitPrice: number | "";
  setLimitPrice: (v: number | "") => void;
  limitError: string | null;
  lastPendingOrder: PendingOrderLike | null;
  setLastPendingOrder: (o: PendingOrderLike | null) => void;
  cancellingPending: boolean;
  setCancellingPending: (v: boolean) => void;
  cancelPendingOrder?: (orderId: string) => Promise<void>;
  handleSimulate: (side: "LONG" | "SHORT") => void;
  actionableRunKeel?: () => void;
  onResetPaperAccount: (capital: number) => void;
  selectedCapital: number;
}

export const OrderEntryPanel: React.FC<OrderEntryPanelProps> = ({
  isLiveMode,
  currentPrice,
  symbol,
  orderType,
  setOrderType,
  limitPrice,
  setLimitPrice,
  limitError,
  lastPendingOrder,
  setLastPendingOrder,
  cancellingPending,
  setCancellingPending,
  cancelPendingOrder,
  handleSimulate,
  actionableRunKeel,
  onResetPaperAccount,
  selectedCapital,
}) => {
  const { pushToast } = useToast();
  const [confirmSide, setConfirmSide] = useState<"LONG" | "SHORT" | null>(null);
  const [sending, setSending] = useState(false);

  // Eksekusi order (setelah confirm gate di live). Toast feedback ala exchange.
  const executeOrder = async (side: "LONG" | "SHORT") => {
    setSending(true);
    pushToast(
      "info",
      `Order ${side} dikirim`,
      `${symbol} • ${orderType.toUpperCase()}${orderType === "limit" && limitPrice ? ` @ $${Number(limitPrice).toLocaleString()}` : ` @ $${currentPrice.toLocaleString()}`}`
    );
    try {
      const maybe = (handleSimulate as unknown as (s: "LONG" | "SHORT") => Promise<unknown> | void)(side);
      const res = maybe instanceof Promise ? await maybe : undefined;
      if (res === null) {
        pushToast("error", `Order ${side} ditolak server`, "Cek Execution Console / Guardrails untuk alasan lengkap.");
      } else if (res && typeof res === "object") {
        pushToast("success", `Order ${side} diterima`, `${symbol} — detail fill di panel posisi & console.`);
      }
    } catch (err) {
      pushToast("error", `Order ${side} gagal`, (err as Error)?.message || "Kesalahan jaringan/server.");
    } finally {
      setSending(false);
      setConfirmSide(null);
    }
  };

  const handleOrderClick = (side: "LONG" | "SHORT") => {
    if (isLiveMode) {
      // LIVE: wajib lewat confirmation gate (type-symbol + countdown).
      setConfirmSide(side);
      return;
    }
    void executeOrder(side);
  };

  const handleCancelLastPending = async () => {
    if (!lastPendingOrder) return;
    if (!window.confirm(`Batalkan limit order ${lastPendingOrder.id}?`)) return;
    setCancellingPending(true);
    try {
      if (cancelPendingOrder) {
        await cancelPendingOrder(lastPendingOrder.id);
      } else {
        await authFetch("/api/broker/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: lastPendingOrder.id }),
        });
      }
      setLastPendingOrder(null);
    } catch {
      // keep banner so user can retry
    } finally {
      setCancellingPending(false);
    }
  };

  return (
    <>
      {/* Top Banner: Paper Trading Command Center */}
      <div className="bg-gradient-to-r from-zinc-900 via-zinc-900 to-amber-950/40 border border-amber-500/30 rounded-2xl p-4 sm:p-5 shadow-lg relative overflow-hidden">
        <div className="absolute right-0 top-0 translate-x-10 -translate-y-10 w-48 h-48 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span
                className={`px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold flex items-center gap-1.5 border ${
                  isLiveMode
                    ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                    : "bg-amber-500/20 text-amber-300 border-amber-500/40"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full ${isLiveMode ? "bg-rose-400" : "bg-amber-400"} animate-pulse`}
                />
                {isLiveMode ? "LIVE TRADING ACTIVE" : "SIMULATED PAPER TRADING ACTIVE"}
              </span>
              <span
                className={`px-2 py-0.5 rounded text-[10px] bg-zinc-800 border font-mono ${
                  isLiveMode ? "text-rose-300 border-rose-500/30" : "text-zinc-300 border-zinc-700"
                }`}
              >
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
              Pantau seluruh posisi yang dibuka oleh agent secara transparan: mencakup <strong>Floating PnL</strong>,
              <strong>Alasan Entry</strong> teknikal &amp; on-chain, serta proyeksi arus kas
              (<strong>Cashflow Target TP vs Cut Loss CL</strong>).
            </p>
          </div>

          {/* Quick Simulation Trigger Buttons */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            <button
              onClick={() => handleOrderClick("LONG")}
              disabled={sending}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl font-bold font-mono text-xs shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed ${
                isLiveMode
                  ? "bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/30"
                  : "bg-emerald-600 hover:bg-emerald-500 text-zinc-950 shadow-emerald-600/20"
              }`}
              title={isLiveMode ? "KIRIM order LONG REAL ke exchange (konfirmasi dulu)" : "Simulasikan Entry LONG pada sinyal 15m"}
            >
              {isLiveMode ? <ShieldAlert className="w-3.5 h-3.5" /> : <TrendingUp className="w-3.5 h-3.5" />}
              <span>{sending ? "SENDING…" : isLiveMode ? "EXECUTE LONG (live)" : "Simulate LONG"}</span>
            </button>
            <button
              onClick={() => handleOrderClick("SHORT")}
              disabled={sending}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-zinc-100 font-bold font-mono text-xs shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed ${
                isLiveMode
                  ? "bg-rose-700 hover:bg-rose-600 shadow-rose-700/30"
                  : "bg-rose-600 hover:bg-rose-500 shadow-rose-600/20"
              }`}
              title={isLiveMode ? "KIRIM order SHORT REAL ke exchange (konfirmasi dulu)" : "Simulasikan Entry SHORT pada sinyal 15m"}
            >
              {isLiveMode ? <ShieldAlert className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              <span>{sending ? "SENDING…" : isLiveMode ? "EXECUTE SHORT (live)" : "Simulate SHORT"}</span>
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

        {/* Order entry: Market / Limit toggle + limitPrice */}
        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-zinc-800/80 relative z-10">
          <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800 font-mono text-xs">
            <button
              onClick={() => setOrderType("market")}
              className={`px-3 py-1.5 rounded-lg transition font-semibold ${
                orderType === "market"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
              title="Market order — fill langsung di harga live"
            >
              Market
            </button>
            <button
              onClick={() => setOrderType("limit")}
              className={`px-3 py-1.5 rounded-lg transition font-semibold ${
                orderType === "limit"
                  ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
              title="Limit order — pending di book sampai harga tersentuh"
            >
              Limit
            </button>
          </div>
          {orderType === "limit" && (
            <label className="flex items-center gap-2 font-mono text-xs text-zinc-300">
              <span className="text-zinc-500 uppercase text-[10px]">Limit Price</span>
              <input
                type="number"
                min={0}
                step="any"
                value={limitPrice}
                placeholder={currentPrice ? currentPrice.toFixed(2) : "0.00"}
                onChange={(e) => {
                  const v = e.target.value;
                  setLimitPrice(v === "" ? "" : Number(v));
                }}
                className="w-36 px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-xs focus:outline-none focus:border-sky-500/60"
              />
            </label>
          )}
          <span className="text-[10px] font-mono text-zinc-500">
            {orderType === "limit"
              ? "Limit: order pending di book — batalkan via panel Pending Orders."
              : "Market: fill instan di harga live."}
          </span>
        </div>
        {limitError && (
          <p className="mt-2 text-[11px] font-mono text-rose-400 relative z-10">{limitError}</p>
        )}
      </div>

      {/* Limit order pending status banner */}
      {lastPendingOrder && (
        <div className="bg-sky-950/40 border border-sky-500/30 rounded-2xl p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 font-mono text-xs">
            <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
            <span className="text-sky-200">
              Order pending di book — {lastPendingOrder.symbol} {lastPendingOrder.side}{" "}
              {lastPendingOrder.qty} @ ${Number(lastPendingOrder.limitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
            <span className="px-2 py-0.5 rounded border text-[10px] font-bold bg-sky-500/15 text-sky-300 border-sky-500/30">
              NEW
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCancelLastPending}
              disabled={cancellingPending}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-600 text-zinc-200 hover:text-white border border-zinc-700 hover:border-rose-500 font-mono text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed"
              title="Batalkan limit order via POST /api/broker/cancel"
            >
              {cancellingPending ? "Cancelling…" : "Cancel"}
            </button>
            <button
              onClick={() => setLastPendingOrder(null)}
              className="px-2 py-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 font-mono text-xs transition"
              title="Sembunyikan banner (order tetap pending di book)"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Confirmation gate — LIVE mode wajib konfirmasi sebelum eksekusi */}
      <ConfirmOrderModal
        isOpen={confirmSide !== null}
        symbol={symbol}
        side={confirmSide || "LONG"}
        qty={currentPrice > 0 ? Number((selectedCapital / currentPrice).toFixed(4)) : 0}
        orderType={orderType}
        price={orderType === "limit" && limitPrice ? Number(limitPrice) : currentPrice}
        leverage={10}
        mode={isLiveMode ? "live" : "paper"}
        busy={sending}
        onConfirm={() => confirmSide && void executeOrder(confirmSide)}
        onCancel={() => setConfirmSide(null)}
      />
    </>
  );
};
