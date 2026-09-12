import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Candle,
  ExchangeFeedStatus,
  FeedMode,
  MacroSummary,
  MicroTick1s,
  MTFLiquidityAnalysis,
  OnChainMetrics,
  OrderBook,
  TechnicalIndicators,
  Timeframe,
} from "../types";
import {
  calculateEMA,
  calculateMACD,
  calculateRSI,
  generateCandlesForTimeframe,
  generateOrderBook,
} from "../logic/indicators";
import { analyzeMTFLiquidity } from "../logic/liquidityHunt";
import { generateNextMicroTick } from "../logic/microTickStream";
import { fetchKlinesForTimeframe, fetchLiveMarketData } from "../data/marketData";
import { useMarketStream } from "./useMarketStream";

export interface UseMarketDataOptions {
  symbol: string;
  timeframe: Timeframe;
  onChainMetrics: OnChainMetrics;
  macroSummary: MacroSummary;
  /** Dipanggil setelah feed live berhasil sinkron (untuk refresh on-chain/makro). */
  onFeedLive?: (price: number) => void;
}

const ALL_TIMEFRAMES: Timeframe[] = ["1s", "1m", "5m", "15m", "1h", "4h", "1D", "1W"];

function updateCandleSeries(candles: Candle[], price: number, volume: number, volumeScale: number): Candle[] {
  if (!candles || candles.length === 0) return candles;
  const last = { ...candles[candles.length - 1] };
  last.close = price;
  last.high = Math.max(last.high, price);
  last.low = Math.min(last.low, price);
  if (volumeScale > 0) last.volume += Number((volume * volumeScale).toFixed(3));
  return [...candles.slice(0, -1), last];
}

/**
 * Feeder pasar real-time: 1s micro-tick stream (buat ML feature store),
 * candle multi-timeframe 1s-1W, order book, dan indikator teknikal.
 * Sinkronisasi data live lewat data/marketData.ts.
 */
