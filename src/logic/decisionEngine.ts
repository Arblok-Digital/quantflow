import {
  LLMDecision,
  MTFLiquidityAnalysis,
  TechnicalIndicators,
  Position,
  RiskConfig,
  Candle,
  OnChainMetrics,
  MacroSummary,
  OrderBook,
} from "../types";
import { z } from "zod";
import { authFetch } from "../hooks/useAuth";
import { runKeelQuantEngine, evaluateKeelRisk } from "./keelAdapter";
import type { RecentTrade, FuturesMetrics } from "../data/marketFetcher";

/**
 * Fail-closed price-order validation untuk setiap decision non-HOLD.
 * BUY  : stopLoss < currentPrice < takeProfit
 * SELL : takeProfit < currentPrice < stopLoss
 * Menolak silent default SL/TP dari server/LLM yang tidak konsisten
 * dengan arah (posisi zombie). Return {ok:false, message} bila invalid.
 */
export function validateDecisionPriceOrder(
  action: "BUY" | "SELL" | "HOLD",
  currentPrice: number,
  stopLoss: number,
  takeProfit: number
): { ok: boolean; message?: string } {
  if (action === "HOLD") return { ok: true };
  if (!isFinite(currentPrice) || currentPrice <= 0 || !isFinite(stopLoss) || stopLoss <= 0 || !isFinite(takeProfit) || takeProfit <= 0) {
    return { ok: false, message: "SL/TP levels must be finite positive numbers" };
  }
  const okOrder =
    action === "BUY"
      ? stopLoss < currentPrice && currentPrice < takeProfit
      : takeProfit < currentPrice && currentPrice < stopLoss;
  if (!okOrder) {
    return {
      ok: false,
      message:
        action === "BUY"
          ? "Order BUY tidak valid: harus stopLoss < harga sekarang < takeProfit."
          : "Order SELL tidak valid: harus takeProfit < harga sekarang < stopLoss.",
    };
  }
  return { ok: true };
}

/** Shape guard untuk output /api/ai-decision (LLM) — tanpa fallback diam-diam. */
const AIDecisionResponseSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  confidence: z.number().min(0).max(100),
  targetPrice: z.number().finite().positive(),
  stopLoss: z.number().finite().positive(),
  takeProfit: z.number().finite().positive(),
  positionSizePercent: z.number().min(1).max(100),
});

export interface DecisionEngineInput {
  symbol: string;
  currentPrice: number;
  candles: Candle[];
  /**
   * F4: candle kedua TF untuk MTFEngine real 4-TF — m15 & h1 (agregat ×4)
   * dari candles15m; h4 & d1 (agregat ×6) dari candles4h. Absen = fallback
   * legacy 2-sumber + penalti duplikasi.
   */
  candles15m?: Candle[];
  candles4h?: Candle[];
  technicals: TechnicalIndicators;
  mtfLiquidity: MTFLiquidityAnalysis;
  onChainMetrics?: OnChainMetrics;
  macroCalendar?: MacroSummary;
  activePositions: Position[];
  portfolioEquity: number;
  riskConfig: RiskConfig;
  /**
   * AI diaktifkan? Client melempar hasil /api/health.geminiConfigured.
   * Konteks Node tanpa flag ini mengecek process.env.GEMINI_API_KEY.
   */
  aiEnabled?: boolean;
  /** Real order book untuk estimasi depth keel yang jujur (opsional). */
  orderBook?: OrderBook;
  /** Real order-flow (aggTrades) untuk keel (opsional, empty → flow NEUTRAL → HOLD jujur). */
  recentTrades?: RecentTrade[];
  /** Futures institutional metrics untuk keel (opsional, gagal → undefined). */
  futures?: FuturesMetrics;
  /** Provenance tag per pilar (4.4) — diteruskan ke server /api/ai-decision. */
  provenance?: {
    market?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    liquidity?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    onChain?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
    macro?: { source: "REAL" | "SIMULATED" | "STALE"; fetchedAt: number; ageMinutes?: number };
  };
}

