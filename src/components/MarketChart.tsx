import React, { useMemo, useState } from "react";
import { Candle, TechnicalIndicators, OrderBook, MTFLiquidityAnalysis, Timeframe } from "../types";
import { Layers, BarChart2, Flame, Crosshair, Clock, Compass, TrendingUp, Sparkles, Activity } from "lucide-react";
import { calculateEMA, calculateRSI, calculateMACD } from "../logic/indicators";

interface MarketChartProps {
  candles: Candle[];
  symbol: string;
  technicals: TechnicalIndicators;
  orderBook: OrderBook;
  currentPrice: number;
  mtfLiquidity: MTFLiquidityAnalysis;
  timeframe: Timeframe;
  onSelectTimeframe?: (tf: Timeframe) => void;
  /** Per-timeframe candle series — real data for the 4TF confluence matrix. */
  candlesByTimeframe?: Partial<Record<Timeframe, Candle[]>>;
}

const ALL_TIMEFRAMES: { id: Timeframe; label: string; tag?: string; desc: string }[] = [
  { id: "1s", label: "1s", tag: "ML", desc: "1-Detik (Ultra-High-Frequency ML Stream & Micro-Ticks)" },
  { id: "1m", label: "1m", desc: "1-Menit (Scalp Momentum & Intra-Minute Rejection)" },
  { id: "5m", label: "5m", desc: "5-Menit (Micro-Structure & Order Blocks)" },
  { id: "15m", label: "15m", tag: "AI CORE", desc: "15-Menit (Anchor AI Execution & Liquidity Sweep Hunter)" },
  { id: "1h", label: "1h", desc: "1-Jam (Hourly Trend & Fair Value Gap/FVG)" },
  { id: "4h", label: "4h", tag: "SWING", desc: "4-Jam (Macro Swing Liquidity & Institutional S/R)" },
  { id: "1D", label: "1D", desc: "1-Hari (Daily Institutional Bias & Key Range)" },
  { id: "1W", label: "1W", desc: "1-Minggu (Weekly Macro Cycle & Historic Value Area)" },
];

