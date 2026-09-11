import type { Express } from "express";
import { requireAuth } from "@/auth";
import { fetchMarketData, fetchOHLCVWithFallback, fetchRecentTrades, fetchFuturesMetrics, type RecentTrade, type FuturesMetrics } from "@/src/data/marketFetcher";
import { scanGateMicrocapPumps } from "@/src/logic/pumpScanner";
import { analyzeMTFLiquidity } from "@/src/logic/liquidityHunt";
import type { Candle, OrderBook } from "@/src/types";
import { parseMarketSymbol, fetchWithTimeout } from "./_utils";

interface BitcoinOnChainSnapshot {
  source: string;
  fetchedAt: number;
  blockHeight: number;
  priceUSD: number;
  priceChange24hPct: number;
  priceChange7dPct: number;
  txCount24h: number;
  mempoolSizeMB: number;
  mempoolFeesSatVByte: { economy: number; regular: number; priority: number };
  hashrateEH: number;
  supplyBTC: number;
  marketCapUSD: number;
}

let btcOnChainCache: { data: BitcoinOnChainSnapshot; fetchedAt: number } | null = null;
const BTC_ON_CHAIN_TTL_MS = 120_000;

function clampPct(n: number): number {
  if (!isFinite(n)) return 0;
  return Number(Math.max(-20, Math.min(20, n)).toFixed(2));
}

