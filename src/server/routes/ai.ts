import type { Express } from "express";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { liquidityPoolContext, onChainDecisionContext, promptNumber } from "../aiDataContext";
import { requireAuth } from "@/auth";
import { appendAudit, saveAgentDecisionDb, listReplayRunsDb } from "@/db";
import { getPaperAccount } from "@/paperBook";
import { runKeelQuantEngine, evaluateKeelRisk, type FuturesAnalysis } from "@/src/logic/keelAdapter";
import { analyzeMTFLiquidity } from "@/src/logic/liquidityHunt";
import { fetchMarketData, fetchRecentTrades, fetchFuturesMetrics, fetchMacroReal, deriveMacroRiskIndex, type RecentTrade, type FuturesMetrics } from "@/src/data/marketFetcher";
import { calculateRSI, calculateEMA, calculateMACD } from "@/src/logic/indicators";
import type { Candle, OrderBook, MTFLiquidityAnalysis, OnChainMetrics, MacroSummary } from "@/src/types";
import { callChatJson, callOpencodeCli } from "@/src/logic/aiProviders";
import {
  buildJevState,
  jevStateToPrompt,
  parseJevResponse,
  sanitizeJevError,
  jevZenConfig,
  openRouterConfig,
  opencodeGatewayConfig,
  isProviderConfigured,
  isOpencodeGatewayConfigured,
  type ProviderConfig,
  type OpencodeGatewayConfig,
} from "@/src/logic/jevChip";
import { assembleDecision, type JevDecision } from "@/src/logic/decisionAssembler";
import {
  verdictFromProvenance,
  healthRowFromVerdict,
  applyEntryPolicyGate,
  type ProvenanceVerdict,
} from "@/src/logic/provenance";

/** Verdict provenance untuk "market.price" dari body — dipakai kedua route AI
 *  (decision & advisor). MISSING = tidak diblokir (perilaku lama), klaim palsu
 *  (STALE/SIMULATED/UNKNOWN) → dataHealth turun + entry policy gate. */
function marketPriceVerdictFromBody(body: any, now: number): ProvenanceVerdict {
  const p = body?.provenance;
  const marketProv =
    p?.market ?? p?.price ?? (p && typeof p === "object" && ("venue" in p || "source" in p || "marketType" in p) ? p : null);
  return verdictFromProvenance(marketProv, { now }, "market.price");
}

// Shape kontrak output /api/ai-decision (dipakai Gemini DAN hasil Jev setelah
// assembleDecision — dipertahankan identik supaya client decisionEngine tidak
// berubah). HOLD perlu positionSizePercent>=1 di wire (client zero-kan sendiri).
const DECISION_RESPONSE_SCHEMA = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  confidence: z.number().int().min(1).max(100).finite(),
  targetPrice: z.number().finite().positive(),
  stopLoss: z.number().finite().positive(),
  takeProfit: z.number().finite().positive(),
  positionSizePercent: z.number().min(1).max(100),
  reasoning: z.string().optional(),
  onChainContext: z
    .object({
      smartMoneyBias: z.string().optional(),
      netflowStatus: z.string().optional(),
      mvrvZScore: z.number().optional(),
      whaleSignal: z.string().optional(),
    })
    .optional(),
  macroContext: z
    .object({
      nearestEventName: z.string().optional(),
      volatilityRisk: z.string().optional(),
      fedStance: z.string().optional(),
    })
    .optional(),
});

// Lazy Gemini client (singleton). Key model baru format AQ.xxxxx
// (key lama AIza... sudah dicabut Google — semua model jawab 404).
// Return juga status key agar pesan keel-only bisa bedakan "belum di-set"
// vs "legacy dicabut" vs "AI error saat call".
export type GeminiKeyStatus = "ok" | "legacy-revoked" | "none";
let genAI: GoogleGenAI | null = null;
function probeGeminiKey(apiKey: string | undefined): GeminiKeyStatus {
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") return "none";
  if (apiKey.startsWith("AIza")) return "legacy-revoked";
  return "ok";
}
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (probeGeminiKey(apiKey) !== "ok") {
    return null;
  }
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey: apiKey as string });
  }
  return genAI;
}

/**
 * Keel summary untuk state Jev di /api/ai-decision — dari data yang SAMA
 * dengan yang dikirim FE (technicals/mtf/orderBook/recentTrades/futures).
 * Bentuknya identik dengan keelSummary advisor supaya Gemini & Jev menalar
 * dari fakta yang sama. Null (fail-closed) kalau keel engine error.
 */
function buildDecisionKeelSummary(opts: {
  symbol: string;
  currentPrice: number;
  technicals: any;
  mtfLiquidity: any;
  orderBook?: any;
  recentTrades?: any;
  futures?: any;
}): Record<string, unknown> | null {
  try {
    const result = runKeelQuantEngine({
      symbol: opts.symbol,
      currentPrice: opts.currentPrice,
      technicals: opts.technicals,
      mtfLiquidity: opts.mtfLiquidity,
      orderBook: opts.orderBook || undefined,
      recentTrades: opts.recentTrades,
      futures: opts.futures,
    });
    const decision = result.decision as any;
    const raw = result.rawSignalResult as any;
    const fa = decision?.futuresAnalysis;
    const mtf = opts.mtfLiquidity;
    return {
      action: String(decision?.action ?? "HOLD"),
      confidence: Number(decision?.confidence ?? 50),
      flow: String(raw?.smartMoneyFlow ?? "NEUTRAL"),
      futuresBias: fa?.bias ?? "NEUTRAL",
      fundingBps: fa?.fundingBps ?? null,
      openInterestUsd: fa?.openInterestUsd ?? null,
      lsrTaker: fa?.lsrTaker ?? null,
      confluenceScore: raw?.confluence?.score ?? decision?.liquidityHuntAnalysis?.confluenceScore ?? null,
      liquidityDepthUsd: typeof raw?.liquidityDepthUsd === "number" ? raw.liquidityDepthUsd : null,
      reasoning: String(decision?.reasoning ?? "Tidak ada reasoning dari keel."),
      discardedReason: raw?.discardedReason ?? null,
      mtfState: mtf
        ? {
            activeState: mtf.activeState,
            nearestBSL: mtf.nearestBSL ? { midPrice: mtf.nearestBSL.midPrice, estimatedVolumeUSD: mtf.nearestBSL.estimatedVolumeUSD } : null,
            nearestSSL: mtf.nearestSSL ? { midPrice: mtf.nearestSSL.midPrice, estimatedVolumeUSD: mtf.nearestSSL.estimatedVolumeUSD } : null,
            recentSweep: mtf.recentSweep
              ? { type: mtf.recentSweep.type, wickRejectionPercent: mtf.recentSweep.wickRejectionPercent, invalidationPrice: mtf.recentSweep.invalidationPrice }
              : null,
          }
        : null,
    };
  } catch (e: any) {
    console.warn(`[jev] keel summary builder gagal: ${e?.message}`);
    return null;
  }
}

/**
 * Daftar provider Jev + dispatcher. Tier keyless "jev-opencode" (gateway CLI
 * opencode) dimasukkan PALING DEPAN — tanpa API key, model `opencode/*`
 * diproksi gateway opencode. Berikutnya zen (HTTP), lalu OpenRouter (HTTP).
 */
type JevProviderEntry = {
  id: string;
  kind: "cli" | "http";
  cfg: OpencodeGatewayConfig | ProviderConfig;
};

function jevProviderEntries(): JevProviderEntry[] {
  const oc = opencodeGatewayConfig();
  const entries: JevProviderEntry[] = [];
  if (isOpencodeGatewayConfigured(oc)) entries.push({ id: "jev-opencode", kind: "cli", cfg: oc });
  for (const [id, cfg] of [
    ["jev-zen", jevZenConfig()],
    ["jev-openrouter", openRouterConfig()],
  ] as Array<[string, ProviderConfig]>) {
    if (isProviderConfigured(cfg)) entries.push({ id, kind: "http", cfg });
  }
  return entries;
}

async function callJevProvider(entry: JevProviderEntry, prompt: string): Promise<import("@/src/logic/aiProviders").ChatJsonResult> {
  if (entry.kind === "cli") {
    const c = entry.cfg as OpencodeGatewayConfig;
    return callOpencodeCli({ model: c.model, prompt, bin: c.bin || undefined, workDir: c.workDir || undefined, timeoutMs: 30_000 });
  }
  const c = entry.cfg as ProviderConfig;
  return callChatJson({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, prompt, maxTokens: 300, temperature: 0.1, timeoutMs: 20_000 });
}

/**
* Chain Jev: zen → openrouter. Setiap provider: buildJevState → chat JSON →
  * parseJevResponse → assembleDecision → zod lama → guard harga → audit.
  * Gagal/err/invalid = console.warn + continue (TIDAK throw ke Express 4).
  * Return { handled, errors } — errors = alasan gagal per provider (sudah
  * di-sanitasi) untuk konsol & UI.
  */
