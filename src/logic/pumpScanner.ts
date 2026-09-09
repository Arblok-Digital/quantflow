/**
 * PUMP RADAR — Scanner microcap Gate.io SPOT.
 * Mendeteksi dini kandidat pump berbasis momentum + volume.
 * ALERT ONLY — tidak ada jalur eksekusi order di modul ini.
 *
 * Sumber kebenaran: GET https://api.gateio.ws/api/v4/spot/tickers
 * Fail-closed jujur: fetch error / empty → return [] (TIDAK pernah fabricate).
 */

export interface GateTicker {
  currency_pair?: string;
  last?: string;
  lowest_ask?: string;
  highest_bid?: string;
  change_percentage?: string;
  base_volume?: string;
  quote_volume?: string;
  high_24h?: string;
  low_24h?: string;
}

export type PumpHeat = "HOT" | "WATCH" | "COLD";

export interface PumpScanResult {
  symbol: string;
  price: number;
  changePct24h: number;
  quoteVolumeUsd: number;
  marketCapUsd: number;
  score: number;
  heat: PumpHeat;
  reasons: string[];
}

export interface PumpScoreComponents {
  momentum: number;       // change_percentage (24h) dalam unit persen-number, e.g. +30 => 30
  volSurge: number;       // multiplier volume intraday (15m vs avg), 0 kalau data tak tersedia
  spreadPct: number | null;
  spreadNarrow: number;   // 1 (<1%), 0.5 (<2%), else 0
  ageBonus: number;       // selalu 0 — listing age tidak tersedia dari tickers (fail-closed)
  power: number;          // min(10, volSurge*2 + momentum*1.5 + spreadNarrow + ageBonus)
  score: number;          // 10 ** power
  heat: PumpHeat;
}

const TICKERS_URL = "https://api.gateio.ws/api/v4/spot/tickers";
const FETCH_TIMEOUT_MS = 8_000;
const CANDLE_TIMEOUT_MS = 5_000;

export const MICROCAP_THRESHOLD_USD = 5_000_000;
export const MIN_QUOTE_VOLUME_USD = 10_000;
export const MIN_PRICE = 0.000001;
export const MAX_CANDIDATES = 20;
const CANDLE_PREVIEW = 25;

const STABLECOIN_BASES = new Set<string>([
  "USDT", "USDC", "DAI", "TUSD", "BUSD", "USDP", "FDUSD", "UST", "USTC", "USDD",
  "USDJ", "USD1", "PYUSD", "GUSD", "SUSD", "XSGD", "EURS", "EURT", "EUROC",
  "AEUR", "CEUR", "XUSD", "USDE", "USDL", "USDY", "USDX", "USDC.E",
]);

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parsePair(pair: string | undefined): { base: string; quote: string } | null {
  if (!pair) return null;
  const idx = pair.indexOf("_");
  if (idx <= 0 || idx === pair.length - 1) return null;
  return { base: pair.slice(0, idx), quote: pair.slice(idx + 1) };
}

function heatFromPower(power: number): PumpHeat {
  if (power >= 7) return "HOT";
  if (power >= 5) return "WATCH";
  return "COLD";
}

const fmtUsdShort = (n: number): string =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`;

/**
 * Scoring momentum — DETERMINISTIC & PURE.
 * Tidak punya efek samping; input sama => output sama.
 *
 * Formula: score = 10 ** min(10, volSurge*2 + momentum*1.5 + spreadNarrow*1 + ageBonus)
 * 'momentum' dalam unit persen-number (change_percentage 24h), volSurge multiplier
 * volume intraday (fallback 0 bila data intraday tak tersedia). ageBonus selalu 0
 * (listing age tidak bisa di-detect dari /spot/tickers — JANGAN fabricate).
 */
export function computePumpScore(
  ticker: GateTicker,
  opts: { volSurge?: number; ageBonus?: number } = {}
): PumpScoreComponents {
  const last = num(ticker.last);
  const ask = num(ticker.lowest_ask);
  const bid = num(ticker.highest_bid);

  const momentum = num(ticker.change_percentage) ?? 0;

  const spreadPct =
    last && last > 0 && ask != null && bid != null && ask >= 0 && bid >= 0
      ? ((ask - bid) / last) * 100
      : null;
  const spreadNarrow = spreadPct == null ? 0 : spreadPct < 1 ? 1 : spreadPct < 2 ? 0.5 : 0;

  const volSurge = Number.isFinite(opts.volSurge) && (opts.volSurge ?? 0) > 1 ? Math.min(20, opts.volSurge!) : 0;
  const ageBonus = Number.isFinite(opts.ageBonus) && (opts.ageBonus ?? 0) > 0 ? opts.ageBonus! : 0;

  const raw = volSurge * 2 + momentum * 1.5 + spreadNarrow * 1 + ageBonus;
  const power = Math.max(0, Math.min(10, raw));
  const score = Math.pow(10, power);

  return { momentum, volSurge, spreadPct, spreadNarrow, ageBonus, power, score, heat: heatFromPower(power) };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AI-Trading-Agent-Engine/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

/**
 * Candle 15m Gate (fallback-only). Response Gate newest-first (konvensi marketFetcher):
 * k0=ts, k1=open/mapped, k2=high, k3=low, k4=close, k5=volume(base).
 * Fail-closed: gagal/empty → [].
 */
async function fetchGateCandlesVolumes(pair: string, interval = "15m", limit = 10): Promise<number[]> {
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(pair)}&interval=${interval}&limit=${limit}`;
  try {
    const data = await fetchWithTimeout(url, CANDLE_TIMEOUT_MS);
    if (!Array.isArray(data) || data.length === 0) return [];
    return data
      .slice()
      .reverse()
      .map((c: any) => num(Array.isArray(c) ? c[5] : undefined) ?? 0);
  } catch (err: any) {
    console.warn(`[pumpScanner] candles failed ${pair}: ${err?.message}`);
    return [];
  }
}

