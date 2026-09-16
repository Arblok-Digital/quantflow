import type { Express } from "express";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { requireAuth } from "@/auth";
import { appendAudit, saveAgentDecisionDb, listReplayRunsDb } from "@/db";
import { getPaperAccount } from "@/paperBook";
import { runKeelQuantEngine, evaluateKeelRisk, type FuturesAnalysis } from "@/src/logic/keelAdapter";
import { analyzeMTFLiquidity } from "@/src/logic/liquidityHunt";
import { fetchMarketData, fetchRecentTrades, fetchFuturesMetrics, fetchMacroReal, deriveMacroRiskIndex, type RecentTrade, type FuturesMetrics } from "@/src/data/marketFetcher";
import { calculateRSI, calculateEMA, calculateMACD } from "@/src/logic/indicators";
import type { Candle, OrderBook, MTFLiquidityAnalysis, OnChainMetrics, MacroSummary } from "@/src/types";

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
- Status Liquidity Hunt: ${mtfLiquidity?.activeState || "EQUILIBRIUM"}
- Confluence Score: ${mtfLiquidity?.confluenceScore ?? 75}% (${mtfLiquidity?.confluenceSummary || "Neutral"})
- Upper BSL Pool (Short Stops): $${mtfLiquidity?.nearestBSL?.midPrice ?? "N/A"} (est. $${mtfLiquidity?.nearestBSL?.estimatedVolumeUSD ?? "14"}M Liq)
- Lower SSL Pool (Long Stops): $${mtfLiquidity?.nearestSSL?.midPrice ?? "N/A"} (est. $${mtfLiquidity?.nearestSSL?.estimatedVolumeUSD ?? "18"}M Liq)
- Recent Sweep: ${mtfLiquidity?.recentSweep ? `${mtfLiquidity.recentSweep.type} dengan ${mtfLiquidity.recentSweep.wickRejectionPercent}% wick absorption. Invalidation: $${mtfLiquidity.recentSweep.invalidationPrice}` : "Belum ada sweep terbaru"}

Analisa On-Chain (Smart Money & Whale Dynamics):
- Netflow Bursa 24 Jam: ${onChainMetrics?.exchangeNetflow24hUSD != null ? (onChainMetrics.exchangeNetflow24hUSD > 0 ? `+$${onChainMetrics.exchangeNetflow24hUSD}M (Net Inflow / Potensi Jual)` : `-$${Math.abs(onChainMetrics.exchangeNetflow24hUSD)}M (Net Outflow / Akumulasi Whale ke Cold Storage)`) : "No data"}
- Status Netflow: ${onChainMetrics?.netflowStatus || "No data"}
- Smart Money Bias: ${onChainMetrics?.smartMoneyBias || "No data"} (Confidence: ${onChainMetrics?.onChainConfidence != null ? `${onChainMetrics.onChainConfidence}%` : "No data"})
- MVRV Z-Score: ${onChainMetrics?.mvrvZScore != null ? `${onChainMetrics.mvrvZScore} (${onChainMetrics.mvrvTerritory || "unknown"})` : "No data"}
- SOPR: ${onChainMetrics?.sopr != null ? `${onChainMetrics.sopr} (${onChainMetrics.soprStatus || "unknown"})` : "No data"}
- Whale Alerts: ${onChainMetrics?.whaleAlerts?.[0] ? `${onChainMetrics.whaleAlerts[0].type} $${(onChainMetrics.whaleAlerts[0].usdValue / 1e6).toFixed(1)}M (${onChainMetrics.whaleAlerts[0].from} -> ${onChainMetrics.whaleAlerts[0].to})` : "No whale alert data"}

Kalender Makroekonomi (Macro Knowledge & Catalysts):
- Sikap Moneter The Fed: ${macroCalendar?.fedPolicyStance || "No data"}
- Indeks Risiko Makro: ${macroCalendar?.macroRiskIndex != null ? `${macroCalendar.macroRiskIndex}/100` : "No data"}
- Event Terdekat: ${macroCalendar?.nearestEvent ? `${macroCalendar.nearestEvent.name} (${macroCalendar.nearestEvent.relativeTime}) - Impact: ${macroCalendar.nearestEvent.impact}. Implikasi: ${macroCalendar.nearestEvent.implicationNotes}` : "No macro event data"}
- Panduan Risiko Makro: ${macroCalendar?.macroTradingAdvice || "No data"}

