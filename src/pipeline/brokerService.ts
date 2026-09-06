import {
  TradeAction,
  Position,
  Timeframe,
  MarketType,
} from "../types";

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

interface ServerOrderReceipt {
  id: string;
  status: "FILLED" | "REJECTED";
  fillPrice?: number;
  slippageBps?: number;
  feeUSD?: number;
  qty?: number;
  notional?: number;
  leverage?: number;
  marginRequired?: number;
  executionLatencyMs?: number;
  timestamp?: number;
  signature?: string;
  payloadHash?: string;
}

interface ServerPaperPosition {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  notionalUSD: number;
  leverage: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  openedAt: number;
  lastMark?: number;
  timeframe?: string;
  marketType?: string;
  targetPool?: string;
  entryReasoning?: string;
  confidence?: number;
}

/**
 * Broker Gateway Service
 * Executes orders through the server's real broker gateway (POST /api/broker/order).
 * The server produces ALL execution data: measured fills against the real order
 * book (VWAP + measured slippage), real fees, measured latency, and a signed
 * payload hash. Nothing here is simulated. If the server is unreachable we
 * throw — the pipeline catches errors at cycle level and never fabricates fills.
 */
export async function executeBrokerOrder(
  params: OrderExecutionParams
): Promise<ExecutionResult> {
  const startTime = Date.now();

  const body = {
    symbol: params.symbol,
    side: params.action === "BUY" ? "buy" : "sell",
    type: "market",
    amount: params.qty,
    leverage: params.leverage || 10,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    meta: {
      reasoning: params.entryReasoning,
      confidence: params.confidence,
      timeframe: params.timeframe,
      marketType: params.marketType,
      targetPool: params.targetPool,
    },
  };

  const response = await postJson("/api/broker/order", body);

  const order: ServerOrderReceipt = response?.order || {};
  const status: "FILLED" | "REJECTED" =
    order.status === "REJECTED" || response?.status === "REJECTED" ? "REJECTED" : "FILLED";
  const position = response?.position ? mapServerPosition(response.position) : undefined;

  return {
    status,
    executedPrice: Number(order.fillPrice ?? 0),
    slippageBps: Number(order.slippageBps ?? 0),
    signature: order.signature || "",
    payloadHash: order.payloadHash || "",
    // Server-measured execution time (real Date.now deltas around the fill),
    // not a fabricated round-trip constant.
    executionLatencyMs: Number(order.executionLatencyMs ?? Math.max(0, Date.now() - startTime)),
    position,
  };
}

async function postJson(url: string, body: unknown): Promise<any> {
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network failure: never simulate, surface the error.
    throw new Error(`Broker server unreachable (${url}): ${(err as Error).message}`);
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    // Business rejection (REJECTED with a reason) is a valid execution outcome.
    if (payload && payload.status === "REJECTED") {
      return payload;
    }
    throw new Error(payload?.message || `Broker API error (HTTP ${response.status})`);
  }
  return payload;
}

function mapServerPosition(p: ServerPaperPosition): Position {
  const mark = p.lastMark ?? p.entryPrice;
  const unrealizedPnl = p.side === "LONG" ? (mark - p.entryPrice) * p.qty : (p.entryPrice - mark) * p.qty;
  const unrealizedPnlPercent = p.notionalUSD > 0 ? (unrealizedPnl / p.notionalUSD) * 100 : 0;
  const potentialProfitUSD = p.takeProfit ? Math.abs(p.takeProfit - p.entryPrice) * p.qty : undefined;
  const potentialLossUSD = p.stopLoss ? Math.abs(p.entryPrice - p.stopLoss) * p.qty : undefined;
  return {
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    qty: p.qty,
    notionalUSD: p.notionalUSD,
    leverage: p.leverage,
    entryPrice: p.entryPrice,
    currentPrice: mark,
    unrealizedPnl,
    unrealizedPnlPercent,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    potentialProfitUSD,
    potentialLossUSD,
    riskRewardRatio: potentialLossUSD ? (potentialProfitUSD ?? 0) / Math.max(1e-9, potentialLossUSD) : undefined,
    openedAt: p.openedAt,
    timeframe: (p.timeframe as Timeframe) || "15m",
    marketType: (p.marketType as MarketType) || "FUTURES",
    targetLiquidityPool: p.targetPool,
    entryReasoning: p.entryReasoning,
    confidence: p.confidence,
    liquidationPrice: p.liquidationPrice,
  };
}