export function registerMarketRoutes(app: Express, heartbeatState: { lastWsTick: number; startTime: number }): void {
  // Health check (public, skip rate limit via skip fn above)
  app.get("/api/health", (_req, res) => {
    const now = Date.now();
    const wsAgeMs = now - (heartbeatState.lastWsTick || now);
    const feed = heartbeatState.lastWsTick === 0
      ? (process.env.DISABLE_WS === "true" ? "disabled" : "pending")
      : wsAgeMs > 60000 ? "down"
      : wsAgeMs > 15000 ? "stale"
      : "live";
    const uptimeSec = Math.floor((now - heartbeatState.startTime) / 1000);
    const mode = (process.env.TRADING_MODE === "live" ? "live" : "paper") as "live" | "paper";
    res.json({
      status: "online",
      timestamp: now,
      mode,
      feed,
      broker: "ok",
      db: "ok",
      uptimeSec,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"),
    });
  });

  // Real Exchange Market Data Route with Multi-Exchange Fallback
  app.get("/api/market-feed", async (req, res) => {
    const symbol = String(req.query.symbol || "BTC/USDT");
    try {
      const data = await fetchMarketData(symbol);
      return res.json({ ...data, symbol });
    } catch (err: any) {
      console.error(`[market-feed] Unexpected error: ${err?.message}`);
      // Ultimate fallback - synthetic
      const synthetic = await fetchMarketData(symbol); // will return synthetic
      return res.json({ ...synthetic, symbol });
    }
  });

  // Multi-Timeframe Dedicated Klines Endpoint (1s to 1w) with fallback chain
  app.get("/api/klines", async (req, res) => {
    const symbol = String(req.query.symbol || "BTC/USDT");
    const tf = String(req.query.interval || req.query.timeframe || "15m");
    const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || "50"))));

    try {
      const candles = await fetchOHLCVWithFallback(symbol, tf, limit);
      if (candles.length > 0) {
        return res.json({ success: true, source: "FALLBACK_CHAIN", symbol, timeframe: tf, candles });
      }
      return res.json({ success: false, symbol, timeframe: tf, candles: [] });
    } catch (err: any) {
      console.error(`[klines] Error: ${err?.message}`);
      return res.json({ success: false, symbol, timeframe: tf, candles: [], error: err?.message });
    }
  });

  // ================= ON-CHAIN REAL DATA (blockchain.com / blockchain.info, FREE = no key) =================
  app.get("/api/onchain/bitcoin", async (_req, res) => {
    if (btcOnChainCache && Date.now() - btcOnChainCache.fetchedAt < BTC_ON_CHAIN_TTL_MS) {
      return res.json({ success: true, ...btcOnChainCache.data });
    }

    const [statsRes, priceSeriesRes, feeRes, latestBlockRes] = await Promise.allSettled([
      fetchWithTimeout("https://blockchain.info/stats?format=json", 4000),
      fetchWithTimeout("https://api.blockchain.info/charts/market-price?timespan=14days&format=json&sampled=true", 4000),
      fetchWithTimeout("https://api.blockchain.info/mempool/fees", 4000),
      fetchWithTimeout("https://blockchain.info/latestblock", 4000),
    ]);

    const stats: any = statsRes.status === "fulfilled" ? statsRes.value : null;
    const priceSeries: any = priceSeriesRes.status === "fulfilled" ? priceSeriesRes.value : null;
    const mempoolFees: any = feeRes.status === "fulfilled" ? feeRes.value : null;
    const latestBlock: any = latestBlockRes.status === "fulfilled" ? latestBlockRes.value : null;

    if (!stats && !priceSeries) {
      return res
        .status(503)
        .json({ success: false, message: "blockchain.com upstream unreachable. Client fallback ke simulasi." });
    }

    let priceUSD = Number(stats?.market_price_usd) || 0;
    let priceChange24hPct = 0;
    let priceChange7dPct = 0;

    if (priceSeries && Array.isArray(priceSeries.values) && priceSeries.values.length > 2) {
      const values = priceSeries.values as { x: number; y: number }[];
      const nowSec = Date.now() / 1000;
      const last = values[values.length - 1];
      priceUSD = priceUSD || Number(last.y) || 0;
      const findClosest = (targetSec: number): number => {
        let best = values[0].y;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const v of values) {
          const delta = Math.abs(v.x - targetSec);
          if (delta < bestDelta) {
            bestDelta = delta;
            best = v.y;
          }
        }
        return best;
      };
      const p24 = findClosest(nowSec - 86400);
      const p7 = findClosest(nowSec - 7 * 86400);
      if (p24 > 0) priceChange24hPct = ((last.y - p24) / p24) * 100;
      if (p7 > 0) priceChange7dPct = ((last.y - p7) / p7) * 100;
    }

    const supplySatoshis = Number(stats?.totalbc) || 0;
    const supplyBTC = Number((supplySatoshis / 1e8).toFixed(0));
    const snapshot: BitcoinOnChainSnapshot = {
      source: "blockchain.com/explorer",
      fetchedAt: Date.now(),
      blockHeight: Number(latestBlock?.height) || Number(stats?.blocks) || 0,
      priceUSD: priceUSD > 0 ? Number(priceUSD.toFixed(2)) : 0,
      priceChange24hPct: clampPct(priceChange24hPct),
      priceChange7dPct: clampPct(priceChange7dPct),
      txCount24h: Number(stats?.n_tx) || 0,
      mempoolSizeMB: Number((Number(stats?.mempool_size || 0) / 1e6).toFixed(1)),
      mempoolFeesSatVByte: {
        economy: Number(mempoolFees?.economy) || 0,
        regular: Number(mempoolFees?.regular) || 0,
        priority: Number(mempoolFees?.priority) || 0,
      },
      hashrateEH: Number((Number(stats?.hash_rate || 0) / 1e9).toFixed(2)),
      supplyBTC,
      marketCapUSD: supplyBTC > 0 ? Number((priceUSD * supplyBTC).toFixed(0)) : 0,
    };

    btcOnChainCache = { data: snapshot, fetchedAt: Date.now() };
    res.json({ success: true, ...snapshot });
  });

  // Keel Context — satu sumber kebenaran server-side untuk mode KEEL local.
  app.get("/api/market/keel-context", requireAuth, async (req, res) => {
    const sym = String(req.query.symbol || "BTC/USDT");

    let orderBook: any = undefined;
    try {
      const market = await fetchMarketData(sym);
      if (market && market.success !== false && market.orderBook) {
        orderBook = market.orderBook;
      }
    } catch (e: any) {
      console.warn(`[keel-context] market fetch failed: ${e?.message}`);
    }

    let recentTrades: { success: boolean; trades: RecentTrade[]; source: string } = { success: false, trades: [], source: "NONE" };
    try {
      recentTrades = await fetchRecentTrades(sym, 60);
    } catch (e: any) {
      console.warn(`[keel-context] recent trades fetch failed: ${e?.message}`);
    }

    let futures: FuturesMetrics = { success: false, source: "NONE" };
    try {
      futures = await fetchFuturesMetrics(sym);
    } catch (e: any) {
      console.warn(`[keel-context] futures metrics fetch failed: ${e?.message}`);
    }

    res.json({
      success: true,
      symbol: sym,
      timestamp: Date.now(),
      orderBook: orderBook ?? null,
      recentTrades: recentTrades.trades,
      futures,
    });
  });

  // ================= PUMP RADAR (Gate.io SPOT microcap scanner — ALERT ONLY) =================
  app.get("/api/pump-scan", requireAuth, async (_req, res) => {
    try {
      const results = await scanGateMicrocapPumps();
      res.json({ success: true, scannedAt: Date.now(), results });
    } catch (err: any) {
      console.error(`[pump-scan] failed: ${err?.message}`);
      res.status(502).json({ success: false, message: err?.message || "Scan microcap Gate.io gagal." });
    }
  });
}
