import { Candle, OrderBook, ExchangeFeedStatus, MarketDataSource, Timeframe } from "../types";
import { generateCandlesForTimeframe, generateOrderBook } from "../logic/indicators";

export interface MarketFeedResult {
  symbol: string;
  currentPrice: number;
  candles15m: Candle[];
  candles4h: Candle[];
  orderBook: OrderBook;
  status: ExchangeFeedStatus;
  /** F-02: true bila candles15m/4h dari exchange; false bila digenerate lokal
      (direct-ticker branch & synthetic branch) — untuk label TF yang jujur. */
  candlesReal: boolean;
  ticker24h: {
    high: number;
    low: number;
    priceChangePercent: number;
    volumeUSD: number;
  };
}

/**
 * Fetch real live market data with multi-exchange fallback:
 * 1. Server-proxied /api/market-feed (chain Vision → Gate → Bybit → primer → CCXT)
 * 2. Client-direct Binance ticker (harga real, candle tetap sintetis → candlesReal:false)
 * 3. Pure synthetic simulation if offline or network restricted
 */
export async function fetchLiveMarketData(
  symbol: string = "BTC/USDT",
  fallbackBasePrice: number = 68420
): Promise<MarketFeedResult> {
  const startTime = Date.now();
  const rawSymbol = symbol.replace("/", "").toUpperCase();

  try {
    const res = await fetch(`/api/market-feed?symbol=${encodeURIComponent(rawSymbol)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.currentPrice && data.candles15m?.length > 0) {
        return {
          symbol,
          currentPrice: data.currentPrice,
          candles15m: data.candles15m,
          candles4h: data.candles4h || generateCandlesForTimeframe(data.currentPrice, "4h", 35),
          orderBook: data.orderBook || generateOrderBook(data.currentPrice),
          // F-02: bila 4h digenerate lokal (fallback baris di atas), flag jadi false.
          candlesReal: !data.candles4h ? false : true,
          ticker24h: data.ticker24h || {
            high: data.currentPrice * 1.025,
            low: data.currentPrice * 0.978,
            priceChangePercent: 2.14,
            volumeUSD: 2450000000,
          },
          status: {
            source: data.source as MarketDataSource,
            latencyMs: data.latencyMs || (Date.now() - startTime),
            lastSyncTimestamp: Date.now(),
            // F-12: Vision/Gate/Bybit = data REAL (isLive:true). "KRAKEN_FALLBACK"
            // dihapus dari daftar (tidak pernah jadi source aktual di chain manapun).
            isLive: data.success !== false && data.source !== "SIMULATED",
            activeEndpoint: data.source === "BINANCE_LIVE" ? "api.binance.com/v3" : data.source === "BYBIT_FALLBACK" ? "api.bybit.com/v5" : "internal-router",
          },
        };
      }
    }
  } catch (err) {
    console.warn("Error calling /api/market-feed, falling back to client-direct or simulated feed:", err);
  }

  // Client-side Direct Binance attempt (CORS-friendly public endpoint)
  try {
    const binanceTickerRes = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${rawSymbol}`, {
      cache: "no-cache",
    });
    if (binanceTickerRes.ok) {
      const tickerJson = await binanceTickerRes.json();
      const realPrice = parseFloat(tickerJson.price);
      if (!isNaN(realPrice) && realPrice > 0) {
        const candles15m = generateCandlesForTimeframe(realPrice, "15m", 35);
        const candles4h = generateCandlesForTimeframe(realPrice, "4h", 35);
        return {
          symbol,
          currentPrice: realPrice,
          candles15m,
          candles4h,
          orderBook: generateOrderBook(realPrice),
          // F-02: harga ticker real, tapi candle digenerate lokal → label sintetis.
          candlesReal: false,
          ticker24h: {
            high: Number((realPrice * 1.022).toFixed(2)),
            low: Number((realPrice * 0.981).toFixed(2)),
            priceChangePercent: 1.85,
            volumeUSD: 1850000000,
          },
          status: {
            source: "BINANCE_LIVE",
            latencyMs: Date.now() - startTime,
            lastSyncTimestamp: Date.now(),
            isLive: true,
            activeEndpoint: "api.binance.com/api/v3/ticker/price",
          },
        };
      }
    }
  } catch (directErr) {
    // If browser CORS blocks direct binance call, gracefully proceed to fallback
  }

  // Pure Synthetic Fallback
  const candles15m = generateCandlesForTimeframe(fallbackBasePrice, "15m", 35);
  const candles4h = generateCandlesForTimeframe(fallbackBasePrice, "4h", 35);
  return {
    symbol,
    currentPrice: fallbackBasePrice,
    candles15m,
    candles4h,
    orderBook: generateOrderBook(fallbackBasePrice),
    candlesReal: false,
    ticker24h: {
      high: Number((fallbackBasePrice * 1.018).toFixed(2)),
      low: Number((fallbackBasePrice * 0.984).toFixed(2)),
      priceChangePercent: 1.25,
      volumeUSD: 850000000,
    },
    status: {
      source: "SIMULATED",
      latencyMs: Date.now() - startTime,
      lastSyncTimestamp: Date.now(),
      isLive: false,
      activeEndpoint: "offline-synthetic-engine",
    },
  };
}

