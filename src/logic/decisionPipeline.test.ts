/**
 * src/logic/decisionPipeline.test.ts
 * FE-PIPELINE-1 — kontrak tabel pipeline keel → Jev → LLM → final.
 * Fokus: kejujuran angka (raw vs final), status per engine, konsensus, dan
 * larangan output "undefined"/"NaN"/angka karangan.
 */
import { describe, it, expect } from "vitest";
import {
  buildDecisionPipeline,
  normalizePipelineAction,
  type PipelineInput,
} from "./decisionPipeline";

const base: PipelineInput = {
  mode: "ai",
  model: "gemini-2.5-flash",
  geminiConfigured: true,
  decisionSource: "jev-opencode",
  decision: { action: "BUY", confidence: 65, riskLevel: "MEDIUM", source: "jev-opencode" },
  jevDecision: { action: "BUY", confidence: 65, riskLevel: "MEDIUM", source: "jev-opencode" },
  keelSummary: {
    action: "BUY",
    confidence: 72,
    flow: "ACCUMULATION",
    futuresBias: "BULLISH",
    confluenceScore: 64,
    reasoning: "Sweep SSL lalu reclaim; flow akumulasi.",
    discardedReason: null,
  },
  ai: {
    insight: "Bias long selama harga bertahan di atas SSL.",
    suggestedBias: "LONG",
    keyLevels: { entry: 100, stopLoss: 98, takeProfit: 104 },
    risks: ["makro minggu ini"],
    caveat: "data makro parsial",
    dataGaps: ["orderflow"],
  },
  dataHealth: [
    { source: "market.price", ok: true, detail: "ok" },
    { source: "futures", ok: false, detail: "GAGAL fetch" },
  ],
  latencyMs: 4200,
};

describe("buildDecisionPipeline — snapshot lengkap", () => {
  it("4 baris berurutan keel → jev → llm → final, action konvergen = SEARAH", () => {
    const p = buildDecisionPipeline(base);
    expect(p.rows.map((r) => r.id)).toEqual(["keel", "jev", "llm", "final"]);
    expect(p.rows.map((r) => r.action)).toEqual(["BUY", "BUY", "BUY", "BUY"]);
    expect(p.consensus.label).toBe("SEARAH");
    expect(p.consensus.agree).toBe(3);
    expect(p.consensus.total).toBe(3);
    expect(p.finalDecidedBy).toBe("jev");
    expect(p.gateActive).toBe(false);
  });

  it("baris FINAL memakai decisionSource + latency total, bukan angka baru", () => {
    const final = buildDecisionPipeline(base).rows[3];
    expect(final.source).toBe("jev-opencode");
    expect(final.latencyMs).toBe(4200);
    expect(final.status).toBe("OK");
    expect(final.notes.join(" ")).toContain("diputuskan oleh: jev-opencode");
    expect(final.notes.join(" ")).toContain("per-tahap belum tersedia");
  });

  it("kolom confidence LLM SELALU null (tidak mengarang) walau bias ada", () => {
    const llm = buildDecisionPipeline(base).rows[2];
    expect(llm.id).toBe("llm");
    expect(llm.confidence).toBeNull();
    expect(llm.notes.join(" ")).toContain("tidak mengembalikan confidence terstruktur");
    expect(llm.source).toBe("gemini-2.5-flash");
  });

  it("sumber data gagal dilaporkan apa adanya", () => {
    expect(buildDecisionPipeline(base).failedSources).toEqual(["futures"]);
  });
});

describe("buildDecisionPipeline — Jev mati / fallback keel", () => {
  const noJev: PipelineInput = {
    ...base,
    decisionSource: "keel",
    jevDecision: null,
    decision: { action: "BUY", confidence: 72, riskLevel: "LOW", source: "keel" },
    ai: { ...base.ai, suggestedBias: "SHORT" },
  };

  it("baris JEV jadi NO_DATA dengan alasan, bukan angka default", () => {
    const p = buildDecisionPipeline(noJev);
    const jev = p.rows[1];
    expect(jev.present).toBe(false);
    expect(jev.action).toBeNull();
    expect(jev.confidence).toBeNull();
    expect(jev.status).toBe("NO_DATA");
    expect(jev.notes.join(" ")).toContain("tidak tersedia");
  });

  it("FINAL berstatus FALLBACK dan raw diambil dari keel", () => {
    const p = buildDecisionPipeline(noJev);
    const final = p.rows[3];
    expect(final.status).toBe("FALLBACK");
    expect(final.source).toBe("keel");
    expect(final.raw).toEqual({ action: "BUY", confidence: 72 });
    expect(p.finalDecidedBy).toBe("keel");
  });

  it("keel BUY vs llm SHORT → DIVERGEN dengan detail per engine (aksi ternormalisasi)", () => {
    const p = buildDecisionPipeline(noJev);
    expect(p.consensus.label).toBe("DIVERGEN");
    expect(p.consensus.agree).toBe(1);
    expect(p.consensus.total).toBe(2);
    // Detail memakai aksi hasil normalisasi (bias SHORT → SELL) supaya bisa
    // dibandingkan lintas engine, bukan bias mentah milik LLM.
    expect(p.consensus.detail).toBe("keel BUY · llm SELL");
  });
});

