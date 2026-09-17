import {
  Candle,
  TechnicalIndicators,
  MarketType,
  Timeframe,
  Portfolio,
  Position,
  RiskConfig,
  AuditLogEntry,
  LLMDecision,
  RiskEvaluationResult,
  MTFLiquidityAnalysis,
  LatencyBreakdown,
  OrderBook,
} from "../types";
import { analyzeMTFLiquidity } from "../logic/liquidityHunt";
import { evaluateTradingDecision } from "../logic/decisionEngine";
import { evaluateRiskGate } from "../logic/riskGatekeeper";
import { executeBrokerOrder } from "./brokerService";
import { sha256Hex } from "../utils/crypto";

// F-13: ledger client (hash-chain ini) hanya untuk tampilan real-time;
// server /api/ledger (HMAC sinkron dengan appendAudit di db.ts) adalah sumber otoritatif.
// LEGACY PATH: hook useTradingPipeline sudah server-driven (POST /api/pipeline/cycle).
// Fungsi ini dipertahankan untuk kompatibilitas (manual trigger / tooling) —
// decisionId diteruskan dari input agar trace tetap utuh (F-08/P1).
let warnedClientLedgerDisplayOnly = false;

export interface PipelineCycleInput {
  symbol: string;
  currentPrice: number;
  candles15m: Candle[];
  candles4h: Candle[];
  technicals: TechnicalIndicators;
  marketType: MarketType;
  timeframe: Timeframe;
  portfolio: Portfolio;
  activePositions: Position[];
  riskConfig: RiskConfig;
  lastBlockHash: string;
  onChainMetrics?: import("../types").OnChainMetrics;
  macroCalendar?: import("../types").MacroSummary;
  /** Real order book (bids/asks) to estimate liquidation depth honestly. */
  orderBook?: OrderBook;
  /** AI diaktifkan? Dari /api/health.geminiConfigured. Absen = cek env server. */
  aiEnabled?: boolean;
  /** Real order-flow (aggTrades) untuk keel quant engine (opsional). */
  recentTrades?: import("../data/marketFetcher").RecentTrade[];
  /** Futures institutional metrics untuk keel quant engine (opsional). */
  futures?: import("../data/marketFetcher").FuturesMetrics;
  /**
   * AI decision id (dari saveAgentDecisionDb / /api/ai-decision) — diteruskan
   * ke paper book sebagai order.meta.decisionId untuk training join.
   */
  decisionId?: string;
}

export interface PipelineCycleOutput {
  decision: LLMDecision;
  riskResult: RiskEvaluationResult;
  mtfLiquidity: MTFLiquidityAnalysis;
  auditEntry: AuditLogEntry;
  newPosition: Position | null;
  /** Limit NEW dari server (belum ada posisi) — hook meneruskan ke pending list. */
  newPendingOrder?: {
    id: string;
    symbol: string;
    side: string;
    type: string;
    status: string;
    amount: number;
    limitPrice?: number;
    leverage?: number;
  } | null;
  updatedPortfolio: Portfolio;
  latencyBreakdown: LatencyBreakdown;
}

/**
 * End-to-end Trading Pipeline Orchestrator
 * Modularly connects Data Feeder -> MTF Liquidation Analysis -> Decision Engine
 * -> Risk Gatekeeper -> Broker Gateway -> Immutable Ledger.
 */
