/**
 * In-memory persistence store — Keel PG-tables adapted to in-memory arrays.
 * Keeps the SAME column semantics (serverTime, stopLossPrice strings, etc.)
 * so gatekeeper / executor / kill-switch / audit logic ports near-verbatim.
 * No PG / Redis. Deterministic ids (crypto.randomUUID) + monotonically
 * increasing sequence for decision ids.
 */
import crypto from 'node:crypto';
import type { MMValidatedSignal, OrderStatus, Venue } from './types.js';
import { VENUES } from './types.js';

// ---------------------------------------------------------------------------
// Row shapes (mirror Keel db/schema.ts semantics, in-memory)
// ---------------------------------------------------------------------------
export interface RiskLimitsRow {
  id: string;
  maxOpenPositions: number;
  maxOrdersPerHour: number;
  maxDrawdownPct: number;
  minPositionSizePct: number;
  maxPositionSizePct: number;
  stopLossPct: number;
}

export type DecisionState = 'PENDING' | 'EXECUTED' | 'REJECTED' | 'FAILED' | 'CANCELLED';

export interface TradeDecisionRow {
  id: string;
  symbol: string;
  venue: Venue;
  action: 'BUY' | 'SELL' | 'HOLD';
  mmThesis: string;
  smartMoneyFlow: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  mtfBias: MMValidatedSignal['mtfBias'];
  liquidityDepthUsd: string;
  stopLossPct: string;
  takeProfitPct: string;
  sizePct: string;
  riskPassed: boolean;
  riskReasons: string[];
  terminalState: DecisionState;
  createdAt: number; // server ms
}

export interface DecisionTransitionRow {
  decisionId: string;
  fromState: DecisionState | null;
  toState: DecisionState;
  reason: string;
  actorId: string;
  serverTime: number;
}

export interface PositionRow {
  id: string;
  symbol: string;
  venue: Venue;
  decisionId: string;
  orderId: string;
  sizePct: string;
  entryPrice: string;
  stopLossPrice: string;
  takeProfitPrice: string;
  currentPnlPct: string | null;
  isOpen: boolean;
  createdAt: number;
  updatedAt: number | null;
}

export interface OrderRow {
  id: string;
  clientOrderId: string;
  decisionId: string;
  venue: Venue;
  symbol: string;
  side: 'BUY' | 'SELL';
  requestedQty: string;
  executedQty: string | null;
  avgFillPrice: string | null;
  externalRef: string | null;
  status: OrderStatus;
  orderRole: 'ENTRY' | 'OCO_SL' | 'OCO_TP' | null;
  ocoListId: string | null;
  stopPrice: string | null;
  serverTime: number;
  updatedAt: number | null;
}

export interface KillSwitchEventRow {
  id: string;
  triggeredBy: string;
  reason: string;
  isActive: boolean;
  createdAt: number;
}

export interface AuditRow {
  id: string;
  prevHash: string | null;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  diff: Record<string, unknown> | null;
  createdAt: number;
  hash: string;
}

export interface OutcomeRow {
  decisionId: string;
  symbol: string;
  outcome: 'TP' | 'SL' | 'TIMEOUT' | 'KILL';
  pnlPct: number;
  rMultiple: number;
  bucket: string | null;
  closedAt: number;
}

export interface FeatureRawRow {
  decisionId: string;
  raw: Record<string, unknown> | null;
  outcome: string | null;
}

let seq = 0;
function safeRandomHex(): string {
  // crypto.randomUUID hanya tersedia di secure-context (https/localhost modern)
  // atau Node ≥14.17. Di browser non-secure / HTTP lama bisa undefined → fallback.
  try {
    const g = globalThis.crypto as Crypto | undefined;
    if (g?.randomUUID) return g.randomUUID().slice(0, 8);
  } catch { /* fallthrough */ }
  return Math.random().toString(36).slice(2, 10);
}
export function nextId(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${safeRandomHex()}`;
}

function defaultRiskLimits(): RiskLimitsRow {
  return {
    id: nextId(),
    maxOpenPositions: 5,
    maxOrdersPerHour: 10,
    maxDrawdownPct: 3.0,
    minPositionSizePct: 2.0,
    maxPositionSizePct: 5.0,
    stopLossPct: -2.0,
  };
}

class InMemoryStore {
  riskLimits: RiskLimitsRow = defaultRiskLimits();
  orders: OrderRow[] = [];
  positions: PositionRow[] = [];
  tradeDecisions: TradeDecisionRow[] = [];
  decisionTransitions: DecisionTransitionRow[] = [];
  killSwitchEvents: KillSwitchEventRow[] = [];
  auditLogs: AuditRow[] = [];
  outcomes: OutcomeRow[] = [];
  featureRows: FeatureRawRow[] = [];
  tradingMode: 'PAPER' | 'LIVE' = 'PAPER';

  reset(): void {
    this.riskLimits = defaultRiskLimits();
    this.orders = [];
    this.positions = [];
    this.tradeDecisions = [];
    this.decisionTransitions = [];
    this.killSwitchEvents = [];
    this.auditLogs = [];
    this.outcomes = [];
    this.featureRows = [];
    this.tradingMode = 'PAPER';
  }
}

export const store = new InMemoryStore();

// ---------------------------------------------------------------------------
// Convenience queries (mirror gatekeeper/executor PG selects)
// ---------------------------------------------------------------------------
export type QueryTx = { isolation?: 'read' };

/** Mirrors executor `withActorContext(tx => ...)` — single-threaded in-memory, so a
 *  "transaction" is a synchronous callback over the shared store. */
export function withActorContext<T>(_actorId: string, fn: () => T): T {
  return fn();
}

export function openPositions(): PositionRow[] {
  return store.positions.filter((p) => p.isOpen);
}

export function openPositionForSymbol(symbol: string): PositionRow | undefined {
  const normalized = symbol.toUpperCase();
  return store.positions.find((p) => p.isOpen && p.symbol.toUpperCase() === normalized);
}

export function ordersLastHour(serverNowMs: number): OrderRow[] {
  return store.orders.filter((o) => o.serverTime >= serverNowMs - 3_600_000);
}

export function ordersForDecision(decisionId: string): OrderRow[] {
  return store.orders.filter((o) => o.decisionId === decisionId);
}

export function decisionsForSymbol(symbol: string): TradeDecisionRow[] {
  const normalized = symbol.toUpperCase();
  return store.tradeDecisions.filter((d) => d.symbol.toUpperCase() === normalized).sort((a, b) => b.createdAt - a.createdAt);
}

export function lastKillSwitchEvent(): KillSwitchEventRow | undefined {
  return store.killSwitchEvents.at(-1);
}

export function insertDecision(row: Omit<TradeDecisionRow, 'id' | 'createdAt'>): TradeDecisionRow {
  const full: TradeDecisionRow = { ...row, id: nextId(), createdAt: Date.now() };
  store.tradeDecisions.push(full);
  return full;
}

export function insertOrder(row: Omit<OrderRow, 'id'>): OrderRow {
  const full: OrderRow = { ...row, id: nextId() };
  store.orders.push(full);
  return full;
}

export function insertPosition(row: Omit<PositionRow, 'id'>): PositionRow {
  const full: PositionRow = { ...row, id: nextId() };
  store.positions.push(full);
  return full;
}

export function venusIncludes(v: unknown): v is Venue {
  return (VENUES as readonly string[]).includes(v as string);
}