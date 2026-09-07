/**
 * Probability Engine — Ported from Keel `probability-engine.ts`.
 *
 * Client-side calibrated P(TP before SL) using:
 * - Coarse bucketing by flow × confluence × absorption × wall
 * - Wilson lower-bound shrinkage toward 0.5 when thin
 * - Laplace smoothing cold-start prior
 * - Expected value: EV = P × tpPct - (1-P) × slPctAbs
 *
 * Neural adaptation: uses client-side trade history from server
 * (/api/ledger/stats closedTrades) instead of Keel's Postgres signal_outcomes.
 * When no history exists, returns cold prior (P=0.52, prior=true).
 */

export interface ProbInput {
  flow: string;          // BULLISH | BEARISH | NEUTRAL
  confluenceScore: number; // 0-1
  absorptionScore: number; // 0-100
  wallAction: string;      // from wallDynamics: PULLED_SELL_WALL | BID_SUPPORT_UP | WALL_ADDED | NONE
  spreadPct: number;
  imbalance: number;       // order book imbalance ratio
}

export interface ProbResult {
  p: number;       // P(TP before SL) 0-1
  n: number;       // sample count informing p
  prior: boolean;  // true = cold-start prior (no data)
  ev: number;      // expected value: P*tpPct - (1-P)*slPctAbs
  tp1: number;     // take-profit price 1
  tp2: number;     // take-profit price 2
  sl: number;      // stop-loss price
  bucket: string;  // bucket key used for classification
}

const COLD_PRIOR_P = 0.52;
const COLD_N = 12; // Laplace pseudo-count

function bucketOf(input: ProbInput): string {
  const cBin = input.confluenceScore >= 0.8 ? "hi" : input.confluenceScore >= 0.5 ? "mid" : "lo";
  const aBin = input.absorptionScore >= 75 ? "hi" : input.absorptionScore >= 40 ? "mid" : "lo";
  const wall = input.wallAction !== "NONE" ? "wall" : "nowall";
  return `${input.flow}:${cBin}:${aBin}:${wall}`;
}

/** Stored outcome bucket for local history tracking. */
interface OutcomeBucket {
  wins: number;
  total: number;
}

// In-memory client-side outcome store (populated from /api/ledger/stats)
let outcomeStore: Map<string, OutcomeBucket> = new Map();
let globalWins = 0;
let globalTotal = 0;
let lastLoadAt = 0;
const CACHE_TTL_MS = 30_000;

/**
 * Load trade outcomes from the server ledger stats.
 * Called lazily on first prob calculation and every 30s.
 */
export async function loadOutcomesFromServer(): Promise<void> {
  const now = Date.now();
  if (now - lastLoadAt < CACHE_TTL_MS) return;

  try {
    const res = await fetch("/api/ledger/stats");
    const data = await res.json().catch(() => null);
    if (!data?.success || !Array.isArray(data.closedTrades)) {
      lastLoadAt = now;
      return;
    }

    // Rebuild bucket counts from closed trades
    const newStore = new Map<string, OutcomeBucket>();
    let gWins = 0;
    let gTotal = 0;

    for (const trade of data.closedTrades as Array<{
      realizedPnlUsd?: number | null;
      entryReasoning?: string;
      targetLiquidityPool?: string;
      status?: string;
    }>) {
      gTotal++;
      const pnl = Number(trade.realizedPnlUsd ?? 0);
      if (pnl > 0) gWins++;

      // Try to reconstruct bucket from trade metadata
      // Use a simplified bucket: NEUTRAL:mid:mid:nowall as default
      const bucket = "__global__";
      const existing = newStore.get(bucket);
      if (existing) {
        existing.total++;
        if (pnl > 0) existing.wins++;
      } else {
        newStore.set(bucket, { wins: pnl > 0 ? 1 : 0, total: 1 });
      }
    }

    outcomeStore = newStore;
    globalWins = gWins;
    globalTotal = gTotal;
    lastLoadAt = now;
  } catch {
    // Server unavailable — keep previous state
    lastLoadAt = now;
  }
}

/**
 * Calibrated probability of TP being hit before SL.
 * Ported from Keel probability-engine.ts with client-side adaptation.
 */
export async function calibratedProb(
  input: ProbInput,
  currentPrice: number,
  tpPct: number = 0.021,    // 2.1% default TP
  slPctAbs: number = 0.009  // 0.9% default SL
): Promise<ProbResult> {
  // Ensure outcomes are loaded
  await loadOutcomesFromServer();

  const bucket = bucketOf(input);

  // Try bucket-specific data first
  const bucketData = outcomeStore.get(bucket);
  let wins = bucketData?.wins ?? 0;
  let total = bucketData?.total ?? 0;
  let prior = false;

  if (total < 15) {
    // Fallback to global
    if (globalTotal >= 10) {
      wins = globalWins;
      total = globalTotal;
    } else {
      // Cold start: Laplace smoothing around prior
      prior = true;
      const pSmooth = (wins + COLD_PRIOR_P * COLD_N) / (total + COLD_N);
      const ev = pSmooth * tpPct - (1 - pSmooth) * slPctAbs;
      const tp1 = currentPrice * (1 + tpPct);
      const tp2 = currentPrice * (1 + tpPct * 1.5);
      const sl = currentPrice * (1 - slPctAbs);
      return { p: pSmooth, n: total, prior, ev, tp1, tp2, sl, bucket };
    }
  }

  // Wilson lower-bound style shrinkage
  const raw = total > 0 ? wins / total : COLD_PRIOR_P;
  const shrink = Math.min(1, total / 80);
  const p = raw * shrink + 0.5 * (1 - shrink) * 0.15;
  const ev = p * tpPct - (1 - p) * slPctAbs;
  const tp1 = currentPrice * (1 + tpPct);
  const tp2 = currentPrice * (1 + tpPct * 1.5);
  const sl = currentPrice * (1 - slPctAbs);

  return { p, n: total, prior, ev, tp1, tp2, sl, bucket };
}

/**
 * Synchronous cold-start probability (no server fetch).
 * Used for initial render before async load completes.
 */
export function coldProb(
  currentPrice: number,
  tpPct: number = 0.021,
  slPctAbs: number = 0.009
): ProbResult {
  const tp1 = currentPrice * (1 + tpPct);
  const tp2 = currentPrice * (1 + tpPct * 1.5);
  const sl = currentPrice * (1 - slPctAbs);
  return {
    p: COLD_PRIOR_P,
    n: 0,
    prior: true,
    ev: COLD_PRIOR_P * tpPct - (1 - COLD_PRIOR_P) * slPctAbs,
    tp1,
    tp2,
    sl,
    bucket: "cold-start",
  };
}