export function useMarketData({ symbol, timeframe, onChainMetrics, macroSummary, onFeedLive }: UseMarketDataOptions) {
  const [currentPrice, setCurrentPrice] = useState<number>(64250.0);
  const [priceDelta, setPriceDelta] = useState<number>(1.84);
  const [microTicks, setMicroTicks] = useState<MicroTick1s[]>([]);
  const [candles15m, setCandles15m] = useState<Candle[]>([]);
  const [candles4h, setCandles4h] = useState<Candle[]>([]);
  const [candlesByTimeframe, setCandlesByTimeframe] = useState<Record<Timeframe, Candle[]>>({
    "1s": [],
    "1m": [],
    "5m": [],
    "15m": [],
    "1h": [],
    "4h": [],
    "1D": [],
    "1W": [],
  });
  const [orderBook, setOrderBook] = useState<OrderBook>({ bids: [], asks: [], spread: 1.2 });
  const [technicals, setTechnicals] = useState<TechnicalIndicators>({
    rsi: 48.5,
    ema20: 64180.0,
    ema50: 63950.0,
    macd: { macdLine: 12.4, signalLine: 8.2, histogram: 4.2 },
    orderBookImbalance: 1.18,
    volatility: "2.4%",
  });
  // Indikator per-TF: pill/header mengikuti TF yang diklik, bukan hardcode 15m.
  const [technicalsByTimeframe, setTechnicalsByTimeframe] = useState<Partial<Record<Timeframe, TechnicalIndicators>>>({});
  // TF aktif untuk indikator (diset via setActiveIndicatorTimeframe dari App).
  const [activeIndicatorTf, setActiveIndicatorTfState] = useState<Timeframe>("15m");
  const [exchangeStatus, setExchangeStatus] = useState<ExchangeFeedStatus>({
    source: "BINANCE_LIVE",
    latencyMs: 14,
    lastSyncTimestamp: Date.now(),
    isLive: true,
    activeEndpoint: "api.binance.com/v3",
  });
  const [isSyncingFeed, setIsSyncingFeed] = useState<boolean>(false);

  // Anchor harga real terakhir dari exchange (dipakai untuk mean-reversion di tick loop).
  const anchorPriceRef = useRef<number>(64250.0);

  // Task 5.1/5.2/6.3: konsumsi SSE proxy Binance WS — satu sumber kebenaran
  // harga real-time (harga & depth) untuk pipeline, chart, DAN portfolio.
  const stream = useMarketStream({ symbol });
  const streamRef = useRef(stream);
  streamRef.current = stream;

  // Feed mode otoritatif (task 5.2): berlabel jujur.
  const feedMode: FeedMode = useMemo(() => {
    const liveAge = stream.lastUpdateAt != null ? Date.now() - stream.lastUpdateAt : Number.POSITIVE_INFINITY;
    const wsFresh = liveAge <= 1500;
    if (wsFresh) return "WS_LIVE";
    if (exchangeStatus.source === "SIMULATED" && !exchangeStatus.isLive) return "SIMULATED";
    if (stream.feedMode === "REST_POLL") return "REST_POLL";
    if (stream.feedMode === "INTERPOLATED") return "INTERPOLATED";
    // WS terhubung tapi diam / WS tak pernah live: interpolasi di sekitar anchor.
    return exchangeStatus.isLive ? "INTERPOLATED" : "SIMULATED";
  }, [stream.lastUpdateAt, stream.feedMode, exchangeStatus.source, exchangeStatus.isLive]);

  // Sinkronkan feedMode & messageRate ke exchangeStatus (UI via prop exchangeStatus).
  useEffect(() => {
    setExchangeStatus((prev) =>
      prev.feedMode === feedMode && prev.messageRate === stream.messageRate
        ? prev
        : { ...prev, feedMode, messageRate: stream.messageRate }
    );
  }, [feedMode, stream.messageRate]);

  const mtfLiquidity: MTFLiquidityAnalysis = useMemo(
    () => analyzeMTFLiquidity(candles15m, candles4h, currentPrice, "FUTURES", orderBook),
    [candles15m, candles4h, currentPrice, orderBook]
  );

  // Refs terbarui tiap render -> interval 1s tidak pernah re-subscribe (anti churn).
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const priceRef = useRef(currentPrice);
  priceRef.current = currentPrice;
  const microTicksRef = useRef(microTicks);
  microTicksRef.current = microTicks;
  const technicalsRef = useRef(technicals);
  technicalsRef.current = technicals;
  const mtfLiquidityRef = useRef(mtfLiquidity);
  mtfLiquidityRef.current = mtfLiquidity;
  const onChainMetricsRef = useRef(onChainMetrics);
  onChainMetricsRef.current = onChainMetrics;
  const macroSummaryRef = useRef(macroSummary);
  macroSummaryRef.current = macroSummary;
  const onFeedLiveRef = useRef(onFeedLive);
  onFeedLiveRef.current = onFeedLive;
  const candles15mRef = useRef(candles15m);
  candles15mRef.current = candles15m;
  const candles4hRef = useRef(candles4h);
  candles4hRef.current = candles4h;
  const candlesByTimeframeRef = useRef(candlesByTimeframe);
  candlesByTimeframeRef.current = candlesByTimeframe;

  const getBasePrice = (sym: string): number => {
    if (sym.startsWith("BTC")) return 64250;
    if (sym.startsWith("ETH")) return 3480;
    return 145; // SOL
  };

  const syncLiveExchangeData = useCallback(async () => {
    setIsSyncingFeed(true);
    try {
      const base = getBasePrice(symbolRef.current);
      const feed = await fetchLiveMarketData(symbolRef.current, base);

      setCurrentPrice(feed.currentPrice);
      anchorPriceRef.current = feed.currentPrice;
      setCandles15m(feed.candles15m);
      setCandles4h(feed.candles4h);
      setOrderBook(feed.orderBook);
      setExchangeStatus(feed.status);
      setPriceDelta(feed.ticker24h.priceChangePercent);

      setCandlesByTimeframe((prev) => ({
        ...prev,
        "15m": feed.candles15m,
        "4h": feed.candles4h,
        "1s": prev["1s"].length ? prev["1s"] : generateCandlesForTimeframe(feed.currentPrice, "1s", 45),
        "1m": prev["1m"].length ? prev["1m"] : generateCandlesForTimeframe(feed.currentPrice, "1m", 45),
        "5m": prev["5m"].length ? prev["5m"] : generateCandlesForTimeframe(feed.currentPrice, "5m", 45),
        "1h": prev["1h"].length ? prev["1h"] : generateCandlesForTimeframe(feed.currentPrice, "1h", 45),
        "1D": prev["1D"].length ? prev["1D"] : generateCandlesForTimeframe(feed.currentPrice, "1D", 45),
        "1W": prev["1W"].length ? prev["1W"] : generateCandlesForTimeframe(feed.currentPrice, "1W", 45),
      }));

      const closes = feed.candles15m.map((c) => c.close);
      setTechnicals({
        rsi: calculateRSI(closes, 14),
        ema20: calculateEMA(closes, 20),
        ema50: calculateEMA(closes, 50),
        macd: calculateMACD(closes),
        orderBookImbalance: 1.15,
        volatility: "2.3%",
      });

      onFeedLiveRef.current?.(feed.currentPrice);
    } catch (err) {
      console.warn("Error in syncLiveExchangeData:", err);
    } finally {
      setIsSyncingFeed(false);
    }
  }, []);

  const loadTimeframe = useCallback(async (tf: Timeframe) => {
    try {
      const loadedCandles = await fetchKlinesForTimeframe(symbolRef.current, tf, priceRef.current, 50);
      if (loadedCandles && loadedCandles.length > 0) {
        setCandlesByTimeframe((prev) => ({ ...prev, [tf]: loadedCandles }));

        const closes = loadedCandles.map((c) => c.close);
        const perTf: TechnicalIndicators = {
          rsi: calculateRSI(closes, 14),
          ema20: calculateEMA(closes, 20),
          ema50: calculateEMA(closes, 50),
          macd: calculateMACD(closes),
          orderBookImbalance: technicalsRef.current.orderBookImbalance,
          volatility: "2.4%",
        };
        // Simpan per-TF; pill mengikuti TF aktif (lihat setActiveIndicatorTimeframe).
        setTechnicalsByTimeframe((prev) => ({ ...prev, [tf]: perTf }));
        if (timeframeRef.current === tf) {
          setTechnicals(perTf);
        }
      }
    } catch (err) {
      console.warn("Failed to load klines for timeframe:", tf, err);
    }
  }, []);

  // Dipanggil App saat user klik TF: pill indikator langsung ikut TF baru
  // (pakai cache per-TF bila ada, sekaligus fetch ulang candle TF tersebut).
  const setActiveIndicatorTimeframe = useCallback(
    (tf: Timeframe) => {
      timeframeRef.current = tf;
      setActiveIndicatorTfState(tf);
      const cached = candlesByTimeframeRef.current[tf];
      if (cached && cached.length > 0) {
        const closes = cached.map((c) => c.close);
        setTechnicals({
          rsi: calculateRSI(closes, 14),
          ema20: calculateEMA(closes, 20),
          ema50: calculateEMA(closes, 50),
          macd: calculateMACD(closes),
          orderBookImbalance: technicalsRef.current.orderBookImbalance,
          volatility: technicalsRef.current.volatility,
        });
      }
      loadTimeframe(tf);
    },
    [loadTimeframe]
  );

  // Sinkronisasi feed live saat symbol berubah.
  useEffect(() => {
    syncLiveExchangeData();
  }, [symbol, syncLiveExchangeData]);

  // Re-anchor otomatis ke harga real exchange tiap 20s, agar simulasi tick 1s
  // selalu berjalan dekat dengan basis data real terbaru.
  useEffect(() => {
    const reanchorTimer = setInterval(() => {
      syncLiveExchangeData();
    }, 20000);
    return () => clearInterval(reanchorTimer);
  }, [symbol, syncLiveExchangeData]);

  // --- Real-time 1-Second Micro-Tick Feeder (1000ms sampling) ---
  // Deps hanya [symbol] -> interval stabil, tanpa churn meski state berubah tiap detik.
  // Harga 1s: pakai trade harga real dari WS/SSE saat fresh; jika WS mati
  // (INTERPOLATED/REST_POLL), fallback ke microTick interpolation ter-anchor
  // harga exchange terakhir yang asli.
  useEffect(() => {
    const tickInterval = setInterval(() => {
      const live = streamRef.current;
      const wsFresh = live.lastUpdateAt != null && Date.now() - live.lastUpdateAt <= 1500;
      const hasLivePrice = wsFresh && live.currentPrice != null && live.currentPrice > 0;
      const prevPrice = priceRef.current;

      let nextTick: MicroTick1s;
      let newPrice: number;
      if (hasLivePrice) {
        // Harga nyata dari Binance (single source of truth, task 6.3).
        const real = live.currentPrice as number;
        nextTick = generateNextMicroTick(
          real,
          symbolRef.current,
          technicalsRef.current,
          mtfLiquidityRef.current,
          onChainMetricsRef.current,
          macroSummaryRef.current,
          microTicksRef.current,
          real
        );
        nextTick.close = real;
        nextTick.price = real;
        nextTick.open = prevPrice;
        nextTick.high = Math.max(prevPrice, real, nextTick.high);
        nextTick.low = Math.min(prevPrice, real, nextTick.low);
        newPrice = real;
      } else {
        nextTick = generateNextMicroTick(
          prevPrice,
          symbolRef.current,
          technicalsRef.current,
          mtfLiquidityRef.current,
          onChainMetricsRef.current,
          macroSummaryRef.current,
          microTicksRef.current,
          anchorPriceRef.current
        );
        newPrice = nextTick.close;
      }

      setCurrentPrice(newPrice);
      setMicroTicks((prev) => [...prev.slice(-119), nextTick]);

      // Task 5.4: priceDelta TIDAK lagi diskalakan `+ delta * 10`. Nilainya
      // adalah priceChangePercent 24h real dari ticker Binance (set saat
      // syncLiveExchangeData) — jujur, bukan angka karangan.
      const updated15m = updateCandleSeries(candles15mRef.current, newPrice, nextTick.volume, 0.1);
      const updated4h = updateCandleSeries(candles4hRef.current, newPrice, nextTick.volume, 0);
      setCandles15m(updated15m);
      setCandles4h(updated4h);

      const closes = updated15m.map((c) => c.close);
      setTechnicals({
        rsi: calculateRSI(closes, 14),
        ema20: calculateEMA(closes, 20),
        ema50: calculateEMA(closes, 50),
        macd: calculateMACD(closes),
        orderBookImbalance: Math.max(0.4, Math.min(2.5, Number((1.0 + nextTick.orderFlowImbalance * 0.5).toFixed(2)))),
        volatility: "2.4%",
      });

      const tf = timeframeRef.current;
      const currentTf = candlesByTimeframeRef.current[tf];
      if (currentTf && currentTf.length > 0) {
        setCandlesByTimeframe((prev) => ({
          ...prev,
          [tf]: updateCandleSeries(currentTf, newPrice, nextTick.volume, 0.05),
        }));
      }

      // Order book: real dari SSE saat WS live; synthetic hanya saat interpolating.
      setOrderBook(hasLivePrice && live.orderBook ? live.orderBook : generateOrderBook(newPrice));

      // Re-anchor ke harga real tiap tick WS agar interpolasi sempat (WS mati)
      // tetap dekat dengan harga exchange yang benar.
      if (hasLivePrice) anchorPriceRef.current = newPrice;
    }, 1000);

    return () => clearInterval(tickInterval);
  }, [symbol]);

  return {
    currentPrice,
    priceDelta,
    microTicks,
    candles15m,
    candles4h,
    candlesByTimeframe,
    orderBook,
    technicals,
    technicalsByTimeframe,
    activeIndicatorTf,
    exchangeStatus,
    feedMode,
    messageRate: stream.messageRate,
    isSyncingFeed,
    mtfLiquidity,
    syncLiveExchangeData,
    loadTimeframe,
    setActiveIndicatorTimeframe,
  };
}

export type MarketDataController = ReturnType<typeof useMarketData>;