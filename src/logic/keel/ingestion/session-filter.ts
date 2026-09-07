/**
 * Session filter — Keel `src/services/ingestion/session-filter.ts` port.
 * Pure; weekend policy defaults to FILTER_TRAINING (no env dependency).
 */
import { timeService } from '../time-sync.js';

export type SessionKind = 'WEEKEND_THIN' | 'NY' | 'LONDON' | 'ASIA' | 'WEEKDAY_OFF';
export interface SessionVerdict {
  kind: SessionKind;
  isWeekend: boolean;
  trainAllowed: boolean;
  execMult: number;
  reason: string;
}

export type WeekendPolicy = 'FILTER_TRAINING' | 'SIZE_DOWN_ONLY' | 'BLOCK_WEEKEND';
export const DEFAULT_WEEKEND_POLICY: WeekendPolicy = 'FILTER_TRAINING';

function isWeekendUtc(d: Date): boolean {
  const wd = d.getUTCDay();
  return wd === 0 || wd === 6;
}

export function classifySession(atMs: number = timeService.now(), weekendPolicy: WeekendPolicy | undefined = undefined): SessionVerdict {
  const weekendPolicyEff = weekendPolicy ?? DEFAULT_WEEKEND_POLICY;
  const d = new Date(atMs);
  const hr = d.getUTCHours();
  const weekend = isWeekendUtc(d);
  if (weekend) {
    if (weekendPolicyEff === 'BLOCK_WEEKEND') return { kind: 'WEEKEND_THIN', isWeekend: true, trainAllowed: false, execMult: 0, reason: 'weekend flat — thin liquidity (FILTER_TRAINING=BLOCK)' };
    if (weekendPolicyEff === 'SIZE_DOWN_ONLY') return { kind: 'WEEKEND_THIN', isWeekend: true, trainAllowed: true, execMult: 0.45, reason: 'weekend size-down 55% — thin orderbook' };
    return { kind: 'WEEKEND_THIN', isWeekend: true, trainAllowed: false, execMult: 0.55, reason: 'weekend: snapshot not representative — training filtered, exec 45% size-down' };
  }
  if (hr >= 13 && hr < 21) return { kind: 'NY', isWeekend: false, trainAllowed: true, execMult: 1, reason: 'NY session (high liquidity)' };
  if (hr >= 7 && hr < 16) return { kind: 'LONDON', isWeekend: false, trainAllowed: true, execMult: 1, reason: 'London session' };
  if (hr >= 0 && hr < 9) return { kind: 'ASIA', isWeekend: false, trainAllowed: true, execMult: 0.9, reason: 'Asia session — mildly thinner' };
  return { kind: 'WEEKDAY_OFF', isWeekend: false, trainAllowed: true, execMult: 0.9, reason: 'off-hours weekday' };
}

export function shouldTrainAt(atMs: number = timeService.now()): boolean {
  return classifySession(atMs).trainAllowed;
}
export function execMultAt(atMs: number = timeService.now()): number {
  return classifySession(atMs).execMult;
}