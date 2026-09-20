export function anomaly(tokenToKols, walletResults) {
  const rows = [];
  for (const [mint, kolMap] of tokenToKols) {
    const holders = [...kolMap.entries()]
      .map(([wallet, amount]) => {
        const info = walletResults.find((r) => r.wallet === wallet);
        return {
          wallet,
          amount,
          handle: info?.handle || '?',
          verified: !!info?.verified,
          followers: info?.followers || 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    rows.push({
      mint,
      count: holders.length,
      verifiedCount: holders.filter((h) => h.verified).length,
      maxFollowers: Math.max(...holders.map((h) => h.followers), 0),
      totalAmount: holders.reduce((s, h) => s + h.amount, 0),
      holders,
    });
  }

  const candidates = rows.filter((r) => r.count >= 1).sort((a, b) => b.count - a.count || b.verifiedCount - a.verifiedCount);
  return candidates;
}