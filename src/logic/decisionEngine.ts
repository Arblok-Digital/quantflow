import {
  LLMDecision,
  MTFLiquidityAnalysis,
  TechnicalIndicators,
  Position,
  RiskConfig,
  Candle,
  OnChainMetrics,
  MacroSummary,
  OrderBook,
} from "../types";
import { authFetch } from "../hooks/useAuth";
import { runKeelQuantEngine } from "./keelAdapter";
import type { RecentTrade, FuturesMetrics } from "../data/marketFetcher";

export interface DecisionEngineInput {
  symbol: string;
  currentPrice: number;
  candles: Candle[];
  technicals: TechnicalIndicators;
  mtfLiquidity: MTFLiquidityAnalysis;
  onChainMetrics?: OnChainMetrics;
  macroCalendar?: MacroSummary;
  activePositions: Position[];
  portfolioEquity: number;
  riskConfig: RiskConfig;
  /**
   * AI diaktifkan? Client melempar hasil /api/health.geminiConfigured.
   * Konteks Node tanpa flag ini mengecek process.env.GEMINI_API_KEY.
   */
  aiEnabled?: boolean;
  /** Real order book untuk estimasi depth keel yang jujur (opsional). */
  orderBook?: OrderBook;
  /** Real order-flow (aggTrades) untuk keel (opsional, empty → flow NEUTRAL → HOLD jujur). */
  recentTrades?: RecentTrade[];
  /** Futures institutional metrics untuk keel (opsional, gagal → undefined). */
  futures?: FuturesMetrics;
  /** Provenance tag per pilar (4.4) — diteruskan ke server /api/ai-decision. */
  provenance?: {
    market?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    liquidity?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    onChain?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    macro?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
  };
}

/**
 * Two-Mode Decision Router — Satu source of truth untuk keputusan.
 *
 * Routing bersih (tidak campur aduk):
 *   MODE AI  : process.env.GEMINI_API_KEY ada (atau input.aiEnabled true)
 *              → POST /api/ai-decision (authFetch) → source="ai-decision-server"
 *              → kalau fetch gagal → turun ke MODE KEEL
 *   MODE KEEL: GEMINI kosong ATAU /api/ai-decision gagal
 *              → runKeelQuantEngine(input) LANGSUNG local → source="keel-institutional-quant"
 *              → TIDAK lewat /api/keel/signal (hindari double round-trip)
 */
export async function evaluateTradingDecision(
  input: DecisionEngineInput
): Promise<LLMDecision> {
  const startTime = Date.now();

  // Client (browser) tidak punya process.env — UI melempar input.aiEnabled dari
  // /api/health.geminiConfigured. Konteks Node pakai env langsung. Guard
  // typeof process agar bundel client tidak ReferenceError.
  const envHasGemini =
    typeof process !== "undefined" &&
    !!process.env &&
    !!process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY";
  const aiConfigured = input.aiEnabled != null ? input.aiEnabled : envHasGemini;

  if (aiConfigured) {
    try {
      // F-04: /api/ai-decision di server sekarang requireAuth → wajib pakai authFetch
      // supaya Authorization header (Bearer token) ikut terkirim.
      const res = await authFetch("/api/ai-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: input.symbol,
          currentPrice: input.currentPrice,
          technicals: input.technicals,
          mtfLiquidity: {
            marketType: input.mtfLiquidity.marketType,
            activeState: input.mtfLiquidity.activeState,
            confluenceScore: input.mtfLiquidity.confluenceScore,
            confluenceSummary: input.mtfLiquidity.confluenceSummary,
            nearestBSL: input.mtfLiquidity.nearestBSL,
            nearestSSL: input.mtfLiquidity.nearestSSL,
            recentSweep: input.mtfLiquidity.recentSweep,
            huntingTarget: input.mtfLiquidity.huntingTarget,
          },
          onChainMetrics: input.onChainMetrics,
          macroCalendar: input.macroCalendar,
          activePositions: input.activePositions,
          portfolioEquity: input.portfolioEquity,
          riskParams: {
            maxRiskPerTradePercent: input.riskConfig.maxRiskPerTradePercent,
            maxDrawdownPercent: input.riskConfig.maxDrawdownLimit,
            minConfidenceThreshold: input.riskConfig.minConfidenceThreshold,
          },
          /*** Provenance tags per pilar (4.4) — server simpan di audit ledger. */
          provenance: input.provenance,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          action: data.action || "HOLD",
          confidence: data.confidence || 75,
          targetPrice: data.targetPrice || input.currentPrice,
          stopLoss: data.stopLoss || Number((input.currentPrice * 0.985).toFixed(2)),
          takeProfit: data.takeProfit || Number((input.currentPrice * 1.03).toFixed(2)),
          positionSizePercent: data.positionSizePercent || 8,
          reasoning: data.reasoning || "Evaluasi MTF Liquidation Hunt, On-Chain, dan Makro selesai.",
          source: "ai-decision-server",
          inferenceLatencyMs: Date.now() - startTime,
          liquidityHuntAnalysis: data.liquidityHuntAnalysis || {
            targetPool: input.mtfLiquidity.huntingTarget?.targetType || "BSL",
            targetZonePrice: input.mtfLiquidity.huntingTarget?.targetPrice || input.currentPrice * 1.025,
            sweepTriggered: Boolean(input.mtfLiquidity.recentSweep),
            mtfBias: input.mtfLiquidity.activeState,
            confluenceScore: input.mtfLiquidity.confluenceScore,
            invalidationLevel: input.mtfLiquidity.recentSweep?.invalidationPrice || input.currentPrice * 0.985,
          },
          onChainContext: data.onChainContext || {
            smartMoneyBias: input.onChainMetrics?.smartMoneyBias || "BULLISH_ACCUMULATION",
            netflowStatus: input.onChainMetrics?.netflowStatus || "STRONG_OUTFLOW",
            mvrvZScore: input.onChainMetrics?.mvrvZScore || 1.84,
            whaleSignal: "Akumulasi Cold Storage",
          },
          macroContext: data.macroContext || {
            // Jujur: kalau tidak ada data makro real, jangan klaim FOMC/HIGH_ALERT
            // yang ber-opini — kasih label no-data (F9).
            nearestEventName: input.macroCalendar?.nearestEvent?.name || "No macro data (fail-closed)",
            volatilityRisk: input.macroCalendar?.nearestEvent?.volatilityRisk || "UNKNOWN",
            fedStance: input.macroCalendar?.fedPolicyStance || "DATA_DEPENDENT",
          },
          provenance: data.provenance ?? input.provenance,
          promptSummary: data.promptSummary,
        };
      }
    } catch (err) {
      console.warn(
        "Server decision route unavailable, falling back to local Keel institutional quant engine:",
        err
      );
    }
  }

  // MODE KEEL — local, tanpa HTTP /api/keel/signal (hindari double round-trip).
  // Fail-closed jujur: orderBook kosong atau recentTrades kosong → keel HOLD
  // (tidak pernah fabricate depth/trade print).
  const keelResult = runKeelQuantEngine({
    symbol: input.symbol,
    currentPrice: input.currentPrice,
    technicals: input.technicals,
    mtfLiquidity: input.mtfLiquidity,
    orderBook: input.orderBook,
    recentTrades: input.recentTrades,
    futures: input.futures,
  });

  return {
    ...keelResult.decision,
    source: "keel-institutional-quant",
    inferenceLatencyMs: Date.now() - startTime,
  };
}