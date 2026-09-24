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
  generateOrderBook,
} from "../logic/indicators";
import { analyzeMTFLiquidity } from "../logic/liquidityHunt";
import { generateNextMicroTick } from "../logic/microTickStream";
import { fetchKlinesForTimeframe, fetchLiveMarketData, type CandleSource } from "../data/marketData";
import {
  bootBackoffDelay,
  classifyBootFeed,
  probeServerHealth,
} from "../data/marketData";
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
 * Deadband: tahan nilai lama bila perubahan di bawah ambang — angka indikator
 * tidak berkedip karena noise micro-tick 1s. BUKAN pembulatan data (nilai
 * real tetap dipakai saat ambang terlampaui).
 */
function withDeadband(next: number, prev: number, tol: number): number {
  if (!isFinite(next)) return prev;
  if (!isFinite(prev)) return next;
  return Math.abs(next - prev) < tol ? prev : next;
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
  // F-02: provenance per-TF — seed awal KOSONG = bukan sintetis-tanpa-label.
  // 15m/4h jadi REAL setelah syncLiveExchangeData; TF lain jadi REAL/SYNTHETIC
  // eksplisit setelah loadTimeframe selesai (fetchKlinesForTimeframe berlabel).
  // Default "SYNTHETIC" HANYA untuk slot yang belum pernah di-load (kosong),
  // agar badge tidak pernah klaim REAL sebelum ada fetch sukses.
  const [candleSourceByTimeframe, setCandleSourceByTimeframe] = useState<Record<Timeframe, CandleSource>>({
    "1s": "SYNTHETIC",
    "1m": "SYNTHETIC",
    "5m": "SYNTHETIC",
    "15m": "SYNTHETIC",
    "1h": "SYNTHETIC",
    "4h": "SYNTHETIC",
    "1D": "SYNTHETIC",
    "1W": "SYNTHETIC",
  });
  const [candleOriginByTimeframe, setCandleOriginByTimeframe] = useState<Record<Timeframe, string>>({
    "1s": "NONE",
    "1m": "NONE",
    "5m": "NONE",
    "15m": "NONE",
    "1h": "NONE",
    "4h": "NONE",
    "1D": "NONE",
    "1W": "NONE",
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
  // SRV-WATCH-1: status awal JUJUR — "probing", bukan klaim BINANCE_LIVE.
  // Sebelum sync pertama sukses (atau synthetic berlabel setelah N gagal),
  // UI memakai feedMode SIMULATED + hasLivePrice=false (harga tampil "—").
  const [exchangeStatus, setExchangeStatus] = useState<ExchangeFeedStatus>({
    source: "SIMULATED",
    latencyMs: 0,
    lastSyncTimestamp: Date.now(),
    isLive: false,
    activeEndpoint: "boot-probe",
  });
  const [isSyncingFeed, setIsSyncingFeed] = useState<boolean>(false);
  // Boot gate: null = masih probing; true = server terjangkau; false = offline.
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  // Jumlah gagal-sync beruntun (untuk label banner "attempt N").
  const [bootAttempt, setBootAttempt] = useState<number>(0);
  // True setelah sync sukses pertama ATAU synthetic berlabel (pasca-N-gagal).
  // Men-gate tampilan harga & seed order-book sintetis di tick loop.
  const [hasLivePrice, setHasLivePrice] = useState<boolean>(false);

  // Anchor harga real terakhir dari exchange (dipakai untuk mean-reversion di tick loop).
  const anchorPriceRef = useRef<number>(64250.0);
  // Gagal-sync beruntun (ref — pemicu retry; cermin state bootAttempt untuk banner).
  const bootFailuresRef = useRef<number>(0);
  // Cermin hasLivePrice untuk tick loop 1s (tanpa re-subscribe interval).
  const hasLivePriceRef = useRef<boolean>(false);
  // Throttle indikator: timestamp + harga saat technicals terakhir dihitung.
  const lastTechAtRef = useRef<number>(0);
  const lastTechPriceRef = useRef<number>(0);

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

  // MTF liquidity lintas SEMUA timeframe: candlesByTimeframe yang sudah di-load
  // (1s–1W) + 15m/4h yang di-update live via feed. TF tanpa candle ≥5 dilabeli
  // NO DATA oleh analyzer — bukan dilewati diam-diam.
  const mtfLiquidity: MTFLiquidityAnalysis = useMemo(() => {
    const allCandles: Partial<Record<Timeframe, Candle[]>> = {
      ...candlesByTimeframe,
      "15m": candles15m.length > 0 ? candles15m : candlesByTimeframe["15m"],
      "4h": candles4h.length > 0 ? candles4h : candlesByTimeframe["4h"],
    };
    return analyzeMTFLiquidity(allCandles, currentPrice, "FUTURES", orderBook);
  }, [candles15m, candles4h, candlesByTimeframe, currentPrice, orderBook]);

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
      // Happy path tanpa latensi tambahan: sync + probe jalan KONKUREN.
      // Sync sukses selalu menang; probe HANYA menghalangi synthetic fallback.
      const [feed, healthy] = await Promise.all([
        fetchLiveMarketData(symbolRef.current, base),
        probeServerHealth(3000),
      ]);
      // SRV-WATCH-1 boot gate: server down + feed tak-live = synthetic murni.
      // Tahan (HOLD_RETRY) sampai N gagal — slot candle/harga tetap kosong,
      // banner SERVER OFFLINE yang bicara. Lolos gate (APPLY) = data real
      // ATAU synthetic yang sudah berlabel (candlesReal:false → SYNTHETIC).
      const failures = bootFailuresRef.current + 1;
      const decision = classifyBootFeed({
        serverReachable: healthy,
        feedLive: feed.status.isLive,
        consecutiveFailures: failures,
      });
      if (decision === "HOLD_RETRY") {
        bootFailuresRef.current = failures;
        setBootAttempt(failures);
        setServerOnline(false);
        return;
      }
      bootFailuresRef.current = 0;
      setBootAttempt(0);
      setServerOnline(healthy);

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
      }));
      // F-02: 15m/4h ikut status feed (real bila exchange sukses, sintetis bila
      // market-feed fallback). TF lain TETAP kosong sampai loadTimeframe
      // berlabel — tidak pernah di-seed generator tanpa label.
      // candlesReal=false juga bila marketData.ts generate 4h lokal meski 15m real.
      const feedIsReal = feed.status.isLive && feed.candlesReal !== false;
      const tfOrigin = String(feed.status.source || "UNKNOWN");
      setCandleSourceByTimeframe((prev) => ({
        ...prev,
        "15m": feed.candles15m.length > 0 ? (feedIsReal ? "REAL" : "SYNTHETIC") : prev["15m"],
        "4h": feed.candles4h.length > 0 ? (feedIsReal ? "REAL" : "SYNTHETIC") : prev["4h"],
      }));
      setCandleOriginByTimeframe((prev) => ({ ...prev, "15m": tfOrigin, "4h": tfOrigin }));

      const closes = feed.candles15m.map((c) => c.close);
      const freshTechnicals = {
        rsi: calculateRSI(closes, 14),
        ema20: calculateEMA(closes, 20),
        ema50: calculateEMA(closes, 50),
        macd: calculateMACD(closes),
        orderBookImbalance: 1.15,
        volatility: "2.3%",
      };
      setTechnicals(freshTechnicals);
      lastTechAtRef.current = Date.now();
      lastTechPriceRef.current = feed.currentPrice;
      // Harga boleh tampil (header) & book boleh di-seed: data real, atau
      // synthetic yang sudah lewat gate N-gagal + berlabel SYNTHETIC.
      hasLivePriceRef.current = true;
      setHasLivePrice(true);

      onFeedLiveRef.current?.(feed.currentPrice);
    } catch (err) {
      console.warn("Error in syncLiveExchangeData:", err);
    } finally {
      setIsSyncingFeed(false);
    }
  }, []);

  const loadTimeframe = useCallback(async (tf: Timeframe) => {
    try {
      const result = await fetchKlinesForTimeframe(symbolRef.current, tf, priceRef.current, 300);
      const loadedCandles = result.candles;
      if (loadedCandles && loadedCandles.length > 0) {
        setCandlesByTimeframe((prev) => ({ ...prev, [tf]: loadedCandles }));
        // F-02: catat provenance berlabel dari wrapper (REAL vs SYNTHETIC).
        setCandleSourceByTimeframe((prev) => ({ ...prev, [tf]: result.source }));
        setCandleOriginByTimeframe((prev) => ({ ...prev, [tf]: result.origin }));

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

  // Eager-load semua TF (1m/5m/1h/1D/1W) saat symbol pertama kali maupun ganti,
  // agar MTF matrix dashboard & confluence browser punya zona likuiditas lintas
  // timeframe TANPA user harus klik TF satu-satu. 15m/4h sudah terisi feed live
  // dan 1s dari micro-tick stream — tidak perlu di-load ulang.
  const eagerLoadedSymbolRef = useRef<string>("");
  useEffect(() => {
    if (eagerLoadedSymbolRef.current === symbol) return;
    eagerLoadedSymbolRef.current = symbol;
    const eagerTfs: Timeframe[] = ["1m", "5m", "1h", "1D", "1W"];
    eagerTfs.forEach((tf) => {
      loadTimeframe(tf);
    });
  }, [symbol, loadTimeframe]);

  // Re-anchor otomatis ke harga real exchange tiap 20s, agar simulasi tick 1s
  // selalu berjalan dekat dengan basis data real terbaru.
  useEffect(() => {
    const reanchorTimer = setInterval(() => {
      syncLiveExchangeData();
    }, 20000);
    return () => clearInterval(reanchorTimer);
  }, [symbol, syncLiveExchangeData]);

  // SRV-WATCH-1 boot retry: selama server offline, jadwalkan ulang sync yang
  // SAMA (tanpa timer/duplikasi logika baru) dengan backoff 2s→4s→8s…cap 30s.
  // Reanchor 20s di atas tetap jalan sebagai steady-state healer.
  useEffect(() => {
    if (serverOnline !== false) return;
    const delay = bootBackoffDelay(Math.max(0, bootAttempt - 1));
    const t = setTimeout(() => {
      syncLiveExchangeData();
    }, delay);
    return () => clearTimeout(t);
  }, [serverOnline, bootAttempt, symbol, syncLiveExchangeData]);

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
      setMicroTicks((prev) => [...prev.slice(-399), nextTick]);

      // Task 5.4: priceDelta TIDAK lagi diskalakan `+ delta * 10`. Nilainya
      // adalah priceChangePercent 24h real dari ticker Binance (set saat
      // syncLiveExchangeData) — jujur, bukan angka karangan.
      const updated15m = updateCandleSeries(candles15mRef.current, newPrice, nextTick.volume, 0.1);
      const updated4h = updateCandleSeries(candles4hRef.current, newPrice, nextTick.volume, 0);
      setCandles15m(updated15m);
      setCandles4h(updated4h);

      // Indikator (RSI/EMA/MACD) di-throttle: candle bergerak tiap tick OK,
      // tapi angka indikator hanya dihitung ulang tiap 5 detik ATAU bila harga
      // bergerak >0.05% sejak hitungan terakhir. Mencegah pill berkedip tiap
      // detik karena noise micro-tick — angka yang "tidak bisa diam".
      const lastTech = technicalsRef.current;
      const techAgeMs = Date.now() - (lastTechAtRef.current || 0);
      const lastTechPrice = lastTechPriceRef.current || 0;
      const priceMovePct = lastTechPrice > 0 ? Math.abs(newPrice - lastTechPrice) / lastTechPrice : 1;
      if (techAgeMs >= 5000 || priceMovePct > 0.0005) {
        const closes = updated15m.map((c) => c.close);
        const fresh: typeof lastTech = {
          rsi: withDeadband(calculateRSI(closes, 14), lastTech.rsi, 0.2),
          ema20: withDeadband(calculateEMA(closes, 20), lastTech.ema20, lastTech.ema20 * 0.0002),
          ema50: withDeadband(calculateEMA(closes, 50), lastTech.ema50, lastTech.ema50 * 0.0002),
          macd: {
            macdLine: calculateMACD(closes).macdLine,
            signalLine: calculateMACD(closes).signalLine,
            histogram: withDeadband(calculateMACD(closes).histogram, lastTech.macd.histogram, 0.05),
          },
          orderBookImbalance: withDeadband(
            Math.max(0.4, Math.min(2.5, Number((1.0 + nextTick.orderFlowImbalance * 0.5).toFixed(2)))),
            lastTech.orderBookImbalance,
            0.02
          ),
          volatility: "2.4%",
        };
        lastTechAtRef.current = Date.now();
        lastTechPriceRef.current = newPrice;
        setTechnicals(fresh);
      }

      const tf = timeframeRef.current;
      const currentTf = candlesByTimeframeRef.current[tf];
      if (currentTf && currentTf.length > 0) {
        setCandlesByTimeframe((prev) => ({
          ...prev,
          [tf]: updateCandleSeries(currentTf, newPrice, nextTick.volume, 0.05),
        }));
      }

      // Order book: real dari SSE saat WS live; synthetic hanya saat interpolating
      // DAN setelah harga-live pertama (gate boot: sebelum itu book tetap
      // kosong — tidak di-seed sintetis seolah real). Steady-state identik.
      if (hasLivePrice && live.orderBook) setOrderBook(live.orderBook);
      else if (hasLivePriceRef.current) setOrderBook(generateOrderBook(newPrice));

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
    candleSourceByTimeframe,
    candleOriginByTimeframe,
    orderBook,
    technicals,
    technicalsByTimeframe,
    activeIndicatorTf,
    exchangeStatus,
    feedMode,
    messageRate: stream.messageRate,
    isSyncingFeed,
    mtfLiquidity,
    // SRV-WATCH-1 boot gate: null = probing, false = server offline (banner),
    // hasLivePrice = harga boleh tampil di header (false → "—", bukan $64.250).
    serverOnline,
    bootAttempt,
    hasLivePrice,
    syncLiveExchangeData,
    loadTimeframe,
    setActiveIndicatorTimeframe,
  };
}

export type MarketDataController = ReturnType<typeof useMarketData>;