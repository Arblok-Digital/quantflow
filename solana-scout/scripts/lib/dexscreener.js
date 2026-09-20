// ---------------------------------------------------------------------------
// dexscreener.js — client DexScreener (free, tanpa auth) untuk solana-scout.
// DexScreener memblokir request tanpa User-Agent browser -> UA default.
// Endpoint:
//   GET /token-boosts/latest/v1          -> token yang sedang di-boost (trending)
//   GET /latest/dex/tokens/<CA1,CA2,...> -> pair data (batch sampai 30 CA)
// Fungsi pure (pickMainPair/pairToMeta/filterBoosted/candidatesFromDiscovery)
// di-test tanpa jaringan di tests/dexscreener.test.js.
// ---------------------------------------------------------------------------
import https from 'node:https';

export const DEX_BASE = 'https://api.dexscreener.com';
export const DEX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Alamat khusus yang bukan token meme (wrapped SOL / stablecoin) — jangan
// pernah tampil sebagai kandidat discovery.
export const IGNORE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

export function dexscreenerGet(path, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `${DEX_BASE}${path}`,
      { headers: { Accept: 'application/json', 'User-Agent': DEX_UA } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            const err = new Error(`DexScreener HTTP ${res.statusCode}: ${data.substring(0, 140)}`);
            err.statusCode = res.statusCode;
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`DexScreener JSON parse: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
  });
}

// Pilih pair utama: likuiditas tertinggi (fallback volume), skip pair tanpa baseToken.
export function pickMainPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  const scored = pairs
    .map((p, i) => ({
      p,
      i,
      liq: Number(p?.liquidity?.usd) || 0,
      vol: Number(p?.volume?.h24) || 0,
    }))
    .filter((x) => x.p?.baseToken?.address);
  if (scored.length === 0) return null;
  scored.sort((a, b) => {
    if (b.liq !== a.liq) return b.liq - a.liq;
    if (b.vol !== a.vol) return b.vol - a.vol;
    return a.i - b.i;
  });
  return scored[0].p;
}

// Ekstrak meta token dari satu pair DexScreener. DexScreener tidak menyediakan
// decimals — tetap null di sini (resolveMintMeta melengkapinya via RPC bila perlu).
export function pairToMeta(pair, now = Date.now()) {
  const base = pair?.baseToken || {};
  const created = Number(pair?.pairCreatedAt) || 0;
  return {
    mint: base.address || null,
    symbol: base.symbol || null,
    name: base.name || null,
    decimals: null,
    ageHours: created > 0 ? Math.max(0, (now - created) / 3_600_000) : null,
    liquidityUsd: Number(pair?.liquidity?.usd) || 0,
    marketCap: Number(pair?.marketCap) || null,
    fdv: Number(pair?.fdv) || null,
    dexId: pair?.dexId || null,
    pairAddress: pair?.pairAddress || null,
    pairCreatedAt: created,
    chainId: pair?.chainId || null,
    // Data harga/volume — dipakai gate MID_PUMP_EXIT (exit-liquidity guard).
    priceUsd: Number(pair?.priceUsd) || null,
    priceChangeH24: pair?.priceChange?.h24 != null ? Number(pair.priceChange.h24) : null,
    volumeH1: pair?.volume?.h1 != null ? Number(pair.volume.h1) : null,
    volumeH24: Number(pair?.volume?.h24) || null,
    txnsH1: pair?.txns?.h1?.buys ?? null,
    txnsH24: pair?.txns?.h24?.buys ?? null,
  };
}

// Dari response /token-boosts/latest/v1: hanya solana, dedupe, buang wrapped/stable.
export function filterBoosted(boots) {
  if (!Array.isArray(boots)) return [];
  const seen = new Set();
  const out = [];
  for (const b of boots) {
    const ca = b?.tokenAddress;
    if (!ca || b?.chainId !== 'solana') continue;
    if (IGNORE_MINTS.has(ca)) continue;
    if (seen.has(ca)) continue;
    seen.add(ca);
    out.push(ca);
  }
  return out;
}

// Gabungkan boosted mint + pairsByMint -> kandidat discovery (main pair per token,
// filter maxMcap, urut sesuai urutan boosts, batasi limit). Murni — di-test langsung.
export function candidatesFromDiscovery(
  boostedMints,
  pairsByMint,
  { limit = Infinity, maxMcap = 5_000_000, now = Date.now() } = {}
) {
  const out = [];
  for (const mint of boostedMints) {
    const pairs = pairsByMint.get(mint) || [];
    const main = pickMainPair(pairs);
    if (!main) continue;
    const meta = pairToMeta(main, now);
    // marketCap null (token sangat baru) -> tetap masuk, biar gate yang menilai.
    if (meta.marketCap && maxMcap > 0 && meta.marketCap > maxMcap) continue;
    out.push(meta);
    if (out.length >= limit) break;
  }
  return out;
}

// Orkestrasi lengkap: boosts -> batch pair data -> kandidat.
export async function discoverBoosted({ limit = 50, maxMcap = 5_000_000, minLiq = 0, now = Date.now() } = {}) {
  limit = Number.isFinite(limit) ? limit : 50;
  maxMcap = Number.isFinite(maxMcap) ? maxMcap : 5_000_000;
  minLiq = Number.isFinite(minLiq) ? minLiq : 0;
  const boosts = await dexscreenerGet('/token-boosts/latest/v1');
  const mints = filterBoosted(boosts);
  const pairsByMint = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const resp = await dexscreenerGet(`/latest/dex/tokens/${chunk.join(',')}`);
    const pairs = Array.isArray(resp?.pairs) ? resp.pairs : [];
    for (const p of pairs) {
      const base = p?.baseToken?.address;
      if (!base) continue;
      if (!pairsByMint.has(base)) pairsByMint.set(base, []);
      pairsByMint.get(base).push(p);
    }
  }
  let cands = candidatesFromDiscovery(mints, pairsByMint, { limit, maxMcap, now });
  if (minLiq > 0) cands = cands.filter((c) => c.liquidityUsd >= minLiq);
  return cands;
}