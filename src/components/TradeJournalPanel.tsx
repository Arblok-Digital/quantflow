import React, { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Award,
  Activity,
  Percent,
  DollarSign,
  Clock,
  Info,
  LineChart,
  AlertCircle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// TradeJournalPanel — DB-backed journal & equity curve (roadmap 3.5)
// GET /api/ledger/stats -> stat cards, closedTrades, equityCurve
// Poll 3.5s paused while hidden. Honest empty states. No fabricated numbers.
// ---------------------------------------------------------------------------

interface StatsClosedTrade {
  id: string;
  symbol: string;
  side: string;
  entryPrice: number;
  closePrice: number | null;
  amount: number;
  realizedPnlUsd: number | null;
  openedAt: number;
  closedAt: number | null;
  status: string;
}

interface StatsResponse {
  success?: boolean;
  totalTrades: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgSlippageBps: number;
  realizedPnlUSD: number;
  closedTrades: StatsClosedTrade[];
  equityCurve: Array<{ ts: number; equity: number }>;
}

const POLL_MS = 5000;

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(n: number): string {
  return typeof n === "number" && isFinite(n) ? n.toFixed(2) : "–";
}
function formatDuration(openedAt: number, closedAt: number | null): string {
  if (!closedAt || !openedAt) return "–";
  const diff = Math.max(0, closedAt - openedAt);
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `${hrs}h ${rem}m`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return `${days}d ${rh}h`;
}

function EquityCurveSVG({ curve }: { curve: Array<{ ts: number; equity: number }> }) {
  if (!curve || curve.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 bg-zinc-950/60 rounded-xl border border-dashed border-zinc-800 text-center">
        <LineChart className="w-7 h-7 text-zinc-600 mb-2" />
        <p className="text-xs font-mono text-zinc-400">Belum ada equity curve — belum ada trade / snapshot.</p>
        <p className="text-[11px] font-mono text-zinc-600 mt-1">Curve akan muncul setelah ada posisi & snapshot portfolio dari server.</p>
      </div>
    );
  }
  if (curve.length === 1) {
    return (
      <div className="flex flex-col items-center justify-center py-8 px-4 bg-zinc-950/60 rounded-xl border border-zinc-800 text-center">
        <LineChart className="w-7 h-7 text-zinc-600 mb-2" />
        <p className="text-xs font-mono text-zinc-400">Equity curve baru 1 titik — butuh ≥2 snapshot untuk garis.</p>
        <p className="text-[11px] font-mono text-zinc-500 mt-1">Equity: ${fmtMoney(curve[0].equity)} @ {new Date(curve[0].ts).toLocaleTimeString("id-ID")}</p>
      </div>
    );
  }

  const W = 640;
  const H = 160;
  const PAD_L = 40;
  const PAD_R = 12;
  const PAD_T = 16;
  const PAD_B = 24;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  let minEq = Infinity;
  let maxEq = -Infinity;
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const p of curve) {
    if (p.equity < minEq) minEq = p.equity;
    if (p.equity > maxEq) maxEq = p.equity;
    if (p.ts < minTs) minTs = p.ts;
    if (p.ts > maxTs) maxTs = p.ts;
  }
  // add breathing room
  const eqSpan = Math.max(1, maxEq - minEq);
  const yPad = eqSpan * 0.12 || 10;
  const yMin = minEq - yPad;
  const yMax = maxEq + yPad;
  const spanTs = Math.max(1, maxTs - minTs);

  const xFor = (ts: number) => PAD_L + ((ts - minTs) / spanTs) * plotW;
  const yFor = (eq: number) => PAD_T + (1 - (eq - yMin) / (yMax - yMin)) * plotH;

  const linePath = curve.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(p.ts).toFixed(2)} ${yFor(p.equity).toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L ${xFor(curve[curve.length - 1].ts).toFixed(2)} ${(PAD_T + plotH).toFixed(2)} L ${xFor(curve[0].ts).toFixed(2)} ${(PAD_T + plotH).toFixed(2)} Z`;

  return (
    <div className="bg-zinc-950 rounded-xl border border-zinc-800 p-3">
      <div className="flex items-center justify-between mb-2 font-mono text-[11px] text-zinc-500">
        <span>Equity Curve (server snapshots)</span>
        <span className="flex items-center gap-3">
          <span className="text-emerald-400 font-bold">max ${fmtMoney(maxEq)}</span>
          <span className="text-rose-400 font-bold">min ${fmtMoney(minEq)}</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[160px] block" preserveAspectRatio="none">
          {/* grid */}
          <g className="text-zinc-800" stroke="currentColor" strokeWidth="0.7" strokeDasharray="3 4" opacity={0.45}>
            <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + plotH * 0.25} y2={PAD_T + plotH * 0.25} />
            <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + plotH * 0.5} y2={PAD_T + plotH * 0.5} />
            <line x1={PAD_L} x2={W - PAD_R} y1={PAD_T + plotH * 0.75} y2={PAD_T + plotH * 0.75} />
          </g>
          {/* Y labels */}
          <text x={PAD_L - 6} y={PAD_T + 8} textAnchor="end" fontSize="9" fill="#71717a" fontFamily="ui-monospace, monospace">{fmtMoney(yMax)}</text>
          <text x={PAD_L - 6} y={PAD_T + plotH + 4} textAnchor="end" fontSize="9" fill="#71717a" fontFamily="ui-monospace, monospace">{fmtMoney(yMin)}</text>
          {/* X labels */}
          <text x={PAD_L} y={H - 4} textAnchor="start" fontSize="9" fill="#52525b" fontFamily="ui-monospace, monospace">{new Date(minTs).toLocaleDateString("id-ID")}</text>
          <text x={W - PAD_R} y={H - 4} textAnchor="end" fontSize="9" fill="#52525b" fontFamily="ui-monospace, monospace">{new Date(maxTs).toLocaleDateString("id-ID")}</text>

          {/* area fill */}
          <path d={areaPath} fill="rgba(16,185,129,0.12)" stroke="none" />
          {/* line */}
          <path d={linePath} fill="none" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          {/* dots */}
          {curve.map((p, i) => (
            <circle key={i} cx={xFor(p.ts)} cy={yFor(p.equity)} r={i === 0 || i === curve.length - 1 ? 2.8 : 1.6} fill={p.equity >= (curve[Math.max(0, i - 1)]?.equity ?? p.equity) ? "#10b981" : "#f43f5e"} stroke="#09090b" strokeWidth={0.9} />
          ))}
        </svg>
      </div>
      <div className="flex justify-between text-[10px] font-mono text-zinc-600 mt-1">
        <span>{curve.length} snapshots</span>
        <span>Δ {(maxEq - minEq >= 0 ? "+" : "") + fmtMoney(maxEq - minEq)}</span>
      </div>
    </div>
  );
}

export const TradeJournalPanel: React.FC = () => {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [conn, setConn] = useState<"ok" | "error" | "hidden" | "loading">("loading");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (document.hidden) {
      setConn("hidden");
      return;
    }
    try {
      const res = await authFetch("/api/ledger/stats");
      if (res.status === 401) {
        setConn("error");
        return;
      }
      const payload = (await res.json()) as StatsResponse;
      if (payload && typeof payload.totalTrades === "number") {
        setStats(payload);
        setConn("ok");
        setLastSync(Date.now());
      } else {
        setConn("error");
      }
    } catch {
      setConn("error");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const iv = setInterval(load, POLL_MS);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      mountedRef.current = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const hasTrades = stats ? stats.totalTrades > 0 : false;
  const healthDot = conn === "ok" ? "bg-emerald-400" : conn === "error" ? "bg-rose-500" : "bg-zinc-600";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-zinc-800 rounded-xl flex items-center justify-center text-sky-400 border border-zinc-700/60">
            <BarChart3 className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              Trade Journal & Equity Curve
              <span className="px-2 py-0.5 rounded border text-[10px] font-bold font-mono bg-sky-500/15 text-sky-300 border-sky-500/30">
                DB • /api/ledger/stats
              </span>
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Historis dari DB — bukan in-memory • polling 3.5s</p>
          </div>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
          <span className={`w-2 h-2 rounded-full ${healthDot}`} />
          {lastSync ? <span>SYNC {new Date(lastSync).toLocaleTimeString("en-GB", { hour12: false })}</span> : <span>{conn === "loading" ? "MEMUAT STATS..." : "MENUNGGU SYNC"}</span>}
        </div>
      </div>

      {!stats ? (
        <div className="flex items-center justify-center py-10 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs font-mono text-zinc-500">
          {conn === "error" ? "Gagal memuat /api/ledger/stats — periksa auth / koneksi server." : "Memuat statistik dari server..."}
        </div>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 font-mono mb-4">
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 flex items-center gap-1"><Activity className="w-3 h-3" /> Total Trades</span>
              <span className="text-sm font-bold text-zinc-100 block mt-1">{stats.totalTrades}</span>
              <span className="text-[10px] text-zinc-600">closed</span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 flex items-center gap-1"><Percent className="w-3 h-3" /> Win Rate</span>
              <span className={`text-sm font-bold block mt-1 ${hasTrades ? (stats.winRate >= 50 ? "text-emerald-400" : "text-rose-400") : "text-zinc-500"}`}>{hasTrades ? `${stats.winRate.toFixed(2)}%` : "–"}</span>
              <span className="text-[10px] text-zinc-600">{hasTrades ? `${stats.totalTrades} trades` : "no trades"}</span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 flex items-center gap-1">
                Avg R
                <span className="group relative inline-flex items-center">
                  <Info className="w-3 h-3 text-zinc-500" />
                  <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 hidden group-hover:block whitespace-nowrap bg-zinc-800 text-zinc-200 text-[10px] px-2 py-1 rounded border border-zinc-700 z-10">
                    R = PnL / risk (|entry-SL|×amount)
                  </span>
                </span>
              </span>
              <span className={`text-sm font-bold block mt-1 ${hasTrades ? (stats.avgR >= 0 ? "text-emerald-400" : "text-rose-400") : "text-zinc-500"}`}>{hasTrades ? fmtNum(stats.avgR) : "–"}</span>
              <span className="text-[10px] text-zinc-600">R multiple</span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 flex items-center gap-1"><Award className="w-3 h-3" /> Profit Factor</span>
              <span className={`text-sm font-bold block mt-1 ${hasTrades ? (stats.profitFactor >= 1 ? "text-emerald-400" : "text-rose-400") : "text-zinc-500"}`}>{hasTrades ? fmtNum(stats.profitFactor) : "–"}</span>
              <span className="text-[10px] text-zinc-600">gross P / gross L</span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 flex items-center gap-1"><TrendingDown className="w-3 h-3" /> Max DD</span>
              <span className={`text-sm font-bold block mt-1 ${stats.maxDrawdownPct > 0 ? "text-rose-400" : "text-zinc-100"}`}>{fmtNum(stats.maxDrawdownPct)}%</span>
              <span className="text-[10px] text-zinc-600">drawdown %</span>
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] uppercase text-zinc-500 flex items-center gap-1"><DollarSign className="w-3 h-3" /> Net PnL</span>
              <span className={`text-sm font-bold block mt-1 ${stats.realizedPnlUSD > 0 ? "text-emerald-400" : stats.realizedPnlUSD < 0 ? "text-rose-400" : "text-zinc-100"}`}>
                {stats.realizedPnlUSD >= 0 ? "+" : "-"}${fmtMoney(Math.abs(stats.realizedPnlUSD))}
              </span>
              <span className="text-[10px] text-zinc-600">realized USD</span>
            </div>
          </div>

          {/* Extra small stats row */}
          <div className="flex flex-wrap gap-2 font-mono text-[11px] text-zinc-500 mb-4">
            <span className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800">avgSlippage <strong className="text-zinc-300">{fmtNum(stats.avgSlippageBps)} bps</strong></span>
          </div>

          {/* Empty state honest */}
          {!hasTrades && (
            <div className="flex flex-col items-center justify-center py-6 px-4 mb-4 bg-amber-950/20 border border-amber-500/20 rounded-xl text-center">
              <AlertCircle className="w-6 h-6 text-amber-400 mb-2" />
              <p className="text-xs font-mono font-bold text-amber-300">Belum ada trade tertutup</p>
              <p className="text-[11px] font-mono text-zinc-500 mt-1 max-w-md">Semua metrik di atas akan terisi setelah ada posisi yang tertutup via server (TP/SL / manual close). Tidak ada angka palsu yang ditampilkan.</p>
            </div>
          )}

          {/* Equity Curve */}
          <div className="mb-4">
            <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-400 mb-2 flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> Equity Curve
              <span className="text-[10px] text-zinc-600 normal-case">({stats.equityCurve.length} points)</span>
            </h3>
            <EquityCurveSVG curve={stats.equityCurve} />
          </div>

          {/* Closed trades table */}
          <div>
            <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-400 mb-2 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-zinc-400" /> Closed Trades <span className="text-[10px] text-zinc-600 normal-case">({stats.closedTrades.length})</span>
            </h3>
            {stats.closedTrades.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80">
                <BarChart3 className="w-7 h-7 text-zinc-600 mb-2" />
                <p className="text-xs font-mono text-zinc-400">Belum ada trade tertutup</p>
                <p className="text-[11px] font-mono text-zinc-600 mt-1">Tabel akan terisi setelah bracket monitor / manual close menyimpan ke DB.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
                      <th className="pb-2">Symbol</th>
                      <th className="pb-2">Side</th>
                      <th className="pb-2 text-right">Entry → Close</th>
                      <th className="pb-2 text-right">Amount</th>
                      <th className="pb-2 text-right">PnL</th>
                      <th className="pb-2">Status</th>
                      <th className="pb-2 text-right">Durasi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {stats.closedTrades.map((t) => {
                      const pnl = t.realizedPnlUsd ?? 0;
                      const win = pnl > 0;
                      const loss = pnl < 0;
                      const entry = t.entryPrice;
                      const exit = t.closePrice ?? entry;
                      return (
                        <tr key={t.id} className="hover:bg-zinc-800/30">
                          <td className="py-2.5 font-bold text-zinc-200">{t.symbol}</td>
                          <td className="py-2.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${t.side === "LONG" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-rose-500/15 text-rose-400 border-rose-500/30"}`}>
                              {t.side}
                            </span>
                          </td>
                          <td className="py-2.5 text-right text-zinc-300 whitespace-nowrap">
                            ${fmtMoney(entry)} <span className="text-zinc-600">→</span> ${fmtMoney(exit)}
                          </td>
                          <td className="py-2.5 text-right text-zinc-400">{Number(t.amount).toFixed(4)}</td>
                          <td className={`py-2.5 text-right font-bold ${win ? "text-emerald-400" : loss ? "text-rose-400" : "text-zinc-400"}`}>
                            {win ? "+" : ""}${fmtMoney(pnl)}
                          </td>
                          <td className="py-2.5">
                            <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[10px] border border-zinc-700">{t.status}</span>
                          </td>
                          <td className="py-2.5 text-right text-zinc-500">{formatDuration(t.openedAt, t.closedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default TradeJournalPanel;
