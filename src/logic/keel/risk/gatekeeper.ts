/**
 * Risk gatekeeper — Keel `src/services/risk/gatekeeper.ts` port.
 * 11 hard gates: spot-only venue, max open positions (5), order rate (10/hr),
 * position size band (2-5%), stop-loss protection, daily drawdown (3%),
 * kill switch, symbol one-position, symbol cooldown, max reentry/day,
 * HOLD-no-action; plus macro-event-flat and weekend-liquidity-flat guards.
 * PG selects adapted to the in-memory store.
 */
import type { MMValidatedSignal } from '../types.js';
import { VENUES } from '../types.js';
import { RISK_CONSTANTS } from '../config.js';
import { timeService } from '../time-sync.js';
import { evaluate as evaluateMacro } from '../config.js';
import { classifySession } from '../ingestion/session-filter.js';
import {
  store,
  decisionsForSymbol,
  insertDecision,
  lastKillSwitchEvent,
  openPositionForSymbol,
  openPositions,
  ordersLastHour,
  type QueryTx,
} from '../store.js';

export interface RiskLimitsView {
  maxOpenPositions: number;
  maxOrdersPerHour: number;
  maxDrawdownPct: number;
  minPositionSizePct: number;
  maxPositionSizePct: number;
  stopLossPct: number;
}

export interface RiskSnapshot {
  openPositions: number;
  ordersLastHour: number;
  dailyDrawdownPct: number | null;
  killSwitchActive: boolean;
}

export interface RiskCandidate {
  venue: (typeof VENUES)[number];
  action: 'BUY' | 'SELL' | 'HOLD';
  sizePct: number;
  stopLossPct: number;
}

export interface RiskEvaluation {
  passed: boolean;
  reasons: string[];
}

export const RISK_REASONS = {
  SPOT_ONLY_VIOLATION: 'SPOT_ONLY_VIOLATION',
  MAX_OPEN_POSITIONS: 'MAX_OPEN_POSITIONS',
  ORDER_RATE_LIMIT: 'ORDER_RATE_LIMIT',
  POSITION_SIZE_OUT_OF_BAND: 'POSITION_SIZE_OUT_OF_BAND',
  NO_STOP_LOSS_PROTECTION: 'NO_STOP_LOSS_PROTECTION',
  DAILY_DRAWDOWN_BREACH: 'DAILY_DRAWDOWN_BREACH',
  KILL_SWITCH_ENGAGED: 'KILL_SWITCH_ENGAGED',
  SYMBOL_POSITION_OPEN: 'SYMBOL_POSITION_OPEN',
  SYMBOL_COOLDOWN: 'SYMBOL_COOLDOWN',
  MAX_REENTRY_PER_SYMBOL_PER_DAY: 'MAX_REENTRY_PER_SYMBOL_PER_DAY',
  HOLD_NO_ACTION: 'HOLD_NO_ACTION',
  MACRO_EVENT_FLAT: 'MACRO_EVENT_FLAT',
  WEEKEND_LIQUIDITY_FLAT: 'WEEKEND_LIQUIDITY_FLAT',
} as const;

export function evaluateRisk(
  candidate: RiskCandidate,
  snapshot: RiskSnapshot,
  limits: RiskLimitsView,
): RiskEvaluation {
  const reasons: string[] = [];

  if (!VENUES.includes(candidate.venue)) {
    reasons.push(RISK_REASONS.SPOT_ONLY_VIOLATION);
  }

  if (candidate.action !== 'HOLD') {
    if (snapshot.killSwitchActive) {
      reasons.push(RISK_REASONS.KILL_SWITCH_ENGAGED);
    }
    if (snapshot.dailyDrawdownPct !== null && snapshot.dailyDrawdownPct >= limits.maxDrawdownPct) {
      reasons.push(RISK_REASONS.DAILY_DRAWDOWN_BREACH);
    }
    if (candidate.action === 'BUY' && snapshot.openPositions + 1 > limits.maxOpenPositions) {
      reasons.push(RISK_REASONS.MAX_OPEN_POSITIONS);
    }
    if (candidate.action === 'BUY' && snapshot.ordersLastHour + 1 > limits.maxOrdersPerHour) {
      reasons.push(RISK_REASONS.ORDER_RATE_LIMIT);
    }
    if (
      candidate.action === 'BUY' &&
      (candidate.sizePct < limits.minPositionSizePct || candidate.sizePct > limits.maxPositionSizePct)
    ) {
      reasons.push(RISK_REASONS.POSITION_SIZE_OUT_OF_BAND);
    }
    if (candidate.stopLossPct >= 0) {
      reasons.push(RISK_REASONS.NO_STOP_LOSS_PROTECTION);
    }
  }

  return { passed: reasons.length === 0, reasons };
}

export function loadRiskLimits(_tx?: QueryTx): RiskLimitsView & { id: string } {
  return { ...store.riskLimits };
}

export function collectSnapshot(
  _tx: QueryTx | undefined,
  serverNowMs: number,
  drawdownPct: number | null,
  killSwitchActive: boolean,
): RiskSnapshot {
  return {
    openPositions: openPositions().length,
    ordersLastHour: ordersLastHour(serverNowMs).length,
    dailyDrawdownPct: drawdownPct,
    killSwitchActive,
  };
}

