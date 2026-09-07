import { describe, it, expect } from "vitest";
import { evaluateRiskGate } from "./riskGatekeeper";
import type { LLMDecision, RiskConfig, Portfolio } from "../types";

function mockConfig(over: Partial<RiskConfig> = {}): RiskConfig {
  return {
    maxRiskPerTradePercent: 2,
    maxPositionPercent: 10,
    maxDrawdownLimit: 25,
    minConfidenceThreshold: 70,
    minRiskRewardRatio: 1.5,
    isEmergencyStopActive: false,
    ...over,
  };
}

function mockPortfolio(over: Partial<Portfolio> = {}): Portfolio {
  return {
    cash: 10000,
    equity: 10000,
    initialBalance: 10000,
    realizedPnl: 0,
    winCount: 0,
    lossCount: 0,
    totalTrades: 0,
    maxDrawdownPercent: 0,
    currentDrawdownPercent: 0,
    ...over,
  };
}

function mockDecision(over: Partial<LLMDecision> = {}): LLMDecision {
  return {
    action: "BUY",
    confidence: 85,
    targetPrice: 100,
    stopLoss: 97,
    takeProfit: 106,
    positionSizePercent: 8,
    reasoning: "test decision",
    inferenceLatencyMs: 0,
    ...over,
  };
}

describe("evaluateRiskGate", () => {
  it("menolak ketika emergency stop aktif (kill-switch operator)", () => {
    const result = evaluateRiskGate(mockDecision(), mockConfig({ isEmergencyStopActive: true }), mockPortfolio(), 100);
    expect(result.approved).toBe(false);
    expect(result.maxDrawdownPassed).toBe(false);
    expect(result.positionSizePassed).toBe(false);
    expect(result.notes).toContain("Kill-Switch");
  });

  it("menolak ketika currentDrawdownPercent >= maxDrawdownLimit", () => {
    const result = evaluateRiskGate(mockDecision(), mockConfig(), mockPortfolio({ currentDrawdownPercent: 30 }), 100);
    expect(result.approved).toBe(false);
    expect(result.maxDrawdownPassed).toBe(false);
    expect(result.notes).toContain("Max Drawdown");
  });

  it("HOLD disetujui tanpa alokasi modal baru", () => {
    const result = evaluateRiskGate(
      mockDecision({ action: "HOLD", positionSizePercent: 999, confidence: 0 }),
      mockConfig(),
      mockPortfolio(),
      100
    );
    expect(result.approved).toBe(true);
    expect(result.maxDrawdownPassed).toBe(true);
    expect(result.notes).toContain("HOLD");
  });

  it("menolak ketika positionSizePercent > maxPositionPercent", () => {
    const result = evaluateRiskGate(
      mockDecision({ positionSizePercent: 15 }),
      mockConfig({ maxPositionPercent: 10 }),
      mockPortfolio(),
      100
    );
    expect(result.approved).toBe(false);
    expect(result.positionSizePassed).toBe(false);
    expect(result.notes).toContain("melampaui batas toleransi");
  });

  it("menolak ketika risiko SL x size melampaui maxRiskPerTradePercent (F6)", () => {
    const result = evaluateRiskGate(
      mockDecision({ stopLoss: 90 }),
      mockConfig({ maxRiskPerTradePercent: 0.5 }),
      mockPortfolio(),
      100
    );
    expect(result.approved).toBe(false);
    expect(result.notes).toContain("Risiko per trade");
  });

  it("menolak ketika rasio Risk:Reward di bawah minRiskRewardRatio", () => {
    const result = evaluateRiskGate(mockDecision({ stopLoss: 99.5, takeProfit: 100.5 }), mockConfig(), mockPortfolio(), 100);
    expect(result.approved).toBe(false);
    expect(result.riskRewardRatio).toBe(1);
    expect(result.notes).toContain("Risk:Reward");
  });

  it("menolak ketika confidence < minConfidenceThreshold", () => {
    const result = evaluateRiskGate(mockDecision({ confidence: 55 }), mockConfig(), mockPortfolio(), 100);
    expect(result.approved).toBe(false);
    expect(result.notes).toContain("Confidence");
  });

  it("menyetujui ketika seluruh aturan lolos dan mencatat rasio RR", () => {
    const result = evaluateRiskGate(mockDecision(), mockConfig(), mockPortfolio(), 100);
    expect(result.approved).toBe(true);
    expect(result.maxDrawdownPassed).toBe(true);
    expect(result.positionSizePassed).toBe(true);
    expect(result.riskRewardRatio).toBe(2);
    expect(result.notes).toContain("Lolos seluruh aturan");
  });

  it("fail-closed: saat currentPrice 0, stopDist dianggap 100% sehingga reject", () => {
    const result = evaluateRiskGate(mockDecision(), mockConfig(), mockPortfolio(), 0);
    expect(result.approved).toBe(false);
  });
});