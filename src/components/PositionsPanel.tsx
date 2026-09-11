import React, { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck, Zap, XCircle } from "lucide-react";
import { authFetch, useAuth } from "../hooks/useAuth";
import { normalizeSide } from "../lib/sideNormalize";

// ---------------------------------------------------------------------------
// Positions Panel — server-backed open positions table (roadmap 1.8).
// Polls GET /api/broker/positions every 3.5s (paused while hidden). The
// server paper book is the single source of truth: no client-side book is
// duplicated here. Renders the account summary strip + open positions table
// with Close / Move-to-BE actions calling the broker endpoints directly.
// ---------------------------------------------------------------------------

interface ServerPosition {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  notionalUSD: number;
  leverage: number;
  marginUSD: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  openedAt: number;
  status: "OPEN" | "CLOSED";
  lastMark?: number;
}

interface ServerAccount {
  cash: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openCount: number;
  marginLocked: number;
}

interface PositionsResponse {
  success: boolean;
  mode: "paper" | "live";
  positions: ServerPosition[] | null;
  account: ServerAccount | null;
  note?: string;
}

interface ActionError {
  reason: string;
  message: string;
  duplicatePositionId?: string;
}

interface PositionsPanelProps {
  /** Called with the ids of currently OPEN server positions after each poll
   *  so the legacy client-side book can prune stale server-backed rows. */
  onServerPositions?: (openServerIds: string[]) => void;
}

const POLL_MS = 5000;
const fmtMoney = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

function unrealizedFor(pos: ServerPosition): { pnlUSD: number; pnlPct: number } {
  const mark = pos.lastMark ?? pos.entryPrice;
  const pnlUSD = pos.side === "LONG" ? (mark - pos.entryPrice) * pos.qty : (pos.entryPrice - mark) * pos.qty;
  const pnlPct = pos.notionalUSD > 0 ? (pnlUSD / pos.notionalUSD) * 100 : 0;
  return { pnlUSD, pnlPct };
}

