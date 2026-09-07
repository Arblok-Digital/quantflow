/**
 * Scanner Engine — Client-side port of Keel's all-ticker-scanner concept.
 *
 * Fetches tickers from Binance public API (CORS-friendly) and computes
 * a liquidity/SMT score per ticker. Top-N results are enriched with
 * orderbook depth estimation where available.
 *
 * Honesty invariant: liquidityUsd=0 and dataSource='N/A' when
 * orderbook enrichment is not yet available (no fabricated numbers).
 */

export interface ScannerCandidate {
  symbol: string;
  price: number;
  change24hPct: number;
  volumeUsd24h: number;
  bid: number | null;
  ask: number | null;
  score: number;
  flow: "ACCUMULATION" | "DISTRIBUTION" | "NEUTRAL";
  liquidityUsd: number;
  liquidityDataSource: "ORDERBOOK" | "N/A";
  mtfAlignment: boolean;
}

type Flow = ScannerCandidate["flow"];

const STABLE = new Set(["USDT", "USDC", "DAI", "FDUSD", "USDE", "TUSD", "USDD", "PYUSD", "BUSD"]);

function computeScore(t: { price: number; change: number; volume: number }, volMedian: number): { score: number; flow: Flow } {
  const volSpike = t.volume / Math.max(1, volMedian);
  const isMajor = t.volume > 5_000_000_000;
  let volScore = Math.min(22, Math.max(-8, Math.log10(Math.max(0.5, volSpike)) * 14));
  if (isMajor) volScore *= 0.35;
  const changeAbs = Math.abs(t.change);
  const stealth = t.change >= -0.8 && t.change <= 2.2 && volSpike > 1.7 ? 18
    : changeAbs < 1.2 && volSpike > 1.35 ? 10
    : changeAbs > 5.5 ? -16 : -2;
  const damp = t.change < -3.5 ? -10 : 0;
  let score = Math.round(44 + volScore + stealth + damp);
  score = Math.max(18, Math.min(89, score));
  let flow: Flow = "NEUTRAL";
  if (score >= 66 && t.change >= -1.2 && volSpike > 1.4) flow = "ACCUMULATION";
  else if (t.change < -3.8 || score < 36) flow = "DISTRIBUTION";
  return { score, flow };
}

/**
 * Fetch all USDT tickers from Binance public API and score them.
 * Top-N are returned sorted by score descending.
 */
export async function fetchScannerCandidates(limit: number = 20): Promise<{
  top: ScannerCandidate[];
  allCount: number;
}> {
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", { cache: "no-cache" });
    if (!res.ok) return { top: [], allCount: 0 };
    const tickers: Array<{
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
      quoteVolume: string;
      bidPrice: string;
      askPrice: string;
    }> = await res.json();

    // Filter to USDT pairs only
    const usdtTickers = tickers.filter((t) => {
      if (!t.symbol.endsWith("USDT")) return false;
      const base = t.symbol.replace("USDT", "");
      return !STABLE.has(base) && !["USD1", "USDG", "USDX"].includes(base);
    });

    // Compute median volume
    const volumes = usdtTickers
      .map((t) => Number(t.quoteVolume))
      .filter((v) => v > 300_000)
      .sort((a, b) => a - b);
    const volMedian = volumes.length > 0 ? volumes[Math.floor(volumes.length / 2)] : 800_000;

    // Score all
    const all: ScannerCandidate[] = [];
    for (const t of usdtTickers) {
      const price = Number(t.lastPrice);
      if (!price || price <= 0) continue;
      const vol = Number(t.quoteVolume);
      if (vol < 300_000) continue;
      const change = Number(t.priceChangePercent);
      const { score, flow } = computeScore({ price, change, volume: vol }, volMedian);
      all.push({
        symbol: t.symbol,
        price,
        change24hPct: change,
        volumeUsd24h: vol,
        bid: Number(t.bidPrice) || null,
        ask: Number(t.askPrice) || null,
        score,
        flow,
        liquidityUsd: 0,
        liquidityDataSource: "N/A",
        mtfAlignment: false,
      });
    }

    all.sort((a, b) => b.score - a.score);
    return { top: all.slice(0, limit), allCount: all.length };
  } catch {
    return { top: [], allCount: 0 };
  }
}
