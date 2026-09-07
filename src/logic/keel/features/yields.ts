/**
 * Yields — Keel `src/services/features/yields.ts` port.
 * 10y REAL yield (nominal - breakeven). FRED requires an API key; without one
 * the engine degrades to a null-yield cache (stale=true) instead of failing.
 */
import { timeService } from '../time-sync.js';

let cache: { asOf: number; nominal10y: number | null; breakeven: number | null; real: number | null } | null = null;
let cacheAtMs = 0;
const TTL_MS = 30 * 60_000;

export interface YieldSnapshot {
  nominal10y: number | null;
  breakeven10y: number | null;
  real10y: number | null;
  asOf: number;
  stale: boolean;
  trendingUp: boolean | null;
}

async function fetchFred(series: string, apiKey: string): Promise<number | null> {
  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=2`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { observations?: Array<{ value: string }> };
    const v = j.observations?.[0]?.value;
    const n = v != null && v !== '.' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function toSnapshot(c: { asOf: number; nominal10y: number | null; breakeven: number | null; real: number | null }, stale: boolean, trendingUp: boolean | null): YieldSnapshot {
  return { nominal10y: c.nominal10y, breakeven10y: c.breakeven, real10y: c.real, asOf: c.asOf, stale, trendingUp };
}
export async function refreshYields(fredApiKey?: string): Promise<YieldSnapshot> {
  const now = timeService.now();
  if (cache && now - cacheAtMs < TTL_MS) return toSnapshot(cache, false, null);
  if (!fredApiKey) {
    if (cache) return toSnapshot(cache, true, null);
    cache = { asOf: now, nominal10y: null, breakeven: null, real: null };
    cacheAtMs = now;
    return toSnapshot(cache, true, null);
  }
  const nom = await fetchFred('DGS10', fredApiKey);
  const be = await fetchFred('T10YIE', fredApiKey);
  const prevNom = cache?.nominal10y ?? null;
  const real = nom != null && be != null ? +(nom - be).toFixed(2) : null;
  cache = { asOf: now, nominal10y: nom, breakeven: be, real };
  cacheAtMs = now;
  const trendingUp = prevNom != null && nom != null ? nom > prevNom : null;
  return toSnapshot(cache, false, trendingUp);
}
export function getYieldSnapshot(): YieldSnapshot {
  if (!cache) return { nominal10y: null, breakeven10y: null, real10y: null, asOf: 0, stale: true, trendingUp: null };
  return { nominal10y: cache.nominal10y, breakeven10y: cache.breakeven, real10y: cache.real, asOf: cache.asOf, stale: timeService.now() - cache.asOf > TTL_MS * 2, trendingUp: null };
}
export function realYieldFeature(real10y: number | null): number | null {
  if (real10y == null) return null;
  return Math.max(-1, Math.min(1, (real10y - 1.8) / 1.2));
}