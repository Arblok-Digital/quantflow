/**
 * Robust Market Data Fetcher with Fallback Chain
 * Binance → Binance Vision → Gate.io → Bybit → Synthetic
 * Used by server.ts (market-feed, klines) and paperBook.ts (bracket monitor)
 */

import { getExchange, ensureMarketsLoaded } from "../../broker";

const KNOWN_QUOTES = ["FDUSD", "BUSD", "USDC", "USDT", "BTC", "ETH", "EUR", "USD"];
const KNOWN_QUOTES_SORTED = [...KNOWN_QUOTES].sort((a, b) => b.length - a.length);

interface ParsedSymbol { base: string; quote: string; raw: string; ccxt: string; }

function parseMarketSymbol(input: string): ParsedSymbol {
  const s = String(input || "BTC/USDT").trim().toUpperCase();
  let base = "";
  let quote = "USDT";
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    base = parts[0] || "BTC";
    quote = parts[1] || "USDT";
  } else {
    let matched = "";
    for (const q of KNOWN_QUOTES_SORTED) {
      if (s.endsWith(q) && s.length > q.length && q.length > matched.length) matched = q;
    }
    if (matched) { quote = matched; base = s.slice(0, -matched.length); }
    else base = s;
  }
  base = base || "BTC"; quote = quote || "USDT";
  return { base, quote, raw: `${base}${quote}`, ccxt: `${base}/${quote}` };
}

interface FetchResult<T> {
  data: T | null;
  source: string;
  error?: string;
}

// Generic fetch with timeout
async function fetchWithTimeout(url: string, timeoutMs = 3000): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AITradingAgentEngine/1.0" },
    });
    clearTimeout(id);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Try Binance primary
