import { generateSignal, SignalBuildInput, SignalGenerationResult } from "./keel/mm-brain/signal-generator";
import { evaluateRisk, RiskCandidate, RiskSnapshot } from "./keel/risk/gatekeeper";
import { IntradayHighWaterMark } from "./keel/risk/drawdown-monitor";
import { store, openPositions, ordersLastHour, lastKillSwitchEvent } from "./keel/store";
import { NormalizedDepth, NormalizedTrade, MtfVector, DepthLevel } from "./keel/types";
import { MTFEngine, type MTFTrendResult } from "./keel/mm-brain/mtf-engine";
import type { Kline } from "./keel/ingestion/kline-aggregator";
import type { RecentTrade, FuturesMetrics } from "../data/marketFetcher";
import { LLMDecision, Candle, TechnicalIndicators, MTFLiquidityAnalysis, OrderBook } from "../types";

export interface KeelAdapterInput {
  symbol: string;
  currentPrice: number;
  candles15m?: Candle[];
  candles4h?: Candle[];
  technicals?: TechnicalIndicators;
  mtfLiquidity?: MTFLiquidityAnalysis;
  orderBook?: OrderBook;
  recentTrades?: RecentTrade[];
  futures?: FuturesMetrics;
  portfolioEquity?: number;
}

export interface FuturesAnalysis {
  fundingRate?: number;
  fundingBps?: number;
  markPrice?: number;
  openInterest?: number;
  openInterestUsd?: number;
  lsrTaker?: number;
  lsrAccount?: number;
  longLiqUsd?: number;
  shortLiqUsd?: number;
  longLiqSize?: number;
  shortLiqSize?: number;
  topLongSize?: number;
  topShortSize?: number;
  topLsrSize?: number;
  volume24hUsd?: number;
  bias?: "BULLISH" | "BEARISH" | "NEUTRAL";
  biasReason?: string;
  source?: string;
}

function buildFuturesAnalysis(fm: FuturesMetrics): FuturesAnalysis | undefined {
  if (!fm || fm.success !== true) return undefined;

  let total = 0;
  const reasons: string[] = [];

  if (fm.fundingRate != null) {
    if (fm.fundingRate < 0) { total += 1; reasons.push("funding<0 (long murah)"); }
    else if (fm.fundingRate > 0.0005) { total -= 1; reasons.push("funding>0.05% (long crowded)"); }
  }
  if (fm.lsrTaker != null) {
    if (fm.lsrTaker < 0.9) { total += 1; reasons.push("LSR<0.9 (banyak short)"); }
    else if (fm.lsrTaker > 1.1) { total -= 1; reasons.push("LSR>1.1 (banyak long)"); }
  }
  if (fm.longLiqUsd != null && fm.shortLiqUsd != null) {
    if (fm.shortLiqUsd > 0 && fm.longLiqUsd > 3 * fm.shortLiqUsd) { total += 1; reasons.push("liq LONG magnet atas"); }
    else if (fm.longLiqUsd > 0 && fm.shortLiqUsd > 3 * fm.longLiqUsd) { total -= 1; reasons.push("liq SHORT magnet bawah"); }
  }

  const bias: "BULLISH" | "BEARISH" | "NEUTRAL" =
    total >= 1 ? "BULLISH" : total <= -1 ? "BEARISH" : "NEUTRAL";
  const biasReason = reasons.length > 0 ? reasons.join("; ") : "tidak ada komponen ekstrem";

  return {
    fundingRate: fm.fundingRate,
    fundingBps: fm.fundingBps,
    markPrice: fm.markPrice,
    openInterest: fm.openInterest,
    openInterestUsd: fm.openInterestUsd,
    lsrTaker: fm.lsrTaker,
    lsrAccount: fm.lsrAccount,
    longLiqUsd: fm.longLiqUsd,
    shortLiqUsd: fm.shortLiqUsd,
    longLiqSize: fm.longLiqSize,
    shortLiqSize: fm.shortLiqSize,
    topLongSize: fm.topLongSize,
    topShortSize: fm.topShortSize,
    topLsrSize: fm.topLsrSize,
    volume24hUsd: fm.volume24hUsd,
    bias,
    biasReason,
    source: fm.source,
  };
}

