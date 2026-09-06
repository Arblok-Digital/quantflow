import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import {
  X,
  FileText,
  ShieldCheck,
  AlertTriangle,
  Download,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Filter,
} from "lucide-react";

interface AuditLedgerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Server shape: GET /api/ledger -> {success, entries:[{seq,kind,payload,createdAt,prevHash,hash}], nextCursor}
interface LedgerEntry {
  seq: number;
  kind: string;
  payload: string;
  createdAt: number;
  prevHash: string;
  hash: string;
}

interface VerifyResult {
  success?: boolean;
  total: number;
  valid: boolean;
  tampered: number[];
  issues: Array<{ seq: number; reason: string }>;
}

type KindFilter = "all" | "decision" | "order" | "exit";

const KIND_COLOR: Record<string, string> = {
  decision: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  order: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  exit: "bg-violet-500/20 text-violet-300 border-violet-500/30",
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

export const AuditLedgerModal: React.FC<AuditLedgerModalProps> = ({ isOpen, onClose }) => {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filterKind, setFilterKind] = useState<KindFilter>("all");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [showIssues, setShowIssues] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const tamperedSet = useMemo(() => new Set(verifyResult?.tampered ?? []), [verifyResult]);

  const fetchLedger = useCallback(async (cursor?: number | null, append = false) => {
    if (!append) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "50");
      if (cursor) qs.set("cursor", String(cursor));
      const res = await authFetch(`/api/ledger?${qs.toString()}`);
      if (res.status === 401) {
        throw new Error("Unauthorized — silakan login ulang.");
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        throw new Error(data?.message || `Gagal memuat ledger (HTTP ${res.status})`);
      }
      const newEntries: LedgerEntry[] = Array.isArray(data.entries) ? data.entries : [];
      const nc: number | null = data.nextCursor ?? null;
      if (!mountedRef.current) return;
      if (append) {
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e.seq));
          const merged = [...prev];
          for (const e of newEntries) if (!seen.has(e.seq)) merged.push(e);
          // keep DESC order (server already DESC)
          return merged;
        });
      } else {
        setEntries(newEntries);
      }
      setNextCursor(nc);
    } catch (e: any) {
      if (!mountedRef.current) return;
      setError(e?.message || "Gagal memuat ledger.");
    } finally {
      if (!mountedRef.current) return;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  const handleVerifyChain = useCallback(async () => {
    setIsVerifying(true);
    setShowIssues(false);
    try {
      const res = await authFetch("/api/ledger/verify");
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        throw new Error(data?.message || `Verify gagal (HTTP ${res.status})`);
      }
      // server returns {success, total, valid, tampered, issues}
      const vr: VerifyResult = {
        total: Number(data.total ?? 0),
        valid: Boolean(data.valid),
        tampered: Array.isArray(data.tampered) ? data.tampered.map((n: any) => Number(n)) : [],
        issues: Array.isArray(data.issues) ? data.issues : [],
      };
      setVerifyResult(vr);
      setShowIssues(!vr.valid);
    } catch {
      setVerifyResult({ total: entries.length, valid: false, tampered: [], issues: [{ seq: -1, reason: "VERIFY_FAILED" }] });
      setShowIssues(true);
    } finally {
      setIsVerifying(false);
    }
  }, [entries.length]);

  // Fetch on open
  useEffect(() => {
    if (!isOpen) return;
    // reset verify when reopening? keep but refresh ledger
    fetchLedger(null, false);
  }, [isOpen, fetchLedger]);

  const handleLoadMore = () => {
    if (nextCursor != null) fetchLedger(nextCursor, true);
  };

  const handleExportJSON = () => {
    const target = filtered;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(target, null, 2));
    const a = document.createElement("a");
    a.setAttribute("href", dataStr);
    a.setAttribute("download", `audit_ledger_${Date.now()}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const toggleExpand = (seq: number) => {
    setExpanded((prev) => {
      const nt = new Set(prev);
      if (nt.has(seq)) nt.delete(seq);
      else nt.add(seq);
      return nt;
    });
  };

  const filtered = useMemo(() => {
    if (filterKind === "all") return entries;
    return entries.filter((e) => e.kind === filterKind);
  }, [entries, filterKind]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[90vh] w-full max-w-5xl flex-col rounded-2xl border border-zinc-800 bg-zinc-950 p-6 shadow-2xl relative overflow-hidden">
        <div className="absolute inset-0 opacity-5 pointer-events-none bento-dot-grid" />
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4 relative z-10">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="font-mono text-base font-bold text-zinc-100">CRYPTOGRAPHIC TRANSACTION AUDIT LEDGER</h2>
                <span className="rounded bg-amber-500/10 px-2 py-0.5 text-[10px] font-mono text-amber-400 border border-amber-500/20">SHA-256 HASH CHAIN • PERSISTENT DB</span>
              </div>
              <p className="text-xs text-zinc-400">Sumber: <span className="text-zinc-300">GET /api/ledger</span> • persist di SQLite • pagination via cursor</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors relative z-10">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Action Bar */}
        <div className="my-4 flex flex-wrap items-center justify-between gap-3 bg-zinc-900/60 p-3 rounded-lg border border-zinc-800/80 relative z-10">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleVerifyChain}
              disabled={isVerifying}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-mono font-bold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50 transition-colors shadow-lg shadow-emerald-500/10"
            >
              <ShieldCheck className="h-4 w-4" />
              <span>{isVerifying ? "MEMVERIFIKASI..." : "VERIFY CHAIN"}</span>
            </button>
            <button
              onClick={() => fetchLedger(null, false)}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-mono text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors border border-zinc-700"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              <span>Refresh</span>
            </button>

            {/* Filter by kind */}
            <div className="flex items-center gap-1 ml-1">
              <Filter className="w-3.5 h-3.5 text-zinc-500" />
              <div className="flex rounded-lg overflow-hidden border border-zinc-700">
                {(["all", "decision", "order", "exit"] as KindFilter[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setFilterKind(k)}
                    className={`px-2.5 py-1 text-[11px] font-mono font-bold uppercase transition ${filterKind === k ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"}`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={handleExportJSON}
            disabled={entries.length === 0}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-mono text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors border border-zinc-700"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Ekspor JSON ({filtered.length})</span>
          </button>
        </div>

        {/* Verification Banner */}
        {verifyResult && (
          <div
            onClick={() => !verifyResult.valid && setShowIssues((v) => !v)}
            className={`mb-4 flex items-start gap-3 rounded-lg p-3 border font-mono text-xs relative z-10 ${verifyResult.valid ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-rose-500/10 text-rose-400 border-rose-500/30 cursor-pointer hover:bg-rose-500/15"}`}
          >
            {verifyResult.valid ? <ShieldCheck className="h-5 w-5 shrink-0" /> : <AlertTriangle className="h-5 w-5 shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="font-bold flex items-center gap-2">
                {verifyResult.valid ? `CHAIN VALID (${verifyResult.total} blocks)` : `TAMPERED — klik buat detail (${verifyResult.tampered.length} seq)`}
                {!verifyResult.valid && (showIssues ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
              </div>
              <p className="text-[11px] opacity-90 mt-0.5">
                {verifyResult.valid
                  ? "Semua blok terverifikasi via recompute hash chain + HMAC di server (GET /api/ledger/verify)."
                  : "Hash mismatch / chain broken terdeteksi. Daftar seq & reason di bawah; baris terkait di-highlight kuning."}
              </p>
              {!verifyResult.valid && showIssues && verifyResult.issues.length > 0 && (
                <div className="mt-2 grid gap-1 max-h-32 overflow-y-auto pr-1">
                  {verifyResult.issues.map((iss, idx) => (
                    <div key={`${iss.seq}-${iss.reason}-${idx}`} className="flex items-center gap-2 text-[11px] bg-rose-950/40 border border-rose-500/20 rounded px-2 py-1">
                      <span className="text-amber-300 font-bold">seq {iss.seq}</span>
                      <span className="text-zinc-500">→</span>
                      <span className="text-rose-300 font-bold">{iss.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-rose-950/40 border border-rose-500/30 text-xs font-mono text-rose-300 relative z-10">
            {error}
          </div>
        )}

        {/* Ledger Table */}
        <div className="flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-xs relative z-10">
          {loading && entries.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-zinc-400 gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" /> Memuat ledger dari server...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-zinc-400 px-4 text-center">
              <p className="text-zinc-300 font-bold">Belum ada entry{filterKind !== "all" ? ` untuk kind "${filterKind}"` : ""}.</p>
              <p className="text-[11px] text-zinc-500 mt-1">Ledger persist di DB — entry baru akan muncul setelah decision/order/exit tercatat via server (appendAudit).</p>
            </div>
          ) : (
            <div className="divide-y divide-zinc-900">
              {/* header row */}
              <div className="sticky top-0 bg-zinc-900 text-zinc-400 text-[11px] border-b border-zinc-800 grid grid-cols-[72px_96px_150px_1fr] gap-2 px-3 py-2">
                <span>SEQ</span>
                <span>KIND</span>
                <span>CREATED AT</span>
                <span>PAYLOAD (JSON)</span>
              </div>

              {filtered.map((e) => {
                const isTampered = tamperedSet.has(e.seq);
                const isExpanded = expanded.has(e.seq);
                const payloadPreview = truncate(e.payload, 140);
                return (
                  <div
                    key={e.seq}
                    className={`grid grid-cols-[72px_96px_150px_1fr] gap-2 px-3 py-3 hover:bg-zinc-900/60 transition ${isTampered ? "bg-amber-950/30 border-l-2 border-amber-400" : ""}`}
                  >
                    <div className="font-bold text-zinc-200 flex items-center gap-1">
                      #{e.seq}
                      {isTampered && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" title="Tampered" />}
                    </div>
                    <div>
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold border ${KIND_COLOR[e.kind] || "bg-zinc-800 text-zinc-300 border-zinc-700"}`}>
                        {e.kind}
                      </span>
                    </div>
                    <div className="text-zinc-400 text-[11px]">{new Date(e.createdAt).toLocaleString("id-ID")}</div>
                    <div className="min-w-0">
                      <div className="text-zinc-300 break-all leading-relaxed text-[11px]">{isExpanded ? e.payload : payloadPreview}</div>
                      <div className="flex items-center gap-2 mt-1">
                        {e.payload.length > 140 && (
                          <button onClick={() => toggleExpand(e.seq)} className="text-[11px] text-cyan-400 hover:text-cyan-300 flex items-center gap-1">
                            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                            {isExpanded ? "Tutup" : "Expand"}
                          </button>
                        )}
                        <span className="text-[10px] text-zinc-600 hidden sm:inline">
                          prev {e.prevHash.slice(0, 8)}… • hash {e.hash.slice(0, 8)}…
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Load More */}
        {nextCursor != null && (
          <div className="pt-3 flex justify-center relative z-10">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono border border-zinc-700 disabled:opacity-50 flex items-center gap-2"
            >
              {loadingMore ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
              {loadingMore ? "Memuat..." : "Load More"}
            </button>
          </div>
        )}

        <div className="pt-2 text-[10px] font-mono text-zinc-600 text-center relative z-10">
          {entries.length > 0 ? `${entries.length} entries ter-load (filter: ${filterKind}) • endpoint GET /api/ledger` : "—"}
        </div>
      </div>
    </div>
  );
};