/**
 * VolSurge dari candle 15m: perbandingan rata-rata 2 candle terbaru vs rata-rata
 * 6 candle sebelumnya. < 6 candle (data tak cukup) → 0 (fail-closed, bukan fabricate).
 */
export function computeVolSurge(volumes: number[]): number {
  if (volumes.length < 6) return 0;
  const recent = volumes.slice(-2);
  const before = volumes.slice(0, -2).slice(-6);
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const beforeAvg = before.reduce((s, v) => s + v, 0) / before.length;
  if (recentAvg <= 0 || beforeAvg <= 0) return 0;
  return Math.min(20, recentAvg / beforeAvg);
}

/**
 * Scan microcap pump Gate.io SPOT.
 * Filter: quote USDT, non-stablecoin, numeric price, mikrokap proxy < $5M,
 * quoteVolume > $10k, price > 0.000001. Max 20 kandidat sorted score desc.
 * Fail-closed: fetch tickers error/empty → [] (NEVER fabricate).
 */
export async function scanGateMicrocapPumps(): Promise<PumpScanResult[]> {
  let tickers: any[];
  try {
    const data = await fetchWithTimeout(TICKERS_URL, FETCH_TIMEOUT_MS);
    if (!Array.isArray(data) || data.length === 0) {
      console.warn("[pumpScanner] tickers empty — fail-closed []");
      return [];
    }
    tickers = data;
  } catch (err: any) {
    console.warn(`[pumpScanner] tickers fetch failed — fail-closed []: ${err?.message}`);
    return [];
  }

  interface Candidate {
    ticker: GateTicker;
    symbol: string;
    price: number;
    quoteVolumeUsd: number;
    marketCapUsd: number;
    changePct24h: number;
    prelimPower: number;
  }
  const candidates: Candidate[] = [];

  for (const t of tickers) {
    const pair = parsePair(t?.currency_pair);
    if (!pair || pair.quote !== "USDT") continue;
    if (STABLECOIN_BASES.has(pair.base) || pair.base.startsWith("USDT")) continue;

    const last = num(t?.last);
    if (last == null || last <= MIN_PRICE) continue;

    const baseVolume = num(t?.base_volume) ?? 0;
    const quoteVolume = num(t?.quote_volume) ?? 0;
    if (quoteVolume <= MIN_QUOTE_VOLUME_USD) continue;

    const marketCapUsd = last * baseVolume; // proxy supply (volume 24h base)
    if (!(marketCapUsd < MICROCAP_THRESHOLD_USD)) continue;

    const ticker = t as GateTicker;
    const prelim = computePumpScore(ticker);
    candidates.push({
      ticker,
      symbol: `${pair.base}/${pair.quote}`,
      price: last,
      quoteVolumeUsd: quoteVolume,
      marketCapUsd,
      changePct24h: num(ticker.change_percentage) ?? 0,
      prelimPower: prelim.power,
    });
  }

  if (candidates.length === 0) return [];

  // Preview: peringkat awal pakai volSurge=0 → ambil top CANDLE_PREVIEW untuk
  // fetch volume intraday (jaga jumlah request tetap bounded).
  candidates.sort((a, b) => {
    const pa = a.prelimPower;
    const pb = b.prelimPower;
    if (pb !== pa) return pb - pa;
    if (b.changePct24h !== a.changePct24h) return b.changePct24h - a.changePct24h;
    return b.quoteVolumeUsd - a.quoteVolumeUsd;
  });
  const preview = candidates.slice(0, CANDLE_PREVIEW);

  // Fetch candle 15m paralel untuk volSurge nyata (fallback 0 bila gagal / tak cukup data).
  const candleResults = await Promise.allSettled(
    preview.map((c) => fetchGateCandlesVolumes(c.symbol.replace("/", "_"), "15m", 10))
  );

  const results: PumpScanResult[] = preview.map((c, i) => {
    const volumes = candleResults[i].status === "fulfilled" ? candleResults[i].value : [];
    const volSurge = computeVolSurge(volumes);
    const comp = computePumpScore(c.ticker, { volSurge });

    const reasons: string[] = [
      `momentum ${c.changePct24h >= 0 ? "+" : ""}${c.changePct24h.toFixed(1)}% (24h)`,
      `microcap ${fmtUsdShort(c.marketCapUsd)}`,
    ];
    if (comp.spreadPct != null) {
      reasons.push(`spread ${comp.spreadPct.toFixed(2)}%${comp.spreadNarrow === 1 ? " (tight <1%)" : ""}`);
    } else {
      reasons.push("spread N/A");
    }
    if (volSurge > 1) {
      reasons.push(`volume x${volSurge.toFixed(1)} (15m vs avg)`);
    } else {
      reasons.push("vol intraday tak tersedia — volSurge 0");
    }

    return {
      symbol: c.symbol,
      price: c.price,
      changePct24h: c.changePct24h,
      quoteVolumeUsd: c.quoteVolumeUsd,
      marketCapUsd: c.marketCapUsd,
      score: comp.score,
      heat: comp.heat,
      reasons,
    };
  });

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.changePct24h !== a.changePct24h) return b.changePct24h - a.changePct24h;
    return b.quoteVolumeUsd - a.quoteVolumeUsd;
  });

  return results.slice(0, MAX_CANDIDATES);
}