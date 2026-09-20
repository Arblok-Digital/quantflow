import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKolDb } from './lib/kolDb.js';
import { kolScan } from './kolScan.js';
import { anomaly } from './anomaly.js';
import { fetchRugCheck } from './fundamentals.js';
import { sentimentGap } from './sentiment.js';
import { scoreCandidates } from './signal.js';
import { mockMarket } from './mock.js';
import { resolveMintMeta } from './lib/rpc.js';
import { discoverBoosted, IGNORE_MINTS } from './lib/dexscreener.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'output');
const OUT_FILE = path.join(OUT_DIR, 'report.json');

const MOCK_TOKENS = mockMarket();

function buildReportFromScored(scored, meta, crawlInfo) {
  const counts = { ALPHA: 0, BUY: 0, WATCH: 0, SKIP: 0 };
  for (const s of scored) if (counts[s.verdict.tier] != null) counts[s.verdict.tier]++;

  return {
    meta,
    crawlInfo: crawlInfo || {
      detecting: 'Kolabo wallet default; bukan token. Newborn via PumpPortal WS adalah fase lanjutan.',
      gapNote: 'Sentimen/narasi belum ditarik — gap kolaboratif belum dihitung.',
    },
    summary: { counts, total: scored.length },
    tokens: scored.map((s) => ({
      mint: s.mint,
      symbol: s.symbol,
      name: s.name,
      ageHours: s.ageHours,
      kol: {
        count: s.count,
        verifiedCount: s.verifiedCount,
        maxFollowers: s.maxFollowers,
        holders: s.holders,
      },
      fundamentals: s.fundamentals,
      verdict: s.verdict,
    })),
  };
}

function writeReport(report) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, OUT_FILE); // atomic: pembaca tak pernah lihat file parsiil
  console.log(`Report ditulis: ${OUT_FILE}`);
  return OUT_FILE;
}

async function live({ limit, maxWallets }) {
  const db = loadKolDb();
  console.log(`KOL DB: ${db.kols.length} wallet, ${db.verifiedCount} verified`);
  console.log(`Mode LIVE — Helius: ${process.env.HELIUS_API_KEY ? 'dipakai (env)' : 'fallback public RPC'}`);

  const { walletResults, tokenToKols } = await kolScan({ limit, maxWallets, onProgress: (p) => {
    process.stdout.write(`\r  [${p.scanned}/${p.total}] wallet OK ${p.ok}`);
  } });
  console.log('\nWallet scan selesai');

  const candidates = anomaly(tokenToKols, walletResults).slice(0, limit);
  console.log(`Kandidat (≥1 KOL pegang): ${candidates.length}`);

  const fundamentalsMap = new Map();
  for (const c of candidates) {
    const f = await fetchRugCheck(c.mint);
    fundamentalsMap.set(c.mint, f);
    await new Promise((r) => setTimeout(r, 350));
  }

  // Usia diambil dari DexScreener (pairCreatedAt) — bukan NaN lagi. Token
  // tanpa pair DexScreener (baru/recently delisted) -> ageHours null.
  for (const c of candidates) {
    const meta = await resolveMintMeta(c.mint);
    c.symbol = meta.symbol;
    c.name = meta.name;
    c.decimals = meta.decimals;
    c.ageHours = meta.ageHours ?? null;
  }

  const scored = scoreCandidates(candidates, fundamentalsMap);
  const header = {
    mode: 'live',
    generatedAt: new Date(),
    engine: 'kol-first v0.1',
    limit,
    maxWallets,
    feeds: { rpc: process.env.HELIUS_API_KEY ? 'helius' : 'public-rpc', rugcheck: 'api.rugcheck.xyz' },
  };
  return buildReportFromScored(scored, header);
}

async function mock() {
  const header = {
    mode: 'mock',
    generatedAt: new Date(),
    engine: 'kol-first v0.1',
    note: 'Data deterministik untuk demo; bukan hasil scan real.',
  };
  return buildReportFromScored(MOCK_TOKENS, header);
}

async function discovery({ limit = 50, maxMcap = 5_000_000, minLiq = 0 }) {
  console.log(`Mode DISCOVERY — DexScreener token-boosts (bottom-up, market-cap ≤ $${maxMcap.toLocaleString()})`);
  const cands = await discoverBoosted({ limit, maxMcap, minLiq });
  console.log(`Kandidat dari boost: ${cands.length}`);

  const fundamentalsMap = new Map();
  for (const c of cands) {
    const f = await fetchRugCheck(c.mint);
    // RugCheck sering null liquidity untuk token pumpfun — dalam mode discovery
    // DexScreener adalah sumber utama: fallback pakai liquidity pair-nya.
    if (f && (f.liquidityUsd === null || f.liquidityUsd === undefined) && c.liquidityUsd > 0) {
      f.liquidityUsd = c.liquidityUsd;
    }
    fundamentalsMap.set(c.mint, f);
    await new Promise((r) => setTimeout(r, 350));
  }

  // Kandidat discovery belum punya info KOL — kol kosong (skor murni dari
  // fundamentals + age). Tambahan KOL overlay = fase lanjutan.
  const candidates = cands.map((c) => ({
    mint: c.mint,
    symbol: c.symbol,
    name: c.name,
    decimals: c.decimals,
    ageHours: c.ageHours,
    count: 0,
    verifiedCount: 0,
    maxFollowers: 0,
    holders: [],
  }));

  const scored = scoreCandidates(candidates, fundamentalsMap);
  const header = {
    mode: 'discovery',
    generatedAt: new Date(),
    engine: 'dexscreener-boosts v0.1',
    limit,
    maxMcap,
    minLiq,
    feeds: { dex: 'api.dexscreener.com', rugcheck: 'api.rugcheck.xyz' },
  };
  const crawlInfo = {
    detecting: 'Bottom-up dari token-boosts DexScreener (bukan KOL-first). KOL overlay belum ada.',
    gapNote: 'Sentimen/narasi belum ditarik; KOL concurrency belum dihitung (0 KOL).',
  };
  return buildReportFromScored(scored, header, crawlInfo);
}

const args = process.argv.slice(2);
if (args[0] === '--mock') {
  mock().then(writeReport).catch((e) => { console.error(e); process.exit(1); });
} else if (args[0] === '--discovery') {
  const limit = parseInt(args[args.indexOf('--limit') + 1] || '50', 10);
  const maxMcap = parseInt(args[args.indexOf('--max-mcap') + 1] || '5000000', 10);
  const minLiq = parseInt(args[args.indexOf('--min-liq') + 1] || '0', 10);
  discovery({ limit, maxMcap, minLiq }).then(writeReport).catch((e) => { console.error(e); process.exit(1); });
} else {
  const limit = parseInt(args[args.indexOf('--limit') + 1] || '30', 10);
  const maxWallets = parseInt(args[args.indexOf('--wallets') + 1] || '20', 10);
  live({ limit, maxWallets }).then(writeReport).catch((e) => { console.error(e); process.exit(1); });
}