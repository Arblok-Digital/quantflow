import React, { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../hooks/useAuth";

interface PumpScanResultItem {
  symbol: string;
  price: number;
  changePct24h: number;
  quoteVolumeUsd: number;
  marketCapUsd: number;
  score: number;
  heat: "HOT" | "WATCH" | "COLD";
  reasons: string[];
}

interface PumpScanResponse {
  success: boolean;
  scannedAt?: number;
  results?: PumpScanResultItem[];
  message?: string;
}

interface PumpRadarPanelProps {
  onNavigate?: (tab: any) => void;
}

const fmtPrice = (n: number): string => {
  if (n >= 1000) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 6, minimumFractionDigits: 2 })}`;
};

const fmtUsd = (n: number): string =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`;

const heatBadge = (heat: PumpScanResultItem["heat"]) =>
  heat === "HOT"
    ? { label: "HOT", cls: "bg-amber-400 text-zinc-950 border-amber-500 font-black shadow-amber-400/30 shadow-md" }
    : heat === "WATCH"
      ? { label: "WATCH", cls: "bg-zinc-800 text-zinc-200 border-zinc-700 font-bold" }
      : { label: "COLD", cls: "bg-zinc-900 text-zinc-500 border-zinc-800 font-bold" };

export const PumpRadarPanel: React.FC<PumpRadarPanelProps> = ({ onNavigate }) => {
  const [results, setResults] = useState<PumpScanResultItem[] | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<boolean>(false);
  const aliveRef = useRef(true);

  const runScan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    try {
      const res = await authFetch("/api/pump-scan");
      const data: PumpScanResponse = res.ok ? await res.json() : { success: false, message: `HTTP ${res.status}` };
      if (!aliveRef.current) return;
      if (!data?.success) {
        setError(data?.message || "Gagal scan — cek server / koneksi Gate.");
        return;
      }
      setResults(data.results ?? []);
      setScannedAt(data.scannedAt ?? Date.now());
    } catch (e: any) {
      if (aliveRef.current) {
        setError("Gagal scan — cek server / koneksi Gate.");
      }
    } finally {
      if (aliveRef.current) setScanning(false);
    }
  }, [scanning]);

  // Auto-refresh tiap 60 detik + scan pertama saat mount.
  useEffect(() => {
    aliveRef.current = true;
    runScan();
    const iv = setInterval(runScan, 60000);
    const onVisible = () => {
      if (!document.hidden) runScan();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      aliveRef.current = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const prettyScore = (score: number): string => {
    const power = Math.log10(score || 1);
    return `10^${Math.round(power * 10) / 10}`;
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm relative overflow-hidden">
      <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />
      <div className="absolute right-0 top-0 translate-x-10 -translate-y-10 w-48 h-48 bg-amber-400/10 rounded-full blur-3xl pointer-events-none" />
      <div className="relative z-10 flex flex-col gap-4">
        {/* HEADER */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-amber-400/15 rounded-xl flex items-center justify-center text-amber-400 border border-amber-500/30 font-mono font-black text-sm">
              ^
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                PUMP RADAR
                <span className="px-2 py-0.5 rounded border text-[10px] font-mono font-bold bg-amber-400/10 text-amber-300 border-amber-500/30">
                  ALERT ONLY
                </span>
              </h2>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
                SCANNER MICROCAP GATE.IO SPOT
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            {scannedAt && (
              <span className="hidden sm:inline text-[10px] font-mono text-zinc-500">
                {new Date(scannedAt).toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={runScan}
              disabled={scanning}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-400 hover:bg-amber-300 disabled:bg-zinc-800 disabled:text-zinc-500 text-zinc-950 font-bold font-mono text-xs shadow-md shadow-amber-400/20 border border-amber-500 transition"
            >
              {scanning ? (
                <span className="w-3 h-3 border-2 border-zinc-700 border-t-amber-500 rounded-full animate-spin" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-950 animate-pulse" />
              )}
              {scanning ? "Scanning..." : "SCAN NOW"}
            </button>
          </div>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-mono">
            {error} — SCAN NOW untuk coba lagi.
          </div>
        )}

        {/* Scan pertama belum selesai */}
        {results === null && !error && (
          <div className="flex items-center justify-center py-10 text-center bg-zinc-950/60 rounded-xl border border-zinc-800">
            <span className="flex items-center gap-2 text-xs font-mono text-zinc-400">
              <span className="w-3 h-3 border-2 border-zinc-700 border-t-amber-400 rounded-full animate-spin" />
              Memindai pasar microcap Gate.io SPOT...
            </span>
          </div>
        )}

        {/* Hasil scan */}
        {results !== null && !error && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 text-center bg-zinc-950/60 rounded-xl border border-dashed border-zinc-800">
            <div className="w-2 h-2 rounded-full bg-zinc-700 mb-3" />
            <p className="text-xs font-mono text-zinc-400">Tidak ada kandidat. Scan ulang nanti.</p>
            <p className="text-[10px] font-mono text-zinc-600 mt-1">
              Filter: USDT microcap &lt; $5M proxy &middot; quote volume &gt; $10k &middot; anti-dust
            </p>
          </div>
        )}

        {results !== null && results.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {results.map((r) => {
              const hb = heatBadge(r.heat);
              const isUp = r.changePct24h >= 0;
              return (
                <div
                  key={r.symbol}
                  className="rounded-xl bg-zinc-950/70 border border-zinc-800 p-3.5 space-y-2.5 flex flex-col"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-bold font-mono text-zinc-100 truncate">{r.symbol}</p>
                      <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
                        microcap {fmtUsd(r.marketCapUsd)}
                      </p>
                    </div>
                    <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-mono ${hb.cls}`}>
                      {hb.label} {prettyScore(r.score)}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 font-mono text-xs">
                    <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                      <span className="text-[9px] uppercase text-zinc-500 block font-semibold">Price</span>
                      <span className="text-sm font-bold text-zinc-100">{fmtPrice(r.price)}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                      <span className="text-[9px] uppercase text-zinc-500 block font-semibold">24h</span>
                      <span className={`text-sm font-bold ${isUp ? "text-emerald-400" : "text-rose-400"}`}>
                        {isUp ? "+" : ""}
                        {r.changePct24h.toFixed(2)}%
                      </span>
                    </div>
                    <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                      <span className="text-[9px] uppercase text-zinc-500 block font-semibold">Vol 24h</span>
                      <span className="text-sm font-bold text-amber-300">{fmtUsd(r.quoteVolumeUsd)}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1 mt-auto">
                    {r.reasons.map((rsn, i) => (
                      <span
                        key={i}
                        className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[9px] font-mono text-zinc-400"
                      >
                        {rsn}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[10px] font-mono text-zinc-600">
          ALERT ONLY — radar ini cuma memindai, tidak pernah memasang order. Refresh otomatis tiap 60 detik.
        </p>
      </div>
    </div>
  );
};

export default PumpRadarPanel;