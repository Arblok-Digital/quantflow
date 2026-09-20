import React from "react";
import { Activity, Clock, TrendingUp, TrendingDown } from "lucide-react";
import { ReplaySession, fmtMoney } from "./replayTypes";

// ---------------------------------------------------------------------------
// ReplayOrderPanel — Order entry form during replay (side, type, qty,
// leverage, SL/TP, decision ID, execute button).
// Extracted from ReplayControlPanel.
// ---------------------------------------------------------------------------

interface ReplayOrderPanelProps {
  session: ReplaySession;
  currentCandle: ReplaySession["currentCandle"];
  currentIndex: number;
  orderSide: "buy" | "sell";
  setOrderSide: (v: "buy" | "sell") => void;
  orderType: "market" | "limit";
  setOrderType: (v: "market" | "limit") => void;
  limitPrice: number | "";
  setLimitPrice: (v: number | "") => void;
  orderQty: number;
  setOrderQty: (v: number) => void;
  orderLeverage: number;
  setOrderLeverage: (v: number) => void;
  slPct: number;
  setSlPct: (v: number) => void;
  tpPct: number;
  setTpPct: (v: number) => void;
  slMode: "pct" | "manual";
  setSlMode: (v: "pct" | "manual") => void;
  tpMode: "pct" | "manual";
  setTpMode: (v: "pct" | "manual") => void;
  slPrice: number | "";
  setSlPrice: (v: number | "") => void;
  tpPrice: number | "";
  setTpPrice: (v: number | "") => void;
  decisionId: string;
  setDecisionId: (v: string) => void;
  handleOrder: () => void;
}

