import express from "express";
import path from "path";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import {
  clearBrokerCredentials,
  fetchBrokerBalance,
  fetchCcxtOHLCV,
  fetchCcxtOrderBook,
  fetchCcxtTicker,
  getBrokerStatus,
  getVaultCredentialsStatus,
  placeBrokerOrder,
  saveBrokerCredentials,
  setLiveArmed,
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
  updatePaperMarkCache,
  updatePaperPosition,
} from "./paperBook";
import {
  appendAudit,
  getLedgerEntries,
  verifyLedger,
  getLedgerStats,
  saveAgentDecisionDb,
  initDb,
  warnIfDefaultAuditSecret,
} from "./db";
import {
  createSession,
  getAuthPasscode,
  getSessionFromAuthHeader,
  requireAuth,
  removeSessionByToken,
  validateToken,
  warnIfDefaultPasscode,
} from "./auth";
import {
  evaluateGuardrails,
  getGuardrailsSnapshotAsync,
  getGuardrailsSnapshotSync,
  getTodayRealized,
  GuardrailRejectedError,
  initGuardrails,
  recordOrderPlaced,
  setKillSwitch,
} from "./guardrails";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

// ---------- Security middleware ----------
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// CORS only if CORS_ORIGIN is set
if (process.env.CORS_ORIGIN) {
  const allowedOrigin = String(process.env.CORS_ORIGIN).trim();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    // simple allowlist: if origin matches allowedOrigin, set header
    if (origin === allowedOrigin || allowedOrigin === "*") {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
}

app.use(express.json({ limit: "5mb" }));

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/api/health",
  handler: (_req, res) => {
    res.status(429).json({ success: false, code: "RATE_LIMITED", message: "Terlalu banyak request. Coba lagi nanti." });
  },
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, code: "RATE_LIMITED", message: "Terlalu banyak request. Coba lagi nanti." });
  },
});

// Apply apiLimiter to all /api routes (will also cover login, but login has stricter limiter separately)
app.use("/api/", apiLimiter);

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

// ================= AUTH ROUTES =================
warnIfDefaultPasscode();
warnIfDefaultAuditSecret();

app.post("/api/auth/login", loginLimiter, (req, res) => {
  const passcode = String((req.body || {}).passcode || "");
  const expected = getAuthPasscode();
  if (passcode !== expected) {
    return res.status(401).json({ success: false, message: "passcode salah" });
  }
  const { token, expiresAt } = createSession();
  res.json({ success: true, token, expiresAt });
});

app.post("/api/auth/logout", requireAuth, (req: any, res) => {
  const auth = req.headers.authorization as string | undefined;
  if (auth) {
    const parts = auth.trim().split(/\s+/);
    const token = parts.length === 2 ? parts[1] : "";
    if (token) removeSessionByToken(token);
  }
  res.json({ success: true, message: "logged out" });
});

app.get("/api/auth/session", requireAuth, (req: any, res) => {
  const session = (req as any).authSession;
  res.json({ success: true, authenticated: true, expiresAt: session?.expiresAt || null });
});

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

// ---------- Symbol parsing (task 5.5) ----------
// Generic BASE/QUOTE parser. Menangani:
//   "BTC/USDT"  -> { base: BTC, quote: USDT, raw: BTCUSDT, ccxt: BTC/USDT }
//   "USDC/USDT" -> { base: USDC, quote: USDT, raw: USDCUSDT, ccxt: USDC/USDT }
//   "ETH/USDC"  -> { base: ETH,  quote: USDC, raw: ETHUSDC,  ccxt: ETH/USDC }
//   "SOLUSDT"   -> { base: SOL,  quote: USDT, raw: SOLUSDT,  ccxt: SOL/USDT }
const KNOWN_QUOTES_SORTED = ["FDUSD", "BUSD", "USDC", "USDT", "BTC", "ETH", "EUR", "USD"];

interface ParsedSymbol {
  base: string;
  quote: string;
  raw: string; // tanpa slash, untuk Binance REST/WS
  ccxt: string; // dengan slash, untuk ccxt API broker
}

function parseMarketSymbol(input: string): ParsedSymbol {
  const s = String(input || "BTC/USDT").trim().toUpperCase();
  let base = "";
  let quote = "USDT";
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    base = parts[0] || "BTC";
    quote = parts[1] || "USDT";
  } else {
    // Cari suffix quote terpanjang yang dikenal (USDCUSDT -> base USDC, bukan U).
    let matched = "";
    for (const q of KNOWN_QUOTES_SORTED) {
      if (s.endsWith(q) && s.length > q.length && q.length > matched.length) {
        matched = q;
      }
    }
    if (matched) {
      quote = matched;
      base = s.slice(0, -matched.length);
    } else {
      base = s;
    }
  }
  base = base || "BTC";
  quote = quote || "USDT";
  return { base, quote, raw: `${base}${quote}`, ccxt: `${base}/${quote}` };
}

