/**
 * Confluence matrix — Keel `src/services/mm-brain/confluence-matrix.ts` port.
 */
import type { MtfVector } from '../types.js';

export interface ConfluenceVerdict {
  aligned: boolean;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number;
  disagreeingFrames: string[];
  weightBreakdown: Record<string, number>;
  pullbackEntry: boolean;
}

export const MTF_WEIGHTS: Record<keyof MtfVector, number> = {
  d1: 0.4,
  h4: 0.3,
  h1: 0.2,
  m15: 0.1,
};
export const MTF_WEIGHTS_SWING: Record<keyof MtfVector, number> = {
  h4: 0.45,
  d1: 0.2,
  h1: 0.25,
  m15: 0.1,
};

export const MTF_CONFLUENCE_THRESHOLD = 0.7;

export function evaluateConfluence(bias: MtfVector, strategy: 'SCALP' | 'SWING' = 'SCALP'): ConfluenceVerdict {
  const weights = strategy === 'SWING' ? MTF_WEIGHTS_SWING : MTF_WEIGHTS;
  const scores: Record<keyof MtfVector, number> = {
    d1: 0,
    h4: 0,
    h1: 0,
    m15: 0,
  };
  for (const tf of Object.keys(weights) as (keyof MtfVector)[]) {
    scores[tf] = bias[tf] === 'BULLISH' ? weights[tf] : bias[tf] === 'BEARISH' ? -weights[tf] : 0;
  }

  const disagreeing = (['m15', 'h1', 'h4', 'd1'] as const).filter((tf) => bias[tf] !== bias.d1);

  const bullScore = scores.d1 + scores.h4 + scores.h1 + scores.m15;
  const direction = bullScore > 0 ? 'BULLISH' : bullScore < 0 ? 'BEARISH' : 'NEUTRAL';
  const score = Math.round(Math.abs(bullScore) * 100) / 100;
  const aligned = score >= MTF_CONFLUENCE_THRESHOLD;

  let pullbackEntry = false;
  if (direction !== 'NEUTRAL' && bias.m15 !== 'NEUTRAL' && bias.m15 !== direction) {
    const primaryWeight = scores.d1 + scores.h4;
    if (primaryWeight >= 0.6) pullbackEntry = true;
  }

  return {
    aligned,
    direction,
    score,
    disagreeingFrames: disagreeing,
    weightBreakdown: scores,
    pullbackEntry,
  };
}

export function directionalAction(direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): 'BUY' | 'SELL' | 'HOLD' {
  if (direction === 'BULLISH') return 'BUY';
  if (direction === 'BEARISH') return 'SELL';
  return 'HOLD';
}