/**
 * Sumber candle per-TF (F-02): tiap fetch TF wajib berlabel agar FE bisa
 * bedakan data real vs sintetis — badge agregat market-feed TIDAK cukup.
 */
export type CandleSource = "REAL" | "SYNTHETIC";

export interface KlinesResult {
  candles: Candle[];
  source: CandleSource;
  /** Exchange hulu bila real (BINANCE_VISION/GATE_IO/direct-Binance), "GENERATOR" bila sintetis. */
  origin: string;
}
/**
 * Fetch dedicated candles for any specific timeframe (1s to 1W)
 * Calls /api/klines with graceful fallback to client Binance or high-fidelity synthetic model.
 * F-02: return wrapper berlabel { candles, source, origin } — BUKAN array
 * polos — agar FE tidak pernah render candle sintetis seolah data real.
 */
export async function fetchKlinesForTimeframe(
  symbol: string,
  timeframe: Timeframe,
  basePrice: number = 64250,
  limit: number = 45
): Promise<KlinesResult> {
  const rawSymbol = symbol.replace("/", "").toUpperCase();

  // Try server proxy /api/klines
  try {
    const res = await fetch(`/api/klines?symbol=${encodeURIComponent(rawSymbol)}&interval=${timeframe}&limit=${limit}`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.candles) && data.candles.length > 0) {
        return { candles: data.candles, source: "REAL", origin: String(data.source || "SERVER_CHAIN") };
      }
    }
  } catch (err) {
    // Graceful fallback to direct Binance or synthetic
  }

  // If 1s requested, generate fast micro candles around basePrice
  if (timeframe === "1s") {
    return { candles: generateCandlesForTimeframe(basePrice, "1s", limit), source: "SYNTHETIC", origin: "GENERATOR" };
  }

  // Direct Binance public klines attempt
  try {
    let interval = "15m";
    if (timeframe === "1m") interval = "1m";
    else if (timeframe === "5m") interval = "5m";
    else if (timeframe === "15m") interval = "15m";
    else if (timeframe === "1h") interval = "1h";
    else if (timeframe === "4h") interval = "4h";
    else if (timeframe === "1D") interval = "1d";
    else if (timeframe === "1W") interval = "1w";

    const binanceRes = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${rawSymbol}&interval=${interval}&limit=${limit}`
    );
    if (binanceRes.ok) {
      const rawKlines = await binanceRes.json();
      if (Array.isArray(rawKlines) && rawKlines.length > 0) {
        return {
          candles: rawKlines.map((k: any) => ({
            timestamp: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
          })),
          source: "REAL",
          origin: "BINANCE_DIRECT",
        };
      }
    }
  } catch (directErr) {
    // Fallback to generator
  }

  return { candles: generateCandlesForTimeframe(basePrice, timeframe, limit), source: "SYNTHETIC", origin: "GENERATOR" };
}