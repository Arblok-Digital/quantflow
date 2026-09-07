/**
 * Keel engine configuration — pure in-memory adaptation of Keel's
 * `src/config/risk-constants.ts`, `src/config/algo-config.ts` and
 * `src/services/macro/calendar.ts`. No env / PG / Redis dependencies.
 */

// ---------------------------------------------------------------------------
// Risk constants (Keel src/config/risk-constants.ts)
// ---------------------------------------------------------------------------
export const RISK_CONSTANTS = {
  MAX_OPEN_POSITIONS: 5,
  MAX_ORDERS_PER_HOUR: 10,
  MIN_POSITION_SIZE_PCT: 2.0,
  MAX_POSITION_SIZE_PCT: 5.0,
  STOP_LOSS_PCT: -2.0,
  TAKE_PROFIT_PCT: 4.0,
  MAX_DAILY_DRAWDOWN_PCT: 3.0,
  STALENESS_LIMIT_MS: 1500,
  RECONCILIATION_INTERVAL_MS: 15_000,
  KILL_SWITCH_DEADLINE_MS: 500,
  ORDER_TIMEOUT_MS: 5_000,
  TIME_SYNC_INTERVAL_MS: 30_000,
  DISCREPANCY_TOLERANCE_USD: 1.0,
  MTF_TIMEFRAMES: ['m15', 'h1', 'h4', 'd1'] as const,
  SYMBOL_COOLDOWN_MS: 60 * 60_000,
  MAX_REENTRY_PER_SYMBOL_PER_DAY: 3,
  SYMBOL_COOLDOWN_WINDOW_MS: 24 * 60 * 60_000,
} as const;

export const SPOT_ONLY_SCOPES = ['spot'] as const;
export const FORBIDDEN_KEY_SCOPES = [
  'withdrawal',
  'withdraw',
  'margin',
  'transfer',
  'futures',
  'leverage',
] as const;

// ---------------------------------------------------------------------------
// Algo config (Keel src/config/algo-config.ts)
// ---------------------------------------------------------------------------
export type TradingStrategy = 'SCALP' | 'SWING';

export interface ScalpConfig {
  imbalanceBuy: number; // bid/ask >1.15 => BUY
  imbalanceSell: number; // <0.85 => SELL
  spreadMaxPct: number; // skip if spread too wide
  atrFallbackPct: number; // 0.004 = 0.4% of mid
  riskPct: number; // 0.5% equity risk per trade
  rMultiple: number; // TP = 1.5 × SL distance (when no wall)
  minTpPct: number;
}

export interface SwingConfig {
  mtfWeights: { d1: number; h4: number; h1: number; m15: number };
  confluenceThreshold: number;
  minHoldBars: number;
  maxHoldDays: number;
  mlMinProb: number;
  mlShadowOnly: boolean;
  rMultiple: number;
  atrTf: 'h4' | 'd1';
}

export const ALGO_CONFIG: Record<TradingStrategy, ScalpConfig | SwingConfig> = {
  SCALP: {
    imbalanceBuy: 1.15,
    imbalanceSell: 0.85,
    spreadMaxPct: 0.15,
    atrFallbackPct: 0.004,
    riskPct: 0.5,
    rMultiple: 1.5,
    minTpPct: 0.9,
  } as ScalpConfig,
  SWING: {
    mtfWeights: { d1: 0.4, h4: 0.3, h1: 0.2, m15: 0.1 },
    confluenceThreshold: 0.7,
    minHoldBars: 6,
    maxHoldDays: 3,
    mlMinProb: 0.55,
    mlShadowOnly: true,
    rMultiple: 2.0,
    atrTf: 'h4',
  } as SwingConfig,
} as const;

export function isScalpCfg(c: ScalpConfig | SwingConfig): c is ScalpConfig {
  return (c as ScalpConfig).imbalanceBuy !== undefined;
}

// ---------------------------------------------------------------------------
// Macro calendar (Keel src/services/macro/calendar.ts) — seed schedule, pure.
// ---------------------------------------------------------------------------
export type EventType = 'NFP' | 'CPI' | 'FOMC' | 'PPI' | 'ECB' | 'GDP';
export type Impact = 'HIGH' | 'MEDIUM';
export interface MacroEvent {
  id: string;
  type: EventType;
  scheduledAtMs: number;
  impact: Impact;
  preMin: number;
  postMin: number;
  volPct: number;
  src: string;
}
export type RiskLevel = 'FLAT' | 'SIZE_DOWN' | 'NORMAL';
export interface Verdict {
  level: RiskLevel;
  mult: number;
  active: MacroEvent | null;
  next: MacroEvent | null;
  minsTo: number | null;
  minsSince: number | null;
  reason: string;
}