// ---------- Binance WebSocket -> SSE proxy (task 5.1) ----------
// Menggunakan WebSocket native Node (global sejak Node 22) — tanpa dependency `ws`.
// Per symbol: satu koneksi Binance wss, dipancarkan ke banyak klien SSE.
// Reconnect backoff 2s/5s/10s, dan emit status disconnected. Jika WS disabled
// (env WS_DISABLED), klien mendapat status REST_POLL dan memakai REST polling.
interface StreamSlot {
  binanceWs: WebSocket | null;
  clients: Set<import("express").Response>;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  depth: Map<number, number>; // price -> size (bid)
  asks: Map<number, number>;
}

const streamSlots = new Map<string, StreamSlot>();

function streamKey(symbol: string): string {
  return parseMarketSymbol(symbol).ccxt;
}

function broadcastSSE(key: string, event: string, data: unknown): void {
  const slot = streamSlots.get(key);
  if (!slot) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of slot.clients) {
    try {
      client.write(frame);
    } catch {
      // client sudah mati; di-handle di req.on("close")
    }
  }
}

function rebuildAndBroadcastDepth(key: string): void {
  const slot = streamSlots.get(key);
  if (!slot) return;
  const bids = [...slot.depth.entries()]
    .filter(([, size]) => size > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 12)
    .map(([price, size]) => ({ price, size, total: 0 }));
  const asks = [...slot.asks.entries()]
    .filter(([, size]) => size > 0)
    .sort((a, b) => a[0] - b[0])
    .slice(0, 12)
    .map(([price, size]) => ({ price, size, total: 0 }));
  let bidAccum = 0;
  for (const lvl of bids) {
    bidAccum += lvl.size;
    lvl.total = Number(bidAccum.toFixed(4));
  }
  let askAccum = 0;
  for (const lvl of asks) {
    askAccum += lvl.size;
    lvl.total = Number(askAccum.toFixed(4));
  }
  const spread = bids.length > 0 && asks.length > 0 ? Number((asks[0].price - bids[0].price).toFixed(2)) : 0;
  broadcastSSE(key, "depth", { type: "depth", bids, asks, spread });
}

const WS_BACKOFF_MS = [2000, 5000, 10000];

function connectBinanceStream(key: string): void {
  let slot = streamSlots.get(key);
  if (!slot) {
    slot = { binanceWs: null, clients: new Set(), reconnectAttempt: 0, reconnectTimer: null, depth: new Map(), asks: new Map() };
    streamSlots.set(key, slot);
  }
  if (slot.binanceWs || slot.reconnectTimer) return; // sudah connect / sedang nunggu retry

  const wsDisabled = /^(1|true)$/i.test(String(process.env.WS_DISABLED || ""));
  if (wsDisabled) {
    broadcastSSE(key, "status", { type: "status", feedMode: "REST_POLL", message: "WS_DISABLED — REST polling aktif." });
    return;
  }

  const parsed = parseMarketSymbol(key);
  const wsUrl = `wss://stream.binance.com:9443/ws/${parsed.raw}@trade/${parsed.raw}@depth@100ms`;

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    broadcastSSE(key, "status", { type: "status", feedMode: "REST_POLL", message: `WS init gagal: ${(err as Error).message}` });
    scheduleStreamReconnect(key);
    return;
  }
  slot.binanceWs = ws;

  ws.onopen = () => {
    const cur = streamSlots.get(key);
    if (cur) cur.reconnectAttempt = 0;
    broadcastSSE(key, "status", { type: "status", feedMode: "WS_LIVE", message: "connected" });
    // Seed depth snapshot dari REST supaya depth deltas punya basis.
    fetchWithTimeout(`https://api.binance.com/api/v3/depth?symbol=${parsed.raw}&limit=20`, 3000)
      .then((depth) => {
        const curSlot = streamSlots.get(key);
        if (!curSlot) return;
        curSlot.depth.clear();
        curSlot.asks.clear();
        for (const lvl of (depth?.bids || [])) curSlot.depth.set(parseFloat(lvl[0]), parseFloat(lvl[1]));
        for (const lvl of (depth?.asks || [])) curSlot.asks.set(parseFloat(lvl[0]), parseFloat(lvl[1]));
        rebuildAndBroadcastDepth(key);
      })
      .catch(() => {});
  };

  ws.onmessage = (ev) => {
    const raw = String(ev.data);
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const curSlot = streamSlots.get(key);
    if (!curSlot) return;
    if (msg.e === "trade") {
      const price = parseFloat(msg.p);
      const qty = parseFloat(msg.q);
      if (isFinite(price) && price > 0) {
        // Sumber kebenaran mark untuk paper book (6.3): server tick dipakai
        // pipeline/chart/portfolio, bukan mark-to-market ganda di client.
        updatePaperMarkCache(parsed.ccxt, price);
        broadcastSSE(key, "trade", { type: "trade", price, qty, time: msg.T });
      }
    } else if (msg.e === "depthUpdate" && Array.isArray(msg.b) && Array.isArray(msg.a)) {
      for (const lvl of msg.b) {
        const price = parseFloat(lvl[0]);
        const size = parseFloat(lvl[1]);
        if (size === 0) curSlot.depth.delete(price);
        else curSlot.depth.set(price, size);
      }
      for (const lvl of msg.a) {
        const price = parseFloat(lvl[0]);
        const size = parseFloat(lvl[1]);
        if (size === 0) curSlot.asks.delete(price);
        else curSlot.asks.set(price, size);
      }
      rebuildAndBroadcastDepth(key);
    }
  };

  ws.onclose = () => {
    const cur = streamSlots.get(key);
    if (cur) cur.binanceWs = null;
    broadcastSSE(key, "status", { type: "status", feedMode: "REST_POLL", message: "disconnected" });
    scheduleStreamReconnect(key);
  };

  ws.onerror = () => {
    // onclose menyusul; cukup tutup agar loop reconnect berjalan.
    try {
      ws.close();
    } catch {}
  };
}

