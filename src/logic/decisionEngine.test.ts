import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { evaluateTradingDecision } from "./decisionEngine";
import type { DecisionEngineInput } from "./decisionEngine";
import { setAiDecisionCore, resetAiDecisionCore } from "./aiDecisionBridge";
import type {
  MTFLiquidityAnalysis,
  LiquidityZone,
  LiquidityPoolType,
  OnChainMetrics,
  MacroSummary,
  RiskConfig,
  TechnicalIndicators,
  OrderBook,
  LLMDecision,
} from "../types";

vi.mock("./keelAdapter", () => ({
  runKeelQuantEngine: vi.fn(),
  // F-01/P0: inline risk gate pada fallback keel — mock default LOLOS agar
  // test routing lama tetap valid; kasus blocked diuji eksplisit di bawah.
  evaluateKeelRisk: vi.fn(() => ({ passed: true, reasons: [] as string[] })),
}));
import * as keelAdapter from "./keelAdapter";

const runKeelMock = vi.mocked(keelAdapter.runKeelQuantEngine);
const riskMock = vi.mocked(keelAdapter.evaluateKeelRisk);

// --- helpers ---

function zone(type: LiquidityPoolType, mid: number, timeframe: "15m" | "4h" = "15m"): LiquidityZone {
  return {
    id: `${type}-${timeframe}-1`,
    timeframe,
    type,
    priceMin: mid * 0.99,
    priceMax: mid * 1.01,
    midPrice: mid,
    estimatedVolumeUSD: 14.5,
    leverageTiers: timeframe === "4h" ? "20x - 50x" : "50x - 100x",
    status: "ACTIVE",
    touches: 1,
    distancePercent: 1,
  };
}

function mtf(over: Partial<MTFLiquidityAnalysis> = {}): MTFLiquidityAnalysis {
  return {
    marketType: "FUTURES",
    primaryTimeframe: "15m",
    macroTimeframe: "4h",
    activeState: "EQUILIBRIUM",
    nearestBSL: null,
    nearestSSL: null,
    recentSweep: null,
    zones15m: [],
    zones4h: [],
    zonesByTimeframe: {},
    confluenceScore: 70,
    confluenceSummary: "",
    huntingTarget: null,
    ...over,
  };
}

function baseTechnicals(): TechnicalIndicators {
  return {
    rsi: 60,
    ema20: 100,
    ema50: 99,
    macd: { macdLine: 1, signalLine: 0.5, histogram: 0.5 },
    orderBookImbalance: 1.2,
    volatility: "MEDIUM",
  };
}

function baseRisk(): RiskConfig {
  return {
    maxRiskPerTradePercent: 2,
    maxPositionPercent: 10,
    maxDrawdownLimit: 25,
    minConfidenceThreshold: 70,
    minRiskRewardRatio: 1.5,
    isEmergencyStopActive: false,
  };
}

function onChain(over: Partial<OnChainMetrics> = {}): OnChainMetrics {
  return {
    symbol: "BTC",
    timestamp: 1,
    exchangeNetflow24hUSD: -142,
    exchangeReserveChangePercent: -1.2,
    netflowStatus: "STRONG_OUTFLOW_ACCUMULATION",
    whaleAlerts: [],
    whaleConcentrationScore: 60,
    whale7dNetAccumulationUSD: 5_000_000,
    mvrvZScore: 1.84,
    mvrvTerritory: "FAIR_VALUE",
    sopr: 1.1,
    soprStatus: "PROFIT_TAKING",
    activeAddresses24h: 1_000_000,
    activeAddressesGrowth24h: 2.5,
    smartMoneyBias: "STRONG_BULLISH",
    onChainConfidence: 80,
    summaryInsight: "",
    ...over,
  };
}

