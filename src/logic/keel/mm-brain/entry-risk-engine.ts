/**
 * Entry / risk engine — Keel `src/services/mm-brain/entry-risk-engine.ts` port.
 * Derives entry / SL / TP / size from the live book + volatility (tick or H4 ATR).
 * Size is risk-targeted (F2): SL distance × notional ≤ budget.maxRiskPct,
 * di-cap notional maksimum — BUKAN lagi band 2..5%.
 */
import type { NormalizedDepth, NormalizedTrade } from '../types.js';
import { RISK_CONSTANTS } from '../config.js';
import { riskTargetedSizePct } from '../../positionSizing.js';

export interface MarketContext {
  depth: NormalizedDepth;
  trades: NormalizedTrade[];
}

export interface TradeDirection {
  action: 'BUY' | 'SELL' | 'HOLD';
}

export interface DerivedLevels {
  action: 'BUY' | 'SELL' | 'HOLD';
  entryPrice: number;
  stopLossPct: number;
  takeProfitPct: number;
  sizePct: number;
  volatilityPct: number;
  stopAbs: number;
  targetAbs: number;
  reason: string;
}

export interface RiskBudget {
  maxRiskPct: number; // % of equity risked on the stop (e.g. 0.5% -> used for sizing)
  /**
   * F2: cap notional (% equity). Default RISK_CONSTANTS.MAX_POSITION_SIZE_PCT.
   * Satuan sizing resmi = % equity sebagai NOTIONAL (bukan margin).
   */
  maxNotionalPct?: number;
  rewardRatio: number; // TP distance / SL distance
  volatilityWindowMs: number; // look-back for volatility estimate (SCALP)
  atrPct?: number | null; // e.g. 0.018 = 1.8% (H4 ATR / mid)
  atrSource?: string; // 'h4' | 'tick' for reason string
  executionMultiplier?: number;
  /** R:R minimum saat TP diambil dari wall (bukan rMultiple). Default 1.5. */
  minRewardRatio?: number;
}

const DEFAULT_BUDGET: RiskBudget = {
  maxRiskPct: 0.5,
  rewardRatio: 1.5,
  volatilityWindowMs: 30_000,
  minRewardRatio: 1.5,
};

/**
 * F1/P0 (audit) — lantai jarak SL.
 *
 * Sebelumnya lantai stop = 0.75 × volatilitas tick-30s saja, sehingga di pasar
 * tenang SL bisa 0.08% dari entry (observed di trading.db: SL 76743.75 pada entry
 * 76805.20 = 0.08%). SL setipis itu berada DI DALAM noise 1 menit BTC (±20-40 bps)
 * dan di bawah biaya bolak-balik (2 × 4 bps taker), jadi stop kena oleh gerakan
 * acak, bukan oleh thesis. Lantai absolut 0.35% + penskalaan terhadap spread
 * membuat jarak stop selalu melebihi noise + biaya.
 */
export const MIN_STOP_DISTANCE_PCT = 0.0035;
/** Lantai SL ikut menskala spread book nyata (8× spread) untuk instrumen tipis. */
export const MIN_STOP_SPREAD_MULT = 8;
/** R:R minimum saat TP diambil dari wall liqudity (bukan rMultiple). */
export const DEFAULT_MIN_REWARD_RATIO = 1.5;

export function estimateVolatilityPct(trades: NormalizedTrade[], windowMs: number): number | null {
  const now = trades.length ? Math.max(...trades.map((t) => t.tsServerMs)) : 0;
  const window = trades.filter((t) => now - t.tsServerMs <= windowMs);
  if (window.length < 5) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const t of window) {
    if (t.price > high) high = t.price;
    if (t.price < low) low = t.price;
  }
  const mid = (high + low) / 2;
  if (mid <= 0) return null;
  return (high - low) / mid;
}

export function largestLevel(levels: Array<{ price: number; qty: number }>): { price: number; notionalUsd: number } | null {
  let best: { price: number; notionalUsd: number } | null = null;
  for (const l of levels) {
    const notional = l.price * l.qty;
    if (!best || notional > best.notionalUsd) best = { price: l.price, notionalUsd: notional };
  }
  return best;
}

