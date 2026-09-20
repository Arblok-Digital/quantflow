import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildRpcEndpoints, feedFromUrl, getFeedStats, formatFeedStats } from '../scripts/lib/rpc.js';

const ORIG_HELIUS = process.env.HELIUS_API_KEY;
const ORIG_ZAN = process.env.ZAN_API_KEY;

beforeEach(() => {
  process.env.HELIUS_API_KEY = ORIG_HELIUS;
  process.env.ZAN_API_KEY = ORIG_ZAN;
});

test('ZAN canonical endpoint: api.zan.top/node/v1/solana/mainnet/{key}', () => {
  process.env.ZAN_API_KEY = 'zan_test_key_123';
  delete process.env.HELIUS_API_KEY;
  const { zan, helius, endpoints } = buildRpcEndpoints();
  assert.equal(helius, false);
  assert.equal(zan, true);
  assert.equal(
    endpoints[0],
    'https://api.zan.top/node/v1/solana/mainnet/zan_test_key_123',
  );
});

test('urutan prioritas: Helius > ZAN > public RPC', () => {
  process.env.HELIUS_API_KEY = 'helius_a';
  process.env.ZAN_API_KEY = 'zan_b';
  const { endpoints } = buildRpcEndpoints();
  assert.equal(endpoints[0], 'https://mainnet.helius-rpc.com/?api-key=helius_a');
  assert.equal(endpoints[1], 'https://api.zan.top/node/v1/solana/mainnet/zan_b');
  assert.ok(endpoints.length >= 3, 'public RPC ikut di belakang');
});

test('tanpa key: hanya public RPC', () => {
  delete process.env.HELIUS_API_KEY;
  delete process.env.ZAN_API_KEY;
  const { zan, helius, endpoints } = buildRpcEndpoints();
  assert.equal(zan, false);
  assert.equal(helius, false);
  assert.ok(endpoints.length >= 1);
  assert.ok(endpoints[0].startsWith('https://'));
});

test('feedFromUrl: helius / zan / public', () => {
  assert.equal(feedFromUrl('https://mainnet.helius-rpc.com/?api-key=x'), 'helius');
  assert.equal(feedFromUrl('https://api.zan.top/node/v1/solana/mainnet/x'), 'zan');
  assert.equal(feedFromUrl('https://api.mainnet-beta.solana.com'), 'public-rpc');
  assert.equal(feedFromUrl(null), 'public-rpc');
});

test('getFeedStats/formatFeedStats: nol saat belum ada panggilan RPC', () => {
  const s = getFeedStats();
  assert.deepEqual(s, { helius: { ok: 0, fail: 0 }, zan: { ok: 0, fail: 0 }, 'public-rpc': { ok: 0, fail: 0 } });
  assert.equal(formatFeedStats(s), 'helius: ok 0/0 · zan: ok 0/0 · public-rpc: ok 0/0');
});