describe("buildDecisionPipeline — gate, raw vs final, mode keel-only", () => {
  it("provenance gate → FINAL GATED + HOLD, tapi nilai mentah Jev tetap tercatat", () => {
    const gated: PipelineInput = {
      ...base,
      decision: { action: "HOLD", confidence: 65, riskLevel: "MEDIUM", source: "jev-opencode" },
      provenanceGate: { kind: "STALE", note: "klaim REAL tapi basi (age 45000ms > 15000ms)." },
    };
    const p = buildDecisionPipeline(gated);
    const final = p.rows[3];
    expect(final.status).toBe("GATED");
    expect(final.action).toBe("HOLD");
    expect(final.raw).toEqual({ action: "BUY", confidence: 65 });
    expect(final.notes.join(" ")).toContain("PROVENANCE GATE STALE");
    expect(final.notes.join(" ")).toContain("raw BUY (65%) → final HOLD");
    expect(p.gateActive).toBe(true);
  });

  it("confidence final beda dari raw dijelaskan sebagai clamp/gate, bukan data baru", () => {
    const clamped: PipelineInput = {
      ...base,
      decision: { action: "BUY", confidence: 40, riskLevel: "MEDIUM", source: "jev-opencode" },
    };
    const final = buildDecisionPipeline(clamped).rows[3];
    expect(final.confidence).toBe(40);
    expect(final.raw).toEqual({ action: "BUY", confidence: 65 });
    expect(final.notes.join(" ")).toContain("confidence final 40% berbeda dari raw 65%");
  });

  it("mode keel + aiDisabledReason → baris LLM DISABLED dan tidak menyesatkan", () => {
    const keelOnly: PipelineInput = {
      ...base,
      mode: "keel",
      model: undefined,
      aiDisabledReason: "KEY_MISSING",
      ai: { insight: "Mode AI nonaktif. Ringkasan keel: ...", suggestedBias: "BULLISH" },
    };
    const llm = buildDecisionPipeline(keelOnly).rows[2];
    expect(llm.status).toBe("DISABLED");
    expect(llm.source).toBe("keel-fallback");
    expect(llm.risk).toBe("keel-only");
    expect(llm.action).toBe("BUY");
  });
});

describe("buildDecisionPipeline — fail-closed & normalisasi", () => {
  it("input kosong → semua baris NO_DATA, tanpa 'undefined'/'NaN' di output", () => {
    const p = buildDecisionPipeline({});
    expect(p.rows).toHaveLength(4);
    expect(p.rows.every((r) => r.status === "NO_DATA" || r.id === "llm")).toBe(true);
    expect(p.rows[0].status).toBe("NO_DATA");
    expect(p.rows[3].status).toBe("NO_DATA");
    expect(p.rows[3].raw).toEqual({ action: null, confidence: null });
    expect(p.consensus.label).toBe("TIDAK_LENGKAP");
    expect(p.finalDecidedBy).toBeNull();
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("undefined");
    expect(serialized).not.toContain("NaN");
  });

  it("input null tidak melempar dan tetap struktur valid", () => {
    const p = buildDecisionPipeline(null);
    expect(p.rows.map((r) => r.id)).toEqual(["keel", "jev", "llm", "final"]);
    expect(p.failedSources).toEqual([]);
  });

  it("keelSummary null → baris KEEL NO_DATA dengan catatan fail-closed", () => {
    const p = buildDecisionPipeline({ ...base, keelSummary: null, decisionSource: "jev-opencode" });
    expect(p.rows[0].status).toBe("NO_DATA");
    expect(p.rows[0].confidence).toBeNull();
    expect(p.rows[0].notes.join(" ")).toContain("fail-closed");
    // Jev + LLM tetap dikenal → konsensus tetap dihitung dari dua engine
    expect(p.consensus.total).toBe(2);
  });

  it("normalizePipelineAction memetakan bias/aksi lintas engine", () => {
    expect(normalizePipelineAction("BUY")).toBe("BUY");
    expect(normalizePipelineAction("LONG")).toBe("BUY");
    expect(normalizePipelineAction("bullish")).toBe("BUY");
    expect(normalizePipelineAction("SHORT")).toBe("SELL");
    expect(normalizePipelineAction("bearish")).toBe("SELL");
    expect(normalizePipelineAction("NEUTRAL")).toBe("HOLD");
    expect(normalizePipelineAction("WAIT")).toBe("HOLD");
    expect(normalizePipelineAction("")).toBeNull();
    expect(normalizePipelineAction(null)).toBeNull();
    expect(normalizePipelineAction("MOON")).toBeNull();
  });

  it("reasoning sangat panjang dipotong, bukan dibuang", () => {
    const long = "x".repeat(400);
    const keelLong = { ...(base.keelSummary ?? {}), reasoning: long };
    const p = buildDecisionPipeline({ ...base, keelSummary: keelLong });
    const note = p.rows[0].notes.find((n) => n.startsWith("x"));
    expect(note).toBeDefined();
    expect(note!.length).toBeLessThanOrEqual(160);
    expect(note!.endsWith("…")).toBe(true);
  });
});