export const MarketChart: React.FC<MarketChartProps> = ({
  candles,
  symbol,
  technicals,
  orderBook,
  currentPrice,
  mtfLiquidity,
  timeframe,
  onSelectTimeframe,
  candlesByTimeframe,
}) => {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [crosshairPos, setCrosshairPos] = useState<{ x: number; y: number } | null>(null);

  // Compute bounds for SVG candlestick chart
  const { minPrice, maxPrice, priceRange, svgCandles } = useMemo(() => {
    if (candles.length === 0) {
      return { minPrice: 0, maxPrice: 100, priceRange: 100, svgCandles: [] };
    }

    const prices = candles.flatMap((c) => [c.low, c.high]);
    // Also factor in the nearest liquidation pools so they sit comfortably within chart viewport
    if (mtfLiquidity.nearestBSL) prices.push(mtfLiquidity.nearestBSL.midPrice);
    if (mtfLiquidity.nearestSSL) prices.push(mtfLiquidity.nearestSSL.midPrice);

    const min = Math.min(...prices) * 0.9985;
    const max = Math.max(...prices) * 1.0015;
    const range = Math.max(max - min, 1);

    const svgC = candles.map((c, i) => {
      const x = i * 16 + 10;
      const yHigh = 220 - ((c.high - min) / range) * 200;
      const yLow = 220 - ((c.low - min) / range) * 200;
      const yOpen = 220 - ((c.open - min) / range) * 200;
      const yClose = 220 - ((c.close - min) / range) * 200;
      const isUp = c.close >= c.open;

      return {
        ...c,
        x,
        yHigh,
        yLow,
        yTop: Math.min(yOpen, yClose),
        bodyHeight: Math.max(Math.abs(yClose - yOpen), 2),
        isUp,
      };
    });

    return { minPrice: min, maxPrice: max, priceRange: range, svgCandles: svgC };
  }, [candles, mtfLiquidity]);

  // Compute EMA lines for the chart
  const ema20Y = 220 - ((technicals.ema20 - minPrice) / priceRange) * 200;
  const ema50Y = 220 - ((technicals.ema50 - minPrice) / priceRange) * 200;

  // Compute Liquidity Pool Zone Y coords
  const nearestBSL = mtfLiquidity.nearestBSL;
  const nearestSSL = mtfLiquidity.nearestSSL;

  const bslY = nearestBSL ? 220 - ((nearestBSL.midPrice - minPrice) / priceRange) * 200 : -100;
  const sslY = nearestSSL ? 220 - ((nearestSSL.midPrice - minPrice) / priceRange) * 200 : -100;

  // Imbalance description
  const isBidHeavy = technicals.orderBookImbalance >= 1.15;
  const isAskHeavy = technicals.orderBookImbalance <= 0.85;

  // Active TF info
  const activeTfMeta = ALL_TIMEFRAMES.find((t) => t.id === timeframe) || ALL_TIMEFRAMES[3];
  const inspectedCandle =
    hoveredIndex !== null && svgCandles[hoveredIndex]
      ? svgCandles[hoveredIndex]
      : svgCandles[svgCandles.length - 1];

  const formatTimeLabel = (timestamp: number, tf: Timeframe) => {
    const d = new Date(timestamp);
    if (tf === "1s") {
      return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    if (tf === "1m" || tf === "5m" || tf === "15m") {
      return d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
    }
    if (tf === "1h" || tf === "4h") {
      return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" })}`;
    }
    if (tf === "1D" || tf === "1W") {
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    return d.toLocaleTimeString();
  };

  // MTF Multi-Timeframe Status Matrix (Indikator TF Confluence)
  // 4TF upgrade: real per-timeframe indicators computed from actual candles
  // (candlesByTimeframe), not hardcoded "BULLISH" claims. TFs without real
  // data are labeled honestly as "NO DATA" instead of fabricating a bias.
  const mtfIndicatorMatrix = useMemo(() => {
    const perTf = (tf: Timeframe): { rsi: number; ema20: number; ema50: number; macdHist: number } | null => {
      const series = candlesByTimeframe?.[tf];
      if (!series || series.length < 5) {
        return null;
      }
      const closes = series.map((c) => c.close);
      return {
        rsi: calculateRSI(closes, 14),
        ema20: calculateEMA(closes, 20),
        ema50: calculateEMA(closes, 50),
        macdHist: calculateMACD(closes).histogram,
      };
    };

    const biasOf = (v: { rsi: number; ema20: number; ema50: number; macdHist: number } | null, tf: Timeframe) => {
      if (!v) return { bias: "NO DATA" as const, signal: "no candle series loaded", statusBadge: "NODATA" };
      // EMA structure is the primary bias; RSI/MACD confirm
      const trend = v.ema20 >= v.ema50 ? "BULLISH" : "BEARISH";
      const confirm =
        v.rsi > 55 || v.macdHist > 0
          ? trend
          : v.rsi < 45 || v.macdHist < 0
          ? trend === "BULLISH" ? "NEUTRAL" : trend
          : "NEUTRAL";
      return {
        bias: confirm as "BULLISH" | "BEARISH" | "NEUTRAL",
        signal: `${v.rsi.toFixed(0)} RSI • EMA${v.ema20 >= v.ema50 ? "20>50" : "20<50"} • MACD ${v.macdHist >= 0 ? "bull" : "bear"}`,
        statusBadge: `${seriesLenLabel(tf)}`,
      };
    };

    const seriesLenLabel = (tf: Timeframe) => {
      const n = candlesByTimeframe?.[tf]?.length ?? 0;
      return n > 0 ? `${n} CANDLES` : "NO DATA";
    };

    const v15 = perTf("15m");
    const v1h = perTf("1h");
    const v4h = perTf("4h");
    const v1D = perTf("1D");
    const b15 = biasOf(v15, "15m");
    const b1h = biasOf(v1h, "1h");
    const b4h = biasOf(v4h, "4h");
    const b1D = biasOf(v1D, "1D");

    return [
      {
        tf: "1s" as Timeframe,
        name: "1s (ML Feed)",
        bias: technicals.orderBookImbalance >= 1.15 ? "BULLISH" : technicals.orderBookImbalance <= 0.85 ? "BEARISH" : "NEUTRAL",
        signal: `${technicals.orderBookImbalance.toFixed(2)}x L2 Imbalance`,
        statusBadge: "1000ms TICK",
      },
      {
        tf: "1m" as Timeframe,
        name: "1m (Scalp)",
        bias: technicals.rsi > 52 ? "BULLISH" : technicals.rsi < 48 ? "BEARISH" : "NEUTRAL",
        signal: `RSI ${technicals.rsi} Momentum`,
        statusBadge: "MICRO FLOW",
      },
      {
        tf: "5m" as Timeframe,
        name: "5m (Intraday)",
        bias: technicals.macd.histogram >= 0 ? "BULLISH" : "BEARISH",
        signal: technicals.macd.histogram >= 0 ? "FVG Expansion Bull" : "FVG Pullback",
        statusBadge: "STRUCTURE",
      },
      {
        tf: "15m" as Timeframe,
        name: "15m (AI Anchor)",
        bias: (mtfLiquidity.recentSweep?.type === "BULLISH_SSL_SWEEP" ? "BULLISH" : b15.bias) as "BULLISH" | "BEARISH" | "NEUTRAL",
        signal: mtfLiquidity.recentSweep?.type === "BULLISH_SSL_SWEEP" ? "🎯 SSL Swept + Reversal" : b15.signal,
        statusBadge: b15.statusBadge,
        isAnchor: true,
      },
      {
        tf: "1h" as Timeframe,
        name: "1h (Swing S/R)",
        bias: b1h.bias,
        signal: b1h.signal,
        statusBadge: b1h.statusBadge,
      },
      {
        tf: "4h" as Timeframe,
        name: "4h (Macro)",
        bias: b4h.bias,
        signal: b4h.signal,
        statusBadge: b4h.statusBadge,
      },
      {
        tf: "1D" as Timeframe,
        name: "1D (Daily)",
        bias: b1D.bias,
        signal: b1D.signal,
        statusBadge: b1D.statusBadge,
      },
      {
        tf: "1W" as Timeframe,
        name: "1W (Weekly)",
        bias: "NEUTRAL" as const,
        signal: "no weekly series loaded",
        statusBadge: "NODATA",
      },
    ];
  }, [technicals, mtfLiquidity, candlesByTimeframe]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 relative overflow-hidden shadow-sm flex flex-col">
      {/* Ambient Bento Dot Grid */}
      <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />

      {/* Chart Header */}
      <div className="relative z-10 mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-zinc-950 border border-zinc-800 text-amber-400 shadow-inner">
            <BarChart2 className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-zinc-200 uppercase tracking-wider font-mono">
                {symbol} &bull; {timeframe} Exchange View
              </h2>
              <span className="flex items-center gap-1.5 text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider">
                <Flame className="h-3 w-3 text-amber-400" />
                {timeframe === "15m" ? "AI Anchor 15m (Active)" : `Manual View (${timeframe})`}
              </span>
            </div>
            <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-wide">
              BSL (Buy-Side Liq) &bull; SSL (Sell-Side Liq) &bull; Stop-Loss Hunt Clusters
            </p>
          </div>
        </div>

        {/* Technical Indicators Pill */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <div className="flex items-center gap-1.5 rounded-xl bg-zinc-950 px-2.5 py-1.5 border border-zinc-800">
            <span className="text-zinc-500 text-[10px] font-semibold uppercase">RSI(14):</span>
            <span
              className={`font-bold ${
                technicals.rsi > 70
                  ? "text-rose-400"
                  : technicals.rsi < 30
                  ? "text-emerald-400"
                  : "text-zinc-200"
              }`}
            >
              {technicals.rsi}
            </span>
            <span className="text-[10px] text-zinc-500">
              {technicals.rsi > 70 ? "(Overbought)" : technicals.rsi < 30 ? "(Oversold)" : "(Neutral)"}
            </span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl bg-zinc-950 px-2.5 py-1.5 border border-zinc-800">
            <span className="text-blue-400 font-semibold text-[10px] uppercase">EMA20:</span>
            <span className="text-zinc-200">${technicals.ema20}</span>
            <span className="text-amber-400 font-semibold text-[10px] uppercase ml-1">EMA50:</span>
            <span className="text-zinc-200">${technicals.ema50}</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl bg-zinc-950 px-2.5 py-1.5 border border-zinc-800">
            <span className="text-zinc-500 text-[10px] font-semibold uppercase">Order Flow:</span>
            <span
              className={`font-bold ${
                isBidHeavy ? "text-emerald-400" : isAskHeavy ? "text-rose-400" : "text-zinc-300"
              }`}
            >
              {technicals.orderBookImbalance.toFixed(2)}x
            </span>
          </div>
        </div>
      </div>

      {/* Exchange Multi-Timeframe Toolbar (1s to 1W) */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-2 bg-zinc-950/80 border border-zinc-800/90 rounded-xl p-1.5 mb-3">
        <div className="flex items-center gap-1 overflow-x-auto py-0.5">
          <span className="text-[10px] font-mono font-bold text-zinc-500 uppercase px-1.5 flex items-center gap-1">
            <Clock className="w-3 h-3 text-zinc-400" /> TF:
          </span>
          {ALL_TIMEFRAMES.map((tf) => {
            const isActive = timeframe === tf.id;
            return (
              <button
                key={tf.id}
                onClick={() => onSelectTimeframe?.(tf.id)}
                className={`relative px-2.5 py-1 rounded-lg text-xs font-mono font-bold transition-all flex items-center gap-1.5 ${
                  isActive
                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/50 shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 border border-transparent"
                }`}
                title={tf.desc}
              >
                {tf.id === "1s" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                )}
                <span>{tf.label}</span>
                {tf.tag && (
                  <span
                    className={`text-[9px] px-1 py-0.2 rounded font-semibold ${
                      isActive ? "bg-amber-500/30 text-amber-200" : "bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    {tf.tag}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="text-[11px] font-mono text-zinc-400 px-2 flex items-center gap-2">
          <span className="text-zinc-500 hidden sm:inline">Active Route:</span>
          <span className="text-zinc-300 font-medium">{activeTfMeta.desc}</span>
        </div>
      </div>

      {/* Interactive OHLC Readout Bar (Manual Check Mode) */}
      <div className="relative z-10 flex flex-wrap items-center justify-between bg-zinc-950/90 border border-zinc-800/80 px-3 py-1.5 rounded-lg mb-3 text-xs font-mono text-zinc-300">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex items-center gap-1.5 text-zinc-400 font-semibold">
            <Crosshair className="w-3 h-3 text-amber-400" />
            <span className="text-zinc-200">{inspectedCandle ? formatTimeLabel(inspectedCandle.timestamp, timeframe) : "LIVE"}</span>
          </span>
          {inspectedCandle && (
            <>
              <span>O: <strong className="text-zinc-100">${inspectedCandle.open.toFixed(2)}</strong></span>
              <span>H: <strong className="text-emerald-400">${inspectedCandle.high.toFixed(2)}</strong></span>
              <span>L: <strong className="text-rose-400">${inspectedCandle.low.toFixed(2)}</strong></span>
              <span>C: <strong className={inspectedCandle.close >= inspectedCandle.open ? "text-emerald-400" : "text-rose-400"}>${inspectedCandle.close.toFixed(2)}</strong></span>
              <span>Vol: <strong className="text-zinc-200">{inspectedCandle.volume}</strong></span>
              <span>
                Chg:{" "}
                <strong className={inspectedCandle.close >= inspectedCandle.open ? "text-emerald-400" : "text-rose-400"}>
                  {inspectedCandle.close >= inspectedCandle.open ? "+" : ""}
                  {(((inspectedCandle.close - inspectedCandle.open) / inspectedCandle.open) * 100).toFixed(2)}%
                </strong>
              </span>
            </>
          )}
        </div>
        <div className="text-[10px] text-zinc-500 font-mono hidden md:block">
          {hoveredIndex !== null ? "Mode Cek Manual Aktif" : "Arahkan kursor ke lilin untuk cek detail OHLC"}
        </div>
      </div>

      {/* Main Grid: Candlestick Chart + Order Book Ladder */}
      <div className="relative z-10 grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Candlestick & Liquidity Pool Canvas (3 cols) */}
        <div className="lg:col-span-3 flex flex-col rounded-xl bg-zinc-950 p-3 border border-zinc-800 overflow-hidden relative shadow-inner">
          
          {/* TOP INTEGRATED TIMEFRAME SELECTOR BAR (Directly inside Chart Column) */}
          <div className="flex flex-wrap items-center justify-between gap-2 bg-zinc-900/95 border border-zinc-800 rounded-xl p-1.5 mb-2.5 z-20">
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[10px] font-mono font-bold text-amber-400 uppercase px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 flex items-center gap-1">
                <Flame className="w-3 h-3 text-amber-400" /> TIMEFRAME:
              </span>

              {/* All 8 exchange timeframes */}
              {ALL_TIMEFRAMES.map((tf) => {
                const isActive = timeframe === tf.id;
                return (
                  <button
                    key={tf.id}
                    onClick={() => onSelectTimeframe?.(tf.id)}
                    className={`relative px-2.5 py-1 rounded-lg text-xs font-mono transition-all flex items-center gap-1 ${
                      isActive
                        ? "bg-amber-500 text-zinc-950 font-black shadow-md shadow-amber-500/20 ring-1 ring-amber-400 scale-[1.03]"
                        : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/80 font-bold"
                    }`}
                    title={tf.desc}
                  >
                    {tf.id === "1s" && (
                      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-zinc-950" : "bg-cyan-400"} animate-pulse`} />
                    )}
                    {tf.id === "15m" && (
                      <span className="text-[10px]">★</span>
                    )}
                    <span>{tf.label}</span>
                    {tf.tag && (
                      <span
                        className={`text-[8.5px] px-1 py-0.2 rounded font-extrabold uppercase ${
                          isActive ? "bg-zinc-950 text-amber-400" : "bg-zinc-800 text-zinc-400"
                        }`}
                      >
                        {tf.tag}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Quick Timeframe Status Notice */}
            <div className="text-[10.5px] font-mono text-zinc-400 px-2 flex items-center gap-1.5">
              <span className="text-zinc-500">Route:</span>
              <span className="text-amber-300 font-semibold">{activeTfMeta.desc}</span>
            </div>
          </div>

          {/* Top overlay legend */}
          <div className="flex flex-wrap gap-2 text-[10px] font-mono text-zinc-400 bg-zinc-900/90 px-3 py-1.5 rounded-lg border border-zinc-800 backdrop-blur mb-2">
            <span className="flex items-center gap-1 text-rose-400 font-bold">
              <span className="h-1.5 w-3 bg-rose-500/30 border border-rose-500 rounded-sm inline-block" />
              BSL Short Liquidation Zone
            </span>
            <span className="flex items-center gap-1 text-emerald-400 font-bold">
              <span className="h-1.5 w-3 bg-emerald-500/30 border border-emerald-500 rounded-sm inline-block" />
              SSL Long Liquidation Zone
            </span>
            <span className="text-zinc-400">High: ${maxPrice.toFixed(2)}</span>
            <span className="text-zinc-400">Low: ${minPrice.toFixed(2)}</span>
          </div>

          {/* SVG Candlestick & Liquidity Overlay Plot */}
          <div className="w-full overflow-x-auto relative">
            <svg
              viewBox={`0 0 ${Math.max(680, svgCandles.length * 16 + 40)} 240`}
              className="w-full h-64 select-none cursor-crosshair bg-zinc-950/70"
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;
                const svgWidth = rect.width;
                const totalSvgWidth = Math.max(680, svgCandles.length * 16 + 40);
                const scale = totalSvgWidth / svgWidth;
                const actualX = mouseX * scale;
                const actualY = (mouseY / rect.height) * 240;

                const candleIdx = Math.min(
                  svgCandles.length - 1,
                  Math.max(0, Math.round((actualX - 10) / 16))
                );
                setHoveredIndex(candleIdx);
                setCrosshairPos({ x: svgCandles[candleIdx]?.x + 5 || actualX, y: actualY });
              }}
              onMouseLeave={() => {
                setHoveredIndex(null);
                setCrosshairPos(null);
              }}
            >
              {/* Big Watermark Identifier on Canvas */}
              <g opacity="0.10" className="pointer-events-none select-none">
                <text
                  x="50%"
                  y="46%"
                  textAnchor="middle"
                  fill="#f4f4f5"
                  fontSize="44"
                  fontWeight="900"
                  fontFamily="monospace"
                  letterSpacing="2"
                >
                  {symbol} • {timeframe}
                </text>
                <text
                  x="50%"
                  y="62%"
                  textAnchor="middle"
                  fill="#f59e0b"
                  fontSize="12"
                  fontWeight="bold"
                  fontFamily="monospace"
                  letterSpacing="1"
                >
                  {timeframe === "15m"
                    ? "★ AI AGENT ANCHOR EXECUTION (15m MTF)"
                    : timeframe === "1s"
                    ? "⚡ 1-SECOND MICRO-TICK STREAM (ML STORE)"
                    : `MANUAL ROUTE VIEW: ${timeframe}`}
                </text>
              </g>
              {/* Horizontal Grid lines */}
              {[40, 90, 140, 190].map((y) => (
                <line
                  key={y}
                  x1="0"
                  y1={y}
                  x2="100%"
                  y2={y}
                  stroke="#27272a"
                  strokeDasharray="3 3"
                  strokeWidth="0.8"
                />
              ))}

              {/* Upper BSL Liquidity Zone Band (Short Stops) */}
              {bslY >= 10 && bslY <= 230 && (
                <g>
                  <rect
                    x="0"
                    y={Math.max(0, bslY - 12)}
                    width="100%"
                    height="20"
                    fill="#f43f5e"
                    fillOpacity="0.08"
                  />
                  <line
                    x1="0"
                    y1={bslY}
                    x2="100%"
                    y2={bslY}
                    stroke="#f43f5e"
                    strokeWidth="1.2"
                    strokeDasharray="5 3"
                  />
                  <text
                    x="98%"
                    y={bslY - 3}
                    textAnchor="end"
                    fill="#fb7185"
                    fontSize="9.5"
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    ▲ BSL POOL: ${nearestBSL?.midPrice} (${nearestBSL?.estimatedVolumeUSD}M Short Liq)
                  </text>
                </g>
              )}

              {/* Lower SSL Liquidity Zone Band (Long Stops) */}
              {sslY >= 10 && sslY <= 230 && (
                <g>
                  <rect
                    x="0"
                    y={Math.min(220, sslY - 8)}
                    width="100%"
                    height="20"
                    fill="#10b981"
                    fillOpacity="0.08"
                  />
                  <line
                    x1="0"
                    y1={sslY}
                    x2="100%"
                    y2={sslY}
                    stroke="#10b981"
                    strokeWidth="1.2"
                    strokeDasharray="5 3"
                  />
                  <text
                    x="98%"
                    y={sslY + 12}
                    textAnchor="end"
                    fill="#34d399"
                    fontSize="9.5"
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    ▼ SSL POOL: ${nearestSSL?.midPrice} (${nearestSSL?.estimatedVolumeUSD}M Long Liq)
                  </text>
                </g>
              )}

              {/* EMA 20 line */}
              {ema20Y >= 0 && ema20Y <= 240 && (
                <line
                  x1="0"
                  y1={ema20Y}
                  x2="100%"
                  y2={ema20Y}
                  stroke="#60a5fa"
                  strokeWidth="1"
                  strokeDasharray="4 2"
                  opacity="0.6"
                />
              )}

              {/* EMA 50 line */}
              {ema50Y >= 0 && ema50Y <= 240 && (
                <line
                  x1="0"
                  y1={ema50Y}
                  x2="100%"
                  y2={ema50Y}
                  stroke="#fbbf24"
                  strokeWidth="1"
                  strokeDasharray="4 2"
                  opacity="0.6"
                />
              )}

              {/* Current Price dashed line */}
              {candles.length > 0 && (
                <line
                  x1="0"
                  y1={220 - ((currentPrice - minPrice) / priceRange) * 200}
                  x2="100%"
                  y2={220 - ((currentPrice - minPrice) / priceRange) * 200}
                  stroke="#38bdf8"
                  strokeWidth="1"
                  strokeDasharray="2 2"
                  opacity="0.9"
                />
              )}

              {/* Candlesticks with Sweep markers */}
              {svgCandles.map((c, idx) => {
                const isHovered = hoveredIndex === idx;
                const isRecentSweepCandle = mtfLiquidity.recentSweep && idx >= svgCandles.length - 3;

                return (
                  <g key={idx} className="cursor-pointer">
                    {/* Wick */}
                    <line
                      x1={c.x + 5}
                      y1={c.yHigh}
                      x2={c.x + 5}
                      y2={c.yLow}
                      stroke={c.isUp ? "#10b981" : "#f43f5e"}
                      strokeWidth={isHovered ? "2" : "1.2"}
                    />
                    {/* Body */}
                    <rect
                      x={c.x}
                      y={c.yTop}
                      width={10}
                      height={c.bodyHeight}
                      fill={c.isUp ? "#10b981" : "#f43f5e"}
                      stroke={isHovered ? "#ffffff" : "none"}
                      strokeWidth={isHovered ? "1" : "0"}
                      rx={1}
                    />

                    {/* Sweep highlight circle if active */}
                    {isRecentSweepCandle && (
                      <circle
                        cx={c.x + 5}
                        cy={mtfLiquidity.recentSweep?.type === "BULLISH_SSL_SWEEP" ? c.yLow : c.yHigh}
                        r="5"
                        fill="none"
                        stroke="#f59e0b"
                        strokeWidth="1.5"
                        className="animate-pulse"
                      />
                    )}

                    {/* Time tick on every 7th candle */}
                    {idx % 7 === 0 && (
                      <text
                        x={c.x + 5}
                        y={235}
                        textAnchor="middle"
                        fill="#71717a"
                        fontSize="8.5"
                        fontFamily="monospace"
                      >
                        {formatTimeLabel(c.timestamp, timeframe)}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Interactive Crosshair Overlay */}
              {crosshairPos && (
                <g className="pointer-events-none">
                  <line
                    x1={crosshairPos.x}
                    y1={0}
                    x2={crosshairPos.x}
                    y2={240}
                    stroke="#71717a"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    opacity="0.8"
                  />
                  <line
                    x1={0}
                    y1={crosshairPos.y}
                    x2="100%"
                    y2={crosshairPos.y}
                    stroke="#71717a"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                    opacity="0.8"
                  />
                  <rect
                    x="90%"
                    y={Math.max(2, crosshairPos.y - 8)}
                    width="60"
                    height="16"
                    fill="#18181b"
                    stroke="#71717a"
                    rx="3"
                  />
                  <text
                    x="95%"
                    y={Math.max(13, crosshairPos.y + 4)}
                    textAnchor="middle"
                    fill="#f4f4f5"
                    fontSize="9"
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    ${(maxPrice - (crosshairPos.y / 200) * priceRange).toFixed(1)}
                  </text>
                </g>
              )}
            </svg>
          </div>

          {/* MULTI-TIMEFRAME (MTF) CONFLUENCE MATRIX RIBBON ("INDIKATOR TF") */}
          <div className="mt-2.5 pt-2 border-t border-zinc-800/90 bg-zinc-900/60 rounded-xl p-2">
            <div className="flex items-center justify-between mb-1.5 px-1">
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] font-mono font-bold text-amber-400 uppercase flex items-center gap-1">
                  <Compass className="w-3.5 h-3.5 text-amber-400" /> INDIKATOR TF & CONFLUENCE MULTI-TF:
                </span>
                <span className="text-[9.5px] font-mono text-zinc-400 hidden sm:inline">
                  (Klik pada salah satu TF di bawah untuk langsung ganti chart & cek manual)
                </span>
              </div>
              <span className="text-[9.5px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                15m = BOT ANCHOR • 1s = ML FEED
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-1.5">
              {mtfIndicatorMatrix.map((item) => {
                const isCurrent = timeframe === item.tf;
                const isBull = item.bias === "BULLISH";
                const isBear = item.bias === "BEARISH";

                return (
                  <button
                    key={item.tf}
                    onClick={() => onSelectTimeframe?.(item.tf)}
                    className={`flex flex-col p-1.5 rounded-lg border text-left transition-all ${
                      isCurrent
                        ? "bg-amber-500/15 border-amber-500/70 ring-1 ring-amber-500/50 shadow-sm shadow-amber-500/10"
                        : "bg-zinc-950/80 border-zinc-800/80 hover:border-zinc-700 hover:bg-zinc-900"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-0.5">
                      <span className={`text-[10px] font-mono font-extrabold ${isCurrent ? "text-amber-300" : "text-zinc-200"}`}>
                        {item.tf}
                      </span>
                      {item.isAnchor ? (
                        <span className="text-[8px] font-mono px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-bold">
                          AI
                        </span>
                      ) : (
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            isBull ? "bg-emerald-400 shadow-sm shadow-emerald-500/50" : isBear ? "bg-rose-400 shadow-sm shadow-rose-500/50" : "bg-zinc-400"
                          }`}
                        />
                      )}
                    </div>
                    <div
                      className={`text-[9.5px] font-mono font-bold leading-tight truncate ${
                        isBull ? "text-emerald-400" : isBear ? "text-rose-400" : "text-zinc-300"
                      }`}
                    >
                      {item.bias}
                    </div>
                    <div className="text-[8.5px] font-mono text-zinc-500 truncate mt-0.5">
                      {item.signal}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Bottom Bar: Liquidity Status bar */}
          <div className="flex flex-wrap items-center justify-between border-t border-zinc-800/80 pt-2 px-1 text-[11px] font-mono text-zinc-400 gap-2 mt-2">
            <div className="flex items-center gap-3">
              <span>Strategy: <strong className="text-amber-300 font-bold">MTF Liquidity Sweep</strong></span>
              <span>Confluence: <strong className="text-emerald-400">{mtfLiquidity.confluenceScore}%</strong></span>
              <span>MACD Hist: <strong className={technicals.macd.histogram >= 0 ? "text-emerald-400" : "text-rose-400"}>{technicals.macd.histogram}</strong></span>
            </div>
            <div className="text-zinc-400">
              Price: <strong className="text-zinc-100">${currentPrice.toFixed(2)}</strong> | Route TF: <strong className="text-amber-300">{timeframe}</strong> | Anchor: <strong className="text-emerald-400">15m (AI Agent)</strong>
            </div>
          </div>
        </div>

        {/* Order Book Depth Ladder (1 col) */}
        <div className="flex flex-col rounded-xl bg-zinc-950 p-3 border border-zinc-800/80 font-mono text-xs">
          <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2 mb-2">
            <span className="text-zinc-400 font-bold flex items-center gap-1">
              <Layers className="h-3 w-3 text-amber-400" /> ORDER BOOK (L2)
            </span>
            <span className="text-[10px] text-zinc-400">SPREAD: ${orderBook.spread}</span>
          </div>

          {/* Asks (Sells) - top */}
          <div className="flex flex-col gap-1 mb-1.5">
            {orderBook.asks.slice(-4).reverse().map((ask, i) => (
              <div key={i} className="relative flex justify-between px-1 py-0.5 text-[11px]">
                <div
                  className="absolute right-0 top-0 bottom-0 bg-rose-500/10 rounded-r"
                  style={{ width: `${Math.min(100, (ask.total / 15) * 100)}%` }}
                />
                <span className="text-rose-400 font-semibold relative z-10">${ask.price.toFixed(2)}</span>
                <span className="text-zinc-400 relative z-10">{ask.size.toFixed(2)}</span>
              </div>
            ))}
          </div>

          {/* Mid Market Price */}
          <div className="py-1.5 my-0.5 border-y border-zinc-800/80 bg-zinc-900/60 rounded px-2 flex justify-between items-center text-xs font-bold">
            <span className="text-zinc-400 text-[10px] uppercase">MID PRICE</span>
            <span className="text-zinc-100">${currentPrice.toFixed(2)}</span>
          </div>

          {/* Bids (Buys) - bottom */}
          <div className="flex flex-col gap-1 mt-1.5">
            {orderBook.bids.slice(0, 4).map((bid, i) => (
              <div key={i} className="relative flex justify-between px-1 py-0.5 text-[11px]">
                <div
                  className="absolute left-0 top-0 bottom-0 bg-emerald-500/10 rounded-l"
                  style={{ width: `${Math.min(100, (bid.total / 15) * 100)}%` }}
                />
                <span className="text-emerald-400 font-semibold relative z-10">${bid.price.toFixed(2)}</span>
                <span className="text-zinc-400 relative z-10">{bid.size.toFixed(2)}</span>
              </div>
            ))}
          </div>

          {/* Depth Imbalance Meter */}
          <div className="mt-auto pt-3 border-t border-zinc-800/80">
            <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
              <span>Bids Ratio</span>
              <span>Asks Ratio</span>
            </div>
            <div className="h-1.5 w-full bg-rose-500/30 rounded-full overflow-hidden flex">
              <div
                className="bg-emerald-500 h-full transition-all duration-300"
                style={{
                  width: `${Math.max(10, Math.min(90, (technicals.orderBookImbalance / (technicals.orderBookImbalance + 1)) * 100))}%`,
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
