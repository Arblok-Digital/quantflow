import { generateSignal, SignalBuildInput, SignalGenerationResult } from "./keel/mm-brain/signal-generator";
import { evaluateRisk, RiskCandidate, RiskSnapshot } from "./keel/risk/gatekeeper";
import { IntradayHighWaterMark } from "./keel/risk/drawdown-monitor";
import { store, openPositions, ordersLastHour, lastKillSwitchEvent } from "./keel/store";
import { NormalizedDepth, NormalizedTrade, MtfVector, DepthLevel } from "./keel/types";
import type { RecentTrade, FuturesMetrics } from "../data/marketFetcher";
import { LLMDecision, Candle, TechnicalIndicators, MTFLiquidityAnalysis, OrderBook } from "../types";

export interface KeelAdapterInput {
  symbol: string;
  currentPrice: number;
  candles15m?: Candle[];
  candles4h?: Candle[];
  technicals?: TechnicalIndicators;
  mtfLiquidity?: MTFLiquidityAnalysis;
  orderBook?: OrderBook;
  recentTrades?: RecentTrade[];
  futures?: FuturesMetrics;
  portfolioEquity?: number;
}

export interface FuturesAnalysis {
  fundingRate?: number;
  fundingBps?: number;
  markPrice?: number;
  openInterest?: number;
  openInterestUsd?: number;
  lsrTaker?: number;
  lsrAccount?: number;
  longLiqUsd?: number;
  shortLiqUsd?: number;
  longLiqSize?: number;
  shortLiqSize?: number;
  topLongSize?: number;
  topShortSize?: number;
  topLsrSize?: number;
  volume24hUsd?: number;
  bias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  biasReason?: string;
  source?: string;
}

