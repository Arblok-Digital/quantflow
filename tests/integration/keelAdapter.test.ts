import { describe, it, expect } from "vitest";
import { runKeelQuantEngine, evaluateKeelRisk } from "../../src/logic/keelAdapter";

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
