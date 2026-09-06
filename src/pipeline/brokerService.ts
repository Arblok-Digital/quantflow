import {
  TradeAction,
  Position,
  Timeframe,
  MarketType,
} from "../types";
import { hmacSha256, sha256Hex } from "../utils/crypto";

export interface OrderExecutionParams {
  symbol: string;
  action: TradeAction;
  qty: number;
  requestedPrice: number;
  timeframe: Timeframe;
  marketType: MarketType;
  stopLoss: number;
  takeProfit: number;
  targetPool?: string;
  apiSecret?: string;
  entryReasoning?: string;
  confidence?: number;
  leverage?: number;
}

export interface ExecutionResult {
  status: "FILLED" | "REJECTED";
  executedPrice: number;
  slippageBps: number;
  signature: string;
  payloadHash: string;
  executionLatencyMs: number;
  position?: Position;
}

/**
 * Broker Gateway Service
 * Simulates swing/positional order routing (15m Futures / 4h Spot) with realistic
 * liquidity fills, HMAC cryptographic signing, and position generation.
 */
export async function executeBrokerOrder(
  params: OrderExecutionParams
): Promise<ExecutionResult> {
  const startTime = Date.now();

  // For 15m/4h swing trading, slippage is measured against spread & book depth
  // Slippage is much smaller in bps (0.2 to 1.5 bps) compared to HFT front-running
  const slippageBps = Number((0.3 + Math.random() * 0.8).toFixed(2));
  const slippageMultiplier = params.action === "BUY" ? (1 + slippageBps / 10000) : (1 - slippageBps / 10000);
  const executedPrice = Number((params.requestedPrice * slippageMultiplier).toFixed(2));

  // Prepare signed order payload
  const payload = JSON.stringify({
    symbol: params.symbol,
    side: params.action,
    qty: params.qty,
    price: executedPrice,
    marketType: params.marketType,
    timeframe: params.timeframe,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    timestamp: Date.now(),
    nonce: Math.floor(Math.random() * 1000000),
  });

  const secret = params.apiSecret || "broker_client_secret_noncustodial";
  const signature = await hmacSha256(secret, payload);
  const payloadHash = await sha256Hex(payload);

  const potentialProfitUSD = Number((params.qty * Math.abs(params.takeProfit - executedPrice)).toFixed(2));
  const potentialLossUSD = Number((params.qty * Math.abs(executedPrice - params.stopLoss)).toFixed(2));
  const riskRewardRatio = potentialLossUSD > 0 ? Number((potentialProfitUSD / potentialLossUSD).toFixed(2)) : 2.5;

  const newPosition: Position = {
    id: `pos_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    symbol: params.symbol,
    side: params.action === "BUY" ? "LONG" : "SHORT",
    qty: params.qty,
    notionalUSD: Number((params.qty * executedPrice).toFixed(2)),
    leverage: params.leverage || 10,
    entryPrice: executedPrice,
    currentPrice: executedPrice,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    potentialProfitUSD,
    potentialLossUSD,
    riskRewardRatio,
    openedAt: Date.now(),
    timeframe: params.timeframe,
    marketType: params.marketType,
    targetLiquidityPool: params.targetPool,
    entryReasoning: params.entryReasoning,
    confidence: params.confidence,
    liquidationPrice: params.action === "BUY"
      ? Number((executedPrice * 0.90).toFixed(2))
      : Number((executedPrice * 1.10).toFixed(2)),
  };

  return {
    status: "FILLED",
    executedPrice,
    slippageBps,
    signature,
    payloadHash,
    executionLatencyMs: Date.now() - startTime + 8, // Realistic socket round-trip
    position: newPosition,
  };
}