Indikator Teknikal Pendukung:
- RSI (14): ${technicals?.rsi ?? 50}
- EMA (20): $${technicals?.ema20 ?? currentPrice} | EMA (50): $${technicals?.ema50 ?? currentPrice}
- Order Book Imbalance: ${technicals?.orderBookImbalance?.toFixed(2) ?? "1.0"}

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

        const decisionSchema = z.object({
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
            // Semua model gagal (termasuk transien): jangan throw — biarkan
            // jatuh ke fallback keel di bawah (503 JSON informatif).
            console.warn(`Gemini decision semua model gagal: ${String(lastErr?.message || lastErr).slice(0, 160)}`);
          }
        }

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
        const currentP = Number(currentPrice) || 0;
        const isBadOrder =
          (parsedDecision2.action === "BUY" &&
            !(parsedDecision2.stopLoss < currentP && currentP < parsedDecision2.takeProfit)) ||
          (parsedDecision2.action === "SELL" &&
            !(parsedDecision2.takeProfit < currentP && currentP < parsedDecision2.stopLoss));
        if (parsedDecision2.action !== "HOLD" && isBadOrder) {
          const inferenceLatency = Date.now() - startTime;
          try {
            appendAudit("decision", {
              symbol: String(symbol || "BTC/USDT"),
              action: parsedDecision2.action,
              latencyMs: inferenceLatency,
              modelId: usedModel,
              reason: "invalid-price-order",
              details: {
                currentPrice: currentP,
                stopLoss: parsedDecision2.stopLoss,
                takeProfit: parsedDecision2.takeProfit,
              },
            });
          } catch {}
          return res.status(502).json({
            success: false,
            source: "fallback-validation-failed",
            reason: "invalid-price-order",
            message:
              parsedDecision2.action === "BUY"
                ? "Order BUY tidak valid: harus stopLoss < harga sekarang < takeProfit."
                : "Order SELL tidak valid: harus takeProfit < harga sekarang < stopLoss.",
          });
        }

        const maxRisk = Number(riskParams?.maxRiskPerTradePercent) || 0;
        const positionSizePercent =
          maxRisk > 0 && parsedDecision2.positionSizePercent > maxRisk
            ? maxRisk
            : parsedDecision2.positionSizePercent;

        const inferenceLatency = Date.now() - startTime;
        const provenance = (req.body && req.body.provenance) || null;

        try {
          const decisionId = `dec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const promptSummary = prompt.slice(0, 800);
          const responseStr = JSON.stringify(parsedDecision2).slice(0, 2000);
          const sourceTags =
            JSON.stringify({
              model: usedModel,
              provenance,
              clampedPositionSize: positionSizePercent !== parsedDecision2.positionSizePercent,
            }) || null;
          saveAgentDecisionDb({
            id: decisionId,
            created_at: Date.now(),
            symbol: String(symbol || "BTC/USDT"),
            action: parsedDecision2.action,
            confidence: parsedDecision2.confidence,
            model_id: usedModel,
            latency_ms: inferenceLatency,
            prompt: promptSummary,
            response: responseStr,
            source_tags: sourceTags,
          });
          appendAudit("decision", {
            decisionId,
            symbol: String(symbol || "BTC/USDT"),
            action: parsedDecision2.action,
            confidence: parsedDecision2.confidence,
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
          ...parsedDecision2,
          positionSizePercent,
          source: usedModel,
          inferenceLatencyMs: inferenceLatency,
          provenance,
          promptSummary,
        });
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
    // F-01: gate on-chain cek PROVENANCE (realData), bukan sekadar presence.
    // Tanpa anchor blockchain.com, metrik on-chain = simulasi murni (baseline
    // + noise di logic/onchain.ts) → ok:false agar otomatis masuk failedSources
    // dan wajib diakui LLM sama seperti sumber GAGAL lain.
    const onChainHasRealAnchor = !!((body.onChainMetrics as any)?.realData);
    pushHealth(
      "onchain",
      onChainHasRealAnchor,
      body.onChainMetrics
        ? onChainHasRealAnchor
          ? "client-sent + REAL anchor blockchain.com"
          : "SIMULASI MURNI (tanpa anchor real) — bukan data real, bobot on-chain harus NOL"
        : "GAGAL/tidak dikirim — bobot on-chain harus diturunkan"
    );
    pushHealth(
      "macro",
      !!body.macroCalendar,
      body.macroCalendar
        ? Number((body.macroCalendar as any).macroRiskIndex) > 0
          ? "client-sent (ada event/risiko)"
          : "client-sent tapi no-data/fail-closed"
        : "GAGAL/tidak dikirim — jangan anggap pasar aman"
    );
    pushHealth(
      "backtest",
      true,
      "DB replay_runs (bisa kosong — LLM wajib sebut bila tidak ada run)"
    );

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
    const oc: any = body.onChainMetrics;
    const mc: any = body.macroCalendar;
    const onChainEcho = oc
      ? {
          netflowStatus: oc.netflowStatus ?? null,
          smartMoneyBias: oc.smartMoneyBias ?? null,
          onChainConfidence: oc.onChainConfidence ?? null,
          sopr: oc.sopr ?? null,
          soprStatus: oc.soprStatus ?? null,
          activeAddressesGrowth24h: oc.activeAddressesGrowth24h ?? null,
          // F-01: flag provenance agar konsumen (keel-only insight/FE) bisa
          // bedakan anchor real vs simulasi murni tanpa menebak dari teks.
          hasRealAnchor: !!oc.realData,
        }
      : null;
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

[ON-CHAIN METRICS]:
- Netflow: ${oc?.exchangeNetflow24hUSD != null ? oc.exchangeNetflow24hUSD : "N/A"} (${onChainEcho?.netflowStatus || "N/A"})
- Smart money: ${onChainEcho?.smartMoneyBias || "N/A"} (confidence ${onChainEcho?.onChainConfidence ?? "N/A"}%)
- MVRV Z-score: ${oc?.mvrvZScore ?? "N/A"} (${oc?.mvrvTerritory || "N/A"})
- SOPR: ${onChainEcho?.sopr ?? "N/A"} (${onChainEcho?.soprStatus || "N/A"})
- Active addr growth 24h: ${onChainEcho?.activeAddressesGrowth24h ?? "N/A"}%
- Whale Move: ${oc?.whaleAlerts?.[0] ? oc.whaleAlerts[0].type + " $" + (oc.whaleAlerts[0].usdValue / 1e6).toFixed(1) + "M" : "None"}
${oc?.realData ? `- REAL anchor blockchain.com: block ${oc.realData.blockHeight}, tx24h ${oc.realData.txCount24h}, mempool ${oc.realData.mempoolSizeMB}MB, hashrate ${oc.realData.hashrateEH}EH (fetched ${new Date(oc.realData.fetchedAt).toISOString()})` : "- Tanpa anchor real blockchain.com (simulasi murni) — turunkan bobot on-chain dalam sintesis."}

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
              return res.json({
                success: true,
                mode: "ai",
                geminiConfigured: true,
                model: usedModel,
                timestamp: Date.now(),
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
                  suggestedBias: ai.suggestedBias,
                  keyLevels: ai.keyLevels,
                  risks: ai.risks || [],
                  caveat: ai.caveat || "",
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
    const ocBits: string[] = [];
    // F-01: insight keel-only TIDAK boleh menyajikan metrik simulasi murni
    // seolah fakta — beri label eksplisit, atau drop bila tanpa anchor real.
    if (onChainEcho?.hasRealAnchor) {
      if (onChainEcho?.smartMoneyBias) ocBits.push(`smart money ${onChainEcho.smartMoneyBias}`);
      if (onChainEcho?.sopr != null) ocBits.push(`SOPR ${onChainEcho.sopr} (${onChainEcho.soprStatus || "?"})`);
    }
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
      (ocBits.length > 0 ? ` On-chain: ${ocBits.join(", ")}.` : " On-chain: no-data/simulasi (tanpa anchor real — diabaikan).") +
      ` ${mcNote} Eksekusi TETAP keputusan Anda — periksa level SL/TP sebelum bertindak.`;

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
