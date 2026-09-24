/**
 * src/logic/decisionPipeline.ts
 * FE-PIPELINE-1 — satu tabel transparansi pipeline keputusan:
 * KEEL → JEV → LLM → FINAL (yang dipakai order).
 *
 * Murni & deterministik: TIDAK membaca env/DB/network, tidak mengarang angka.
 * Kalau sebuah engine tidak mengirim nilai → null + catatan jujur, bukan default.
 *
 * Kontrak penting (jangan diubah tanpa test):
 *  - `action` = arah; LLM memakai `ai.suggestedBias` (LONG/BULLISH→BUY,
 *    SHORT/BEARISH→SELL, selainnya HOLD) karena LLM tidak punya field action.
 *  - `confidence` LLM SELALU null — LLM tidak mengembalikan confidence
 *    terstruktur; mengarang angka di sini = pelanggaran kebijakan prompt.
 *  - Baris FINAL mencatat `raw` (nilai mentah Jev/keel) terpisah dari nilai
 *    final setelah clamp + provenance gate, supaya beda angka bisa dijelaskan.
 *  - `latencyMs` hanya tersedia sebagai total request; per-tahap belum ada di
 *    payload (butuh penambahan server — di luar scope Fase 1).
 */

export type PipelineEngineId = "keel" | "jev" | "llm" | "final";
export type PipelineStatus = "OK" | "FALLBACK" | "GATED" | "NO_DATA" | "DISABLED";
export type PipelineConsensus = "SEARAH" | "DIVERGEN" | "TIDAK_LENGKAP";

export interface PipelineKeelSummary {
  action?: string | null;
  confidence?: number | null;
  flow?: string | null;
  futuresBias?: string | null;
  confluenceScore?: number | null;
  reasoning?: string | null;
  discardedReason?: string | null;
}

export interface PipelineDecisionLevel {
  action?: string | null;
  confidence?: number | null;
  riskLevel?: string | null;
  source?: string | null;
}

export interface PipelineAiInsight {
  insight?: string | null;
  suggestedBias?: string | null;
  keyLevels?: { entry?: number | null; stopLoss?: number | null; takeProfit?: number | null } | null;
  risks?: string[] | null;
  caveat?: string | null;
  dataGaps?: string[] | null;
}

/** Satu percobaan provider Jev (termasuk yang gagal) — dari respons server. */
export interface PipelineAttempt {
  provider: string;
  model?: string | null;
  ok: boolean;
  latencyMs?: number | null;
  error?: string | null;
}

/** Subset respons `/api/ai-advisor` yang dibutuhkan tabel (struktural). */
export interface PipelineInput {
  mode?: string | null;
  model?: string | null;
  geminiConfigured?: boolean | null;
  aiDisabledReason?: string | null;
  /** Slug model Jev yang MENANG (null bila semua provider gagal) — Fase 2. */
  modelId?: string | null;
  /** Latensi per-tahap; null = tahap tidak dijalankan (bukan 0 ms) — Fase 2. */
  latencyByStage?: { keel?: number | null; jev?: number | null; llm?: number | null } | null;
  /** Percobaan provider Jev berurutan, termasuk yang gagal (Fase 2). */
  jevAttempts?: PipelineAttempt[] | null;
  decisionSource?: string | null;
  decision?: PipelineDecisionLevel | null;
  jevDecision?: PipelineDecisionLevel | null;
  keelSummary?: PipelineKeelSummary | null;
  ai?: PipelineAiInsight | null;
  provenanceGate?: { kind?: string | null; note?: string | null } | null;
  dataHealth?: Array<{ source: string; ok: boolean; detail: string }> | null;
  latencyMs?: number | null;
}

export interface PipelineRow {
  id: PipelineEngineId;
  label: string;
  role: string;
  present: boolean;
  action: string | null;
  confidence: number | null;
  risk: string | null;
  source: string | null;
  status: PipelineStatus;
  latencyMs: number | null;
  notes: string[];
  /** Nilai mentah sebelum clamp/provenance gate (hanya baris FINAL). */
  raw: { action: string | null; confidence: number | null } | null;
}

export interface DecisionPipeline {
  rows: PipelineRow[];
  /** Engine yang memutuskan (dari decisionSource) — null bila tidak diketahui. */
  finalDecidedBy: PipelineEngineId | null;
  consensus: {
    label: PipelineConsensus;
    agree: number;
    total: number;
    detail: string;
  };
  failedSources: string[];
  gateActive: boolean;
}

const NOTE_MAX = 160;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clean = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};
const clip = (v: string | null, max = NOTE_MAX): string | null =>
  v != null && v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;

/** Normalisasi arah keputusan lintas engine (LLM memakai bias, bukan action). */
export function normalizePipelineAction(v: unknown): "BUY" | "SELL" | "HOLD" | null {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "") return null;
  if (s === "BUY" || s === "LONG" || s === "BULLISH") return "BUY";
  if (s === "SELL" || s === "SHORT" || s === "BEARISH") return "SELL";
  if (s === "HOLD" || s === "NEUTRAL" || s === "WAIT") return "HOLD";
  return null;
}

