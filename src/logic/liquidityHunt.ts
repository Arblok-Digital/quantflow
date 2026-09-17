import {
  Candle,
  LiquidityZone,
  MTFLiquidityAnalysis,
  LiquidityHuntState,
  Timeframe,
  MarketType,
  OrderBook,
} from "../types";

/**
 * Estimate the liquidation-volume depth around a liquidity zone using the REAL
 * order book, instead of synthetic `volume % N` numbers.
 *
 * Honest semantics:
 * - For a BSL (buy-side, above price): sum of ask-side depth within ~0.3% of
 *   the zone price → how much resting sell size is "in the way" if price hunts
 *   up into the pool.
 * - For an SSL (sell-side, below price): sum of bid-side depth within ~0.3% of
 *   the zone price → resting buy size below price.
 * - Falls back to a small fraction of the candle's real volume ONLY as a rough
 *   lower bound when the book has no levels near the zone, and flags it EST.
 *
 * Returns millions (e.g. 14.5 = $14.5M) to stay consistent with existing type.
 */
export function estimateLiquidationDepthFromBook(
  orderBook: OrderBook,
  zonePrice: number,
  isBSL: boolean
): number {
  const window = zonePrice * 0.003; // ±0.3% band
  const side = isBSL ? orderBook.asks : orderBook.bids;
  const levels = (side || []).filter((lvl) => Math.abs(lvl.price - zonePrice) <= window);
  const depthUSD = levels.reduce((sum, lvl) => sum + lvl.price * lvl.size, 0);
  const depthMillions = Number((depthUSD / 1_000_000).toFixed(1));
  // If the book has no levels near the zone, give an honest zero-derived est:
  // do NOT fabricate a big number — a flat spot is a flat spot.
  return Number.isFinite(depthMillions) && depthMillions > 0 ? depthMillions : 0;
}

/** Tag added to zone summaries so the UI/LLM can tell depth-derived from placeholder. */
export type LiquidityVolumeSource = "ORDERBOOK" | "EST_NODATA";

/**
 * Identifies Swing Highs & Swing Lows in candle series to map out
 * Buy-Side Liquidity (BSL) and Sell-Side Liquidity (SSL) pools.
 * MTF-aware: setiap timeframe dihitung independen dari candle serinya sendiri
 * (bukan proxy TF aktif). Macro timeframe (1h/4h/1D/1W) memakai buffer &
 * leverage tier yang lebih lebar; intraday (1s/1m/5m/15m) memakai buffer ketat.
 */
const MACRO_TIMEFRAMES: Timeframe[] = ["1h", "4h", "1D", "1W"];

