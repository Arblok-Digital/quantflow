import { describe, it, expect, afterEach, vi } from "vitest";
import {
  evaluateOrderRisk,
  describeOrderRiskRejection,
  defaultOrderRiskPolicy,
  isOrderRiskGateEnabled,
  ORDER_RISK_REASONS,
  type OrderRiskPolicy,
} from "./orderRiskGate";

// Policy default: risk 1%/trade, notional 25% equity, RR ≥ 1.5, lantai SL 0.35%.
const P: OrderRiskPolicy = {
  maxRiskPerTradePercent: 1.0,
  maxNotionalPercent: 25,
  minRiskRewardRatio: 1.5,
  minStopDistancePercent: 0.35,
  takerFeeRate: 0.0004,
};

const base = {
  symbol: "BTC/USDT",
  side: "buy" as const,
  qty: 0.015,
  price: 80_000,
  stopLoss: 79_360, // 0.8%
  takeProfit: 80_960, // 1.2% → RR 1.5
  leverage: 10,
  equity: 10_000,
};

describe("evaluateOrderRisk — gate matematis pre-trade", () => {
  it("order sehat (SL 0.8% / TP 1.2%, notional 12% equity) → lolos", () => {
    const r = evaluateOrderRisk({ ...base, qty: 0.015 }, P); // notional $1200 = 12%
    expect(r.approved).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.metrics?.riskRewardRatio).toBeCloseTo(1.5, 2);
    expect(r.metrics?.stopDistancePercent).toBeCloseTo(0.8, 2);
    expect(r.metrics?.riskPercentOfEquity).toBeCloseTo(0.096, 3);
    expect(r.metrics?.roundTripCostUsd).toBeCloseTo(1200 * 0.0008, 2);
  });

  it("RR 1.0 (kasus nyata di DB: TP dari wall terlalu dekat) → ditolak RR_BELOW_MIN", () => {
    const r = evaluateOrderRisk({ ...base, takeProfit: 80_640 }, P);
    expect(r.approved).toBe(false);
    expect(r.reasons[0]).toContain(ORDER_RISK_REASONS.RR_BELOW_MIN);
  });

  it("SL 0.08% (di dalam noise + di bawah biaya bolak-balik) → ditolak STOP_TOO_TIGHT", () => {
    const r = evaluateOrderRisk({ ...base, stopLoss: 79_936, takeProfit: 81_600 }, P);
    expect(r.approved).toBe(false);
    expect(r.reasons.join(";")).toContain(ORDER_RISK_REASONS.STOP_TOO_TIGHT);
    expect(r.metrics?.stopDistancePercent).toBeCloseTo(0.08, 2);
  });

  it("bracket terbalik (BUY dengan SL di atas harga) → ditolak INVALID_BRACKET", () => {
    const r = evaluateOrderRisk({ ...base, stopLoss: 81_000, takeProfit: 82_000 }, P);
    expect(r.approved).toBe(false);
    expect(r.reasons.join(";")).toContain(ORDER_RISK_REASONS.INVALID_BRACKET);
  });

  it("SELL: bracket arah benar (TP < harga < SL) → lolos; arah salah → ditolak", () => {
    const ok = evaluateOrderRisk(
      { ...base, side: "sell", stopLoss: 80_640, takeProfit: 79_040 },
      P,
    );
    expect(ok.approved).toBe(true);
    const bad = evaluateOrderRisk(
      { ...base, side: "sell", stopLoss: 79_360, takeProfit: 80_960 },
      P,
    );
    expect(bad.approved).toBe(false);
    expect(bad.reasons.join(";")).toContain(ORDER_RISK_REASONS.INVALID_BRACKET);
  });

  it("risiko riil per trade dihitung dari jarak SL × NOTIONAL (bukan % equity client)", () => {
    // notional $8000 (80% equity) × SL 2% = $160 = 1.6% equity > cap 1%
    const r = evaluateOrderRisk(
      { ...base, qty: 0.1, stopLoss: 78_400, takeProfit: 82_400 },
      P,
    );
    expect(r.approved).toBe(false);
    expect(r.reasons.join(";")).toContain(ORDER_RISK_REASONS.NOTIONAL_TOO_LARGE);
    expect(r.reasons.join(";")).toContain(ORDER_RISK_REASONS.RISK_PER_TRADE_EXCEEDED);
    expect(r.metrics?.riskPercentOfEquity).toBeCloseTo(1.6, 2);
  });

  it("equity tidak diketahui → cap dilewati + capsSkipped (tidak diam-diam lolos)", () => {
    const r = evaluateOrderRisk({ ...base, equity: undefined }, P);
    expect(r.approved).toBe(true);
    expect(r.capsSkipped).toBe(true);
    expect(r.metrics?.notionalPercentOfEquity).toBeNull();
  });

  it("requireEquity (jalur live) + equity tak terbaca → ditolak EQUITY_UNAVAILABLE", () => {
    const r = evaluateOrderRisk({ ...base, equity: undefined }, { ...P, requireEquity: true });
    expect(r.approved).toBe(false);
    expect(r.reasons.join(";")).toContain(ORDER_RISK_REASONS.EQUITY_UNAVAILABLE);
  });

  it("input tidak valid (harga/qty/SL/TP) → ditolak INVALID_INPUT tanpa metrics", () => {
    for (const bad of [
      { ...base, price: 0 },
      { ...base, qty: 0 },
      { ...base, stopLoss: Number.NaN },
      { ...base, takeProfit: -1 },
    ]) {
      const r = evaluateOrderRisk(bad, P);
      expect(r.approved).toBe(false);
      expect(r.reasons).toEqual([ORDER_RISK_REASONS.INVALID_INPUT]);
      expect(r.metrics).toBeNull();
    }
  });

  it("pesan penolakan memuat angka aktual (untuk toast/log)", () => {
    const r = evaluateOrderRisk({ ...base, takeProfit: 80_640 }, P);
    const msg = describeOrderRiskRejection(r);
    expect(msg).toContain("RR_BELOW_MIN");
    expect(msg).toContain("R:R 1");
    expect(msg).toContain("notional $");
  });
});

describe("orderRiskGate policy & toggle", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("default policy: risk 1%, notional 25%, RR 1.5, lantai SL 0.35%", () => {
    const p = defaultOrderRiskPolicy();
    expect(p.maxRiskPerTradePercent).toBe(1.0);
    expect(p.maxNotionalPercent).toBe(25);
    expect(p.minRiskRewardRatio).toBe(1.5);
    expect(p.minStopDistancePercent).toBe(0.35);
    expect(p.takerFeeRate).toBeCloseTo(0.0004, 6);
  });

  it("env override diterapkan", () => {
    vi.stubEnv("RISK_MIN_RR", "2.5");
    vi.stubEnv("RISK_MIN_STOP_PCT", "0.6");
    const p = defaultOrderRiskPolicy();
    expect(p.minRiskRewardRatio).toBe(2.5);
    expect(p.minStopDistancePercent).toBe(0.6);
  });

  it("toggle: default ON, hanya false/0/off/no yang mematikan", () => {
    expect(isOrderRiskGateEnabled()).toBe(true);
    vi.stubEnv("RISK_GATE_ENABLED", "off");
    expect(isOrderRiskGateEnabled()).toBe(false);
    vi.stubEnv("RISK_GATE_ENABLED", "0");
    expect(isOrderRiskGateEnabled()).toBe(false);
    vi.stubEnv("RISK_GATE_ENABLED", "true");
    expect(isOrderRiskGateEnabled()).toBe(true);
  });
});