import express from "express";
import path from "path";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import {
  clearBrokerCredentials,
  fetchBrokerBalance,
  fetchCcxtOHLCV,
  fetchCcxtOrderBook,
  fetchCcxtTicker,
  getBrokerStatus,
  placeBrokerOrder,
  saveBrokerCredentials,
  testBrokerConnection,
} from "./broker";
import {
  PaperOrderError,
  closePaperPosition,
  getBookFilePath,
  getLatestEventSeq,
  getPaperAccount,
  getPaperBalance,
  getPaperEvents,
  getPaperOrder,
  getPaperPositions,
  initPaperBook,
  openPaperPosition,
  refreshPaperMarks,
  startBracketMonitor,
  updatePaperPosition,
} from "./paperBook";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json({ limit: "5mb" }));

// Lazy Gemini client
let genAI: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

// ================= API ROUTES =================

// Helper with timeout
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

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "online",
    timestamp: Date.now(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"),
  });
});

// Real Exchange Market Data Route with Multi-Exchange Fallback (Binance -> Bybit -> Kraken -> Simulated)
app.get("/api/market-feed", async (req, res) => {
  const tStart = Date.now();
  const rawSymbol = String(req.query.symbol || "BTC/USDT").replace("/", "").toUpperCase();
  const asset = rawSymbol.replace("USDT", "") || "BTC";

  // 1. Try Binance REST API (Primary)
  try {
    const [tickerData, klines15mData, klines4hData, depthData] = await Promise.all([
      fetchWithTimeout(`https://api.binance.com/api/v3/ticker/24hr?symbol=${rawSymbol}`),
      fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${rawSymbol}&interval=15m&limit=40`),
      fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${rawSymbol}&interval=4h&limit=40`),
      fetchWithTimeout(`https://api.binance.com/api/v3/depth?symbol=${rawSymbol}&limit=12`),
    ]);

    const candles15m = klines15mData.map((k: any) => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    const candles4h = klines4hData.map((k: any) => ({
      timestamp: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    let bidAccum = 0;
    const bids = (depthData.bids || []).map((b: any) => {
      const price = parseFloat(b[0]);
      const size = parseFloat(b[1]);
      bidAccum += size;
      return { price, size: Number(size.toFixed(4)), total: Number(bidAccum.toFixed(4)) };
    });

    let askAccum = 0;
    const asks = (depthData.asks || []).map((a: any) => {
      const price = parseFloat(a[0]);
      const size = parseFloat(a[1]);
      askAccum += size;
      return { price, size: Number(size.toFixed(4)), total: Number(askAccum.toFixed(4)) };
    });

    const currentPrice = parseFloat(tickerData.lastPrice);
    const latencyMs = Date.now() - tStart;

    return res.json({
      success: true,
      source: "BINANCE_LIVE",
      symbol: `${asset}/USDT`,
      currentPrice,
      ticker24h: {
        high: parseFloat(tickerData.highPrice),
        low: parseFloat(tickerData.lowPrice),
        priceChangePercent: parseFloat(tickerData.priceChangePercent),
        volumeUSD: parseFloat(tickerData.quoteVolume),
      },
      candles15m,
      candles4h,
      orderBook: {
        bids,
        asks,
        spread: bids[0] && asks[0] ? Number((asks[0].price - bids[0].price).toFixed(2)) : 0.5,
      },
      latencyMs,
      timestamp: Date.now(),
    });
  } catch (binanceErr: any) {
    console.warn(`Binance fetch failed (${binanceErr?.message}), attempting Bybit fallback...`);
  }

  // 2. Try Bybit API (Fallback 1)
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
        timestamp: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));

      const candles4h = k4hList.map((k: any) => ({
        timestamp: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));

      return res.json({
        success: true,
        source: "BYBIT_FALLBACK",
        symbol: `${asset}/USDT`,
        currentPrice,
        ticker24h: {
          high: parseFloat(ticker.highPrice24h || currentPrice * 1.02),
          low: parseFloat(ticker.lowPrice24h || currentPrice * 0.98),
          priceChangePercent: parseFloat(ticker.price24hPcnt || "0.0") * 100,
          volumeUSD: parseFloat(ticker.turnover24h || "50000000"),
        },
        candles15m,
        candles4h,
        latencyMs: Date.now() - tStart,
        timestamp: Date.now(),
      });
    }
  } catch (bybitErr: any) {
    console.warn(`Bybit fallback failed (${bybitErr?.message}), falling back to internal synthetic engine...`);
  }

  // 3. Graceful Fallback to Synthetic Data (Safe Offline / Restricted Network Mode)
  res.json({
    success: true,
    source: "SIMULATED",
    symbol: `${asset}/USDT`,
    latencyMs: Date.now() - tStart,
    timestamp: Date.now(),
    message: "Exchange public REST API uncontactable or rate-limited; using client/server synthetic feeder.",
  });
});