export const PositionsPanel: React.FC<PositionsPanelProps> = ({ onServerPositions }) => {
  const { isAuthenticated } = useAuth();
  const [data, setData] = useState<PositionsResponse | null>(null);
  const [conn, setConn] = useState<"ok" | "error" | "hidden">("hidden");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const onServerPositionsRef = useRef(onServerPositions);
  onServerPositionsRef.current = onServerPositions;
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isAuthenticated) return;
    if (document.hidden) {
      setConn("hidden");
      return;
    }
    try {
      const res = await authFetch("/api/broker/positions");
      if (res.status === 401) {
        setConn("error");
        return;
      }
      const payload = (await res.json()) as PositionsResponse;
      setData(payload);
      setConn("ok");
      setLastSync(Date.now());
      // Sync server open ids ke client book untuk mode paper maupun live —
      // shape response identik, tinggal server yang menentukan isinya.
      if (Array.isArray(payload.positions)) {
        onServerPositionsRef.current?.(
          payload.positions.filter((p) => p.status === "OPEN").map((p) => p.id)
        );
      }
    } catch {
      setConn("error");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isAuthenticated) return;
    const interval = setInterval(() => {
      load();
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    load();
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isAuthenticated, load]);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const handleClose = async (pos: ServerPosition) => {
    if (!window.confirm(`Tutup posisi ${pos.symbol}? Ini mengirim order lawan ke server.`)) return;
    setBusyId(pos.id);
    setActionError(null);
    try {
      const res = await authFetch("/api/broker/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: pos.id }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        const duplicateId = payload?.duplicatePositionId || payload?.existingPositionId;
        setActionError({
          reason: String(payload?.reason || `HTTP ${res.status}`),
          message: String(payload?.message || "Close gagal."),
          duplicatePositionId: duplicateId,
        });
        return;
      }
      await load();
    } catch (err) {
      setActionError({ reason: "NETWORK", message: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const handleBreakEven = async (pos: ServerPosition) => {
    setBusyId(pos.id);
    setActionError(null);
    try {
      const res = await authFetch("/api/broker/position/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: pos.id, breakEven: true }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        setActionError({
          reason: String(payload?.reason || `HTTP ${res.status}`),
          message: String(payload?.message || "Update posisi gagal."),
        });
        return;
      }
      await load();
    } catch (err) {
      setActionError({ reason: "NETWORK", message: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const account = data?.account;
  const openPositions =
    Array.isArray(data?.positions)
      ? data.positions.filter((p) => p.status === "OPEN").sort((a, b) => b.openedAt - a.openedAt)
      : [];

  const healthDot =
    conn === "ok" ? "bg-emerald-400" : conn === "error" ? "bg-rose-500" : "bg-zinc-600";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-zinc-800 rounded-xl flex items-center justify-center text-amber-400 border border-zinc-700/60">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 font-sans flex items-center gap-2">
              Open Positions
              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-bold font-mono ${
                  data?.mode === "live"
                    ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
                    : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                }`}
              >
                {data?.mode === "live" ? "LIVE" : "PAPER"}
              </span>
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
              Server Book /api/broker/positions (sumber kebenaran)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
          <span className={`w-2 h-2 rounded-full ${healthDot}`} />
          {lastSync ? (
            <span>
              SYNC {new Date(lastSync).toLocaleTimeString("en-GB", { hour12: false })}
            </span>
          ) : (
            <span>MENUNGGU POLL PERTAMA</span>
          )}
        </div>
      </div>

      {account ? (
        <>
          {/* Account summary strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4 font-mono">
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 block">Cash</span>
              <span className="text-sm font-bold text-zinc-100">${fmtMoney(account.cash)}</span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 block">Equity</span>
              <span className="text-sm font-bold text-zinc-100">${fmtMoney(account.equity)}</span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 block">Realized PnL</span>
              <span className={`text-sm font-bold ${account.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {account.realizedPnl >= 0 ? "+" : "-"}${fmtMoney(Math.abs(account.realizedPnl))}
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 block">Unrealized PnL</span>
              <span className={`text-sm font-bold ${account.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {account.unrealizedPnl >= 0 ? "+" : "-"}${fmtMoney(Math.abs(account.unrealizedPnl))}
              </span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 block">Open Positions</span>
              <span className="text-sm font-bold text-sky-400">{openPositions.length}</span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 block">Margin Locked</span>
              <span className="text-sm font-bold text-amber-400">${fmtMoney(account.marginLocked)}</span>
            </div>
          </div>

          {/* Inline action error banner */}
          {actionError && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-500/40 font-mono text-[11px] text-rose-300 flex items-start justify-between gap-2">
              <span>
                <strong>REJECTED ({actionError.reason}):</strong> {actionError.message}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                {actionError.duplicatePositionId && (
                  <button
                    onClick={async () => {
                      if (!window.confirm(`Tutup posisi yang sudah ada (${actionError.duplicatePositionId})?`)) return;
                      setBusyId(actionError.duplicatePositionId!);
                      try {
                        const res = await authFetch("/api/broker/close", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ positionId: actionError.duplicatePositionId }),
                        });
                        const payload = await res.json().catch(() => null);
                        if (!res.ok || !payload?.success) {
                          setActionError({
                            reason: String(payload?.reason || `HTTP ${res.status}`),
                            message: String(payload?.message || "Close gagal."),
                          });
                          return;
                        }
                        await load();
                        setActionError(null);
                      } catch (err) {
                        setActionError({ reason: "NETWORK", message: (err as Error).message });
                      } finally {
                        setBusyId(null);
                      }
                    }}
                    className="px-2.5 py-1 rounded bg-rose-600 hover:bg-rose-700 text-white text-[10px] font-bold transition"
                  >
                    Close existing
                  </button>
                )}
                <button
                  onClick={() => setActionError(null)}
                  className="text-rose-400 hover:text-rose-200 transition-colors shrink-0"
                  title="Tutup"
                >
                  <XCircle className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Open positions table */}
          {openPositions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80">
              <Zap className="w-8 h-8 text-zinc-600 mb-2" />
              <p className="text-xs font-mono text-zinc-400">Tidak ada posisi open.</p>
              <p className="text-[10px] font-mono text-zinc-600 mt-1">
                Posisi yang dibuka pipeline (/api/broker/order) akan muncul di sini
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
                    <th className="pb-2">Symbol</th>
                    <th className="pb-2">Side</th>
                    <th className="pb-2 text-right">Qty</th>
                    <th className="pb-2 text-right">Entry</th>
                    <th className="pb-2 text-right">Mark</th>
                    <th className="pb-2 text-right">uPnL $</th>
                    <th className="pb-2 text-right">uPnL %</th>
                    <th className="pb-2 text-right">SL</th>
                    <th className="pb-2 text-right">TP</th>
                    <th className="pb-2 text-right">Liq</th>
                    <th className="pb-2 text-right">Lev</th>
                    <th className="pb-2 text-right">Margin</th>
                    <th className="pb-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60">
                  {openPositions.map((pos) => {
                    const { pnlUSD, pnlPct } = unrealizedFor(pos);
                    const profitable = pnlUSD >= 0;
                    const rowTint = profitable
                      ? "bg-emerald-500/[0.04] hover:bg-emerald-500/[0.08]"
                      : "bg-rose-500/[0.04] hover:bg-rose-500/[0.08]";
                    const busy = busyId === pos.id;
                    const canBreakEven = Math.abs(pos.stopLoss - pos.entryPrice) > 1e-9;
                    return (
                      <tr key={pos.id} className={`transition-colors ${rowTint}`}>
                        <td className="py-2.5 font-bold text-zinc-200">{pos.symbol}</td>
                        <td className="py-2.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              normalizeSide(pos.side) === "LONG"
                                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                                : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                            }`}
                          >
                            {normalizeSide(pos.side)}
                          </span>
                        </td>
                        <td className="py-2.5 text-right text-zinc-300">{fmtNum(pos.qty)}</td>
                        <td className="py-2.5 text-right text-zinc-300">${fmtMoney(pos.entryPrice)}</td>
                        <td className="py-2.5 text-right text-zinc-100 font-semibold">
                          ${fmtMoney(pos.lastMark ?? pos.entryPrice)}
                        </td>
                        <td className={`py-2.5 text-right font-bold ${profitable ? "text-emerald-400" : "text-rose-400"}`}>
                          {profitable ? "+" : "-"}${fmtMoney(Math.abs(pnlUSD))}
                        </td>
                        <td className={`py-2.5 text-right ${profitable ? "text-emerald-400" : "text-rose-400"}`}>
                          {profitable ? "+" : "-"}{fmtMoney(Math.abs(pnlPct))}%
                        </td>
                        <td className="py-2.5 text-right text-rose-400">${fmtMoney(pos.stopLoss)}</td>
                        <td className="py-2.5 text-right text-emerald-400">${fmtMoney(pos.takeProfit)}</td>
                        <td className="py-2.5 text-right text-zinc-400">${fmtMoney(pos.liquidationPrice)}</td>
                        <td className="py-2.5 text-right text-zinc-300">{fmtNum(pos.leverage)}x</td>
                        <td className="py-2.5 text-right text-amber-400">${fmtMoney(pos.marginUSD)}</td>
                        <td className="py-2.5 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5">
                            {canBreakEven && (
                              <button
                                onClick={() => handleBreakEven(pos)}
                                disabled={busy}
                                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[10px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                title="Geser Stop Loss ke harga entry (break-even)"
                              >
                                Move to BE
                              </button>
                            )}
                            <button
                              onClick={() => handleClose(pos)}
                              disabled={busy}
                              className="px-2 py-1 rounded bg-zinc-800 hover:bg-rose-600 hover:text-white text-slate-300 border border-zinc-700 hover:border-rose-500 text-[10px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                              title="Tutup posisi via /api/broker/close"
                            >
                              {busy ? "CLOSING" : "Close"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-center py-10 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs font-mono text-zinc-500">
          Memuat data dari server broker...
        </div>
      )}
    </div>
  );
};