export async function symbolGuard(
  _tx: QueryTx | undefined,
  signal: MMValidatedSignal,
  serverNowMs: number,
  cooldownMs: number = RISK_CONSTANTS.SYMBOL_COOLDOWN_MS,
  maxReentryPerDay: number = RISK_CONSTANTS.MAX_REENTRY_PER_SYMBOL_PER_DAY,
  windowMs: number = RISK_CONSTANTS.SYMBOL_COOLDOWN_WINDOW_MS,
): Promise<{ blocked: boolean; reasons: string[] }> {
  const normalized = signal.symbol.toUpperCase();
  if (signal.action !== 'BUY') return { blocked: false, reasons: [] };
  const reasons: string[] = [];

  const openForSymbol = openPositionForSymbol(normalized);
  if (openForSymbol) {
    reasons.push(`${RISK_REASONS.SYMBOL_POSITION_OPEN}:${normalized}`);
    return { blocked: true, reasons };
  }

  const lastDecision = decisionsForSymbol(normalized)[0];
  if (lastDecision) {
    const ageMs = serverNowMs - lastDecision.createdAt;
    if (ageMs >= 0 && ageMs < cooldownMs) {
      reasons.push(`${RISK_REASONS.SYMBOL_COOLDOWN}:${normalized}:${Math.round(ageMs)}`);
      return { blocked: true, reasons };
    }
  }

  const windowStart = serverNowMs - windowMs;
  const reentries = decisionsForSymbol(normalized).filter((d) => d.createdAt >= windowStart).length;
  if (reentries >= maxReentryPerDay) {
    reasons.push(`${RISK_REASONS.MAX_REENTRY_PER_SYMBOL_PER_DAY}:${normalized}`);
    return { blocked: true, reasons };
  }

  return { blocked: false, reasons: [] };
}

function signalToCandidate(signal: MMValidatedSignal): RiskCandidate {
  return {
    venue: signal.venue,
    action: signal.action,
    sizePct: signal.sizePct,
    stopLossPct: signal.stopLossPct,
  };
}

export interface ReserveResult {
  decisionId: string;
  passed: boolean;
  reasons: string[];
  limitsId: string;
}

export async function reserveAndPersistDecision(
  _tx: QueryTx | undefined,
  signal: MMValidatedSignal,
  actorId: string,
  snapshot: Pick<RiskSnapshot, 'dailyDrawdownPct' | 'killSwitchActive'>,
): Promise<ReserveResult> {
  const isHoldNoAction = signal.action === 'HOLD';
  const limits = loadRiskLimits(_tx);
  const serverNow = Math.trunc(timeService.now());
  const resolvedDrawdown = snapshot.dailyDrawdownPct ?? 0;
  const partial = collectSnapshot(_tx, serverNow, resolvedDrawdown, snapshot.killSwitchActive);
  let guardReasons: string[] = [];
  if (!isHoldNoAction) {
    const mv = evaluateMacro(serverNow);
    if (mv.level === 'FLAT') guardReasons.push(`${RISK_REASONS.MACRO_EVENT_FLAT}:${mv.active?.type ?? mv.next?.type ?? 'UNKNOWN'}:${mv.reason}`);
    const sv = classifySession(serverNow);
    if (sv.kind === 'WEEKEND_THIN' && sv.execMult === 0) guardReasons.push(`${RISK_REASONS.WEEKEND_LIQUIDITY_FLAT}:${sv.reason}`);
    if (!guardReasons.length && signal.action === 'BUY') {
      const guard = await symbolGuard(_tx, signal, serverNow);
      if (guard.blocked) guardReasons = [...guard.reasons];
    }
  }
  const evaluation = isHoldNoAction
    ? { passed: false, reasons: [RISK_REASONS.HOLD_NO_ACTION] as string[] }
    : guardReasons.length > 0
      ? { passed: false, reasons: guardReasons }
      : evaluateRisk(signalToCandidate(signal), partial, limits);

  const decision = insertDecision({
    symbol: signal.symbol,
    venue: signal.venue,
    action: signal.action,
    mmThesis: signal.mmThesis,
    smartMoneyFlow: signal.smartMoneyFlow,
    mtfBias: signal.mtfBias,
    liquidityDepthUsd: String(signal.liquidityDepthUsd),
    stopLossPct: String(signal.stopLossPct),
    takeProfitPct: String(signal.takeProfitPct),
    sizePct: String(signal.sizePct),
    riskPassed: evaluation.passed,
    riskReasons: evaluation.reasons,
    terminalState: isHoldNoAction ? 'REJECTED' : 'PENDING',
  });
  if (!decision) throw new Error('decision insert failed');

  store.decisionTransitions.push({
    decisionId: decision.id,
    fromState: null,
    toState: isHoldNoAction ? 'REJECTED' : 'PENDING',
    reason: evaluation.passed ? 'risk gates passed' : evaluation.reasons.join(';'),
    actorId,
    serverTime: Math.trunc(timeService.now()),
  });

  return { decisionId: decision.id, passed: evaluation.passed, reasons: evaluation.reasons, limitsId: limits.id };
}