export function deriveEntryStopTarget(ctx: MarketContext, direction?: TradeDirection, budget: RiskBudget = DEFAULT_BUDGET): DerivedLevels {
  const { depth, trades } = ctx;
  const bestBid = depth.bids[0]?.price ?? null;
  const bestAsk = depth.asks[0]?.price ?? null;
  if (!bestBid || !bestAsk) {
    return { action: 'HOLD', entryPrice: 0, stopLossPct: -2, takeProfitPct: 4, sizePct: 3, volatilityPct: 0, stopAbs: 0, targetAbs: 0, reason: 'no touchable book' };
  }
  const mid = (bestBid + bestAsk) / 2;

  const atrUsed = budget.atrPct != null && budget.atrPct > 0;
  const volPct = atrUsed ? budget.atrPct! : estimateVolatilityPct(trades, budget.volatilityWindowMs);
  const volatility = volPct ?? 0.004;

  const bidWall = largestLevel(depth.bids);
  const askWall = largestLevel(depth.asks);

  const action = direction?.action ?? (bestAsk > mid ? 'BUY' : bestBid < mid ? 'SELL' : 'HOLD');
  if (action === 'HOLD') {
    return { action: 'HOLD', entryPrice: mid, stopLossPct: -2, takeProfitPct: 4, sizePct: 3, volatilityPct: Number((volatility * 100).toFixed(2)), stopAbs: mid, targetAbs: mid, reason: 'no directional edge' };
  }

  const entry = action === 'BUY' ? bestAsk : bestBid;
  const volLabel = atrUsed ? `H4-ATR ${budget.atrSource || 'h4'}` : 'tick-30s';

  // F1/P0: lantai jarak SL = max(0.75×vol, lantai absolut 0.35%, 8× spread book).
  // Lantai lama (0.75×vol tick-30s) membiarkan SL 0.08% lolos → stop di dalam
  // noise + di bawah biaya bolak-balik (lihat MIN_STOP_DISTANCE_PCT).
  const spreadPct = mid > 0 ? Math.abs(bestAsk - bestBid) / mid : 0;
  const minStopPct = Math.max(MIN_STOP_DISTANCE_PCT, spreadPct * MIN_STOP_SPREAD_MULT);
  const minRewardRatio = budget.minRewardRatio ?? DEFAULT_MIN_REWARD_RATIO;
  const volStopFloor = Math.max(volatility * 0.75, minStopPct);
  let stopAbs: number;
  let stopRationale: string;
  // Wall dipakai sebagai SL HANYA bila jaraknya sudah lebih LEBAR dari LANTAI
  // (minStopPct, bukan setengah lantai). Untuk BUY, harga stop yang lebih KECIL
  // = lebih jauh dari entry. Jadi wall valid bila stopFromStructure <= minAllow;
  // bila wall lebih dekat (>) → fallback vol.
  if (action === 'BUY') {
    const support = bidWall && bidWall.price < entry ? bidWall.price : null;
    const stopFromStructure = support ? entry - (entry - support) : null;
    const stopFromVol = entry * (1 - volStopFloor);
    const minAllow = entry * (1 - minStopPct);
    if (support && stopFromStructure! <= minAllow) {
      stopAbs = stopFromStructure!;
      stopRationale = `below structure support @${support.toFixed(depthPrecision(entry))}`;
    } else {
      stopAbs = stopFromVol;
      stopRationale = `0.75×${volLabel}(${(volatility * 100).toFixed(2)}%) below entry`;
    }
  } else {
    // SELL simetris: stop yang lebih BESAR = lebih jauh dari entry.
    // Wall valid bila stopFromStructure >= minAllow.
    const resist = askWall && askWall.price > entry ? askWall.price : null;
    const stopFromStructure = resist ? entry + (resist - entry) : null;
    const stopFromVol = entry * (1 + volStopFloor);
    const minAllow = entry * (1 + minStopPct);
    if (resist && stopFromStructure! >= minAllow) {
      stopAbs = stopFromStructure!;
      stopRationale = `above structure resistance @${resist.toFixed(depthPrecision(entry))}`;
    } else {
      stopAbs = stopFromVol;
      stopRationale = `0.75×${volLabel}(${(volatility * 100).toFixed(2)}%) above entry`;
    }
  }

  const stopDistance = Math.abs(entry - stopAbs);
  const stopLossPct = entry > 0 ? -((stopDistance / entry) * 100) : -2;

  let targetAbs: number;
  let tpRationale: string;
  const rewardDistance = stopDistance * budget.rewardRatio;
  // F1/P0: TP dari wall HANYA dipakai bila memenuhi R:R minimum
  // (≥ stopDistance × minRewardRatio). Ambang lama `rewardDistance × 0.6`
  // = 0.9 × jarak SL → TP lebih dekat dari SL; observed R:R 1.28 di DB
  // (policy minimum 1.8) adalah hasil langsung dari celah ini.
  const minTpDistance = stopDistance * minRewardRatio;
  if (action === 'BUY') {
    const wallTp = askWall && askWall.price > entry ? askWall.price : null;
    if (wallTp && wallTp - entry >= minTpDistance) {
      targetAbs = wallTp;
      tpRationale = `at ask wall @${wallTp.toFixed(depthPrecision(entry))}`;
    } else {
      targetAbs = entry + rewardDistance;
      tpRationale = `${budget.rewardRatio}×SL distance`;
    }
  } else {
    const wallTp = bidWall && bidWall.price < entry ? bidWall.price : null;
    if (wallTp && entry - wallTp >= minTpDistance) {
      targetAbs = wallTp;
      tpRationale = `at bid wall @${wallTp.toFixed(depthPrecision(entry))}`;
    } else {
      targetAbs = entry - rewardDistance;
      tpRationale = `${budget.rewardRatio}×SL distance`;
    }
  }
  const takeProfitPct = entry > 0 ? ((targetAbs - entry) / entry) * 100 : 4;

  // F2 (sizing satu satuan): size = risk-targeted dalam SATUAN TUNGGAL
  // "% equity sebagai NOTIONAL" — risiko riil (jarak SL × notional) ≤
  // budget.maxRiskPct, di-cap notional maksimum. Band lama 2–5% MEMBATALKAN
  // sizing berbasis risiko: untuk SL < 10% raw > 5% → SELALU dipaksa 5%
  // (size tak pernah merefleksikan jarak SL), dan lantai 2% MEMAKSA oversize
  // saat SL lebar (risiko > target). Gate Keel kini cap-only (gatekeeper.ts).
  const execMult = budget.executionMultiplier ?? 1;
  const stopPctPos = Math.abs(stopLossPct);
  const capNotionalPct = budget.maxNotionalPct ?? RISK_CONSTANTS.MAX_POSITION_SIZE_PCT;
  const sizing = riskTargetedSizePct({
    riskTargetPct: budget.maxRiskPct,
    stopDistancePct: stopPctPos,
    maxNotionalPct: capNotionalPct,
    executionMultiplier: execMult,
  });
  const sizePct = sizing.sizePct;

  return {
    action,
    entryPrice: Number(entry.toFixed(depthPrecision(entry))),
    stopLossPct: Number(stopLossPct.toFixed(2)),
    takeProfitPct: Number(takeProfitPct.toFixed(2)),
    sizePct,
    volatilityPct: Number((volatility * 100).toFixed(2)),
    stopAbs: Number(stopAbs.toFixed(depthPrecision(entry))),
    targetAbs: Number(targetAbs.toFixed(depthPrecision(entry))),
    reason: `${action} vol ${(volatility * 100).toFixed(2)}% · SL ${stopRationale} · TP ${tpRationale} · size ${sizePct}% (risk target ${budget.maxRiskPct}%${sizing.capped ? `, capped notional ${capNotionalPct}%` : ` · efektif ${sizing.riskEffectivePct}%`}) · floor SL ${(minStopPct * 100).toFixed(2)}% R:R≥${minRewardRatio}`,
  };
}

function depthPrecision(price: number): number {
  if (price >= 1000) return 0;
  if (price >= 1) return 2;
  return Number(price.toString().split('.')[1]?.length ?? 2) + 2;
}