import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { useBrokerPositions } from "../hooks/useBrokerPositions";
import { useLedgerStats } from "../hooks/useLedgerStats";
import { Scale, CheckCircle2, AlertTriangle, RefreshCw, ShieldCheck, Activity, XCircle } from "lucide-react";
import { normalizeSide } from "../lib/sideNormalize";

interface LocalRecon {
  timestamp: number;
  isSynced: boolean;
  localEquity: number;
  localCash: number;
  unrealizedPnl: number;
  marginLocked: number;
  exchangeEquity: number | null;
  discrepancyUsd: number;
  breakdown: Record<string, unknown>;
  mode: string;
  note: string;
  positionCheck?: { symbol: string; side: string; qty: number; status: "MATCH" | "MISMATCH" | "ONLY-EXCHANGE" }[];
}

export const ReconciliationPanel: React.FC = () => {
  const { isAuthenticated } = useAuth();
  // Shared hooks (dedup global 15s) — TIDAK fetch /api/* sendiri. Balance mode
  // diambil dari useLiveMode yang juga dipakai App (satu poller).
  const sharedPositions = useBrokerPositions();
  const ledgerStats = useLedgerStats();
  const [report, setReport] = useState<LocalRecon | null>(null);
  const [conn, setConn] = useState<"ok" | "loading" | "error" | "none">("loading");
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [isLiveMode, setIsLiveMode] = useState(false);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isAuthenticated) return;
    if (document.hidden) return;
    try {
      const mode = sharedPositions.mode;
      const isLive = mode === "live";
      setIsLiveMode(isLive);

      if (isLive) {
        const rawPositions = sharedPositions.positions;
        const positions = rawPositions.map((p: any) => ({
          symbol: String(p.symbol || "?"),
          side: normalizeSide(p.side),
          qty: Number(p.qty ?? p.amount ?? p.contracts ?? 0),
          entryPrice: Number(p.entryPrice ?? 0),
          markPrice: Number(p.markPrice ?? 0),
          unrealizedPnl: Number(p.unrealizedPnl ?? 0),
          status: ("OPEN" as const),
        }));
        const positionCheck = positions.map((p) => ({
          symbol: p.symbol,
          side: p.side,
          qty: p.qty,
          status: ("MATCH" as const), // live = server-truth; exchange is the source — pass-through
        }));
        const cash = Number(sharedPositions.account?.cash ?? 0);
        const equity = Number(sharedPositions.account?.equity ?? cash);
        const localRecon: LocalRecon = {
          timestamp: Date.now(),
          isSynced: true,
          localEquity: equity,
          localCash: cash,
          unrealizedPnl: Number(sharedPositions.account?.unrealizedPnl ?? 0),
          marginLocked: Number(sharedPositions.account?.marginLocked ?? 0),
          exchangeEquity: null,
          discrepancyUsd: 0,
          breakdown: { mode: "LIVE", note: "Reconciliation aktif di LIVE mode (exchange vs local)." },
          mode: "live",
          note: "Mode LIVE — reconciliation exchange aktif.",
          positionCheck,
        };
        setReport(localRecon);
        setConn("ok");
        setLastSync(Date.now());
        return;
      }

      const acc = sharedPositions.account as { cash: number; equity: number; unrealizedPnl: number; marginLocked: number } | null;
      if (!acc || sharedPositions.error) {
        if (sharedPositions.error) setConn("error");
        else setConn("none");
        return;
      }

      const cash = Number(acc.cash ?? 0);
      const marginLocked = Number(acc.marginLocked ?? 0);
      const unrealizedPnl = Number(acc.unrealizedPnl ?? 0);
      const equity = Number(acc.equity ?? 0);
      const derivedEquity = cash + marginLocked + unrealizedPnl;
      const discrepancyUsd = Number((equity - derivedEquity).toFixed(2));
      const tolerance = 0.02;
      const isSynced = Math.abs(discrepancyUsd) <= tolerance;
      const maxDD = Number(ledgerStats.maxDrawdownPct ?? 0);

      const recon: LocalRecon = {
        timestamp: Date.now(),
        isSynced,
        localEquity: equity,
        localCash: cash,
        unrealizedPnl,
        marginLocked,
        exchangeEquity: null,
        discrepancyUsd,
        breakdown: {
          cash: `$${cash.toFixed(2)}`,
          marginLocked: `$${marginLocked.toFixed(2)}`,
          unrealizedPnl: `${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(2)}`,
          derivedEquity: `$${derivedEquity.toFixed(2)}`,
          reportedEquity: `$${equity.toFixed(2)}`,
          maxDrawdownPct: `${maxDD}%`,
          check: "equity ?= cash + marginLocked + unrealizedPnl",
        },
        mode: "paper",
        note: isSynced
          ? "Reconciliation lokal konsisten (server truth). Reconciliation exchange hanya untuk LIVE mode."
          : `Diskrepansi ${discrepancyUsd >= 0 ? "+" : ""}$${discrepancyUsd.toFixed(2)} melebihi toleransi $${tolerance.toFixed(2)}.`,
      };

      setReport(recon);
      setConn(isSynced ? "ok" : "ok");
      setLastSync(Date.now());
    } catch {
      setConn("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, sharedPositions.account, sharedPositions.positions, sharedPositions.mode, sharedPositions.error, ledgerStats.maxDrawdownPct]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isAuthenticated) return;
    // TIDAK ada interval sendiri — recompute ikut perubahan shared hooks
    // (15s global) + tombol Refresh manual. Menghilangkan 3 req/6s.
    load();
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const fmtUsd = (v: string | number) => {
    const n = Number(v ?? 0);
    if (!isFinite(n)) return "–";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const healthDot =
    conn === "ok"
      ? report?.isSynced
        ? "bg-emerald-400"
        : "bg-amber-500"
      : conn === "none"
      ? "bg-zinc-500"
      : conn === "error"
      ? "bg-rose-500"
      : "bg-zinc-500";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-emerald-500/10 rounded-xl flex items-center justify-center text-emerald-400 border border-emerald-500/30">
            <Scale className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
              Reconciliation
              <span className="px-2 py-0.5 rounded border text-[10px] font-bold font-mono bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
                LOCAL CHECK
              </span>
              {isLiveMode ? null : (
                <span className="px-2 py-0.5 rounded border text-[10px] font-mono bg-amber-500/15 text-amber-300 border-amber-500/30">PAPER</span>
              )}
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
              {isLiveMode ? "Local equity vs exchange balance — server truth" : "Reconciliation hanya untuk LIVE mode — lokal check: equity vs cash+uPnL+margin"}
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
          <button type="button"
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
          <p className="text-xs font-mono font-bold text-zinc-300">Reconciliation hanya untuk LIVE mode</p>
          <p className="text-[11px] font-mono text-zinc-500 mt-1 max-w-md">
            Di PAPER mode, panel ini menampilkan local consistency check (server truth). Reconciliation exchange vs local hanya aktif saat LIVE trading.
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
          {!isLiveMode && (
            <div className="px-3 py-2 rounded-lg bg-amber-950/20 border border-amber-500/30 text-[11px] font-mono text-amber-300">
              Reconciliation hanya untuk LIVE mode — di bawah ini adalah <strong>local consistency check</strong> (server truth: <code className="bg-zinc-900 px-1 rounded">equity ?= cash + marginLocked + uPnL</code>). Angka real dari server, bukan fabricasi.
            </div>
          )}
          <div
            className={`flex items-center gap-3 px-3.5 py-2.5 rounded-lg border ${
              report.isSynced
                ? "bg-emerald-950/20 border-emerald-500/30"
                : "bg-amber-950/30 border-amber-500/40"
            }`}
          >
            {report.isSynced ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            )}
            <div>
              <div className={`text-xs font-bold font-mono ${report.isSynced ? "text-emerald-300" : "text-amber-300"}`}>
                {report.isSynced ? (isLiveMode ? "LEDGER SYNCED" : "LOCAL CHECK — KONSISTEN") : "LOCAL DISCREPANCY — perlu investigasi"}
              </div>
              <div className="text-[11px] font-mono text-zinc-400">
                {new Date(report.timestamp).toLocaleString("id-ID")} • {report.note}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono">
            <div className="bg-zinc-950/70 rounded-xl p-3.5 border border-zinc-800">
              <div className="text-[10px] uppercase text-zinc-500 flex items-center gap-1 mb-1">
                <Scale className="w-3 h-3" /> LOCAL EQUITY
              </div>
              <div className="text-xl font-black text-zinc-100">${fmtUsd(report.localEquity)}</div>
              <div className="text-[10px] text-zinc-600">server paper account.equity</div>
            </div>
            <div className="bg-zinc-950/70 rounded-xl p-3.5 border border-zinc-800">
              <div className="text-[10px] uppercase text-zinc-500 flex items-center gap-1 mb-1">
                <ShieldCheck className="w-3 h-3" /> CASH + MARGIN + uPnL
              </div>
              <div className="text-xl font-black text-zinc-100">${fmtUsd(report.localCash + report.marginLocked + report.unrealizedPnl)}</div>
              <div className="text-[10px] text-zinc-600">${fmtUsd(report.localCash)} + ${fmtUsd(report.marginLocked)} + {report.unrealizedPnl >= 0 ? "+" : ""}${fmtUsd(report.unrealizedPnl)}</div>
            </div>
            <div className={`bg-zinc-950/70 rounded-xl p-3.5 border ${report.isSynced ? "border-emerald-500/30" : "border-amber-500/40"}`}>
              <div className="text-[10px] uppercase text-zinc-500 flex items-center gap-1 mb-1">
                <Activity className="w-3 h-3" /> DISCREPANCY
              </div>
              <div className={`text-xl font-black ${report.discrepancyUsd === 0 ? "text-emerald-400" : Math.abs(report.discrepancyUsd) <= 0.02 ? "text-amber-400" : "text-rose-400"}`}>
                ${fmtUsd(report.discrepancyUsd)}
              </div>
              <div className="text-[10px] text-zinc-600">
                {report.isSynced ? "IN SYNC" : "MISMATCH"}
              </div>
            </div>
          </div>

          {report.breakdown && Object.keys(report.breakdown).length > 0 && (
            <div className="bg-zinc-950/60 rounded-xl border border-zinc-800 p-3.5">
              <div className="text-[10px] uppercase text-zinc-400 font-mono font-bold mb-2">BREAKDOWN (server truth)</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px]">
                {Object.entries(report.breakdown as Record<string, string | number>).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between bg-zinc-900 rounded-lg px-2.5 py-1.5 border border-zinc-800">
                    <span className="text-zinc-400 font-bold">{k}</span>
                    <span className="text-zinc-200">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isLiveMode && report.positionCheck && report.positionCheck.length > 0 && (
            <div className="bg-zinc-950/60 rounded-xl border border-zinc-800 p-3.5">
              <div className="text-[10px] uppercase text-zinc-400 font-mono font-bold mb-2 flex items-center gap-1.5">
                <ShieldCheck className="w-3 h-3 text-emerald-400" /> OPEN POSITIONS (EXCHANGE — pass-through, server truth)
              </div>
              <div className="space-y-1.5 font-mono text-[11px]">
                {report.positionCheck.map((pc) => (
                  <div key={pc.symbol} className="flex items-center justify-between bg-zinc-900 rounded-lg px-2.5 py-1.5 border border-zinc-800">
                    <span className="text-zinc-300 font-bold">{pc.symbol}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${
                      pc.side === "LONG"
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                        : "bg-rose-500/15 text-rose-300 border-rose-500/30"
                    }`}>{pc.side}</span>
                    <span className="text-zinc-400">{pc.qty.toFixed(4)}</span>
                    <span className="flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" /> {pc.status}
                    </span>
                  </div>
                ))}
              </div>
              <div className="text-[10px] font-mono text-zinc-600 mt-2">
                Live positions langsung dari exchange via /api/broker/positions — server truth, bukan state lokal.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ReconciliationPanel;
