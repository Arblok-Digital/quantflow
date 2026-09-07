/**
 * Sentiment (Fear & Greed) — Keel `src/services/features/sentiment.ts` port.
 * Fetches Alternative.me FNG with a 30 min TTL cache; graceful fallback to
 * stale cache or null-off (engine keeps working without live sentiment).
 */
import { timeService } from '../time-sync.js';

export type SentimentLabel = 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed';
export interface SentimentSnapshot {
  value: number | null; // 0..100, 50 neutral (Fear&Greed style)
  label: SentimentLabel | null;
  asOf: number;
  stale: boolean;
  z: number | null;
}
let cache: { v: number; asOf: number; hist: number[] } | null = null;
let fetchedAt = 0;
const TTL = 30 * 60_000;

function labelOf(v: number): SentimentLabel {
  if (v <= 25) return 'extreme_fear';
  if (v <= 44) return 'fear';
  if (v <= 55) return 'neutral';
  if (v <= 75) return 'greed';
  return 'extreme_greed';
}
function zscore(v: number, hist: number[]): number | null {
  if (hist.length < 7) return null;
  const m = hist.reduce((a, b) => a + b, 0) / hist.length;
  const vr = hist.reduce((s, x) => s + (x - m) * (x - m), 0) / hist.length;
  const sd = Math.sqrt(vr) || 1;
  return +((v - m) / sd).toFixed(2);
}

export async function refreshSentiment(): Promise<SentimentSnapshot> {
  const now = timeService.now();
  if (cache && now - fetchedAt < TTL) {
    return { value: cache.v, label: labelOf(cache.v), asOf: cache.asOf, stale: false, z: zscore(cache.v, cache.hist) };
  }
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=30&format=json', { signal: AbortSignal.timeout(3500) });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { data?: Array<{ value: string; timestamp: string }> };
    const arr = j.data ?? [];
    const vals = arr.map((x) => Number(x.value)).filter((n) => Number.isFinite(n));
    const cur = vals[0];
    if (cur == null) throw new Error('no val');
    const hist = vals.slice(0, 30);
    const ts = arr[0]?.timestamp ? Number(arr[0].timestamp) * 1000 : now;
    cache = { v: cur, asOf: ts, hist };
    fetchedAt = now;
    return { value: cur, label: labelOf(cur), asOf: ts, stale: false, z: zscore(cur, hist) };
  } catch {
    if (cache) return { value: cache.v, label: labelOf(cache.v), asOf: cache.asOf, stale: true, z: zscore(cache.v, cache.hist) };
    return { value: null, label: null, asOf: 0, stale: true, z: null };
  }
}
export function getSentimentSnapshot(): SentimentSnapshot {
  if (!cache) return { value: null, label: null, asOf: 0, stale: true, z: null };
  return { value: cache.v, label: labelOf(cache.v), asOf: cache.asOf, stale: timeService.now() - fetchedAt > TTL * 2, z: zscore(cache.v, cache.hist) };
}
export function sentimentFeature(v: number | null): number | null {
  if (v == null) return null;
  return Math.max(-1, Math.min(1, (v - 50) / 50));
}