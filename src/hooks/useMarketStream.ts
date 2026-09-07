import { useEffect, useRef, useState } from "react";
import { FeedMode, OrderBook } from "../types";

/**
 * useMarketStream — konsumen SSE /api/market/stream (task 5.1).
 * Server melakukan proxy WebSocket Binance (trade + depth@100ms) ke SSE.
 * Hook ini meng-update currentPrice & orderBook secara real-time dan
 * melaporkan feedMode + messageRate untuk badge UI (task 5.3).
 *
 * Jika EventSource tidak tersedia / route gagal, feedMode tetap di nilai
 * yang dilaporkan status terakhir, dan penggunaan REST polling berjalan
 * normal di useMarketData (fallback).
 */
export interface MarketStreamResult {
  currentPrice: number | null;
  orderBook: OrderBook | null;
  feedMode: FeedMode;
  messageRate: number;
  lastUpdateAt: number | null;
}

interface UseMarketStreamOptions {
  symbol: string;
}

export function useMarketStream({ symbol }: UseMarketStreamOptions): MarketStreamResult {
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [feedMode, setFeedMode] = useState<FeedMode>("REST_POLL");
  const [messageRate, setMessageRate] = useState<number>(0);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const lastMsgAtRef = useRef(Date.now());
  const everLiveRef = useRef(false);

  useEffect(() => {
    lastMsgAtRef.current = Date.now();
    if (typeof EventSource === "undefined") {
      setFeedMode("REST_POLL");
      return;
    }

    const rawSymbol = symbol.replace("/", "").toUpperCase();
    const es = new EventSource(`/api/market/stream?symbol=${encodeURIComponent(rawSymbol)}`);
    let messageCount = 0;
    let countWindowStart = Date.now();

    const rateTimer = setInterval(() => {
      const elapsed = (Date.now() - countWindowStart) / 1000;
      setMessageRate(elapsed > 0 ? Math.round(messageCount / elapsed) : 0);
      messageCount = 0;
      countWindowStart = Date.now();
    }, 2000);

    es.addEventListener("trade", (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data);
        const price = Number(msg.price);
        if (isFinite(price) && price > 0) {
          setCurrentPrice(price);
          everLiveRef.current = true;
          lastMsgAtRef.current = Date.now();
          setLastUpdateAt(lastMsgAtRef.current);
          setFeedMode("WS_LIVE");
          messageCount += 1;
        }
      } catch {
        // abaikan frame malformed
      }
    });

    es.addEventListener("depth", (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data);
        if (Array.isArray(msg.bids) && Array.isArray(msg.asks)) {
          setOrderBook({
            bids: msg.bids,
            asks: msg.asks,
            spread:
              msg.bids.length > 0 && msg.asks.length > 0
                ? Number((msg.asks[0].price - msg.bids[0].price).toFixed(2))
                : 0,
          });
          messageCount += 1;
        }
      } catch {
        // abaikan frame malformed
      }
    });

    es.addEventListener("status", (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data);
        if (msg.feedMode === "REST_POLL") {
          // WS pernah live lalu putus -> INTERPOLATED (task 5.2).
          // WS memang disabled sejak awal -> REST_POLL (fallback jujur).
          setFeedMode(everLiveRef.current ? "INTERPOLATED" : "REST_POLL");
        } else if (msg.feedMode) {
          setFeedMode(msg.feedMode as FeedMode);
        }
      } catch {
        // abaikan frame malformed
      }
    });

    // Watchdog: jika sudah >3s tanpa pesan dari SSE, tandai INTERPOLATED
    // (useMarketData akan memakai microTick interpolation di sekitar anchor).
    const stalenessTimer = setInterval(() => {
      if (Date.now() - lastMsgAtRef.current > 3000) {
        setFeedMode((prev) => (prev === "WS_LIVE" ? "INTERPOLATED" : prev));
      }
    }, 1000);

    es.onerror = () => {
      // EventSource auto-reconnect browser. Akurasi label ditangani watchdog.
    };

    return () => {
      clearInterval(rateTimer);
      clearInterval(stalenessTimer);
      es.close();
    };
  }, [symbol]);

  return { currentPrice, orderBook, feedMode, messageRate, lastUpdateAt };
}