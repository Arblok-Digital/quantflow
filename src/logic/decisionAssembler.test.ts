import { describe, it, expect } from "vitest";
import { assembleDecision, type JevDecision, type AssembleContext } from "./decisionAssembler";

const PRICE = 100;
const baseCtx: AssembleContext = {
  currentPrice: PRICE,
  keelSummary: {
    mtfState: {
      nearestBSL: { midPrice: 104 },
      nearestSSL: { midPrice: 97 },
    },
  },
  riskConfig: { maxRiskPerTradePercent: 8, minConfidenceThreshold: 50 },
};

describe("assembleDecision", () => {
  it("LONG → BUY dengan SL=SSL, TP=BSL (guard SL<price<TP)", () => {
    const d = assembleDecision({ action: "LONG", confidence: 70, riskLevel: "MEDIUM" }, baseCtx);
    expect(d.action).toBe("BUY");
    expect(d.stopLoss).toBe(97);
    expect(d.takeProfit).toBe(104);
    expect(d.targetPrice).toBe(104);
    expect(d.stopLoss < PRICE && PRICE < d.takeProfit).toBe(true);
  });

  it("SELL → SHORT cermin: SL=BSL, TP=SSL", () => {
    const d = assembleDecision({ action: "SELL", confidence: 70, riskLevel: "MEDIUM" }, baseCtx);
    expect(d.action).toBe("SELL");
    expect(d.stopLoss).toBe(104);
    expect(d.takeProfit).toBe(97);
    expect(d.targetPrice).toBe(104); // target = sisi risiko (stop)
    expect(d.takeProfit < PRICE && PRICE < d.stopLoss).toBe(true);
  });

  it("ATR fallback ketika BSL/SSL kosong", () => {
    const d = assembleDecision(
      { action: "BUY", confidence: 66, riskLevel: "MEDIUM" },
      { ...baseCtx, keelSummary: null, technicals: { atr: 2 } }
    );
    expect(d.action).toBe("BUY");
    expect(d.stopLoss).toBeCloseTo(100 - 2 * 1.2, 6);
    expect(d.takeProfit).toBeCloseTo(100 + 2 * 2.4, 6);
  });

  it("guard harga: SSL di atas harga tidak dipakai → band-default SL<price<TP", () => {
    const ctx: AssembleContext = {
      currentPrice: 100,
      keelSummary: { mtfState: { nearestBSL: { midPrice: 99 }, nearestSSL: { midPrice: 200 } } },
      riskConfig: { maxRiskPerTradePercent: 8, minConfidenceThreshold: 50 },
    };
    const d = assembleDecision({ action: "BUY", confidence: 70, riskLevel: "HIGH" }, ctx);
    expect(d.action).toBe("BUY");
    expect(d.stopLoss).toBeLessThan(PRICE);
    expect(d.takeProfit).toBeGreaterThan(PRICE);
    expect(d.stopLoss < PRICE && PRICE < d.takeProfit).toBe(true);
  });

  it("HOLD → level netral (target=currentPrice), size 0", () => {
    const d = assembleDecision({ action: "HOLD", confidence: 30, riskLevel: "LOW" }, baseCtx);
    expect(d.action).toBe("HOLD");
    expect(d.targetPrice).toBe(PRICE);
    expect(d.positionSizePercent).toBe(0);
    expect(d.stopLoss).toBeGreaterThan(0);
    expect(d.takeProfit).toBeGreaterThan(0);
    expect(Number.isFinite(d.confidence)).toBe(true);
  });

  it("clamp sizing ke maxRiskPerTradePercent", () => {
    const d = assembleDecision({ action: "BUY", confidence: 95, riskLevel: "HIGH" }, { ...baseCtx, riskConfig: { maxRiskPerTradePercent: 8, minConfidenceThreshold: 50 } });
    expect(d.action).toBe("BUY");
    expect(d.positionSizePercent).toBeLessThanOrEqual(8);
    expect(d.positionSizePercent).toBeGreaterThanOrEqual(1);
    // confidence 95 → round(95/10)=10 → clamp 8
    expect(d.positionSizePercent).toBe(8);
  });

  it("confidence < ambang → HOLD (risk gate fail-closed)", () => {
    const d = assembleDecision({ action: "BUY", confidence: 40, riskLevel: "HIGH" }, baseCtx);
    expect(d.action).toBe("HOLD");
    expect(d.positionSizePercent).toBe(0);
    expect(d.confidence).toBe(0);
    expect(d.reasoning).toContain("risk gate");
  });

  it("deterministik untuk input sama", () => {
    const a = assembleDecision({ action: "BUY", confidence: 72, riskLevel: "MEDIUM" }, baseCtx);
    const b = assembleDecision({ action: "BUY", confidence: 72, riskLevel: "MEDIUM" }, baseCtx);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("semua angka finite & positif untuk arah direksional", () => {
    for (const j of [
      { action: "LONG", confidence: 60, riskLevel: "LOW" } as JevDecision,
      { action: "SHORT", confidence: 88, riskLevel: "HIGH" } as JevDecision,
    ]) {
      const d = assembleDecision(j, baseCtx);
      for (const v of [d.targetPrice, d.stopLoss, d.takeProfit]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  // FIX-C (audit 2026-09-21): harga invalid → HOLD jujur tanpa band karangan
  // (dulu: price=100 → level fiktif di sekitar 100).
  it("currentPrice invalid (NaN) → HOLD dengan level 0 (tanpa fabrikasi harga)", () => {
    const d = assembleDecision(
      { action: "BUY", confidence: 70, riskLevel: "MEDIUM" },
      { ...baseCtx, currentPrice: Number.NaN }
    );
    expect(d.action).toBe("HOLD");
    expect(d.confidence).toBe(0);
    expect(d.positionSizePercent).toBe(0);
    expect(d.stopLoss).toBe(0);
    expect(d.takeProfit).toBe(0);
    expect(d.targetPrice).toBe(0);
    expect(d.reasoning).toContain("currentPrice invalid");
  });
});