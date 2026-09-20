import React, { useCallback, useEffect, useState } from "react";
import { Radar, RefreshCw, AlertTriangle } from "lucide-react";
import { authFetch, useAuth } from "../hooks/useAuth";

// ---------------------------------------------------------------------------
// SolanaScoutPanel — vertical meme-coin (Solana), mesin TERPISAH.
// GET /api/scout/report -> baca output/report.json milik solana-scout.
// POST /api/scout/scan  -> trigger re-scan (child process node, mock/live).
// Verdict hanya baca informasi; TIDAK menyentuh paperbook/HMAC ledger engine.
// ---------------------------------------------------------------------------

interface ScoutCheck {
  kind: "gate" | "credit";
  key: string;
  label: string;
  weight: number;
  applied: boolean;
  detail?: string;
}

interface ScoutVerdict {
  score: number;
  scale: number;
  tier: "ALPHA" | "BUY" | "WATCH" | "SKIP";
  tierLabel: string;
  color: "alpha" | "buy" | "watch" | "skip";
  hardFailed: boolean;
  hardFailReason: string | null;
  checks: ScoutCheck[];
  breakdown: string;
}

interface ScoutHolder {
  handle: string;
  verified?: boolean;
  followers?: number;
  amount: number;
}

interface ScoutToken {
  mint: string;
  symbol: string;
  name: string;
  ageHours: number | null;
  kol: { count: number; verifiedCount: number; maxFollowers: number; holders?: ScoutHolder[] };
  fundamentals: {
    available?: boolean;
    rugRisk?: boolean | null;
    rugRiskDetail?: string[];
    topHolderPct?: number | null;
    holders?: number | null;
    liquidityUsd?: number | null;
    mintAuthorityRevoked?: boolean | null;
  };
  verdict: ScoutVerdict;
}

interface ScoutReport {
  meta: { mode?: string; generatedAt: string; engine?: string; note?: string };
  crawlInfo?: { detecting?: string; gapNote?: string };
  summary?: { counts: Record<string, number>; total: number };
  tokens: ScoutToken[];
}

const TIER_STYLE: Record<string, { badge: string; bar: string; text: string }> = {
  ALPHA: { badge: "bg-amber-400 text-zinc-950", bar: "bg-amber-400", text: "text-amber-300" },
  BUY: { badge: "bg-emerald-500 text-zinc-950", bar: "bg-emerald-500", text: "text-emerald-400" },
  WATCH: { badge: "bg-yellow-400 text-zinc-950", bar: "bg-yellow-400", text: "text-yellow-300" },
  SKIP: { badge: "bg-zinc-600 text-zinc-200", bar: "bg-zinc-500", text: "text-zinc-400" },
};

function fmtUsd(v?: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Number(v).toFixed(0)}`;
}

function fmtAge(h: number | null): string {
  if (h === null || h === undefined || Number.isNaN(h)) return "n/a";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${h.toFixed(1)}j`;
  return `${(h / 24).toFixed(1)}h`;
}

function fmtNum(v?: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function shortMint(m: string): string {
  return m ? `${m.slice(0, 5)}…${m.slice(-4)}` : "?";
}

function CheckRow({ c }: { key?: React.Key; c: ScoutCheck }): React.ReactElement {
  const markCss = c.applied
    ? c.kind === "gate"
      ? "text-rose-400"
      : "text-emerald-500"
    : "text-zinc-600";
  const mark = c.applied ? (c.kind === "gate" ? "✕" : "✓") : "·";
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className={`w-3 shrink-0 font-mono font-bold ${markCss}`}>{mark}</span>
      <div className="min-w-0">
        <span className="text-zinc-300">{c.label}</span>
        {c.detail ? <span className="ml-1.5 text-zinc-500 font-mono text-[10px]">{c.detail}</span> : null}
      </div>
    </div>
  );
}