/**
 * Keel Engine Adapter — bridges Keel's institutional quantitative algorithms
 * (Smart Money Tracker, Absorption Engine, Wall Dynamics, Confluence Matrix)
 * into the main trading pipeline decision & risk gates.
 */
// ---------------------------------------------------------------------------
// F4 — Real 4-TF trend (MTFEngine.computeAll) dari candle OHLCV riil.
// Sebelumnya mtfBias dibangun dari 2 sumber diduplikasi (likuiditas → m15/h1,
// teknikal flat → h4/d1) lalu kena penalti 25% karena "duplikasi". Dengan
// candle nyata per TF (m15 asli, h1 = agregat 4×15m, 4h asli, d1 = agregat
// 6×4h), bias 4 TF jadi independen — penalti duplikasi tidak diterapkan.
// TF tanpa data cukup = NEUTRAL (tidak beropini) — jujur, bukan fabrikasi.
// ---------------------------------------------------------------------------

function candlesToKlines(candles: Candle[], tfMs: number): Kline[] {
  const out: Kline[] = [];
  for (const k of candles) {
    if (!k || !Number.isFinite(k.open) || !Number.isFinite(k.high) || !Number.isFinite(k.low) || !Number.isFinite(k.close)) continue;
    if (k.high <= 0 || k.low <= 0 || k.close <= 0) continue;
    const ts = Number(k.timestamp) || 0;
    out.push({
      openTime: ts,
      closeTime: ts + tfMs - 1,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: Number(k.volume) || 0,
      trades: 0,
    });
  }
  return out;
}

/** Gabungkan `factor` bar berurutan jadi 1 bar TF lebih tinggi (sisa bar tak penuh dibuang). */
function aggregateKlines(kl: Kline[], factor: number): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i + factor <= kl.length; i += factor) {
    const g = kl.slice(i, i + factor);
    out.push({
      openTime: g[0]!.openTime,
      closeTime: g[g.length - 1]!.closeTime,
      open: g[0]!.open,
      high: Math.max(...g.map((k) => k.high)),
      low: Math.min(...g.map((k) => k.low)),
      close: g[g.length - 1]!.close,
      volume: g.reduce((s, k) => s + k.volume, 0),
      trades: g.reduce((s, k) => s + k.trades, 0),
    });
  }
  return out;
}

/** TF dianggap "ter-cover" bila punya cukup bar untuk struktur/EMA (≥21). */
const MTF_MIN_BARS = 21;

export interface RealMtfResult {
  bias: MtfVector;
  /** TF yang benar-benar punya data cukup (≥21 bar). TF lain = NEUTRAL (no opinion). */
  coveredTfs: string[];
  raw: MTFTrendResult;
}

export function computeRealMtfBias(candles15m?: Candle[], candles4h?: Candle[]): RealMtfResult | null {
  if ((!candles15m || candles15m.length === 0) && (!candles4h || candles4h.length === 0)) return null;
  const m15 = candles15m ? candlesToKlines(candles15m, 15 * 60_000) : [];
  const h4 = candles4h ? candlesToKlines(candles4h, 4 * 3_600_000) : [];
  const h1 = aggregateKlines(m15, 4);
  const d1 = aggregateKlines(h4, 6);
  const klines = { m15, h1, h4, d1 };
  const coveredTfs = (["m15", "h1", "h4", "d1"] as const).filter((tf) => klines[tf].length >= MTF_MIN_BARS);
  if (coveredTfs.length === 0) return null;
  const raw = new MTFEngine().computeAll("keel-mtf", klines);
  const bias: MtfVector = { m15: raw.m15, h1: raw.h1, h4: raw.h4, d1: raw.d1 };
  return { bias, coveredTfs, raw };
}

