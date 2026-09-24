/**
 * src/server/routes/pipeline.ts
 * Server-driven trading pipeline endpoint (F-07/P0).
 *
 * Memindahkan seluruh siklus feeder → decision → risk → broker → ledger
 * dari browser (useTradingPipeline) ke server:
 *   1. API keys (Gemini) TIDAK pernah menyentuh browser — decision AI
 *      dirutekan lewat /api/ai-decision dari sisi server.
 *   2. Decision atomic & traceable: decisionId di-generate server-side per
 *      cycle, disimpan ke agent_decisions, diteruskan ke broker order
 *      (order.meta.decisionId → position.decisionId) dan audit entry.
 *   3. Audit server-side (HMAC appendAudit) adalah sumber otoritatif;
 *      auditEntry client hanya untuk tampilan real-time.
 *
 * Risk posture: fail-closed. Input invalid → 400. Gemini down →
 * decisionEngine fallback Keel + inline keel risk gate → HOLD bila blocked.
 * Guardrail server (evaluateGuardrails) + risk gate matematika
 * (evaluateRiskGate) + broker guard tetap berlapis di server.
 */
import type { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "@/auth";
import {
  getPaperAccount,
  getPaperPositions,
} from "@/paperBook";
import { appendAudit, saveAgentDecisionDb } from "@/db";
import { analyzeMTFLiquidity } from "@/src/logic/liquidityHunt";
import { evaluateTradingDecision } from "@/src/logic/decisionEngine";
import { evaluateRiskGate } from "@/src/logic/riskGatekeeper";
import { executeBrokerOrder } from "@/src/pipeline/brokerService";
import { sha256HexNode } from "@/src/server/routes/_utils";
import type {
  AuditLogEntry,
  Candle,
  LLMDecision,
  OrderBook,
  Position,
  Portfolio,
  RiskConfig,
} from "@/src/types";
import type { RecentTrade, FuturesMetrics } from "@/src/data/marketFetcher";

const CandleSchema = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

const TechnicalsSchema = z.object({
  rsi: z.number(),
  ema20: z.number(),
  ema50: z.number(),
  macd: z.object({
    macdLine: z.number(),
    signalLine: z.number(),
    histogram: z.number(),
  }),
  orderBookImbalance: z.number(),
  volatility: z.string(),
  atr: z.number().optional(),
});

const OrderBookLevelSchema = z.object({
  price: z.number(),
  size: z.number(),
  total: z.number().optional(),
});

const OrderBookSchema = z.object({
  bids: z.array(OrderBookLevelSchema),
  asks: z.array(OrderBookLevelSchema),
  spread: z.number(),
});

const RiskConfigSchema = z.object({
  maxRiskPerTradePercent: z.number(),
  maxPositionPercent: z.number(),
  maxDrawdownLimit: z.number(),
  minConfidenceThreshold: z.number(),
  minRiskRewardRatio: z.number(),
  isEmergencyStopActive: z.boolean(),
});

const PipelineInputSchema = z.object({
  symbol: z.string().min(1),
  currentPrice: z.number().positive().finite(),
  candles15m: z.array(CandleSchema).default([]),
  candles4h: z.array(CandleSchema).default([]),
  technicals: TechnicalsSchema,
  marketType: z.enum(["FUTURES", "SPOT"]),
  timeframe: z.enum(["1s", "1m", "5m", "15m", "1h", "4h", "1D", "1W"]),
  riskConfig: RiskConfigSchema,
  lastBlockHash: z.string().min(1).default("GENESIS_ROOT_AI_TRADING"),
  onChainMetrics: z.record(z.string(), z.unknown()).optional(),
  macroCalendar: z.record(z.string(), z.unknown()).optional(),
  orderBook: OrderBookSchema.optional(),
  recentTrades: z.array(z.record(z.string(), z.unknown())).optional(),
  futures: z.record(z.string(), z.unknown()).optional(),
  aiEnabled: z.boolean().optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
});

export type PipelineCycleServerResult = {
  success: true;
  decisionId: string;
  decision: LLMDecision;
  riskResult: Awaited<ReturnType<typeof evaluateRiskGate>>;
  mtfLiquidity: ReturnType<typeof analyzeMTFLiquidity>;
  auditEntry: AuditLogEntry;
  newPosition: (Position & { decisionId?: string }) | null;
  newPendingOrder: {
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
  latencyBreakdown: AuditLogEntry["latency"];
  latencyMs: number;
};

/** Normalisasi posisi dari brokerService ke shape server + decision trace. */
function mapToPosition(p: any, decisionId: string): Position & { decisionId?: string } {
  return { ...p, decisionId: p?.decisionId ?? decisionId };
}

export function registerPipelineRoutes(app: Express): void {
  app.post("/api/pipeline/cycle", requireAuth, async (req: Request, res: Response) => {
    const startTime = Date.now();
    const parsed = PipelineInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        reason: "INVALID_PIPELINE_INPUT",
        message: "Input pipeline cycle tidak valid.",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const body = parsed.data;

    // decisionId di-generate server-side per cycle — single trace id untuk
    // decision → order → position → audit → training CSV (F-08/P1).
    const decisionId = `dec-${Date.now()}-${randomUUID().slice(0, 8)}`;

    try {
      const feederStart = Date.now();
      const mtfLiquidity = analyzeMTFLiquidity(
        body.candles15m as Candle[],
        body.candles4h as Candle[],
        body.currentPrice,
        body.marketType,
        body.orderBook as OrderBook | undefined
      );
      const feederMs = Date.now() - feederStart;

      // Snapshot portfolio + posisi dari SERVER paper book (sumber kebenaran),
      // bukan angka kiriman client yang bisa stale/dimanipulasi.
      const portfolio: Portfolio = getPaperAccount() as unknown as Portfolio;
      const serverPositions = getPaperPositions();
      const activePositions = serverPositions.map((p: any) => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        entryPrice: p.entryPrice,
        currentPrice: p.lastMark ?? p.entryPrice,
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        openedAt: p.openedAt,
        timeframe: body.timeframe,
        marketType: body.marketType,
      }));

      // Decision engine (server-side): executeAiDecisionCore dipanggil
      // LANGSUNG in-memory lewat aiDecisionBridge ketika core terdaftar —
      // BUKAN HTTP authFetch (relative URL throw di native fetch Node dan
      // localStorage tidak ada; audit Gemini 3 Pro P0-A/C). Fallback Keel +
      // inline risk gate + provenance entry gate (P0-B) fail-closed.
      const inferenceStart = Date.now();
      const decision = await evaluateTradingDecision({
        symbol: body.symbol,
        currentPrice: body.currentPrice,
        candles: body.timeframe === "4h" ? (body.candles4h as Candle[]) : (body.candles15m as Candle[]),
        candles15m: body.candles15m as Candle[],
        candles4h: body.candles4h as Candle[],
        technicals: body.technicals,
        mtfLiquidity,
        onChainMetrics: body.onChainMetrics as any,
        macroCalendar: body.macroCalendar as any,
        activePositions: activePositions as any,
        portfolioEquity: portfolio.equity,
        riskConfig: body.riskConfig as RiskConfig,
        aiEnabled: body.aiEnabled,
        orderBook: body.orderBook as OrderBook | undefined,
        recentTrades: body.recentTrades as unknown as RecentTrade[] | undefined,
        futures: body.futures as unknown as FuturesMetrics | undefined,
        provenance: body.provenance as any,
      });
      const inferenceMs = Date.now() - inferenceStart;

      const riskStart = Date.now();
      const riskResult = evaluateRiskGate(decision, body.riskConfig as RiskConfig, portfolio, body.currentPrice);
      const riskCheckMs = Date.now() - riskStart;

      let brokerExecutionMs = 0;
      let newPosition: PipelineCycleServerResult["newPosition"] = null;
      let newPendingOrder: PipelineCycleServerResult["newPendingOrder"] = null;
      let executedPrice = body.currentPrice;
      let slippageBps = 0.4;
      let signature = "sig_simulated_hold";
      let payloadHash = "hash_simulated_hold";
      let status: "FILLED" | "REJECTED" | "NEW" = "FILLED";
      let tradeQty = 0;
      let updatedPortfolio: Portfolio = { ...portfolio };

      if (riskResult.approved && decision.action !== "HOLD") {
        const existingSameSide = activePositions.find(
          (p) => p.symbol === body.symbol && p.side === (decision.action === "BUY" ? "LONG" : "SHORT")
        );
        if (!existingSameSide) {
          const allocatedUsd = (portfolio.equity * decision.positionSizePercent) / 100;
          tradeQty = Number((allocatedUsd / body.currentPrice).toFixed(4));

          const brokerRes = await executeBrokerOrder({
            symbol: body.symbol,
            action: decision.action,
            qty: tradeQty,
            requestedPrice: body.currentPrice,
            timeframe: body.timeframe,
            marketType: body.marketType,
            stopLoss: decision.stopLoss,
            takeProfit: decision.takeProfit,
            targetPool: decision.liquidityHuntAnalysis?.targetPool,
            entryReasoning: decision.reasoning,
            confidence: decision.confidence,
            leverage: 10,
            decisionId,
          });

          brokerExecutionMs = brokerRes.executionLatencyMs;
          executedPrice = brokerRes.executedPrice;
          slippageBps = brokerRes.slippageBps;
          signature = brokerRes.signature;
          payloadHash = brokerRes.payloadHash;

          if (brokerRes.status === "REJECTED") {
            status = "REJECTED";
            newPosition = null;
          } else if (brokerRes.status === "NEW") {
            status = "NEW";
            newPosition = null;
            newPendingOrder = brokerRes.pendingOrder ?? null;
            executedPrice = brokerRes.pendingOrder?.limitPrice ?? body.currentPrice;
            slippageBps = 0;
          } else {
            status = "FILLED";
            newPosition = brokerRes.position ? mapToPosition(brokerRes.position, decisionId) : null;
            updatedPortfolio = { ...updatedPortfolio, cash: Math.max(0, updatedPortfolio.cash - allocatedUsd) };
          }
        }
      } else if (!riskResult.approved && decision.action !== "HOLD") {
        status = "REJECTED";
      }

      const latencyBreakdown = {
        feederMs,
        inferenceMs,
        riskCheckMs,
        brokerExecutionMs,
        totalMs: Date.now() - startTime,
      };

      const logId = `ORD-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const blockData = JSON.stringify({
        id: logId,
        timestamp: Date.now(),
        symbol: body.symbol,
        action: decision.action,
        qty: tradeQty,
        executedPrice,
        signature,
        payloadHash,
        previousHash: body.lastBlockHash,
        timeframe: body.timeframe,
        mtfBias: decision.liquidityHuntAnalysis?.mtfBias,
        decisionId,
      });
      const blockHash = sha256HexNode(blockData);

      const auditEntry: AuditLogEntry = {
        id: logId,
        timestamp: Date.now(),
        symbol: body.symbol,
        action: decision.action,
        qty: tradeQty,
        requestedPrice: body.currentPrice,
        executedPrice,
        slippageBps,
        status: riskResult.approved
          ? decision.action === "HOLD"
            ? "FILLED"
            : status === "NEW"
              ? "PENDING"
              : status
          : "REJECTED",
        reasoning: decision.reasoning,
        confidence: decision.confidence,
        riskEvaluation: riskResult,
        latency: latencyBreakdown,
        signature,
        payloadHash,
        previousHash: body.lastBlockHash,
        blockHash,
        timeframe: body.timeframe,
        marketType: body.marketType,
        liquidityContext: decision.liquidityHuntAnalysis?.mtfBias,
        decisionId,
      };

      // Persist decision ke DB (training source) + audit ledger server-side.
      try {
        saveAgentDecisionDb({
          id: decisionId,
          created_at: Date.now(),
          symbol: body.symbol,
          action: decision.action,
          confidence: decision.confidence,
          model_id: decision.source || "pipeline",
          latency_ms: Date.now() - startTime,
          prompt: `symbol=${body.symbol} tf=${body.timeframe} pipeline=cycle`,
          response: JSON.stringify(decision).slice(0, 2000),
          source_tags: JSON.stringify({ pipeline: true, mtf: true, decisionId }),
        });
      } catch (dbErr) {
        console.warn(`[pipeline] Gagal simpan decision ${decisionId}: ${(dbErr as Error)?.message}`);
      }
      try {
        appendAudit("pipeline-cycle", {
          id: auditEntry.id,
          decisionId,
          symbol: body.symbol,
          action: decision.action,
          status: auditEntry.status,
          fillPrice: executedPrice,
          reason: "PIPELINE_CYCLE",
          timestamp: Date.now(),
        });
      } catch (auditErr) {
        console.warn(`[pipeline] Gagal audit cycle ${decisionId}: ${(auditErr as Error)?.message}`);
      }

      const result: PipelineCycleServerResult = {
        success: true,
        decisionId,
        decision,
        riskResult,
        mtfLiquidity,
        auditEntry,
        newPosition,
        newPendingOrder,
        updatedPortfolio,
        latencyBreakdown,
        latencyMs: Date.now() - startTime,
      };
      return res.json(result);
    } catch (err: any) {
      console.error(`[pipeline] Cycle ${decisionId} gagal: ${err?.message}`);
      return res.status(500).json({
        success: false,
        decisionId,
        message: err?.message || "Pipeline cycle gagal.",
      });
    }
  });
}
