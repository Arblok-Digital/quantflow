import React from "react";
import { ReplaySession, ReplayPosition, ReplayOrder, fmtMoney, fmtNum } from "./replayTypes";

// ---------------------------------------------------------------------------
// ReplayResultsTable — Open positions, pending orders, and closed trades
// tables during replay session.  Extracted from ReplayControlPanel.
// ---------------------------------------------------------------------------

interface ReplayResultsTableProps {
  session: ReplaySession;
  openPositions: ReplayPosition[];
  pendingOrders: ReplayOrder[];
  handleClose: (positionId: string) => void;
  handleCancel: (orderId: string) => void;
}

export const ReplayResultsTable: React.FC<ReplayResultsTableProps> = ({
  session,
  openPositions,
  pendingOrders,
  handleClose,
  handleCancel,
}) => {
  return (
    <div className="space-y-3">
      {/* Open Positions */}
      <div className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
        <div className="px-3 py-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest border-b border-zinc-800">
          Open Positions ({openPositions.length})
        </div>
        {openPositions.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] font-mono text-zinc-600">
            Belum ada posisi terbuka
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[11px]">
              <thead className="bg-zinc-900 text-zinc-500 text-[10px] uppercase">
                <tr>
                  <th className="px-3 py-2">SYM</th>
                  <th className="px-3 py-2">SIDE</th>
                  <th className="px-3 py-2 text-right">QTY</th>
                  <th className="px-3 py-2 text-right">ENTRY</th>
                  <th className="px-3 py-2 text-right">MARK</th>
                  <th className="px-3 py-2 text-right">uPnL</th>
                  <th className="px-3 py-2 text-right">SL</th>
                  <th className="px-3 py-2 text-right">TP</th>
                  <th className="px-3 py-2 text-right">LIQ</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {openPositions.map((pos) => {
                  const mark = pos.lastMark ?? pos.entryPrice;
                  const upnl =
                    pos.side === "LONG"
                      ? (mark - pos.entryPrice) * pos.qty
                      : (pos.entryPrice - mark) * pos.qty;
                  return (
                    <tr key={pos.id} className="hover:bg-zinc-900/40">
                      <td className="px-3 py-2 text-zinc-300">{pos.symbol}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            pos.side === "LONG"
                              ? "bg-emerald-500/20 text-emerald-400"
                              : "bg-rose-500/20 text-rose-400"
                          }`}
                        >
                          {pos.side}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-zinc-300">{fmtNum(pos.qty)}</td>
                      <td className="px-3 py-2 text-right text-zinc-300">
                        ${fmtMoney(pos.entryPrice)}
                      </td>
                      <td className="px-3 py-2 text-right text-zinc-100">${fmtMoney(mark)}</td>
                      <td
                        className={`px-3 py-2 text-right font-bold ${
                          upnl >= 0 ? "text-emerald-400" : "text-rose-400"
                        }`}
                      >
                        {upnl >= 0 ? "+" : ""}${fmtMoney(upnl)}
                      </td>
                      <td className="px-3 py-2 text-right text-rose-400">
                        ${fmtMoney(pos.stopLoss)}
                      </td>
                      <td className="px-3 py-2 text-right text-emerald-400">
                        ${fmtMoney(pos.takeProfit)}
                      </td>
                      <td className="px-3 py-2 text-right text-amber-400">
                        ${fmtMoney(pos.liquidationPrice)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => handleClose(pos.id)}
                          className="px-2 py-1 rounded bg-zinc-800 hover:bg-rose-600 hover:text-white text-slate-300 border border-zinc-700 text-[10px] font-bold transition-colors"
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pending Orders */}
      <div className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
        <div className="px-3 py-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest border-b border-zinc-800">
          Pending Orders ({pendingOrders.length})
        </div>
        {pendingOrders.length === 0 ? (
          <div className="px-3 py-3 text-center text-[11px] font-mono text-zinc-600">
            Tidak ada order pending
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-[11px]">
              <thead className="bg-zinc-900 text-zinc-500 text-[10px] uppercase">
                <tr>
                  <th className="px-3 py-2">SYM</th>
                  <th className="px-3 py-2">SIDE</th>
                  <th className="px-3 py-2 text-right">QTY</th>
                  <th className="px-3 py-2 text-right">LIMIT</th>
                  <th className="px-3 py-2 text-right">LEV</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {pendingOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-zinc-900/40">
                    <td className="px-3 py-2 text-zinc-300">{o.symbol}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          o.side === "buy"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-rose-500/20 text-rose-400"
                        }`}
                      >
                        {o.side}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">{fmtNum(o.amount)}</td>
                    <td className="px-3 py-2 text-right text-zinc-100">
                      ${o.limitPrice ? fmtMoney(o.limitPrice) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-400">{o.leverage}x</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => handleCancel(o.id)}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-slate-300 border border-zinc-700 text-[10px] font-bold transition-colors"
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Closed Trades */}
      {session.trades.length > 0 && (
        <div className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
          <div className="px-3 py-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest border-b border-zinc-800">
            Closed Trades ({session.trades.length})
          </div>
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-left font-mono text-[11px]">
              <thead className="bg-zinc-900 text-zinc-500 text-[10px] uppercase sticky top-0">
                <tr>
                  <th className="px-3 py-2">SIDE</th>
                  <th className="px-3 py-2 text-right">ENTRY</th>
                  <th className="px-3 py-2 text-right">EXIT</th>
                  <th className="px-3 py-2 text-right">PnL</th>
                  <th className="px-3 py-2 text-right">R%</th>
                  <th className="px-3 py-2">REASON</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {[...session.trades].reverse().map((t) => (
                  <tr key={t.id} className="hover:bg-zinc-900/40">
                    <td className="px-3 py-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          t.side === "LONG"
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-rose-500/20 text-rose-400"
                        }`}
                      >
                        {t.side}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-300">
                      ${fmtMoney(t.entryPrice)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-100">
                      ${fmtMoney(t.exitPrice)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-bold ${
                        t.pnlUSD >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {t.pnlUSD >= 0 ? "+" : ""}${fmtMoney(t.pnlUSD)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right ${
                        t.pnlPercent >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {t.pnlPercent >= 0 ? "+" : ""}
                      {fmtNum(t.pnlPercent)}%
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          t.exitReason === "TAKE_PROFIT"
                            ? "bg-emerald-950 text-emerald-300 border border-emerald-500/40"
                            : t.exitReason === "STOP_LOSS"
                            ? "bg-rose-950 text-rose-300 border border-rose-500/40"
                            : t.exitReason === "LIQUIDATED"
                            ? "bg-amber-950 text-amber-300 border border-amber-500/40"
                            : "bg-zinc-800 text-zinc-300"
                        }`}
                      >
                        {t.exitReason}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