const shortConf = (v: number | null): string => (v != null ? `${Math.round(v)}%` : "—");

/**
 * Susun tabel pipeline dari satu snapshot respons advisor.
 * Semua field opsional — input kosong sekalipun harus menghasilkan struktur
 * valid tanpa string "undefined"/"NaN".
 */
export function buildDecisionPipeline(input: PipelineInput | null | undefined): DecisionPipeline {
  const src = input ?? {};
  const keel = src.keelSummary ?? null;
  const jev = src.jevDecision ?? null;
  const fin = src.decision ?? null;
  const ai = src.ai ?? null;
  const gate = src.provenanceGate ?? null;
  const gateActive = gate != null && clean(gate.kind) != null;
  const isAi = String(src.mode ?? "") === "ai";

  // ---------- KEEL ----------
  const keelAction = normalizePipelineAction(keel?.action);
  const keelNotes: string[] = [];
  if (keel) {
    if (num(keel.confluenceScore) != null) keelNotes.push(`confluence ${Math.round(Number(keel.confluenceScore))}%`);
    const conf = num(keel.confidence);
    if (keelAction === "HOLD" && conf != null) keelNotes.push(`confidence ${shortConf(conf)} (HOLD)`);
    const flow = clean(keel.flow);
    if (flow && flow.toUpperCase() !== "NEUTRAL") keelNotes.push(`flow ${flow}`);
    const disc = clip(clean(keel.discardedReason));
    if (disc) keelNotes.push(`discarded: ${disc}`);
    const why = clip(clean(keel.reasoning));
    if (why) keelNotes.push(why);
  }
  const keelRow: PipelineRow = {
    id: "keel",
    label: "KEEL",
    role: "quant engine lokal",
    present: keel != null,
    action: keelAction,
    confidence: num(keel?.confidence),
    risk: clean(keel?.futuresBias),
    source: keel != null ? "keel" : null,
    status: keel != null ? "OK" : "NO_DATA",
    latencyMs: num(src.latencyByStage?.keel),
    notes: keel != null ? keelNotes : ["keel summary tidak tersedia di respons (fail-closed)."],
    raw: null,
  };

  // ---------- JEV ----------
  const jevNotes: string[] = [];
  if (jev) {
    const c = num(jev.confidence);
    if (c != null) jevNotes.push(`chip ${c}/100`);
    const prov = clean(src.decisionSource);
    if (prov && prov.indexOf("jev") === 0) jevNotes.push(`dipakai sebagai arah final (${prov})`);
  }
  // Fase 2 — daftar percobaan berurutan: yang menang tanpa error, yang gagal
  // dengan alasan yang sudah disanitasi server. Bila nilai baru tidak tersedia
  // (respons lama), baris memakai catatan lama tanpa berubah perilaku.
  const attempts = Array.isArray(src.jevAttempts) ? src.jevAttempts : [];
  if (attempts.length > 0) {
    const bits = attempts
      .filter((a) => a && typeof a.provider === "string")
      .map((a) => {
        const ms = num(a.latencyMs);
        const tag = a.ok ? "ok" : `gagal${a.error ? `: ${clip(clean(String(a.error)), 140)}` : ""}`;
        return `${a.provider}${ms != null ? ` ${Math.round(ms)}ms` : ""} ${tag}`;
      });
    if (bits.length > 0) jevNotes.push(`provider dicoba: ${bits.join(" · ")}`);
  }
  // Slug model pemenang agar kolom Sumber tidak hanya berisi id provider.
  if (jev && clean(src.modelId)) jevNotes.push(`model menang: ${clean(src.modelId)}`);
  const jevRow: PipelineRow = {
    id: "jev",
    label: "JEV",
    role: "System One — chip terstruktur",
    present: jev != null,
    action: normalizePipelineAction(jev?.action),
    confidence: num(jev?.confidence),
    risk: clean(jev?.riskLevel),
    source: clean(jev?.source),
    status: jev != null ? "OK" : "NO_DATA",
    latencyMs: num(src.latencyByStage?.jev),
    notes: jev
      ? jevNotes
      : attempts.length > 0
        ? [...jevNotes, "tidak tersedia — semua provider Jev mati/tidak dikonfigurasi → arah final dari keel."]
        : ["tidak tersedia — semua provider Jev mati/tidak dikonfigurasi → arah final dari keel."],
    raw: null,
  };

  // ---------- LLM ----------
  const llmAction = normalizePipelineAction(ai?.suggestedBias);
  const llmNotes: string[] = [];
  if (ai) {
    const entry = num(ai.keyLevels?.entry);
    const sl = num(ai.keyLevels?.stopLoss);
    const tp = num(ai.keyLevels?.takeProfit);
    if (entry != null || sl != null || tp != null) {
      llmNotes.push(`levels entry ${entry ?? "—"} / SL ${sl ?? "—"} / TP ${tp ?? "—"}`);
    }
    const gaps = Array.isArray(ai.dataGaps) ? ai.dataGaps.filter((g) => clean(g) != null) : [];
    if (gaps.length > 0) llmNotes.push(`gap diakui: ${clip(gaps.join(", "))}`);
    const caveat = clip(clean(ai.caveat));
    if (caveat) llmNotes.push(caveat);
    const riskCount = Array.isArray(ai.risks) ? ai.risks.length : 0;
    if (riskCount > 0) llmNotes.push(`${riskCount} risiko terdaftar`);
  }
  llmNotes.push("LLM tidak mengembalikan confidence terstruktur — kolom conf sengaja kosong.");
  const llmStatus: PipelineStatus = isAi ? "OK" : src.aiDisabledReason ? "DISABLED" : "FALLBACK";
  const llmRow: PipelineRow = {
    id: "llm",
    label: "LLM",
    role: isAi ? "insight naratif (Gemini)" : "insight deterministik (fallback keel)",
    present: clean(ai?.insight) != null,
    action: llmAction,
    confidence: null,
    risk: isAi ? null : "keel-only",
    source: isAi ? clean(src.model) ?? "gemini" : "keel-fallback",
    status: llmStatus,
    latencyMs: num(src.latencyByStage?.llm),
    notes: llmNotes,
    raw: null,
  };

  // ---------- FINAL ----------
  const finalAction = normalizePipelineAction(fin?.action);
  const rawAction = jev != null ? normalizePipelineAction(jev.action) : keelAction;
  const rawConfidence = jev != null ? num(jev.confidence) : num(keel?.confidence);
  const finalConfidence = num(fin?.confidence);
  const finalNotes: string[] = [];
  const decidedBy = clean(src.decisionSource) ?? clean(fin?.source);
  if (decidedBy) finalNotes.push(`diputuskan oleh: ${decidedBy}`);
  if (gateActive) {
    const gateNote = clip(clean(gate?.note));
    finalNotes.push(
      `PROVENANCE GATE ${clean(gate?.kind) ?? "?"} — ENTRY ditahan (HOLD); EXIT risiko tidak diblokir.${gateNote ? ` ${gateNote}` : ""}`
    );
  }
  if (rawAction != null && finalAction != null && rawAction !== finalAction) {
    finalNotes.push(`raw ${rawAction} (${shortConf(rawConfidence)}) → final ${finalAction} (${shortConf(finalConfidence)}).`);
  } else if (rawConfidence != null && finalConfidence != null && rawConfidence !== finalConfidence) {
    finalNotes.push(
      `confidence final ${shortConf(finalConfidence)} berbeda dari raw ${shortConf(rawConfidence)} (clamp/gate, bukan data baru).`
    );
  }
  if (num(src.latencyMs) != null) finalNotes.push("latency = total request (per-tahap belum tersedia di payload).");

  const finalRow: PipelineRow = {
    id: "final",
    label: "FINAL",
    role: "dipakai order/eksekusi",
    present: fin != null,
    action: finalAction,
    confidence: finalConfidence,
    risk: clean(fin?.riskLevel),
    source: decidedBy,
    status: fin == null ? "NO_DATA" : gateActive ? "GATED" : jev == null && decidedBy === "keel" ? "FALLBACK" : "OK",
    latencyMs: num(src.latencyMs),
    notes: finalNotes.length > 0 ? finalNotes : ["—"],
    raw: { action: rawAction, confidence: rawConfidence },
  };

  // ---------- Konsensus (keel vs jev vs llm — FINAL tidak dihitung) ----------
  const parts: Array<{ label: string; action: string | null }> = [
    { label: "keel", action: keelRow.action },
    { label: "jev", action: jevRow.action },
    { label: "llm", action: llmRow.action },
  ];
  const known = parts.filter((p) => p.action != null) as Array<{ label: string; action: string }>;
  const tally = new Map<string, number>();
  for (const p of known) tally.set(p.action, (tally.get(p.action) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topCount = ranked.length > 0 ? ranked[0][1] : 0;
  const detail = known.map((p) => `${p.label} ${p.action}`).join(" · ");
  const consensus =
    known.length < 2
      ? {
          label: "TIDAK_LENGKAP" as PipelineConsensus,
          agree: 0,
          total: known.length,
          detail: detail !== "" ? detail : "belum ada engine yang memberi arah",
        }
      : topCount === known.length
        ? { label: "SEARAH" as PipelineConsensus, agree: known.length, total: known.length, detail }
        : { label: "DIVERGEN" as PipelineConsensus, agree: topCount, total: known.length, detail };

  const failedSources = (Array.isArray(src.dataHealth) ? src.dataHealth : [])
    .filter((d) => !d.ok)
    .map((d) => String(d.source));

  const sourceOf = (v: string | null): PipelineEngineId | null => {
    if (v == null) return null;
    if (v.indexOf("jev") === 0) return "jev";
    if (v === "keel") return "keel";
    if (v === "gemini") return "llm";
    return null;
  };

  return {
    rows: [keelRow, jevRow, llmRow, finalRow],
    finalDecidedBy: sourceOf(decidedBy),
    consensus,
    failedSources,
    gateActive,
  };
}



