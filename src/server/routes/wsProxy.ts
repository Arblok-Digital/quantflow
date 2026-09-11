// ---------------------------------------------------------------------------
// wsProxy.ts — Binance WebSocket -> SSE proxy (task 5.1)
// Route: GET /api/market/stream (public)
// State: streamSlots map + reconnect logic + heartbeatState updates
// ---------------------------------------------------------------------------
import type { Express } from "express";
import { parseMarketSymbol, fetchWithTimeout } from "./_utils";
import { updatePaperMarkCache } from "@/paperBook";

// heartbeatState di-inject via registerWsProxy (module-level agar connectBinanceStream bisa akses)
let wsHeartbeat: { lastWsTick: number; lastWsError: number } = { lastWsTick: 0, lastWsError: 0 };

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
    wsHeartbeat.lastWsTick = Date.now();
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



export function registerWsProxy(app: Express, heartbeatState: { lastWsTick: number; lastWsError: number }): void {
  wsHeartbeat = heartbeatState;
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

}