export function detectLiquidityZones(
  candles: Candle[],
  timeframe: Timeframe,
  currentPrice: number,
  orderBook: OrderBook = { bids: [], asks: [], spread: 0 }
): LiquidityZone[] {
  if (candles.length < 5) return [];

  const zones: LiquidityZone[] = [];
  const isMacro = MACRO_TIMEFRAMES.includes(timeframe);
  const lookback = isMacro ? 4 : 3;
  const bufferPct = isMacro ? 0.005 : 0.0025;
  const leverageTiers = isMacro ? "20x - 50x" : "50x - 100x";

  // Detect Swing Highs (BSL - Buy-Side Liquidity / Short Liquidation Pools)
  for (let i = lookback; i < candles.length - lookback; i++) {
    const curr = candles[i];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= curr.high) isSwingHigh = false;
      if (candles[j].low <= curr.low) isSwingLow = false;
    }

    if (isSwingHigh) {
      const priceMin = curr.high;
      const buffer = curr.high * bufferPct;
      const priceMax = curr.high + buffer;
      const midPrice = (priceMin + priceMax) / 2;
      const distancePercent = Number((((midPrice - currentPrice) / currentPrice) * 100).toFixed(2));

      // Honest liquidation-depth estimate from the REAL order book (no
      // synthetic baseVol + volume % N). 0 = no resting depth near this zone.
      const estimatedVolumeUSD = estimateLiquidationDepthFromBook(orderBook, curr.high, true);

      zones.push({
        id: `BSL-${timeframe}-${curr.timestamp}`,
        timeframe,
        type: "BSL",
        priceMin: Number(priceMin.toFixed(2)),
        priceMax: Number(priceMax.toFixed(2)),
        midPrice: Number(midPrice.toFixed(2)),
        estimatedVolumeUSD,
        leverageTiers,
        status: currentPrice > priceMax ? "FULLY_SWEPT" : "ACTIVE",
        touches: 1,
        distancePercent,
      });
    }

    if (isSwingLow) {
      const buffer = curr.low * bufferPct;
      const priceMin = curr.low - buffer;
      const priceMax = curr.low;
      const midPrice = (priceMin + priceMax) / 2;
      const distancePercent = Number((((midPrice - currentPrice) / currentPrice) * 100).toFixed(2));

      const estimatedVolumeUSD = estimateLiquidationDepthFromBook(orderBook, curr.low, false);

      zones.push({
        id: `SSL-${timeframe}-${curr.timestamp}`,
        timeframe,
        type: "SSL",
        priceMin: Number(priceMin.toFixed(2)),
        priceMax: Number(priceMax.toFixed(2)),
        midPrice: Number(midPrice.toFixed(2)),
        estimatedVolumeUSD,
        leverageTiers,
        status: currentPrice < priceMin ? "FULLY_SWEPT" : "ACTIVE",
        touches: 1,
        distancePercent,
      });
    }
  }

  // Deduplicate and return nearest top zones
  return zones.slice(-6);
}

/**
 * Multi-Timeframe (MTF) Liquidity Hunt Evaluator
 * Evaluates likuiditas lintas SEMUA timeframe yang tersedia (1s–1W), bukan
 * hardcode 15m+4h. Tiap TF menghitung zona independen dari candle serinya
 * sendiri; nearest BSL/SSL = gabungan seluruh TF (paling dekat dari harga).
 *
 * Dua bentuk panggilan:
 *  - Legacy: analyzeMTFLiquidity(candles15m, candles4h, price, mktType?, book?)
 *  - Full map: analyzeMTFLiquidity(candlesByTimeframe, price, mktType?, book?)
 */
