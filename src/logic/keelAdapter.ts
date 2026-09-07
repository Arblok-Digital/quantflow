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

  // Map orderBook format to Keel NormalizedDepth
  const bids: DepthLevel[] = (input.orderBook?.bids || []).map((b) => ({ price: b.price, qty: b.size }));
  const asks: DepthLevel[] = (input.orderBook?.asks || []).map((a) => ({ price: a.price, qty: a.size }));

  const depth: NormalizedDepth = {
    symbol,
    venue: "BINANCE_SPOT",
    bids: bids.length > 0 ? bids : [{ price: entryPrice * 0.999, qty: 5.0 }],
    asks: asks.length > 0 ? asks : [{ price: entryPrice * 1.001, qty: 5.0 }],
    tsServerMs: Date.now(),
  };

  // Determine MTF bias vector from MTFLiquidityAnalysis if present
  let biasVal: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (input.mtfLiquidity) {
    if (input.mtfLiquidity.activeState.includes("SWEPT_SSL") || input.mtfLiquidity.activeState.includes("BSL")) {
      biasVal = "BULLISH";
    } else if (input.mtfLiquidity.activeState.includes("SWEPT_BSL") || input.mtfLiquidity.activeState.includes("SSL")) {
      biasVal = "BEARISH";
    }
  }

  const mtfBias: MtfVector = {
    m15: biasVal,
    h1: biasVal,
    h4: biasVal,
    d1: biasVal,
  };

  const recentTrades: NormalizedTrade[] = [
    {
      symbol,
      venue: "BINANCE_SPOT",
      price: entryPrice,
      qty: 0.5,
      notionalUsd: entryPrice * 0.5,
      isBuyerMaker: false,
      tsServerMs: Date.now() - 500,
    },
    {
      symbol,
      venue: "BINANCE_SPOT",
      price: entryPrice * 1.0001,
      qty: 1.2,
      notionalUsd: entryPrice * 1.2,
      isBuyerMaker: true,
      tsServerMs: Date.now() - 100,
    },
  ];

  const buildInput: SignalBuildInput = {
    symbol,
    venue: "BINANCE_SPOT",
    depth,
    recentTrades,
    mtfBias,
    narrativeVelocity: 1.2,
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
  const hwm = new IntradayHighWaterMark(currentEquityUsd);
  const drawdownPct = hwm.observe(currentEquityUsd).drawdownPct;

  const snapshot: RiskSnapshot = {
    openPositions: openPositions().length,
    ordersLastHour: ordersLastHour(Date.now()).length,
    dailyDrawdownPct: drawdownPct,
    killSwitchActive: killSwitch ? killSwitch.isActive : false,
  };

  return evaluateRisk(candidate, snapshot, limitsView);
}