function macro(over: Partial<MacroSummary> = {}): MacroSummary {
  return {
    fedPolicyStance: "DATA_DEPENDENT",
    upcomingHighImpactCount: 1,
    nearestEvent: {
      id: "e1",
      name: "FOMC Press Conference",
      country: "US",
      currency: "USD",
      timestamp: 1,
      timeLabel: "Dalam 2 Jam",
      relativeTime: "T-2h",
      impact: "HIGH",
      category: "CENTRAL_BANK",
      previous: "5.50%",
      forecast: "5.50%",
      actual: null,
      status: "UPCOMING",
      hawkishOrDovish: "TBD",
      implicationNotes: "",
      volatilityRisk: "HIGH_ALERT",
    },
    macroRiskIndex: 60,
    macroTradingAdvice: "",
    events: [],
    lastUpdated: 1,
    ...over,
  };
}

function input(over: Partial<DecisionEngineInput> = {}): DecisionEngineInput {
  return {
    symbol: "BTC/USDT",
    currentPrice: 100,
    candles: [],
    technicals: baseTechnicals(),
    mtfLiquidity: mtf(),
    activePositions: [],
    portfolioEquity: 10000,
    riskConfig: baseRisk(),
    ...over,
  };
}

function realOrderBook(): OrderBook {
  return {
    bids: [
      { price: 99.9, size: 2.5, total: 2.5 },
      { price: 99.8, size: 3.0, total: 5.5 },
    ],
    asks: [
      { price: 100.1, size: 2.2, total: 2.2 },
      { price: 100.2, size: 2.8, total: 5.0 },
    ],
    spread: 0.2,
  };
}

