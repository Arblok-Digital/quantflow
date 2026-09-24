/**
 * src/logic/jevChip.ts
 * "Jev chip" — System One decision model (type-safe choice, bukan LLM naratif).
 *
 * Dua mode akses:
 *  1. Chat-completions wrapper (default): POST {baseUrl}/chat/completions dengan
 *     prompt JSON { action, confidence, riskLevel }. Verdict ditentukan probe
 *     (scripts/jev-probe.mts); kalau wrapper tidak balas JSON "rasional",
 *     berpasangan dengan adapter native `/v1/systemone` (di luar scope file ini).
 *  2. State builder deterministik: buildJevState(ctx) → JevState (JSON aman,
 *     whitelist field, TANPA NaN/undefined/secrets), lalu jevStateToPrompt().
 *
 * Kebijakan fail-closed sama dengan prompt Gemini (aiPrompt.test.ts):
 *  - data gagal → null jujur, bukan angka karangan.
 *  - on-chain policy alias ZERO weight disisipkan apa adanya.
 *  - angka hanya dikutip dari data REAL yang sudah dihitung server.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider config (dibaca LAZY per request — mirror getDbFilePath; jangan
// simpan di module scope supaya test yang stubbing env per-test tetap benar).
// ---------------------------------------------------------------------------
export type JevProviderId = "jev-zen" | "jev-openrouter" | "jev-opencode";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function jevZenConfig(): ProviderConfig {
  return {
    baseUrl: String(process.env.JEV_ZEN_BASE_URL || "").trim(),
    apiKey: String(process.env.JEV_ZEN_API_KEY || "").trim(),
    // Slug default = id TERVERIFIKASI via `opencode models` (keluarga `opencode/*`
    // diproksi gateway; slug "oc/..." TIDAK ada di katalog mana pun).
    model: String(process.env.JEV_ZEN_MODEL || "opencode/jev-1.13-free").trim(),
  };
}

export function openRouterConfig(): ProviderConfig {
  return {
    baseUrl: String(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").trim(),
    apiKey: String(process.env.OPENROUTER_API_KEY || "").trim(),
    model: String(process.env.OPENROUTER_MODEL || "").trim(),
  };
}

/**
 * Gateway opencode — jalur KEYLESS (tanpa API key). Model `opencode/*` diproksi
 * gateway built-in opencode CLI; slug default = yang TERBUKTI hidup via
 * `npm run jev:probe` (2026-09-21): **`opencode/ling-3.0-flash-fin-free`**.
 * (Slug lama `opencode/jev-1.13-free` mati sisi-cloud: "Unexpected server
 * error" konsisten — jangan jadikan default lagi.)
 * Dipanggil lewat CLI (`opencode run`), bukan HTTP chat-completions.
 */
export interface OpencodeGatewayConfig {
  /** Path binary (default: resolusi otomatis / OPENCODE_BIN). */
  bin: string;
  /** Slug model opencode (default terbukti lewat `opencode models`). */
  model: string;
  /** Dir kerja aman untuk CLI (default temp; jangan cwd proyek user). */
  workDir: string;
}

export function opencodeGatewayConfig(): OpencodeGatewayConfig {
  return {
    bin: String(process.env.OPENCODE_BIN || "").trim(),
    model: String(process.env.OPENCODE_MODEL || "opencode/ling-3.0-flash-fin-free").trim(),
    workDir: String(process.env.OPENCODE_WORK_DIR || "").trim(),
  };
}

export function isOpencodeGatewayConfigured(cfg: OpencodeGatewayConfig): boolean {
  return cfg.model !== "";
}

export function isProviderConfigured(cfg: ProviderConfig): boolean {
  return cfg.baseUrl !== "" && cfg.apiKey !== "" && cfg.model !== "";
}

// ---------------------------------------------------------------------------
// Schema keluaran Jev (chip) — { action, confidence, riskLevel }
// ---------------------------------------------------------------------------
export const jevDecisionSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  confidence: z.number().min(1).max(100).finite(),
  riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
});

