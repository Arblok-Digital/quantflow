import { evaluate } from './lib/scoring.js';

export function scoreCandidates(candidates, fundamentalsMap, now = Date.now()) {
  return candidates.map((c) => {
    const fundamentals = fundamentalsMap.get(c.mint) || {
      available: false,
      rugRisk: null,
      rugRiskDetail: [],
      topHolderPct: null,
      holders: null,
      liquidityUsd: null,
      mintAuthorityRevoked: null,
    };
    const ageHours = c.ageHours ?? NaN;
    const verdict = evaluate({
      kol: { count: c.count, verifiedCount: c.verifiedCount, maxFollowers: c.maxFollowers },
      fundamentals,
      ageHours,
      market: c.market || undefined,
    });
    return {
      mint: c.mint,
      symbol: c.symbol || null,
      name: c.name || null,
      decimals: c.decimals ?? null,
      count: c.count,
      verifiedCount: c.verifiedCount,
      maxFollowers: c.maxFollowers,
      holders: c.holders,
      fundamentals,
      ageHours,
      market: c.market || null,
      verdict,
    };
  });
}