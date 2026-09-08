import { generateSignal, SignalBuildInput, SignalGenerationResult } from "./keel/mm-brain/signal-generator";
import { evaluateRisk, RiskCandidate, RiskSnapshot } from "./keel/risk/gatekeeper";
import { IntradayHighWaterMark } from "./keel/risk/drawdown-monitor";
import { store, openPositions, ordersLastHour, lastKillSwitchEvent } from "./keel/store";
import { NormalizedDepth, NormalizedTrade, MtfVector, DepthLevel } from "./keel/types";
import { LLMDecision, Candle, TechnicalIndicators, MTFLiquidityAnalysis, OrderBook } from "../types";

export interface KeelAdapterInput {
  symbol: string;
  currentPrice: number;
  candles15m?: Candle[];
  candles4h?: Candle[];
  technicals?: TechnicalIndicators;
  mtfLiquidity?: MTFLiquidityAnalysis;
  orderBook?: OrderBook;
  portfolioEquity?: number;
}

/**
 * Keel Engine Adapter — bridges Keel's institutional quantitative algorithms
 * (Smart Money Tracker, Absorption Engine, Wall Dynamics, Confluence Matrix)
 * into the main trading pipeline decision & risk gates.
 */
export function runKeelQuantEngine(input: KeelAdapterInput): {
  decision: LLMDecision;
  rawSignalResult: SignalGenerationResult;
} {
  const symbol = input.symbol || "BTC/USDT";
  const entryPrice = input.currentPrice;

  const bids: DepthLevel[] = (input.orderBook?.bids || []).map((b) => ({ price: b.price, qty: b.size }));
  const asks: DepthLevel[] = (input.orderBook?.asks || []).map((a) => ({ price: a.price, qty: a.size }));
  const hasRealDepth = bids.length > 0 && asks.length > 0;
  const depth: NormalizedDepth | null = hasRealDepth
    ? { symbol, venue: "BINANCE_SPOT", bids, asks, tsServerMs: Date.now() }
    : null;

  let biasVal: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (input.mtfLiquidity) {
    const s = String(input.mtfLiquidity.activeState);
    if (s === "SWEPT_SSL" || s === "HUNTING_BSL" || s === "BSL") {
      biasVal = "BULLISH";
    } else if (s === "SWEPT_BSL" || s === "HUNTING_SSL" || s === "SSL") {
      biasVal = "BEARISH";
    }
  }

  const mtfBias: MtfVector = {
    m15: biasVal,
    h1: biasVal,
    h4: biasVal,
    d1: biasVal,
  };

  if (!hasRealDepth) {
    const holdDecision: LLMDecision = {
      action: "HOLD",
      confidence: 50,
      targetPrice: entryPrice,
      stopLoss: Number((entryPrice * 0.985).toFixed(2)),
      takeProfit: Number((entryPrice * 1.03).toFixed(2)),
      positionSizePercent: 0,
      reasoning: "[Keel Engine] HOLD — no real depth: orderBook kosong, skip fail-closed (tidak fabricate depth).",
      source: "keel-institutional-quant",
      inferenceLatencyMs: 1,
      liquidityHuntAnalysis: {
        targetPool: "BSL",
        targetZonePrice: Number((entryPrice * 1.03).toFixed(2)),
        sweepTriggered: false,
        mtfBias: biasVal === "BULLISH" ? "BULLISH_REVERSAL" : biasVal === "BEARISH" ? "BEARISH_REVERSAL" : "NEUTRAL",
        confluenceScore: 0,
        invalidationLevel: Number((entryPrice * 0.985).toFixed(2)),
      },
    };
    const emptyResult = generateSignal({
      symbol,
      venue: "BINANCE_SPOT",
      depth: null,
      recentTrades: [],
      mtfBias,
      narrativeVelocity: 0,
      entryPrice,
      detectedAtServerMs: Date.now(),
      strategy: "SWING",
    });
    return { decision: holdDecision, rawSignalResult: emptyResult };
  }

  // F-03: only the real order book depth is wired into the adapter input —
  // there is NO real recentTrades / order-flow stream available. Do NOT
  // fabricate trade prints: pass empty trades and narrativeVelocity 0 so the
  // signal generator runs purely on the REAL depth (serbuk jujur, fail-closed).
  const recentTrades: NormalizedTrade[] = [];

  const buildInput: SignalBuildInput = {
    symbol,
    venue: "BINANCE_SPOT",
    depth: depth as NormalizedDepth,
    recentTrades,
    mtfBias,
    narrativeVelocity: 0,
    entryPrice,
    detectedAtServerMs: Date.now(),
    strategy: "SWING",
  };

  const signalResult = generateSignal(buildInput);

  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  let targetPrice = entryPrice;
  let stopLoss = Number((entryPrice * 0.985).toFixed(2));
  let takeProfit = Number((entryPrice * 1.03).toFixed(2));
  let confidence = Math.min(95, Math.max(50, Math.round(signalResult.compositeScore * 100)));

  if (signalResult.signal) {
    action = signalResult.signal.action;
    confidence = Math.round(signalResult.confluence.score);

    if (signalResult.levels) {
      stopLoss = signalResult.levels.stopAbs;
      takeProfit = signalResult.levels.targetAbs;
    } else {
      stopLoss = action === "BUY" ? Number((entryPrice * 0.98).toFixed(2)) : Number((entryPrice * 1.02).toFixed(2));
      takeProfit = action === "BUY" ? Number((entryPrice * 1.04).toFixed(2)) : Number((entryPrice * 0.96).toFixed(2));
    }
  }

  const reasoning = signalResult.discardedReason
    ? `[Keel Engine] Signal Filtered: ${signalResult.discardedReason} | Flow: ${signalResult.smartMoneyFlow} | Liquidity Depth: $${(signalResult.liquidityDepthUsd / 1000).toFixed(0)}k`
    : `[Keel Engine] Institutional Signal Approved | Flow: ${signalResult.smartMoneyFlow} | Wall Action: ${signalResult.wall?.action || "NONE"} | Confluence: ${signalResult.confluence.score}%`;

  const decision: LLMDecision = {
    action,
    confidence,
    targetPrice,
    stopLoss,
    takeProfit,
    positionSizePercent: action === "HOLD" ? 0 : 5,
    reasoning,
    source: "keel-institutional-quant",
    inferenceLatencyMs: 2,
    liquidityHuntAnalysis: {
      targetPool: action === "BUY" ? "BSL" : "SSL",
      targetZonePrice: takeProfit,
      sweepTriggered: Boolean(signalResult.absorption?.isPreBreakoutAccumulation),
      mtfBias: biasVal === "BULLISH" ? "BULLISH_REVERSAL" : biasVal === "BEARISH" ? "BEARISH_REVERSAL" : "NEUTRAL",
      confluenceScore: signalResult.confluence.score,
      invalidationLevel: stopLoss,
    },
  };

  return { decision, rawSignalResult: signalResult };
}

