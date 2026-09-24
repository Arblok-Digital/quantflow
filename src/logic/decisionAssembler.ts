/**
 * src/logic/decisionAssembler.ts
 * assembleDecision — menerjemahkan keputusan Jev (chip System One) menjadi
 * shape LLMDecision server-side. SL/TP/target dihitung DETERMINISTIK di server
 * dari data real (bukan diminta Jev mengarang angka):
 *
 *   BUY : SL ← SSL (keel mtf) bila ada & < harga; TP ← BSL bila ada & > harga.
 *         Fallback: ATR(14) → band default harga (0.8%/1.6%).
 *   SELL: cermin (TP ← SSL, SL ← BSL).
 *   Guard harga: SL < price < TP (BUY) / TP < price < SL (SELL); gagal → coba
 *         generasi berikutnya → band default → jika masih invalid → HOLD jujur.
 *   Sizing: clamp [1, maxRiskPerTradePercent]; confidence < minConfidence
 *         → HOLD (fail-closed risk gate).
 *   HOLD : level netral (SL/TP default, target=currentPrice, size 0).
 * Semua nilai finite & deterministik (tanpa RNG, tanpa Date.now di angka).
 */

import type { LLMDecision } from "../types";

export interface JevDecision {
  action: "LONG" | "SHORT" | "BUY" | "SELL" | "HOLD";
  confidence: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
}

export interface AssembleContext {
  symbol?: string;
  currentPrice: number;
  /** Keel summary — mtfState.nearestBSL/nearestSSL adalah sumber SL/TP primer. */
  keelSummary?: {
    mtfState?: {
      nearestBSL?: { midPrice?: number | null } | null;
      nearestSSL?: { midPrice?: number | null } | null;
    } | null;
  } | null;
  /** ATR/EMA real dari teknikal server (kalau ada). */
  technicals?: {
    atr?: number | null;
    ema20?: number | null;
    ema50?: number | null;
  } | null;
  riskConfig?: {
    maxRiskPerTradePercent?: number;
    minConfidenceThreshold?: number;
  } | null;
  /** Latency (ms) diisi route setelah faktual HTTP. */
  latencyMs?: number;
}

const SL_DEFAULT_PCT = 0.015; // 1.5% dari harga — band default (mirip client 0.985)
const TP_DEFAULT_PCT = 0.03; // 3.0% dari harga (mirip client 1.03)
const ATR_SL_MULT = 1.2;
const ATR_TP_MULT = 2.4;

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function bandLevels(price: number, side: "BUY" | "SELL"): { sl: number; tp: number } {
  if (side === "BUY") {
    return { sl: price * (1 - SL_DEFAULT_PCT), tp: price * (1 + TP_DEFAULT_PCT) };
  }
  return { sl: price * (1 + SL_DEFAULT_PCT), tp: price * (1 - TP_DEFAULT_PCT) };
}

/** Generasi levels dari data real (urutan: BSL/SSL → ATR → EMA → band default). */
function deriveLevels(
  action: "BUY" | "SELL",
  price: number,
  ctx: AssembleContext
): { sl: number; tp: number; method: string } {
  const mtf = ctx.keelSummary?.mtfState ?? null;
  const bsl = fin(mtf?.nearestBSL?.midPrice) ? Number(mtf!.nearestBSL!.midPrice) : null;
  const ssl = fin(mtf?.nearestSSL?.midPrice) ? Number(mtf!.nearestSSL!.midPrice) : null;
  const atr = fin(ctx.technicals?.atr) ? Number(ctx.technicals!.atr) : null;

  if (action === "BUY") {
    const sl = ssl != null && ssl < price ? ssl : atr != null ? price - atr * ATR_SL_MULT : null;
    const tp = bsl != null && bsl > price ? bsl : atr != null ? price + atr * ATR_TP_MULT : null;
    if (sl != null && tp != null && sl < price && price < tp) {
      return { sl, tp, method: sl === ssl && tp === bsl ? "BSL/SSL" : "ATR" };
    }
    // Campuran valid (satu sumber saja yang lolos guard)
    if (sl != null && sl < price) {
      const fallbackTp = bsl != null && bsl > price ? bsl : price + Math.max(price * 0.004, (atr ?? price * 0.005) * ATR_TP_MULT);
      if (sl < price && price < fallbackTp) return { sl, tp: fallbackTp, method: "partial" };
    }
    if (tp != null && price < tp) {
      const fallbackSl = ssl != null && ssl < price ? ssl : price - Math.max(price * 0.004, (atr ?? price * 0.005) * ATR_SL_MULT);
      if (fallbackSl < price && price < tp) return { sl: fallbackSl, tp, method: "partial" };
    }
    return { ...bandLevels(price, "BUY"), method: "band-default" };
  }

  const sl = bsl != null && bsl > price ? bsl : atr != null ? price + atr * ATR_SL_MULT : null;
  const tp = ssl != null && ssl < price ? ssl : atr != null ? price - atr * ATR_TP_MULT : null;
  if (sl != null && tp != null && tp < price && price < sl) {
    return { sl, tp, method: sl === bsl && tp === ssl ? "BSL/SSL" : "ATR" };
  }
  if (sl != null && price < sl) {
    const fallbackTp = ssl != null && ssl < price ? ssl : price - Math.max(price * 0.004, (atr ?? price * 0.005) * ATR_TP_MULT);
    if (fallbackTp < price && price < sl) return { sl, tp: fallbackTp, method: "partial" };
  }
  if (tp != null && tp < price) {
    const fallbackSl = bsl != null && bsl > price ? bsl : price + Math.max(price * 0.004, (atr ?? price * 0.005) * ATR_SL_MULT);
    if (tp < price && price < fallbackSl) return { sl: fallbackSl, tp, method: "partial" };
  }
  return { ...bandLevels(price, "SELL"), method: "band-default" };
}

