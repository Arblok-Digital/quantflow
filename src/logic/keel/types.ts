/**
 * Keel engine shared types — pure in-memory adaptation of Keel's
 * `src/types/exchange.ts`, `src/types/signals.ts` and schema constants.
 * No PG / Redis / Drizzle imports. Keeps zod validation, deterministic
 * clientOrderId conventions and server-time fields.
 */
import { z } from 'zod';
import { evaluateConfluence, MTF_CONFLUENCE_THRESHOLD } from './mm-brain/confluence-matrix.js';

// ---------------------------------------------------------------------------
// Venues & enums (adapted from Keel db/schema.ts constants)
// ---------------------------------------------------------------------------
export const VENUES = ['BINANCE_SPOT', 'UNISWAP_V3', 'RAYDIUM'] as const;
export type Venue = (typeof VENUES)[number];

export const SMART_MONEY_FLOWS = ['ACCUMULATION', 'DISTRIBUTION', 'NEUTRAL'] as const;
export type SmartMoneyFlow = (typeof SMART_MONEY_FLOWS)[number];

export const MTF_BIASES = ['BULLISH', 'BEARISH', 'NEUTRAL'] as const;
export type MtfBiasValue = (typeof MTF_BIASES)[number];

export const ORDER_STATUSES = ['FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED', 'PENDING'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// ---------------------------------------------------------------------------
// Market data types (Keel src/types/exchange.ts)
// ---------------------------------------------------------------------------
export interface DepthLevel {
  price: number;
  qty: number;
}

export interface NormalizedDepth {
  symbol: string;
  venue: Venue;
  bids: DepthLevel[];
  asks: DepthLevel[];
  tsServerMs: number;
}

export interface NormalizedTrade {
  symbol: string;
  venue: Venue;
  price: number;
  qty: number;
  notionalUsd: number;
  isBuyerMaker: boolean;
  tsServerMs: number;
}

export interface DEXPoolUpdate {
  poolAddress: string;
  venue: Venue;
  symbol: string;
  baseLiquidityUsd: number;
  quoteLiquidityUsd: number;
  swapVolumeUsdWindow: number;
  tsServerMs: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  usdValue: number;
}

export interface PlaceOrderRequest {
  decisionId: string;
  clientOrderId: string;
  venue: Venue;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  quoteUsdEstimate: number;
  slippageBps: number;
}

export interface OcoPlaceRequest {
  decisionId: string;
  symbol: string;
  side: 'SELL' | 'BUY';
  qty: number;
  stopPrice: number;
  stopLimitPrice: number;
  takeProfitPrice: number;
}

export interface OcoStatus {
  orderListId: number | string;
  listStatusType: string;
  listOrderStatus: string;
  orders: Array<{ symbol: string; orderId: number | string; clientOrderId: string; status: string }>;
}

export interface OcoExecutionReport {
  orderListId: string;
  listClientOrderId: string;
  contingencyType: string;
  status: string;
  orders: Array<{ symbol: string; orderId: number | string; clientOrderId: string }>;
}

export interface OrderExecutionReport {
  clientOrderId: string;
  externalRef: string | null;
  status: OrderStatus;
  executedQty: number;
  avgFillPrice: number | null;
  serverTimeMs: number;
}

export interface PermissionProbe {
  valid: boolean;
  violations: string[];
  effectiveScopes: string[];
}

// ---------------------------------------------------------------------------
// Exceptions (Keel src/services/execution/exchange-adapter.ts)
// ---------------------------------------------------------------------------
export class OrderTimeoutError extends Error {
  constructor(public readonly clientOrderId: string) {
    super(`order placement timed out for ${clientOrderId}; query-by-clientOrderId required before retry`);
    this.name = 'OrderTimeoutError';
  }
}

export class SpotOnlyViolationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`credential rejected: non-spot scopes ${violations.join(',')}`);
    this.name = 'SpotOnlyViolationError';
  }
}

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  scopes: string[];
}

export interface ExchangeAdapter {
  readonly venue: Venue;
  serverTime(): Promise<number>;
  balances(creds?: ExchangeCredentials): Promise<Balance[]>;
  placeOrder(req: PlaceOrderRequest, creds?: ExchangeCredentials): Promise<OrderExecutionReport>;
  queryByClientOrderId(clientOrderId: string, creds?: ExchangeCredentials): Promise<OrderExecutionReport | null>;
  cancelAll(symbol: string | undefined, creds?: ExchangeCredentials): Promise<number>;
  probePermissions(creds: ExchangeCredentials): Promise<PermissionProbe>;
  placeOco?(req: OcoPlaceRequest, creds?: ExchangeCredentials): Promise<OcoExecutionReport | null>;
  queryOcoByListId?(clientOrderId: string, creds?: ExchangeCredentials): Promise<OcoStatus | null>;
  cancelOco?(symbol: string, orderListId: number | string, creds?: ExchangeCredentials): Promise<void>;
}

