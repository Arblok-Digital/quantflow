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

async function fetchTextWithTimeout(url: string, timeoutMs = 5000): Promise<string> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AITradingAgentEngine/1.0" },
    });
    clearTimeout(id);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
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
            // F-09: kalau field 24h tidak tersedia, nilai fallback adalah ESTIMASI, bukan fakta.
            estimated: !ticker.high_24h || !ticker.low_24h || !ticker.quote_volume,
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
            // F-09: kalau field 24h tidak tersedia, nilai fallback adalah ESTIMASI, bukan fakta.
            estimated: !ticker.highPrice24h || !ticker.lowPrice24h || !ticker.turnover24h,
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
      // F-09: seluruh bidikan sintetis adalah ESTIMASI, bukan fakta pasar.
      ticker24h: { high: basePrice * 1.02, low: basePrice * 0.98, priceChangePercent: 0, volumeUSD: 50000000, estimated: true },
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
  // F-09: data sintetis/hallucinated BUKAN data valid → success:false.
  // Frontend harus menampilkan peringatan "data simulasi" bukan data pasar nyata.
  const synthetic = generateSynthetic(symbol);
  console.warn("[MarketFetcher] All live sources failed, using synthetic data");
  return { success: false, ...synthetic.data, source: synthetic.source, timestamp: Date.now(), message: synthetic.error };
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

// ---------------------------------------------------------------------------
// Recent trades (order flow) — for Keel Engine institutional flow detection
// Fallback chain: Binance Vision → Gate.io → Binance primary → Bybit
// Fail-closed: semua sumber gagal → [] (NEVER fabricate/synthetic)
// ---------------------------------------------------------------------------
export interface RecentTrade {
  price: number;
  qty: number;
  notionalUsd: number;
  isBuyerMaker: boolean;
  timestamp: number;
}

function recentTradeFromBinanceAgg(t: any): RecentTrade {
  const price = parseFloat(t.p);
  const qty = parseFloat(t.q);
  const ts = Number(t.T) || Number(t.t) || Date.now();
  return { price, qty, notionalUsd: price * qty, isBuyerMaker: t.m === true || String(t.m) === "true", timestamp: ts };
}

/**
 * Fetch REAL recent aggregate trades (aggTrades) dari exchange untuk keel flow.
 * Fail-closed jujur: kalau semua sumber gagal → { success:false, trades:[], source:"NONE" }.
 */
export async function fetchRecentTrades(symbol: string, limit = 60): Promise<{ success: boolean; trades: RecentTrade[]; source: string }> {
  const parsed = parseMarketSymbol(symbol);
  const rawSymbol = parsed.raw;
  const gateSymbol = parsed.base + "_" + parsed.quote;

  // 1. Binance Vision (data-api.binance.vision — paling sering terbuka)
  try {
    const res = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/aggTrades?symbol=${rawSymbol}&limit=${limit}`);
    if (Array.isArray(res) && res.length > 0) {
      return { success: true, trades: res.map(recentTradeFromBinanceAgg), source: "BINANCE_VISION" };
    }
  } catch {}

  // 2. Gate.io (side = taker side: buy → isBuyerMaker=false; sell → true)
  try {
    const res = await fetchWithTimeout(`https://api.gateio.ws/api/v4/spot/trades?currency_pair=${gateSymbol}&limit=${limit}`);
    if (Array.isArray(res) && res.length > 0) {
      const trades = res.map((t: any) => {
        const price = parseFloat(t.price);
        const qty = parseFloat(t.amount);
        const ts = typeof t.create_time_ms === "number" && t.create_time_ms > 0
          ? t.create_time_ms
          : (Number(t.create_time) || 0) * 1000;
        return { price, qty, notionalUsd: price * qty, isBuyerMaker: String(t.side).toLowerCase() === "sell", timestamp: ts };
      });
      return { success: true, trades, source: "GATE_IO" };
    }
  } catch {}

  // 3. Binance primary
  try {
    const res = await fetchWithTimeout(`https://api.binance.com/api/v3/aggTrades?symbol=${rawSymbol}&limit=${limit}`);
    if (Array.isArray(res) && res.length > 0) {
      return { success: true, trades: res.map(recentTradeFromBinanceAgg), source: "BINANCE_LIVE" };
    }
  } catch {}

  // 4. Bybit (side "Sell" = buyer maker → isBuyerMaker=true; "Buy" → false)
  try {
    const res = await fetchWithTimeout(`https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=${rawSymbol}&limit=${limit}`);
    const list = res?.result?.list || [];
    if (Array.isArray(list) && list.length > 0) {
      const trades = list.map((t: any) => {
        const price = parseFloat(t.price);
        const qty = parseFloat(t.size);
        return { price, qty, notionalUsd: price * qty, isBuyerMaker: String(t.side).toLowerCase() === "sell", timestamp: Number(t.time) || Date.now() };
      });
      return { success: true, trades, source: "BYBIT_FALLBACK" };
    }
  } catch {}

  return { success: false, trades: [], source: "NONE" };
}