export async function runTradingPipelineCycle(
  input: PipelineCycleInput
): Promise<PipelineCycleOutput> {
  const cycleStart = Date.now();

  // Step 1: MTF Liquidation Hunt Analysis (15m Futures & 4h Spot)
  const feederStart = Date.now();
  const mtfLiquidity = analyzeMTFLiquidity(
    input.candles15m,
    input.candles4h,
    input.currentPrice,
    input.marketType,
    input.orderBook
  );
  const feederMs = Date.now() - feederStart;

  // Step 2: Decision Engine (Gemini 3.8 Flash or Algorithmic MTF Hunter)
  const inferenceStart = Date.now();
  const decision = await evaluateTradingDecision({
    symbol: input.symbol,
    currentPrice: input.currentPrice,
    candles: input.timeframe === "4h" ? input.candles4h : input.candles15m,
    candles15m: input.candles15m,
    candles4h: input.candles4h,
    technicals: input.technicals,
    mtfLiquidity,
    onChainMetrics: input.onChainMetrics,
    macroCalendar: input.macroCalendar,
    activePositions: input.activePositions,
    portfolioEquity: input.portfolio.equity,
    riskConfig: input.riskConfig,
    aiEnabled: input.aiEnabled,
    orderBook: input.orderBook,
    recentTrades: input.recentTrades,
    futures: input.futures,
  });
  const inferenceMs = Date.now() - inferenceStart;

  // Step 3: Risk Management Gatekeeper Pre-Trade Verification
  const riskStart = Date.now();
  const riskResult = evaluateRiskGate(
    decision,
    input.riskConfig,
    input.portfolio,
    input.currentPrice
  );
  const riskCheckMs = Date.now() - riskStart;

  // Step 4: Broker Execution (if approved & action != HOLD)
  let brokerExecutionMs = 0;
  let newPosition: Position | null = null;
  let newPendingOrder: PipelineCycleOutput["newPendingOrder"] = null;
  let executedPrice = input.currentPrice;
  let slippageBps = 0.4;
  let signature = "sig_simulated_hold";
  let payloadHash = "hash_simulated_hold";
  let status: "FILLED" | "REJECTED" | "NEW" = "FILLED";
  let tradeQty = 0;

  let updatedPortfolio = { ...input.portfolio };

  if (riskResult.approved && decision.action !== "HOLD") {
    // Check if position for symbol already open in same direction
    const existingSameSide = input.activePositions.find(
      (p) => p.symbol === input.symbol && p.side === (decision.action === "BUY" ? "LONG" : "SHORT")
    );

    if (!existingSameSide) {
      // Calculate position size in USD and Qty
      const allocatedUsd = (input.portfolio.equity * decision.positionSizePercent) / 100;
      tradeQty = Number((allocatedUsd / input.currentPrice).toFixed(4));

      const brokerRes = await executeBrokerOrder({
        symbol: input.symbol,
        action: decision.action,
        qty: tradeQty,
        requestedPrice: input.currentPrice,
        timeframe: input.timeframe,
        marketType: input.marketType,
        stopLoss: decision.stopLoss,
        takeProfit: decision.takeProfit,
        targetPool: decision.liquidityHuntAnalysis?.targetPool,
        entryReasoning: decision.reasoning,
        confidence: decision.confidence,
        leverage: 10,
        decisionId: input.decisionId,
      });

      brokerExecutionMs = brokerRes.executionLatencyMs;
      executedPrice = brokerRes.executedPrice;
      slippageBps = brokerRes.slippageBps;
      signature = brokerRes.signature;
      payloadHash = brokerRes.payloadHash;

      if (brokerRes.status === "REJECTED") {
        // Server menolak order (alasan eksplisit). Tidak ada posisi, tidak ada
        // pengurangan cash.
        status = "REJECTED";
        newPosition = null;
      } else if (brokerRes.status === "NEW") {
        // Limit NEW: belum ada posisi & belum ada fill — teruskan receipt agar
        // FE bisa render pending (sebelumnya dibuang → invisible).
        status = "NEW";
        newPosition = null;
        newPendingOrder = brokerRes.pendingOrder ?? null;
        executedPrice = brokerRes.pendingOrder?.limitPrice ?? input.currentPrice;
        slippageBps = 0;
      } else {
        status = "FILLED";
        newPosition = brokerRes.position || null;
        // Update cash balance (margin dipotong server dari akun paper; sisi
        // client mempertahankan cash simetris untuk UI lokal).
        updatedPortfolio.cash = Math.max(0, updatedPortfolio.cash - allocatedUsd);
      }
    }
  } else if (!riskResult.approved && decision.action !== "HOLD") {
    status = "REJECTED";
  }

  const totalMs = Date.now() - cycleStart;
  const latencyBreakdown: LatencyBreakdown = {
    feederMs,
    inferenceMs,
    riskCheckMs,
    brokerExecutionMs,
    totalMs,
  };

  // Step 5: Cryptographic Hash Block Generation for Audit Ledger
  // F-13: client ledger display-only — server /api/ledger adalah sumber otoritatif.
  if (!warnedClientLedgerDisplayOnly) {
    console.warn(
      "[tradingPipeline] client ledger is display-only; server /api/ledger is authoritative"
    );
    warnedClientLedgerDisplayOnly = true;
  }
  const logId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const blockData = JSON.stringify({
    id: logId,
    timestamp: Date.now(),
    symbol: input.symbol,
    action: decision.action,
    qty: tradeQty,
    executedPrice,
    signature,
    payloadHash,
    previousHash: input.lastBlockHash,
    timeframe: input.timeframe,
    mtfBias: decision.liquidityHuntAnalysis?.mtfBias,
  });
  const blockHash = await sha256Hex(blockData);

  const auditEntry: AuditLogEntry = {
    id: logId,
    timestamp: Date.now(),
    symbol: input.symbol,
    action: decision.action,
    qty: tradeQty,
    requestedPrice: input.currentPrice,
    executedPrice,
    slippageBps,
    // Limit NEW dipetakan ke PENDING (OrderStatus tidak mengenal NEW).
    status: riskResult.approved ? (decision.action === "HOLD" ? "FILLED" : status === "NEW" ? "PENDING" : status) : "REJECTED",
    reasoning: decision.reasoning,
    confidence: decision.confidence,
    riskEvaluation: riskResult,
    latency: latencyBreakdown,
    signature,
    payloadHash,
    previousHash: input.lastBlockHash,
    blockHash,
    timeframe: input.timeframe,
    marketType: input.marketType,
    liquidityContext: decision.liquidityHuntAnalysis?.mtfBias,
    // F-08/P1: decision trace end-to-end (decision → order → position → audit).
    decisionId: input.decisionId,
  };

  return {
    decision,
    riskResult,
    mtfLiquidity,
    auditEntry,
    newPosition,
    newPendingOrder,
    updatedPortfolio,
    latencyBreakdown,
  };
}
