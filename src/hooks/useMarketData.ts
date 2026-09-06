import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Candle,
  ExchangeFeedStatus,
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

  const mtfLiquidity: MTFLiquidityAnalysis = useMemo(
    () => analyzeMTFLiquidity(candles15m, candles4h, currentPrice),
    [candles15m, candles4h, currentPrice]
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
        setTechnicals((prev) => ({
          ...prev,
          rsi: calculateRSI(closes, 14),
          ema20: calculateEMA(closes, 20),
          ema50: calculateEMA(closes, 50),
          macd: calculateMACD(closes),
        }));
      }
    } catch (err) {
      console.warn("Failed to load klines for timeframe:", tf, err);
    }
  }, []);

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
  useEffect(() => {
    const tickInterval = setInterval(() => {
      const prevPrice = priceRef.current;
      const nextTick = generateNextMicroTick(
        prevPrice,
        symbolRef.current,
        technicalsRef.current,
        mtfLiquidityRef.current,
        onChainMetricsRef.current,
        macroSummaryRef.current,
        microTicksRef.current,
        anchorPriceRef.current
      );
      const newPrice = nextTick.close;

      setCurrentPrice(newPrice);
      setMicroTicks((prev) => [...prev.slice(-119), nextTick]);

      const deltaPercent = (newPrice - prevPrice) / prevPrice;
      setPriceDelta((prev) => Number((prev + deltaPercent * 10).toFixed(2)));

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

      setOrderBook(generateOrderBook(newPrice));
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
    exchangeStatus,
    isSyncingFeed,
    mtfLiquidity,
    syncLiveExchangeData,
    loadTimeframe,
  };
}

export type MarketDataController = ReturnType<typeof useMarketData>;