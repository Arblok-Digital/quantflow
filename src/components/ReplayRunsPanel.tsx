import React, { useCallback, useEffect, useRef, useState } from "react";
import { Database, Download } from "lucide-react";
import { authFetch, useAuth } from "../hooks/useAuth";

// ---------------------------------------------------------------------------
// ReplayRunsPanel — viewer riwayat replay_runs tersimpan (DB training data).
// GET /api/paper/replay/runs -> list; GET /runs/:id -> detail; ?format=csv -> unduh.
// Sebelumnya tabel replay_runs invisible di FE (hanya dipakai sebagai string
// prompt backtest). Panel ini menutup jalur DB → FE yang terputus.
// ---------------------------------------------------------------------------

interface ReplayRunSummary {
  id: string;
  symbol: string;
  timeframe: string;
  startTs: number;
  endTs: number;
  totalCandles: number;
  initialCash: number;
  finalEquity: number;
  realizedPnl: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  createdAt: number;
}

const POLL_MS = 10000;
const fmtMoney = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const ReplayRunsPanel: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [runs, setRuns] = useState<ReplayRunSummary[]>([]);
  const [conn, setConn] = useState<"ok" | "error" | "hidden" | "loading">("loading");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isAuthenticated) return;
    if (document.hidden) {
      setConn("hidden");
      return;
    }
    try {
      const res = await authFetch("/api/paper/replay/runs?limit=50");
      if (res.status === 401) {
        setConn("error");
        return;
      }
      const payload = await res.json().catch(() => null);
      if (payload?.success && Array.isArray(payload.runs)) {
        setRuns(payload.runs);
        setConn("ok");
        setLastSync(Date.now());
      } else {
        setConn("error");
      }
    } catch {
      setConn("error");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isAuthenticated) return;
    load();
    const iv = setInterval(load, POLL_MS);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isAuthenticated, load]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggleDetail = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await authFetch(`/api/paper/replay/runs/${encodeURIComponent(id)}`);
      const payload = await res.json().catch(() => null);
      if (payload?.success) setDetail(payload.dataset ?? payload.run ?? null);
    } catch {
      // keep collapsed detail empty
    } finally {
      setDetailLoading(false);
    }
  };

  const downloadCsv = async (id: string) => {
    try {
      const res = await authFetch(`/api/paper/replay/runs/${encodeURIComponent(id)}?format=csv`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `replay-${id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // silent — user bisa retry
    }
  };

  const healthDot =
    conn === "ok" ? "bg-emerald-400" : conn === "error" ? "bg-rose-500" : "bg-zinc-600";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-zinc-800 rounded-xl flex items-center justify-center text-cyan-400 border border-zinc-700/60">
            <Database className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 font-sans flex items-center gap-2">
              Replay Runs Tersimpan
              <span className="px-2 py-0.5 rounded border text-[10px] font-bold font-mono bg-cyan-500/15 text-cyan-300 border-cyan-500/30">
                DB • /api/paper/replay/runs
              </span>
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
              Training data history — hasil export replay
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
          <span className={`w-2 h-2 rounded-full ${healthDot}`} />
          {lastSync ? (
            <span>SYNC {new Date(lastSync).toLocaleTimeString("en-GB", { hour12: false })}</span>
          ) : (
            <span>{conn === "loading" ? "MEMUAT RUNS..." : "MENUNGGU SYNC"}</span>
          )}
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80">
          <Database className="w-7 h-7 text-zinc-600 mb-2" />
          <p className="text-xs font-mono text-zinc-400">Belum ada replay run tersimpan.</p>
          <p className="text-[11px] font-mono text-zinc-600 mt-1">
            Jalankan sesi replay di atas lalu klik Export untuk menyimpan ke DB.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
                <th className="pb-2">Run</th>
                <th className="pb-2">Symbol/TF</th>
                <th className="pb-2 text-right">Candles</th>
                <th className="pb-2 text-right">Trades</th>
                <th className="pb-2 text-right">Win%</th>
                <th className="pb-2 text-right">PF</th>
                <th className="pb-2 text-right">MaxDD</th>
                <th className="pb-2 text-right">PnL</th>
                <th className="pb-2 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {runs.map((r) => (
                <React.Fragment key={r.id}>
                  <tr className="hover:bg-zinc-800/30">
                    <td className="py-2.5 text-zinc-400 text-[11px]">
                      {r.id}
                      <span className="block text-zinc-600">
                        {new Date(r.createdAt).toLocaleString("id-ID")}
                      </span>
                    </td>
                    <td className="py-2.5 font-bold text-zinc-200">
                      {r.symbol} <span className="text-zinc-500 font-normal">{r.timeframe}</span>
                    </td>
                    <td className="py-2.5 text-right text-zinc-300">{r.totalCandles}</td>
                    <td className="py-2.5 text-right text-zinc-300">{r.totalTrades}</td>
                    <td className="py-2.5 text-right text-zinc-300">{Number(r.winRate).toFixed(1)}%</td>
                    <td className="py-2.5 text-right text-zinc-300">{Number(r.profitFactor).toFixed(2)}</td>
                    <td className="py-2.5 text-right text-amber-400">{Number(r.maxDrawdownPct).toFixed(2)}%</td>
                    <td className={`py-2.5 text-right font-bold ${r.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {r.realizedPnl >= 0 ? "+" : "-"}${fmtMoney(Math.abs(r.realizedPnl))}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button type="button"
                          onClick={() => toggleDetail(r.id)}
                          className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[10px] transition-colors"
                        >
                          {expandedId === r.id ? "Tutup" : "Detail"}
                        </button>
                        <button type="button"
                          onClick={() => downloadCsv(r.id)}
                          className="px-2 py-1 rounded bg-zinc-800 hover:bg-cyan-600 hover:text-white text-zinc-300 border border-zinc-700 text-[10px] transition-colors flex items-center gap-1"
                          title="Unduh CSV trades"
                        >
                          <Download className="w-3 h-3" /> CSV
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === r.id && (
                    <tr>
                      <td colSpan={9} className="pb-3">
                        <div className="rounded-lg bg-zinc-950 border border-zinc-800 p-3">
                          {detailLoading ? (
                            <p className="text-[11px] font-mono text-zinc-500">Memuat detail...</p>
                          ) : detail ? (
                            <pre className="overflow-x-auto text-[10px] text-cyan-300/90 font-mono leading-relaxed max-h-64 overflow-y-auto">
                              {JSON.stringify(detail.stats ?? detail, null, 2)}
                            </pre>
                          ) : (
                            <p className="text-[11px] font-mono text-zinc-500">Detail tidak tersedia.</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ReplayRunsPanel;
