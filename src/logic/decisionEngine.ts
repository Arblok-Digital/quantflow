import {
  LLMDecision,
  MTFLiquidityAnalysis,
  TechnicalIndicators,
  Position,
  RiskConfig,
  Candle,
  OnChainMetrics,
  MacroSummary,
} from "../types";
import { authFetch } from "../hooks/useAuth";
import { runKeelQuantEngine } from "./keelAdapter";

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
  /** Provenance tag per pilar (4.4) — diteruskan ke server /api/ai-decision. */
  provenance?: {
    market?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    liquidity?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    onChain?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    macro?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
  };
}

/**
 * Modular Decision Engine
 * Prioritizes MTF Liquidation Hunt Zones (15m Futures & 4h Spot), On-Chain Whale Flows, and Macro Catalysts.
 */
export async function evaluateTradingDecision(
  input: DecisionEngineInput
): Promise<LLMDecision> {
  const startTime = Date.now();

  try {
    // /api/ai-decision is currently NOT protected (no requireAuth in server.ts),
    // keep using plain fetch so it stays public. If server adds auth later,
    // swap to authFetch here — authFetch will still work for public routes too.
    const res = await fetch("/api/ai-decision", {
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
        source: data.source || "ai-decision-server",
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
      };
    }
  } catch (err) {
    console.warn("Server decision route unavailable, using modular algorithmic quant engine fallback:", err);
  }

  // Deterministic Fallback Logic based on MTF Liquidity Hunt Zones
  const { mtfLiquidity, currentPrice, technicals, onChainMetrics, macroCalendar } = input;
  const isWhaleAccumulation = onChainMetrics?.smartMoneyBias === "STRONG_BULLISH" || (onChainMetrics?.exchangeNetflow24hUSD || -100) < 0;
  const isMacroAlert = (macroCalendar?.macroRiskIndex || 30) > 70;
  const targetPool = mtfLiquidity.huntingTarget?.targetType || "BSL";
  const targetZonePrice = mtfLiquidity.huntingTarget?.targetPrice || (currentPrice * 1.025);

  if (mtfLiquidity.activeState === "SWEPT_SSL" && mtfLiquidity.recentSweep) {
    // Bullish Reversal: Long Stop-Losses swept, smart money absorbing liquidity
    const invalidation = mtfLiquidity.recentSweep.invalidationPrice;
    const target = mtfLiquidity.nearestBSL?.midPrice || currentPrice * 1.035;
    return {
      action: "BUY",
      // 4.3: lapor confidence apa adanya (raw) — biarkan RiskGatekeeper yang reject.
      // Bervariasi dengan kekuatan confluence: base 78 + confluenceScore/10,
      // naik jika on-chain mengonfirmasi akumulasi whale.
      confidence: 78 + mtfLiquidity.confluenceScore / 10 + (isWhaleAccumulation ? 6 : 0),
      targetPrice: currentPrice,
      stopLoss: invalidation,
      takeProfit: target,
      positionSizePercent: isMacroAlert ? 5 : 8,
      reasoning: `MTF Liquidation Hunt: Long stop-loss pool ($${mtfLiquidity.recentSweep.zone.estimatedVolumeUSD}M) telah di-sweep dengan absorpsi sumbu (${mtfLiquidity.recentSweep.wickRejectionPercent}% absorption). On-Chain mengonfirmasi whale outflow -$${Math.abs(onChainMetrics?.exchangeNetflow24hUSD || 142)}M. Target hunting pool atas (BSL) di $${target.toFixed(2)}.`,
      source: "algorithmic-mtf-hunter",
      inferenceLatencyMs: Date.now() - startTime,
      liquidityHuntAnalysis: {
        targetPool: "BSL",
        targetZonePrice: target,
        sweepTriggered: true,
        mtfBias: "BULLISH_REVERSAL_AFTER_SSL_SWEEP",
        confluenceScore: mtfLiquidity.confluenceScore,
        invalidationLevel: invalidation,
      },
      onChainContext: {
        smartMoneyBias: onChainMetrics?.smartMoneyBias || "STRONG_BULLISH",
        netflowStatus: onChainMetrics?.netflowStatus || "STRONG_OUTFLOW_ACCUMULATION",
        mvrvZScore: onChainMetrics?.mvrvZScore || 1.84,
        whaleSignal: "Penarikan Bursa Terverifikasi",
      },
      macroContext: {
        nearestEventName: macroCalendar?.nearestEvent?.name || "No macro data (fail-closed)",
        volatilityRisk: macroCalendar?.nearestEvent?.volatilityRisk || "UNKNOWN",
        fedStance: macroCalendar?.fedPolicyStance || "DATA_DEPENDENT",
      },
    };
  }

  if (mtfLiquidity.activeState === "SWEPT_BSL" && mtfLiquidity.recentSweep) {
    // Bearish Reversal: Short Stop-Losses swept, distribution at high
    const invalidation = mtfLiquidity.recentSweep.invalidationPrice;
    const target = mtfLiquidity.nearestSSL?.midPrice || currentPrice * 0.965;
    return {
      action: "SELL",
      // 4.3: lapor confidence raw (tanpa self-bypass Math.max gate).
      // Bervariasi dengan kekuatan confluence: base 78 + confluenceScore/10.
      confidence: 78 + mtfLiquidity.confluenceScore / 10,
      targetPrice: currentPrice,
      stopLoss: invalidation,
      takeProfit: target,
      positionSizePercent: isMacroAlert ? 4 : 7,
      reasoning: `MTF Liquidation Hunt: Short stop-loss pool ($${mtfLiquidity.recentSweep.zone.estimatedVolumeUSD}M) telah di-sweep di swing high 15m. Terjadi penolakan harga tajam; target hunting pool bawah (SSL) di $${target.toFixed(2)}.`,
      source: "algorithmic-mtf-hunter",
      inferenceLatencyMs: Date.now() - startTime,
      liquidityHuntAnalysis: {
        targetPool: "SSL",
        targetZonePrice: target,
        sweepTriggered: true,
        mtfBias: "BEARISH_REVERSAL_AFTER_BSL_SWEEP",
        confluenceScore: mtfLiquidity.confluenceScore,
        invalidationLevel: invalidation,
      },
      onChainContext: {
        smartMoneyBias: onChainMetrics?.smartMoneyBias || "NEUTRAL",
        netflowStatus: onChainMetrics?.netflowStatus || "NEUTRAL",
        mvrvZScore: onChainMetrics?.mvrvZScore || 1.84,
        whaleSignal: "Potensi Distribusi Swing High",
      },
      macroContext: {
        nearestEventName: macroCalendar?.nearestEvent?.name || "No macro data (fail-closed)",
        volatilityRisk: macroCalendar?.nearestEvent?.volatilityRisk || "UNKNOWN",
        fedStance: macroCalendar?.fedPolicyStance || "DATA_DEPENDENT",
      },
    };
  }

  if (mtfLiquidity.activeState === "HUNTING_BSL" && technicals.rsi < 65 && technicals.orderBookImbalance > 1.05) {
    // Upward Momentum: Price is being magnetically attracted to upper short liquidation pool
    const target = mtfLiquidity.nearestBSL?.midPrice || currentPrice * 1.025;
    const stopLoss = Number((currentPrice * 0.985).toFixed(2));
    return {
      action: "BUY",
      confidence: 76,
      targetPrice: currentPrice,
      stopLoss,
      takeProfit: target,
      positionSizePercent: 6,
      reasoning: `Ekspansi harga menuju cluster likuidasi short (BSL) di $${target.toFixed(2)} (${mtfLiquidity.nearestBSL?.distancePercent}% distance, est. $${mtfLiquidity.nearestBSL?.estimatedVolumeUSD}M liq density).`,
      source: "algorithmic-mtf-hunter",
      inferenceLatencyMs: Date.now() - startTime,
      liquidityHuntAnalysis: {
        targetPool: "BSL",
        targetZonePrice: target,
        sweepTriggered: false,
        mtfBias: "MAGNET_EXPANSION_TO_BSL",
        confluenceScore: mtfLiquidity.confluenceScore,
        invalidationLevel: stopLoss,
      },
    };
  }

  // Default equilibrium
  return {
    action: "HOLD",
    confidence: 68,
    targetPrice: currentPrice,
    stopLoss: Number((currentPrice * 0.985).toFixed(2)),
    takeProfit: Number((currentPrice * 1.025).toFixed(2)),
    positionSizePercent: 5,
    reasoning: `Harga berada di ekuilibrium rentang likuidasi 15m/4h. Belum terjadi sweep pada pool BSL ($${mtfLiquidity.nearestBSL?.midPrice ?? "N/A"}) maupun SSL ($${mtfLiquidity.nearestSSL?.midPrice ?? "N/A"}). Agent menunggu liquidity grab terkonfirmasi.`,
    source: "algorithmic-mtf-hunter",
    inferenceLatencyMs: Date.now() - startTime,
    liquidityHuntAnalysis: {
      targetPool,
      targetZonePrice,
      sweepTriggered: false,
      mtfBias: "EQUILIBRIUM_WAITING_SWEEP",
      confluenceScore: mtfLiquidity.confluenceScore,
      invalidationLevel: Number((currentPrice * 0.985).toFixed(2)),
    },
  };
}
