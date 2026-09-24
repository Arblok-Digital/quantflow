/**
 * Integration test — telemetri per-tahap /api/ai-advisor (FE-PIPELINE-1 Fase 2).
 * Fokus: respons membawa `modelId`, `latencyByStage{keel,jev,llm}` dan
 * `jevAttempts[]` (termasuk percobaan GAGAL) — jujur, tanpa apiKey/token.
 * Harness meniru tests/integration/jevDecision.test.ts (mock provider, SDK
 * Gemini, DB, keel; tidak menyentuh jaringan/DB/.env).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const sdk = vi.hoisted(() => ({ generateContent: vi.fn() }));
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
  appendAudit: vi.fn(),
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

const GEMINI_ADVISOR_PAYLOAD = JSON.stringify({
  insight:
    "market orderflow futures macro_real klines_1h klines_4h technicals_mtf onchain macro provenance:market.price gagal terfetch; sintesis mengikuti Jev.",
  suggestedBias: "LONG",
  keyLevels: { entry: 100.5, stopLoss: 98, takeProfit: 104 },
  risks: ["data tipis"],
  caveat: "banyak sumber gagal — jangan overleveraged",
  dataGaps: ["market", "orderflow", "futures", "macro_real", "klines_1h", "klines_4h", "technicals_mtf", "onchain", "macro", "provenance:market.price"],
});

beforeEach(() => {
  feedback.zen = "unset";
  feedback.or = "unset";
  vi.stubGlobal("fetch", globalFetch);
  globalFetch.mockClear();
  sdk.generateContent.mockReset();
  sdk.generateContent.mockResolvedValue({ text: GEMINI_ADVISOR_PAYLOAD });
  ocCli.fn.mockReset();
  ocCli.fn.mockResolvedValue({ ok: false, error: "gateway down (mocked)", latencyMs: 5 });
});

afterEach(() => {
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

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});

describe("advisor stage telemetry (Fase 2)", () => {
  it("Jev gateway sukses → modelId + latencyByStage + 1 attempt ok", async () => {
    ocCli.fn.mockResolvedValue({
      ok: true,
      data: { action: "BUY", confidence: 66, riskLevel: "MEDIUM" },
      rawText: JSON.stringify({ action: "BUY", confidence: 66, riskLevel: "MEDIUM" }),
      latencyMs: 5,
    });
    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("ai");
    expect(typeof res.body.modelId).toBe("string");
    expect(res.body.modelId.length).toBeGreaterThan(0);
    expect(res.body.jevDecision.source).toBe("jev-opencode");
    const stage = asRecord(res.body.latencyByStage);
    expect(typeof stage.keel).toBe("number");
    expect(stage.keel).toBeGreaterThanOrEqual(0);
    expect(typeof stage.jev).toBe("number");
    expect(stage.jev).toBeGreaterThanOrEqual(0);
    expect(typeof stage.llm).toBe("number");
    expect(stage.llm).toBeGreaterThanOrEqual(0);
    const attempts = res.body.jevAttempts;
    expect(Array.isArray(attempts)).toBe(true);
    expect(attempts.length).toBe(1);
    expect(attempts[0]).toMatchObject({ provider: "jev-opencode", ok: true, error: null });
  });

  it("zen 429 lalu openrouter sukses → kedua attempt tercatat + gagal disanitasi", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    vi.stubEnv("JEV_ZEN_MODEL", "oc/jev-1.13-free");
    vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "or-key");
    vi.stubEnv("OPENROUTER_MODEL", "typesafe/jev-1.13");
    feedback.zen = "http429";
    feedback.or = "ok";
    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("ai");
    expect(res.body.jevDecision.source).toBe("jev-openrouter");
    expect(res.body.modelId).toBe("typesafe/jev-1.13");
    const attempts = res.body.jevAttempts;
    expect(Array.isArray(attempts)).toBe(true);
    // jev-opencode (tier keyless paling depan) gagal duluan di default harness,
    // lalu zen 429, lalu openrouter sukses — KETIGA attempt tercatat berurutan.
    expect(attempts.length).toBe(3);
    expect(attempts[0]).toMatchObject({ provider: "jev-opencode", ok: false });
    expect(attempts[1]).toMatchObject({ provider: "jev-zen", ok: false });
    expect(attempts[2]).toMatchObject({ provider: "jev-openrouter", ok: true, error: null });
    // Kegagalan HTTP dilaporkan sebagai alasan ringkas, bukan JSON mentah.
    expect(String(attempts[1].error)).toContain("HTTP 429");
    const stage = asRecord(res.body.latencyByStage);
    expect(typeof stage.jev).toBe("number");
    expect(stage.jev).toBeGreaterThanOrEqual(0);
  });

  it("semua Jev gagal + Gemini mati → mode keel + attempts semua false + modelId null", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "http503";
    feedback.or = "http503";
    sdk.generateContent.mockRejectedValue(new Error("gemini down (mocked)"));
    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("keel");
    expect(res.body.decisionSource).toBe("keel");
    expect(res.body.modelId).toBeNull();
    const attempts = res.body.jevAttempts;
    expect(Array.isArray(attempts)).toBe(true);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a: any) => a.ok === false)).toBe(true);
    const stage = asRecord(res.body.latencyByStage);
    expect(typeof stage.keel).toBe("number");
    expect(typeof stage.jev).toBe("number");
    expect(stage.llm === null || typeof stage.llm === "number").toBe(true);
  });

  it("error key palsu di provider → disanitasi total, tidak bocor ke respons", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "zen-key");
    feedback.zen = "http503";
    feedback.or = "http503";
    ocCli.fn.mockResolvedValue({
      ok: false,
      error: "boom apiKey=sk-or-v1-SECRET-DO-NOT-LEAK dan Bearer token-SECRET-XYZ",
      latencyMs: 7,
    });
    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    const attempts = res.body.jevAttempts;
    expect(Array.isArray(attempts)).toBe(true);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a: any) => a.ok === false)).toBe(true);
    const raw2 = JSON.stringify(res.body);
    // Tidak ada fragmen secret tersisa: token sk-* hilang utuh (karena pola
    // key=value single-token memang sengaja menelan sisa token, lihat
    // jevChip.test.ts), dan bearer dibatasi marker.
    expect(raw2).not.toContain("sk-or-v1-SECRET-DO-NOT-LEAK");
    expect(raw2).not.toContain("token-SECRET-XYZ");
    expect(raw2).not.toContain("SECRET-DO-NOT-LEAK");
    expect(raw2).not.toContain("SECRET-XYZ");
    expect(raw2).toContain("[redacted]");
  });

  it("keel-only tanpa key Gemini dan semua provider Jev mati → llm null + attempts tercatat", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    feedback.zen = "http503";
    feedback.or = "http503";
    const res = await request(app).post("/api/ai-advisor").send(sendBody);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("keel");
    const stage = asRecord(res.body.latencyByStage);
    expect(typeof stage.keel).toBe("number");
    expect(typeof stage.jev).toBe("number");
    expect(stage.llm).toBeNull();
  });
});