function buildFuturesAnalysis(fm: FuturesMetrics): FuturesAnalysis | undefined {
  if (!fm || fm.success !== true) return undefined;

  let total = 0;
  const reasons: string[] = [];

  if (fm.fundingRate != null) {
    if (fm.fundingRate < 0) { total += 1; reasons.push("funding<0 (long murah)"); }
    else if (fm.fundingRate > 0.0005) { total -= 1; reasons.push("funding>0.05% (long crowded)"); }
  }
  if (fm.lsrTaker != null) {
    if (fm.lsrTaker < 0.9) { total += 1; reasons.push("LSR<0.9 (banyak short)"); }
    else if (fm.lsrTaker > 1.1) { total -= 1; reasons.push("LSR>1.1 (banyak long)"); }
  }
  if (fm.longLiqUsd != null && fm.shortLiqUsd != null) {
    if (fm.shortLiqUsd > 0 && fm.longLiqUsd > 3 * fm.shortLiqUsd) { total += 1; reasons.push("liq LONG magnet atas"); }
    else if (fm.longLiqUsd > 0 && fm.shortLiqUsd > 3 * fm.longLiqUsd) { total -= 1; reasons.push("liq SHORT magnet bawah"); }
  }

  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    total >= 1 ? "BULLISH" : total <= -1 ? "BEARISH" : "NEUTRAL";
  const biasReason = reasons.length > 0 ? reasons.join("; ") : "tidak ada komponen ekstrem";

  return {
    fundingRate: fm.fundingRate,
    fundingBps: fm.fundingBps,
    markPrice: fm.markPrice,
    openInterest: fm.openInterest,
    openInterestUsd: fm.openInterestUsd,
    lsrTaker: fm.lsrTaker,
    lsrAccount: fm.lsrAccount,
    longLiqUsd: fm.longLiqUsd,
    shortLiqUsd: fm.shortLiqUsd,
    longLiqSize: fm.longLiqSize,
    shortLiqSize: fm.shortLiqSize,
    topLongSize: fm.topLongSize,
    topShortSize: fm.topShortSize,
    topLsrSize: fm.topLsrSize,
    volume24hUsd: fm.volume24hUsd,
    bias,
    biasReason,
    source: fm.source,
  };
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
  const futuresAnalysis = buildFuturesAnalysis(input.futures as FuturesMetrics | undefined);

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

  // LIMITATION: `TechnicalIndicators` (src/types.ts) TIDAK punya field per-timeframe
  // (hanya satu set datar: rsi/ema20/ema50/macd/orderBookImbalance). Karena itu kita
  // TIDAK bisa membaca bias independent per-TF dari technicals. Strategi yang dipakai
  // agar confluence-matrix tidak "bias total 100%" secara artifisial:
  //   - m15 & h1  → bias konteks likuiditas (mtfLiquidity.activeState) — frame yang
  //                 sedang "hunting/sweep" (konteks 15m futures / 4h spot).
  //   - h4  & d1  → bias teknis dari satu set technicals datar (RSI/EMA/MACD/orderbook)
  //                 sebagai proxy arah trend makro. Bukan fabricate per-TF: ini derivasi
  //                 jujur dari indikator riil, hanya tidak bisa dibedakan per-frame.
  //
  // Jadi m15/h1 vs h4/d1 memang punya basis data berbeda → skor confluence tidak lagi
  // selalu 100% (bug), tanpa mengarang angka yang tak ada di input.

  // Bias teknis makro untuk frame tinggi (h4/d1) — RSI/EMA cross/trend/MACD/orderbook.
  let techBias: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (input.technicals) {
    const t = input.technicals;
    let score = 0;
    if (t.rsi < 30) score += 1;
    else if (t.rsi > 70) score -= 1;
    else if (t.rsi < 45) score += 1;
    else if (t.rsi > 55) score -= 1;
    if (t.ema20 != null && t.ema50 != null) {
      if (t.ema20 > t.ema50) score += 1;
      else if (t.ema20 < t.ema50) score -= 1;
    }
    if (t.macd && t.macd.histogram > 0) score += 1;
    else if (t.macd && t.macd.histogram < 0) score -= 1;
    if (t.orderBookImbalance > 1) score += 1;
    else if (t.orderBookImbalance < 1) score -= 1;
    if (score >= 2) techBias = "BULLISH";
    else if (score <= -2) techBias = "BEARISH";
  }

  const mtfBias: MtfVector = {
    m15: biasVal,
    h1: biasVal,
    h4: techBias,
    d1: techBias,
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
      futuresAnalysis: futuresAnalysis || undefined,
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

  // Real order-flow stream (aggTrades) diwire dari input.recentTrades.
  // Fail-closed jujur: kalau trades kosong/undefined → [] → flow NEUTRAL → HOLD.
  // TIDAK pernah fabricate/synthetic trade prints.
  const recentTrades: NormalizedTrade[] = (input.recentTrades && input.recentTrades.length > 0)
    ? input.recentTrades.map((t) => ({
        symbol,
        venue: "BINANCE_SPOT",
        price: t.price,
        qty: t.qty,
        notionalUsd: t.notionalUsd,
        isBuyerMaker: t.isBuyerMaker,
        tsServerMs: t.timestamp || Date.now(),
      }))
    : [];

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

  let reasoning = signalResult.discardedReason
    ? `[Keel Engine] Signal Filtered: ${signalResult.discardedReason} | Flow: ${signalResult.smartMoneyFlow} | Liquidity Depth: $${(signalResult.liquidityDepthUsd / 1000).toFixed(0)}k`
    : `[Keel Engine] Institutional Signal Approved | Flow: ${signalResult.smartMoneyFlow} | Wall Action: ${signalResult.wall?.action || "NONE"} | Confluence: ${signalResult.confluence.score}%`;

  if (futuresAnalysis && futuresAnalysis.fundingBps != null) {
    const fa = futuresAnalysis;
    reasoning += ` | Futures: funding ${fa.fundingBps?.toFixed(2)}bps, OI $${((fa.openInterestUsd || 0) / 1e9).toFixed(1)}B, LSR ${fa.lsrTaker ?? "-"}, liq LONG $${((fa.longLiqUsd || 0) / 1000).toFixed(0)}k/SHORT $${((fa.shortLiqUsd || 0) / 1000).toFixed(0)}k → bias ${fa.bias}`;
  }

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
    futuresAnalysis: futuresAnalysis || undefined,
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