let keelHwm: number | null = null;

export function _resetKeelHwmForTest(): void {
  keelHwm = null;
}

/**
 * Keel Risk Gate Evaluation — evaluates trade candidate against Keel's institutional risk limits.
 */
export function evaluateKeelRisk(candidate: RiskCandidate, currentEquityUsd: number): {
  passed: boolean;
  reasons: string[];
} {
  const limitsView = {
    maxOpenPositions: 5,
    maxOrdersPerHour: 10,
    maxDrawdownPct: 3.0,
    minPositionSizePct: 2.0,
    maxPositionSizePct: 5.0,
    stopLossPct: 2.0,
  };

  const killSwitch = lastKillSwitchEvent();
  if (keelHwm === null || !isFinite(keelHwm)) keelHwm = currentEquityUsd;
  else keelHwm = Math.max(keelHwm, currentEquityUsd);
  const hwmInst = new IntradayHighWaterMark(keelHwm);
  const drawdownPct = hwmInst.observe(currentEquityUsd).drawdownPct;
  keelHwm = hwmInst.current();

  const snapshot: RiskSnapshot = {
    openPositions: openPositions().length,
    ordersLastHour: ordersLastHour(Date.now()).length,
    dailyDrawdownPct: drawdownPct,
    killSwitchActive: killSwitch ? killSwitch.isActive : false,
  };

  return evaluateRisk(candidate, snapshot, limitsView);
}