/** Paranoia tambahan: parsing dari text JSON mengecilkan peluang tipuan marker. */
export function parseJevResponse(raw: unknown): { ok: boolean; parsed?: z.infer<typeof jevDecisionSchema>; issues?: z.ZodIssue[] } {
  if (raw == null) return { ok: false, issues: [] };
  let target: unknown = raw;
  if (typeof raw === "string") {
    try {
      target = JSON.parse(raw);
    } catch {
      return { ok: false, issues: [] };
    }
  }
  const v = jevDecisionSchema.safeParse(target);
  if (!v.success) {
    return { ok: false, parsed: undefined, issues: v.error.issues };
  }
  return { ok: true, parsed: v.data };
}

// ---------------------------------------------------------------------------
// Jev state builder — deterministik, whitelist, fail-closed
// ---------------------------------------------------------------------------
export interface JevDataHealth {
  source: string;
  ok: boolean;
  detail: string;
}

export interface JevKeelSummary {
  action: string | null;
  confidence: number | null;
  flow: string | null;
  futuresBias: string | null;
  fundingBps: number | null;
  openInterestUsd: number | null;
  lsrTaker: number | null;
  confluenceScore: number | null;
  liquidityDepthUsd: number | null;
  reasoning: string | null;
  discardedReason: string | null;
  mtfState: {
    activeState: string | null;
    nearestBSL: { midPrice: number | null; estimatedVolumeUSD: number | null } | null;
    nearestSSL: { midPrice: number | null; estimatedVolumeUSD: number | null } | null;
    recentSweep: { type: string | null; wickRejectionPercent: number | null; invalidationPrice: number | null } | null;
  } | null;
}

// (FIX-E audit 2026-09-21: duplikat deklarasi JevKeelSummary dihapus —
// interface merge TS membuat duplikasi ini silent, tapi membingungkan.)

export interface JevState {
  symbol: string;
  currentPrice: number | null;
  timeframe: string;
  keel: JevKeelSummary;
  dataHealth: JevDataHealth[];
  multiTf: Record<string, { rsi: number | null; ema20: number | null; ema50: number | null; macdHistogram: number | null; trend: string | null } | null>;
  futures: Record<string, unknown> | null;
  macro: Record<string, unknown> | null;
  onChainPolicy: string;
  backtest: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 600) : null);

export interface JevStateInput {
  symbol: string;
  currentPrice: number;
  timeframe?: string;
  keelSummary: Record<string, unknown> | null;
  dataHealth: Array<{ source: string; ok: boolean; detail: string }>;
  multiTf: Record<string, { rsi?: number | null; ema20?: number | null; ema50?: number | null; macdHistogram?: number | null; trend?: string | null } | null>;
  futuresDetail?: Record<string, unknown> | null;
  macroEcho?: Record<string, unknown> | null;
  onChainPolicy: string;
  backtestCtx?: string;
}

