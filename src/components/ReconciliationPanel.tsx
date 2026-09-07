import React, { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import { Scale, CheckCircle2, AlertTriangle, RefreshCw, ShieldCheck, Activity } from "lucide-react";

const POLL_MS = 5000;

// Mirrors Keel reconciliation_reports shape
interface ReconReport {
  timestamp: number;
  isSynced: boolean;
  localBalanceUsd: string | number;
  exchangeBalanceUsd: string | number;
  discrepancyUsd: string | number;
  breakdown?: Record<string, unknown> | null;
}

interface ServerReconResponse {
  success?: boolean;
  report?: ReconReport;
  latest?: ReconReport;
}

/**
 * Reconciliation Panel — live balance reconciliation between local (Neural
 * ledger / paper account) and exchange (Binance).
 *
 * Pulls from the Neural API. Honest: if no data available, shows an explicit
 * "no reconciliation report yet" state rather than fabricating one.
 * Ports Keel ledger-sync concept (localEquity vs exchangeEquity, discrepancy,
 * isSynced verdict, kill-switch on breach).
 */
export const ReconciliationPanel: React.FC = () => {
  const [report, setReport] = useState<ReconReport | null>(null);
  const [conn, setConn] = useState<"ok" | "loading" | "error" | "none">("loading");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (document.hidden) return;
    try {
      // Try API endpoint — server may or may not expose reconciliation route
      const res = await authFetch("/api/reconciliation/latest");
      if (res.status === 404) {
        setConn("none");
        return;
      }
      const payload = (await res.json().catch(() => null)) as ServerReconResponse | null;
      const found = payload?.report ?? payload?.latest;
      if (found && typeof found.timestamp === "number") {
        setReport(found);
        setConn("ok");
        setLastSync(Date.now());
      } else if (payload?.success && !found) {
        setConn("none");
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

  const fmtUsd = (v: string | number) => {
    const n = Number(v ?? 0);
    if (!isFinite(n)) return "–";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const healthDot =
    conn === "ok"
      ? report?.isSynced
        ? "bg-emerald-400"
        : "bg-rose-500"
      : conn === "none"
      ? "bg-zinc-500"
      : conn === "error"
      ? "bg-rose-500"
      : "bg-zinc-500";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-emerald-500/10 rounded-xl flex items-center justify-center text-emerald-400 border border-emerald-500/30">
            <Scale className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              Reconciliation
              <span className="px-2 py-0.5 rounded border text-[10px] font-bold font-mono bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                LEDGER ⇄ EXCHANGE
              </span>
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
              Local equity vs exchange balance — discrepancy breach → kill switch
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
          <span className={`w-2 h-2 rounded-full ${healthDot}`} />
          {lastSync ? (
            <span>SYNC {new Date(lastSync).toLocaleTimeString("en-GB", { hour12: false })}</span>
          ) : (
            <span>{conn === "loading" ? "MEMUAT..." : "NO DATA"}</span>
          )}
          <button
            onClick={load}
            disabled={conn === "loading"}
            className="px-2 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[10px] font-mono border border-zinc-700 disabled:opacity-50 transition flex items-center gap-1"
          >
            <RefreshCw className={`w-3 h-3 ${conn === "loading" ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {conn === "none" ? (
        <div className="flex flex-col items-center justify-center py-12 px-4 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80">
          <Scale className="w-7 h-7 text-zinc-600 mb-2" />
          <p className="text-xs font-mono font-bold text-zinc-300">Belum ada laporan rekonsiliasi</p>
          <p className="text-[11px] font-mono text-zinc-500 mt-1 max-w-md">
            Endpoint reconciliation belum menyediakan report. Ini status jujur — tidak ada angka fiktif yang ditampilkan.
          </p>
        </div>
      ) : conn === "error" ? (
        <div className="flex flex-col items-center justify-center py-12 px-4 text-center bg-zinc-950/60 rounded-xl border border-rose-500/20">
          <AlertTriangle className="w-6 h-6 text-rose-400 mb-2" />
          <p className="text-xs font-mono font-bold text-rose-300">Gagal memuat reconciliation</p>
          <p className="text-[11px] font-mono text-zinc-500 mt-1">Periksa auth / koneksi server.</p>
        </div>
      ) : !report ? (
        <div className="flex items-center justify-center py-12 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs font-mono text-zinc-500 animate-pulse">
          Memuat laporan reconciliation...
        </div>
      ) : (
        <div className="space-y-4">
          {/* Breach banner */}
          <div
            className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg border ${
              report.isSynced
                ? "bg-emerald-950/20 border-emerald-500/30"
                : "bg-rose-950/30 border-rose-500/40"
            }`}
          >
            {report.isSynced ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            )}
            <div>
              <div className={`text-xs font-bold font-mono ${report.isSynced ? "text-emerald-300" : "text-rose-300"}`}>
                {report.isSynced ? "LEDGER SYNCED" : "DISCREPANCY BREACH — KILL SWITCH ENGAGED"}
              </div>
              <div className="text-[11px] font-mono text-zinc-400">
                {new Date(report.timestamp).toLocaleString("id-ID")}
              </div>
            </div>
          </div>

          {/* Balance cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono">
            <div className="bg-zinc-950/70 rounded-xl p-3.5 border border-zinc-800">
              <div className="text-[10px] uppercase text-zinc-500 flex items-center gap-1 mb-1">
                <Scale className="w-3 h-3" /> LOCAL EQUITY
              </div>
              <div className="text-xl font-black text-zinc-100">${fmtUsd(report.localBalanceUsd)}</div>
              <div className="text-[10px] text-zinc-600">Neural ledger / paper account</div>
            </div>
            <div className="bg-zinc-950/70 rounded-xl p-3.5 border border-zinc-800">
              <div className="text-[10px] uppercase text-zinc-500 flex items-center gap-1 mb-1">
                <ShieldCheck className="w-3 h-3" /> EXCHANGE EQUITY
              </div>
              <div className="text-xl font-black text-zinc-100">${fmtUsd(report.exchangeBalanceUsd)}</div>
              <div className="text-[10px] text-zinc-600">Exchange (Binance) balance</div>
            </div>
            <div className={`bg-zinc-950/70 rounded-xl p-3.5 border ${report.isSynced ? "border-emerald-500/30" : "border-rose-500/40"}`}>
              <div className="text-[10px] uppercase text-zinc-500 flex items-center gap-1 mb-1">
                <Activity className="w-3 h-3" /> DISCREPANCY
              </div>
              <div className={`text-xl font-black ${Number(report.discrepancyUsd) === 0 ? "text-emerald-400" : "text-rose-400"}`}>
                ${fmtUsd(report.discrepancyUsd)}
              </div>
              <div className="text-[10px] text-zinc-600">
                {Number(report.discrepancyUsd) === 0 ? "IN SYNC" : "MISMATCH"}
              </div>
            </div>
          </div>

          {report.breakdown && Object.keys(report.breakdown).length > 0 && (
            <div className="bg-zinc-950/60 rounded-xl border border-zinc-800 p-3.5">
              <div className="text-[10px] uppercase text-zinc-400 font-mono font-bold mb-2">BREAKDOWN (per asset)</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px]">
                {Object.entries(report.breakdown as Record<string, { localUsd?: number; exchangeUsd?: number }>).map(
                  ([asset, b]) => (
                    <div key={asset} className="flex items-center justify-between bg-zinc-900 rounded-lg px-2.5 py-1.5 border border-zinc-800">
                      <span className="text-zinc-300 font-bold">{asset}</span>
                      <span className="text-zinc-500">
                        L: <span className="text-emerald-400">${fmtUsd(Number(b.localUsd ?? 0))}</span> • E:{" "}
                        <span className="text-amber-400">${fmtUsd(Number(b.exchangeUsd ?? 0))}</span>
                      </span>
                    </div>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ReconciliationPanel;