// ---------------------------------------------------------------------------
// Signal schema (Keel src/types/signals.ts)
// ---------------------------------------------------------------------------
export const mtfBiasSchema = z.object({
  m15: z.enum(MTF_BIASES),
  h1: z.enum(MTF_BIASES),
  h4: z.enum(MTF_BIASES),
  d1: z.enum(MTF_BIASES),
});

export type MtfVector = z.infer<typeof mtfBiasSchema>;

export const mmSignalSchema = z
  .object({
    symbol: z.string().min(1),
    venue: z.enum(VENUES),
    action: z.enum(['BUY', 'SELL', 'HOLD']),
    mmThesis: z.string().min(20),
    smartMoneyFlow: z.enum(SMART_MONEY_FLOWS),
    liquidityDepthUsd: z.number().positive(),
    narrativeVelocity: z.number(),
    mtfBias: mtfBiasSchema,
    entryPrice: z.number().positive(),
    sizePct: z.number(),
    stopLossPct: z.number(),
    takeProfitPct: z.number(),
    detectedAtServerMs: z.number().int().nonnegative(),
  })
  .superRefine((signal, ctx) => {
    const confluence = evaluateConfluence(signal.mtfBias);
    if (!confluence.aligned && !confluence.pullbackEntry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `MTF confluence violated: weighted score ${(confluence.score * 100).toFixed(0)}% below ${(MTF_CONFLUENCE_THRESHOLD * 100).toFixed(0)}% (naked-indicator rejection)`,
        path: ['mtfBias'],
      });
    }
    if (signal.smartMoneyFlow === 'NEUTRAL' && signal.action !== 'HOLD') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'smart-money flow NEUTRAL cannot justify directional action',
        path: ['smartMoneyFlow'],
      });
    }
    if (
      (signal.smartMoneyFlow === 'ACCUMULATION' && signal.action === 'SELL') ||
      (signal.smartMoneyFlow === 'DISTRIBUTION' && signal.action === 'BUY')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'action contradicts institutional flow direction',
        path: ['action'],
      });
    }
    if (signal.stopLossPct > 0 || signal.stopLossPct < -15) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `data-driven stop loss out of sanity band (-15%, 0): received ${signal.stopLossPct}%`,
        path: ['stopLossPct'],
      });
    }
    if (signal.takeProfitPct <= 0 || signal.takeProfitPct > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `data-driven take profit out of sanity band (0, 30%): received ${signal.takeProfitPct}%`,
        path: ['takeProfitPct'],
      });
    }
  });

export type MMValidatedSignal = z.infer<typeof mmSignalSchema>;

export function isNakedIndicator(candidate: {
  mmThesis?: unknown;
  smartMoneyFlow?: unknown;
  liquidityDepthUsd?: unknown;
  mtfBias?: unknown;
}): boolean {
  return (
    typeof candidate.mmThesis !== 'string' ||
    candidate.mmThesis.length < 20 ||
    typeof candidate.smartMoneyFlow !== 'string' ||
    !SMART_MONEY_FLOWS.includes(candidate.smartMoneyFlow as never) ||
    typeof candidate.liquidityDepthUsd !== 'number' ||
    candidate.liquidityDepthUsd <= 0 ||
    typeof candidate.mtfBias !== 'object' ||
    candidate.mtfBias === null
  );
}

export type CompositeScoreInput = {
  smartMoneyFlow: SmartMoneyFlow;
  liquidityDepthUsd: number;
  narrativeVelocity: number;
};

export function computeCompositeScore(input: CompositeScoreInput): number {
  const flowScore = input.smartMoneyFlow === 'ACCUMULATION' ? 40 : input.smartMoneyFlow === 'DISTRIBUTION' ? 10 : 0;
  const liquidityScore = Math.min(30, input.liquidityDepthUsd / 50_000);
  const velocityScore = Math.min(30, Math.max(0, input.narrativeVelocity));
  return Math.round((flowScore + liquidityScore + velocityScore) * 100) / 100;
}