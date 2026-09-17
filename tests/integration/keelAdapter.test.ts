import { describe, it, expect } from "vitest";
import { runKeelQuantEngine, evaluateKeelRisk, computeRealMtfBias } from "../../src/logic/keelAdapter";
import { evaluateRisk } from "../../src/logic/keel/risk/gatekeeper";
import type { TechnicalIndicators, MTFLiquidityAnalysis, OrderBook, Candle } from "../../src/types";
import type { RecentTrade } from "../../src/data/marketFetcher";

describe("Keel Engine Adapter Integration", () => {
  it("should generate a valid quant decision using Keel signal generator", () => {
    const result = runKeelQuantEngine({
      symbol: "BTC/USDT",
      currentPrice: 65000,
    });

    expect(result).toBeDefined();
    expect(result.decision).toBeDefined();
    expect(result.decision.action).toMatch(/BUY|SELL|HOLD/);
    expect(result.decision.confidence).toBeGreaterThanOrEqual(0);
    expect(result.decision.confidence).toBeLessThanOrEqual(100);
    expect(result.decision.source).toBe("keel-institutional-quant");
    expect(result.rawSignalResult).toBeDefined();
  });

  it("should evaluate Keel risk limits correctly", () => {
    const riskEval = evaluateKeelRisk(
      {
        venue: "BINANCE_SPOT",
        action: "BUY",
        sizePct: 3.0,
        stopLossPct: -2.0,
      },
      10000
    );

    expect(riskEval).toBeDefined();
    expect(typeof riskEval.passed).toBe("boolean");
    expect(Array.isArray(riskEval.reasons)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F2 — sizing satu satuan: % equity sebagai NOTIONAL. Sizing Keel kini
// risk-targeted (risiko riil = jarak SL × notional ≤ target), gate size
// cap-only, dan adapter MENERUSKAN output sizing engine (tidak hardcode).
// ---------------------------------------------------------------------------
const bullishTechnicals = {
  rsi: 25,
  ema20: 101,
  ema50: 100,
  macd: { histogram: 1 },
  orderBookImbalance: 1.5,
} as unknown as TechnicalIndicators;
const huntingBsl = { activeState: "HUNTING_BSL" } as unknown as MTFLiquidityAnalysis;
const depthBook: OrderBook = {
  bids: [
    { price: 64970, size: 0.01, total: 0.01 }, // best bid — spread tipis (band liq 50 bps)
    { price: 64350, size: 5, total: 5 }, // wall bid 1% di bawah entry → SL struktur 1%
    { price: 63000, size: 50, total: 50 },
  ],
  asks: [
    { price: 65000, size: 0.01, total: 0.01 },
    { price: 70000, size: 50, total: 50 }, // wall ask 7.7% → TP wall (R:R 7.7 ≥ 1.5)
  ],
  spread: 30,
};
const accumulationTrades: RecentTrade[] = [
  ...Array.from({ length: 6 }, (_, i) => ({
    price: 65000,
    qty: 0.5,
    notionalUsd: 32_500,
    isBuyerMaker: false,
    timestamp: Date.now() - (i + 1) * 1_000,
  })),
  { price: 64999, qty: 0.08, notionalUsd: 5_200, isBuyerMaker: true, timestamp: Date.now() - 7_000 },
  { price: 64998, qty: 0.07, notionalUsd: 4_550, isBuyerMaker: true, timestamp: Date.now() - 8_000 },
];

describe("F2 — sizing satu satuan (adapter + gate Keel)", () => {

  it("adapter MENERUSKAN sizePct engine (risk-targeted), bukan hardcode 5", () => {
    const result = runKeelQuantEngine({
      symbol: "BTC/USDT",
      currentPrice: 65000,
      technicals: bullishTechnicals,
      mtfLiquidity: huntingBsl,
      orderBook: depthBook,
      recentTrades: accumulationTrades,
    });
    expect(result.decision.action).toBe("BUY");
    const levels = result.rawSignalResult.levels;
    expect(levels).not.toBeNull();
    expect(result.decision.positionSizePercent).toBe(levels!.sizePct);
    // Invarian di level adapter: risiko riil = size% × jarak SL% ≤ target 0.5%
    const stopPct = (Math.abs(result.decision.stopLoss - 65000) / 65000) * 100;
    expect((result.decision.positionSizePercent * stopPct) / 100).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("gate size CAP-ONLY: size risk-based 0.8% (SL lebar 12%) lolos — bukan OUT_OF_BAND", () => {
    const riskEval = evaluateKeelRisk(
      { venue: "BINANCE_SPOT", action: "BUY", sizePct: 0.8, stopLossPct: -12 },
      10000
    );
    expect(riskEval.passed).toBe(true);
    expect(riskEval.reasons).not.toContain("POSITION_SIZE_OUT_OF_BAND");
  });

  it("gate size: cap tetap menolak oversize (6% > cap 5%)", () => {
    const riskEval = evaluateKeelRisk(
      { venue: "BINANCE_SPOT", action: "BUY", sizePct: 6, stopLossPct: -2 },
      10000
    );
    expect(riskEval.passed).toBe(false);
    expect(riskEval.reasons).toContain("POSITION_SIZE_OUT_OF_BAND");
  });
});

// ---------------------------------------------------------------------------
// F4 — MTF real 4-TF (MTFEngine dari candle OHLCV) + gate keel dua arah.
// ---------------------------------------------------------------------------
describe("F4 — MTF real 4-TF + gate dua arah", () => {
  const T0 = 1_700_000_000_000;
  function mkSeries(n: number, start: number, drift: number, tfMs: number): Candle[] {
    return Array.from({ length: n }, (_, i) => {
      const o = start + drift * i;
      const c = start + drift * (i + 1);
      return {
        timestamp: T0 + i * tfMs,
        open: o,
        high: Math.max(o, c) * 1.001,
        low: Math.min(o, c) * 0.999,
        close: c,
        volume: 10,
      };
    });
  }

  it("computeRealMtfBias: 15m uptrend → BULLISH (m15+h1), 4h downtrend → BEARISH (h4+d1)", () => {
    // Drift cukup curam supaya EMA9 vs EMA21 melewati threshold 0.1% (regime).
    const up15 = mkSeries(120, 64_000, 20, 900_000);          // h1 = 30 bar
    const down4h = mkSeries(132, 67_000, -20, 4 * 3_600_000); // d1 = 22 bar
    const res = computeRealMtfBias(up15, down4h)!;
    expect(res.bias.m15).toBe("BULLISH");
    expect(res.bias.h1).toBe("BULLISH");
    expect(res.bias.h4).toBe("BEARISH");
    expect(res.bias.d1).toBe("BEARISH");
    expect(res.coveredTfs).toEqual(["m15", "h1", "h4", "d1"]);
  });

  it("data tipis → null (fallback legacy, bukan bias palsu)", () => {
    expect(computeRealMtfBias(mkSeries(5, 100, 0.1, 900_000), undefined)).toBeNull();
    expect(computeRealMtfBias(undefined, undefined)).toBeNull();
  });

  it("runKeelQuantEngine + candle → reasoning MTF REAL, tanpa penalti duplikasi", () => {
    const result = runKeelQuantEngine({
      symbol: "BTC/USDT",
      currentPrice: 65000,
      technicals: bullishTechnicals,
      mtfLiquidity: huntingBsl,
      orderBook: depthBook,
      recentTrades: accumulationTrades,
      // Kedua TF uptrend → confluence 4-TF aligned → BUY (bukan kontradiksi
      // yang disengaja: itu memang harus ditolak schema).
      candles15m: mkSeries(120, 64_000, 20, 900_000),
      candles4h: mkSeries(132, 67_000, 20, 4 * 3_600_000),
    });
    expect(result.decision.action).toBe("BUY");
    expect(result.decision.reasoning).toContain("MTF REAL 4-TF");
    expect(result.decision.reasoning).not.toContain("MTF-DUP-PENALTY");
  });

  it("gate dua arah: SELL kena MAX_OPEN_POSITIONS + ORDER_RATE_LIMIT + SIZE (sebelumnya lolos semua)", () => {
    const limits = {
      maxOpenPositions: 2,
      maxOrdersPerHour: 1,
      maxDrawdownPct: 3,
      minPositionSizePct: 2,
      maxPositionSizePct: 5,
      stopLossPct: 2,
    };
    const snap = { openPositions: 3, ordersLastHour: 2, dailyDrawdownPct: 0, killSwitchActive: false };
    const sell = evaluateRisk({ venue: "BINANCE_SPOT", action: "SELL", sizePct: 6, stopLossPct: -2 }, snap, limits);
    expect(sell.passed).toBe(false);
    expect(sell.reasons).toContain("MAX_OPEN_POSITIONS");
    expect(sell.reasons).toContain("ORDER_RATE_LIMIT");
    expect(sell.reasons).toContain("POSITION_SIZE_OUT_OF_BAND");
    // Parity: BUY dengan kondisi identik juga kena (tidak ada yang dilonggarkan)
    const buy = evaluateRisk({ venue: "BINANCE_SPOT", action: "BUY", sizePct: 6, stopLossPct: -2 }, snap, limits);
    expect(buy.passed).toBe(false);
    expect(buy.reasons).toEqual(sell.reasons);
  });
});
