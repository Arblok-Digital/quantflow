/**
 * Absorption engine — Keel `src/services/mm-brain/absorption-engine.ts` port.
 */
export interface AbsorptionInput {
  priceChangePct: number;
  netTakerBuyUsd: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  tradeCount: number;
}

export interface AbsorptionVerdict {
  score: number;
  classification: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
  isPreBreakoutAccumulation: boolean;
}

const ACCUMULATION_SCORE_THRESHOLD = 75;
const ACCUMULATION_PRICE_RANGE_PCT = 1.0;
const MIN_TRADE_COUNT = 5;

export function computeAbsorptionScore(input: AbsorptionInput): number {
  const priceRangePct = Math.abs(input.priceChangePct);
  const totalNotional = Math.abs(input.buyNotionalUsd) + Math.abs(input.sellNotionalUsd);
  if (totalNotional <= 0) return 0;
  const flowRatio = Math.abs(input.netTakerBuyUsd) / totalNotional;
  const logMag = Math.max(0, Math.min(1, (Math.log10(Math.max(10, totalNotional)) - 3) / 3));
  const flatness = 1 / (1 + priceRangePct * 2.5);
  const k = tradeCountFactor(input.tradeCount);
  const blended = flowRatio * 100 * (0.55 + 0.45 * flatness) + logMag * 32;
  const asymBonus = flowRatio >= 0.48 ? 8 : 0;
  return Math.min(100, (blended + asymBonus) * k);
}

function tradeCountFactor(tradeCount: number): number {
  if (tradeCount <= 0) return 0;
  if (tradeCount < MIN_TRADE_COUNT) return tradeCount / MIN_TRADE_COUNT;
  return 1;
}

export function classifyAbsorption(input: AbsorptionInput): AbsorptionVerdict {
  const score = computeAbsorptionScore(input);
  const flatPrice = Math.abs(input.priceChangePct) < ACCUMULATION_PRICE_RANGE_PCT;
  const hasTrades = input.tradeCount >= MIN_TRADE_COUNT;

  if (score > ACCUMULATION_SCORE_THRESHOLD && flatPrice && hasTrades && input.netTakerBuyUsd > 0) {
    return { score: Math.round(score), classification: 'ACCUMULATION', isPreBreakoutAccumulation: true };
  }
  if (score > ACCUMULATION_SCORE_THRESHOLD && flatPrice && hasTrades && input.netTakerBuyUsd < 0) {
    return { score: Math.round(score), classification: 'DISTRIBUTION', isPreBreakoutAccumulation: false };
  }
  return { score: Math.round(score), classification: 'NEUTRAL', isPreBreakoutAccumulation: false };
}