export function buildJevState(input: JevStateInput): JevState {
  const ks = input.keelSummary && typeof input.keelSummary === "object" ? (input.keelSummary as Record<string, any>) : null;
  const mtfRaw = input.multiTf && typeof input.multiTf === "object" ? input.multiTf : {};
  const multiTf: JevState["multiTf"] = {};
  const TF_ORDER = ["15m", "1h", "4h"];
  for (const tf of TF_ORDER) {
    const t = mtfRaw[tf];
    if (!t || typeof t !== "object") {
      multiTf[tf] = null;
      continue;
    }
    multiTf[tf] = {
      rsi: num(t.rsi),
      ema20: num(t.ema20),
      ema50: num(t.ema50),
      macdHistogram: num(t.macdHistogram),
      trend: str(t.trend),
    };
  }

  const mtfState = ks?.mtfState && typeof ks.mtfState === "object" ? (ks.mtfState as Record<string, any>) : null;
  const sweep = mtfState?.recentSweep && typeof mtfState.recentSweep === "object" ? (mtfState.recentSweep as Record<string, any>) : null;

  const health = Array.isArray(input.dataHealth)
    ? input.dataHealth.slice(0, 20).map((h) => ({
        source: String(h.source ?? "?").slice(0, 40),
        ok: Boolean(h.ok),
        detail: String(h.detail ?? "").slice(0, 300),
      }))
    : [];

  const futFields: Record<string, unknown> = {};
  if (input.futuresDetail && typeof input.futuresDetail === "object") {
    const f = input.futuresDetail as Record<string, any>;
    for (const k of ["fundingBps", "markPrice", "openInterestUsd", "lsrTaker", "lsrAccount", "longLiqUsd", "shortLiqUsd", "volume24hUsd", "biasReason", "source"]) {
      futFields[k] = num(f[k]) ?? str(f[k]);
    }
  }

  const macroFields: Record<string, unknown> = {};
  if (input.macroEcho && typeof input.macroEcho === "object") {
    const m = input.macroEcho as Record<string, any>;
    for (const k of ["vix", "riskIndex", "upcomingCount", "source", "latestFomc", "fedStance"]) {
      macroFields[k] = num(m[k]) ?? str(m[k]);
    }
  }

  return {
    symbol: String(input.symbol || "BTC/USDT"),
    currentPrice: num(input.currentPrice),
    timeframe: str(input.timeframe) ?? "15m",
    keel: {
      action: str(ks?.action),
      confidence: num(ks?.confidence),
      flow: str(ks?.flow),
      futuresBias: str(ks?.futuresBias),
      fundingBps: num(ks?.fundingBps),
      openInterestUsd: num(ks?.openInterestUsd),
      lsrTaker: num(ks?.lsrTaker),
      confluenceScore: num(ks?.confluenceScore ?? ks?.confluence?.score),
      liquidityDepthUsd: num(ks?.liquidityDepthUsd),
      reasoning: str(ks?.reasoning),
      discardedReason: str(ks?.discardedReason),
      mtfState: mtfState
        ? {
            activeState: str(mtfState.activeState),
            nearestBSL: mtfState.nearestBSL ? { midPrice: num(mtfState.nearestBSL.midPrice), estimatedVolumeUSD: num(mtfState.nearestBSL.estimatedVolumeUSD) } : null,
            nearestSSL: mtfState.nearestSSL ? { midPrice: num(mtfState.nearestSSL.midPrice), estimatedVolumeUSD: num(mtfState.nearestSSL.estimatedVolumeUSD) } : null,
            recentSweep: sweep ? { type: str(sweep.type), wickRejectionPercent: num(sweep.wickRejectionPercent), invalidationPrice: num(sweep.invalidationPrice) } : null,
          }
        : null,
    },
    dataHealth: health,
    multiTf,
    futures: input.futuresDetail && typeof input.futuresDetail === "object" ? futFields : null,
    macro: input.macroEcho && typeof input.macroEcho === "object" ? macroFields : null,
    onChainPolicy: String(input.onChainPolicy || "No on-chain data policy."),
    backtest: str(input.backtestCtx) ?? "Tidak ada konteks backtest.",
  };
}