async function tryJevDecisionChain(opts: {
  symbol: string;
  currentPrice: number;
  technicals: any;
  mtfLiquidity: any;
  reqOrderBook?: any;
  reqRecentTrades?: any;
  reqFutures?: any;
  onChainMetrics?: OnChainMetrics;
  macroCalendar?: MacroSummary;
  riskParams: any;
  provenance?: any;
  /** P1-01: verdict provenance harga — MISSING tidak block; STALE/SIM/UNKNOWN block entry. */
  marketPriceVerdict: ProvenanceVerdict;
  onDone: (payload: Record<string, unknown>, provider: string, modelSlug: string, jev: JevDecision, latencyMs: number, jevErrors: string[]) => void;
}): Promise<{ handled: boolean; errors: string[] }> {
  const symbol = String(opts.symbol || "BTC/USDT");
  const price = Number(opts.currentPrice) || 0;
  const errors: string[] = [];
  const keelSummary = buildDecisionKeelSummary({
    symbol,
    currentPrice: price,
    technicals: opts.technicals,
    mtfLiquidity: opts.mtfLiquidity,
    orderBook: opts.reqOrderBook,
    recentTrades: opts.reqRecentTrades,
    futures: opts.reqFutures,
  });
  let futuresDetail: Record<string, unknown> | null = null;
  if (opts.reqFutures && opts.reqFutures.success) {
    const f = opts.reqFutures as FuturesMetrics & Record<string, any>;
    futuresDetail = {
      fundingBps: f.fundingBps ?? null,
      markPrice: f.markPrice ?? null,
      openInterestUsd: f.openInterestUsd ?? null,
      lsrTaker: f.lsrTaker ?? null,
      longLiqUsd: f.longLiqUsd ?? null,
      shortLiqUsd: f.shortLiqUsd ?? null,
      volume24hUsd: f.volume24hUsd ?? null,
      source: f.source ?? null,
    };
  }
  let backtestCtx = "Tidak ada konteks backtest.";
  try {
    backtestCtx = buildBacktestContextFor(symbol);
  } catch (e: any) {
    console.warn(`[jev] backtest context gagal: ${e?.message}`);
  }
  const state = buildJevState({
    symbol,
    currentPrice: price,
    keelSummary,
    dataHealth: [
      { source: "keel", ok: !!keelSummary, detail: keelSummary ? "keel engine tersedia" : "GAGAL — state Jev tanpa arah keel" },
      { source: "futures", ok: !!futuresDetail, detail: futuresDetail ? "futures metrics tersedia" : "GAGAL / tidak dikirim" },
      { source: "backtest", ok: true, detail: "DB replay_runs (bisa kosong)" },
      // P1-01: verdict provenance harga dari server — klaim client tidak ditelan
      // mentah; STALE/SIMULATED/UNKNOWN ikut "failed sources" di prompt.
      healthRowFromVerdict(opts.marketPriceVerdict, "provenance:market.price"),
    ],
    multiTf: {},
    futuresDetail,
    macroEcho: opts.macroCalendar ? { ...opts.macroCalendar } : null,
    onChainPolicy: onChainDecisionContext(opts.onChainMetrics),
    backtestCtx,
  });
  const prompt = jevStateToPrompt(state);

  for (const entry of jevProviderEntries()) {
    const provider = entry.id;
    const cfg = entry.cfg;
    if (entry.kind === "http" && !isProviderConfigured(cfg as ProviderConfig)) {
      console.warn(`[jev] ${provider} tidak terkonfigurasi (baseUrl/apiKey/model kosong) — lanjut.`);
      continue;
    }
    const modelSlug = entry.kind === "cli" ? (cfg as OpencodeGatewayConfig).model : (cfg as ProviderConfig).model;
    try {
      const res = await callJevProvider(entry, prompt);
      if (!res.ok) {
        const why = sanitizeJevError(res.error || `HTTP ${res.status ?? "?"}`);
        console.warn(`[jev] ${provider} gagal (${why}) — coba provider berikutnya.`);
        errors.push(`${provider}: ${why}`);
        continue;
      }
      const parsed = parseJevResponse(res.data);
      if (!parsed.ok || !parsed.parsed) {
        const why = sanitizeJevError(parsed.issues?.map((i) => i.message).join("; ") || "non-JSON");
        console.warn(`[jev] ${provider} output invalid (${why}) — coba berikutnya.`);
        errors.push(`${provider}: output invalid (${why})`);
        continue;
      }
      const decision = assembleDecision(parsed.parsed, {
        symbol,
        currentPrice: price,
        keelSummary,
        technicals: opts.technicals,
        riskConfig: {
          maxRiskPerTradePercent: Number(opts.riskParams?.maxRiskPerTradePercent) || 10,
          minConfidenceThreshold: Number(opts.riskParams?.minConfidenceThreshold) || 50,
        },
      });
      // P1-01: ENTRY policy — harga dinyatakan palsu/basi/simulasi → HOLD
      // (EXIT risiko tidak diblokir; itu domain bracket monitor).
      const gated = applyEntryPolicyGate(
        { action: decision.action, positionSizePercent: decision.positionSizePercent, reasoning: decision.reasoning },
        opts.marketPriceVerdict
      );
      const finalDecision = gated.gated ? { ...decision, action: gated.action as "BUY" | "SELL" | "HOLD", positionSizePercent: gated.positionSizePercent, reasoning: gated.reasoning } : decision;
      const payloadForSchema = {
        action: finalDecision.action,
        confidence: finalDecision.confidence,
        targetPrice: finalDecision.targetPrice,
        stopLoss: finalDecision.stopLoss,
        takeProfit: finalDecision.takeProfit,
        positionSizePercent: finalDecision.action === "HOLD" ? 1 : finalDecision.positionSizePercent,
      };
      const shape = DECISION_RESPONSE_SCHEMA.safeParse(payloadForSchema);
      if (!shape.success) {
        const why = sanitizeJevError(shape.error.issues.map((i) => i.message).join("; "));
        console.warn(`[jev] ${provider}: hasil assembleDecision gagal shape lama (${why}) — coba berikutnya.`);
        errors.push(`${provider}: shape lama gagal (${why})`);
        continue;
      }
      const priceOk =
        finalDecision.action === "BUY"
          ? finalDecision.stopLoss < price && price < finalDecision.takeProfit
          : finalDecision.action === "SELL"
            ? finalDecision.takeProfit < price && price < finalDecision.stopLoss
            : true;
      if (!priceOk) {
        console.warn(`[jev] ${provider}: guard harga gagal — coba berikutnya.`);
        errors.push(`${provider}: guard harga gagal`);
        continue;
      }
      opts.onDone(
        {
          ...payloadForSchema,
          reasoning: finalDecision.reasoning,
        },
        provider,
        modelSlug,
        parsed.parsed,
        Date.now(),
        errors
      );
      return { handled: true, errors };
    } catch (err: any) {
      console.warn(`[jev] ${provider} unexpected (tanpa throw ke Express): ${sanitizeJevError(err?.message || err)}`);
      errors.push(`${provider}: ${sanitizeJevError(err?.message || err)}`);
      continue;
    }
  }
  return { handled: false, errors };
}

/** Konteks backtest (replay runs tersimpan per simbol) — dipakai prompt Gemini
 *  maupun state Jev. Dideklarasikan di module scope supaya bisa dipakai kedua
 *  route + chain Jev tanpa duplikasi. */
function buildBacktestContextFor(symbol: string): string {
  try {
    const symUpper = String(symbol || "").toUpperCase().replace(" ", "");
    const runs = (listReplayRunsDb(50) || []).filter(
      (r) => r.symbol.toUpperCase().replace(" ", "") === symUpper || `${r.symbol}USDT`.toUpperCase().replace(" ", "") === symUpper
    );
    if (runs.length === 0) {
      return "Tidak ada run replay/backtest tersimpan untuk simbol ini. (Jalankan Replay di tab Paper lalu klik Export untuk menghasilkan).";
    }
    const rows = runs.slice(0, 3).map((r) => {
      const date = new Date(r.createdAt).toISOString().slice(0, 10);
      return (
        `- ${date} · ${r.symbol} ${r.timeframe} · ${r.totalCandles} candle · ` +
        `${r.totalTrades} trade (${r.winRate}% win) · PF ${r.profitFactor} · avgR ${r.avgR} · ` +
        `MaxDD ${r.maxDrawdownPct}% · PnL ${r.realizedPnl >= 0 ? "+" : ""}$${r.realizedPnl.toFixed(2)} (modal $${r.initialCash.toFixed(0)})`
      );
    });
    return (
      "Run replay/backtest historis terbaru pada simbol ini (sumber candle REAL Binance Vision):\n" +
      rows.join("\n") +
      "\nCatatan penting: ini HASIL MASA LALU (backtest) — bukan prediksi & bukan jaminan. " +
      "Gunakan sebagai KALIBRASI keyakinan: jika backtest strategi menunjukkan win rate rendah / MaxDD besar / PF < 1, " +
      "turunkan tingkat keyakinan dan hindari bias optimistik."
    );
  } catch (e: any) {
    return `Gagal memuat konteks backtest: ${e?.message || "unknown"}`;
  }
}

