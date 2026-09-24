/**
 * Integration test — chain Jev di /api/ai-decision (S9).
 * Chain: jev-zen → jev-openrouter → Gemini → Keel → 503.
 * Semua IO di-mock (fetch global untuk provider, SDK Gemini, DB, keel).
 * Tidak menyentuh jaringan/DB/.env. Jev state tetap dibangun dari ctx asli.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const sdk = vi.hoisted(() => ({ generateContent: vi.fn() }));
const auditCalls = vi.hoisted(() => [] as Array<{ kind: string; payload: any }>);
const ocCli = vi.hoisted(() => ({ fn: vi.fn() }));
const feedback = vi.hoisted(() => ({
  zen: "ok",
  or: "ok",
}));
const JEV_OK = JSON.stringify({ action: "BUY", confidence: 72, riskLevel: "MEDIUM" });

const globalFetch = vi.hoisted(() =>
  vi.fn(async (url: unknown) => {
    const u = String(url);
    const mode = u.includes("zen") ? feedback.zen : u.includes("openrouter") ? feedback.or : "error";
    let body: any = { choices: [{ message: { content: JEV_OK } }] };
    let status = 200;
    let ok = true;
    let text = "";
    if (mode === "http429") {
      ok = false;
      status = 429;
      text = "rate limited";
    } else if (mode === "http503") {
      ok = false;
      status = 503;
      text = "overloaded";
    } else if (mode === "garbage") {
      body = { choices: [{ message: { content: "i have no idea" } }] };
    } else if (mode === "error") {
      ok = false;
      status = 500;
      text = "boom";
    }
    return { ok, status, json: async () => body, text: async () => text };
  })
);

vi.mock("@google/genai", () => ({
  GoogleGenAI: class { models = { generateContent: sdk.generateContent }; },
}));
vi.mock("@/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("@/src/logic/aiProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/logic/aiProviders")>();
  return { ...actual, callOpencodeCli: ocCli.fn };
});
vi.mock("@/db", () => ({
  appendAudit: (kind: string, payload: any) => { auditCalls.push({ kind, payload }); },
  saveAgentDecisionDb: vi.fn(),
  listReplayRunsDb: () => [],
}));
vi.mock("@/paperBook", () => ({ getPaperAccount: () => ({ equity: 10000, cash: 10000, marginLocked: 0, unrealizedPnl: 0 }) }));
vi.mock("@/src/logic/keelAdapter", () => ({
  runKeelQuantEngine: () => ({
    decision: { action: "SELL", confidence: 55, stopLoss: 105, takeProfit: 95, targetPrice: 105, positionSizePercent: 5, reasoning: "keel fallback" },
    rawSignalResult: { smartMoneyFlow: "NEUTRAL", liquidityDepthUsd: null },
  }),
  evaluateKeelRisk: () => ({ passed: true, reasons: [] }),
}));
vi.mock("@/src/data/marketFetcher", () => ({
  fetchMarketData: async () => ({ success: false }),
  fetchRecentTrades: async () => ({ success: false, trades: [], source: "NONE" }),
  fetchFuturesMetrics: async () => ({ success: false, source: "NONE" }),
  fetchMacroReal: async () => ({ ok: false, source: "NONE" }),
  fetchOHLCVWithFallback: async () => ({ candles: [], source: "NONE" }),
  deriveMacroRiskIndex: () => 0,
}));

import { registerAiRoutes } from "../../src/server/routes/ai";

const app = express();
app.use(express.json());
registerAiRoutes(app);

const GEMINI_PAYLOAD = JSON.stringify({
  action: "HOLD", confidence: 1, targetPrice: 100, stopLoss: 98,
  takeProfit: 104, positionSizePercent: 1, reasoning: "sdk fallback",
});

beforeAll(() => {
  vi.stubEnv("GEMINI_API_KEY", "gemini-mock-key");
});

beforeEach(() => {
  auditCalls.length = 0;
  feedback.zen = "unset";
  feedback.or = "unset";
  vi.stubGlobal("fetch", globalFetch);
  globalFetch.mockClear();
  sdk.generateContent.mockReset();
  // Gateway keyless opencode: TIER PALING DEPAN selalu "configured" (model
  // default). Default behavior test = gagal → chain jatuh ke zen/Gemini
  // (menguji fallback). Test khusus mengganti jadi sukses.
  ocCli.fn.mockReset();
  ocCli.fn.mockResolvedValue({ ok: false, error: "gateway down (mocked)", latencyMs: 5 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sendBody = {
  symbol: "BTC/USDT",
  currentPrice: 100,
  technicals: { rsi: 45, ema20: 99.5, ema50: 98 },
  mtfLiquidity: {
    activeState: "HUNTING_BSL",
    nearestBSL: { midPrice: 104 },
    nearestSSL: { midPrice: 97 },
  },
  riskParams: { maxRiskPerTradePercent: 8, minConfidenceThreshold: 50 },
};

describe("Jev decision chain (S9)", () => {
  it("zen sukses → 200 source=jev-zen, audit bawa provider+jevConfidence, size clamp", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    vi.stubEnv("JEV_ZEN_MODEL", "oc/jev-1.13-free");
    feedback.zen = "ok";

    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("jev-zen");
    expect(res.body.decisionSource).toBe("jev-zen");
    expect(res.body.jevConfidence).toBe(72);
    expect(res.body.jevRiskLevel).toBe("MEDIUM");
    expect(res.body.action).toBe("BUY");
    expect(res.body.stopLoss).toBe(97);
    expect(res.body.takeProfit).toBe(104);
    expect(res.body.positionSizePercent).toBeLessThanOrEqual(8);
    expect(res.body.reasoning).toContain("Jev BUY");
    // Gemini tidak boleh dipanggil ketika Jev sukses
    expect(sdk.generateContent).not.toHaveBeenCalled();

    const audit = auditCalls.find((a) => a.kind === "decision");
    expect(audit).toBeTruthy();
    expect(audit!.payload.provider).toBe("jev-zen");
    expect(audit!.payload.modelId).toBe("oc/jev-1.13-free");
    expect(audit!.payload.jevConfidence).toBe(72);
    expect(audit!.payload.jevRiskLevel).toBe("MEDIUM");
  });

  it("gateway opencode keyless sukses → 200 source=jev-opencode (tanpa API key)", async () => {
    ocCli.fn.mockResolvedValue({
      ok: true,
      data: { action: "BUY", confidence: 72, riskLevel: "MEDIUM" },
      rawText: JSON.stringify({ action: "BUY", confidence: 72, riskLevel: "MEDIUM" }),
      latencyMs: 5,
    });
    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("jev-opencode");
    expect(res.body.jevConfidence).toBe(72);
    expect(res.body.stopLoss).toBe(97);
    expect(res.body.takeProfit).toBe(104);
    // keyless: tidak ada panggilan HTTP chat-completions apa pun
    expect(globalFetch).not.toHaveBeenCalled();
    expect(sdk.generateContent).not.toHaveBeenCalled();
    // callOpencodeCli dipakai dengan slug default terverifikasi
    expect(ocCli.fn).toHaveBeenCalledTimes(1);
    const firstCall = ocCli.fn.mock.calls[0][0] as { model: string };
    expect(firstCall.model).toBe("opencode/ling-3.0-flash-fin-free");
    const audit = auditCalls.find((a) => a.kind === "decision");
    expect(audit!.payload.provider).toBe("jev-opencode");
    expect(audit!.payload.modelId).toBe("opencode/ling-3.0-flash-fin-free");
  });

  it("gateway gagal (mock down) → jatuh ke zen → 200 source=jev-zen", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "ok";
    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(ocCli.fn).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("jev-zen");
  });

  it("zen HTTP 429 → fallback openrouter sukses → 200 source=jev-openrouter", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    vi.stubEnv("JEV_ZEN_MODEL", "oc/jev-1.13-free");
    vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    vi.stubEnv("OPENROUTER_MODEL", "typesafe/jev-1.13");
    feedback.zen = "http429";
    feedback.or = "ok";

    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("jev-openrouter");
    expect(sdk.generateContent).not.toHaveBeenCalled();
    const audit = auditCalls.find((a) => a.kind === "decision");
    expect(audit!.payload.provider).toBe("jev-openrouter");
  });

  it("kedua Jev mati → Gemini (SDK) → 200 source gemini", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "http503";
    feedback.or = "http503";
    sdk.generateContent.mockResolvedValue({ text: GEMINI_PAYLOAD });

    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.source).toMatch(/^gemini-/);
    expect(sdk.generateContent).toHaveBeenCalledTimes(1);
  });

  it("Jev output invalid → fail ke Gemini → 200 source gemini", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "garbage";
    sdk.generateContent.mockResolvedValue({ text: GEMINI_PAYLOAD });

    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.source).toMatch(/^gemini-/);
  });

  it("Jev unset + Gemini mati → keel fallback → 200 source=keel-institutional-quant", async () => {
    sdk.generateContent.mockRejectedValue(new Error("UNAVAILABLE"));
    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("keel-institutional-quant");
    expect(res.body.action).toBe("SELL");
  });

  it("Jev unset + Gemini invalid JSON → 502 validation (tidak fallback diam-diam)", async () => {
    sdk.generateContent.mockResolvedValue({ text: "this is not json" });
    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe("unparseable-llm-json");
  });
});

// ---------------------------------------------------------------------------
// S10 — /api/ai-advisor dua tahap (Jev decide → Gemini insight)
// ---------------------------------------------------------------------------
const ADVISOR_OK = (bias: string) =>
  JSON.stringify({
    insight:
      "market orderflow futures macro_real klines_1h klines_4h technicals_mtf onchain macro provenance:market.price gagal terfetch; sintesis dari data tersisa tetap konservatif dan mengikuti Jev.",
    suggestedBias: bias,
    keyLevels: { entry: 100.5, stopLoss: 98, takeProfit: 104 },
    risks: ["data tipis"],
    caveat: "banyak sumber gagal — jangan overleveraged",
    dataGaps: ["market", "orderflow", "futures", "macro_real", "klines_1h", "klines_4h", "technicals_mtf", "onchain", "macro", "provenance:market.price"],
  });

describe("AI advisor dua tahap Jev+Gemini (S10)", () => {
  it("Jev gateway (keyless) decide → prompt Gemini memuat [JEV DECISION] source jev-opencode", async () => {
    ocCli.fn.mockResolvedValue({
      ok: true,
      data: { action: "BUY", confidence: 66, riskLevel: "MEDIUM" },
      rawText: JSON.stringify({ action: "BUY", confidence: 66, riskLevel: "MEDIUM" }),
      latencyMs: 5,
    });
    sdk.generateContent.mockResolvedValue({ text: ADVISOR_OK("LONG") });
    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("ai");
    expect(res.body.decision.source).toBe("jev-opencode");
    expect(res.body.decisionSource).toBe("jev-opencode");
    expect(res.body.decision.action).toBe("BUY");
    expect(res.body.jevDecision.confidence).toBe(66);
    const advisorPrompt: string = sdk.generateContent.mock.calls[0][0].contents;
    expect(advisorPrompt).toContain("[JEV DECISION");
    expect(advisorPrompt).toContain("source: jev-opencode");
  });

  it("Jev decide → prompt Gemini memuat [JEV DECISION], insight ikut arah Jev", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "ok";
    sdk.generateContent.mockResolvedValue({ text: ADVISOR_OK("LONG") });

    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("ai");
    // decision block & source
    expect(res.body.decision).toEqual({ action: "BUY", confidence: 72, riskLevel: "MEDIUM", source: "jev-zen" });
    expect(res.body.decisionSource).toBe("jev-zen");
    expect(res.body.jevDecision.action).toBe("BUY");
    expect(res.body.ai.suggestedBias).toBe("LONG");
    // prompt Gemini memuat keputusan Jev DAN state gagal dibawa
    const advisorPrompt: string = sdk.generateContent.mock.calls[0][0].contents;
    expect(advisorPrompt).toContain("[JEV DECISION");
    expect(advisorPrompt).toContain("Arah: BUY");
    expect(advisorPrompt).toContain("source: jev-zen");
    expect(advisorPrompt).toContain("orderflow: GAGAL");
  });

  it("Gemini membalik arah → server override ke arah Jev + caveat [JEV override]", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "ok";
    sdk.generateContent.mockResolvedValue({ text: ADVISOR_OK("NEUTRAL") });

    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.decision.source).toBe("jev-zen");
    expect(res.body.decision.action).toBe("BUY");
    // flipped dari NEUTRAL → LONG (ikut Jev)
    expect(res.body.ai.suggestedBias).toBe("LONG");
    expect(res.body.ai.caveat).toContain("[JEV override]");
  });

  it("Jev down (HTTP 503) → decision dari keel (deterministik); bias Gemini hanya insight [FIX-A]", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "http503";
    feedback.or = "http503";
    sdk.generateContent.mockResolvedValue({ text: ADVISOR_OK("LONG") });

    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("ai");
    expect(res.body.jevDecision).toBeNull();
    // FIX-A: arah decision dari keel mock (SELL conf 55) — BUKAN dari bias
    // Gemini (LONG). Konflik dicatat di caveat, bukan dipakai sebagai arah.
    expect(res.body.decision.source).toBe("keel");
    expect(res.body.decisionSource).toBe("keel");
    expect(res.body.decision.action).toBe("SELL");
    expect(res.body.decision.confidence).toBe(55);
    expect(res.body.decision.riskLevel).toBe("MEDIUM"); // derivasi deterministik conf 55
    // bias Gemini tetap tampil sebagai insight naratif (tetap LONG)
    expect(res.body.ai.suggestedBias).toBe("LONG");
    expect(res.body.ai.caveat).toContain("[KEEL FALLBACK]");
    expect(res.body.ai.caveat).toContain("konflik");
  });

  it("semua mati (Jev unset + Gemini macet) → keel summary (decision.source=keel)", async () => {
    sdk.generateContent.mockRejectedValue(new Error("UNAVAILABLE"));
    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("keel");
    expect(res.body.jevDecision).toBeNull();
    expect(res.body.decision.source).toBe("keel");
    expect(res.body.decisionSource).toBe("keel");
    expect(res.body.decision.action).toBe("SELL"); // dari keelSummary mock
  });

  it("keel-only fallback tetap membawa dataHealth + konteks jujur", async () => {
    sdk.generateContent.mockRejectedValue(new Error("UNAVAILABLE"));
    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.dataHealth)).toBe(true);
    expect(res.body.ai.insight).toContain("analitik belum terverifikasi");
    expect(res.body.ai.suggestedBias).toBe("BEARISH"); // keel SELL
  });
});

// ---------------------------------------------------------------------------
// P1-01 — Real-only decision inputs: fake/stale/sim provenance → gate + honesty
// ---------------------------------------------------------------------------
const GEMINI_BUY = JSON.stringify({
  action: "BUY", confidence: 70, targetPrice: 104, stopLoss: 98,
  takeProfit: 104, positionSizePercent: 5, reasoning: "sdk buy",
});

describe("P1-01 provenance handal & entry gate", () => {
  it("klaim REAL palsu (venue kosong) + Jev BUY → entry ditahan HOLD + [PROVENANCE GATE]", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "ok";
    const res = await request(app).post("/api/ai-decision").send({
      ...sendBody,
      provenance: { market: { source: "REAL", marketType: "FUTURES", exchangeTs: Date.now() } }, // venue kosong = fake
    });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("jev-zen");
    expect(res.body.action).toBe("HOLD"); // gate menang atas arah Jev BUY
    expect(res.body.reasoning).toContain("[PROVENANCE GATE]");
    expect(res.body.jevConfidence).toBe(72); // confidence tetap nyata
    expect(res.body.positionSizePercent).toBe(1); // schema wire; client zero-kan HOLD
  });

  it("klaim REAL basi (exchangeTs lama) + jalur Gemini BUY → HOLD + gate di reasoning", async () => {
    // Jev unset → chain ke Gemini. SDK balas BUY valid (98<100<104).
    sdk.generateContent.mockResolvedValue({ text: GEMINI_BUY });
    const res = await request(app).post("/api/ai-decision").send({
      ...sendBody,
      provenance: { market: { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() - 60_000 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.source).toMatch(/^gemini-/);
    expect(res.body.action).toBe("HOLD");
    expect(res.body.reasoning).toContain("[PROVENANCE GATE]");
    // FIX-B: gated HOLD → wire size 1 (kontrak sama dengan jalur Jev; dulu 0)
    expect(res.body.positionSizePercent).toBe(1);
  });

  it("klaim SIMULATED → entry ditahan (Jev zen ok tetap diproses, arah di-gate)", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "ok";
    const res = await request(app).post("/api/ai-decision").send({
      ...sendBody,
      provenance: { market: { source: "SIMULATED", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() } },
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("HOLD");
    expect(res.body.reasoning).toContain("SIMULATED");
    expect(res.body.reasoning).toContain("[PROVENANCE GATE]");
  });

  it("tanpa provenance (MISSING) → tidak diblokir (perilaku lama) & arah Jev tetap", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "ok";
    const res = await request(app).post("/api/ai-decision").send({ ...sendBody });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("BUY"); // tidak diblokir
    expect(res.body.reasoning).not.toContain("[PROVENANCE GATE]");
  });

  it("advisor: fake provenance → dataHealth provenance:market.price FAIL + gate HOLD + caveat (tanpa blokir exit)", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "ok";
    sdk.generateContent.mockResolvedValue({ text: ADVISOR_OK("LONG") });
    const res = await request(app).post("/api/ai-advisor").send({
      ...sendBody,
      provenance: { market: { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() - 20_000 } }, // basi
    });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("ai");
    const provRow = res.body.dataHealth.find((d: any) => d.source === "provenance:market.price");
    expect(provRow).toBeTruthy();
    expect(provRow.ok).toBe(false);
    expect(provRow.detail).toContain("STALE");
    // gate menang atas Jev BUY + insight LONG → NEUTRAL/HOLD
    expect(res.body.decision.action).toBe("HOLD");
    expect(res.body.ai.suggestedBias).toBe("NEUTRAL");
    expect(res.body.ai.caveat).toContain("[PROVENANCE GATE]");
    // prompt Gemini wajib menyebut sumber gagal ini (honesty passthrough)
    const advisorPrompt: string = sdk.generateContent.mock.calls[0][0].contents;
    expect(advisorPrompt).toContain("provenance:market.price");
  });

  it("advisor: provenance REAL valid → row OK dan TIDAK gate (LONG tetap)", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "ok";
    sdk.generateContent.mockResolvedValue({ text: ADVISOR_OK("LONG") });
    const res = await request(app).post("/api/ai-advisor").send({
      ...sendBody,
      provenance: { market: { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() - 50 } },
    });
    expect(res.status).toBe(200);
    const provRow = res.body.dataHealth.find((d: any) => d.source === "provenance:market.price");
    expect(provRow.ok).toBe(true);
    expect(res.body.decision.action).toBe("BUY"); // tidak di-gate
    expect(res.body.ai.caveat).not.toContain("[PROVENANCE GATE]");
  });

  // ---------------------------------------------------------------------------
  // FIX-B (audit 2026-09-21): jalur Gemini di /api/ai-decision — level SL/TP/
  // target/size dihitung deterministik dari data server (assembleDecision),
  // bukan dari angka LLM. Cermin persis kontrak jalur Jev.
  // ---------------------------------------------------------------------------
  it("gemini fallback BUY → SL/TP dari BSL/SSL server (bukan angka LLM), size clamp", async () => {
    feedback.zen = "http503";
    feedback.or = "http503";
    // LLM memberi level karangan: SL 90 / TP 200 / size 20 — di luar struktur
    // likuiditas (SSL 97 / BSL 104). Server wajib memakai 97/104.
    sdk.generateContent.mockResolvedValue({
      text: JSON.stringify({
        action: "BUY", confidence: 72, targetPrice: 200, stopLoss: 90,
        takeProfit: 200, positionSizePercent: 20, reasoning: "LLM levels",
      }),
    });
    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.source).toMatch(/^gemini-/);
    expect(res.body.action).toBe("BUY");
    expect(res.body.stopLoss).toBe(97); // SSL — bukan 90 dari LLM
    expect(res.body.takeProfit).toBe(104); // BSL — bukan 200 dari LLM
    expect(res.body.targetPrice).toBe(104);
    expect(res.body.positionSizePercent).toBe(7); // round(72/10)=7, ≤ maxRisk 8
    expect(res.body.reasoning).toContain("BSL/SSL");
  });

  it("gemini fallback confidence < ambang → HOLD fail-closed + wire size 1", async () => {
    feedback.zen = "http503";
    feedback.or = "http503";
    sdk.generateContent.mockResolvedValue({
      text: JSON.stringify({
        action: "BUY", confidence: 30, targetPrice: 200, stopLoss: 90,
        takeProfit: 200, positionSizePercent: 20, reasoning: "low conf",
      }),
    });
    const res = await request(app).post("/api/ai-decision").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("HOLD");
    expect(res.body.positionSizePercent).toBe(1); // kontrak wire HOLD (client zero-kan)
    expect(res.body.reasoning).toContain("risk gate");
  });
});