// ---------------------------------------------------------------------------
// Futures metrics (Gate.io futures perp) — for Keel Engine institutional futures context
// Source verified live: Gate.io USDT-margined perpetual futures API
// Fail-closed jujur: kalau tickers/contract_stats gagal → { success:false, source:"NONE" }
// TIDAK pernah fabricate/synthetic.
// ---------------------------------------------------------------------------
export interface FuturesMetrics {
  success: boolean;
  source: string;               // "GATE_FUTURES" | "NONE"
  fundingRate?: number;         // decimal
  fundingBps?: number;          // fundingRate * 10000 (untuk UI)
  markPrice?: number;
  openInterest?: number;        // contracts (dari contract_stats.open_interest atau tickers.total_size)
  openInterestUsd?: number;     // derived: total_size × quanto_multiplier × mark_price (LABEL derived)
  quantoMultiplier?: number;
  lsrTaker?: number;
  lsrAccount?: number;
  longLiqUsd?: number;          // long_liq_usd_new
  shortLiqUsd?: number;         // short_liq_usd_new
  longLiqSize?: number;
  shortLiqSize?: number;
  topLongSize?: number;
  topShortSize?: number;
  topLsrSize?: number;
  volume24hUsd?: number;        // volume_24h_quote
  timestamp?: number;
}

function gateFuturesSymbol(symbol: string): string {
  const parsed = parseMarketSymbol(symbol);
  return parsed.base + "_" + parsed.quote; // BTC/USDT → BTC_USDT
}

/**
 * Fetch REAL futures institutional metrics dari Gate.io (USDT perp):
 * funding rate, open interest, long/short ratio, dan area likuidasi long/short.
 * tickers + contract_stats di-fetch paralel; hasil digabung.
 * Fail-closed jujur: kalau salah satu gagal → { success:false, source:"NONE" }.
 */
export async function fetchFuturesMetrics(symbol: string): Promise<FuturesMetrics> {
  const contract = gateFuturesSymbol(symbol);

  try {
    const [tickerList, statsList] = await Promise.all([
      fetchWithTimeout(`https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${contract}`),
      fetchWithTimeout(`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${contract}&limit=1&interval=5m`),
    ]);

    const ticker = Array.isArray(tickerList) ? tickerList[0] : tickerList?.[0];
    const stats = Array.isArray(statsList) ? statsList[0] : statsList?.[0];

    if (!ticker) {
      return { success: false, source: "NONE" };
    }

    const totalSize = ticker.total_size != null ? parseFloat(ticker.total_size) : stats?.open_interest != null ? parseFloat(stats.open_interest) : undefined;
    const quantoMultiplier = ticker.quanto_multiplier != null ? parseFloat(ticker.quanto_multiplier) : undefined;
    const markPrice = ticker.mark_price != null ? parseFloat(ticker.mark_price) : stats?.mark_price != null ? parseFloat(stats.mark_price) : undefined;
    const fundingRate = ticker.funding_rate != null ? parseFloat(ticker.funding_rate) : undefined;

    const openInterestUsd =
      totalSize != null && quantoMultiplier != null && markPrice != null
        ? totalSize * quantoMultiplier * markPrice
        : undefined;

    const metrics: FuturesMetrics = {
      success: true,
      source: "GATE_FUTURES",
      fundingRate,
      fundingBps: fundingRate != null ? fundingRate * 10000 : undefined,
      markPrice,
      openInterest: totalSize,
      openInterestUsd,
      quantoMultiplier,
      lsrTaker: stats?.lsr_taker != null ? parseFloat(stats.lsr_taker) : undefined,
      lsrAccount: stats?.lsr_account != null ? parseFloat(stats.lsr_account) : undefined,
      longLiqUsd: stats?.long_liq_usd_new != null ? parseFloat(stats.long_liq_usd_new) : undefined,
      shortLiqUsd: stats?.short_liq_usd_new != null ? parseFloat(stats.short_liq_usd_new) : undefined,
      longLiqSize: stats?.long_liq_size != null ? parseFloat(stats.long_liq_size) : undefined,
      shortLiqSize: stats?.short_liq_size != null ? parseFloat(stats.short_liq_size) : undefined,
      topLongSize: stats?.top_long_size != null ? parseFloat(stats.top_long_size) : undefined,
      topShortSize: stats?.top_short_size != null ? parseFloat(stats.top_short_size) : undefined,
      topLsrSize: stats?.top_lsr_size != null ? parseFloat(stats.top_lsr_size) : undefined,
      volume24hUsd: ticker.volume_24h_quote != null ? parseFloat(ticker.volume_24h_quote) : undefined,
      timestamp: Date.now(),
    };

    return metrics;
  } catch (err: any) {
    console.warn(`[MarketFetcher] Gate futures metrics failed for ${contract}: ${err?.message}`);
    return { success: false, source: "NONE" };
  }
}

