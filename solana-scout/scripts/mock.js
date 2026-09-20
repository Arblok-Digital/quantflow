import { evaluate, SCALE } from './lib/scoring.js';

export function mockMarket(now = Date.now()) {
  const H = 3600_000;
  const tokens = [
    {
      mint: 'MiLKS8xUkQKdNRbRvpY9vaL43BdWvvJH1s6sL1qpump',
      symbol: 'MILK',
      name: 'Milky Way Cat',
      ageMs: 5 * H,
      count: 3,
      verifiedCount: 1,
      maxFollowers: 812000,
      fundamentals: {
        available: true,
        rugRisk: false,
        rugRiskDetail: [],
        topHolderPct: 0.055,
        holders: 2140,
        liquidityUsd: 214000,
        mintAuthorityRevoked: true,
      },
    },
    {
      mint: 'KMIC49eQNAsTL7e5dLJ7YDsfhRrVwEiHfBG1Eiypump',
      symbol: 'KMIC',
      name: 'Kamala Micro',
      ageMs: 12 * H,
      count: 2,
      verifiedCount: 0,
      maxFollowers: 190000,
      fundamentals: {
        available: true,
        rugRisk: false,
        rugRiskDetail: [],
        topHolderPct: 0.18,
        holders: 740,
        liquidityUsd: 61800,
        mintAuthorityRevoked: true,
      },
    },
    {
      mint: 'SUGARzQ2dQ8N1jKfKp5q9HXhZfV9J9f9f9f9f9f9pump',
      symbol: 'SUGAR',
      name: 'Sugar Rush',
      ageMs: 50 * H,
      count: 2,
      verifiedCount: 0,
      maxFollowers: 98000,
      fundamentals: {
        available: true,
        rugRisk: true,
        rugRiskDetail: ['HighCreatorBalance', 'OwnershipRenouncedOff'],
        topHolderPct: 0.42,
        holders: 320,
        liquidityUsd: 4200,
        mintAuthorityRevoked: false,
      },
    },
    {
      mint: 'OLDO9Z2xW3vVn7pQK1cJ8M5dR2sT9yZ4qXnRvYjupump',
      symbol: 'OLDO',
      name: 'Olde Town Road',
      ageMs: 96 * H,
      count: 1,
      verifiedCount: 0,
      maxFollowers: 42000,
      fundamentals: {
        available: true,
        rugRisk: false,
        rugRiskDetail: [],
        topHolderPct: 0.08,
        holders: 1500,
        liquidityUsd: 88000,
        mintAuthorityRevoked: true,
      },
    },
    {
      mint: 'TINY9vVKfXqWsZD2qP7mR2bLzT1yJ8cA3dH5gKjJpump',
      symbol: 'TINY',
      name: 'Tiny Trends',
      ageMs: 2 * H,
      count: 1,
      verifiedCount: 1,
      maxFollowers: 1310000,
      fundamentals: {
        available: true,
        rugRisk: false,
        rugRiskDetail: [],
        topHolderPct: 0.12,
        holders: 610,
        liquidityUsd: 45200,
        mintAuthorityRevoked: true,
      },
    },
    {
      mint: 'RUGGYz8xQ1pBbCcDdEeFfGgHhIiJjKkLlMmNnOoPp',
      symbol: 'RUGGY',
      name: 'Ruggy Bear',
      ageMs: 8 * H,
      count: 2,
      verifiedCount: 0,
      maxFollowers: 112000,
      fundamentals: {
        available: true,
        rugRisk: true,
        rugRiskDetail: ['Honeypot', 'MintAuthority'],
        topHolderPct: 0.54,
        holders: 55,
        liquidityUsd: 310,
        mintAuthorityRevoked: false,
      },
    },
  ];

  return tokens.map((t) => {
    const verdict = evaluate({
      kol: { count: t.count, verifiedCount: t.verifiedCount, maxFollowers: t.maxFollowers },
      fundamentals: t.fundamentals,
      ageHours: t.ageMs / H,
    });
    return { ...t, ageHours: t.ageMs / H, verdict };
  });
}

export { SCALE };