export function runKeelQuantEngine(input: KeelAdapterInput): {
  decision: LLMDecision;
  rawSignalResult: SignalGenerationResult;
} {
  const symbol = input.symbol || "BTC/USDT";
  const entryPrice = input.currentPrice;
  const futuresAnalysis = buildFuturesAnalysis(input.futures as FuturesMetrics | undefined);

  const bids: DepthLevel[] = (input.orderBook?.bids || []).map((b) => ({ price: b.price, qty: b.size }));
  const asks: DepthLevel[] = (input.orderBook?.asks || []).map((a) => ({ price: a.price, qty: a.size }));
  const hasRealDepth = bids.length > 0 && asks.length > 0;
  const depth: NormalizedDepth | null = hasRealDepth
    ? { symbol, venue: "BINANCE_SPOT", bids, asks, tsServerMs: Date.now() }
    : null;

  let biasVal: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (input.mtfLiquidity) {
    const s = String(input.mtfLiquidity.activeState);
    if (s === "SWEPT_SSL" || s === "HUNTING_BSL" || s === "BSL") {
      biasVal = "BULLISH";
    } else if (s === "SWEPT_BSL" || s === "HUNTING_SSL" || s === "SSL") {
      biasVal = "BEARISH";
    }
  }

  // LIMITATION: `TechnicalIndicators` (src/types.ts) TIDAK punya field per-timeframe
  // (hanya satu set datar: rsi/ema20/ema50/macd/orderBookImbalance). Karena itu kita
  // TIDAK bisa membaca bias independent per-TF dari technicals. Strategi yang dipakai
  // agar confluence-matrix tidak "bias total 100%" secara artifisial:
  //   - m15 & h1  → bias konteks likuiditas (mtfLiquidity.activeState) — frame yang
  //                 sedang "hunting/sweep" (konteks 15m futures / 4h spot).
  //   - h4  & d1  → bias teknis dari satu set technicals datar (RSI/EMA/MACD/orderbook)
  //                 sebagai proxy arah trend makro. Bukan fabricate per-TF: ini derivasi
  //                 jujur dari indikator riil, hanya tidak bisa dibedakan per-frame.
  //
  // Jadi m15/h1 vs h4/d1 memang punya basis data berbeda → skor confluence tidak lagi
  // selalu 100% (bug), tanpa mengarang angka yang tak ada di input.

  // Bias teknis makro untuk frame tinggi (h4/d1) — RSI/EMA cross/trend/MACD/orderbook.
  let techBias: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (input.technicals) {
    const t = input.technicals;
    let score = 0;
    if (t.rsi < 30) score += 1;
    else if (t.rsi > 70) score -= 1;
    else if (t.rsi < 45) score += 1;
    else if (t.rsi > 55) score -= 1;
    if (t.ema20 != null && t.ema50 != null) {
      if (t.ema20 > t.ema50) score += 1;
      else if (t.ema20 < t.ema50) score -= 1;
    }
    if (t.macd && t.macd.histogram > 0) score += 1;
    else if (t.macd && t.macd.histogram < 0) score -= 1;
    if (t.orderBookImbalance > 1) score += 1;
    else if (t.orderBookImbalance < 1) score -= 1;
    if (score >= 2) techBias = "BULLISH";
    else if (score <= -2) techBias = "BEARISH";
  }

  const legacyMtf: MtfVector = {
    m15: biasVal,
    h1: biasVal,
    h4: techBias,
    d1: techBias,
  };

  // F-02/P1: penalti duplikasi MTF — mtfBias di atas memang dibangun dari
  // 2 sumber independen (likuiditas untuk m15/h1, teknikal flat untuk h4/d1),
  // BUKAN 4 timeframe independen. Confluence matrix berbobot (weights d1 .4,
  // h4 .3, h1 .2, m15 .1) akan menghitung skor dari pasangan duplikat;
  // published score dipangkas 25% saat duplikasi terdeteksi agar tidak
  // overstate keyakinan "konfirmasi 4 TF". Flag di reasoning untuk audit.
  // (Refactor proper TechnicalIndicators per-TF tetap roadmap, bukan v1.)
  const legacyDuplicated = legacyMtf.m15 === legacyMtf.h1 || legacyMtf.h4 === legacyMtf.d1;

  // F4 — bias REAL 4-TF dari candle OHLCV bila tersedia (m15/h1/h4/d1
  // independen via MTFEngine). Fallback legacy 2-sumber tetap berlaku bila
  // candle tidak dikirim — penalti duplikasi hanya berlaku di jalur legacy.
  const realMtf = computeRealMtfBias(input.candles15m, input.candles4h);
  const mtfBias: MtfVector = realMtf ? realMtf.bias : legacyMtf;
  const mtfDuplicated = realMtf ? false : legacyDuplicated;

  if (!hasRealDepth) {
    const holdDecision: LLMDecision = {
      action: "HOLD",
      confidence: 50,
      targetPrice: entryPrice,
      stopLoss: Number((entryPrice * 0.985).toFixed(2)),
      takeProfit: Number((entryPrice * 1.03).toFixed(2)),
      positionSizePercent: 0,
      reasoning: "[Keel Engine] HOLD — no real depth: orderBook kosong, skip fail-closed (tidak fabricate depth).",
      source: "keel-institutional-quant",
      inferenceLatencyMs: 1,
      liquidityHuntAnalysis: {
        targetPool: "BSL",
        targetZonePrice: Number((entryPrice * 1.03).toFixed(2)),
        sweepTriggered: false,
        mtfBias: biasVal === "BULLISH" ? "BULLISH_REVERSAL" : biasVal === "BEARISH" ? "BEARISH_REVERSAL" : "NEUTRAL",
        confluenceScore: 0,
        invalidationLevel: Number((entryPrice * 0.985).toFixed(2)),
      },
      futuresAnalysis: futuresAnalysis || undefined,
    };
    const emptyResult = generateSignal({
      symbol,
      venue: "BINANCE_SPOT",
      depth: null,
      recentTrades: [],
      mtfBias,
      narrativeVelocity: 0,
      entryPrice,
      detectedAtServerMs: Date.now(),
      strategy: "SWING",
    });
    return { decision: holdDecision, rawSignalResult: emptyResult };
  }

  // Real order-flow stream (aggTrades) diwire dari input.recentTrades.
  // Fail-closed jujur: kalau trades kosong/undefined → [] → flow NEUTRAL → HOLD.
  // TIDAK pernah fabricate/synthetic trade prints.
  const recentTrades: NormalizedTrade[] = (input.recentTrades && input.recentTrades.length > 0)
    ? input.recentTrades.map((t) => ({
        symbol,
        venue: "BINANCE_SPOT",
        price: t.price,
        qty: t.qty,
        notionalUsd: t.notionalUsd,
        isBuyerMaker: t.isBuyerMaker,
        tsServerMs: t.timestamp || Date.now(),
      }))
    : [];

  const buildInput: SignalBuildInput = {
    symbol,
    venue: "BINANCE_SPOT",
    depth: depth as NormalizedDepth,
    recentTrades,
    mtfBias,
    narrativeVelocity: 0,
    entryPrice,
    detectedAtServerMs: Date.now(),
    strategy: "SWING",
  };

  const signalResult = generateSignal(buildInput);

  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  let targetPrice = entryPrice;
  let stopLoss = Number((entryPrice * 0.985).toFixed(2));
  let takeProfit = Number((entryPrice * 1.03).toFixed(2));
  let confidence = Math.min(95, Math.max(50, Math.round(signalResult.compositeScore * 100)));
  if (mtfDuplicated) {
    // Terapkan penalti 25% SEKARANG (pre-signal fallback) agar jalur HOLD
    // fail-closed (no real depth) konsisten dengan jalur sinyal di bawah.
    confidence = Math.max(0, Math.round(confidence * 0.75));
  }

  if (signalResult.signal) {
    action = signalResult.signal.action;
    // F1/P0 (audit): `confluence.score` adalah FRAKSI 0..1 (lihat
    // confluence-matrix: score = Math.round(Math.abs(bullScore)*100)/100),
    // sedangkan minConfidenceThreshold (App.tsx: 60) & seluruh UI memakai
    // skala 0..100. Sebelumnya confidence = round(0..1) → 0 atau 1, sehingga
    // (a) SEMUA sinyal Keel gagal gate confidence di /api/pipeline/cycle dan
    // (b) UI menampilkan "conf 1%". Sekarang dikonversi ke skala 0..100.
    confidence = Math.max(0, Math.min(100, Math.round(signalResult.confluence.score * 100)));
    if (mtfDuplicated) {
      confidence = Math.max(0, Math.round(confidence * 0.75));
    }

    if (signalResult.levels) {
      stopLoss = signalResult.levels.stopAbs;
      takeProfit = signalResult.levels.targetAbs;
    } else {
      stopLoss = action === "BUY" ? Number((entryPrice * 0.98).toFixed(2)) : Number((entryPrice * 1.02).toFixed(2));
      takeProfit = action === "BUY" ? Number((entryPrice * 1.04).toFixed(2)) : Number((entryPrice * 0.96).toFixed(2));
    }
  }

  let reasoning = signalResult.discardedReason
    ? `[Keel Engine] Signal Filtered: ${signalResult.discardedReason} | Flow: ${signalResult.smartMoneyFlow} | Liquidity Depth: $${(signalResult.liquidityDepthUsd / 1000).toFixed(0)}k`
    : `[Keel Engine] Institutional Signal Approved | Flow: ${signalResult.smartMoneyFlow} | Wall Action: ${signalResult.wall?.action || "NONE"} | Confluence: ${signalResult.confluence.score}%`;
  if (mtfDuplicated) {
    reasoning += " | MTF-DUP-PENALTY-25pct (2 sumber independen, bukan 4 TF)";
  } else if (realMtf) {
    reasoning += ` | MTF REAL 4-TF [${realMtf.coveredTfs.join("/")}]`;
  }

  if (futuresAnalysis && futuresAnalysis.fundingBps != null) {
    const fa = futuresAnalysis;
    reasoning += ` | Futures: funding ${fa.fundingBps?.toFixed(2)}bps, OI $${((fa.openInterestUsd || 0) / 1e9).toFixed(1)}B, LSR ${fa.lsrTaker ?? "-"}, liq LONG $${((fa.longLiqUsd || 0) / 1000).toFixed(0)}k/SHORT $${((fa.shortLiqUsd || 0) / 1000).toFixed(0)}k → bias ${fa.bias}`;
  }

  const decision: LLMDecision = {
    action,
    confidence,
    targetPrice,
    stopLoss,
    takeProfit,
    // F2 (sizing satu satuan): pakai sizePct hasil engine (risk-targeted,
    // % equity sebagai notional) — sebelumnya hardcode 5 sehingga output
    // sizing engine selalu dibuang. Fallback 5 = cap notional Keel bila
    // levels null (bracket fallback default 2%/4%).
    positionSizePercent: action === "HOLD" ? 0 : (signalResult.levels?.sizePct ?? 5),
    reasoning,
    source: "keel-institutional-quant",
    inferenceLatencyMs: 2,
    liquidityHuntAnalysis: {
      targetPool: action === "BUY" ? "BSL" : "SSL",
      targetZonePrice: takeProfit,
      sweepTriggered: Boolean(signalResult.absorption?.isPreBreakoutAccumulation),
      mtfBias: biasVal === "BULLISH" ? "BULLISH_REVERSAL" : biasVal === "BEARISH" ? "BEARISH_REVERSAL" : "NEUTRAL",
      confluenceScore: mtfDuplicated
        ? Math.max(0, Math.round(signalResult.confluence.score * 0.75))
        : signalResult.confluence.score,
      invalidationLevel: stopLoss,
    },
    futuresAnalysis: futuresAnalysis || undefined,
  };

  return { decision, rawSignalResult: signalResult };
}

