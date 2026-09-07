/**
 * Feature pack — Keel `src/services/features/feature-pack.ts` port.
 * Aggregates orderflow + yields + sentiment + macro + session into one ML pack.
 * `evaluate` (macro) here takes `now` as first arg (pure adaptation).
 */
import type { NormalizedDepth } from '../types.js';
import { extractOrderFlow } from './orderflow.js';
import { getYieldSnapshot, realYieldFeature } from './yields.js';
import { getSentimentSnapshot, sentimentFeature } from './sentiment.js';
import { evaluate as evalMacro } from '../config.js';
import { classifySession } from '../ingestion/session-filter.js';
import { timeService } from '../time-sync.js';

export interface MlFeaturePack {
  at: number;
  orderflow: ReturnType<typeof extractOrderFlow>;
  yields: { realFeat: number | null; raw: ReturnType<typeof getYieldSnapshot> };
  sentiment: { feat: number | null; raw: ReturnType<typeof getSentimentSnapshot> };
  macro: ReturnType<typeof evalMacro>;
  session: ReturnType<typeof classifySession>;
  execMult: number;
  trainAllowed: boolean;
}

const EMPTY_ORDERFLOW: ReturnType<typeof extractOrderFlow> = {
  bidDepth1pctUsd: 0,
  askDepth1pctUsd: 0,
  imbalance: 1,
  spreadPct: 0,
  spreadBps: 0,
  bidWallPrice: null,
  bidWallUsd: 0,
  askWallPrice: null,
  askWallUsd: 0,
  liqLevels: [],
  densityScore: 0,
};

export function buildFeaturePack(depth: NormalizedDepth | null, now: number = timeService.now()): MlFeaturePack {
  const of = depth ? extractOrderFlow(depth) : EMPTY_ORDERFLOW;
  const yRaw = getYieldSnapshot();
  const yFeat = realYieldFeature(yRaw.real10y);
  const sRaw = getSentimentSnapshot();
  const sFeat = sentimentFeature(sRaw.value);
  const macro = evalMacro(now);
  const sess = classifySession(now);
  const execMult = Math.min(macro.mult, sess.execMult);
  const trainAllowed = sess.trainAllowed && macro.level !== 'FLAT';
  return { at: now, orderflow: of, yields: { realFeat: yFeat, raw: yRaw }, sentiment: { feat: sFeat, raw: sRaw }, macro, session: sess, execMult, trainAllowed };
}