function TokenCard({ t, expanded, onToggle }: { key?: React.Key; t: ScoutToken; expanded: boolean; onToggle: () => void }): React.ReactElement {
  const v = t.verdict;
  const style = TIER_STYLE[v.tier] || TIER_STYLE.SKIP;
  const f = t.fundamentals || {};
  const gateFailCount = v.checks.filter((c) => c.kind === "gate" && c.applied).length;
  const creditCount = v.checks.filter((c) => c.kind === "credit" && c.applied).length;
  const holders = t.kol.holders || [];
  const pct = Math.round((v.score / v.scale) * 100);

  return (
    <div className={`rounded-xl border ${v.hardFailed ? "border-rose-900/60 bg-rose-950/10" : "border-zinc-800 bg-zinc-900/60"}`}>
      <button onClick={onToggle} className="w-full text-left flex items-center gap-3 p-3">
        <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-mono font-bold ${style.badge}`}>{v.tier}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold text-zinc-100">{t.name || "?"}</span>
            <span className="shrink-0 font-mono text-[11px] text-zinc-500">${t.symbol || "?"}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-3 font-mono text-[11px] text-zinc-500">
            <span>{shortMint(t.mint)}</span>
            <span>umur {fmtAge(t.ageHours)}</span>
            <span>{t.kol.count} KOL</span>
            <span className="text-zinc-400">
              {gateFailCount} gate ✕ · {creditCount} poin ✓
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-sm font-bold" style={{}}>
            <span className={style.text}>{v.score}</span>
            <span className="text-zinc-600">/{v.scale}</span>
          </div>
          <div className="mt-1 h-1.5 w-24 rounded-full bg-zinc-800 overflow-hidden">
            <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
        <RefreshCw className={`h-3.5 w-3.5 text-zinc-600 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="border-t border-zinc-800 p-3 pt-0">
          <div className={`pt-2 pb-2 text-xs ${v.hardFailed ? "text-rose-300" : "text-zinc-400"}`}>{v.breakdown}</div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="mb-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">Gate & poin</div>
              <div className="space-y-1.5">
                {v.checks.map((c, i) => (
                  <CheckRow key={i} c={c} />
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">On-chain</div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-zinc-400">RugCheck</span><span className={f.rugRisk ? "text-rose-400" : "text-emerald-400"}>{f.rugRisk ? (f.rugRiskDetail || []).join("; ") : "bersih"}</span></div>
                <div className="flex justify-between"><span className="text-zinc-400">Likuiditas</span><span className="font-mono text-zinc-200">{fmtUsd(f.liquidityUsd)}</span></div>
                <div className="flex justify-between"><span className="text-zinc-400">Top holder</span><span className="font-mono text-zinc-200">{f.topHolderPct != null ? `${(f.topHolderPct * 100).toFixed(1)}%` : "n/a"}</span></div>
                <div className="flex justify-between"><span className="text-zinc-400">Holder</span><span className="font-mono text-zinc-200">{fmtNum(f.holders)}</span></div>
                <div className="flex justify-between"><span className="text-zinc-400">Mint authority</span><span className={`font-mono ${f.mintAuthorityRevoked ? "text-emerald-400" : "text-rose-400"}`}>{f.mintAuthorityRevoked === true ? "revoked" : f.mintAuthorityRevoked === false ? "AKTIF" : "n/a"}</span></div>
              </div>
              {holders.length > 0 && (
                <>
                  <div className="mt-3 mb-1.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">Wallet KOL yang pegang</div>
                  <div className="space-y-1 text-xs">
                    {holders.slice(0, 6).map((h, i) => (
                      <div key={i} className="flex justify-between gap-2">
                        <span className="truncate text-zinc-300">
                          @{h.handle}{h.verified ? <span className="ml-1 text-amber-400" title="verified">✔</span> : null}
                        </span>
                        <span className="shrink-0 font-mono text-zinc-500">
                          {fmtNum(h.followers)} flw · {h.amount.toFixed(0)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export const SolanaScoutPanel: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [report, setReport] = useState<ScoutReport | null>(null);
  const [conn, setConn] = useState<"loading" | "ok" | "error" | "no-report">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [scanMode, setScanMode] = useState<"mock" | "live" | "discovery">("mock");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isAuthenticated) return;
    setConn("loading");
    try {
      const res = await authFetch("/api/scout/report");
      if (res.status === 404) {
        setConn("no-report");
        setReport(null);
        setErrorMsg(null);
        return;
      }
      if (!res.ok) {
        setConn("error");
        setErrorMsg(`HTTP ${res.status}`);
        return;
      }
      const payload = await res.json();
      if (payload?.success && Array.isArray(payload.tokens)) {
        setReport(payload);
        setConn("ok");
        setErrorMsg(null);
      } else {
        setConn("error");
        setErrorMsg("payload tidak valid");
      }
    } catch (e: any) {
      setConn("error");
      setErrorMsg(e?.message || "fetch gagal");
    }
  }, [isAuthenticated]);

  useEffect(() => {
    load();
  }, [load]);

  const runScan = useCallback(async () => {
    if (!isAuthenticated || scanning) return;
    setScanning(true);
    setScanMsg(scanMode === "discovery" ? "Menjalankan discovery DexScreener…" : "Menjalankan scan…");
    try {
      const res = await authFetch("/api/scout/scan", { method: "POST", body: JSON.stringify({ mode: scanMode }) });
      const payload = await res.json().catch(() => null);
      if (payload && payload.success && Array.isArray(payload.tokens)) {
        setReport(payload);
        setConn("ok");
        setScanMsg(`Scan selesai (${payload.exitCode === 0 ? "0" : `${payload.exitCode}`})`);
      } else {
        setScanMsg(payload?.message || `HTTP ${res.status}`);
      }
    } catch (e: any) {
      setScanMsg(e?.message || "scan gagal");
    } finally {
      setScanning(false);
    }
  }, [isAuthenticated, scanning, scanMode]);

  const toggle = (mint: string) => {
    setExpanded((prev) => {
      const nt = new Set(prev);
      if (nt.has(mint)) nt.delete(mint);
      else nt.add(mint);
      return nt;
    });
  };

  const counts = report?.summary?.counts || { ALPHA: 0, BUY: 0, WATCH: 0, SKIP: 0 };
  const total = report?.summary?.total ?? report?.tokens?.length ?? 0;

  const filtered = (report?.tokens || [])
    .filter((t) => !tierFilter || t.verdict.tier === tierFilter)
    .filter((t) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return [t.name, t.symbol, t.mint, t.verdict.tier].some((s) => s && s.toLowerCase().includes(q));
    })
    .sort((a, b) => b.verdict.score - a.verdict.score);

  if (!isAuthenticated) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center">
            <Radar className="h-4 w-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold text-zinc-100 tracking-tight">Solana Scout</div>
            <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">
              KOL akumulasi on-chain · mesin terpisah dari engine futures
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {report?.meta?.generatedAt && (
            <span className="font-mono text-[10px] text-zinc-500">
              {report.meta.mode?.toUpperCase() || "MOCK"} ·{" "}
              {new Date(report.meta.generatedAt).toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" })}
            </span>
          )}
          <div className="flex items-center rounded-md border border-zinc-800 overflow-hidden text-[11px] font-mono">
            {(["mock", "live", "discovery"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setScanMode(m)}
                disabled={scanning}
                className={`px-2.5 py-1.5 transition disabled:opacity-50 ${
                  scanMode === m ? "bg-amber-500/20 text-amber-300" : "bg-zinc-900/60 text-zinc-500 hover:text-zinc-300"
                }`}
                title={m === "discovery" ? "Bottom-up: token-boosts DexScreener" : m === "live" ? "KOL-first (butuh Helius key)" : "Data deterministik demo"}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            onClick={runScan}
            disabled={scanning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-xs font-mono font-semibold disabled:opacity-50 hover:bg-amber-500/20 transition"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? "Scanning…" : "Scan"}
          </button>
        </div>
      </div>

      {scanMsg && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs font-mono text-zinc-400">{scanMsg}</div>
      )}

      {conn === "no-report" && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-4 text-sm text-amber-200">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Belum ada report scout.</div>
          <p className="mt-1 text-xs text-amber-300/80">Klik <strong>Scan</strong> untuk menjalankan playbook (mock, deterministik) lalu hasilnya tampil di sini. Live scan butuh <code className="font-mono bg-zinc-900 px-1 rounded">HELIUS_API_KEY</code> di proses server.</p>
        </div>
      )}

      {conn === "error" && (
        <div className="rounded-xl border border-rose-800/60 bg-rose-950/20 p-4 text-sm text-rose-200">
          <div className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" /> Gagal memuat report.</div>
          <p className="mt-1 text-xs font-mono text-rose-300/80">{errorMsg}</p>
        </div>
      )}

      {(conn === "ok" || report) && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {(["ALPHA", "BUY", "WATCH", "SKIP"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTierFilter(tierFilter === k ? null : k)}
                className={`rounded-xl border p-3 text-left transition ${tierFilter === k ? "border-amber-500/40 bg-amber-500/5" : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"}`}
              >
                <div className={`font-mono text-lg font-bold ${TIER_STYLE[k].text}`}>{counts[k] || 0}</div>
                <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">{k}</div>
              </button>
            ))}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="font-mono text-lg font-bold text-zinc-100">{total}</div>
              <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">Total</div>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-[11px] text-zinc-400">
            <strong className="text-zinc-300">Cara baca:</strong> ALPHA ≥150 ({counts.ALPHA || 0}) · BUY 110–149 ({counts.BUY || 0}) · WATCH 70–109 ({counts.WATCH || 0}) · SKIP &lt;70 / gate gagal ({counts.SKIP || 0}). Hard gate (rug, likuiditas tipis, top holder &gt;40%) langsung SKIP.
          </div>

          {report?.crawlInfo && (
            <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-2 text-[11px] text-zinc-500">
              <strong className="text-zinc-400">Metode:</strong> {report.crawlInfo.detecting || "KOL-first"}.{" "}
              {report.crawlInfo.gapNote ? <><strong className="text-zinc-400">Gap:</strong> {report.crawlInfo.gapNote}</> : null}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cari simbol / nama / mint…"
              className="flex-1 min-w-[180px] rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:border-amber-500/50 outline-none"
            />
            <span className="font-mono text-[10px] text-zinc-600">{filtered.length} hasil</span>
          </div>

          <div className="space-y-2">
            {filtered.length === 0 && <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500">Tidak ada token yang cocok.</div>}
            {filtered.map((t) => (
              <TokenCard key={t.mint} t={t} expanded={expanded.has(t.mint)} onToggle={() => toggle(t.mint)} />
            ))}
          </div>
        </>
      )}

      <div className="rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-[11px] text-rose-200/90">
        <strong>Bukan nasihat keuangan.</strong> Mayoritas token baru rug. Detail token hanya informasi; eksekusi (jika ada) tetap lewat dompet/sniper terpisah — tidak pernah lewat paperbook futures.
      </div>
    </div>
  );
};