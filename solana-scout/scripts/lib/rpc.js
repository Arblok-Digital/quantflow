import https from 'node:https';
import { dexscreenerGet, pairToMeta, pickMainPair } from './dexscreener.js';

export const HELIUS_KEY = process.env.HELIUS_API_KEY || '';
export const HELIUS_RPC = HELIUS_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`
  : null;
// ZAN (Ant Group) — credit-based free tier, murah utk history reads
// (getSignaturesForAddress 40ct, getTransaction 50ct, ~150–300M credit/bln).
// HTTPS-only di free plan. Urutan prioritas: Helius > ZAN > public.
export const ZAN_API_KEY = process.env.ZAN_API_KEY || '';
export const ZAN_RPC = ZAN_API_KEY
  ? `https://api.zan.top/node/v1/solana/mainnet/${ZAN_API_KEY}`
  : null;

// Endpoint dibaca LAZY (per-call) supaya tes bisa set env kapan saja tanpa
// memikirkan urutan import ESM — rpcCall selalu memakai nilai env terbaru.
export function buildRpcEndpoints() {
  const endpoints = [];
  if (process.env.HELIUS_API_KEY) endpoints.push(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`);
  if (process.env.ZAN_API_KEY) endpoints.push(`https://api.zan.top/node/v1/solana/mainnet/${process.env.ZAN_API_KEY}`);
  endpoints.push(...PUBLIC_RPCS);
  return { helius: !!process.env.HELIUS_API_KEY, zan: !!process.env.ZAN_API_KEY, endpoints };
}

let lastOkUrl = null;

export function feedFromUrl(url) {
  if (!url) return 'public-rpc';
  if (url.startsWith('https://mainnet.helius-rpc.com')) return 'helius';
  if (url.startsWith('https://api.zan.top')) return 'zan';
  return 'public-rpc';
}

export function lastFeed() {
  return feedFromUrl(lastOkUrl);
}

const feedStats = {
  helius: { ok: 0, fail: 0 },
  zan: { ok: 0, fail: 0 },
  'public-rpc': { ok: 0, fail: 0 },
};

export function getFeedStats() {
  return {
    helius: { ...feedStats.helius },
    zan: { ...feedStats.zan },
    'public-rpc': { ...feedStats['public-rpc'] },
  };
}

export function formatFeedStats(stats = getFeedStats()) {
  return Object.entries(stats)
    .map(([k, v]) => `${k}: ok ${v.ok}/${v.ok + v.fail}`)
    .join(' · ');
}
// Endpoint publik tanpa key — diverifikasi hidup 2026-09-19.
export const PUBLIC_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana.leorpc.com/?api_key=FREE',
  'https://public.rpc.solanavibestation.com',
  'https://api.uniblock.dev/uni/v1/json-rpc?chainId=solana',
  'https://solana-mainnet.gateway.tatum.io/',
];

const META_CACHE_TTL_MS = 60 * 60 * 1000; // 1 jam
const metaCache = new Map();

export function rpcRequest(url, method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = https.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            const err = new Error(`HTTP ${res.statusCode}: ${data.substring(0, 140)}`);
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(body);
    req.end();
  });
}

export async function rpcList(requests) {
  const results = [];
  for (const { method, params } of requests) {
    results.push(await rpcCall(method, params));
  }
  return results;
}

export async function rpcCall(method, params, opts = {}) {
  const { attempts = 2, timeoutMs = 15000 } = opts;
  const { endpoints } = buildRpcEndpoints();

  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const url of endpoints) {
      try {
        const resp = await rpcRequest(url, method, params, timeoutMs);
        if (resp.error) throw new Error(resp.error.message);
        lastOkUrl = url;
        feedStats[feedFromUrl(url)].ok++;
        return resp.result;
      } catch (e) {
        lastErr = e;
        feedStats[feedFromUrl(url)].fail++;
        if (process.env.RPC_TRACE) console.error(`[rpc] ${feedFromUrl(url)} ${method} FAIL: ${e.message}`);
        if (e?.statusCode === 429) await sleep(400 * (attempt + 1));
      }
    }
    if (attempt < attempts - 1) await sleep(300 * (attempt + 1));
  }
  throw new Error(`All ${endpoints.length} RPC endpoints failed. Last: ${lastErr?.message}`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function shortMint(mint) {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export async function resolveMintMeta(mint, now = Date.now()) {
  const cached = metaCache.get(mint);
  if (cached && Date.now() - cached.ts < META_CACHE_TTL_MS) return cached.meta;

  let meta = await dexMeta(mint, now);
  if (!meta) {
    // DexScreener tidak punya pair (sangat baru / tak ter-index) — fallback Helius DAS.
    if (HELIUS_RPC) {
      try {
        const resp = await rpcRequest(HELIUS_RPC, 'getAsset', { id: mint }, 12000);
        const m = resp?.result?.content?.metadata;
        if (m?.symbol || m?.name) {
          meta = {
            symbol: m.symbol || shortMint(mint),
            name: m.name || m.symbol || mint,
            decimals: m.decimals ?? null,
            ageHours: null,
          };
        }
      } catch {
        /* fallback ke RPC biasa */
      }
    }
  }
  if (!meta) {
    try {
      const info = await rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
      const parsed = info?.value?.data?.parsed;
      const decimals = parsed?.info?.decimals ?? null;
      meta = { symbol: shortMint(mint), name: mint, decimals, ageHours: null };
    } catch {
      meta = { symbol: shortMint(mint), name: mint, decimals: null, ageHours: null };
    }
  }
  metaCache.set(mint, { meta, ts: Date.now() });
  return meta;
}

// Meta dari DexScreener: symbol/name ASLI (bukan shortMint) + ageHours dari
// pairCreatedAt. DexScreener tidak menyediakan decimals -> null (diisi RPC bila perlu).
async function dexMeta(mint, now) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
  try {
    const resp = await dexscreenerGet(`/latest/dex/tokens/${mint}`, 12000);
    const main = pickMainPair(resp?.pairs);
    if (!main) return null;
    const m = pairToMeta(main, now);
    if (!m.symbol && !m.name) return null;
    return {
      symbol: m.symbol || shortMint(mint),
      name: m.name || m.symbol || mint,
      decimals: null,
      ageHours: m.ageHours,
      market: {
        priceUsd: m.priceUsd,
        priceChangeH24: m.priceChangeH24,
        volumeH1: m.volumeH1,
        volumeH24: m.volumeH24,
        txnsH1: m.txnsH1,
        txnsH24: m.txnsH24,
        liquidityUsd: m.liquidityUsd,
      },
    };
  } catch {
    return null;
  }
}