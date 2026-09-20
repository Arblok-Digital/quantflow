import React, { useCallback, useEffect, useRef, useState } from "react";
import { ScannerCandidate } from "../types";
import { fetchScannerCandidates } from "../logic/scannerEngine";
import { authFetch } from "../hooks/useAuth";
import {
  Radar,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Minus,
  ArrowUpRight,
  ArrowDownRight,
  Activity,
  Layers,
  ShieldCheck,
  AlertTriangle,
  Zap,
  Droplets,
} from "lucide-react";

const POLL_MS = 20_000;
const MAX_ROWS = 20;

interface ScannerPanelProps {
  currentSymbol: string;
  onSelectSymbol?: (symbol: string) => void;
}

export const ScannerPanel: React.FC<ScannerPanelProps> = ({ currentSymbol, onSelectSymbol }) => {
  const [candidates, setCandidates] = useState<ScannerCandidate[]>([]);
  const [conn, setConn] = useState<"ok" | "loading" | "error">("loading");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (document.hidden) return;
    try {
      const res = await fetchScannerCandidates(MAX_ROWS);
      if (res.top.length > 0) {
        setCandidates(res.top);
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
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      mountedRef.current = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const healthDot =
    conn === "ok" ? "bg-emerald-400"
    : conn === "error" ? "bg-rose-500"
    : "bg-zinc-500";

  const flowBadge = (flow: string) => {
    if (flow === "ACCUMULATION")
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
          <ArrowUpRight className="w-2.5 h-2.5" /> ACC
        </span>
      );
    if (flow === "DISTRIBUTION")
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border bg-rose-500/15 text-rose-400 border-rose-500/30">
          <ArrowDownRight className="w-2.5 h-2.5" /> DIST
        </span>
      );
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold border bg-zinc-800 text-zinc-400 border-zinc-700">
        <Minus className="w-2.5 h-2.5" /> NEUT
      </span>
    );
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-amber-500/10 rounded-xl flex items-center justify-center text-amber-400 border border-amber-500/30">
            <Radar className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              All-Ticker Scanner
              <span className="px-2 py-0.5 rounded border text-[10px] font-bold font-mono bg-amber-500/15 text-amber-300 border-amber-500/30">
                LIQUIDITY • SMC
              </span>
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
              Top liquidity & early-swing candidates — real Binance tickers
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
          <span className={`w-2 h-2 rounded-full ${healthDot}`} />
          {lastSync ? (
            <span>SYNC {new Date(lastSync).toLocaleTimeString("en-GB", { hour12: false })}</span>
          ) : (
            <span>{conn === "loading" ? "MEMUAT TICKERS..." : "OFFLINE"}</span>
          )}
          <button type="button"
            onClick={load}
            disabled={conn === "loading"}
            className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-mono border border-zinc-700 disabled:opacity-50 transition flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${conn === "loading" ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {conn === "loading" && candidates.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs font-mono text-zinc-500 animate-pulse">
          Memuat ticker dari Binance public API...
        </div>
      ) : conn === "error" && candidates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-4 text-center bg-zinc-950/60 rounded-xl border border-rose-500/20">
          <AlertTriangle className="w-6 h-6 text-rose-400 mb-2" />
          <p className="text-xs font-mono font-bold text-rose-300">Tidak dapat memuat data ticker</p>
          <p className="text-[11px] font-mono text-zinc-500 mt-1">Binance public API tidak dapat diakses — coba lagi nanti.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Table column (2/3) */}
          <div className="lg:col-span-2 overflow-x-auto max-h-[520px] rounded-xl border border-zinc-800 bg-zinc-950">
            <table className="w-full text-left font-mono text-xs">
              <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
                <tr>
                  <th className="p-2.5">#</th>
                  <th className="p-2.5">Symbol</th>
                  <th className="p-2.5 text-right">Price</th>
                  <th className="p-2.5 text-right">24h%</th>
                  <th className="p-2.5 text-right">Vol 24h</th>
                  <th className="p-2.5">Flow</th>
                  <th className="p-2.5 text-right">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {candidates.map((c, i) => {
                  const up = c.change24hPct >= 0;
                  const isCurrent = currentSymbol.replace("/", "") === c.symbol || currentSymbol === c.symbol;
                  return (
                    <tr
                      key={c.symbol}
                      onClick={() => onSelectSymbol?.(`${c.symbol.slice(0, -4)}/${c.symbol.slice(-4)}`)}
                      className={`hover:bg-zinc-800/40 cursor-pointer transition ${isCurrent ? "bg-amber-500/5" : ""}`}
                    >
                      <td className="p-2.5 text-zinc-600">{i + 1}</td>
                      <td className="p-2.5 font-bold text-zinc-100">
                        {c.symbol}
                        {isCurrent && (
                          <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">ACTIVE</span>
                        )}
                        {c.liquidityDataSource === "ORDERBOOK" && (
                          <span className="ml-1.5" title="Liquidity dari orderbook">
                            <Droplets className="w-3 h-3 inline text-cyan-400" />
                          </span>
                        )}
                      </td>
                      <td className="p-2.5 text-right text-zinc-300">${c.price.toFixed(4)}</td>
                      <td className={`p-2.5 text-right font-bold ${up ? "text-emerald-400" : "text-rose-400"}`}>
                        {up ? "+" : ""}{c.change24hPct.toFixed(2)}%
                      </td>
                      <td className="p-2.5 text-right text-zinc-400">
                        ${c.volumeUsd24h >= 1_000_000_000 ? (c.volumeUsd24h / 1_000_000_000).toFixed(1) + "B" : (c.volumeUsd24h / 1_000_000).toFixed(0) + "M"}
                      </td>
                      <td className="p-2.5">{flowBadge(c.flow)}</td>
                      <td className="p-2.5 text-right">
                        <span className={`font-black ${c.score >= 66 ? "text-emerald-400" : c.score < 36 ? "text-rose-400" : "text-zinc-200"}`}>
                          {c.score}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Right column: Top pick + honesty ledger */}
          <div className="space-y-3">
            {/* Top pick card */}
            <div className="bg-zinc-950/80 rounded-xl border border-amber-500/30 p-3.5">
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-amber-400 font-bold uppercase mb-2">
                <Zap className="w-3 h-3" /> TOP CANDIDATE
              </div>
              {candidates[0] ? (
                <>
                  <div className="text-lg font-black font-mono text-zinc-100">{candidates[0].symbol}</div>
                  <div className="text-[11px] font-mono text-zinc-400 mt-1">
                    Score: <span className="text-emerald-400 font-bold">{candidates[0].score}</span> •{" "}
                    {candidates[0].flow}
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2 font-mono text-[10px]">
                    <div className="bg-zinc-900 rounded-lg p-2 border border-zinc-800">
                      <span className="text-zinc-500 block">PRICE</span>
                      <span className="text-zinc-200 font-bold">${candidates[0].price.toFixed(4)}</span>
                    </div>
                    <div className="bg-zinc-900 rounded-lg p-2 border border-zinc-800">
                      <span className="text-zinc-500 block">24H CHG</span>
                      <span className={`font-bold ${candidates[0].change24hPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {candidates[0].change24hPct >= 0 ? "+" : ""}{candidates[0].change24hPct.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-xs font-mono text-zinc-500">Tidak ada data.</div>
              )}
            </div>

            {/* Honesty banner */}
            <div className="bg-zinc-950/60 rounded-xl border border-zinc-800 p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-400 font-bold uppercase mb-2">
                <ShieldCheck className="w-3 h-3 text-emerald-400" /> PROVENANCE
              </div>
              <p className="text-[11px] font-mono text-zinc-500 leading-relaxed">
                {candidates.filter((c) => c.liquidityDataSource === "ORDERBOOK").length > 0
                  ? `Liquidity dari real orderbook enrichment untuk top picks.`
                  : `Liquidity depth (ORDERBOOK) belum di-enrich — menampilkan N/A jujur, bukan angka palsu.`}
              </p>
            </div>

            {/* SMC alignment legend */}
            <div className="bg-zinc-950/60 rounded-xl border border-zinc-800 p-3">
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-400 font-bold uppercase mb-2">
                <Layers className="w-3 h-3 text-cyan-400" /> SMC ALIGNMENT
              </div>
              <div className="space-y-1.5 font-mono text-[10px] text-zinc-400">
                <div className="flex items-center gap-2"><TrendingUp className="w-3 h-3 text-emerald-400" /> <span>ACCUMULATION — smart money akumulasi</span></div>
                <div className="flex items-center gap-2"><TrendingDown className="w-3 h-3 text-rose-400" /> <span>DISTRIBUTION — distribusi/distributing</span></div>
                <div className="flex items-center gap-2"><Activity className="w-3 h-3 text-zinc-500" /> <span>Scan memberi skor 0-100</span></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScannerPanel;