// Multi-Timeframe Dedicated Klines Endpoint (1s to 1w)
app.get("/api/klines", async (req, res) => {
  const rawSymbol = String(req.query.symbol || "BTCUSDT").replace("/", "").toUpperCase();
  const tf = String(req.query.interval || req.query.timeframe || "15m");
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || "50"))));

  let binanceInterval = "15m";
  if (tf === "1s") binanceInterval = "1s";
  else if (tf === "1m") binanceInterval = "1m";
  else if (tf === "5m") binanceInterval = "5m";
  else if (tf === "15m") binanceInterval = "15m";
  else if (tf === "1h") binanceInterval = "1h";
  else if (tf === "4h") binanceInterval = "4h";
  else if (tf === "1D" || tf === "1d") binanceInterval = "1d";
  else if (tf === "1W" || tf === "1w") binanceInterval = "1w";

  try {
    const rawKlines = await fetchWithTimeout(
      `https://api.binance.com/api/v3/klines?symbol=${rawSymbol}&interval=${binanceInterval}&limit=${limit}`,
      3500
    );
    if (Array.isArray(rawKlines) && rawKlines.length > 0) {
      const candles = rawKlines.map((k: any) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
      return res.json({
        success: true,
        source: "BINANCE_LIVE",
        symbol: rawSymbol,
        timeframe: tf,
        candles,
      });
    }
  } catch (err: any) {
    // Proceed to Bybit fallback
  }

  // Bybit Fallback for standard intervals
  try {
    let bybitInterval = "15";
    if (tf === "1m") bybitInterval = "1";
    else if (tf === "5m") bybitInterval = "5";
    else if (tf === "15m") bybitInterval = "15";
    else if (tf === "1h") bybitInterval = "60";
    else if (tf === "4h") bybitInterval = "240";
    else if (tf === "1D" || tf === "1d") bybitInterval = "D";
    else if (tf === "1W" || tf === "1w") bybitInterval = "W";

    const bybitRes = await fetchWithTimeout(
      `https://api.bybit.com/v5/market/kline?category=spot&symbol=${rawSymbol}&interval=${bybitInterval}&limit=${limit}`,
      3500
    );
    const kList = (bybitRes?.result?.list || []).reverse();
    if (kList.length > 0) {
      const candles = kList.map((k: any) => ({
        timestamp: parseInt(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
      return res.json({
        success: true,
        source: "BYBIT_FALLBACK",
        symbol: rawSymbol,
        timeframe: tf,
        candles,
      });
    }
  } catch (bybitErr) {
    // Return empty candles to trigger client-side generator
  }

  res.json({
    success: false,
    symbol: rawSymbol,
    timeframe: tf,
    candles: [],
  });
});

// ================= ON-CHAIN REAL DATA (blockchain.com / blockchain.info, FREE = no key) =================

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

// Snapshot real Bitcoin dari blockchain.info/explorer (tanpa API key, rate-limited ~1 req/s).
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

// 1. LLM Decision Engine Route (MTF Liquidation Hunt, On-Chain Analysis & Macro Calendar Integration)
app.post("/api/ai-decision", async (req, res) => {
  const startTime = Date.now();
  const {
    symbol,
    currentPrice,
    technicals,
    mtfLiquidity,
    onChainMetrics,
    macroCalendar,
    activePositions,
    portfolioEquity,
    riskParams,
  } = req.body;

  const client = getGeminiClient();

  // If Gemini API Key is available, call Gemini 3.8 Flash
  if (client) {
    try {
      const prompt = `Anda adalah Institutional AI Trading Agent dengan keahlian komprehensif:
1. Multi-Timeframe (MTF) Liquidity Hunt (15m Futures & 4h Spot Market)
2. On-Chain Analysis & Smart Money Whale Dynamics
3. Macroeconomic Calendar & Fed Interest Rate Policy

Konteks Pasar & MTF Liquidation Hunt:
- Asset: ${symbol}
- Market Type: ${mtfLiquidity?.marketType || "FUTURES"} (Primary TF: ${mtfLiquidity?.primaryTimeframe || "15m"}, Macro TF: ${mtfLiquidity?.macroTimeframe || "4h"})
- Harga Saat Ini: $${currentPrice}
- Status Liquidity Hunt: ${mtfLiquidity?.activeState || "EQUILIBRIUM"}
- Confluence Score: ${mtfLiquidity?.confluenceScore ?? 75}% (${mtfLiquidity?.confluenceSummary || "Neutral"})
- Upper BSL Pool (Short Stops): $${mtfLiquidity?.nearestBSL?.midPrice ?? "N/A"} (est. $${mtfLiquidity?.nearestBSL?.estimatedVolumeUSD ?? "14"}M Liq)
- Lower SSL Pool (Long Stops): $${mtfLiquidity?.nearestSSL?.midPrice ?? "N/A"} (est. $${mtfLiquidity?.nearestSSL?.estimatedVolumeUSD ?? "18"}M Liq)
- Recent Sweep: ${mtfLiquidity?.recentSweep ? `${mtfLiquidity.recentSweep.type} dengan ${mtfLiquidity.recentSweep.wickRejectionPercent}% wick absorption. Invalidation: $${mtfLiquidity.recentSweep.invalidationPrice}` : "Belum ada sweep terbaru"}

Analisa On-Chain (Smart Money & Whale Dynamics):
- Netflow Bursa 24 Jam: ${onChainMetrics?.exchangeNetflow24hUSD ? (onChainMetrics.exchangeNetflow24hUSD > 0 ? `+$${onChainMetrics.exchangeNetflow24hUSD}M (Net Inflow / Potensi Jual)` : `-$${Math.abs(onChainMetrics.exchangeNetflow24hUSD)}M (Net Outflow / Akumulasi Whale ke Cold Storage)`) : "Netflow Outflow -$142M (Akumulasi)"}
- Status Netflow: ${onChainMetrics?.netflowStatus || "STRONG_OUTFLOW_ACCUMULATION"}
- Smart Money Bias: ${onChainMetrics?.smartMoneyBias || "BULLISH_ACCUMULATION"} (Confidence: ${onChainMetrics?.onChainConfidence || 85}%)
- MVRV Z-Score: ${onChainMetrics?.mvrvZScore || 1.84} (${onChainMetrics?.mvrvTerritory || "FAIR_VALUE"})
- SOPR: ${onChainMetrics?.sopr || 1.014} (${onChainMetrics?.soprStatus || "RESET_TO_SUPPORT"})
- Whale Alerts: ${onChainMetrics?.whaleAlerts?.[0] ? `${onChainMetrics.whaleAlerts[0].type} $${(onChainMetrics.whaleAlerts[0].usdValue / 1e6).toFixed(1)}M (${onChainMetrics.whaleAlerts[0].from} -> ${onChainMetrics.whaleAlerts[0].to})` : "Whale transfer to cold storage"}

Kalender Makroekonomi (Macro Knowledge & Catalysts):
- Sikap Moneter The Fed: ${macroCalendar?.fedPolicyStance || "DOVISH_PIVOT"}
- Indeks Risiko Makro: ${macroCalendar?.macroRiskIndex ?? 35}/100
- Event Terdekat: ${macroCalendar?.nearestEvent ? `${macroCalendar.nearestEvent.name} (${macroCalendar.nearestEvent.relativeTime}) - Impact: ${macroCalendar.nearestEvent.impact}. Implikasi: ${macroCalendar.nearestEvent.implicationNotes}` : "FOMC Rate Decision upcoming"}
- Panduan Risiko Makro: ${macroCalendar?.macroTradingAdvice || "Kondisi makro kondusif untuk swing trading"}

Indikator Teknikal Pendukung:
- RSI (14): ${technicals?.rsi ?? 50}
- EMA (20): $${technicals?.ema20 ?? currentPrice} | EMA (50): $${technicals?.ema50 ?? currentPrice}
- Order Book Imbalance: ${technicals?.orderBookImbalance?.toFixed(2) ?? "1.0"}

Portfolio & Risk Context:
- Total Equity: $${portfolioEquity ?? 10000}
- Active Position: ${JSON.stringify(activePositions || [])}
- Max Risk Per Trade: ${riskParams?.maxRiskPerTradePercent ?? 2}%

TUGAS ANDA:
1. Sintesis ketiga pilar (MTF Liquidity Hunt + On-Chain Whale Flows + Macroeconomic Calendar).
2. Jika ada sweep SSL (long stop swept) ditambah On-Chain Whale Outflows dan Macro dovish -> Bullish Confluence kuat.
3. Jika ada sweep BSL (short stop swept) atau Whale Inflow besar menjelang high-impact macro -> Bearish Reversal / Distribution.
4. Tentukan aksi (BUY, SELL, atau HOLD) dan Confidence (1-100%).
5. Tentukan Stop Loss presisi di luar invalidation wick sweep dan Take Profit menuju Liquidity Pool lawan.
6. Berikan reasoning ringkas (2-3 kalimat) yang menjelaskan integrasi Liquidity + On-chain + Makro.

Jawab HANYA dalam format JSON valid tanpa markdown wrapper:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": number,
  "targetPrice": number,
  "stopLoss": number,
  "takeProfit": number,
  "positionSizePercent": number,
  "reasoning": "string",
  "onChainContext": {
    "smartMoneyBias": "string",
    "netflowStatus": "string",
    "mvrvZScore": number,
    "whaleSignal": "string"
  },
  "macroContext": {
    "nearestEventName": "string",
    "volatilityRisk": "string",
    "fedStance": "string"
  }
}`;

      const aiResponse = await client.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.2,
        },
      });

      const responseText = aiResponse.text || "{}";
      const parsedDecision = JSON.parse(responseText);

      const inferenceLatency = Date.now() - startTime;
      return res.json({
        ...parsedDecision,
        source: "gemini-3.8-flash",
        inferenceLatencyMs: inferenceLatency,
      });
    } catch (err: any) {
      console.warn("Gemini API call failed:", err?.message);
      return res.status(503).json({
        success: false,
        source: "unavailable",
        message: "Gemini API call gagal. Fallback keputusan ditangani client-side (logic/decisionEngine).",
      });
    }
  }

  // Tanpa Gemini: serahkan sepenuhnya ke decision engine client-side.
  return res.status(503).json({
    success: false,
    source: "unavailable",
    message: "GEMINI_API_KEY belum dikonfigurasi. Fallback keputusan ditangani client-side (logic/decisionEngine).",
  });
});