export function assembleDecision(jev: JevDecision, ctx: AssembleContext): LLMDecision {
  // FIX-C (audit 2026-09-21): harga invalid → HOLD jujur TANPA band karangan
  // (dulu: price=100 → level fiktif di sekitar 100). Level 0 sengaja: shape
  // check (DECISION_RESPONSE_SCHEMA server / AIDecisionResponseSchema client)
  // akan MENOLAK respons → chain lanjut ke provider berikutnya / client turun
  // ke fallback lokal dengan harga real. Fail-closed, bukan fabricate.
  if (!fin(ctx.currentPrice)) {
    return {
      action: "HOLD",
      confidence: 0,
      targetPrice: 0,
      stopLoss: 0,
      takeProfit: 0,
      positionSizePercent: 0,
      reasoning: "currentPrice invalid → HOLD jujur; level tidak bisa diturunkan dari data (tanpa fabrikasi).",
      inferenceLatencyMs: ctx.latencyMs ?? 0,
    };
  }
  const price = Number(ctx.currentPrice);
  const action = /^(BUY|LONG)$/i.test(jev.action) ? "BUY" : /^(SELL|SHORT)$/i.test(jev.action) ? "SELL" : "HOLD";
  const confidence = Math.round(Math.min(100, Math.max(1, Number(jev.confidence) || 0)));

  const minConf = fin(ctx.riskConfig?.minConfidenceThreshold)
    ? Number(ctx.riskConfig!.minConfidenceThreshold)
    : 50;
  const maxRisk = fin(ctx.riskConfig?.maxRiskPerTradePercent)
    ? Number(ctx.riskConfig!.maxRiskPerTradePercent)
    : 10;

  const riskBlocked = confidence < minConf;
  const effectiveAction: "BUY" | "SELL" | "HOLD" = riskBlocked || action === "HOLD" ? "HOLD" : action;

  if (effectiveAction === "HOLD") {
    const levels = bandLevels(price, "BUY");
    return {
      action: "HOLD",
      confidence: action === "HOLD" ? confidence : 0,
      targetPrice: price,
      stopLoss: levels.sl,
      takeProfit: levels.tp,
      positionSizePercent: 0,
      reasoning: riskBlocked
        ? `Jev confidence ${confidence} < ambang ${minConf} → HOLD (risk gate fail-closed).`
        : `Jev memutuskan HOLD (${String(jev.riskLevel).toLowerCase()} risk) — tidak ada posisi.`,
      inferenceLatencyMs: ctx.latencyMs ?? 0,
    };
  }

  const levels = deriveLevels(effectiveAction, price, ctx);
  if (!(levels.sl > 0 && levels.tp > 0)) {
    return {
      action: "HOLD",
      confidence: 0,
      targetPrice: price,
      stopLoss: bandLevels(price, "BUY").sl,
      takeProfit: bandLevels(price, "BUY").tp,
      positionSizePercent: 0,
      reasoning: "Level SL/TP tidak bisa diturunkan dari data (BSL/SSL/ATR/EMA kosong) → HOLD jujur.",
      inferenceLatencyMs: ctx.latencyMs ?? 0,
    };
  }
  const isBuy = effectiveAction === "BUY";
  const orderOk = isBuy ? levels.sl < price && price < levels.tp : levels.tp < price && price < levels.sl;

  let sl = levels.sl;
  let tp = levels.tp;
  if (!orderOk) {
    const fallback = bandLevels(price, effectiveAction);
    sl = fallback.sl;
    tp = fallback.tp;
  }

  // Sizing: clamp [1, maxRisk]; deterministik dari confidence.
  const positionSizePercent = Math.min(maxRisk, Math.max(1, Math.round(confidence / 10)));
  const targetPrice = isBuy ? tp : sl;

  return {
    action: effectiveAction,
    confidence,
    targetPrice,
    stopLoss: sl,
    takeProfit: tp,
    positionSizePercent,
    reasoning: `Jev ${effectiveAction} (conf ${confidence}, risk ${String(jev.riskLevel).toLowerCase()}) — ` +
      `levels dari ${levels.method}${orderOk ? "" : " → band-default karena guard harga"}.`,
    inferenceLatencyMs: ctx.latencyMs ?? 0,
  };
}