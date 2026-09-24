/**
 * Integration — audit Gemini 3 Pro (2026-09-24) P0-A/P0-B/P0-C.
 *
 * Server pipeline (POST /api/pipeline/cycle) memanggil evaluateTradingDecision
 * di ranah Node. Sebelum fix:
 *  - P0-A: authFetch("/api/ai-decision") relative-URL THROW di native fetch
 *    Node → ditelan catch → AI (Jev/Gemini) TIDAK PERNAH jalan, selalu keel.
 *  - P0-B: provenance entry gate hanya menempel di route HTTP → keel lokal
 *    buta freshness/data hantu.
 *  - P0-C: authFetch bergantung localStorage (browser) untuk Bearer token.
 *
 * Fix: registerAiRoutes() mendaftarkan executeAiDecisionCore ke
 * aiDecisionBridge; jalur Node memanggil core LANGSUNG in-memory.
 * Semua IO di-mock (gateway CLI, SDK, DB, keel, fetch global).
 * Tidak menyentuh jaringan/DB/.env.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const ocCli = vi.hoisted(() => ({ fn: vi.fn() }));
const keelMock = vi.hoisted(() => ({
  run: vi.fn((..._args: unknown[]): { decision: unknown; rawSignalResult: unknown } => ({ decision: {}, rawSignalResult: null })),
  risk: vi.fn((..._args: unknown[]): { passed: boolean; reasons: string[] } => ({ passed: true, reasons: [] })),
}));
const globalFetch = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: vi.fn(async () => ({ text: "{}" })) };
  },
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
vi.mock("@/paperBook", () => ({
  getPaperAccount: () => ({ equity: 10000, cash: 10000, marginLocked: 0, unrealizedPnl: 0 }),
}));
vi.mock("@/src/logic/keelAdapter", () => ({
  runKeelQuantEngine: (...args: unknown[]) => keelMock.run(...args),
  evaluateKeelRisk: (...args: unknown[]) => keelMock.risk(...args),
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
import { getAiDecisionCore } from "../../src/logic/aiDecisionBridge";
import { evaluateTradingDecision, type DecisionEngineInput } from "../../src/logic/decisionEngine";
import type { MTFLiquidityAnalysis, RiskConfig, TechnicalIndicators, LLMDecision, LiquidityZone, LiquidityPoolType } from "../../src/types";

const app = express();
app.use(express.json());
registerAiRoutes(app);

function keelBuy(): { decision: LLMDecision; rawSignalResult: unknown } {
  return {
    decision: {
      action: "BUY",
      confidence: 82,
      targetPrice: 104,
      stopLoss: 97,
      takeProfit: 104,
      positionSizePercent: 5,
      reasoning: "keel local (mock)",
      source: "keel-institutional-quant",
      inferenceLatencyMs: 1,
    },
    rawSignalResult: {},
  } as { decision: LLMDecision; rawSignalResult: unknown };
}

function zone(type: LiquidityPoolType, mid: number): LiquidityZone {
  return {
    id: `${type}-15m-1`,
    timeframe: "15m",
    type,
    priceMin: mid * 0.99,
    priceMax: mid * 1.01,
    midPrice: mid,
    estimatedVolumeUSD: 14.5,
    leverageTiers: "50x - 100x",
    status: "ACTIVE",
    touches: 1,
    distancePercent: 1,
  };
}

function mtf(): MTFLiquidityAnalysis {
  return {
    marketType: "FUTURES",
    primaryTimeframe: "15m",
    macroTimeframe: "4h",
    activeState: "EQUILIBRIUM",
    nearestBSL: zone("BSL", 104),
    nearestSSL: zone("SSL", 97),
    recentSweep: null,
    zones15m: [],
    zones4h: [],
    zonesByTimeframe: {},
    confluenceScore: 70,
    confluenceSummary: "",
    huntingTarget: null,
  };
}

function technicals(): TechnicalIndicators {
  return {
    rsi: 60,
    ema20: 100,
    ema50: 99,
    macd: { macdLine: 1, signalLine: 0.5, histogram: 0.5 },
    orderBookImbalance: 1.2,
    volatility: "MEDIUM",
  };
}

function riskConfig(): RiskConfig {
  return {
    maxRiskPerTradePercent: 2,
    maxPositionPercent: 10,
    maxDrawdownLimit: 25,
    minConfidenceThreshold: 70,
    minRiskRewardRatio: 1.5,
    isEmergencyStopActive: false,
  };
}

function engineInput(over: Partial<DecisionEngineInput> = {}): DecisionEngineInput {
  return {
    symbol: "BTC/USDT",
    currentPrice: 100,
    candles: [],
    technicals: technicals(),
    mtfLiquidity: mtf(),
    activePositions: [],
    portfolioEquity: 10000,
    riskConfig: riskConfig(),
    ...over,
  };
}

beforeEach(() => {
  ocCli.fn.mockReset();
  ocCli.fn.mockResolvedValue({
    ok: true,
    data: { action: "BUY", confidence: 72, riskLevel: "MEDIUM" },
    rawText: JSON.stringify({ action: "BUY", confidence: 72, riskLevel: "MEDIUM" }),
    latencyMs: 5,
  });
  keelMock.run.mockReset();
  keelMock.run.mockImplementation(() => keelBuy());
  keelMock.risk.mockReset();
  keelMock.risk.mockReturnValue({ passed: true, reasons: [] });
  globalFetch.mockReset();
  globalFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  vi.stubGlobal("fetch", globalFetch);
  // Paksa provider Jev HTTP mati (hanya gateway keyless yang dipakai) —
  // hermetic, tidak bergantung env mesin developer.
  vi.stubEnv("JEV_ZEN_BASE_URL", "");
  vi.stubEnv("JEV_ZEN_API_KEY", "");
  vi.stubEnv("OPENROUTER_BASE_URL", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "gemini-mock-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("P0-A/C — direct core in-memory (pipeline server tanpa HTTP authFetch)", () => {
  it("registerAiRoutes mendaftarkan core ke bridge", () => {
    expect(typeof getAiDecisionCore()).toBe("function");
  });

  it("evaluateTradingDecision (Node) → AI lewat core LANGSUNG, fetch/fetch-HTTP TIDAK dipanggil", async () => {
    const d = await evaluateTradingDecision(engineInput({ aiEnabled: true }));

    // P0-A regression: dulu authFetch relative-URL throw di Node → catch →
    // keel diam-diam. Sekarang: tanpa satu pun panggilan fetch, keputusan
    // datang dari chain Jev di route/core (gateway keyless mock sukses).
    expect(globalFetch).not.toHaveBeenCalled();
    expect(ocCli.fn).toHaveBeenCalled();
    expect(d.source).toBe("ai-decision-server");
    expect(d.action).toBe("BUY");
    expect(d.stopLoss).toBe(97);
    expect(d.takeProfit).toBe(104);
    // Jej provider terbaca dari promptSummary route — bukan hasil tebakan.
    expect(String(d.promptSummary ?? "")).toContain("jevs=jev-opencode");
    expect(d.reasoning).not.toContain("[PROVENANCE GATE]");
  });

  it("route HTTP /api/ai-decision tetap identik setelah extract core (parity)", async () => {
    const res = await request(app).post("/api/ai-decision").send({
      symbol: "BTC/USDT",
      currentPrice: 100,
      technicals: technicals(),
      mtfLiquidity: { activeState: "EQUILIBRIUM", confluenceScore: 70, nearestBSL: { midPrice: 104 }, nearestSSL: { midPrice: 97 } },
      riskParams: { maxRiskPerTradePercent: 8, minConfidenceThreshold: 50 },
    });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe("BUY");
    expect(res.body.source).toBe("jev-opencode");
    expect(res.body.stopLoss).toBe(97);
  });
});

describe("P0-B — provenance gate di jantung decisionEngine", () => {
  it("fallback Keel lokal + harga basi (STALE) → HOLD [PROVENANCE GATE], bukan BUY hantu", async () => {
    const d = await evaluateTradingDecision(
      engineInput({
        aiEnabled: false,
        provenance: { market: { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() - 60_000 } },
      })
    );

    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(d.positionSizePercent).toBe(0);
    expect(d.reasoning).toContain("[PROVENANCE GATE]");
    expect(d.source).toBe("keel-institutional-quant");
    // Tidak ada IO sama sekali: gate sebelum eksekusi/risiko.
    expect(globalFetch).not.toHaveBeenCalled();
    expect(ocCli.fn).not.toHaveBeenCalled();
    expect(keelMock.risk).not.toHaveBeenCalled();
  });

  it("jalur AI in-memory + harga basi → HOLD [PROVENANCE GATE] (gate berlaku di SEMUA transport)", async () => {
    const d = await evaluateTradingDecision(
      engineInput({
        aiEnabled: true,
        provenance: { market: { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() - 60_000 } },
      })
    );

    expect(d.action).toBe("HOLD");
    expect(d.reasoning).toContain("[PROVENANCE GATE]");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("tanpa provenance (MISSING) → keel BUY tetap lolos (perilaku lama tidak berubah)", async () => {
    const d = await evaluateTradingDecision(engineInput({ aiEnabled: false }));

    expect(d.action).toBe("BUY");
    expect(d.source).toBe("keel-institutional-quant");
    expect(d.reasoning).not.toContain("[PROVENANCE GATE]");
  });
});