/** Prompt deterministik untuk wrapper chat-completions. */
export function jevStateToPrompt(state: JevState): string {
  const failed = state.dataHealth.filter((d) => !d.ok).map((d) => d.source);
  const healthLines = state.dataHealth
    .map((d) => `- ${d.source}: ${d.ok ? "OK" : "GAGAL"} — ${d.detail}`)
    .join("\n");
  const mtfLines = Object.entries(state.multiTf)
    .map(([tf, t]) =>
      t
        ? `- [${tf}] RSI ${t.rsi ?? "N/A"} | EMA20 ${t.ema20 ?? "N/A"} vs EMA50 ${t.ema50 ?? "N/A"} | MACD hist ${t.macdHistogram ?? "N/A"} | Tren ${t.trend ?? "N/A"}`
        : `- [${tf}] KOSONG (data gagal — jangan analisis TF ini)`
    )
    .join("\n");

  return [
    `Anda adalah Jev (System One) — model keputusan terstruktur untuk trading. Aset: ${state.symbol} | harga: $${state.currentPrice ?? "N/A"} | TF: ${state.timeframe}.`,
    `Sumber data REAL yang dihitung server (bukan prediksi LLM):`,
    JSON.stringify(state.keel, null, 0),
    `Status data:`,
    healthLines,
    `Teknikal multi-TF:`,
    mtfLines,
    state.futures ? `Futures detail: ${JSON.stringify(state.futures)}` : "Futures: no-data.",
    state.macro ? `Macro real echo: ${JSON.stringify(state.macro)}` : "Macro: no-data.",
    state.onChainPolicy,
    `Backtest calibration: ${state.backtest}`,
    `ATURAN: 1) Setiap sumber GAGAL di status data WAJIB kita kenali — jangan mengarang angka untuk sumber yang gagal. 2) On-chain directional weight ZERO. 3) Keputusan harus konsisten dengan keel SUMMARY dan arah data.`,
    `Jawab HANYA JSON tanpa markdown dengan field: {"action":"BUY"|"SELL"|"HOLD","confidence": (1-100), "riskLevel":"LOW"|"MEDIUM"|"HIGH"}`,
    failed.length > 0 ? `Sumber yang GAGAL dan wajib dipertimbangkan: ${failed.join(", ")}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Error display safety — alasan kegagalan provider boleh tampil di console/UI,
// TAPI tidak boleh membawa secret (key/token). Dipakai chain & probe.
// ---------------------------------------------------------------------------
// Urutan penting: token sk-* diredact DULU supaya pola key=value yang greedy
// tidak menelan tokennya (dulu REDACT_RE makan "Bearer sk-..." sekaligus
// sehingga marker [sk-redacted] tak pernah muncul). Value key=value dibatasi
// satu token tanpa spasi supaya "Bearer <token>" polos tetap ketangkap pola
// bearer khusus di bawah tanpa menghapus marker yang sudah ada.
const SK_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const REDACT_KV_RE = /(authorization|api[_-]?key|apikey|secret|token)\s*[:=]\s*[^\s,;|]+/gi;
const BEARER_TOKEN_RE = /\bbearer\s+(?!\[)[^\s,;|]+/gi;

export function sanitizeJevError(msg: unknown, max = 200): string {
  let s = typeof msg === "string" ? msg : String(msg ?? "unknown error");
  s = s.replace(SK_TOKEN_RE, "[sk-redacted]");
  s = s.replace(REDACT_KV_RE, "[redacted]");
  s = s.replace(BEARER_TOKEN_RE, "Bearer [redacted]");
  s = s.replace(/[^\x20-\x7E]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // ellipsis dihitung dalam budget max: hasil tepat max char, bukan max+1.
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// ---------------------------------------------------------------------------
// Probe minimal — dipakai scripts/jev-probe.mts (verdict wrapper vs native)
// ---------------------------------------------------------------------------
export interface ProbeResult {
  provider: JevProviderId;
  ok: boolean;
  rawText: string;
  parsed: z.infer<typeof jevDecisionSchema> | null;
  error?: string;
  status?: number;
  latencyMs?: number;
}

export async function probeJevProvider(
  provider: JevProviderId,
  cfg: ProviderConfig,
  callImpl: (req: {
    baseUrl: string;
    apiKey: string;
    model: string;
    prompt: string;
    timeoutMs: number;
  }) => Promise<{ ok: boolean; rawText?: string; data?: unknown; error?: string; status?: number; latencyMs?: number }>
): Promise<ProbeResult> {
  const prompt = [
    'Kamu Jev System One decision model. Jawab HANYA JSON tanpa markdown: {"action":"HOLD","confidence":1,"riskLevel":"LOW"}',
    "Jangan tambahkan teks lain.",
  ].join("\n");
  const res = await callImpl({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, prompt, timeoutMs: 20_000 });
  const rawText = res.rawText ?? "";
  const parsed = parseJevResponse(res.data ?? rawText);
  return {
    provider,
    ok: res.ok && parsed.ok,
    rawText: rawText.slice(0, 2000),
    parsed: parsed.parsed ?? null,
    error: res.error,
    status: res.status,
    latencyMs: res.latencyMs,
  };
}