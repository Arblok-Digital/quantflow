import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, classify, SCALE } from '../scripts/lib/scoring.js';
import { anomaly } from '../scripts/anomaly.js';
import { mockMarket } from '../scripts/mock.js';

test('evaluate deterministic — kembalikan skor yang sama untuk input yang sama', () => {
  const base = {
    kol: { count: 3, verifiedCount: 1, maxFollowers: 812000 },
    fundamentals: { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.055, holders: 2140, liquidityUsd: 214000, mintAuthorityRevoked: true },
    ageHours: 5,
  };
  const a = evaluate(base);
  const b = evaluate({ ...base, kol: { ...base.kol } });
  assert.equal(a.score, b.score);
  assert.equal(a.tier, b.tier);
});

test('gate rug — hard fail menurunkan ke SKIP', () => {
  const v = evaluate({
    kol: { count: 3, verifiedCount: 1, maxFollowers: 1000000 },
    fundamentals: { rugRisk: true, rugRiskDetail: ['Honeypot'], topHolderPct: 0.1, holders: 500, liquidityUsd: 20000, mintAuthorityRevoked: true },
    ageHours: 6,
  });
  assert.equal(v.hardFailed, true);
  assert.equal(v.tier, 'SKIP');
  assert.ok(v.score < 70);
});

test('no liquidity — hard fail', () => {
  const v = evaluate({
    kol: { count: 2, verifiedCount: 0, maxFollowers: 100000 },
    fundamentals: { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.2, holders: 50, liquidityUsd: 300, mintAuthorityRevoked: true },
    ageHours: 10,
  });
  assert.equal(v.hardFailed, true);
});

test('top holder besar — hard fail', () => {
  const v = evaluate({
    kol: { count: 2, verifiedCount: 0, maxFollowers: 100000 },
    fundamentals: { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.55, holders: 300, liquidityUsd: 50000, mintAuthorityRevoked: true },
    ageHours: 10,
  });
  assert.equal(v.hardFailed, true);
});

test('classify boundary 150 → ALPHA, 110 → BUY, 70 → WATCH, <70 → SKIP', () => {
  assert.equal(classify(200).tier, 'ALPHA');
  assert.equal(classify(150).tier, 'ALPHA');
  assert.equal(classify(149).tier, 'BUY');
  assert.equal(classify(110).tier, 'BUY');
  assert.equal(classify(109).tier, 'WATCH');
  assert.equal(classify(70).tier, 'WATCH');
  assert.equal(classify(69).tier, 'SKIP');
  assert.equal(classify(0).tier, 'SKIP');
});

test('skor selalu dalam [0, SCALE]', () => {
  const v = evaluate({
    kol: { count: 3, verifiedCount: 1, maxFollowers: 2000000 },
    fundamentals: { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.02, holders: 5000, liquidityUsd: 500000, mintAuthorityRevoked: true },
    ageHours: 8,
  });
  assert.ok(v.score >= 0 && v.score <= SCALE);
});

test('anomaly — urut berdasar jumlah KOL, lalu verified', () => {
  const map = new Map();
  const w1 = { wallet: 'A'.repeat(33), handle: 'k1', followers: 100 };
  const w2 = { wallet: 'B'.repeat(33), handle: 'k2', followers: 200, verified: true };
  map.set('AAA', new Map([[w1.wallet, 1]]));
  map.set('BBB', new Map([[w1.wallet, 1], [w2.wallet, 2]]));
  const out = anomaly(map, [w1, w2]);
  assert.equal(out.length, 2);
  assert.equal(out[0].mint, 'BBB');
  assert.equal(out[0].count, 2);
});

test('MID_PUMP — h24 +150% & volH1 < 10% volH24 -> AVOID (exit-liquidity guard)', () => {
  const v = evaluate({
    kol: { count: 2, verifiedCount: 0, maxFollowers: 100000 },
    fundamentals: { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.1, holders: 500, liquidityUsd: 50000, mintAuthorityRevoked: true },
    ageHours: 10,
    market: { priceChangeH24: 300, volumeH1: 500, volumeH24: 80000 },
  });
  assert.equal(v.tier, 'AVOID');
  assert.equal(v.hardFailed, true);
  assert.ok(v.failedGates.some((g) => g.includes('pump')));
});

test('MID_PUMP — TIDAK aktif bila volH1 masih sehat (20% dari volH24)', () => {
  const v = evaluate({
    kol: { count: 2, verifiedCount: 0, maxFollowers: 100000 },
    fundamentals: { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.1, holders: 500, liquidityUsd: 50000, mintAuthorityRevoked: true },
    ageHours: 10,
    market: { priceChangeH24: 300, volumeH1: 16000, volumeH24: 80000 },
  });
  assert.notEqual(v.tier, 'AVOID');
  assert.equal(v.hardFailed, false);
});

test('concurrency exclusive — count 2 tidak dapat KOL_CONCURRENCY_3PLUS', () => {
  const v = evaluate({
    kol: { count: 2, verifiedCount: 0, maxFollowers: 100000 },
    fundamentals: { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.1, holders: 500, liquidityUsd: 50000, mintAuthorityRevoked: true },
    ageHours: 10,
  });
  const keys = v.checks.filter((c) => c.applied && c.kind === 'credit').map((c) => c.key);
  assert.ok(keys.includes('KOL_CONCURRENCY'));
  assert.ok(!keys.includes('KOL_CONCURRENCY_3PLUS'));
});

test('concurrency exclusive — count 3 dapat KOL_CONCURRENCY_3PLUS tapi bukan KOL_CONCURRENCY', () => {
  const v = evaluate({
    kol: { count: 3, verifiedCount: 0, maxFollowers: 100000 },
    fundamentals: { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.1, holders: 500, liquidityUsd: 50000, mintAuthorityRevoked: true },
    ageHours: 10,
  });
  const keys = v.checks.filter((c) => c.applied && c.kind === 'credit').map((c) => c.key);
  assert.ok(keys.includes('KOL_CONCURRENCY_3PLUS'));
  assert.ok(!keys.includes('KOL_CONCURRENCY'));
});

test('age spike — ≤6 jam dapat NEWBORN_WINDOW, 6-24 MATURED, 24-72 OLD (satu credit saja)', () => {
  const f = { rugRisk: false, rugRiskDetail: [], topHolderPct: 0.1, holders: 0, liquidityUsd: 0, mintAuthorityRevoked: true };
  const fresh = evaluate({ kol: { count: 0 }, fundamentals: f, ageHours: 3 });
  const mature = evaluate({ kol: { count: 0 }, fundamentals: f, ageHours: 12 });
  const old = evaluate({ kol: { count: 0 }, fundamentals: f, ageHours: 50 });
  const pick = (v) => v.checks.filter((c) => c.applied && c.kind === 'credit').map((c) => c.key);
  assert.ok(pick(fresh).includes('NEWBORN_WINDOW'));
  assert.ok(pick(mature).includes('MATURED_NEWBORN'));
  assert.ok(pick(old).includes('OLD_NEWBORN'));
  assert.equal(pick(fresh).filter((k) => k.includes('NEWBORN')).length, 1);
});

test('mockMarket — semua verdict deterministik & valid', () => {
  const tokens = mockMarket();
  assert.ok(tokens.length >= 5);
  for (const t of tokens) {
    assert.ok(t.verdict.score >= 0 && t.verdict.score <= 200);
    assert.ok(['ALPHA', 'BUY', 'WATCH', 'SKIP'].includes(t.verdict.tier));
    assert.equal(typeof t.verdict.breakdown, 'string');
  }
});