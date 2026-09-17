import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const sdk = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class { models = { generateContent: sdk.generateContent }; },
}));
vi.mock("@/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("@/db", () => ({ appendAudit: vi.fn(), saveAgentDecisionDb: vi.fn(), listReplayRunsDb: () => [] }));
vi.mock("@/paperBook", () => ({ getPaperAccount: () => ({ equity: 10000, cash: 10000, marginLocked: 0, unrealizedPnl: 0 }) }));
vi.mock("@/src/logic/keelAdapter", () => ({
  runKeelQuantEngine: () => ({ decision: { action: "HOLD", confidence: 0, reasoning: "No data" }, rawSignalResult: null }),
  evaluateKeelRisk: vi.fn(),
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
import { generateOnChainMetrics, generateRealAnchoredOnChainMetrics } from "../../src/logic/onchain";

const app = express();
app.use(express.json());
registerAiRoutes(app);
beforeAll(() => {
  vi.stubEnv("GEMINI_API_KEY", "audit-sdk-mock-only");
  sdk.generateContent.mockResolvedValue({ text: JSON.stringify({
    action: "HOLD", confidence: 1, targetPrice: 100, stopLoss: 98,
    takeProfit: 104, positionSizePercent: 1, reasoning: "No verified data",
  }) });
});
afterAll(() => vi.unstubAllEnvs());

// HTTP -> real route/prompt formatting -> intercepted SDK. No model, exchange,
// auth store or database network/IO. This is prompt-contract integration, not live AI.
describe("AI decision prompt data honesty", () => {
  it("omits invented defaults and excludes synthetic + real-anchored analytics", async () => {
    const snapshot = {
      source: "audit-anchor", fetchedAt: Date.now(), blockHeight: 900000, priceUSD: 100,
      priceChange24hPct: 1, priceChange7dPct: 2, txCount24h: 300000, mempoolSizeMB: 12,
      mempoolFeesSatVByte: { economy: 1, regular: 2, priority: 3 }, hashrateEH: 800,
      supplyBTC: 19000000, marketCapUSD: 1900000000,
    };
    const cases = [undefined, generateOnChainMetrics("BTC/USDT", 100),
      generateRealAnchoredOnChainMetrics("BTC/USDT", 100, snapshot)];
    for (const onChainMetrics of cases) {
      sdk.generateContent.mockClear();
      const response = await request(app).post("/api/ai-decision").send({
        symbol: "BTC/USDT", currentPrice: 100, technicals: {}, mtfLiquidity: {},
        onChainMetrics, provenance: { onChain: { source: "REAL", fetchedAt: Date.now() } },
      });
      expect(response.status).toBe(200);
      expect(sdk.generateContent).toHaveBeenCalledTimes(1);
      const prompt: string = sdk.generateContent.mock.calls[0][0].contents;
      expect(prompt).toContain("Confluence Score: No data");
      expect(prompt).toContain("RSI (14): No data");
      expect(prompt).toContain("EMA (20): No data | EMA (50): No data");
      expect(prompt).toContain("Order Book Imbalance: No data");
      expect(prompt).not.toMatch(/14M|18M|Confluence Score: 75|RSI \(14\): 50|Imbalance: 1\.0/);
      expect(prompt).not.toContain("diukur dari orderbook real");
      expect(prompt).toContain("On-chain directional weight must be ZERO");
      expect(prompt).not.toContain("Binance Hot Wallet #4");
      expect(prompt).not.toContain("Institutional Custody (0x9a...2f)");
      expect(prompt).not.toMatch(/Netflow Bursa 24 Jam: [+-]?\$|MVRV Z-Score: \d|SOPR: \d/);

      // Capture the advisor prompt too. Return invalid advisor JSON to exercise
      // the deterministic fallback as well as checking the SDK input.
      sdk.generateContent.mockClear();
      const advisor = await request(app).post("/api/ai-advisor").send({
        symbol: "BTC/USDT", currentPrice: 100, technicals: {}, mtfLiquidity: {}, onChainMetrics,
      });
      expect(advisor.status).toBe(200);
      expect(sdk.generateContent).toHaveBeenCalledTimes(1);
      const advisorPrompt: string = sdk.generateContent.mock.calls[0][0].contents;
      expect(advisorPrompt).toContain("On-chain directional weight must be ZERO");
      expect(advisorPrompt).not.toContain("Binance Hot Wallet #4");
      expect(advisorPrompt).not.toMatch(/Netflow: -?\d|MVRV Z-score: \d|SOPR: \d/);
      expect(advisor.body.onChainEcho).toBeNull();
      expect(advisor.body.dataHealth.find((h: { source: string }) => h.source === "onchain").ok).toBe(false);
      expect(advisor.body.ai.insight).toContain("analitik belum terverifikasi");
    }
  });
});