function scheduleStreamReconnect(key: string): void {
  const slot = streamSlots.get(key);
  if (!slot) return;
  if (slot.clients.size === 0) return; // tanpa konsumen SSE, jangan reconnect selamanya
  if (/^(1|true)$/i.test(String(process.env.WS_DISABLED || ""))) return;
  const delay = WS_BACKOFF_MS[Math.min(slot.reconnectAttempt, WS_BACKOFF_MS.length - 1)];
  slot.reconnectAttempt += 1;
  slot.reconnectTimer = setTimeout(() => {
    const cur = streamSlots.get(key);
    if (cur) cur.reconnectTimer = null;
    connectBinanceStream(key);
  }, delay);
}

function closeStreamSlot(key: string): void {
  const slot = streamSlots.get(key);
  if (!slot) return;
  if (slot.reconnectTimer) {
    clearTimeout(slot.reconnectTimer);
    slot.reconnectTimer = null;
  }
  if (slot.binanceWs) {
    try {
      slot.binanceWs.close();
    } catch {}
    slot.binanceWs = null;
  }
  streamSlots.delete(key);
}

// SSE: proxy harga & depth Binance real-time (task 5.1) — public, sejajar /api/market-feed.
app.get("/api/market/stream", (req, res) => {
  const key = streamKey(String(req.query.symbol || "BTC/USDT"));
  let slot = streamSlots.get(key);
  if (!slot) {
    slot = { binanceWs: null, clients: new Set(), reconnectAttempt: 0, reconnectTimer: null, depth: new Map(), asks: new Map() };
    streamSlots.set(key, slot);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const st = slot;
  st.clients.add(res);
  res.write(`event: status\ndata: ${JSON.stringify({ type: "status", feedMode: "WS_LIVE", symbol: key })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {}
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    st.clients.delete(res);
    if (st.clients.size === 0) closeStreamSlot(key);
  });

  connectBinanceStream(key);
});

// Health check (public, skip rate limit via skip fn above)
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
  const parsed = parseMarketSymbol(String(req.query.symbol || "BTC/USDT"));
  const rawSymbol = parsed.raw;
  const exchangeSymbol = parsed.ccxt;
  const asset = parsed.base;
  const quote = parsed.quote;

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
      symbol: exchangeSymbol,
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
        symbol: exchangeSymbol,
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
    symbol: exchangeSymbol,
    latencyMs: Date.now() - tStart,
    timestamp: Date.now(),
    message: "Exchange public REST API uncontactable or rate-limited; using client/server synthetic feeder.",
  });
});

// Multi-Timeframe Dedicated Klines Endpoint (1s to 1w)
app.get("/api/klines", async (req, res) => {
  const rawSymbol = parseMarketSymbol(String(req.query.symbol || "BTCUSDT")).raw;
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

  // If Gemini API Key is available, call Gemini (2.0-flash primary, 1.5-flash fallback)
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
- Total Equity: $${(() => { try { const a = getPaperAccount(); return `${a.equity} (real — cash ${a.cash} + margin ${a.marginLocked} + uPnL ${a.unrealizedPnl})`; } catch { return portfolioEquity != null ? `${portfolioEquity} (client-supplied)` : "equity tidak tersedia"; } })()}
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

      // Zod schema untuk validasi output LLM (4.1)
      const decisionSchema = z.object({
        action: z.enum(["BUY", "SELL", "HOLD"]),
        confidence: z.number().int().min(1).max(100).finite(),
        targetPrice: z.number().finite().positive(),
        stopLoss: z.number().finite().positive(),
        takeProfit: z.number().finite().positive(),
        positionSizePercent: z.number().min(1).max(100),
        reasoning: z.string().optional(),
        onChainContext: z
          .object({
            smartMoneyBias: z.string().optional(),
            netflowStatus: z.string().optional(),
            mvrvZScore: z.number().optional(),
            whaleSignal: z.string().optional(),
          })
          .optional(),
        macroContext: z
          .object({
            nearestEventName: z.string().optional(),
            volatilityRisk: z.string().optional(),
            fedStance: z.string().optional(),
          })
          .optional(),
      });

      // Coba model primary, lalu fallback pada INVALID_MODEL (4.2).
      const candidateModels = ["gemini-2.0-flash", "gemini-1.5-flash"];
      let responseText: string = "{}";
      let usedModel = "gemini-2.0-flash";
      let lastErr: any = null;
      for (const model of candidateModels) {
        try {
          const aiResponse = await client.models.generateContent({
            model,
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              temperature: 0.2,
            },
          });
          if (aiResponse && aiResponse.text) {
            responseText = aiResponse.text;
            usedModel = model;
            break;
          }
          lastErr = new Error(`model ${model} returned empty response`);
        } catch (modelErr: any) {
          lastErr = modelErr;
          const msg = String(modelErr?.message || "");
          if (/INVALID_MODEL|not found|does not exist|404/i.test(msg)) {
            console.warn(`Gemini model ${model} tidak valid, coba fallback...`);
            continue;
          }
          throw modelErr;
        }
      }
      if (!responseText || /^\s*\{?\s*\}$/.test(responseText.trim())) {
        responseText = "{}";
        if (lastErr) {
          throw lastErr;
        }
      }

      let parsedDecision: unknown;
      try {
        parsedDecision = JSON.parse(responseText);
      } catch (parseErr: any) {
        const inferenceLatency = Date.now() - startTime;
        try {
          appendAudit("decision", {
            symbol: String(symbol || "BTC/USDT"),
            action: "REJECTED_JSON_PARSE",
            latencyMs: inferenceLatency,
            modelId: usedModel,
            reason: "raw-llm-output-not-json",
          });
        } catch {}
        return res.status(502).json({
          success: false,
          source: "fallback-validation-failed",
          reason: "unparseable-llm-json",
          message: "Output LLM tidak valid JSON. Keputusan ditolak (tidak fallback diam-diam).",
        });
      }

      // Validasi skema + urutan harga per aksi (4.1)
      const validation = decisionSchema.safeParse(parsedDecision);
      if (!validation.success) {
        const inferenceLatency = Date.now() - startTime;
        try {
          const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const responseStr = String(responseText).slice(0, 2000);
          saveAgentDecisionDb({
            id: decisionId,
            created_at: Date.now(),
            symbol: String(symbol || "BTC/USDT"),
            action: "REJECTED",
            confidence: 0,
            model_id: usedModel,
            latency_ms: inferenceLatency,
            prompt: prompt.slice(0, 800),
            response: responseStr,
            source_tags: JSON.stringify({ validation: "failed", issues: validation.error.issues }),
          });
          appendAudit("decision", {
            decisionId,
            symbol: String(symbol || "BTC/USDT"),
            action: "REJECTED",
            latencyMs: inferenceLatency,
            modelId: usedModel,
            reason: "validation-failed",
            issues: validation.error.issues,
          });
        } catch {}
        return res.status(502).json({
          success: false,
          source: "fallback-validation-failed",
          reason: "validation-failed",
          issues: validation.error.issues,
          message: "Output LLM gagal validasi. Keputusan ditolak (tidak fallback diam-diam).",
        });
      }

      const parsedDecision2 = validation.data as z.infer<typeof decisionSchema>;
      const currentP = Number(currentPrice) || 0;
      const isBadOrder =
        (parsedDecision2.action === "BUY" &&
          !(parsedDecision2.stopLoss < currentP && currentP < parsedDecision2.takeProfit)) ||
        (parsedDecision2.action === "SELL" &&
          !(parsedDecision2.takeProfit < currentP && currentP < parsedDecision2.stopLoss));
      if (parsedDecision2.action !== "HOLD" && isBadOrder) {
        const inferenceLatency = Date.now() - startTime;
        try {
          appendAudit("decision", {
            symbol: String(symbol || "BTC/USDT"),
            action: parsedDecision2.action,
            latencyMs: inferenceLatency,
            modelId: usedModel,
            reason: "invalid-price-order",
            details: {
              currentPrice: currentP,
              stopLoss: parsedDecision2.stopLoss,
              takeProfit: parsedDecision2.takeProfit,
            },
          });
        } catch {}
        return res.status(502).json({
          success: false,
          source: "fallback-validation-failed",
          reason: "invalid-price-order",
          message:
            parsedDecision2.action === "BUY"
              ? "Order BUY tidak valid: harus stopLoss < harga sekarang < takeProfit."
              : "Order SELL tidak valid: harus takeProfit < harga sekarang < stopLoss.",
        });
      }

      // Clamp positionSizePercent ke maxRiskPerTradePercent (4.1)
      const maxRisk = Number(riskParams?.maxRiskPerTradePercent) || 0;
      const positionSizePercent =
        maxRisk > 0 && parsedDecision2.positionSizePercent > maxRisk
          ? maxRisk
          : parsedDecision2.positionSizePercent;

      const inferenceLatency = Date.now() - startTime;
      // Provenance dari body (4.4) — dikirim client lewat /api/ai-decision payload.
      const provenance = (req.body && req.body.provenance) || null;

      // Persist decision audit (server-measured latency, modelId, provenance)
      try {
        const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const promptSummary = prompt.slice(0, 800);
        const responseStr = JSON.stringify(parsedDecision2).slice(0, 2000);
        const sourceTags =
          JSON.stringify({
            model: usedModel,
            provenance,
            clampedPositionSize: positionSizePercent !== parsedDecision2.positionSizePercent,
          }) || null;
        saveAgentDecisionDb({
          id: decisionId,
          created_at: Date.now(),
          symbol: String(symbol || "BTC/USDT"),
          action: parsedDecision2.action,
          confidence: parsedDecision2.confidence,
          model_id: usedModel,
          latency_ms: inferenceLatency,
          prompt: promptSummary,
          response: responseStr,
          source_tags: sourceTags,
        });
        appendAudit("decision", {
          decisionId,
          symbol: String(symbol || "BTC/USDT"),
          action: parsedDecision2.action,
          confidence: parsedDecision2.confidence,
          latencyMs: inferenceLatency,
          modelId: usedModel,
          prompt: promptSummary.slice(0, 200),
          response: responseStr.slice(0, 500),
          provenance,
          provenance_json: provenance,
        });
      } catch (e) {
        console.warn(`[audit] Gagal simpan decision: ${(e as Error).message}`);
      }
      // 4.5: ringkas prompt (3 baris) dikirim ke UI agar DecisionStream <details> terisi.
      const promptSummary =
        [
          `symbol=${symbol} price=${currentPrice}`,
          `mtf=${mtfLiquidity?.activeState ?? "?"} state, conf=${mtfLiquidity?.confluenceScore ?? "?"}%`,
          `riskMax=${riskParams?.maxRiskPerTradePercent ?? "?"}% equity=${portfolioEquity ?? "?"}`,
        ].join("\n") + `\nmodel=${usedModel} latency=${inferenceLatency}ms`;
      return res.json({
        ...parsedDecision2,
        positionSizePercent,
        source: usedModel,
        inferenceLatencyMs: inferenceLatency,
        provenance,
        promptSummary,
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

  // Tanpa Gemini: tetap audit (latency nyata) lalu fallback client-side
  try {
    const latencyMs = Date.now() - startTime;
    const fallbackDecision: any = {
      action: "HOLD",
      confidence: 50,
      targetPrice: currentPrice ?? 0,
      stopLoss: 0,
      takeProfit: 0,
      positionSizePercent: 0,
      reasoning: "GEMINI_API_KEY tidak dikonfigurasi — fallback client-side; audit HOLD tercatat.",
    };
    const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const promptSummary = `policy=fallback symbol=${String(symbol || "BTC/USDT")} price=${currentPrice}`.slice(0, 800);
    const responseStr = JSON.stringify(fallbackDecision).slice(0, 2000);
    try {
      saveAgentDecisionDb({
        id: decisionId,
        created_at: Date.now(),
        symbol: String(symbol || "BTC/USDT"),
        action: "HOLD",
        confidence: 50,
        model_id: "fallback-hold",
        latency_ms: latencyMs,
        prompt: promptSummary,
        response: responseStr,
        source_tags: "fallback",
      });
    } catch (e) {
      console.warn(`[audit] Gagal simpan fallback decision: ${(e as Error).message}`);
    }
    try {
      appendAudit("decision", {
        decisionId,
        symbol: String(symbol || "BTC/USDT"),
        action: "HOLD",
        confidence: 50,
        latencyMs,
        modelId: "fallback-hold",
        source: "fallback",
      });
    } catch {}
  } catch {}
  return res.status(503).json({
    success: false,
    source: "unavailable",
    message: "GEMINI_API_KEY belum dikonfigurasi. Fallback keputusan ditangani client-side (logic/decisionEngine).",
  });
});

// ================= BROKER ROUTES (ccxt provider) =================

// Status broker (mode paper/live + apakah live order bisa dipasang) — PROTECTED
app.get("/api/broker/status", requireAuth, (_req, res) => {
  res.json({ success: true, ...getBrokerStatus() });
});

// Ticker via ccxt (public, lintas exchange) — stays public
app.get("/api/broker/ticker", async (req, res) => {
  const symbol = parseMarketSymbol(String(req.query.symbol || "BTC/USDT")).ccxt;
  try {
    const ticker = await fetchCcxtTicker(symbol);
    res.json({ success: true, ...ticker });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err?.message || "Ticker fetch gagal." });
  }
});

// Order book via ccxt (public) — stays public
app.get("/api/broker/orderbook", async (req, res) => {
  const symbol = parseMarketSymbol(String(req.query.symbol || "BTC/USDT")).ccxt;
  const limit = Math.min(50, Math.max(5, parseInt(String(req.query.limit || "12"))));
  try {
    const book = await fetchCcxtOrderBook(symbol, limit);
    res.json({ success: true, ...book });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err?.message || "Order book fetch gagal." });
  }
});

// OHLCV via ccxt (public, timeframe ccxt: "1m","5m","15m","1h","4h","1d","1w") — stays public
app.get("/api/broker/klines", async (req, res) => {
  const symbol = parseMarketSymbol(String(req.query.symbol || "BTC/USDT")).ccxt;
  const timeframe = String(req.query.timeframe || req.query.interval || "15m");
  const limit = Math.min(100, Math.max(10, parseInt(String(req.query.limit || "50"))));
  try {
    const candles = await fetchCcxtOHLCV(symbol, timeframe, limit);
    res.json({ success: true, symbol, timeframe, candles });
  } catch (err: any) {
    res.status(502).json({ success: false, message: err?.message || "OHLCV fetch gagal." });
  }
});

// Balance (paper: saldo akun paper book; live: saldo exchange asli) — PROTECTED
app.get("/api/broker/balance", requireAuth, async (_req, res) => {
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

// Simpan credential broker ke vault lokal (.broker-secrets.json, gitignored) — PROTECTED
app.post("/api/broker/credentials", requireAuth, async (req, res) => {
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

// Hapus credential vault lokal — PROTECTED
app.post("/api/broker/credentials/clear", requireAuth, async (_req, res) => {
  await clearBrokerCredentials();
  res.json({ success: true, ...getBrokerStatus() });
});

// Credential status — PROTECTED
app.get("/api/broker/credentials/status", requireAuth, (_req, res) => {
  res.json(getVaultCredentialsStatus());
});

// Tes koneksi real ke exchange (READ-ONLY: fetchBalance, TIDAK pernah order) — PROTECTED
app.post("/api/broker/test", requireAuth, async (_req, res) => {
  try {
    const result = await testBrokerConnection();
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Koneksi gagal." });
  }
});

// Guardrails — PROTECTED
app.get("/api/broker/guardrails", requireAuth, async (_req, res) => {
  const snap = await getGuardrailsSnapshotAsync();
  res.json({ success: true, ...snap });
});

app.post("/api/broker/kill", requireAuth, (req, res) => {
  const active = Boolean((req.body || {}).active);
  const state = setKillSwitch(active);
  // Return full guard state similar to guardrails endpoint shape
  const snapSync = getGuardrailsSnapshotSync();
  res.json({ success: true, killSwitch: state.killSwitch, guardrails: snapSync, state });
});

// Arm / Disarm — PROTECTED
app.post("/api/broker/arm", requireAuth, async (_req, res) => {
  try {
    await setLiveArmed(true);
    res.json({ success: true, liveArmed: true, armedForLive: true, ...getBrokerStatus() });
  } catch (err: any) {
    const msg = err?.message || "Gagal arm live.";
    const isArmError = String(msg).includes("ARM_REQUIRES_LIVE_AND_CREDENTIALS");
    res.status(400).json({ success: false, code: isArmError ? "ARM_REQUIRES_LIVE_AND_CREDENTIALS" : "ARM_FAILED", message: msg });
  }
});

app.post("/api/broker/disarm", requireAuth, async (_req, res) => {
  try {
    await setLiveArmed(false);
    res.json({ success: true, liveArmed: false, armedForLive: false, ...getBrokerStatus() });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Gagal disarm." });
  }
});

// Helper to map GuardrailRejectedError to 403 REJECTED JSON
function guardReject(res: any, reason: string, message?: string) {
  return res.status(403).json({
    success: false,
    status: "REJECTED",
    reason,
    message: message || `Order ditolak guardrail: ${reason}`,
  });
}

// Order (paper: buku posisi paper dengan fill terukur; live: order exchange asli) — PROTECTED + guardrails
app.post("/api/broker/order", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};

    // ---------- PAPER MODE ----------
    if (getBrokerStatus().mode !== "live") {
      // Closing order: { closePositionId } — closing de-risks, no guardrail
      if (body.closePositionId) {
        try {
          const result = await closePaperPosition(String(body.closePositionId), "MANUAL");
          try {
            appendAudit("exit", {
              positionId: result.position.id,
              symbol: result.position.symbol,
              side: result.position.side,
              exitReason: "MANUAL",
              exitPrice: result.exitFillPrice,
              realizedPnlUSD: result.realizedPnlUSD,
              orderId: result.order.id,
            });
          } catch (err) {
            // P3: audit failure TIDAK boleh silent — log selalu biar operator tau.
            console.error("[audit] GAGAL tulis audit close: ", (err as Error)?.message);
          }
          return res.json({ success: true, mode: "paper", closed: true, ...result });
        } catch (err: any) {
          if (err instanceof PaperOrderError) {
            return res.status(400).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
          }
          return res.status(400).json({ success: false, status: "REJECTED", reason: "CLOSE_FAILED", message: err?.message || "Gagal menutup posisi." });
        }
      }

      // Opening order — evaluate guardrails before placement
      // Only guard OPENs, not closes
      const guard = await evaluateGuardrails({ symbol: String(body.symbol || "BTC/USDT") });
      if (!guard.allowed) {
        const primary = guard.reasons[0] as string;
        return guardReject(res, primary, `Order ditolak guardrail: ${primary} (${guard.reasons.join(", ")})`);
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
        recordOrderPlaced();
        try {
          appendAudit("order", {
            orderId: result.order.id,
            positionId: result.position.id,
            symbol: result.position.symbol,
            side: result.order.side,
            amount: result.order.amount,
            fillPrice: result.order.fillPrice,
            leverage: result.order.leverage,
            stopLoss: body.stopLoss,
            takeProfit: body.takeProfit,
          });
        } catch (err) {
          console.error("[audit] GAGAL tulis audit order: ", (err as Error)?.message);
        }
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

    // ---------- LIVE MODE (pass-through, guarded + double-lock) ----------
    // Guardrails must also apply to live opens
    const guardLive = await evaluateGuardrails({ symbol: String(body.symbol || "BTC/USDT") });
    if (!guardLive.allowed) {
      const primary = guardLive.reasons[0] as string;
      return guardReject(res, primary, `Order ditolak guardrail: ${primary} (${guardLive.reasons.join(", ")})`);
    }
    // Double-lock: liveArmed check is inside placeBrokerOrder via assertLiveAllowed, but we surface clearly
    try {
      const result = await placeBrokerOrder(body);
      recordOrderPlaced();
      res.json({ success: true, ...result });
    } catch (err: any) {
      const code = err?.code;
      if (code === "LIVE_NOT_ARMED") {
        return guardReject(res, "LIVE_NOT_ARMED", err.message);
      }
      if (err instanceof GuardrailRejectedError) {
        return guardReject(res, err.reason, err.message);
      }
      // Map other errors to REJECTED shape if they look like guard
      if (String(err?.message).includes("ARM_REQUIRES_LIVE_AND_CREDENTIALS")) {
        return res.status(400).json({ success: false, status: "REJECTED", reason: "ARM_REQUIRES_LIVE_AND_CREDENTIALS", message: err.message });
      }
      res.status(400).json({ success: false, status: "REJECTED", reason: "ORDER_FAILED", message: err?.message || "Order gagal." });
    }
  } catch (err: any) {
    // Generic fallback — check if it's a guard error
    if (err instanceof GuardrailRejectedError) {
      return guardReject(res, err.reason, err.message);
    }
    res.status(400).json({ success: false, message: err?.message || "Order gagal." });
  }
});

// Positions (paper: buku posisi paper dengan mark terbaru; live: belum disimpan, passthrough) — PROTECTED
app.get("/api/broker/positions", requireAuth, async (_req, res) => {
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

// Close posisi (paper: market close via paper book) — PROTECTED (closing de-risks, no guardrail)
app.post("/api/broker/close", requireAuth, async (req, res) => {
  try {
    if (getBrokerStatus().mode === "live") {
      return res.status(400).json({ success: false, message: "Live close via /api/broker/close belum diimplementasikan (roadmap Phase 2+)." });
    }
    const positionId = String((req.body || {}).positionId || "");
    if (!positionId) {
      return res.status(400).json({ success: false, status: "REJECTED", reason: "MISSING_POSITION_ID", message: "positionId wajib diisi." });
    }
    const result = await closePaperPosition(positionId, "MANUAL");
    try {
      appendAudit("exit", {
        positionId: result.position.id,
        symbol: result.position.symbol,
        side: result.position.side,
        exitReason: "MANUAL",
        exitPrice: result.exitFillPrice,
        realizedPnlUSD: result.realizedPnlUSD,
        orderId: result.order.id,
      });
    } catch (err) {
      console.error("[audit] GAGAL tulis audit close (manual): ", (err as Error)?.message);
    }
    res.json({ success: true, mode: "paper", closed: true, ...result });
  } catch (err: any) {
    if (err instanceof PaperOrderError) {
      const status = err.code === "POSITION_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
    }
    res.status(400).json({ success: false, message: err?.message || "Close gagal." });
  }
});

// Update SL/TP posisi (manual SL edit / move-to-break-even) — PROTECTED
app.post("/api/broker/position/update", requireAuth, (req, res) => {
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

// Order status: receipt order paper yang tersimpan (600 status lifecycle ada; NEW->FILLED sinkron) — PROTECTED
app.get("/api/broker/order-status/:orderId", requireAuth, (req, res) => {
  const order = getPaperOrder(String(req.params.orderId || ""));
  if (!order) {
    return res.status(404).json({ success: false, message: `Order ${req.params.orderId} tidak ditemukan.` });
  }
  res.json({ success: true, mode: "paper", order });
});

// Event log paper book (ring buffer) dengan sinceSeq — PROTECTED
app.get("/api/broker/events", requireAuth, (req, res) => {
  const sinceSeq = Math.max(0, parseInt(String(req.query.sinceSeq || "0"), 10) || 0);
  const events = getPaperEvents(sinceSeq);
  res.json({ success: true, mode: "paper", events, latestSeq: getLatestEventSeq() });
});

// ================= AUDIT LEDGER (HMAC chain) — PROTECTED =================
app.get("/api/ledger", requireAuth, (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  const cursorRaw = req.query.cursor != null ? String(req.query.cursor) : undefined;
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : undefined;
  const { entries, nextCursor } = getLedgerEntries({ limit, cursor: cursor && isFinite(cursor) ? cursor : undefined });
  const mapped = entries.map((e) => ({
    seq: e.seq,
    kind: e.kind,
    payload: e.payload,
    createdAt: e.createdAt,
    prevHash: e.prevHash,
    hash: e.hash,
  }));
  res.json({ success: true, entries: mapped, nextCursor });
});

app.get("/api/ledger/verify", requireAuth, (_req, res) => {
  const result = verifyLedger();
  res.json({ success: true, ...result });
});

app.get("/api/ledger/stats", requireAuth, (_req, res) => {
  const stats = getLedgerStats();
  res.json({ success: true, ...stats });
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

  app.listen(PORT, HOST, () => {
    console.log(`[AI Trading Agent] Server listening on http://${HOST}:${PORT}`);
    // Paper book adalah sumber kebenaran posisi paper; monitor bracket aktif
    // hanya di mode selain live.
    if (getBrokerStatus().mode !== "live") {
      console.log(`[AI Trading Agent] Paper mode aktif; buku posisi: ${getBookFilePath()}`);
      startBracketMonitor(3000);
    }
  });
}

initPaperBook();
initGuardrails();
startServer();