function keelResult(over: Partial<LLMDecision> = {}): ReturnType<typeof keelAdapter.runKeelQuantEngine> {
  return {
    decision: {
      action: "BUY",
      confidence: 82,
      targetPrice: 102,
      stopLoss: 98.5,
      takeProfit: 105,
      // F-01/P0: keel fallback kini melewati evaluateKeelRisk inline.
      // F2: gate size cap-only — size > 5% ditolak, size risk-based < 2%
      // (SL lebar) lolos. Fixture default HARUS ≤ cap agar lolos gate —
      // kasus oversize diuji eksplisit di test "diblokir" di bawah.
      positionSizePercent: 5,
      reasoning: "Keel institutional signal (mock)",
      source: "keel-institutional-quant",
      inferenceLatencyMs: 2,
      liquidityHuntAnalysis: {
        targetPool: "BSL",
        targetZonePrice: 105,
        sweepTriggered: false,
        mtfBias: "BULLISH_REVERSAL",
        confluenceScore: 72,
        invalidationLevel: 98.5,
      },
      ...over,
    },
    rawSignalResult: {} as never,
  };
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- routing tests ---

describe("evaluateTradingDecision — MODE KEEL", () => {
  beforeEach(() => {
    runKeelMock.mockReset();
    riskMock.mockReset();
    riskMock.mockReturnValue({ passed: true, reasons: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aiEnabled=false → runKeelQuantEngine dipanggil local, source=keel-institutional-quant, TANPA /api/ai-decision", async () => {
    runKeelMock.mockReturnValue(keelResult());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input({ aiEnabled: false }));

    expect(runKeelMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.action).toBe("BUY");
    expect(d.source).toBe("keel-institutional-quant");
    expect(d.liquidityHuntAnalysis).toBeDefined();
  });

  it("aiEnabled=false + HOLD fail-closed dari keel (orderBook kosong) → decision HOLD jujur", async () => {
    runKeelMock.mockReturnValue(
      keelResult({
        action: "HOLD",
        confidence: 50,
        positionSizePercent: 0,
        reasoning: "[Keel Engine] HOLD — no real depth: orderBook kosong, skip fail-closed.",
      })
    );

    const d = await evaluateTradingDecision(
      input({
        aiEnabled: false,
        // orderBook/recentTrades/futures — semua kosong → keel fail-closed HOLD
      })
    );

    expect(runKeelMock).toHaveBeenCalledTimes(1);
    expect(d.action).toBe("HOLD");
    expect(d.source).toBe("keel-institutional-quant");
    expect(d.positionSizePercent).toBe(0);
  });

  it("keel menerima input lengkap (symbol, price, technicals, mtf, orderBook, recentTrades, futures)", async () => {
    runKeelMock.mockReturnValue(keelResult());
    const recentTrades = [{ price: 100.5, qty: 0.5, notionalUsd: 50, isBuyerMaker: false, timestamp: 1 }];

    await evaluateTradingDecision(
      input({
        aiEnabled: false,
        orderBook: realOrderBook(),
        recentTrades,
        futures: { success: true, source: "GATE_FUTURES", fundingRate: -0.0002, fundingBps: -0.2 },
      })
    );

    expect(runKeelMock).toHaveBeenCalledTimes(1);
    const keelInput = runKeelMock.mock.calls[0][0];
    expect(keelInput.symbol).toBe("BTC/USDT");
    expect(keelInput.currentPrice).toBe(100);
    expect(keelInput.technicals.rsi).toBe(60);
    expect(keelInput.mtfLiquidity.activeState).toBe("EQUILIBRIUM");
    expect(keelInput.orderBook?.bids.length).toBe(2);
    expect(keelInput.recentTrades).toEqual(recentTrades);
    expect(keelInput.futures?.source).toBe("GATE_FUTURES");
  });

  it("env GEMINI_API_KEY kosong (tidak ada) + aiEnabled undefined → MODE KEEL local", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    runKeelMock.mockReturnValue(keelResult({ action: "HOLD" }));

    const d = await evaluateTradingDecision(input());

    expect(d.source).toBe("keel-institutional-quant");
    expect(runKeelMock).toHaveBeenCalledTimes(1);
  });

  it("F-01/P0: keel fallback dengan size oversize → risk gate block → HOLD confidence 0", async () => {
    runKeelMock.mockReturnValue(keelResult({ action: "BUY", positionSizePercent: 25 }));
    riskMock.mockReturnValue({ passed: false, reasons: ["POSITION_SIZE_OUT_OF_BAND"] });

    const d = await evaluateTradingDecision(input({ aiEnabled: false }));

    expect(runKeelMock).toHaveBeenCalledTimes(1);
    expect(riskMock).toHaveBeenCalledTimes(1);
    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(d.positionSizePercent).toBe(0);
    expect(d.reasoning).toContain("Risk blocked");
  });

  it("F-05: keel fallback SL/TP tidak konsisten arah → HOLD (posisi zombie ditolak)", async () => {
    runKeelMock.mockReturnValue(
      keelResult({ action: "BUY", stopLoss: 105, takeProfit: 110 })
    );

    const d = await evaluateTradingDecision(input({ aiEnabled: false, currentPrice: 100 }));

    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(riskMock).not.toHaveBeenCalled();
  });
});

describe("evaluateTradingDecision — MODE AI", () => {
  beforeEach(() => {
    runKeelMock.mockReset();
    riskMock.mockReset();
    riskMock.mockReturnValue({ passed: true, reasons: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aiEnabled=true + fetch ok → POST /api/ai-decision, source=ai-decision-server, keel TIDAK dipanggil", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        action: "SELL",
        confidence: 74,
        targetPrice: 100,
        stopLoss: 100.8,
        takeProfit: 97.2,
        positionSizePercent: 8,
        reasoning: "AI server decision",
        promptSummary: "symbol=BTC/USDT",
        provenance: {
          market: { source: "REAL", fetchedAt: 1 },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input({ aiEnabled: true }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ai-decision");
    expect(runKeelMock).not.toHaveBeenCalled();
    expect(d.action).toBe("SELL");
    expect(d.source).toBe("ai-decision-server");
  });

  it("aiEnabled=true + fetch gagal → turun MODE KEEL local (bukan mtf-hunter)", async () => {
    runKeelMock.mockReturnValue(keelResult({ action: "BUY" }));
    const fetchMock = vi.fn().mockRejectedValue(new Error("server offline"));
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input({ aiEnabled: true }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runKeelMock).toHaveBeenCalledTimes(1);
    expect(d.source).toBe("keel-institutional-quant");
    expect(d.action).toBe("BUY");
  });

  it("aiEnabled=true + fetch respon tidak-ok → MODE KEEL local", async () => {
    runKeelMock.mockReturnValue(keelResult({ action: "HOLD" }));
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ success: false }, 503));
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input({ aiEnabled: true }));

    expect(runKeelMock).toHaveBeenCalledTimes(1);
    expect(d.source).toBe("keel-institutional-quant");
  });

  it("F-05: MODE AI shape invalid (confidence > 100) → HOLD fail-closed, keel TIDAK dipanggil", async () => {
    // NaN tidak bisa dikirim lewat JSON (diserialisasi jadi null →
    // ter-coerce ke HOLD default yang lolos validasi). Pakai confidence
    // out-of-range sebagai contoh shape invalid yang bertahan di JSON.
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        action: "BUY",
        confidence: 150,
        targetPrice: 100,
        stopLoss: 95,
        takeProfit: 110,
        positionSizePercent: 8,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input({ aiEnabled: true, currentPrice: 100 }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runKeelMock).not.toHaveBeenCalled();
    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(d.reasoning).toContain("shape invalid");
  });

  it("F-05: MODE AI price-order invalid (BUY dengan SL > price) → HOLD fail-closed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        action: "BUY",
        confidence: 90,
        targetPrice: 100,
        stopLoss: 105,
        takeProfit: 110,
        positionSizePercent: 8,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input({ aiEnabled: true, currentPrice: 100 }));

    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(d.reasoning).toContain("tidak valid");
  });

  it("env GEMINI_API_KEY ada (tanpa aiEnabled) → MODE AI", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ action: "BUY", confidence: 90, targetPrice: 100, stopLoss: 97, takeProfit: 104, positionSizePercent: 8 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input());

    expect(d.source).toBe("ai-decision-server");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("provenance dikirim ke /api/ai-decision pada MODE AI", async () => {
    const provenance = {
      market: { source: "REAL" as const, fetchedAt: 1, ageMinutes: 1 },
      liquidity: { source: "REAL" as const, fetchedAt: 1, ageMinutes: 0.5 },
      onChain: { source: "SIMULATED" as const, fetchedAt: 1 },
      macro: { source: "STALE" as const, fetchedAt: 1, ageMinutes: 5 },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ action: "HOLD", confidence: 70, targetPrice: 100, stopLoss: 98, takeProfit: 102, positionSizePercent: 8 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision({ ...input({ aiEnabled: true }), provenance });

    expect(d.source).toBe("ai-decision-server");
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.provenance.market.source).toBe("REAL");
    expect(body.provenance.macro.source).toBe("STALE");
    expect(body.mtfLiquidity.activeState).toBe("EQUILIBRIUM");
  });
});

