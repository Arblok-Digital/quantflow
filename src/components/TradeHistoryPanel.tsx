import React from "react";
import { ClosedTrade } from "../types";

// ---------------------------------------------------------------------------
// TradeHistoryPanel — Closed trades table.  Extracted from PaperTradingPanel.
// ---------------------------------------------------------------------------

interface TradeHistoryPanelProps {
  closedTrades: ClosedTrade[];
}

export const TradeHistoryPanel: React.FC<TradeHistoryPanelProps> = ({ closedTrades }) => {
  if (closedTrades.length === 0) {
    return (
      <div className="text-center py-8 text-zinc-500 font-mono text-xs bg-zinc-950/60 rounded-xl border border-zinc-800">
        Belum ada transaksi tertutup pada sesi ini. Ketika TP atau Cut Loss tersentuh, rekam jejak
        cashflow akan muncul di sini.
      </div>
    );
  }

  return (
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
                  {isWin ? "+" : ""}${trade.pnlUSD.toFixed(2)} ({isWin ? "+" : ""}
                  {trade.pnlPercent.toFixed(2)}%)
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
                <td
                  className="py-2.5 text-right text-zinc-400 max-w-xs truncate text-[11px]"
                  title={trade.entryReasoning}
                >
                  {trade.entryReasoning}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