// ---------------------------------------------------------------------------
// Macro real gratisan (server-side fetch + cache):
//   1. ForexFactory mirror (faireconomy) — kalender event USD high-impact,
//      tanpa key. 2. Stooq CSV — VIX proxy real-time risk sentiment, tanpa key.
// Fail-closed: semua gagal -> { ok:false } (konsumen TIDAK boleh fabricate).
// ---------------------------------------------------------------------------
export interface MacroRealEvent {
  title: string;
  country: string;
  impact: string;
  dateUtc: string;
  forecast: string;
  previous: string;
}

export interface MacroRealData {
  ok: boolean;
  source: string;
  fetchedAt: number;
  events: MacroRealEvent[];
  highImpactUpcoming: MacroRealEvent[];
  vix: number | null;
  vixSource: string | null;
}

let macroRealCache: { data: MacroRealData; at: number } | null = null;
const MACRO_REAL_TTL_MS = 30 * 60 * 1000; // 30 menit (kalender mingguan + VIX intraday)

function isHighImpactUsd(e: any): boolean {
  const country = String(e?.country || "").toUpperCase();
  const impact = String(e?.impact || "").toUpperCase();
  return country === "USD" && impact === "HIGH";
}

export async function fetchMacroReal(force = false): Promise<MacroRealData> {
  if (!force && macroRealCache && Date.now() - macroRealCache.at < MACRO_REAL_TTL_MS) {
    return macroRealCache.data;
  }
  let events: MacroRealEvent[] = [];
  let calSource = "NONE";
  try {
    const raw: any = await fetchWithTimeout("https://nfs.faireconomy.media/ff_calendar_thisweek.json", 6000);
    if (Array.isArray(raw) && raw.length > 0) {
      events = raw
        .filter(isHighImpactUsd)
        .map((e: any) => ({
          title: String(e?.title ?? ""),
          country: "USD",
          impact: "High",
          dateUtc: String(e?.date ?? ""),
          forecast: String(e?.forecast ?? ""),
          previous: String(e?.previous ?? ""),
        }))
        .filter((e) => e.title && e.dateUtc);
      calSource = "FF_MIRROR";
    }
  } catch (err: any) {
    console.warn(`[MarketFetcher] FF mirror calendar gagal: ${err?.message}`);
  }
  const now = Date.now();
  const upcoming = events
    .filter((e) => {
      const t = Date.parse(e.dateUtc);
      return isFinite(t) && t >= now - 24 * 3600 * 1000;
    })
    .sort((a, b) => Date.parse(a.dateUtc) - Date.parse(b.dateUtc))
    .slice(0, 8);

  let vix: number | null = null;
  let vixSource: string | null = null;
  try {
    const csv = await fetchTextWithTimeout("https://stooq.com/q/l/?s=%5Evix&f=sd2t2ohlcv&h&e=csv", 6000);
    const lines = csv.trim().split("\n");
    if (lines.length >= 2) {
      const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
      const vals = lines[1].split(",");
      const ci = header.indexOf("close");
      const c = ci >= 0 ? parseFloat(vals[ci]) : NaN;
      if (isFinite(c) && c > 0) {
        vix = c;
        vixSource = "STOOQ_VIX";
      }
    }
  } catch (err: any) {
    console.warn(`[MarketFetcher] Stooq VIX gagal: ${err?.message}`);
  }

  const ok = calSource !== "NONE" || vix != null;
  const data: MacroRealData = {
    ok,
    source: ok ? [calSource !== "NONE" ? calSource : null, vixSource].filter(Boolean).join("+") : "NONE",
    fetchedAt: now,
    events,
    highImpactUpcoming: upcoming,
    vix,
    vixSource,
  };
  macroRealCache = { data, at: now };
  return data;
}

/** Risk index 0-100 dari data real: VIX + jarak event HIGH terdekat. Fail-closed -> 0. */
export function deriveMacroRiskIndex(macro: MacroRealData): number {
  if (!macro.ok) return 0;
  let score = 0;
  if (macro.vix != null) {
    if (macro.vix >= 30) score += 55;
    else if (macro.vix >= 22) score += 40;
    else if (macro.vix >= 16) score += 25;
    else score += 12;
  }
  const next = macro.highImpactUpcoming[0];
  if (next) {
    const hrs = (Date.parse(next.dateUtc) - Date.now()) / 3600000;
    if (hrs < 0) score += 10; // baru lewat — volatilitas pasca-rilis
    else if (hrs <= 24) score += 35;
    else if (hrs <= 72) score += 20;
    else score += 8;
    if (macro.highImpactUpcoming.length >= 2) score += 5;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
}