/**
 * Two-Mode Decision Router — Satu source of truth untuk keputusan.
 *
 * Routing bersih (tidak campur aduk):
 *   MODE AI  : process.env.GEMINI_API_KEY ada (atau input.aiEnabled true)
 *              → POST /api/ai-decision (authFetch) → source="ai-decision-server"
 *              → kalau fetch gagal → turun ke MODE KEEL
 *   MODE KEEL: GEMINI kosong ATAU /api/ai-decision gagal
 *              → runKeelQuantEngine(input) LANGSUNG local → source="keel-institutional-quant"
 *              → TIDAK lewat /api/keel/signal (hindari double round-trip)
 *              → INLINE guard via evaluateKeelRisk (F-01/P0) + price-order
 *                validation (F-05) sebelum return — fail-closed ke HOLD.
 */
export async function evaluateTradingDecision(
  input: DecisionEngineInput
): Promise<LLMDecision> {
  const startTime = Date.now();

  // Client (browser) tidak punya process.env — UI melempar input.aiEnabled dari
  // /api/health.geminiConfigured. Konteks Node pakai env langsung. Guard
  // typeof process agar bundel client tidak ReferenceError.
  const envHasGemini =
    typeof process !== "undefined" &&
    !!process.env &&
    !!process.env.GEMINI_API_KEY &&
    process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY";
  const aiConfigured = input.aiEnabled != null ? input.aiEnabled : envHasGemini;

  if (aiConfigured) {
    try {
      // F-04: /api/ai-decision di server sekarang requireAuth → wajib pakai authFetch
      // supaya Authorization header (Bearer token) ikut terkirim.
      const res = await authFetch("/api/ai-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: input.symbol,
          currentPrice: input.currentPrice,
          technicals: input.technicals,
          mtfLiquidity: {
            marketType: input.mtfLiquidity.marketType,
            activeState: input.mtfLiquidity.activeState,
            confluenceScore: input.mtfLiquidity.confluenceScore,
            confluenceSummary: input.mtfLiquidity.confluenceSummary,
            nearestBSL: input.mtfLiquidity.nearestBSL,
            nearestSSL: input.mtfLiquidity.nearestSSL,
            recentSweep: input.mtfLiquidity.recentSweep,
            huntingTarget: input.mtfLiquidity.huntingTarget,
          },
          onChainMetrics: input.onChainMetrics,
          macroCalendar: input.macroCalendar,
          activePositions: input.activePositions,
          portfolioEquity: input.portfolioEquity,
          riskParams: {
            maxRiskPerTradePercent: input.riskConfig.maxRiskPerTradePercent,
            maxDrawdownPercent: input.riskConfig.maxDrawdownLimit,
            minConfidenceThreshold: input.riskConfig.minConfidenceThreshold,
          },
          /*** Provenance tags per pilar (4.4) — server simpan di audit ledger. */
          provenance: input.provenance,
          // Full keel context untuk fallback server-side: kalau Gemini gagal,
          // server tetap bisa runKeelQuantEngine dengan depth/flow riil.
          orderBook: input.orderBook,
          recentTrades: input.recentTrades,
          futures: input.futures,
        }),
      });

      if (res.ok) {
        const raw = await res.json();
        // Fail-closed: validasi shape output LLM — tolak keluaran malformed
        // (mis. SL/TP non-finite) walau HTTP 200. F-05.
        const shapeCheck = AIDecisionResponseSchema.safeParse({
          action: raw?.action ?? "HOLD",
          confidence: raw?.confidence ?? 0,
          targetPrice: raw?.targetPrice ?? input.currentPrice,
          stopLoss: raw?.stopLoss ?? Number((input.currentPrice * 0.985).toFixed(2)),
          takeProfit: raw?.takeProfit ?? Number((input.currentPrice * 1.03).toFixed(2)),
          positionSizePercent: raw?.positionSizePercent ?? 8,
        });
        if (!shapeCheck.success) {
          return {
            action: "HOLD",
            confidence: 0,
            targetPrice: input.currentPrice,
            stopLoss: Number((input.currentPrice * 0.985).toFixed(2)),
            takeProfit: Number((input.currentPrice * 1.03).toFixed(2)),
            positionSizePercent: 0,
            reasoning: `AI output ditolak (shape invalid): ${shapeCheck.error.issues.map((i) => `${String(i.path.join("."))}: ${i.message}`).join("; ")}`,
            source: "ai-decision-server",
            inferenceLatencyMs: Date.now() - startTime,
          };
        }
        const data = shapeCheck.data;
        // Fail-closed: SL/TP tidak konsisten dengan arah → HOLD (bukan default
        // diam-diam yang memproduksi posisi zombie). F-05.
        const orderCheck = validateDecisionPriceOrder(data.action, input.currentPrice, data.stopLoss, data.takeProfit);
        if (!orderCheck.ok) {
          return {
            action: "HOLD",
            confidence: 0,
            targetPrice: input.currentPrice,
            stopLoss: Number((input.currentPrice * 0.985).toFixed(2)),
            takeProfit: Number((input.currentPrice * 1.03).toFixed(2)),
            positionSizePercent: 0,
            reasoning: `AI output ditolak (${orderCheck.message})`,
            source: "ai-decision-server",
            inferenceLatencyMs: Date.now() - startTime,
          };
        }
        return {
          action: data.action,
          confidence: data.confidence,
          targetPrice: data.targetPrice,
          stopLoss: data.stopLoss,
          takeProfit: data.takeProfit,
          positionSizePercent: data.action === "HOLD" ? 0 : data.positionSizePercent,
          reasoning: raw.reasoning || "Evaluasi MTF Liquidation Hunt, On-Chain, dan Makro selesai.",
          source: "ai-decision-server",
          inferenceLatencyMs: Date.now() - startTime,
          liquidityHuntAnalysis: raw.liquidityHuntAnalysis || {
            targetPool: input.mtfLiquidity.huntingTarget?.targetType || "BSL",
            targetZonePrice: input.mtfLiquidity.huntingTarget?.targetPrice || input.currentPrice * 1.025,
            sweepTriggered: Boolean(input.mtfLiquidity.recentSweep),
            mtfBias: input.mtfLiquidity.activeState,
            confluenceScore: input.mtfLiquidity.confluenceScore,
            invalidationLevel: input.mtfLiquidity.recentSweep?.invalidationPrice || input.currentPrice * 0.985,
          },
          onChainContext: raw.onChainContext || {
            // F-07: default jujur no-data — JANGAN klaim akumulasi bullish
            // spesifik bila server & client sama-sama tidak punya data on-chain.
            smartMoneyBias: input.onChainMetrics?.smartMoneyBias || "NO_DATA",
            netflowStatus: input.onChainMetrics?.netflowStatus || "NO_DATA",
            mvrvZScore: input.onChainMetrics?.mvrvZScore ?? NaN,
            whaleSignal: input.onChainMetrics?.whaleAlerts?.[0]?.type || "No whale data (fail-closed)",
          },
          macroContext: raw.macroContext || {
            // Jujur: kalau tidak ada data makro real, jangan klaim FOMC/HIGH_ALERT
            // yang ber-opini — kasih label no-data (F9).
            nearestEventName: input.macroCalendar?.nearestEvent?.name || "No macro data (fail-closed)",
            volatilityRisk: input.macroCalendar?.nearestEvent?.volatilityRisk || "UNKNOWN",
            fedStance: input.macroCalendar?.fedPolicyStance || "DATA_DEPENDENT",
          },
          provenance: raw.provenance ?? input.provenance,
          promptSummary: raw.promptSummary,
        };
      }
    } catch (err) {
      console.warn(
        "Server decision route unavailable, falling back to local Keel institutional quant engine:",
        err
      );
    }
  }

  // MODE KEEL — local, tanpa HTTP /api/keel/signal (hindari double round-trip).
  // Fail-closed jujur: orderBook kosong atau recentTrades kosong → keel HOLD
  // (tidak pernah fabricate depth/trade print).
  const keelResult = runKeelQuantEngine({
    symbol: input.symbol,
    currentPrice: input.currentPrice,
    candles15m: input.candles15m,
    candles4h: input.candles4h,
    technicals: input.technicals,
    mtfLiquidity: input.mtfLiquidity,
    orderBook: input.orderBook,
    recentTrades: input.recentTrades,
    futures: input.futures,
  });

  // F-01/P0: inline guardrail check pada fallback Keel — risk gate server
  // (keel risk engine: max posisi, order rate, drawdown, kill-switch, size
  // band, SL protection) HARUS jalan sebelum decision dikembalikan. Tanpa ini
  // client mendapat decision BUY/SELL yang lolos dari semua risk gates.
  const keelDecision = keelResult.decision;
  const keelOrderCheck = validateDecisionPriceOrder(
    keelDecision.action,
    input.currentPrice,
    keelDecision.stopLoss,
    keelDecision.takeProfit
  );
  if (!keelOrderCheck.ok) {
    return {
      action: "HOLD",
      confidence: 0,
      targetPrice: input.currentPrice,
      stopLoss: Number((input.currentPrice * 0.985).toFixed(2)),
      takeProfit: Number((input.currentPrice * 1.03).toFixed(2)),
      positionSizePercent: 0,
      reasoning: `Keel output ditolak (${keelOrderCheck.message})`,
      source: "keel-institutional-quant",
      inferenceLatencyMs: Date.now() - startTime,
    };
  }
  if (keelDecision.action !== "HOLD") {
    const stopDistPct =
      input.currentPrice > 0
        ? Math.abs(input.currentPrice - keelDecision.stopLoss) / input.currentPrice
        : 0;
    const stopLossPct = keelDecision.action === "BUY" ? -stopDistPct * 100 : stopDistPct * 100;
    try {
      const keelRisk = evaluateKeelRisk(
        {
          venue: "BINANCE_SPOT",
          action: keelDecision.action,
          sizePct: keelDecision.positionSizePercent || 5,
          stopLossPct,
        },
        input.portfolioEquity
      );
      if (!keelRisk.passed) {
        return {
          action: "HOLD",
          confidence: 0,
          targetPrice: input.currentPrice,
          stopLoss: Number((input.currentPrice * 0.985).toFixed(2)),
          takeProfit: Number((input.currentPrice * 1.03).toFixed(2)),
          positionSizePercent: 0,
          reasoning: `Risk blocked (keel fallback): ${keelRisk.reasons.join(", ")}`,
          source: "keel-institutional-quant",
          inferenceLatencyMs: Date.now() - startTime,
        };
      }
    } catch (err) {
      // Fail-closed: kalau risk engine sendiri error, jangan loloskan sinyal
      // direksional — kembalikan HOLD jujur.
      return {
        action: "HOLD",
        confidence: 0,
        targetPrice: input.currentPrice,
        stopLoss: Number((input.currentPrice * 0.985).toFixed(2)),
        takeProfit: Number((input.currentPrice * 1.03).toFixed(2)),
        positionSizePercent: 0,
        reasoning: `Risk engine error (fail-closed): ${(err as Error)?.message || "unknown"}`,
        source: "keel-institutional-quant",
        inferenceLatencyMs: Date.now() - startTime,
      };
    }
  }

  return {
    ...keelDecision,
    source: "keel-institutional-quant",
    inferenceLatencyMs: Date.now() - startTime,
  };
}