// ================= BROKER ROUTES (ccxt provider) =================

// Status broker (mode paper/live + apakah live order bisa dipasang)
app.get("/api/broker/status", (_req, res) => {
  res.json({ success: true, ...getBrokerStatus() });
});

// Ticker via ccxt (public, lintas exchange)
app.get("/api/broker/ticker", async (req, res) => {
  const symbol = String(req.query.symbol || "BTC/USDT");
  try {
    const ticker = await fetchCcxtTicker(symbol);
    res.json({ success: true, ...ticker });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err?.message || "Ticker fetch gagal." });
  }
});

// Order book via ccxt (public)
app.get("/api/broker/orderbook", async (req, res) => {
  const symbol = String(req.query.symbol || "BTC/USDT");
  const limit = Math.min(50, Math.max(5, parseInt(String(req.query.limit || "12"))));
  try {
    const book = await fetchCcxtOrderBook(symbol, limit);
    res.json({ success: true, ...book });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err?.message || "Order book fetch gagal." });
  }
});

// OHLCV via ccxt (public, timeframe ccxt: "1m","5m","15m","1h","4h","1d","1w")
app.get("/api/broker/klines", async (req, res) => {
  const symbol = String(req.query.symbol || "BTC/USDT");
  const timeframe = String(req.query.timeframe || req.query.interval || "15m");
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || "50"))));
  try {
    const candles = await fetchCcxtOHLCV(symbol, timeframe, limit);
    res.json({ success: true, symbol, timeframe, candles });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err?.message || "OHLCV fetch gagal." });
  }
});