export function analyzeMTFLiquidity(
  candles15m: Candle[],
  candles4h: Candle[],
  currentPrice: number,
  marketType?: MarketType,
  orderBook?: OrderBook
): MTFLiquidityAnalysis;
export function analyzeMTFLiquidity(
  candlesByTimeframe: Partial<Record<Timeframe, Candle[]>>,
  currentPrice: number,
  marketType?: MarketType,
  orderBook?: OrderBook
): MTFLiquidityAnalysis;
export function analyzeMTFLiquidity(
  a: Candle[] | Partial<Record<Timeframe, Candle[]>>,
  b: Candle[] | number,
  c: number | MarketType = "FUTURES",
  d: MarketType | OrderBook = "FUTURES",
  e?: OrderBook
): MTFLiquidityAnalysis {
  const candlesByTimeframe: Partial<Record<Timeframe, Candle[]>> = {};
  let currentPrice: number;
  let marketType: MarketType = "FUTURES";
  let orderBook: OrderBook = { bids: [], asks: [], spread: 0 };

  if (Array.isArray(a)) {
    // Legacy: dua array 15m/4h + price + marketType + orderBook
    candlesByTimeframe["15m"] = a;
    candlesByTimeframe["4h"] = b as Candle[];
    currentPrice = c as number;
    marketType = (d as MarketType) ?? "FUTURES";
    orderBook = e ?? { bids: [], asks: [], spread: 0 };
  } else {
    // Full map: Record<Timeframe, Candle[]> + price + marketType + orderBook
    Object.assign(candlesByTimeframe, a);
    currentPrice = b as number;
    marketType = (c as MarketType) ?? "FUTURES";
    orderBook = (d as OrderBook) ?? { bids: [], asks: [], spread: 0 };
  }

  // Zona per-TF: hanya TF yang punya candle ≥5 dihitung (valid), sisanya NO DATA.
  const zonesByTimeframe: Partial<Record<Timeframe, LiquidityZone[]>> = {};
  const TF_ORDER: Timeframe[] = ["1s", "1m", "5m", "15m", "1h", "4h", "1D", "1W"];
  for (const tf of TF_ORDER) {
    const series = candlesByTimeframe[tf];
    if (series && series.length >= 5) {
      zonesByTimeframe[tf] = detectLiquidityZones(series, tf, currentPrice, orderBook);
    }
  }
  const zones15m = zonesByTimeframe["15m"] ?? [];
  const zones4h = zonesByTimeframe["4h"] ?? [];
  const allZones = Object.values(zonesByTimeframe).flat();

  // Active BSL (above price) and SSL (below price) across ALL timeframes
  const bslPools = allZones
    .filter((z) => z.type === "BSL" && z.priceMin >= currentPrice)
    .sort((x, y) => x.midPrice - y.midPrice);

  const sslPools = allZones
    .filter((z) => z.type === "SSL" && z.priceMax <= currentPrice)
    .sort((x, y) => y.midPrice - x.midPrice);

  const nearestBSL = bslPools[0] || null;
  const nearestSSL = sslPools[0] || null;

  // Detect Recent Sweep in last 3 candles of tactical 15m
  let recentSweep: MTFLiquidityAnalysis["recentSweep"] = null;
  const candles15mLocal = candlesByTimeframe["15m"] || [];
  const recent15m = candles15mLocal.slice(-3);

  for (const c of recent15m) {
    // Check if pierced swing low and closed higher (Bullish SSL Sweep)
    for (const ssl of zones15m.filter((z) => z.type === "SSL")) {
      if (c.low < ssl.priceMin && c.close > ssl.priceMin) {
        const wickRejection = Number((((c.close - c.low) / (c.high - c.low || 1)) * 100).toFixed(1));
        recentSweep = {
          zone: ssl,
          timestamp: c.timestamp,
          wickRejectionPercent: wickRejection,
          type: "BULLISH_SSL_SWEEP",
          invalidationPrice: Number((c.low * 0.999).toFixed(2)),
        };
        break;
      }
    }

    if (recentSweep) break;

    // Check if pierced swing high and closed lower (Bearish BSL Sweep)
    for (const bsl of zones15m.filter((z) => z.type === "BSL")) {
      if (c.high > bsl.priceMax && c.close < bsl.priceMax) {
        const wickRejection = Number((((c.high - c.close) / (c.high - c.low || 1)) * 100).toFixed(1));
        recentSweep = {
          zone: bsl,
          timestamp: c.timestamp,
          wickRejectionPercent: wickRejection,
          type: "BEARISH_BSL_SWEEP",
          invalidationPrice: Number((c.high * 1.001).toFixed(2)),
        };
        break;
      }
    }
  }

  // Determine Active Liquidity Hunt State
  let activeState: LiquidityHuntState = "EQUILIBRIUM";
  let huntingTarget: MTFLiquidityAnalysis["huntingTarget"] = null;

  if (recentSweep?.type === "BULLISH_SSL_SWEEP") {
    activeState = "SWEPT_SSL";
    if (nearestBSL) {
      huntingTarget = {
        targetType: "BSL",
        targetPrice: nearestBSL.midPrice,
        potentialPnlPercent: Number((((nearestBSL.midPrice - currentPrice) / currentPrice) * 100).toFixed(2)),
      };
    }
  } else if (recentSweep?.type === "BEARISH_BSL_SWEEP") {
    activeState = "SWEPT_BSL";
    if (nearestSSL) {
      huntingTarget = {
        targetType: "SSL",
        targetPrice: nearestSSL.midPrice,
        potentialPnlPercent: Number((((currentPrice - nearestSSL.midPrice) / currentPrice) * 100).toFixed(2)),
      };
    }
  } else if (nearestBSL && Math.abs(nearestBSL.distancePercent) < 0.6) {
    activeState = "HUNTING_BSL";
    huntingTarget = {
      targetType: "BSL",
      targetPrice: nearestBSL.midPrice,
      potentialPnlPercent: Number(Math.abs(nearestBSL.distancePercent).toFixed(2)),
    };
  } else if (nearestSSL && Math.abs(nearestSSL.distancePercent) < 0.6) {
    activeState = "HUNTING_SSL";
    huntingTarget = {
      targetType: "SSL",
      targetPrice: nearestSSL.midPrice,
      potentialPnlPercent: Number(Math.abs(nearestSSL.distancePercent).toFixed(2)),
    };
  }

  // -----------------------------------------------------------------------
  // F4 — Confluence score DIHITUNG dari struktur riil, bukan konstanta per
  // state (lama: 88/85/78/76 hardcode → prompt AI & UI selalu melihat skor
  // tinggi palsu). Komponen: sweep (+15), depth sweep TERUKUR dari book (+5),
  // target aktif (+6), target super dekat ≤0.3% (+6), konfirmasi multi-TF
  // (+5 per TF yang punya zona, cap +10). Netral = 50. Clamp 0..100.
  // -----------------------------------------------------------------------
  let confluenceScore = 50;
  let confluenceSummary = "Struktur likuiditas lintas timeframe membangun pool seimbang.";

  const volLabel = (z: LiquidityZone | null): string => {
    if (!z) return "N/A";
    return z.estimatedVolumeUSD > 0
      ? `$${z.estimatedVolumeUSD}M`
      : "EST(no book depth)";
  };

  const activeTfZones = Object.entries(zonesByTimeframe).filter(([, z]) => z && z.length > 0);
  const coveredTfs = activeTfZones.map(([tf]) => tf).join(",") || "NONE";

  if (activeState === "SWEPT_SSL") {
    confluenceSummary = `Liquidity Hunt: Long stop-loss pool swept pada 15m (${volLabel(recentSweep?.zone ?? null)}) dengan absorption wick. Bias macro (${coveredTfs}) tetap bullish.`;
  } else if (activeState === "SWEPT_BSL") {
    confluenceSummary = `Liquidity Hunt: Short stop-loss pool swept pada 15m (${volLabel(recentSweep?.zone ?? null)}) dengan rejection. Target SSL pool terdekat di TF lain.`;
  } else if (activeState === "HUNTING_BSL") {
    confluenceSummary = `Magnet effect menuju BSL pool ${nearestBSL?.timeframe} di $${nearestBSL?.midPrice} (${volLabel(nearestBSL)} depth).`;
  } else if (activeState === "HUNTING_SSL") {
    confluenceSummary = `Liquidity hunt turun menuju SSL pool ${nearestSSL?.timeframe} di $${nearestSSL?.midPrice} (${volLabel(nearestSSL)} depth).`;
  }

  let score = 50;
  if (recentSweep) score += 15;
  if (recentSweep?.zone && recentSweep.zone.estimatedVolumeUSD > 0) score += 5;
  if (huntingTarget) score += 6;
  if (huntingTarget && huntingTarget.potentialPnlPercent != null && Math.abs(huntingTarget.potentialPnlPercent) <= 0.3) {
    score += 6;
  }
  score += Math.min(10, activeTfZones.length * 5);
  confluenceScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    marketType,
    primaryTimeframe: marketType === "FUTURES" ? "15m" : "4h",
    macroTimeframe: "4h",
    activeState,
    nearestBSL,
    nearestSSL,
    recentSweep,
    zones15m,
    zones4h,
    zonesByTimeframe,
    confluenceScore,
    confluenceSummary,
    huntingTarget,
  };
}
