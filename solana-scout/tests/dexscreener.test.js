import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickMainPair,
  pairToMeta,
  filterBoosted,
  candidatesFromDiscovery,
  IGNORE_MINTS,
} from '../scripts/lib/dexscreener.js';

const NOW = 1_800_000_000_000; // fixed epoch ms

function pair(over = {}) {
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: 'PAIR' + Math.random().toString(36).slice(2, 8),
    baseToken: { address: 'CA1111111111111111111111111111111111111111', name: 'Test Coin', symbol: 'TST' },
    priceUsd: '0.001',
    marketCap: 50000,
    fdv: 50000,
    liquidity: { usd: 12000 },
    volume: { h24: 30000 },
    pairCreatedAt: NOW - 3 * 3_600_000, // 3 jam lalu
    ...over,
  };
}

test('pickMainPair — pilih pair likuiditas tertinggi', () => {
  const pairs = [
    pair({ liquidity: { usd: 500 }, volume: { h24: 90000 } }),
    pair({ liquidity: { usd: 30000 }, volume: { h24: 100 } }),
    pair({ liquidity: { usd: 12000 }, volume: { h24: 30000 } }),
  ];
  const main = pickMainPair(pairs);
  assert.equal(main.liquidity.usd, 30000);
});

test('pickMainPair — fallback volume saat liq sama / kosong, urut stabil', () => {
  const a = pair({ liquidity: { usd: 0 }, volume: { h24: 100 } });
  const b = pair({ liquidity: { usd: 0 }, volume: { h24: 200 } });
  assert.equal(pickMainPair([a, b]).volume.h24, 200);

  const c = pair({ liquidity: { usd: 0 }, volume: { h24: 10 } });
  const d = pair({ liquidity: { usd: 0 }, volume: { h24: 10 } });
  assert.equal(pickMainPair([c, d]).pairAddress, c.pairAddress); // stabil (index order)
});

test('pickMainPair — kembalikan null untuk array kosong / tanpa baseToken', () => {
  assert.equal(pickMainPair([]), null);
  assert.equal(pickMainPair([{ liquidity: { usd: 1000 } }]), null);
  assert.equal(pickMainPair(null), null);
});

test('pairToMeta — ageHours dari pairCreatedAt, decimals null (DexScreener tak punya)', () => {
  const m = pairToMeta(pair({ pairCreatedAt: NOW - 5 * 3_600_000 }), NOW);
  assert.equal(m.ageHours, 5);
  assert.equal(m.symbol, 'TST');
  assert.equal(m.name, 'Test Coin');
  assert.equal(m.decimals, null);
  assert.equal(m.liquidityUsd, 12000);
  assert.equal(m.marketCap, 50000);
});

test('pairToMeta — pairCreatedAt 0/absent -> ageHours null (bukan NaN)', () => {
  const m1 = pairToMeta(pair({ pairCreatedAt: 0 }), NOW);
  assert.equal(m1.ageHours, null);
  const m2 = pairToMeta(pair({ pairCreatedAt: undefined }), NOW);
  assert.equal(m2.ageHours, null);
  const m3 = pairToMeta(null, NOW);
  assert.equal(m3.ageHours, null);
  assert.equal(m3.mint, null);
});

test('filterBoosted — hanya solana, dedupe, buang wSOL/stable (USDC/USDT)', () => {
  const boots = [
    { chainId: 'solana', tokenAddress: 'AAA1111111111111111111111111111111111111111' },
    { chainId: 'solana', tokenAddress: 'AAA1111111111111111111111111111111111111111' }, // dupe
    { chainId: 'solana', tokenAddress: 'BBB2222222222222222222222222222222222222222' },
    { chainId: 'ethereum', tokenAddress: 'CCC3333333333333333333333333333333333333333' }, // bukan solana
    { chainId: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112' }, // wSOL
    { chainId: 'solana', tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }, // USDC
    { chainId: 'solana', tokenAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }, // USDT
    { chainId: 'solana' }, // tanpa tokenAddress
  ];
  const out = filterBoosted(boots);
  assert.equal(out.length, 2);
  assert.deepEqual(out, ['AAA1111111111111111111111111111111111111111', 'BBB2222222222222222222222222222222222222222']);
  assert.deepEqual(filterBoosted(null), []);
  assert.deepEqual(filterBoosted([]), []);
});

test('candidatesFromDiscovery — main pair per token, filter maxMcap, urut boosts, batas limit', () => {
  const mints = ['MINT_A', 'MINT_B', 'MINT_C'];
  const pairsByMint = new Map([
    ['MINT_A', [pair({ marketCap: 6000000, pairAddress: 'PA', baseToken: { address: 'MINT_A', symbol: 'BIG', name: 'Big Cap' } })]], // > maxMcap default -> dibuang
    ['MINT_B', [pair({ marketCap: 80000, pairAddress: 'PB1', baseToken: { address: 'MINT_B', symbol: 'OK1', name: 'Ok One' } }), pair({ marketCap: 70000, liquidity: { usd: 99999 }, pairAddress: 'PB2', baseToken: { address: 'MINT_B', symbol: 'OK2', name: 'Ok Two' } })]], // PB2 liq lebih tinggi
    ['MINT_C', []], // tanpa pair -> di-skip
  ]);
  const out = candidatesFromDiscovery(mints, pairsByMint, { now: NOW });
  assert.equal(out.length, 1); // MINT_A kebuang (mcap), MINT_C skip
  assert.equal(out[0].mint, 'MINT_B');
  assert.equal(out[0].symbol, 'OK2'); // main pair = liq tertinggi
  assert.equal(out[0].ageHours, 3);
});

test('candidatesFromDiscovery — maxMcap 0 = tanpa filter mcap, marketCap null tetap masuk', () => {
  const mints = ['MINT_X', 'MINT_Y'];
  const pairsByMint = new Map([
    ['MINT_X', [pair({ marketCap: 999999999, baseToken: { address: 'MINT_X', symbol: 'HUGE', name: 'Huge' } })]],
    ['MINT_Y', [pair({ marketCap: null, baseToken: { address: 'MINT_Y', symbol: 'FRESH', name: 'Fresh' } })]],
  ]);
  const out = candidatesFromDiscovery(mints, pairsByMint, { maxMcap: 0, now: NOW });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.symbol), ['HUGE', 'FRESH']);
});

test('candidatesFromDiscovery — limit membatasi hasil sesuai urutan boosts', () => {
  const mints = ['M1', 'M2', 'M3'];
  const pairsByMint = new Map(
    mints.map((m, i) => [m, [pair({ baseToken: { address: m, symbol: `T${i}`, name: `T${i}` } })]])
  );
  const out = candidatesFromDiscovery(mints, pairsByMint, { limit: 2, now: NOW });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.symbol), ['T0', 'T1']);
});

test('IGNORE_MINTS — berisi wSOL, USDC, USDT (jaga-jaga)', () => {
  assert.ok(IGNORE_MINTS.has('So11111111111111111111111111111111111111112'));
  assert.ok(IGNORE_MINTS.has('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'));
  assert.ok(IGNORE_MINTS.has('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'));
});