// Balance (paper: saldo akun paper book; live: saldo exchange asli)
app.get("/api/broker/balance", async (_req, res) => {
  try {
    if (getBrokerStatus().mode === "live") {
      const balances = await fetchBrokerBalance();
      return res.json({ success: true, mode: "live", balances });
    }
    res.json({
      success: true,
      mode: "paper",
      balances: getPaperBalance(),
      account: getPaperAccount(),
    });
  } catch (err: any) {
    res.status(403).json({ success: false, message: err?.message || "Balance fetch gagal." });
  }
});

// Simpan credential broker ke vault lokal (.broker-secrets.json, gitignored)
app.post("/api/broker/credentials", async (req, res) => {
  const { exchange, apiKey, apiSecret, testnet } = req.body || {};
  if (!apiKey || !apiSecret) {
    return res.status(400).json({ success: false, message: "apiKey dan apiSecret wajib diisi." });
  }
  await saveBrokerCredentials({
    ...((exchange && { exchange }) || {}),
    apiKey: String(apiKey).trim(),
    apiSecret: String(apiSecret).trim(),
    ...(typeof testnet === "boolean" ? { testnet } : {}),
  });
  res.json({ success: true, ...getBrokerStatus() });
});

// Hapus credential vault lokal
app.post("/api/broker/credentials/clear", async (_req, res) => {
  await clearBrokerCredentials();
  res.json({ success: true, ...getBrokerStatus() });
});