describe("buildDecisionPipeline — Fase 2: telemetri per-tahap", () => {
  const staged = {
    ...base,
    modelId: "opencode/ling-3.0-flash-fin-free",
    latencyByStage: { keel: 3, jev: 26282, llm: 4100 },
    jevAttempts: [
      { provider: "jev-opencode", model: "opencode/ling-3.0-flash-fin-free", ok: true, latencyMs: 26282, error: null },
    ],
  };

  it("keel/jev/llm memakai latencyByStage; total tetap di baris FINAL", () => {
    const p = buildDecisionPipeline(staged);
    expect(p.rows[0].latencyMs).toBe(3);
    expect(p.rows[1].latencyMs).toBe(26282);
    expect(p.rows[2].latencyMs).toBe(4100);
    expect(p.rows[3].latencyMs).toBe(4200);
  });

  it("baris JEV merangkum percobaan berurutan termasuk yang menang", () => {
    const p = buildDecisionPipeline({
      ...staged,
      jevDecision: null,
      decision: { action: "BUY", confidence: 72, riskLevel: "LOW", source: "keel" },
      decisionSource: "keel",
      jevAttempts: [
        { provider: "jev-opencode", model: "m1", ok: false, latencyMs: 5, error: "gateway down" },
        { provider: "jev-zen", model: "m2", ok: false, latencyMs: 12, error: "HTTP 429" },
        { provider: "jev-openrouter", model: "m3", ok: true, latencyMs: 300, error: null },
      ],
    });
    const jev = p.rows[1];
    expect(jev.status).toBe("NO_DATA");
    const txt = jev.notes.join(" ");
    expect(txt).toContain("jev-opencode 5ms gagal: gateway down");
    expect(txt).toContain("jev-zen 12ms gagal: HTTP 429");
    expect(txt).toContain("jev-openrouter 300ms ok");
  });

  it("respons lama tanpa field Fase 2 → tabel tetap seperti Fase 1", () => {
    const p = buildDecisionPipeline(base);
    expect(p.rows[0].latencyMs).toBeNull();
    expect(p.rows[1].latencyMs).toBeNull();
    expect(p.rows[2].latencyMs).toBeNull();
    expect(p.rows[1].notes.every((n) => !n.startsWith("provider dicoba"))).toBe(true);
  });

  it("attempt rusak (provider bukan string) dilewati tanpa melempar", () => {
    const p = buildDecisionPipeline({
      ...base,
      jevAttempts: [{ provider: 7, ok: false } as unknown as never, { provider: "jev-zen", ok: true, latencyMs: 9, error: null }],
    });
    const txt = p.rows[1].notes.join(" ");
    expect(txt).toContain("jev-zen 9ms ok");
    expect(txt).not.toContain("7 ");
  });

  it("slug model pemenang ditulis ke catatan JEV saat tersedia", () => {
    const p = buildDecisionPipeline({
      ...base,
      modelId: "typesafe/jev-1.13",
      jevAttempts: [{ provider: "jev-openrouter", model: "typesafe/jev-1.13", ok: true, latencyMs: 300, error: null }],
    });
    const txt = p.rows[1].notes.join(" ");
    expect(txt).toContain("model menang: typesafe/jev-1.13");
  });
});


