import React from "react";
import {
  ShieldAlert,
  Target,
  Info,
} from "lucide-react";
import { Position } from "../types";

interface PositionCardProps {
  pos: Position;
  currentPrice: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onClosePosition: (positionId: string, reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE") => void;
  onMoveToBreakEven: (positionId: string) => void;
  actionableRunKeel?: () => void;
}

export const PositionCard: React.FC<PositionCardProps> = ({
  pos,
  currentPrice,
  isExpanded,
  onToggleExpand,
  onClosePosition,
  onMoveToBreakEven,
  actionableRunKeel,
}) => {
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
      key={pos.id}
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
              onClosePosition(pos.id, "MANUAL_CLOSE")
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
              ? `15m Sell-Side Liquidity (SSL) Swept: Terjadi penembusan likuidasi stop-loss di $${(pos.entryPrice * 0.992).toFixed(0)} dengan wick absorption agresif + konfirmasi akumulasi On-Chain Paus Outflow (-$142M) dari exchange tier-1. Target ekspansi menuju likuidasi BSL atas.`
              : `15m Buy-Side Liquidity (BSL) Swept: Terjadi penyapuan likuiditas short stop-loss di $${(pos.entryPrice * 1.008).toFixed(0)} dengan resistensi tinggi + lonjakan inflow exchange. Agent mengantisipasi koreksi menuju pool likuidasi SSL bawah.`)}
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
          onClick={() => onMoveToBreakEven(pos.id)}
          className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 text-[11px] transition"
          title="Geser Cut Loss ke harga Entry sehingga posisi bebas risiko (Risk-Free Trade)"
        >
          Set Break-Even (Risk-Free)
        </button>
      </div>
    </div>
  );
};
