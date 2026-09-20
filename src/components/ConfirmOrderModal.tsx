import React, { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";

// ---------------------------------------------------------------------------
// ConfirmOrderModal — confirmation gate untuk LIVE mode (real money).
// Ringkasan order + wajib ketik simbol + delay 3 detik sebelum eksekusi.
// Paper mode TIDAK melewati modal ini.
// ---------------------------------------------------------------------------

interface ConfirmOrderModalProps {
  isOpen: boolean;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  orderType: "market" | "limit";
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage: number;
  mode: "paper" | "live";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmOrderModal: React.FC<ConfirmOrderModalProps> = ({
  isOpen, symbol, side, qty, orderType, price,
  stopLoss, takeProfit, leverage, mode, busy, onConfirm, onCancel,
}) => {
  const [confirmText, setConfirmText] = useState("");
  const [countdown, setCountdown] = useState(3);
  const isLive = mode === "live";
  const base = symbol.includes("/") ? symbol.split("/")[0] : symbol;

  useEffect(() => {
    if (isOpen) { setConfirmText(""); setCountdown(3); }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isLive || countdown <= 0) return;
    const t = window.setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [isOpen, isLive, countdown]);

  if (!isOpen) return null;

  const typedOk = confirmText.trim().toUpperCase() === base.toUpperCase();
  const canConfirm = isLive ? typedOk && countdown <= 0 : true;
  const notional = qty * price;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onCancel}>
      <div
        className={`w-full max-w-md mx-4 rounded-2xl border shadow-2xl ${isLive ? "bg-zinc-950 border-rose-500/50" : "bg-zinc-950 border-sky-500/40"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`flex items-center gap-2 px-5 py-3.5 border-b ${isLive ? "border-rose-500/30 bg-rose-950/30" : "border-sky-500/30 bg-sky-950/30"}`}>
          <ShieldAlert className={`w-5 h-5 ${isLive ? "text-rose-400" : "text-sky-400"}`} />
          <div>
            <p className={`text-sm font-bold font-mono ${isLive ? "text-rose-300" : "text-sky-300"}`}>
              {isLive ? "KONFIRMASI ORDER LIVE — UANG BENERAN" : "Konfirmasi Order Paper"}
            </p>
            <p className="text-[10px] font-mono text-zinc-500">
              {isLive ? "Order akan dieksekusi ke exchange sekarang juga" : "Simulasi via paper book server"}
            </p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-2 font-mono text-xs">
          <Row label="Symbol" value={symbol} />
          <Row label="Side" value={side} valueClass={side === "LONG" ? "text-emerald-400" : "text-rose-400"} />
          <Row label="Type" value={orderType.toUpperCase()} />
          <Row label="Qty" value={String(qty)} />
          <Row label={orderType === "limit" ? "Limit Price" : "Market Price"} value={`$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          <Row label="Leverage" value={`${leverage}x`} />
          <Row label="Notional" value={`$${notional.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          {stopLoss ? <Row label="Stop Loss" value={`$${Number(stopLoss).toLocaleString()}`} valueClass="text-rose-400" /> : null}
          {takeProfit ? <Row label="Take Profit" value={`$${Number(takeProfit).toLocaleString()}`} valueClass="text-emerald-400" /> : null}
        </div>

        {isLive && (
          <div className="px-5 pb-3">
            <label className="block font-mono text-[10px] uppercase text-zinc-500 mb-1.5">
              Ketik <span className="text-rose-400 font-bold">{base}</span> untuk konfirmasi:
            </label>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={base}
              autoFocus
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 focus:border-rose-500/60 focus:outline-none font-mono text-sm text-zinc-100 uppercase"
            />
          </div>
        )}

        {/* Actions */}
        <div className="px-5 pb-5 pt-1 flex gap-2">
          <button type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 font-mono text-xs font-bold transition disabled:opacity-50"
          >
            Batal
          </button>
          <button type="button"
            onClick={onConfirm}
            disabled={!canConfirm || busy}
            className={`flex-1 px-4 py-2.5 rounded-xl font-mono text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed ${
              side === "LONG"
                ? "bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500"
                : "bg-rose-600 hover:bg-rose-500 text-white border border-rose-500"
            }`}
          >
            {busy ? "MENGIRIM…" : isLive && countdown > 0 ? `TUNGGU ${countdown}s…` : `${side === "LONG" ? "BUY" : "SELL"} ${qty} ${base}`}
          </button>
        </div>

      </div>
    </div>
  );
};

const Row: React.FC<{ label: string; value: string; valueClass?: string }> = ({ label, value, valueClass }) => (
  <div className="flex items-center justify-between">
    <span className="text-zinc-500 uppercase text-[10px]">{label}</span>
    <span className={`text-zinc-100 font-bold ${valueClass || ""}`}>{value}</span>
  </div>
);