// Tes koneksi real ke exchange (READ-ONLY: fetchBalance, TIDAK pernah order)
app.post("/api/broker/test", async (_req, res) => {
  try {
    const result = await testBrokerConnection();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Koneksi gagal." });
  }
});

// Order (paper: buku posisi paper dengan fill terukur; live: order exchange asli)
app.post("/api/broker/order", async (req, res) => {
  try {
    const body = req.body || {};

    // ---------- PAPER MODE ----------
    if (getBrokerStatus().mode !== "live") {
      // Closing order: { closePositionId }
      if (body.closePositionId) {
        try {
          const result = await closePaperPosition(String(body.closePositionId), "MANUAL");
          return res.json({ success: true, mode: "paper", closed: true, ...result });
        } catch (err: any) {
          if (err instanceof PaperOrderError) {
            return res.status(400).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
          }
          return res.status(400).json({ success: false, status: "REJECTED", reason: "CLOSE_FAILED", message: err?.message || "Gagal menutup posisi." });
        }
      }

      // Opening order
      try {
        const result = await openPaperPosition({
          symbol: body.symbol,
          side: String(body.side || "buy").toLowerCase() === "sell" ? "sell" : "buy",
          qty: Number(body.amount),
          leverage: body.leverage,
          stopLoss: body.stopLoss,
          takeProfit: body.takeProfit,
          meta: body.meta,
        });
        const { position, order } = result;
        return res.json({
          success: true,
          mode: "paper",
          order: {
            id: order.id,
            status: order.status,
            fillPrice: order.fillPrice,
            slippageBps: order.slippageBps,
            feeUSD: order.feeUSD,
            qty: order.qty,
            notional: order.notional,
            leverage: order.leverage,
            marginRequired: order.marginRequired,
            executionLatencyMs: order.executionLatencyMs,
            timestamp: order.timestamp,
            signature: order.signature,
            payloadHash: order.payloadHash,
          },
          position,
        });
      } catch (err: any) {
        if (err instanceof PaperOrderError) {
          return res.status(400).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
        }
        return res.status(400).json({ success: false, status: "REJECTED", reason: "ORDER_FAILED", message: err?.message || "Order paper gagal." });
      }
    }

    // ---------- LIVE MODE (pass-through, guarded) ----------
    const result = await placeBrokerOrder(body);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Order gagal." });
  }
});

