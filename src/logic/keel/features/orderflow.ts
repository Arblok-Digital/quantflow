/**
 * Orderflow features — Keel `src/services/features/orderflow.ts` port.
 */
import type { NormalizedDepth } from '../types.js';

export interface OrderFlowFeatures {
  bidDepth1pctUsd: number;
  askDepth1pctUsd: number;
  imbalance: number;
  spreadPct: number;
  spreadBps: number;
  bidWallPrice: number | null;
  bidWallUsd: number;
  askWallPrice: number | null;
  askWallUsd: number;
  liqLevels: { price: number; side: 'bid' | 'ask'; notionalUsd: number }[];
  densityScore: number;
}

function within(levels: { price: number; qty: number }[], mid: number, pct: number): number {
  return levels.filter((l) => Math.abs(l.price - mid) / mid <= pct).reduce((s, l) => s + l.price * l.qty, 0);
}
function wall(levels: { price: number; qty: number }[]): { price: number; usd: number } | null {
  if (!levels.length) return null;
  const best = levels.reduce((a, b) => (a.price * a.qty >= b.price * b.qty ? a : b));
  return { price: best.price, usd: best.price * best.qty };
}
export function extractOrderFlow(depth: NormalizedDepth, midOverride?: number): OrderFlowFeatures {
  const bid = depth.bids[0]?.price;
  const ask = depth.asks[0]?.price;
  const mid = midOverride ?? (bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask ?? 0);
  const spreadPct = bid && ask && mid > 0 ? ((ask - bid) / mid) * 100 : 0;
  const bidDepth1pctUsd = mid > 0 ? within(depth.bids, mid, 0.01) : 0;
  const askDepth1pctUsd = mid > 0 ? within(depth.asks, mid, 0.01) : 0;
  const imbalance = askDepth1pctUsd > 0 ? bidDepth1pctUsd / askDepth1pctUsd : 1;
  const bw = wall(depth.bids);
  const aw = wall(depth.asks);
  const buckets = new Map<string, { price: number; side: 'bid' | 'ask'; usd: number; cnt: number }>();
  const binPct = 0.008;
  function bin(levels: { price: number; qty: number }[], side: 'bid' | 'ask') {
    for (const l of levels) {
      if (mid <= 0) break;
      if (Math.abs(l.price - mid) / mid > 0.03) continue;
      const k = Math.round(Math.log(l.price / mid) / Math.log(1 + binPct));
      const key = `${side}:${k}`;
      const cur = buckets.get(key);
      const usd = l.price * l.qty;
      if (!cur) buckets.set(key, { price: l.price, side, usd, cnt: 1 });
      else {
        cur.usd += usd;
        cur.cnt += 1;
        cur.price = (cur.price * (cur.cnt - 1) + l.price) / cur.cnt;
      }
    }
  }
  bin(depth.bids, 'bid');
  bin(depth.asks, 'ask');
  const liqLevels = [...buckets.values()]
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 4)
    .map((v) => ({ price: v.price, side: v.side, notionalUsd: v.usd }));
  const totalDepth = bidDepth1pctUsd + askDepth1pctUsd;
  const densityScore = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        (totalDepth / 100_000) * 40 +
          Math.min(30, imbalance > 1 ? (imbalance - 1) * 30 : (1 / imbalance - 1) * 30) +
          (spreadPct < 0.05 ? 20 : spreadPct < 0.15 ? 10 : 0),
      ),
    ),
  );
  return {
    bidDepth1pctUsd,
    askDepth1pctUsd,
    imbalance,
    spreadPct,
    spreadBps: spreadPct * 100,
    bidWallPrice: bw?.price ?? null,
    bidWallUsd: bw?.usd ?? 0,
    askWallPrice: aw?.price ?? null,
    askWallUsd: aw?.usd ?? 0,
    liqLevels,
    densityScore,
  };
}

export function enrichWithExternalLiq(base: OrderFlowFeatures, extLevels: Array<{ price: number; side: 'bid' | 'ask'; notionalUsd: number }>): OrderFlowFeatures {
  if (!extLevels.length) return base;
  const merged = [...base.liqLevels, ...extLevels].sort((a, b) => b.notionalUsd - a.notionalUsd).slice(0, 4);
  return { ...base, liqLevels: merged };
}