export const ReplayOrderPanel: React.FC<ReplayOrderPanelProps> = ({
  session,
  currentCandle,
  currentIndex,
  orderSide,
  setOrderSide,
  orderType,
  setOrderType,
  limitPrice,
  setLimitPrice,
  orderQty,
  setOrderQty,
  orderLeverage,
  setOrderLeverage,
  slPct,
  setSlPct,
  tpPct,
  setTpPct,
  slMode,
  setSlMode,
  tpMode,
  setTpMode,
  slPrice,
  setSlPrice,
  tpPrice,
  setTpPrice,
  decisionId,
  setDecisionId,
  handleOrder,
}) => {
  return (
    <div className="mb-3 p-3 rounded-xl bg-zinc-950 border border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
          <Activity className="w-3.5 h-3.5 text-cyan-400" /> Place Order (replay book)
        </div>
        <span
          className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[9px] font-mono font-bold text-amber-400"
          title="Replay memakai harga candel HISTORIS di timestamp itu, bukan harga realtime sekarang (backtest valid, tanpa lookahead)"
        >
          <Clock className="w-3 h-3" /> HISTORIS · {session.symbol} {session.timeframe}
        </span>
      </div>

      {/* Referensi harga candle replay saat ini */}
      {currentCandle && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 px-2 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-800/60 font-mono text-[11px]">
          <span className="text-zinc-500">
            Candle <strong className="text-zinc-200">#{currentIndex + 1}</strong> ·{" "}
            {new Date(currentCandle.timestamp).toLocaleString("en-GB", { hour12: false })}
          </span>
          <span className="text-zinc-500">
            Ref close:{" "}
            <strong className="text-cyan-300">${fmtMoney(currentCandle.close)}</strong>
            <span className="text-zinc-600"> (entry MARKET = harga ini)</span>
          </span>
          <span className="text-zinc-500">
            O/H/L: ${fmtMoney(currentCandle.open)} / ${fmtMoney(currentCandle.high)} / $
            {fmtMoney(currentCandle.low)}
          </span>
        </div>
      )}

      {/* Order type + arah */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="flex gap-1">
          <button type="button"
            onClick={() => setOrderType("market")}
            className={`rounded px-2.5 py-1.5 text-xs font-bold border transition-colors ${
              orderType === "market"
                ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/40"
                : "bg-zinc-900 text-zinc-500 border-zinc-800"
            }`}
            title="Entry = close candel replay saat ini (taker fee 0.04%)"
          >
            MARKET
          </button>
          <button type="button"
            onClick={() => setOrderType("limit")}
            className={`rounded px-2.5 py-1.5 text-xs font-bold border transition-colors ${
              orderType === "limit"
                ? "bg-sky-500/20 text-sky-400 border-sky-500/40"
                : "bg-zinc-900 text-zinc-500 border-zinc-800"
            }`}
            title="Entry manual di bawah ini — posisi terisi saat range candel cross harga (maker fee 0.02%)"
          >
            LIMIT
          </button>
        </div>
        <div className="flex gap-1">
          <button type="button"
            onClick={() => setOrderSide("buy")}
            className={`flex-1 rounded px-2.5 py-1.5 text-xs font-bold border transition-colors ${
              orderSide === "buy"
                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                : "bg-zinc-900 text-zinc-500 border-zinc-800"
            }`}
          >
            <TrendingUp className="w-3 h-3 inline mr-1" />LONG
          </button>
          <button type="button"
            onClick={() => setOrderSide("sell")}
            className={`flex-1 rounded px-2.5 py-1.5 text-xs font-bold border transition-colors ${
              orderSide === "sell"
                ? "bg-rose-500/20 text-rose-400 border-rose-500/40"
                : "bg-zinc-900 text-zinc-500 border-zinc-800"
            }`}
          >
            <TrendingDown className="w-3 h-3 inline mr-1" />SHORT
          </button>
        </div>
      </div>

      {/* Entry + qty + leverage + margin */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end mb-2">
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          ENTRY $
          {orderType === "market" ? (
            <input
              value={currentCandle ? `$${fmtMoney(currentCandle.close)}` : "—"}
              readOnly
              className="bg-zinc-900/50 border border-zinc-800 rounded px-2 py-1.5 text-xs text-cyan-300 font-mono"
            />
          ) : (
            <input
              type="number"
              step="0.01"
              value={limitPrice}
              onChange={(e) =>
                setLimitPrice(e.target.value === "" ? "" : Number(e.target.value))
              }
              placeholder={currentCandle ? currentCandle.close.toFixed(2) : ""}
              className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-700"
            />
          )}
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          QTY
          <input
            type="number"
            step="0.001"
            value={orderQty}
            onChange={(e) => setOrderQty(Number(e.target.value))}
            className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          LEVERAGE
          <input
            type="number"
            value={orderLeverage}
            onChange={(e) => setOrderLeverage(Number(e.target.value))}
            className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          MARGIN (est.)
          <input
            value={
              currentCandle
                ? `$${fmtMoney(
                    ((orderType === "limit" ? Number(limitPrice) : currentCandle.close) *
                      orderQty) /
                      Math.max(1, orderLeverage)
                  )}`
                : "—"
            }
            readOnly
            className="bg-zinc-900/50 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 font-mono"
          />
        </label>
      </div>

      {/* SL/TP */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-mono text-rose-400 uppercase tracking-widest">
              Stop Loss
            </span>
            <div className="flex gap-1">
              <button type="button"
                onClick={() => setSlMode("pct")}
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                  slMode === "pct"
                    ? "bg-rose-500/25 text-rose-300 border-rose-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
                title="Hitung dari % referensi close"
              >
                AUTO %
              </button>
              <button type="button"
                onClick={() => setSlMode("manual")}
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                  slMode === "manual"
                    ? "bg-rose-500/25 text-rose-300 border-rose-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
                title="Input harga SL eksplisit"
              >
                MANUAL $
              </button>
            </div>
          </div>
          {slMode === "pct" ? (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                step="0.1"
                value={slPct}
                onChange={(e) => setSlPct(Number(e.target.value))}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
              />
              <span className="text-[10px] text-zinc-500 font-mono">%</span>
              <span className="text-[11px] text-rose-300 font-mono font-bold">
                → ${slPrice ? fmtMoney(Number(slPrice)) : "—"}
              </span>
            </div>
          ) : (
            <input
              type="number"
              step="0.01"
              value={slPrice}
              onChange={(e) => setSlPrice(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="SL $"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-700"
            />
          )}
        </div>
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest">
              Take Profit
            </span>
            <div className="flex gap-1">
              <button type="button"
                onClick={() => setTpMode("pct")}
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                  tpMode === "pct"
                    ? "bg-emerald-500/25 text-emerald-300 border-emerald-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
              >
                AUTO %
              </button>
              <button type="button"
                onClick={() => setTpMode("manual")}
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                  tpMode === "manual"
                    ? "bg-emerald-500/25 text-emerald-300 border-emerald-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
              >
                MANUAL $
              </button>
            </div>
          </div>
          {tpMode === "pct" ? (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                step="0.1"
                value={tpPct}
                onChange={(e) => setTpPct(Number(e.target.value))}
                className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
              />
              <span className="text-[10px] text-zinc-500 font-mono">%</span>
              <span className="text-[11px] text-emerald-300 font-mono font-bold">
                → ${tpPrice ? fmtMoney(Number(tpPrice)) : "—"}
              </span>
            </div>
          ) : (
            <input
              type="number"
              step="0.01"
              value={tpPrice}
              onChange={(e) => setTpPrice(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="TP $"
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-700"
            />
          )}
        </div>
      </div>

      {/* Decision ID + Execute */}
      <div className="flex flex-wrap items-end gap-2">
        <label
          className="flex-1 min-w-[180px] flex flex-col gap-1 text-[10px] font-mono text-zinc-500"
          title="ID keputusan AI (opsional) — join trade ke decision untuk training"
        >
          DECISION ID (opsional)
          <input
            value={decisionId}
            onChange={(e) => setDecisionId(e.target.value)}
            placeholder="decision-..."
            className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-700"
          />
        </label>
        <button type="button"
          onClick={handleOrder}
          className="rounded bg-cyan-500/15 border border-cyan-500/30 px-4 py-1.5 text-xs font-bold text-cyan-400 hover:bg-cyan-500/25 transition-colors"
        >
          EXECUTE
        </button>
      </div>
    </div>
  );
};
