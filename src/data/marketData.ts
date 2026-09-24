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
 *
 * Boot-gate (SRV-WATCH-1): penelepon WAJIB menjalankan probeServerHealth
 * secara konkuren dan menghalangi hasil #3 (synthetic) via classifyBootFeed
 * sampai N percobaan gagal — jangan pernah render synthetic seolah live.
 */

/** Timeout fetch — cegah boot hang saat backend down/cold-start. */
export async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Boot gate probe: GET /api/health dengan timeout pendek (~3s).
 *  true = server terjangkau; false = offline/cold-start (jangan seed sintetis). */
export async function probeServerHealth(timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetchWithTimeout("/api/health", timeoutMs, { cache: "no-cache" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Backoff boot retry: 2s → 4s → 8s … cap 30s (attempt 0-based). Pure — unit-tested. */
export function bootBackoffDelay(attempt: number): number {
  const safe = Math.max(0, Math.floor(attempt));
  return Math.min(30000, 2000 * 2 ** safe);
}

/** Setelah N percobaan offline gagal, synthetic BERLABEL boleh tampil
 *  (itupun tetap lewat flag candlesReal:false → badge SYNTHETIC; retry background lanjut). */
export const BOOT_SYNTHETIC_AFTER_ATTEMPTS = 3;

export type BootFeedDecision = "APPLY" | "HOLD_RETRY";

/**
 * Pure gate: probe HANYA menghalangi synthetic fallback — sync sukses
 * (server ATAU direct-Binance live) selalu menang (APPLY).
 * consecutiveFailures = jumlah gagal beruntun TERMASUK percobaan saat ini.
 */
export function classifyBootFeed(args: {
  serverReachable: boolean;
  feedLive: boolean;
  consecutiveFailures: number;
  maxAttempts?: number;
}): BootFeedDecision {
  if (args.serverReachable || args.feedLive) return "APPLY";
  const max = args.maxAttempts ?? BOOT_SYNTHETIC_AFTER_ATTEMPTS;
  return args.consecutiveFailures >= max ? "APPLY" : "HOLD_RETRY";
}
export async function fetchLiveMarketData(
  symbol: string = "BTC/USDT",
  fallbackBasePrice: number = 68420
): Promise<MarketFeedResult> {
  const startTime = Date.now();
  const rawSymbol = symbol.replace("/", "").toUpperCase();

  try {
    // Timeout 8s: happy path (server sehat) tidak terdampak; saat server
    // down tidak gantung — probe + gate di hook yang memutuskan.
    const res = await fetchWithTimeout(`/api/market-feed?symbol=${encodeURIComponent(rawSymbol)}`, 8000);
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
  } catch (err: any) {
    // Timeout 8s (fetchWithTimeout) adalah JALUR DESAIN, bukan crash: upstream
    // server lambat → abort → fallback. Log ringkas tanpa stack AbortError
    // supaya console tidak dianggap error oleh operator; error non-timeout
    // tetap WARN penuh.
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      console.warn(
        "[market-feed] timeout 8s — server/upstream lambat; fallback client-direct/synthetic (data tetap berlabel, boot-gate aktif)."
      );
    } else {
      console.warn("Error calling /api/market-feed, falling back to client-direct or simulated feed:", err);
    }
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
  limit: number = 300
): Promise<KlinesResult> {
  const rawSymbol = symbol.replace("/", "").toUpperCase();

  // Try server proxy /api/klines (timeout 8s — lihat alasan di market-feed)
  try {
    const res = await fetchWithTimeout(
      `/api/klines?symbol=${encodeURIComponent(rawSymbol)}&interval=${timeframe}&limit=${limit}`,
      8000
    );
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