export function registerAiRoutes(app: Express): void {
  // 1. LLM Decision Engine Route (MTF Liquidation Hunt, On-Chain Analysis & Macro Calendar Integration)
  app.post("/api/ai-decision", requireAuth, async (req, res) => {
    const startTime = Date.now();
    const {
      symbol,
      currentPrice,
      technicals,
      mtfLiquidity,
      onChainMetrics,
      macroCalendar,
      activePositions,
      portfolioEquity,
      riskParams,
    } = req.body;
const reqOrderBook = (req.body as any)?.orderBook;
const reqRecentTrades = (req.body as any)?.recentTrades;
const reqFutures = (req.body as any)?.futures;
// P1-01: verdict provenance harga (klaim client diverifikasi server-side).
const marketPriceVerdict = marketPriceVerdictFromBody(req.body, startTime);

// ===== JEV CHIP (System One) — chain: jev-zen → jev-openrouter → Gemini → Keel.
// Jev lebih cepat & terstruktur; kalau semua provider Jev mati, jatuh ke
// chain Gemini yang sudah ada (tidak throw — pola tetap sama).
const jevHandled = await tryJevDecisionChain({
  symbol: String(symbol || "BTC/USDT"),
  currentPrice: Number(currentPrice) || 0,
  technicals,
  mtfLiquidity,
  reqOrderBook,
  reqRecentTrades,
  reqFutures,
  onChainMetrics,
  macroCalendar,
  riskParams,
  provenance: (req.body as any)?.provenance ?? null,
  marketPriceVerdict,
      onDone: (payload, provider, modelSlug, jev, latencyMs) => {
        const inferenceLatency = Date.now() - startTime;
        const maxRisk = Number(riskParams?.maxRiskPerTradePercent) || 0;
        const clampedSize =
          maxRisk > 0 && Number(payload.positionSizePercent) > maxRisk ? maxRisk : Number(payload.positionSizePercent);
        try {
          const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          saveAgentDecisionDb({
            id: decisionId,
            created_at: Date.now(),
            symbol: String(symbol || "BTC/USDT"),
            action: String(payload.action),
            confidence: Number(payload.confidence),
            model_id: modelSlug,
            latency_ms: inferenceLatency,
            prompt: `jev-state symbol=${String(symbol || "BTC/USDT")} provider=${provider} ${latencyMs}`,
            response: JSON.stringify(payload).slice(0, 2000),
            source_tags: JSON.stringify({
              provider,
              model: modelSlug,
              jevConfidence: jev.confidence,
              jevRiskLevel: jev.riskLevel,
              provenance: (req.body as any)?.provenance ?? null,
            }),
          });
          appendAudit("decision", {
            decisionId,
            symbol: String(symbol || "BTC/USDT"),
            action: String(payload.action),
            confidence: Number(payload.confidence),
            latencyMs: inferenceLatency,
            modelId: modelSlug,
            provider,
            jevConfidence: jev.confidence,
            jevRiskLevel: jev.riskLevel,
            clampedPositionSize: clampedSize !== Number(payload.positionSizePercent),
          });
        } catch (e: any) {
          console.warn(`[jev] gagal simpan audit decision: ${e?.message}`);
        }
        res.json({
          ...payload,
          positionSizePercent: clampedSize,
          reasoning: payload.reasoning,
          source: provider,
          modelId: modelSlug,
          decisionSource: provider,
          jevConfidence: jev.confidence,
          jevRiskLevel: jev.riskLevel,
          inferenceLatencyMs: inferenceLatency,
          provenance: (req.body as any)?.provenance ?? null,
          promptSummary: `jevs=${provider} symbol=${String(symbol || "BTC/USDT")} price=${currentPrice} conf=${jev.confidence} risk=${jev.riskLevel}`,
        });
      },
    });
    // handled = objek {handled:boolean} — cek PROPERTINYA, bukan objeknya
    // (objek selalu truthy; dulu `if (jevHandled)` membuat semua jalur
    // fallback Gemini/keel pulang tanpa respons → request gantung).
    if (jevHandled.handled) return;

    const client = getGeminiClient();

    if (client) {
      try {
        const prompt = `Anda adalah Institutional AI Trading Agent dengan keahlian komprehensif:
1. Multi-Timeframe (MTF) Liquidity Hunt (15m Futures & 4h Spot Market)
2. On-Chain Analysis & Smart Money Whale Dynamics
3. Macroeconomic Calendar & Fed Interest Rate Policy

Konteks Pasar & MTF Liquidation Hunt:
- Asset: ${symbol}
- Market Type: ${mtfLiquidity?.marketType || "FUTURES"} (Primary TF: ${mtfLiquidity?.primaryTimeframe || "15m"}, Macro TF: ${mtfLiquidity?.macroTimeframe || "4h"})
- Harga Saat Ini: $${currentPrice}
- Status Liquidity Hunt: ${mtfLiquidity?.activeState || "No data"}
- Confluence Score: ${promptNumber(mtfLiquidity?.confluenceScore, "%")} (${mtfLiquidity?.confluenceSummary || "No data"})
- Upper BSL candidate: ${liquidityPoolContext(mtfLiquidity?.nearestBSL)}
- Lower SSL candidate: ${liquidityPoolContext(mtfLiquidity?.nearestSSL)}
- Recent Sweep: ${mtfLiquidity?.recentSweep ? `${mtfLiquidity.recentSweep.type} dengan ${mtfLiquidity.recentSweep.wickRejectionPercent}% wick absorption. Invalidation: $${mtfLiquidity.recentSweep.invalidationPrice}` : "Belum ada sweep terbaru"}

${onChainDecisionContext(onChainMetrics)}

Kalender Makroekonomi (Macro Knowledge & Catalysts):
- Sikap Moneter The Fed: ${macroCalendar?.fedPolicyStance || "No data"}
- Indeks Risiko Makro: ${macroCalendar?.macroRiskIndex != null ? `${macroCalendar.macroRiskIndex}/100` : "No data"}
- Event Terdekat: ${macroCalendar?.nearestEvent ? `${macroCalendar.nearestEvent.name} (${macroCalendar.nearestEvent.relativeTime}) - Impact: ${macroCalendar.nearestEvent.impact}. Implikasi: ${macroCalendar.nearestEvent.implicationNotes}` : "No macro event data"}
- Panduan Risiko Makro: ${macroCalendar?.macroTradingAdvice || "No data"}

Indikator Teknikal Pendukung:
- RSI (14): ${promptNumber(technicals?.rsi)}
- EMA (20): ${promptNumber(technicals?.ema20)} | EMA (50): ${promptNumber(technicals?.ema50)}
- Order Book Imbalance: ${promptNumber(technicals?.orderBookImbalance)}

Portfolio & Risk Context:
- Total Equity: $${(() => { try { const a = getPaperAccount(); return `${a.equity} (real — cash ${a.cash} + margin ${a.marginLocked} + uPnL ${a.unrealizedPnl})`; } catch { return portfolioEquity != null ? `${portfolioEquity} (client-supplied)` : "equity tidak tersedia"; } })()}
- Active Position: ${JSON.stringify(activePositions || [])}
- Max Risk Per Trade: ${riskParams?.maxRiskPerTradePercent ?? 2}%

[BACKTEST CONTEXT (HASIL REPLAY HISTORIS — kalibrasi keyakinan)]:
${(() => { try { return buildBacktestContextFor(String(symbol || "BTC/USDT")); } catch { return "Tidak ada konteks backtest."; } })()}

TUGAS ANDA:
1. Sintesis ketiga pilar (MTF Liquidity Hunt + On-Chain Whale Flows + Macroeconomic Calendar).
2. Jika ada sweep SSL (long stop swept) ditambah On-Chain Whale Outflows dan Macro dovish -> Bullish Confluence kuat.
3. Jika ada sweep BSL (short stop swept) atau Whale Inflow besar menjelang high-impact macro -> Bearish Reversal / Distribution.
4. Tentukan aksi (BUY, SELL, atau HOLD) dan Confidence (1-100%).
5. Tentukan Stop Loss presisi di luar invalidation wick sweep dan Take Profit menuju Liquidity Pool lawan.
   (CATATAN PIPELINE: level SL/TP/target/size FINAL dihitung ulang SERVER secara deterministik dari BSL/SSL/ATR — angka Anda dipakai sebagai kalibrasi arah & keyakinan, bukan level eksekusi.)
6. Berikan reasoning ringkas (2-3 kalimat) yang menjelaskan integrasi Liquidity + On-chain + Makro.
7. KALIBRASI dengan BACKTEST CONTEXT: jika strategi historis simbol ini menunjukkan PF < 1 atau MaxDD tinggi -> JANGAN overconfident; turunkan confidence / kecilkan positionSizePercent secara wajar.

Jawab HANYA dalam format JSON valid tanpa markdown wrapper:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": number,
  "targetPrice": number,
  "stopLoss": number,
  "takeProfit": number,
  "positionSizePercent": number,
  "reasoning": "string",
  "onChainContext": {
    "smartMoneyBias": "string",
    "netflowStatus": "string",
    "mvrvZScore": number,
    "whaleSignal": "string"
  },
  "macroContext": {
    "nearestEventName": "string",
    "volatilityRisk": "string",
    "fedStance": "string"
  }
}`;

        const decisionSchema = DECISION_RESPONSE_SCHEMA;

      const candidateModels = ["gemini-3.8-flash", "gemini-3.7-flash"];
        let responseText: string = "{}";
        let usedModel = "gemini-3.8-flash";
        let lastErr: any = null;
        for (const model of candidateModels) {
          try {
            const aiResponse = await client.models.generateContent({
              model,
              contents: prompt,
              config: {
                responseMimeType: "application/json",
                temperature: 0.2,
              },
            });
            if (aiResponse && aiResponse.text) {
              responseText = aiResponse.text;
              usedModel = model;
              break;
            }
            lastErr = new Error(`model ${model} returned empty response`);
          } catch (modelErr: any) {
            lastErr = modelErr;
            const msg = String(modelErr?.message || "");
            const status = (modelErr as any)?.status;
            if (/INVALID_MODEL|not found|does not exist|404/i.test(msg)) {
              console.warn(`Gemini model ${model} tidak valid, coba fallback...`);
              continue;
            }
            // Sama seperti advisor: jangan throw ke Express — 503/429/overload
            // harus jadi 503 JSON + fallback keel, bukan crash proses.
            if (status === 503 || status === 429 || /503|429|UNAVAILABLE|overloaded|high demand|timeout|fetch failed|ECONN|ETIMEDOUT/i.test(msg)) {
              console.warn(`Gemini decision model ${model} sibuk/transien (${status ?? msg.slice(0, 120)}), coba model berikutnya...`);
              continue;
            }
            console.warn(`Gemini decision model ${model} error, fallback ke keel: ${msg.slice(0, 160)}`);
            break;
          }
        }
        if (!responseText || /^\s*\{?\s*\}$/.test(responseText.trim())) {
          responseText = "{}";
          if (lastErr) {
            // Semua model gagal (termasuk transien): jangan 502 validation —
            // itu untuk output yang ADA tapi rusak. Jatuh ke fallback keel.
            console.warn(`Gemini decision semua model gagal: ${String(lastErr?.message || lastErr).slice(0, 160)}`);
          }
        }
        const allGeminiFailed = !!lastErr && /^\s*\{?\s*\}$/.test(responseText.trim());
        if (!allGeminiFailed) {
        let parsedDecision: unknown;
        try {
          parsedDecision = JSON.parse(responseText);
        } catch (parseErr: any) {
          const inferenceLatency = Date.now() - startTime;
          try {
            appendAudit("decision", {
              symbol: String(symbol || "BTC/USDT"),
              action: "REJECTED_JSON_PARSE",
              latencyMs: inferenceLatency,
              modelId: usedModel,
              reason: "raw-llm-output-not-json",
            });
          } catch {}
          return res.status(502).json({
            success: false,
            source: "fallback-validation-failed",
            reason: "unparseable-llm-json",
            message: "Output LLM tidak valid JSON. Keputusan ditolak (tidak fallback diam-diam).",
          });
        }

        const validation = decisionSchema.safeParse(parsedDecision);
        if (!validation.success) {
          const inferenceLatency = Date.now() - startTime;
          try {
            const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const responseStr = String(responseText).slice(0, 2000);
            saveAgentDecisionDb({
              id: decisionId,
              created_at: Date.now(),
              symbol: String(symbol || "BTC/USDT"),
              action: "REJECTED",
              confidence: 0,
              model_id: usedModel,
              latency_ms: inferenceLatency,
              prompt: prompt.slice(0, 800),
              response: responseStr,
              source_tags: JSON.stringify({ validation: "failed", issues: validation.error.issues }),
            });
            appendAudit("decision", {
              decisionId,
              symbol: String(symbol || "BTC/USDT"),
              action: "REJECTED",
              latencyMs: inferenceLatency,
              modelId: usedModel,
              reason: "validation-failed",
              issues: validation.error.issues,
            });
          } catch {}
          return res.status(502).json({
            success: false,
            source: "fallback-validation-failed",
            reason: "validation-failed",
            issues: validation.error.issues,
            message: "Output LLM gagal validasi. Keputusan ditolak (tidak fallback diam-diam).",
          });
        }

        const parsedDecision2 = validation.data as z.infer<typeof decisionSchema>;

        // ---------------------------------------------------------------------
        // FIX-B (audit 2026-09-21): level SL/TP/target/size TIDAK lagi diambil
        // dari angka LLM (dulu: schema + price-order check 502 + clamp manual).
        // LLM hanya menyetor arah + confidence; level dihitung DETERMINISTIK
        // dari data real server (BSL/SSL → ATR → band default) via
        // assembleDecision — cermin persis jalur Jev (ctx sama: keelSummary
        // dari buildDecisionKeelSummary). Angka LLM yang tidak konsisten
        // dengan struktur likuiditas tidak bisa lagi masuk pipeline order.
        // ---------------------------------------------------------------------
        const assembledGemini = assembleDecision(
          { action: parsedDecision2.action, confidence: parsedDecision2.confidence, riskLevel: "MEDIUM" },
          {
            symbol: String(symbol || "BTC/USDT"),
            currentPrice: Number(currentPrice) || 0,
            keelSummary: buildDecisionKeelSummary({
              symbol: String(symbol || "BTC/USDT"),
              currentPrice: Number(currentPrice) || 0,
              technicals,
              mtfLiquidity,
              orderBook: reqOrderBook,
              recentTrades: reqRecentTrades,
              futures: reqFutures,
            }),
            technicals,
            riskConfig: {
              maxRiskPerTradePercent: Number(riskParams?.maxRiskPerTradePercent) || 10,
              minConfidenceThreshold: Number(riskParams?.minConfidenceThreshold) || 50,
            },
          }
        );

        // P1-01: ENTRY policy — harga dinyatakan palsu/basi/simulasi → HOLD
        // (jalur Gemini juga kena gate; EXIT risiko tidak ikut diblokir).
        const gated = applyEntryPolicyGate(
          { action: assembledGemini.action, positionSizePercent: assembledGemini.positionSizePercent, reasoning: assembledGemini.reasoning },
          marketPriceVerdict
        );
        const finalDecision = gated.gated
          ? { ...assembledGemini, action: gated.action as "BUY" | "SELL" | "HOLD", positionSizePercent: 1, reasoning: gated.reasoning }
          : {
              ...assembledGemini,
              // Kontrak wire sama dengan jalur Jev (payloadForSchema): HOLD
              // perlu positionSizePercent>=1 di wire — client zero-kan sendiri.
              positionSizePercent: assembledGemini.action === "HOLD" ? 1 : assembledGemini.positionSizePercent,
            };

        const inferenceLatency = Date.now() - startTime;
        const provenance = (req.body && req.body.provenance) || null;

        try {
          const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const promptSummary = prompt.slice(0, 800);
          // FIX-B: audit menyimpan DUA sisi — output mentah LLM (kalibrasi) +
          // level hasil assembleDecision (yang benar-benar dikirim ke pipeline).
          const responseStr = JSON.stringify({ llmRaw: parsedDecision2, assembled: finalDecision }).slice(0, 2000);
          const sourceTags =
            JSON.stringify({
              model: usedModel,
              provenance,
              levelsMethod: (finalDecision.reasoning.match(/levels dari ([A-Za-z/-]+)/) || [])[1] ?? "unknown",
              llmRawSize: parsedDecision2.positionSizePercent,
              finalSize: finalDecision.positionSizePercent,
            }) || null;
          saveAgentDecisionDb({
            id: decisionId,
            created_at: Date.now(),
            symbol: String(symbol || "BTC/USDT"),
            action: finalDecision.action,
            confidence: finalDecision.confidence,
            model_id: usedModel,
            latency_ms: inferenceLatency,
            prompt: promptSummary,
            response: responseStr,
            source_tags: sourceTags,
          });
          appendAudit("decision", {
            decisionId,
            symbol: String(symbol || "BTC/USDT"),
            action: finalDecision.action,
            confidence: finalDecision.confidence,
            latencyMs: inferenceLatency,
            modelId: usedModel,
            prompt: promptSummary.slice(0, 200),
            response: responseStr.slice(0, 500),
            provenance,
            provenance_json: provenance,
          });
        } catch (e) {
          console.warn(`[audit] Gagal simpan decision: ${(e as Error).message}`);
        }
        const promptSummary =
          [
            `symbol=${symbol} price=${currentPrice}`,
            `mtf=${mtfLiquidity?.activeState ?? "?"} state, conf=${mtfLiquidity?.confluenceScore ?? "?"}%`,
            `riskMax=${riskParams?.maxRiskPerTradePercent ?? "?"}% equity=${portfolioEquity ?? "?"}`,
          ].join("\n") + `\nmodel=${usedModel} latency=${inferenceLatency}ms`;
        return res.json({
          ...finalDecision,
          source: usedModel,
          inferenceLatencyMs: inferenceLatency,
          provenance,
          promptSummary,
        });
        }
      } catch (err: any) {
        console.warn("Gemini API call failed:", err?.message);
        return res.status(503).json({
          success: false,
          source: "unavailable",
          message: "Gemini API call gagal. Fallback keputusan ditangani client-side (logic/decisionEngine).",
        });
      }
    }

    try {
      const latencyMs = Date.now() - startTime;
      const keelResult = runKeelQuantEngine({
        symbol: String(symbol || "BTC/USDT"),
        currentPrice: Number(currentPrice) || 64250,
        technicals,
        mtfLiquidity,
        // Flow/futures diteruskan bila FE mengirimnya (mode AI full-context).
        // Absen → keel fail-closed lokal (HOLD jujur), bukan fabricate.
        orderBook: reqOrderBook,
        recentTrades: Array.isArray(reqRecentTrades) ? reqRecentTrades : undefined,
        futures: reqFutures,
      });
      const keelDecision = keelResult.decision;

      const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const promptSummary = `policy=keel-quant symbol=${String(symbol || "BTC/USDT")} price=${currentPrice}`.slice(0, 800);
      const responseStr = JSON.stringify(keelDecision).slice(0, 2000);
      try {
        saveAgentDecisionDb({
          id: decisionId,
          created_at: Date.now(),
          symbol: String(symbol || "BTC/USDT"),
          action: keelDecision.action,
          confidence: keelDecision.confidence,
          model_id: "keel-institutional-quant",
          latency_ms: latencyMs,
          prompt: promptSummary,
          response: responseStr,
          source_tags: "keel-quant",
        });
      } catch (e) {
        console.warn(`[audit] Gagal simpan keel decision: ${(e as Error).message}`);
      }
      try {
        appendAudit("decision", {
          decisionId,
          symbol: String(symbol || "BTC/USDT"),
          action: keelDecision.action,
          confidence: keelDecision.confidence,
          latencyMs,
          modelId: "keel-institutional-quant",
          source: "keel-quant",
        });
      } catch {}

      return res.json({
        ...keelDecision,
        source: "keel-institutional-quant",
        inferenceLatencyMs: latencyMs,
        promptSummary,
      });
    } catch (err: any) {
      console.warn(`Keel quant engine fallback error: ${err?.message}`);
    }

    return res.status(503).json({
      success: false,
      source: "unavailable",
      message: "Gemini API Key dan Keel Engine fallback gagal.",
    });
  });

  // Dedicated Keel Institutional Quant Engine Signal Endpoint
  app.post("/api/keel/signal", requireAuth, async (req, res) => {
    const { symbol, currentPrice, technicals, mtfLiquidity, orderBook: bodyOrderBook } = req.body || {};
    const sym = String(symbol || "BTC/USDT");
    const price = Number(currentPrice) || 64250;

    let orderBook = bodyOrderBook;
    let mtf = mtfLiquidity;
    let fetchedPrice = price;
    if (!orderBook || !mtf) {
      try {
        const market = await fetchMarketData(sym);
        if (market && market.success !== false && market.orderBook) {
          if (!orderBook) orderBook = market.orderBook;
          if (!mtf && Array.isArray(market.candles15m) && Array.isArray(market.candles4h) && market.candles15m.length > 0 && market.candles4h.length > 0) {
            fetchedPrice = Number(market.currentPrice) || price;
            mtf = analyzeMTFLiquidity(market.candles15m, market.candles4h, fetchedPrice, "SPOT", market.orderBook);
          }
        }
      } catch (e: any) {
        console.error(`[keel] market data fetch failed (will use null depth): ${e?.message}`);
      }
    }

    let trades: { success: boolean; trades: RecentTrade[]; source: string } = { success: false, trades: [], source: "NONE" };
    try {
      trades = await fetchRecentTrades(sym, 60);
    } catch (e: any) {
      console.warn(`[keel] recent trades fetch failed: ${e?.message}`);
    }
    if (trades.success) console.log(`[keel] recentTrades: ${trades.trades.length} (${trades.source})`);

    let futures: FuturesMetrics = { success: false, source: "NONE" };
    try {
      futures = await fetchFuturesMetrics(sym);
    } catch (e: any) {
      console.warn(`[keel] futures metrics fetch failed: ${e?.message}`);
    }
    if (futures.success) {
      const oiB = futures.openInterestUsd ? (futures.openInterestUsd / 1e9).toFixed(1) : "-";
      console.log(`[keel] futures: ${futures.source} funding=${(futures.fundingBps ?? 0).toFixed(2)}bps OI=$${oiB}B LSR=${futures.lsrTaker ?? "-"}`);
    }

    try {
      const result = runKeelQuantEngine({
        symbol: sym,
        currentPrice: price,
        technicals,
        mtfLiquidity: mtf,
        orderBook,
        recentTrades: trades.trades,
        futures,
      });
      const currentEquity = (() => { try { return getPaperAccount().equity; } catch { return 10000; } })();
      const riskEval = evaluateKeelRisk(
        {
          venue: "BINANCE_SPOT",
          action: result.decision.action,
          sizePct: result.decision.positionSizePercent || 5,
          stopLossPct: -2.0,
        },
        currentEquity
      );
      res.json({
        success: true,
        decision: result.decision,
        rawSignal: result.rawSignalResult,
        riskGate: riskEval,
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err?.message || "Keel signal failed." });
    }
  });

  // ========================================================================
  // AI ADVISOR — insight naratif (Keel + MTF + On-chain + Macro).
  // AI = PENASIHAT, BUKAN eksekutor. Tidak ada jalur order dari endpoint ini.
  // Fail-closed jujur: tanpa GEMINI_API_KEY (atau key legacy AIza yang sudah
  // dicabut Google) → mode "keel" dengan insight ringkas dari keelSummary
  // (data REAL yang sudah dihitung server, BUKAN karangan LLM). Pesan dibedakan
  // per penyebab agar user tahu aksi yang benar (set key vs ganti key vs retry),
  // deterministik dari data keel. Tidak pernah fabricate data pasar.
  // ========================================================================

  interface AiAdvisorBody {
    symbol?: string;
    currentPrice?: number;
    onChainMetrics?: OnChainMetrics | null;
    macroCalendar?: MacroSummary | null;
    technicals?: unknown;
    mtfLiquidity?: MTFLiquidityAnalysis | null;
  }

  function deriveTechnicals(
    candles: Candle[],
    orderBook: OrderBook | null
  ): { rsi: number; ema20: number; ema50: number; macd: { macdLine: number; signalLine: number; histogram: number }; orderBookImbalance: number; volatility: string } {
    const closes = candles.map((c) => c.close);
    const bidTotal = (orderBook?.bids || []).reduce((s, l) => s + l.size, 0);
    const askTotal = (orderBook?.asks || []).reduce((s, l) => s + l.size, 0);
    const imbalance = askTotal > 0 ? bidTotal / askTotal : 1;
    return {
      rsi: calculateRSI(closes, 14),
      ema20: calculateEMA(closes, 20),
      ema50: calculateEMA(closes, 50),
      macd: calculateMACD(closes),
      orderBookImbalance: Number(imbalance.toFixed(2)),
      volatility: "MEDIUM",
    };
  }

  // Multi-TF technicals: derivasi RSI/EMA/MACD per timeframe dari candle real.
  // candleMap: { "15m": Candle[], "1h": Candle[], "4h": Candle[] } — hanya TF
  // yang punya >= 26 candle yang dihitung (MACD butuh 26); sisanya null jujur.
  function deriveMultiTfTechnicals(candleMap: Record<string, Candle[] | undefined>): Record<
    string,
    { rsi: number | null; ema20: number | null; ema50: number | null; macdHistogram: number | null; trend: string | null } | null
  > {
    const out: Record<string, any> = {};
    for (const tf of Object.keys(candleMap)) {
      const candles = candleMap[tf];
      if (!candles || candles.length < 26) {
        out[tf] = null;
        continue;
      }
      const closes = candles.map((c) => c.close);
      const ema20 = calculateEMA(closes, 20);
      const ema50 = calculateEMA(closes, 50);
      const macd = calculateMACD(closes);
      out[tf] = {
        rsi: calculateRSI(closes, 14),
        ema20,
        ema50,
        macdHistogram: macd.histogram,
        trend:
          ema20 > ema50 && macd.histogram >= 0
            ? "UP"
            : ema20 < ema50 && macd.histogram < 0
              ? "DOWN"
              : "MIXED",
      };
    }
    return out;
  }

  app.post("/api/ai-advisor", requireAuth, async (req, res) => {
    const startTime = Date.now();
    const body: AiAdvisorBody = req.body || {};
    const sym = String(body.symbol || "BTC/USDT");
    const price = Number(body.currentPrice) || 64250;

    let market: any = null;
    let marketSource = "NONE";
    try {
      const m = await fetchMarketData(sym);
      if (m && m.success !== false) {
        market = m;
        marketSource = String((m as any).source || "LIVE");
      } else if (m) {
        // success:false = synthetic fallback — jangan dipakai sebagai harga real.
        console.warn(`[ai-advisor] market fallback synthetic untuk ${sym}; pakai harga client + tandai.`);
        marketSource = "SYNTHETIC_IGNORED";
      }
    } catch (e: any) {
      console.warn(`[ai-advisor] market fetch failed: ${e?.message}`);
    }

    const orderBook: OrderBook | null = market?.orderBook || null;
    const candles15m: Candle[] = Array.isArray(market?.candles15m) ? market.candles15m : [];
    const candles4h: Candle[] = Array.isArray(market?.candles4h) ? market.candles4h : [];
    const livePrice = market?.currentPrice ? Number(market.currentPrice) : price;

    // Status fetch per sumber — diteruskan ke LLM (wajib konfirmasi di UI)
    // dan ke FE (banner + echo). LLM menerima daftar eksplisit mana yang OK
    // dan mana yang GAGAL agar tidak mengarang dari data yang tidak ada.
    const dataHealth: Array<{ source: string; ok: boolean; detail: string }> = [];
    const pushHealth = (source: string, ok: boolean, detail: string) => {
      dataHealth.push({ source, ok, detail });
    };
    pushHealth(
      "market",
      market != null,
      market != null
        ? `${marketSource} candles15m=${candles15m.length} candles4h=${candles4h.length} depth=${orderBook ? `${orderBook.bids?.length ?? 0}x${orderBook.asks?.length ?? 0}` : "null"}`
        : `GAGAL (${marketSource}) — harga pakai kiriman client $${price}`
    );

    let recentTrades: RecentTrade[] = [];
    let recentTradesSource = "NONE";
    try {
      const tr = await fetchRecentTrades(sym, 60);
      if (tr.success) {
        recentTrades = tr.trades;
        recentTradesSource = tr.source;
      }
    } catch (e: any) {
      console.warn(`[ai-advisor] recent trades fetch failed: ${e?.message}`);
    }
    pushHealth(
      "orderflow",
      recentTrades.length > 0,
      recentTrades.length > 0
        ? `${recentTradesSource} ${recentTrades.length} prints`
        : "GAGAL — flow NEUTRAL, keel fail-closed (HOLD jujur)"
    );

    let futures: FuturesMetrics = { success: false, source: "NONE" };
    try {
      futures = await fetchFuturesMetrics(sym);
    } catch (e: any) {
      console.warn(`[ai-advisor] futures metrics fetch failed: ${e?.message}`);
    }
    pushHealth(
      "futures",
      futures.success === true,
      futures.success === true
        ? `${futures.source} funding=${futures.fundingBps ?? "?"}bps OI=$${futures.openInterestUsd != null ? (Number(futures.openInterestUsd) / 1e9).toFixed(2) + "B" : "?"}`
        : "GAGAL — bias futures NEUTRAL"
    );

    // Macro real gratisan (server-side): FF mirror kalender + Stooq VIX.
    // Paralel dengan futures agar tidak menambah latency serial.
    let macroReal: Awaited<ReturnType<typeof fetchMacroReal>> | null = null;
    try {
      macroReal = await fetchMacroReal();
    } catch (e: any) {
      console.warn(`[ai-advisor] macro real fetch failed: ${e?.message}`);
    }
    const macroRealOk = !!macroReal?.ok;
    const macroRealRisk = macroRealOk && macroReal ? deriveMacroRiskIndex(macroReal) : 0;
    const macroRealNext = macroRealOk && macroReal ? macroReal.highImpactUpcoming[0] ?? null : null;
    pushHealth(
      "macro_real",
      macroRealOk,
      macroRealOk && macroReal
        ? `${macroReal.source} upcoming=${macroReal.highImpactUpcoming.length} vix=${macroReal.vix ?? "?"} risk=${macroRealRisk}`
        : "GAGAL — kalender+VIX tak tersedia, LLM pakai body client saja"
    );

    // Logging diagnostik: sumber data per pilar yang masuk ke LLM.
    console.log(
      `[ai-advisor-diag] symbol=${sym} market=${marketSource} ` +
      `candles15m=${candles15m.length} candles4h=${candles4h.length} ` +
      `orderBook=${orderBook ? `${orderBook.bids?.length ?? 0}x${orderBook.asks?.length ?? 0}` : "null"} ` +
      `recentTrades=${recentTrades.length}(${recentTradesSource}) ` +
      `futures=${futures.success ? futures.source : "NONE"} ` +
      `macroReal=${macroRealOk ? `${macroReal?.source} risk=${macroRealRisk}` : "NONE"} ` +
      `hasClientTechnicals=${!!(req.body && (req.body as any).technicals)} ` +
      `hasClientMtf=${!!(req.body && (req.body as any).mtfLiquidity)} ` +
      `hasOnChain=${!!body.onChainMetrics} hasMacro=${!!body.macroCalendar} ` +
      `gemini=${getGeminiClient() ? "on" : "off"}`
    );

    // Multi-TF klines server-side (1h untuk teknikal intraday; 15m/4h sudah dari
    // fetchMarketData). Paralel; gagal per-TF -> null jujur (bukan sintetis).
    // F-05: catat source per-TF agar cross-exchange (1h vs 15m/4h) terlihat.
    let candles1h: Candle[] = [];
    let klines1hSource = "NONE";
    try {
      const { fetchOHLCVWithFallback } = await import("@/src/data/marketFetcher");
      const h1 = await fetchOHLCVWithFallback(sym, "1h", 60);
      if (Array.isArray(h1.candles) && h1.candles.length > 0) {
        candles1h = h1.candles;
        klines1hSource = h1.source;
      }
    } catch (e: any) {
      console.warn(`[ai-advisor] 1h klines gagal: ${e?.message}`);
    }
    pushHealth(
      "klines_1h",
      candles1h.length >= 26,
      candles1h.length >= 26 ? `${klines1hSource} ${candles1h.length} candle` : "GAGAL — teknikal 1h kosong"
    );
    pushHealth(
      "klines_4h",
      candles4h.length >= 26,
      candles4h.length >= 26
        ? `${marketSource} ${candles4h.length} candle${klines1hSource !== "NONE" && klines1hSource !== marketSource ? ` (BEDA EXCHANGE vs 1h=${klines1hSource} — hati-hati baca divergensi)` : ""}`
        : "GAGAL — teknikal 4h kosong"
    );

    const multiTf = deriveMultiTfTechnicals({ "15m": candles15m, "1h": candles1h, "4h": candles4h });
    const multiTfLabel: Record<string, string> = { "15m": "scalping/eksekusi", "1h": "intraday/konfirmasi", "4h": "swing/arah utama" };
    pushHealth(
      "technicals_mtf",
      Object.values(multiTf).some((t) => t != null),
      Object.entries(multiTf)
        .map(([tf, t]) => (t ? `${tf}:RSI ${Number(t.rsi).toFixed(1)} ${t.trend}` : `${tf}:KOSONG`))
        .join(" | ")
    );

    let technicals = (req.body && req.body.technicals) || (candles15m.length > 0 ? deriveTechnicals(candles15m, orderBook) : undefined);
    pushHealth(
      "technicals",
      !!technicals,
      technicals ? "RSI/EMA/MACD/imbalance tersedia" : "GAGAL — tidak ada candle/orderbook untuk derivasi"
    );
    let mtfLiquidity = (req.body && req.body.mtfLiquidity) || undefined;
    if (!mtfLiquidity && candles15m.length > 0 && candles4h.length > 0) {
      mtfLiquidity = analyzeMTFLiquidity(candles15m, candles4h, livePrice, "SPOT", orderBook || { bids: [], asks: [], spread: 0 });
    }
    pushHealth(
      "mtf",
      !!mtfLiquidity,
      mtfLiquidity ? `state=${(mtfLiquidity as any).activeState ?? "?"}` : "GAGAL — struktur likuiditas tak tersedia"
    );
// Network anchors do not validate synthetic directional analytics.
    pushHealth("onchain", false, onChainDecisionContext(body.onChainMetrics));
    pushHealth(
      "macro",
      !!body.macroCalendar,
      body.macroCalendar
        ? Number((body.macroCalendar as any).macroRiskIndex) > 0
          ? "client-sent (ada event/risiko)"
          : "client-sent tapi no-data/fail-closed"
        : "GAGAL — macro tidak dikirim"
    );
    // P1-01: provenance harga diverifikasi server — klaim client (venus/ts
    // source) tidak ditelan; STALE/SIMULATED/UNKNOWN → row not-ok (wajib
    // diakui prompt) + entry gate di enforcement.
    // (Tambahan setelah pushHealth macro — lokasi tepat diverifikasi di lint.)
    pushHealth(
      "backtest",
      true,
      "DB replay_runs (bisa kosong — LLM wajib sebut bila tidak ada run)"
    );
    // P1-01: provenance harga diverifikasi SERVER — klaim client tidak ditelan
    // mentah; STALE/SIMULATED/UNKNOWN → row not-ok (wajib diakui prompt) + gate.
    const advisorPriceVerdict = marketPriceVerdictFromBody(req.body, startTime);
    const provBlocks =
      advisorPriceVerdict.kind === "STALE" ||
      advisorPriceVerdict.kind === "SIMULATED" ||
      advisorPriceVerdict.kind === "SYNTHETIC" ||
      advisorPriceVerdict.kind === "UNKNOWN";
    {
      const provRow = healthRowFromVerdict(advisorPriceVerdict, "provenance:market.price");
      pushHealth(provRow.source, provRow.ok, provRow.detail);
    }

    let keelDecision: any = null;
    let rawSignal: any = null;
    try {
      const result = runKeelQuantEngine({
        symbol: sym,
        currentPrice: livePrice,
        technicals,
        mtfLiquidity,
        orderBook: orderBook || undefined,
        recentTrades,
        futures,
      });
      keelDecision = result.decision;
      rawSignal = result.rawSignalResult;
    } catch (e: any) {
      console.warn(`[ai-advisor] keel engine failed: ${e?.message}`);
    }

    const fa: FuturesAnalysis | undefined = keelDecision?.futuresAnalysis;
    const mtf: MTFLiquidityAnalysis | undefined = mtfLiquidity;
    const liquidityDepthUsd =
      rawSignal && typeof rawSignal.liquidityDepthUsd === "number" ? rawSignal.liquidityDepthUsd : null;

    // Echo teknikal server-side (sebelumnya dihitung tapi TIDAK pernah masuk
    // prompt LLM maupun respons FE — LLM buta RSI/EMA/MACD/imbalance).
    const technicalsEcho = technicals
      ? {
          rsi: Number((technicals as any).rsi ?? NaN),
          ema20: Number((technicals as any).ema20 ?? NaN),
          ema50: Number((technicals as any).ema50 ?? NaN),
          macdHistogram: Number((technicals as any)?.macd?.histogram ?? NaN),
          orderBookImbalance: Number((technicals as any).orderBookImbalance ?? NaN),
          volatility: String((technicals as any).volatility ?? "UNKNOWN"),
        }
      : null;

    // Detail futures penuh (sebelumnya prompt hanya funding+bias — OI, LSR,
    // liq magnet, volume, biasReason hilang dari pertimbangan LLM).
    const futuresDetail = fa
      ? {
          fundingBps: fa.fundingBps ?? null,
          markPrice: fa.markPrice ?? null,
          openInterestUsd: fa.openInterestUsd ?? null,
          lsrTaker: fa.lsrTaker ?? null,
          lsrAccount: fa.lsrAccount ?? null,
          longLiqUsd: fa.longLiqUsd ?? null,
          shortLiqUsd: fa.shortLiqUsd ?? null,
          volume24hUsd: fa.volume24hUsd ?? null,
          biasReason: fa.biasReason ?? null,
          source: fa.source ?? null,
        }
      : null;

    // Macro real (FF mirror + VIX) untuk LLM + echo UI. macroEcho body client
    // tetap dipertahankan; macroReal jadi sumber utama bila ok.
    const macroRealEcho = macroRealOk && macroReal
      ? {
          source: macroReal.source,
          vix: macroReal.vix,
          riskIndex: macroRealRisk,
          upcomingCount: macroReal.highImpactUpcoming.length,
          upcoming: macroReal.highImpactUpcoming.slice(0, 4).map((e) => ({
            title: e.title,
            dateUtc: e.dateUtc,
            forecast: e.forecast,
            previous: e.previous,
          })),
          fetchedAt: macroReal.fetchedAt,
        }
      : null;

    // Echo on-chain/macro dari body FE (LLM sebelumnya hanya dapat 3 field
    // on-chain + 3 field makro — sisanya tak terlihat).
    // No verified analytics adapter: do not echo synthetic projections to the UI.
    const onChainEcho = null;
    const mc: any = body.macroCalendar;
    const macroEcho = mc
      ? {
          upcomingHighImpactCount: mc.upcomingHighImpactCount ?? null,
          macroTradingAdvice: mc.macroTradingAdvice ?? null,
          nearestEventImpact: mc.nearestEvent?.impact ?? null,
          nearestEventImplication: mc.nearestEvent?.implicationNotes ?? null,
        }
      : null;

    const keelSummary = {
      action: String(keelDecision?.action ?? "HOLD"),
      confidence: Number(keelDecision?.confidence ?? 50),
      flow: rawSignal?.smartMoneyFlow ?? "NEUTRAL",
      futuresBias: fa?.bias ?? "NEUTRAL",
      fundingBps: fa?.fundingBps ?? null,
      openInterestUsd: fa?.openInterestUsd ?? null,
      lsrTaker: fa?.lsrTaker ?? null,
      confluenceScore: rawSignal?.confluence?.score ?? keelDecision?.liquidityHuntAnalysis?.confluenceScore ?? null,
      liquidityDepthUsd,
      reasoning: String(keelDecision?.reasoning ?? "Tidak ada reasoning dari keel."),
      discardedReason: rawSignal?.discardedReason ?? null,
      mtfState: mtf
        ? {
            activeState: mtf.activeState,
            nearestBSL: mtf.nearestBSL ? { midPrice: mtf.nearestBSL.midPrice, estimatedVolumeUSD: mtf.nearestBSL.estimatedVolumeUSD } : null,
            nearestSSL: mtf.nearestSSL ? { midPrice: mtf.nearestSSL.midPrice, estimatedVolumeUSD: mtf.nearestSSL.estimatedVolumeUSD } : null,
            recentSweep: mtf.recentSweep
              ? { type: mtf.recentSweep.type, wickRejectionPercent: mtf.recentSweep.wickRejectionPercent, invalidationPrice: mtf.recentSweep.invalidationPrice }
              : null,
          }
        : null,
    };

    // ===== TAHAP 1 — Jev chip: keputusan terstruktur dari state yang SAMA
    // dengan prompt Gemini (keelSummary/dataHealth/multiTf/futures/macro/
    // onchain policy/backtest). Jev mati → jevDecision null → Gemini decide;
    // semua mati → keelSummary.
    let jevDecision: { action: "BUY" | "SELL" | "HOLD"; confidence: number; riskLevel: "LOW" | "MEDIUM" | "HIGH"; source: string } | null = null;
    {
      const jevState = buildJevState({
        symbol: sym,
        currentPrice: livePrice,
        keelSummary,
        dataHealth,
        multiTf,
        futuresDetail,
        macroEcho: macroRealEcho ?? macroEcho ?? null,
        onChainPolicy: onChainDecisionContext(body.onChainMetrics),
        backtestCtx: buildBacktestContextFor(sym),
      });
      const jevPrompt = jevStateToPrompt(jevState);
      for (const entry of jevProviderEntries()) {
        const provider = entry.id;
        if (entry.kind === "http" && !isProviderConfigured(entry.cfg as ProviderConfig)) {
          console.warn(`[ai-advisor] ${provider} tidak terkonfigurasi — lanjut.`);
          continue;
        }
        const modelSlug = entry.kind === "cli" ? (entry.cfg as OpencodeGatewayConfig).model : (entry.cfg as ProviderConfig).model;
        try {
          const res = await callJevProvider(entry, jevPrompt);
          if (!res.ok) {
            console.warn(`[ai-advisor] ${provider} gagal (${res.error ?? res.status}) — lanjut.`);
            continue;
          }
          const parsed = parseJevResponse(res.data);
          if (!parsed.ok || !parsed.parsed) {
            console.warn(`[ai-advisor] ${provider} output invalid — lanjut.`);
            continue;
          }
          jevDecision = { ...parsed.parsed, source: provider };
          console.log(`[ai-advisor] Jev decide: ${jevDecision.action} conf=${jevDecision.confidence} risk=${jevDecision.riskLevel} via ${provider} (${modelSlug})`);
          break;
        } catch (err: any) {
          console.warn(`[ai-advisor] ${provider} unexpected (tanpa throw): ${String(err?.message || err)}`);
          continue;
        }
      }
    }

    const client = getGeminiClient();

    if (client && keelDecision) {
      const backtestCtx = buildBacktestContextFor(sym);
      const failedSources = dataHealth.filter((d) => !d.ok).map((d) => d.source);
      const healthLines = dataHealth
        .map((d) => `- ${d.source}: ${d.ok ? "OK" : "GAGAL"} — ${d.detail}`)
        .join("\n");
      const prompt = `Anda adalah STRATEGIST & ANALYST QUANT SENIOR dari institusi elit (seperti Jane Street atau BlackRock Aladdin).
Peran Anda: memberikan INTELLIGENCE & REKOMENDASI STRATEGIS berdasarkan sintesis data mikro (Keel/MTF), on-chain, makroekonomi, DAN hasil backtest historis.

Aset: ${sym} | Harga saat ini: $${livePrice}

[STATUS DATA (WAJIB JADIKAN KONFIRMASI DI OUTPUT — JANGAN DIAM-DIAM ABAIKAN YANG GAGAL)]:
${healthLines}
ATURAN KONFIRMASI WAJIB:
- Setiap sumber berstatus GAGAL di atas HARUS Anda sebutkan eksplisit di "insight" (contoh: "orderflow gagal terfetch → flow NEUTRAL, bukan sinyal") dan di "dataGaps" pada JSON.
- DILARANG mengarang angka dari sumber yang GAGAL. Kalau futures GAGAL, tulis funding/OI/LSR sebagai tidak tersedia, jangan substitusi.
- Kalau SEMUA sumber mikro GAGAL, suggestedBias HARUS "NEUTRAL" + caveat menyebut degradasi data.

[DATA MIKRO & FLOW (KEEL ENGINE)]:
- Aksi: ${keelSummary.action} | Confidence: ${keelSummary.confidence}%
- Order flow (Smart Money): ${keelSummary.flow}
- Bias futures: ${keelSummary.futuresBias} | Funding: ${keelSummary.fundingBps != null ? keelSummary.fundingBps.toFixed(2) + " bps" : "N/A"}
- Confluence: ${keelSummary.confluenceScore ?? "N/A"}% | Liquidity: ${keelSummary.liquidityDepthUsd != null ? "$" + (keelSummary.liquidityDepthUsd / 1000).toFixed(0) + "k" : "N/A"}
- Reasoning: ${keelSummary.reasoning}
- Futures detail: mark ${futuresDetail?.markPrice != null ? "$" + Number(futuresDetail.markPrice).toLocaleString() : "N/A"} | LSR taker ${futuresDetail?.lsrTaker ?? "N/A"} (definisi Gate.io: rasio LONG/SHORT taker, >1 = banyak long, <1 = banyak short) / akun ${futuresDetail?.lsrAccount ?? "N/A"} | liq LONG $${futuresDetail?.longLiqUsd != null ? (Number(futuresDetail.longLiqUsd) / 1000).toFixed(0) + "k" : "N/A"} / SHORT $${futuresDetail?.shortLiqUsd != null ? (Number(futuresDetail.shortLiqUsd) / 1000).toFixed(0) + "k" : "N/A"} | vol24h $${futuresDetail?.volume24hUsd != null ? (Number(futuresDetail.volume24hUsd) / 1e6).toFixed(1) + "M" : "N/A"} | biasReason: ${futuresDetail?.biasReason || "N/A"} (sumber: ${futuresDetail?.source || "N/A"})

[TEKNIKAL MULTI-TF (RSI/EMA/MACD PER TIMEFRAME — WAJIB SEBUT TF TIAP ANALISIS)]:
${(["15m", "1h", "4h"] as const)
  .map((tf) => {
    const t = multiTf[tf];
    const role = multiTfLabel[tf];
    if (!t) return `- [${tf}] (${role}): KOSONG/GAGAL fetch — jangan analisis TF ini, sebut eksplisit di insight.`;
    return `- [${tf}] (${role}): RSI ${Number(t.rsi).toFixed(1)} | EMA20 ${Number(t.ema20).toLocaleString()} vs EMA50 ${Number(t.ema50).toLocaleString()} | MACD hist ${Number(t.macdHistogram) >= 0 ? "+" : ""}${Number(t.macdHistogram).toFixed(2)} | Tren TF: ${t.trend}`;
  })
  .join("\n")}
- Konfirmasi antar-TF: sebutkan apakah 15m/1h/4h SEARAH atau DIVERGEN, dan TF mana yang dominan untuk keputusan (4h = arah, 1h = konfirmasi, 15m = timing entry).

[MTF & LIQUIDITY STRUCTURE]:
- State: ${keelSummary.mtfState?.activeState || "N/A"}
- CATATAN CONFLUENCE (F-09): skor confluence keel berbasis 2 sumber independen — (1) konteks likuiditas untuk frame rendah (m15/h1 dari activeState) dan (2) bias teknikal flat untuk frame tinggi (h4/d1 dari RSI/EMA/MACD/orderbook yang sama). BUKAN 4 timeframe independen — jangan overstate keyakinan dari "konfirmasi 4 TF".
- BSL (Buy Side Liquidity): ${keelSummary.mtfState?.nearestBSL ? "$" + keelSummary.mtfState.nearestBSL.midPrice : "N/A"}
- SSL (Sell Side Liquidity): ${keelSummary.mtfState?.nearestSSL ? "$" + keelSummary.mtfState.nearestSSL.midPrice : "N/A"}
- Sweep: ${keelSummary.mtfState?.recentSweep ? keelSummary.mtfState.recentSweep.type + " (" + keelSummary.mtfState.recentSweep.wickRejectionPercent + "%)" : "None"}

${onChainDecisionContext(body.onChainMetrics)}

[MACRO CONTEXT]:
- Fed Stance: ${mc?.fedPolicyStance || "N/A"}
- Risk Index (client): ${mc?.macroRiskIndex ?? "N/A"}/100 (0 = mode no-data/fail-closed, BUKAN pasar aman)
${macroRealEcho ? `- REAL gratisan (${macroRealEcho.source}): VIX ${macroRealEcho.vix ?? "?"} | risk ${macroRealEcho.riskIndex}/100 | high-impact upcoming ${macroRealEcho.upcomingCount}` : "- Macro real GAGAL terfetch — pakai body client saja, turunkan bobot makro."}
${macroRealEcho?.upcoming?.map((e) => `  • ${e.title} @ ${e.dateUtc} (forecast ${e.forecast || "?"} vs prev ${e.previous || "?"})`).join("\n") || ""}
- High-impact upcoming (client): ${macroEcho?.upcomingHighImpactCount ?? "N/A"} | Nearest Event: ${mc?.nearestEvent ? mc.nearestEvent.name + " (" + mc.nearestEvent.relativeTime + ", impact " + (macroEcho?.nearestEventImpact || "?") + ")" : "None (tidak ada katalis terjadwal)"}
- Implikasi event: ${macroEcho?.nearestEventImplication || "N/A"}
- Panduan makro: ${macroEcho?.macroTradingAdvice || "N/A"}

[BACKTEST CONTEXT (HASIL REPLAY HISTORIS — kalibrasi keyakinan)]:
${backtestCtx}

${jevDecision
  ? `[JEV DECISION (System One — keputusan terstruktur; WAJIB jadi dasar arah)]:
- Arah: ${jevDecision.action} | Confidence: ${jevDecision.confidence}% | riskLevel: ${jevDecision.riskLevel} (source: ${jevDecision.source})
- ATURAN: insight HARUS konsisten dengan arah Jev. JANGAN membalik arah Jev kecuali ada konflik data yang sangat jelas — jika ada konflik, sebutkan eksplisit di insight/caveat tetapi tetap IKUTI arah Jev.`
  : `[JEV DECISION]: tidak tersedia (provider Jev mati/tidak dikonfigurasi) — arah decision FINAL diambil dari keel engine (deterministik); suggestedBias Anda dipakai sebagai INSIGHT NARATIF, bukan penentu arah.`}

TUGAS ANDA:
1. Analisis SINTESIS: Hubungkan data mikro (Keel) dengan konteks besar (Makro/On-chain). Mengapa harga bergerak seperti ini?
2. Berikan "Professional Insight" (3-6 kalimat Bahasa Indonesia tajam, tanpa basa-basi).
3. Tentukan suggestedBias secara TEGAS: LONG atau SHORT jika ada sinyal minimal 60% confluence. Gunakan NEUTRAL hanya jika market benar-benar dead-flat atau data sangat kontradiktif (conflict of interest).
4. Berikan level Entry, SL, dan TP yang presisi secara matematis berdasarkan likuiditas (BSL/SSL).
5. KALIBRASI dengan BACKTEST CONTEXT di atas: citakan secara eksplisit (misal "backtest terakhir simbol ini 55% win / PF 1.3 / MaxDD 6% → keyakinan cukup, bukan tinggi"). Jika PF < 1 atau MaxDD besar → turunkan keyakinan & tandai risiko.
6. KONSISTENSI ANGKA WAJIB: setiap angka yang Anda sebut (LSR, SOPR, MVRV, whale inflow) HARUS cocok dengan nilai di blok data di atas — DILARANG membalik arti (LSR<1 = banyak SHORT, bukan long; SOPR>1 = profit-taking, bukan akumulasi).
7. SAMPEL KECIL: bila backtest hanya 1-2 trade (n kecil), nyatakan eksplisit "tidak signifikan statistik" — JANGAN klaim edge dari n=1.

Jawab HANYA JSON valid tanpa markdown:
{
  "insight": "analisis tajam ala Jane Street (WAJIB sebut sumber GAGAL: ${failedSources.length > 0 ? failedSources.join(", ") : "tidak ada — semua sumber OK"})",
  "suggestedBias": "LONG" | "SHORT" | "NEUTRAL" | "BULLISH" | "BEARISH",
  "keyLevels": { "entry": number, "stopLoss": number, "takeProfit": number },
  "risks": ["string", "string"],
  "caveat": "disclaimer singkat (WAJIB sebut degradasi data bila ada GAGAL)",
  "dataGaps": ["daftar sumber GAGAL dari STATUS DATA, atau [] bila semua OK"]
}`;

      const advisorSchema = z.object({
        insight: z.string().min(5),
        suggestedBias: z.enum(["LONG", "SHORT", "NEUTRAL", "BULLISH", "BEARISH"]).optional(),
        keyLevels: z
          .object({
            entry: z.number().nullable().optional(),
            stopLoss: z.number().nullable().optional(),
            takeProfit: z.number().nullable().optional(),
          })
          .optional(),
        risks: z.array(z.string()).max(3).optional(),
        caveat: z.string().optional(),
        // Konfirmasi LLM atas sumber yang gagal terfetch (wajib diisi bila ada GAGAL).
        dataGaps: z.array(z.string()).max(10).optional(),
      });

      const candidateModels = ["gemini-3.8-flash", "gemini-3.7-flash"];
      let responseText = "";
      let usedModel = "";
      let lastErr: any = null;
      for (const model of candidateModels) {
        try {
          const aiResponse = await client.models.generateContent({
            model,
            contents: prompt,
            config: { responseMimeType: "application/json", temperature: 0.3 },
          });
          if (aiResponse && aiResponse.text) {
            responseText = aiResponse.text;
            usedModel = model;
            break;
          }
          lastErr = new Error(`model ${model} returned empty response`);
        } catch (modelErr: any) {
          lastErr = modelErr;
          const msg = String(modelErr?.message || "");
          const status = (modelErr as any)?.status;
          // JANGAN pernah throw dari sini — throw lolos dari route handler async
          // (Express 4) dan membunuh seluruh proses server (crash yang terlihat
          // sebagai ERR_CONNECTION_REFUSED massal di FE). Catat + coba model
          // berikutnya, lalu fallback ke respons keel-only di bawah.
          if (/INVALID_MODEL|not found|does not exist|404/i.test(msg)) {
            console.warn(`Gemini advisor model ${model} tidak valid, coba fallback...`);
            continue;
          }
          if (status === 503 || status === 429 || /503|429|UNAVAILABLE|overloaded|high demand|timeout|fetch failed|ECONN|ETIMEDOUT/i.test(msg)) {
            console.warn(`Gemini advisor model ${model} sibuk/transien (${status ?? msg.slice(0, 120)}), coba model berikutnya...`);
            continue;
          }
          console.warn(`Gemini advisor model ${model} error, fallback ke keel: ${msg.slice(0, 160)}`);
          break;
        }
      }

      if (responseText) {
        try {
          const parsed = JSON.parse(responseText);
          const validation = advisorSchema.safeParse(parsed);
          if (validation.success) {
            const ai = validation.data;
            // Fail-closed: LLM yang mengklaim semua OK padahal ada sumber GAGAL
            // ditolak — paksa LLM konfirmasi degradasi data di UI.
            const llmGaps = Array.isArray(ai.dataGaps) ? ai.dataGaps.map((g) => String(g).toLowerCase()) : [];
            const unacked = failedSources.filter(
              (s) => !llmGaps.some((g) => g.includes(String(s).toLowerCase()))
            );
            const insightMentionsGaps =
              failedSources.length === 0 ||
              failedSources.every((s) =>
                String(ai.insight || "").toLowerCase().includes(String(s).toLowerCase())
              );
            if (unacked.length > 0 || !insightMentionsGaps) {
              console.warn(
                `[ai-advisor] LLM output ditolak: tidak konfirmasi data GAGAL [${failedSources.join(", ")}] di insight/dataGaps.`
              );
            } else {
              // Enforcement arah: Jev decide → Gemini insight wajib tidak
              // membalik arah. Konflik eksplisit tetap dicatat di caveat.
              let suggestedBias = ai.suggestedBias;
              let caveat = ai.caveat || "";
              if (jevDecision && jevDecision.action !== "HOLD") {
                const want = jevDecision.action === "BUY" ? ["LONG", "BULLISH"] : ["SHORT", "BEARISH"];
                const aligned = suggestedBias != null && want.includes(String(suggestedBias).toUpperCase());
                if (!aligned) {
                  const before = suggestedBias ?? "?";
                  suggestedBias = jevDecision.action === "BUY" ? "LONG" : "SHORT";
                  caveat = `${caveat} [JEV override] Gemini bias "${before}" berbeda dari Jev ${jevDecision.action} — arah mengikuti Jev (risk gate).`.trim();
                }
              }
              // P1-01: ENTRY policy — harga dinyatakan palsu/basi/simulasi →
              // suspend arah apa pun (gate menang atas override Jev). EXIT tidak diblokir.
              if (provBlocks) {
                suggestedBias = "NEUTRAL";
                caveat = `${caveat} [PROVENANCE GATE] harga dinyatakan ${advisorPriceVerdict.kind} — ENTRY ditahan, EXIT risiko tidak diblokir.`.trim();
              }
              // FIX-A (audit 2026-09-21): Jev mati → arah decision dari KEEL
              // (data mateng, deterministik), BUKAN dari suggestedBias naratif
              // Gemini. Confidence & riskLevel ikut keel; riskLevel diturunkan
              // deterministik dari confidence keel (>=75 LOW, >=50 MEDIUM,
              // selainnya HIGH). Bias Gemini tetap tampil sebagai insight
              // (ai.suggestedBias); kalau berlawanan dengan arah keel →
              // dicatat di caveat, bukan dipakai sebagai arah.
              const keelConfidence = Number(keelSummary.confidence ?? 0);
              const keelRawAction = String(keelSummary.action || "HOLD");
              const keelFallbackDecision = {
                action:
                  keelRawAction === "BUY" || keelRawAction === "LONG"
                    ? ("BUY" as const)
                    : keelRawAction === "SELL" || keelRawAction === "SHORT"
                      ? ("SELL" as const)
                      : ("HOLD" as const),
                confidence: keelConfidence,
                riskLevel: (keelConfidence >= 75 ? "LOW" : keelConfidence >= 50 ? "MEDIUM" : "HIGH") as "LOW" | "MEDIUM" | "HIGH",
                source: "keel",
              };
              if (!jevDecision) {
                const biasDir =
                  suggestedBias === "LONG" || suggestedBias === "BULLISH"
                    ? "BUY"
                    : suggestedBias === "SHORT" || suggestedBias === "BEARISH"
                      ? "SELL"
                      : "HOLD";
                const conflict = biasDir !== "HOLD" && biasDir !== keelFallbackDecision.action;
                caveat = `${caveat} [KEEL FALLBACK] Jev tidak tersedia — arah decision dari keel (${keelFallbackDecision.action}); suggestedBias Gemini hanya insight naratif${conflict ? ` (konflik: bias ${biasDir} vs keel ${keelFallbackDecision.action})` : ""}.`.trim();
              }
              // P1-01: rekomendasi TERAKHIR di-gate — saat harga dinyatakan
              // palsu/basi, decision.action = HOLD (jevDecision row tetap
              // mencatat output mentah untuk analisis; rekomendasi = HOLD).
              const rawDecision = jevDecision
                ? { action: jevDecision.action, confidence: jevDecision.confidence, riskLevel: jevDecision.riskLevel, source: jevDecision.source }
                : keelFallbackDecision;
              const finalDecisionBlock = provBlocks
                ? {
                    action: "HOLD" as const,
                    confidence: rawDecision.confidence,
                    riskLevel: rawDecision.riskLevel,
                    source: rawDecision.source,
                  }
                : rawDecision;
              return res.json({
                success: true,
                mode: "ai",
                geminiConfigured: true,
                model: usedModel,
                timestamp: Date.now(),
                decision: finalDecisionBlock,
                decisionSource: jevDecision ? jevDecision.source : "keel",
                jevDecision: jevDecision ?? null,
                provenanceGate: provBlocks ? { kind: advisorPriceVerdict.kind, note: advisorPriceVerdict.note } : null,
                keelSummary,
                technicals: technicalsEcho,
                multiTfTechnicals: multiTf,
                futuresDetail,
                onChainEcho,
                macroEcho,
                macroReal: macroRealEcho,
                dataHealth,
                backtest: { symbol: sym, context: backtestCtx },
                ai: {
                  insight: ai.insight,
                  suggestedBias,
                  keyLevels: ai.keyLevels,
                  risks: ai.risks || [],
                  caveat,
                  dataGaps: ai.dataGaps || [],
                },
                latencyMs: Date.now() - startTime,
              });
            }
          }
          console.warn(`[ai-advisor] Gemini output gagal validasi: ${validation.error.message}`);
        } catch (parseErr: any) {
          console.warn(`[ai-advisor] Gemini output tidak valid JSON: ${parseErr?.message}`);
        }
      } else if (lastErr) {
        console.warn(`[ai-advisor] Gemini gagal: ${lastErr?.message}`);
      }
    }

    // Keel-only: rangkai insight dari SEMUA sumber yang ada (bukan cuma
    // flow+bias seperti sebelumnya — teknikal/futures/on-chain/macro ikut
    // dirangkum agar FE tetap informatif tanpa Gemini).
    const connFlow = String(keelSummary.flow || "NEUTRAL");
    const bias = String(keelSummary.futuresBias || "NEUTRAL");
    const techBits: string[] = [];
    if (technicalsEcho && isFinite(technicalsEcho.rsi)) techBits.push(`RSI ${technicalsEcho.rsi.toFixed(1)}`);
    if (technicalsEcho && isFinite(technicalsEcho.ema20) && isFinite(technicalsEcho.ema50)) {
      techBits.push(technicalsEcho.ema20 > technicalsEcho.ema50 ? "EMA20>EMA50 (uptrend)" : "EMA20<EMA50 (downtrend)");
    }
    if (technicalsEcho && isFinite(technicalsEcho.macdHistogram)) {
      techBits.push(`MACD hist ${technicalsEcho.macdHistogram >= 0 ? "+" : ""}${technicalsEcho.macdHistogram.toFixed(2)}`);
    }
    if (technicalsEcho && isFinite(technicalsEcho.orderBookImbalance)) {
      techBits.push(`OB imbalance ${technicalsEcho.orderBookImbalance.toFixed(2)}`);
    }
    const futBits: string[] = [];
    if (futuresDetail?.fundingBps != null) futBits.push(`funding ${Number(futuresDetail.fundingBps).toFixed(2)}bps`);
    if (futuresDetail?.lsrTaker != null) futBits.push(`LSR ${Number(futuresDetail.lsrTaker).toFixed(2)}`);
    if (futuresDetail?.openInterestUsd != null) {
      const oi = Number(futuresDetail.openInterestUsd);
      futBits.push(`OI ${oi >= 1e9 ? "$" + (oi / 1e9).toFixed(2) + "B" : "$" + (oi / 1e6).toFixed(1) + "M"}`);
    }
    if (futuresDetail?.biasReason) futBits.push(futuresDetail.biasReason);
    // Same policy for non-LLM fallback: anchors do not validate analytics.
    const mcNote =
      mc && mc.macroRiskIndex > 0
        ? `Makro: ${mc.fedPolicyStance || "?"} risk ${mc.macroRiskIndex}/100.`
        : "Makro: no-data (fail-closed, jangan anggap aman).";
    const base =
      keelSummary.action === "HOLD"
        ? `Keel HOLD — flow ${connFlow}, bias futures ${bias}. ${keelSummary.discardedReason || "Belum ada konvergensi institusional."}`
        : `Keel ${keelSummary.action} conf ${keelSummary.confidence}% — flow ${connFlow}, bias futures ${bias}.`;
    const insightKeel =
      `${base}` +
      (techBits.length > 0 ? ` Teknikal: ${techBits.join(", ")}.` : "") +
      (futBits.length > 0 ? ` Futures: ${futBits.join("; ")}.` : "") +
      " On-chain: analitik belum terverifikasi (termasuk proyeksi real-anchored) — diabaikan." +
      ` ${mcNote} Eksekusi TETAP keputusan Anda — periksa level SL/TP sebelum bertindak.` +
      (provBlocks
        ? ` [PROVENANCE GATE] harga dinyatakan ${advisorPriceVerdict.kind} — ENTRY ditahan, EXIT risiko tidak diblokir.`
        : "");

    return res.json({
      success: true,
      mode: "keel",
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"),
      aiDisabledReason:
        probeGeminiKey(process.env.GEMINI_API_KEY) === "none"
          ? "KEY_MISSING"
          : probeGeminiKey(process.env.GEMINI_API_KEY) === "legacy-revoked"
            ? "KEY_LEGACY_REVOKED"
            : "AI_CALL_FAILED",
      timestamp: Date.now(),
      decision: {
        action: provBlocks ? "HOLD" : keelSummary.action === "BUY" ? "BUY" : keelSummary.action === "SELL" ? "SELL" : "HOLD",
        confidence: Number(keelSummary.confidence ?? 50),
        // FIX-A: riskLevel diturunkan deterministik dari confidence keel
        // (>=75 LOW, >=50 MEDIUM, selainnya HIGH) — bukan hardcode MEDIUM.
        riskLevel: (Number(keelSummary.confidence ?? 50) >= 75 ? "LOW" : Number(keelSummary.confidence ?? 50) >= 50 ? "MEDIUM" : "HIGH") as "LOW" | "MEDIUM" | "HIGH",
        source: "keel",
      },
      decisionSource: "keel",
      jevDecision: jevDecision ?? null,
      keelSummary,
      technicals: technicalsEcho,
      multiTfTechnicals: multiTf,
      futuresDetail,
      onChainEcho,
      macroEcho,
      macroReal: macroRealEcho,
      dataHealth,
      backtest: { symbol: sym, context: buildBacktestContextFor(sym) },
      ai: {
        insight: `${(() => {
          const ks = probeGeminiKey(process.env.GEMINI_API_KEY);
          if (ks === "none") return "Mode AI nonaktif (GEMINI_API_KEY belum di-set). Berikut ringkasan data keel: ";
          if (ks === "legacy-revoked") return "Mode AI nonaktif (key AIza lama dicabut Google — ganti key baru format AQ.x). Berikut ringkasan data keel: ";
          return "Mode AI gagal dihubungi (transien/overload) — berikut ringkasan data keel sementara: ";
        })()}${insightKeel}`,
        suggestedBias: keelSummary.action === "BUY" ? "BULLISH" : keelSummary.action === "SELL" ? "BEARISH" : "NEUTRAL",
        risks: [],
      },
      latencyMs: Date.now() - startTime,
    });
  });
}