// --- audit Gemini 3 Pro (2026-09-24) P0-A/P0-C: direct core in-memory ---

describe("evaluateTradingDecision — direct core in-memory (P0-A/P0-C)", () => {
  beforeEach(() => {
    runKeelMock.mockReset();
    riskMock.mockReset();
    riskMock.mockReturnValue({ passed: true, reasons: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetAiDecisionCore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("core terdaftar → dipanggil LANGSUNG in-memory, authFetch/fetch TIDAK dipakai", async () => {
    const core = vi.fn().mockResolvedValue({
      status: 200,
      json: {
        action: "SELL",
        confidence: 74,
        targetPrice: 100,
        stopLoss: 100.8,
        takeProfit: 97.2,
        positionSizePercent: 8,
        reasoning: "core direct decision",
        promptSummary: "jevs=jev-opencode symbol=BTC/USDT",
      },
    });
    setAiDecisionCore(core);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input({ aiEnabled: true }));

    expect(core).toHaveBeenCalledTimes(1);
    // P0-A: dulu authFetch("/api/ai-decision") relative-URL THROW di native
    // fetch Node → error ditelan → selalu keel. Sekarang fetch tidak disentuh.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runKeelMock).not.toHaveBeenCalled();
    expect(d.action).toBe("SELL");
    expect(d.source).toBe("ai-decision-server");
    expect(d.reasoning).toBe("core direct decision");
    // Body yang dulu dikirim via HTTP kini diterima core identik.
    const body = core.mock.calls[0][0];
    expect(body.symbol).toBe("BTC/USDT");
    expect(body.currentPrice).toBe(100);
    expect(body.riskParams.maxRiskPerTradePercent).toBe(2);
    expect(body.mtfLiquidity.activeState).toBe("EQUILIBRIUM");
  });

  it("core status 503 → fallback MODE KEEL, tetap tanpa fetch", async () => {
    setAiDecisionCore(vi.fn().mockResolvedValue({ status: 503, json: { success: false } }));
    runKeelMock.mockReturnValue(keelResult());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const d = await evaluateTradingDecision(input({ aiEnabled: true }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(runKeelMock).toHaveBeenCalledTimes(1);
    expect(d.source).toBe("keel-institutional-quant");
  });

  it("core 200 + shape invalid → HOLD fail-closed, keel TIDAK dipanggil", async () => {
    setAiDecisionCore(
      vi.fn().mockResolvedValue({
        status: 200,
        json: { action: "BUY", confidence: 150, targetPrice: 100, stopLoss: 95, takeProfit: 110, positionSizePercent: 8 },
      })
    );

    const d = await evaluateTradingDecision(input({ aiEnabled: true }));

    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(d.reasoning).toContain("shape invalid");
    expect(runKeelMock).not.toHaveBeenCalled();
  });

  it("core 200 BUY + provenance basi → [PROVENANCE GATE] HOLD di jalur AI", async () => {
    setAiDecisionCore(
      vi.fn().mockResolvedValue({
        status: 200,
        json: { action: "BUY", confidence: 90, targetPrice: 100, stopLoss: 95, takeProfit: 110, positionSizePercent: 8, reasoning: "core buy" },
      })
    );

    const d = await evaluateTradingDecision(
      input({
        aiEnabled: true,
        provenance: { market: { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() - 60_000 } },
      })
    );

    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(d.reasoning).toContain("[PROVENANCE GATE]");
  });
});

// --- audit Gemini 3 Pro P0-B: provenance gate di jantung (termasuk keel) ---

describe("evaluateTradingDecision — provenance entry gate di fallback Keel (P0-B)", () => {
  beforeEach(() => {
    runKeelMock.mockReset();
    riskMock.mockReset();
    riskMock.mockReturnValue({ passed: true, reasons: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetAiDecisionCore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("provenance STALE + keel BUY → HOLD [PROVENANCE GATE], risk gate tidak sempat jalan", async () => {
    runKeelMock.mockReturnValue(keelResult());

    const d = await evaluateTradingDecision(
      input({
        aiEnabled: false,
        provenance: { market: { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() - 60_000 } },
      })
    );

    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(d.positionSizePercent).toBe(0);
    expect(d.reasoning).toContain("[PROVENANCE GATE]");
    expect(d.source).toBe("keel-institutional-quant");
    expect(riskMock).not.toHaveBeenCalled();
  });

  it("provenance SIMULATED + keel BUY → HOLD", async () => {
    runKeelMock.mockReturnValue(keelResult());

    const d = await evaluateTradingDecision(
      input({
        aiEnabled: false,
        provenance: { market: { source: "SIMULATED", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() } },
      })
    );

    expect(d.action).toBe("HOLD");
    expect(d.reasoning).toContain("[PROVENANCE GATE]");
  });

  it("klaim REAL tanpa venue (UNKNOWN) + keel BUY → HOLD", async () => {
    runKeelMock.mockReturnValue(keelResult());

    const d = await evaluateTradingDecision(
      input({
        aiEnabled: false,
        provenance: { market: { source: "REAL", marketType: "FUTURES", exchangeTs: Date.now() } },
      })
    );

    expect(d.action).toBe("HOLD");
    expect(d.reasoning).toContain("[PROVENANCE GATE]");
  });

  it("REAL segar (venue+marketType+exchangeTs) → keel BUY tetap lolos gate", async () => {
    runKeelMock.mockReturnValue(keelResult());

    const d = await evaluateTradingDecision(
      input({
        aiEnabled: false,
        provenance: { market: { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: Date.now() - 50 } },
      })
    );

    expect(d.action).toBe("BUY");
    expect(d.source).toBe("keel-institutional-quant");
    expect(d.reasoning).not.toContain("[PROVENANCE GATE]");
    expect(riskMock).toHaveBeenCalled();
  });

  it("tanpa provenance (MISSING) → tidak diblokir (perilaku lama)", async () => {
    runKeelMock.mockReturnValue(keelResult());

    const d = await evaluateTradingDecision(input({ aiEnabled: false }));

    expect(d.action).toBe("BUY");
    expect(d.reasoning).not.toContain("[PROVENANCE GATE]");
  });
});

// --- Zod validation (decision shape guard) ---

const decisionGuard = z
  .object({
    action: z.enum(["BUY", "SELL", "HOLD"]),
    currentPrice: z.number().finite(),
    stopLoss: z.number().finite(),
    takeProfit: z.number().finite(),
    confidence: z.number().finite().min(0).max(100),
    positionSizePercent: z.number().finite(),
  })
  .refine(
    (d) => {
      if (d.action === "BUY") return d.stopLoss < d.currentPrice && d.currentPrice < d.takeProfit;
      if (d.action === "SELL") return d.takeProfit < d.currentPrice && d.currentPrice < d.stopLoss;
      return true;
    },
    { message: "Order-level tidak konsisten dengan arah" }
  );

const clampPositionSize = z
  .object({ positionSizePercent: z.number().finite() })
  .transform((v) => ({ ...v, positionSizePercent: Math.min(v.positionSizePercent, 10) }));

const maxPositionRefine = z
  .object({ positionSizePercent: z.number().finite(), maxPositionPercent: z.number().finite() })
  .refine((v) => v.positionSizePercent <= v.maxPositionPercent, {
    message: "positionSizePercent melebihi cap",
  });

describe("zod decision validation", () => {
  it("valid: BUY dengan SL < price < TP → parse sukses", () => {
    const ok = decisionGuard.safeParse({
      action: "BUY",
      currentPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      confidence: 82,
      positionSizePercent: 8,
    });
    expect(ok.success).toBe(true);
  });

  it("invalid: BUY dengan SL > price → fail", () => {
    const bad = decisionGuard.safeParse({
      action: "BUY",
      currentPrice: 100,
      stopLoss: 105,
      takeProfit: 110,
      confidence: 82,
      positionSizePercent: 8,
    });
    expect(bad.success).toBe(false);
  });

  it("invalid: NaN / Infinity pada harga → fail (finite check)", () => {
    const nan = decisionGuard.safeParse({
      action: "BUY",
      currentPrice: 100,
      stopLoss: NaN,
      takeProfit: 110,
      confidence: 82,
      positionSizePercent: 8,
    });
    const inf = decisionGuard.safeParse({
      action: "BUY",
      currentPrice: 100,
      stopLoss: 90,
      takeProfit: Infinity,
      confidence: 82,
      positionSizePercent: 8,
    });
    expect(nan.success).toBe(false);
    expect(inf.success).toBe(false);
  });

  it("positionSizePercent > max → clamp ke cap, atau reject lewat refine", () => {
    const clamped = clampPositionSize.safeParse({ positionSizePercent: 25 });
    expect(clamped.success).toBe(true);
    expect(clamped.success && clamped.data.positionSizePercent).toBe(10);

    const rejected = maxPositionRefine.safeParse({ positionSizePercent: 25, maxPositionPercent: 10 });
    expect(rejected.success).toBe(false);
  });
});