// Positions (paper: buku posisi paper dengan mark terbaru; live: belum disimpan, passthrough)
app.get("/api/broker/positions", async (_req, res) => {
  if (getBrokerStatus().mode === "live") {
    return res.json({
      success: true,
      mode: "live",
      positions: [],
      account: null,
      note: "Live positions are pass-through only and not stored yet (roadmap Phase 2+).",
    });
  }
  try {
    await refreshPaperMarks();
  } catch (err: any) {
    console.warn(`Mark refresh gagal (getPositions): ${err?.message}`);
  }
  res.json({
    success: true,
    mode: "paper",
    positions: getPaperPositions(),
    account: getPaperAccount(),
  });
});

// Close posisi (paper: market close via paper book)
app.post("/api/broker/close", async (req, res) => {
  try {
    if (getBrokerStatus().mode === "live") {
      return res.status(400).json({ success: false, message: "Live close via /api/broker/close belum diimplementasikan (roadmap Phase 2+)." });
    }
    const positionId = String((req.body || {}).positionId || "");
    if (!positionId) {
      return res.status(400).json({ success: false, status: "REJECTED", reason: "MISSING_POSITION_ID", message: "positionId wajib diisi." });
    }
    const result = await closePaperPosition(positionId, "MANUAL");
    res.json({ success: true, mode: "paper", closed: true, ...result });
  } catch (err: any) {
    if (err instanceof PaperOrderError) {
      const status = err.code === "POSITION_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
    }
    res.status(400).json({ success: false, message: err?.message || "Close gagal." });
  }
});

// Update SL/TP posisi (manual SL edit / move-to-break-even)
app.post("/api/broker/position/update", (req, res) => {
  try {
    const body = req.body || {};
    const positionId = String(body.positionId || "");
    if (!positionId) {
      return res.status(400).json({ success: false, reason: "MISSING_POSITION_ID", message: "positionId wajib diisi." });
    }
    const updated = updatePaperPosition(positionId, {
      stopLoss: body.stopLoss !== undefined ? Number(body.stopLoss) : undefined,
      takeProfit: body.takeProfit !== undefined ? Number(body.takeProfit) : undefined,
      breakEven: Boolean(body.breakEven),
    });
    res.json({ success: true, mode: "paper", position: updated });
  } catch (err: any) {
    if (err instanceof PaperOrderError) {
      const status = err.code === "POSITION_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ success: false, reason: err.code, message: err.message });
    }
    res.status(400).json({ success: false, message: err?.message || "Update posisi gagal." });
  }
});

// Order status: receipt order paper yang tersimpan (600 status lifecycle ada; NEW->FILLED sinkron)
app.get("/api/broker/order-status/:orderId", (req, res) => {
  const order = getPaperOrder(String(req.params.orderId || ""));
  if (!order) {
    return res.status(404).json({ success: false, message: `Order ${req.params.orderId} tidak ditemukan.` });
  }
  res.json({ success: true, mode: "paper", order });
});

// Event log paper book (ring buffer) dengan sinceSeq
app.get("/api/broker/events", (req, res) => {
  const sinceSeq = Math.max(0, parseInt(String(req.query.sinceSeq || "0"), 10) || 0);
  const events = getPaperEvents(sinceSeq);
  res.json({ success: true, mode: "paper", events, latestSeq: getLatestEventSeq() });
});

// --- Server & Vite Startup ---
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[AI Trading Agent] Server listening on http://0.0.0.0:${PORT}`);
    // Paper book adalah sumber kebenaran posisi paper; monitor bracket aktif
    // hanya di mode selain live.
    if (getBrokerStatus().mode !== "live") {
      console.log(`[AI Trading Agent] Paper mode aktif; buku posisi: ${getBookFilePath()}`);
      startBracketMonitor(3000);
    }
  });
}

initPaperBook();
startServer();