function seed(): MacroEvent[] {
  const r: Omit<MacroEvent, 'id'>[] = [
    { type: 'FOMC', scheduledAtMs: Date.UTC(2026, 0, 28, 19, 0), impact: 'HIGH', preMin: 90, postMin: 60, volPct: 3, src: 'seed' },
    { type: 'NFP', scheduledAtMs: Date.UTC(2026, 1, 6, 13, 30), impact: 'HIGH', preMin: 60, postMin: 45, volPct: 3, src: 'seed' },
    { type: 'CPI', scheduledAtMs: Date.UTC(2026, 1, 11, 13, 30), impact: 'HIGH', preMin: 60, postMin: 45, volPct: 2.5, src: 'seed' },
    { type: 'FOMC', scheduledAtMs: Date.UTC(2026, 2, 18, 18, 0), impact: 'HIGH', preMin: 90, postMin: 60, volPct: 3, src: 'seed' },
    { type: 'NFP', scheduledAtMs: Date.UTC(2026, 4, 8, 12, 30), impact: 'HIGH', preMin: 60, postMin: 45, volPct: 3, src: 'seed' },
    { type: 'FOMC', scheduledAtMs: Date.UTC(2026, 5, 17, 18, 0), impact: 'HIGH', preMin: 90, postMin: 60, volPct: 3, src: 'seed' },
    { type: 'FOMC', scheduledAtMs: Date.UTC(2026, 6, 29, 18, 0), impact: 'HIGH', preMin: 90, postMin: 60, volPct: 3, src: 'seed' },
    { type: 'FOMC', scheduledAtMs: Date.UTC(2026, 8, 16, 18, 0), impact: 'HIGH', preMin: 90, postMin: 60, volPct: 3, src: 'seed' },
    { type: 'NFP', scheduledAtMs: Date.UTC(2026, 8, 4, 12, 30), impact: 'HIGH', preMin: 60, postMin: 45, volPct: 3, src: 'seed' },
    { type: 'NFP', scheduledAtMs: Date.UTC(2026, 9, 2, 12, 30), impact: 'HIGH', preMin: 60, postMin: 45, volPct: 3, src: 'seed' },
    { type: 'FOMC', scheduledAtMs: Date.UTC(2026, 9, 28, 18, 0), impact: 'HIGH', preMin: 90, postMin: 60, volPct: 3, src: 'seed' },
    { type: 'NFP', scheduledAtMs: Date.UTC(2026, 10, 6, 13, 30), impact: 'HIGH', preMin: 60, postMin: 45, volPct: 3, src: 'seed' },
    { type: 'FOMC', scheduledAtMs: Date.UTC(2026, 11, 9, 18, 0), impact: 'HIGH', preMin: 90, postMin: 60, volPct: 3, src: 'seed' },
    { type: 'NFP', scheduledAtMs: Date.UTC(2026, 11, 4, 13, 30), impact: 'HIGH', preMin: 60, postMin: 45, volPct: 3, src: 'seed' },
  ];
  return r.map((e, i) => ({ ...e, id: `seed-${e.type}-${i}-${e.scheduledAtMs}` }));
}

let cal: MacroEvent[] = seed();
export function getCalendar(): readonly MacroEvent[] {
  return cal;
}
export function setCalendar(e: MacroEvent[]): void {
  cal = [...e].sort((a, b) => a.scheduledAtMs - b.scheduledAtMs);
}

export function sizeFor(a: number | null, b: number | null, ev: MacroEvent | null): { level: RiskLevel; mult: number } {
  if (!ev || (a === null && b === null)) return { level: 'NORMAL', mult: 1 };
  if (b !== null && b >= 0) {
    if (b <= 30) return { level: 'FLAT', mult: 0 };
    if (b <= ev.postMin) return { level: 'SIZE_DOWN', mult: 0.35 };
    return { level: 'NORMAL', mult: 1 };
  }
  if (a !== null && a >= 0) {
    if (a <= 15) return { level: 'FLAT', mult: 0 };
    if (a <= 30) return { level: 'SIZE_DOWN', mult: 0.35 };
    if (a <= 60) return { level: 'SIZE_DOWN', mult: 0.5 };
    if (a <= ev.preMin) return { level: 'SIZE_DOWN', mult: 0.65 };
  }
  return { level: 'NORMAL', mult: 1 };
}

export function nextEv(now: number): MacroEvent | null {
  for (const e of cal) if (e.scheduledAtMs > now) return e;
  return null;
}

export function bucket(now: number) {
  let act: MacroEvent | null = null;
  let mt: number | null = null;
  let ms: number | null = null;
  for (const e of cal) {
    const d = (e.scheduledAtMs - now) / 60000;
    if (d >= -e.postMin && d <= e.preMin) {
      act = e;
      if (d >= 0) mt = d;
      else ms = -d;
      break;
    }
  }
  const nxt = nextEv(now);
  const buck = act ?? nxt;
  const mtn = nxt ? (nxt.scheduledAtMs - now) / 60000 : null;
  return { active: act, next: buck, minsTo: mt ?? (act ? null : mtn), minsSince: ms };
}

export function evaluate(now: number): Verdict {
  const { active, next, minsTo, minsSince } = bucket(now);
  const b = active ?? next;
  const { level, mult } = sizeFor(minsTo, minsSince, b ?? null);
  let reason = 'NORMAL';
  if (active) reason = `${level} ${active.type} ${minsSince !== null ? minsSince.toFixed(0) + 'm post' : minsTo?.toFixed(0) + 'm pre'}`;
  else if (next && minsTo !== null && minsTo <= 90) reason = `${level} -> ${next.type} ${minsTo.toFixed(0)}m`;
  return { level, mult, active, next: b ?? null, minsTo, minsSince, reason };
}

export function evaluateAt(now: number): Verdict {
  return evaluate(now);
}
export function shouldFlat(now: number): boolean {
  return evaluate(now).level === 'FLAT';
}
export function mult(now: number): number {
  return evaluate(now).mult;
}