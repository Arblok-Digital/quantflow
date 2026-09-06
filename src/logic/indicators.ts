import { Candle, TechnicalIndicators, OrderBook, Timeframe } from "../types";

export function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  if (prices.length < period) {
    const sum = prices.reduce((a, b) => a + b, 0);
    return sum / prices.length;
  }
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return Number(ema.toFixed(2));
}

export function calculateRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(diff)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Number(rsi.toFixed(1));
}

export function calculateMACD(closes: number[]): { macdLine: number; signalLine: number; histogram: number } {
  if (closes.length < 26) {
    return { macdLine: 0, signalLine: 0, histogram: 0 };
  }
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = Number((ema12 - ema26).toFixed(2));
  const signalLine = Number((macdLine * 0.85).toFixed(2));
  const histogram = Number((macdLine - signalLine).toFixed(2));
  return { macdLine, signalLine, histogram };
}

export function calculateATR(candles: Candle[], period: number = 14): number {
  if (candles.length < 2) return 100;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  const recentTrs = trs.slice(-period);
  const sum = recentTrs.reduce((a, b) => a + b, 0);
  return Number((sum / recentTrs.length).toFixed(2));
}

export function getTimeframeIntervalMs(timeframe: Timeframe): number {
  switch (timeframe) {
    case "1s":
      return 1000;
    case "1m":
      return 60 * 1000;
    case "5m":
      return 5 * 60 * 1000;
    case "15m":
      return 15 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "4h":
      return 4 * 60 * 60 * 1000;
    case "1D":
      return 24 * 60 * 60 * 1000;
    case "1W":
      return 7 * 24 * 60 * 60 * 1000;
    default:
      return 15 * 60 * 1000;
  }
}

export function getTimeframeVolatility(timeframe: Timeframe): number {
  switch (timeframe) {
    case "1s":
      return 0.0003;
    case "1m":
      return 0.0012;
    case "5m":
      return 0.0028;
    case "15m":
      return 0.0055;
    case "1h":
      return 0.010;
    case "4h":
      return 0.018;
    case "1D":
      return 0.038;
    case "1W":
      return 0.075;
    default:
      return 0.005;
  }
}

export function generateCandlesForTimeframe(
  basePrice: number,
  timeframe: Timeframe,
  count: number = 40
): Candle[] {
  const candles: Candle[] = [];
  let currentPrice = basePrice;
  const now = Date.now();
  const intervalMs = getTimeframeIntervalMs(timeframe);
  const volatilityMultiplier = getTimeframeVolatility(timeframe);

  // Volume baseline based on timeframe
  const baseVolume = timeframe === "1s" ? 5 : timeframe === "1m" ? 25 : timeframe === "5m" ? 60 : timeframe === "15m" ? 120 : timeframe === "1h" ? 280 : timeframe === "4h" ? 650 : timeframe === "1D" ? 1800 : 5400;

  for (let i = count; i >= 0; i--) {
    const delta = (Math.random() - 0.49) * (basePrice * volatilityMultiplier);
    const open = currentPrice;
    currentPrice = Math.max(1, currentPrice + delta);
    const high = Math.max(open, currentPrice) + Math.random() * (basePrice * volatilityMultiplier * 0.45);
    const low = Math.min(open, currentPrice) - Math.random() * (basePrice * volatilityMultiplier * 0.45);
    const volume = Math.round(baseVolume + Math.random() * (baseVolume * 0.8));

    candles.push({
      timestamp: now - i * intervalMs,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(currentPrice.toFixed(2)),
      volume,
    });
  }

  return candles;
}

export const generateInitialCandles = (basePrice: number, count: number = 35): Candle[] =>
  generateCandlesForTimeframe(basePrice, "15m", count);


export function generateOrderBook(currentPrice: number): OrderBook {
  const bids = [];
  const asks = [];
  let bidTotal = 0;
  let askTotal = 0;

  for (let i = 1; i <= 6; i++) {
    const bidPrice = Number((currentPrice * (1 - i * 0.0006)).toFixed(2));
    const bidSize = Number((0.5 + Math.random() * 3.5).toFixed(2));
    bidTotal += bidSize;
    bids.push({ price: bidPrice, size: bidSize, total: Number(bidTotal.toFixed(2)) });

    const askPrice = Number((currentPrice * (1 + i * 0.0006)).toFixed(2));
    const askSize = Number((0.5 + Math.random() * 3.5).toFixed(2));
    askTotal += askSize;
    asks.push({ price: askPrice, size: askSize, total: Number(askTotal.toFixed(2)) });
  }

  const spread = Number((asks[0].price - bids[0].price).toFixed(2));
  return { bids, asks, spread };
}