let keelHwm: number | null = null;

export function _resetKeelHwmForTest(): void {
  keelHwm = null;
}

/**
 * Keel Risk Gate Evaluation — evaluates trade candidate against Keel's institutional risk limits.
 */
export function evaluateKeelRisk(candidate: RiskCandidate, currentEquityUsd: number): {
  passed: boolean;
  reasons: string[];
} {
  const limitsView = {
    maxOpenPositions: 5,
    maxOrdersPerHour: 10,
    maxDrawdownPct: 3.0,
    minPositionSizePct: 2.0,
    maxPositionSizePct: 5.0,
    stopLossPct: 2.0,
  };

  const killSwitch = lastKillSwitchEvent();
  if (keelHwm === null || !isFinite(keelHwm)) keelHwm = currentEquityUsd;
  else keelHwm = Math.max(keelHwm, currentEquityUsd);
  const hwmInst = new IntradayHighWaterMark(keelHwm);
  const drawdownPct = hwmInst.observe(currentEquityUsd).drawdownPct;
  keelHwm = hwmInst.current();

  const snapshot: RiskSnapshot = {
    openPositions: openPositions().length,
    ordersLastHour: ordersLastHour(Date.now()).length,
    dailyDrawdownPct: drawdownPct,
    killSwitchActive: killSwitch ? killSwitch.isActive : false,
  };

  return evaluateRisk(candidate, snapshot, limitsView);
}