async function tryBinance(symbol: string): Promise<FetchResult<any>> {
  const parsed = parseMarketSymbol(symbol);
  const rawSymbol = parsed.raw;
  
  try {
    const [tickerData, klines15mData, klines4hData, depthData] = await Promise.all([
      fetchWithTimeout(`https://api.binance.com/api/v3/ticker/24hr?symbol=${rawSymbol}`),
      fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${rawSymbol}&interval=15m&limit=40`),
      fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${rawSymbol}&interval=4h&limit=40`),
      fetchWithTimeout(`https://api.binance.com/api/v3/depth?symbol=${rawSymbol}&limit=12`),
    ]);

    const candles15m = klines15mData.map((k: any) => ({
      timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    const candles4h = klines4hData.map((k: any) => ({
      timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));

    let bidAccum = 0;
    const bids = (depthData.bids || []).map((b: any) => {
      const price = parseFloat(b[0]); const size = parseFloat(b[1]);
      bidAccum += size;
      return { price, size: Number(size.toFixed(4)), total: Number(bidAccum.toFixed(4)) };
    });

    let askAccum = 0;
    const asks = (depthData.asks || []).map((a: any) => {
      const price = parseFloat(a[0]); const size = parseFloat(a[1]);
      askAccum += size;
      return { price, size: Number(size.toFixed(4)), total: Number(askAccum.toFixed(4)) };
    });

    const currentPrice = parseFloat(tickerData.lastPrice);

    return {
      data: {
        currentPrice,
        ticker24h: {
          high: parseFloat(tickerData.highPrice),
          low: parseFloat(tickerData.lowPrice),
          priceChangePercent: parseFloat(tickerData.priceChangePercent),
          volumeUSD: parseFloat(tickerData.quoteVolume),
        },
        candles15m,
        candles4h,
        orderBook: { bids, asks, spread: bids[0] && asks[0] ? Number((asks[0].price - bids[0].price).toFixed(2)) : 0.5 },
      },
      source: "BINANCE_LIVE",
    };
  } catch (err: any) {
    return { data: null, source: "BINANCE_LIVE", error: err?.message };
  }
}

// Try Binance Vision (data-api.binance.vision - often unblocked)
async function tryBinanceVision(symbol: string): Promise<FetchResult<any>> {
  const parsed = parseMarketSymbol(symbol);
  const rawSymbol = parsed.raw;
  
  try {
    const [tickerData, klines15mData, klines4hData, depthData] = await Promise.all([
      fetchWithTimeout(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${rawSymbol}`),
      fetchWithTimeout(`https://data-api.binance.vision/api/v3/klines?symbol=${rawSymbol}&interval=15m&limit=40`),
      fetchWithTimeout(`https://data-api.binance.vision/api/v3/klines?symbol=${rawSymbol}&interval=4h&limit=40`),
      fetchWithTimeout(`https://data-api.binance.vision/api/v3/depth?symbol=${rawSymbol}&limit=12`),
    ]);

    const candles15m = klines15mData.map((k: any) => ({
      timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));
    const candles4h = klines4hData.map((k: any) => ({
      timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
    }));

    let bidAccum = 0;
    const bids = (depthData.bids || []).map((b: any) => {
      const price = parseFloat(b[0]); const size = parseFloat(b[1]);
      bidAccum += size;
      return { price, size: Number(size.toFixed(4)), total: Number(bidAccum.toFixed(4)) };
    });

    let askAccum = 0;
    const asks = (depthData.asks || []).map((a: any) => {
      const price = parseFloat(a[0]); const size = parseFloat(a[1]);
      askAccum += size;
      return { price, size: Number(size.toFixed(4)), total: Number(askAccum.toFixed(4)) };
    });

    const currentPrice = parseFloat(tickerData.lastPrice);

    return {
      data: {
        currentPrice,
        ticker24h: {
          high: parseFloat(tickerData.highPrice),
          low: parseFloat(tickerData.lowPrice),
          priceChangePercent: parseFloat(tickerData.priceChangePercent),
          volumeUSD: parseFloat(tickerData.quoteVolume),
        },
        candles15m,
        candles4h,
        orderBook: { bids, asks, spread: bids[0] && asks[0] ? Number((asks[0].price - bids[0].price).toFixed(2)) : 0.5 },
      },
      source: "BINANCE_VISION",
    };
  } catch (err: any) {
    return { data: null, source: "BINANCE_VISION", error: err?.message };
  }
}

// Try Gate.io (often accessible)
async function tryGateIO(symbol: string): Promise<FetchResult<any>> {
  const parsed = parseMarketSymbol(symbol);
  const gateSymbol = parsed.base + "_" + parsed.quote; // BTC_USDT format
  
  try {
    const [tickerRes, klines15mRes, klines4hRes] = await Promise.all([
      fetchWithTimeout(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${gateSymbol}`),
      fetchWithTimeout(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${gateSymbol}&interval=15m&limit=40`),
      fetchWithTimeout(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${gateSymbol}&interval=4h&limit=40`),
    ]);

    const ticker = tickerRes?.[0];
    const k15mList = (klines15mRes || []).reverse();
    const k4hList = (klines4hRes || []).reverse();

    if (ticker && k15mList.length > 0) {
      const currentPrice = parseFloat(ticker.last);
      
      const candles15m = k15mList.map((k: any) => ({
        timestamp: parseInt(k[0]) * 1000, open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
      const candles4h = k4hList.map((k: any) => ({
        timestamp: parseInt(k[0]) * 1000, open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));

      return {
        data: {
          currentPrice,
          ticker24h: {
            high: parseFloat(ticker.high_24h || currentPrice * 1.02),
            low: parseFloat(ticker.low_24h || currentPrice * 0.98),
            priceChangePercent: parseFloat(ticker.change_percentage || "0.0"),
            volumeUSD: parseFloat(ticker.quote_volume || "50000000"),
          },
          candles15m,
          candles4h,
        },
        source: "GATE_IO",
      };
    }
    return { data: null, source: "GATE_IO", error: "No data returned" };
  } catch (err: any) {
    return { data: null, source: "GATE_IO", error: err?.message };
  }
}

// Try Bybit
async function tryBybit(symbol: string): Promise<FetchResult<any>> {
  const parsed = parseMarketSymbol(symbol);
  const rawSymbol = parsed.raw;
  
  try {
    const [tickerRes, kline15mRes, kline4hRes] = await Promise.all([
      fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${rawSymbol}`),
      fetchWithTimeout(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${rawSymbol}&interval=15&limit=40`),
      fetchWithTimeout(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${rawSymbol}&interval=240&limit=40`),
    ]);

    const ticker = tickerRes?.result?.list?.[0];
    const k15mList = (kline15mRes?.result?.list || []).reverse();
    const k4hList = (kline4hRes?.result?.list || []).reverse();

    if (ticker && k15mList.length > 0) {
      const currentPrice = parseFloat(ticker.lastPrice);
      
      const candles15m = k15mList.map((k: any) => ({
        timestamp: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
      const candles4h = k4hList.map((k: any) => ({
        timestamp: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));

      return {
        data: {
          currentPrice,
          ticker24h: {
            high: parseFloat(ticker.highPrice24h || currentPrice * 1.02),
            low: parseFloat(ticker.lowPrice24h || currentPrice * 0.98),
            priceChangePercent: parseFloat(ticker.price24hPcnt || "0.0") * 100,
            volumeUSD: parseFloat(ticker.turnover24h || "50000000"),
          },
          candles15m,
          candles4h,
        },
        source: "BYBIT_FALLBACK",
      };
    }
    return { data: null, source: "BYBIT_FALLBACK", error: "No data returned" };
  } catch (err: any) {
    return { data: null, source: "BYBIT_FALLBACK", error: err?.message };
  }
}

// Fallback: use ccxt with any configured exchange
async function tryCCXT(symbol: string): Promise<FetchResult<any>> {
  try {
    const exchange = getExchange();
    const ticker = await exchange.fetchTicker(symbol);
    
    return {
      data: {
        currentPrice: ticker.last,
        ticker24h: {
          high: ticker.high,
          low: ticker.low,
          priceChangePercent: ticker.percentage,
          volumeUSD: ticker.quoteVolume,
        },
      },
      source: `CCXT:${exchange.id}`,
    };
  } catch (err: any) {
    return { data: null, source: "CCXT", error: err?.message };
  }
}

// Synthetic data generator (last resort)
function generateSynthetic(symbol: string): FetchResult<any> {
  const parsed = parseMarketSymbol(symbol);
  const basePrice = 64250; // fallback base
  
  const candles = (count: number, volatility = 0.01) => {
    const arr = [];
    let price = basePrice;
    for (let i = 0; i < count; i++) {
      const change = (Math.random() - 0.5) * 2 * volatility * price;
      price = Math.max(1, price + change);
      const high = price * (1 + Math.random() * 0.005);
      const low = price * (1 - Math.random() * 0.005);
      arr.push({
        timestamp: Date.now() - (count - i) * 900000,
        open: Number((price - change).toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(price.toFixed(2)),
        volume: Number((Math.random() * 1000).toFixed(3)),
      });
    }
    return arr;
  };

  return {
    data: {
      currentPrice: basePrice,
      ticker24h: { high: basePrice * 1.02, low: basePrice * 0.98, priceChangePercent: 0, volumeUSD: 50000000 },
      candles15m: candles(40, 0.005),
      candles4h: candles(40, 0.01),
    },
    source: "SIMULATED",
    error: "All live sources unavailable; using synthetic data.",
  };
}

/**
 * Main fetch function with full fallback chain
 */
export async function fetchMarketData(symbol: string): Promise<any> {
  const attempts = [
    () => tryBinance(symbol),
    () => tryBinanceVision(symbol),
    () => tryGateIO(symbol),
    () => tryBybit(symbol),
    () => tryCCXT(symbol),
  ];

  for (const attempt of attempts) {
    const result = await attempt();
    if (result.data) {
      return { success: true, ...result.data, source: result.source, timestamp: Date.now() };
    }
    console.warn(`[MarketFetcher] ${result.source} failed: ${result.error}`);
  }

  // All failed - return synthetic
  const synthetic = generateSynthetic(symbol);
  console.warn("[MarketFetcher] All live sources failed, using synthetic data");
  return { success: true, ...synthetic.data, source: synthetic.source, timestamp: Date.now(), message: synthetic.error };
}

/**
 * Fetch only ticker price (for bracket monitor / mark refresh)
 * Simplified fallback chain - just needs price
 */
export async function fetchTickerPrice(symbol: string): Promise<{ price: number; source: string; ok: boolean }> {
  const parsed = parseMarketSymbol(symbol);
  const rawSymbol = parsed.raw;

  // 1. Try Binance Vision (most reliable)
  try {
    const res = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${rawSymbol}`);
    if (res?.price) return { price: parseFloat(res.price), source: "BINANCE_VISION", ok: true };
  } catch {}

  // 2. Try Gate.io
  try {
    const gateSymbol = parsed.base + "_" + parsed.quote;
    const res = await fetchWithTimeout(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${gateSymbol}`);
    if (res?.[0]?.last) return { price: parseFloat(res[0].last), source: "GATE_IO", ok: true };
  } catch {}

  // 3. Try Bybit
  try {
    const res = await fetchWithTimeout(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${rawSymbol}`);
    if (res?.result?.list?.[0]?.lastPrice) return { price: parseFloat(res.result.list[0].lastPrice), source: "BYBIT", ok: true };
  } catch {}

  // 4. Try Binance primary
  try {
    const res = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${rawSymbol}`);
    if (res?.price) return { price: parseFloat(res.price), source: "BINANCE_LIVE", ok: true };
  } catch {}

  // 5. CCXT fallback
  try {
    const exchange = getExchange();
    const ticker = await exchange.fetchTicker(symbol);
    if (ticker.last) return { price: ticker.last, source: `CCXT:${exchange.id}`, ok: true };
  } catch {}

  return { price: 64250, source: "SYNTHETIC", ok: false };
}

/**
 * Fetch OHLCV for specific timeframe (for /api/klines)
 */
export async function fetchOHLCVWithFallback(symbol: string, timeframe: string, limit = 50): Promise<any[]> {
  const parsed = parseMarketSymbol(symbol);
  const rawSymbol = parsed.raw;

  // Map timeframe to exchange intervals
  const intervalMap: Record<string, { binance: string; bybit: string; gate: string }> = {
    "1s": { binance: "1s", bybit: "1", gate: "10s" },
    "1m": { binance: "1m", bybit: "1", gate: "1m" },
    "5m": { binance: "5m", bybit: "5", gate: "5m" },
    "15m": { binance: "15m", bybit: "15", gate: "15m" },
    "1h": { binance: "1h", bybit: "60", gate: "1h" },
    "4h": { binance: "4h", bybit: "240", gate: "4h" },
    "1D": { binance: "1d", bybit: "D", gate: "1d" },
    "1W": { binance: "1w", bybit: "W", gate: "7d" },
  };

  const intervals = intervalMap[timeframe] || intervalMap["15m"];

  // 1. Binance Vision
  try {
    const res = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/klines?symbol=${rawSymbol}&interval=${intervals.binance}&limit=${limit}`);
    if (Array.isArray(res) && res.length > 0) {
      return res.map((k: any) => ({
        timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
    }
  } catch {}

  // 2. Gate.io
  try {
    const gateSymbol = parsed.base + "_" + parsed.quote;
    const res = await fetchWithTimeout(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${gateSymbol}&interval=${intervals.gate}&limit=${limit}`);
    if (Array.isArray(res) && res.length > 0) {
      return res.reverse().map((k: any) => ({
        timestamp: parseInt(k[0]) * 1000, open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
    }
  } catch {}

  // 3. Bybit
  try {
    const res = await fetchWithTimeout(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${rawSymbol}&interval=${intervals.bybit}&limit=${limit}`);
    const kList = (res?.result?.list || []).reverse();
    if (kList.length > 0) {
      return kList.map((k: any) => ({
        timestamp: parseInt(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
    }
  } catch {}

  // 4. Binance primary
  try {
    const res = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${rawSymbol}&interval=${intervals.binance}&limit=${limit}`);
    if (Array.isArray(res) && res.length > 0) {
      return res.map((k: any) => ({
        timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      }));
    }
  } catch {}

  return []; // trigger client-side generator
}