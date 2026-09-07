import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { evaluateTradingDecision } from "./decisionEngine";
import type { DecisionEngineInput } from "./decisionEngine";
import type {
  MTFLiquidityAnalysis,
  LiquidityZone,
  LiquidityPoolType,
  OnChainMetrics,
  MacroSummary,
  RiskConfig,
  TechnicalIndicators,
} from "../types";

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

const sslSweepInput = (over: Partial<DecisionEngineInput> = {}) =>
  input({
    currentPrice: 100.5,
    mtfLiquidity: mtf({
      activeState: "SWEPT_SSL",
      confluenceScore: 88,
      recentSweep: {
        zone: zone("SSL", 99.88),
        timestamp: 1,
        wickRejectionPercent: 57.1,
        type: "BULLISH_SSL_SWEEP",
        invalidationPrice: 99.3,
      },
      nearestBSL: zone("BSL", 103.13),
      huntingTarget: { targetType: "BSL", targetPrice: 103.13, potentialPnlPercent: 2.6 },
    }),
    ...over,
  });

describe("evaluateTradingDecision fallback", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("server offline")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("SWEPT_SSL + recentSweep → BUY, SL = invalidation, confidence + bonus whale", async () => {
    const d = await evaluateTradingDecision(
      sslSweepInput({ onChainMetrics: onChain({ smartMoneyBias: "STRONG_BULLISH", exchangeNetflow24hUSD: -500 }) })
    );
    expect(d.action).toBe("BUY");
    expect(d.stopLoss).toBe(99.3);
    expect(d.takeProfit).toBeCloseTo(103.13, 2);
    expect(d.confidence).toBeCloseTo(78 + 88 / 10 + 6, 5);
    expect(d.source).toBe("algorithmic-mtf-hunter");
  });

  it("tanpa konfirmasi whale (bias netral, inflow) → confidence 78 + confluence/10", async () => {
    const d = await evaluateTradingDecision(
      sslSweepInput({
        onChainMetrics: onChain({ smartMoneyBias: "NEUTRAL", exchangeNetflow24hUSD: 5 }),
      })
    );
    expect(d.confidence).toBeCloseTo(86.8, 5);
  });

  it("SWEPT_BSL + recentSweep → SELL, SL = invalidation, target SSL", async () => {
    const d = await evaluateTradingDecision(
      input({
        currentPrice: 101,
        mtfLiquidity: mtf({
          activeState: "SWEPT_BSL",
          confluenceScore: 85,
          recentSweep: {
            zone: zone("BSL", 102.43),
            timestamp: 1,
            wickRejectionPercent: 37.5,
            type: "BEARISH_BSL_SWEEP",
            invalidationPrice: 103.6,
          },
          nearestSSL: zone("SSL", 99.28),
          huntingTarget: { targetType: "SSL", targetPrice: 99.28, potentialPnlPercent: 1.7 },
        }),
      })
    );
    expect(d.action).toBe("SELL");
    expect(d.stopLoss).toBe(103.6);
    expect(d.takeProfit).toBeCloseTo(99.28, 2);
    expect(d.confidence).toBeCloseTo(86.5, 5);
  });

  it("HUNTING_BSL + rsi<65 + imbalance>1.05 → BUY confidence 76", async () => {
    const d = await evaluateTradingDecision(
      input({
        currentPrice: 101.6,
        technicals: { ...baseTechnicals(), rsi: 55, orderBookImbalance: 1.2 },
        mtfLiquidity: mtf({
          activeState: "HUNTING_BSL",
          confluenceScore: 78,
          nearestBSL: zone("BSL", 102.13),
          huntingTarget: { targetType: "BSL", targetPrice: 102.13, potentialPnlPercent: 0.52 },
        }),
      })
    );
    expect(d.action).toBe("BUY");
    expect(d.confidence).toBe(76);
  });

  it("HUNTING_BSL tapi rsi >= 65 → turun ke HOLD equilibrium", async () => {
    const d = await evaluateTradingDecision(
      input({
        currentPrice: 101.6,
        technicals: { ...baseTechnicals(), rsi: 70, orderBookImbalance: 1.2 },
        mtfLiquidity: mtf({
          activeState: "HUNTING_BSL",
          confluenceScore: 78,
          nearestBSL: zone("BSL", 102.13),
          huntingTarget: { targetType: "BSL", targetPrice: 102.13, potentialPnlPercent: 0.52 },
        }),
      })
    );
    expect(d.action).toBe("HOLD");
  });

  it("EQUILIBRIUM → HOLD confidence 68, tanpa target hunting", async () => {
    const d = await evaluateTradingDecision(input({ mtfLiquidity: mtf() }));
    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(68);
    expect(d.positionSizePercent).toBe(5);
  });

  it("fail-closed: tanpa macro → fedStance DATA_DEPENDENT & 'No macro data'", async () => {
    const d = await evaluateTradingDecision(sslSweepInput());
    expect(d.macroContext?.fedStance).toBe("DATA_DEPENDENT");
    expect(d.macroContext?.nearestEventName).toBe("No macro data (fail-closed)");
  });

  it("macro real diteruskan, dan macroRiskIndex tinggi mengecilkan size", async () => {
    const d = await evaluateTradingDecision(
      input({
        currentPrice: 100.5,
        mtfLiquidity: mtf({
          activeState: "SWEPT_SSL",
          confluenceScore: 88,
          recentSweep: {
            zone: zone("SSL", 99.88),
            timestamp: 1,
            wickRejectionPercent: 57.1,
            type: "BULLISH_SSL_SWEEP",
            invalidationPrice: 99.3,
          },
          nearestBSL: zone("BSL", 103.13),
          huntingTarget: { targetType: "BSL", targetPrice: 103.13, potentialPnlPercent: 2.6 },
        }),
        macroCalendar: macro({
          fedPolicyStance: "HAWKISH_PAUSE",
          macroRiskIndex: 80,
          nearestEvent: {
            ...macro().nearestEvent!,
            name: "CPI Release",
            volatilityRisk: "HIGH_ALERT",
          },
        }),
      })
    );
    expect(d.action).toBe("BUY");
    expect(d.positionSizePercent).toBe(5);
    expect(d.macroContext?.fedStance).toBe("HAWKISH_PAUSE");
    expect(d.macroContext?.nearestEventName).toBe("CPI Release");
  });

  it("provenance passthrough tidak merusak output & ikut dikirim ke server", async () => {
    const provenance = {
      market: { source: "REAL" as const, fetchedAt: 1, ageMinutes: 1 },
      liquidity: { source: "REAL" as const, fetchedAt: 1, ageMinutes: 0.5 },
      onChain: { source: "SIMULATED" as const, fetchedAt: 1 },
      macro: { source: "STALE" as const, fetchedAt: 1, ageMinutes: 5 },
    };
    const d = await evaluateTradingDecision({ ...sslSweepInput(), provenance });
    expect(d.provenance).toBeUndefined();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/ai-decision");
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.provenance.market.source).toBe("REAL");
    expect(body.provenance.macro.source).toBe("STALE");
    expect(body.mtfLiquidity.activeState).toBe("SWEPT_SSL");
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