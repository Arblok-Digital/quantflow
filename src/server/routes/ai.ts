import type { Express } from "express";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { requireAuth } from "@/auth";
import { appendAudit, saveAgentDecisionDb, listReplayRunsDb } from "@/db";
import { getPaperAccount } from "@/paperBook";
import { runKeelQuantEngine, evaluateKeelRisk, type FuturesAnalysis } from "@/src/logic/keelAdapter";
import { analyzeMTFLiquidity } from "@/src/logic/liquidityHunt";
import { fetchMarketData, fetchRecentTrades, fetchFuturesMetrics, type RecentTrade, type FuturesMetrics } from "@/src/data/marketFetcher";
import { calculateRSI, calculateEMA, calculateMACD } from "@/src/logic/indicators";
import type { Candle, OrderBook, MTFLiquidityAnalysis, OnChainMetrics, MacroSummary } from "@/src/types";

// Lazy Gemini client (singleton)
let genAI: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
    return null;
  }
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey });
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

        const candidateModels = ["gemini-3-flash-preview", "gemini-3.5-flash-lite"];
        let responseText: string = "{}";
        let usedModel = "gemini-3-flash-preview";
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
            if (/INVALID_MODEL|not found|does not exist|404/i.test(msg)) {
              console.warn(`Gemini model ${model} tidak valid, coba fallback...`);
              continue;
            }
            throw modelErr;
          }
        }
        if (!responseText || /^\s*\{?\s*\}$/.test(responseText.trim())) {
          responseText = "{}";
          if (lastErr) {
            throw lastErr;
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
  // Fail-closed jujur: tanpa GEMINI_API_KEY → mode "keel" dengan insight
  // deterministik dari data keel. Tidak pernah fabricate data pasar.
  // ========================================================================

  interface AiAdvisorBody {
    symbol?: string;
    currentPrice?: number;
    onChainMetrics?: OnChainMetrics | null;
    macroCalendar?: MacroSummary | null;
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

  app.post("/api/ai-advisor", requireAuth, async (req, res) => {
    const startTime = Date.now();
    const body: AiAdvisorBody = req.body || {};
    const sym = String(body.symbol || "BTC/USDT");
    const price = Number(body.currentPrice) || 64250;

    let market: any = null;
    try {
      const m = await fetchMarketData(sym);
      if (m && m.success !== false) market = m;
    } catch (e: any) {
      console.warn(`[ai-advisor] market fetch failed: ${e?.message}`);
    }

    const orderBook: OrderBook | null = market?.orderBook || null;
    const candles15m: Candle[] = Array.isArray(market?.candles15m) ? market.candles15m : [];
    const candles4h: Candle[] = Array.isArray(market?.candles4h) ? market.candles4h : [];
    const livePrice = market?.currentPrice ? Number(market.currentPrice) : price;

    let recentTrades: RecentTrade[] = [];
    try {
      const tr = await fetchRecentTrades(sym, 60);
      if (tr.success) recentTrades = tr.trades;
    } catch (e: any) {
      console.warn(`[ai-advisor] recent trades fetch failed: ${e?.message}`);
    }

    let futures: FuturesMetrics = { success: false, source: "NONE" };
    try {
      futures = await fetchFuturesMetrics(sym);
    } catch (e: any) {
      console.warn(`[ai-advisor] futures metrics fetch failed: ${e?.message}`);
    }

    let technicals = (req.body && req.body.technicals) || (candles15m.length > 0 ? deriveTechnicals(candles15m, orderBook) : undefined);
    let mtfLiquidity = (req.body && req.body.mtfLiquidity) || undefined;
    if (!mtfLiquidity && candles15m.length > 0 && candles4h.length > 0) {
      mtfLiquidity = analyzeMTFLiquidity(candles15m, candles4h, livePrice, "SPOT", orderBook || { bids: [], asks: [], spread: 0 });
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
      const oc = body.onChainMetrics;
      const mc = body.macroCalendar;
      const backtestCtx = buildBacktestContextFor(sym);
      const prompt = `Anda adalah STRATEGIST & ANALYST QUANT SENIOR dari institusi elit (seperti Jane Street atau BlackRock Aladdin).
Peran Anda: memberikan INTELLIGENCE & REKOMENDASI STRATEGIS berdasarkan sintesis data mikro (Keel/MTF), on-chain, makroekonomi, DAN hasil backtest historis.

Aset: ${sym} | Harga saat ini: $${livePrice}

[DATA MIKRO & FLOW (KEEL ENGINE)]:
- Aksi: ${keelSummary.action} | Confidence: ${keelSummary.confidence}%
- Order flow (Smart Money): ${keelSummary.flow}
- Bias futures: ${keelSummary.futuresBias} | Funding: ${keelSummary.fundingBps != null ? keelSummary.fundingBps.toFixed(2) + " bps" : "N/A"}
- Confluence: ${keelSummary.confluenceScore ?? "N/A"}% | Liquidity: ${keelSummary.liquidityDepthUsd != null ? "$" + (keelSummary.liquidityDepthUsd / 1000).toFixed(0) + "k" : "N/A"}
- Reasoning: ${keelSummary.reasoning}

[MTF & LIQUIDITY STRUCTURE]:
- State: ${keelSummary.mtfState?.activeState || "N/A"}
- BSL (Buy Side Liquidity): ${keelSummary.mtfState?.nearestBSL ? "$" + keelSummary.mtfState.nearestBSL.midPrice : "N/A"}
- SSL (Sell Side Liquidity): ${keelSummary.mtfState?.nearestSSL ? "$" + keelSummary.mtfState.nearestSSL.midPrice : "N/A"}
- Sweep: ${keelSummary.mtfState?.recentSweep ? keelSummary.mtfState.recentSweep.type + " (" + keelSummary.mtfState.recentSweep.wickRejectionPercent + "%)" : "None"}

[ON-CHAIN METRICS]:
- Netflow: ${oc?.exchangeNetflow24hUSD != null ? oc.exchangeNetflow24hUSD : "N/A"}
- MVRV Z-score: ${oc?.mvrvZScore ?? "N/A"} (${oc?.mvrvTerritory || "N/A"})
- Whale Move: ${oc?.whaleAlerts?.[0] ? oc.whaleAlerts[0].type + " $" + (oc.whaleAlerts[0].usdValue / 1e6).toFixed(1) + "M" : "None"}

[MACRO CONTEXT]:
- Fed Stance: ${mc?.fedPolicyStance || "N/A"}
- Risk Index: ${mc?.macroRiskIndex ?? "N/A"}/100
- Nearest Event: ${mc?.nearestEvent ? mc.nearestEvent.name + " (" + mc.nearestEvent.relativeTime + ")" : "None"}

[BACKTEST CONTEXT (HASIL REPLAY HISTORIS — kalibrasi keyakinan)]:
${backtestCtx}

TUGAS ANDA:
1. Analisis SINTESIS: Hubungkan data mikro (Keel) dengan konteks besar (Makro/On-chain). Mengapa harga bergerak seperti ini?
2. Berikan "Professional Insight" (3-6 kalimat Bahasa Indonesia tajam, tanpa basa-basi).
3. Tentukan suggestedBias secara TEGAS: LONG atau SHORT jika ada sinyal minimal 60% confluence. Gunakan NEUTRAL hanya jika market benar-benar dead-flat atau data sangat kontradiktif (conflict of interest).
4. Berikan level Entry, SL, dan TP yang presisi secara matematis berdasarkan likuiditas (BSL/SSL).
5. KALIBRASI dengan BACKTEST CONTEXT di atas: citakan secara eksplisit (misal "backtest terakhir simbol ini 55% win / PF 1.3 / MaxDD 6% → keyakinan cukup, bukan tinggi"). Jika PF < 1 atau MaxDD besar → turunkan keyakinan & tandai risiko.

Jawab HANYA JSON valid tanpa markdown:
{
  "insight": "analisis tajam ala Jane Street",
  "suggestedBias": "LONG" | "SHORT" | "NEUTRAL" | "BULLISH" | "BEARISH",
  "keyLevels": { "entry": number, "stopLoss": number, "takeProfit": number },
  "risks": ["string", "string"],
  "caveat": "disclaimer singkat"
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
      });

      const candidateModels = ["gemini-3-flash-preview", "gemini-3.5-flash-lite"];
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
          if (/INVALID_MODEL|not found|does not exist|404/i.test(msg)) {
            console.warn(`Gemini advisor model ${model} tidak valid, coba fallback...`);
            continue;
          }
          throw modelErr;
        }
      }

      if (responseText) {
        try {
          const parsed = JSON.parse(responseText);
          const validation = advisorSchema.safeParse(parsed);
          if (validation.success) {
            const ai = validation.data;
            return res.json({
              success: true,
              mode: "ai",
              geminiConfigured: true,
              model: usedModel,
              timestamp: Date.now(),
              keelSummary,
              backtest: { symbol: sym, context: backtestCtx },
              ai: {
                insight: ai.insight,
                suggestedBias: ai.suggestedBias,
                keyLevels: ai.keyLevels,
                risks: ai.risks || [],
                caveat: ai.caveat || "",
              },
              latencyMs: Date.now() - startTime,
            });
          }
          console.warn(`[ai-advisor] Gemini output gagal validasi: ${validation.error.message}`);
        } catch (parseErr: any) {
          console.warn(`[ai-advisor] Gemini output tidak valid JSON: ${parseErr?.message}`);
        }
      } else if (lastErr) {
        console.warn(`[ai-advisor] Gemini gagal: ${lastErr?.message}`);
      }
    }

    const connFlow = String(keelSummary.flow || "NEUTRAL");
    const bias = String(keelSummary.futuresBias || "NEUTRAL");
    const insightKeel =
      keelSummary.action === "HOLD"
        ? `Keel belum menemukan sinyal kuat. Flow ${connFlow}, bias futures ${bias}. ${keelSummary.discardedReason || "Belum ada konvergensi institusional."} Saran: tunggu, jangan paksa entry.`
        : `Keel cenderung ${keelSummary.action} dengan confidence ${keelSummary.confidence}% (flow ${connFlow}, bias futures ${bias}). Tapi eksekusi TETAP keputusan Anda — periksa level SL/TP dan konfirmasi harga sebelum bertindak.`;

    return res.json({
      success: true,
      mode: "keel",
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"),
      timestamp: Date.now(),
      keelSummary,
      backtest: { symbol: sym, context: buildBacktestContextFor(sym) },
      ai: {
        insight: `Mode AI nonaktif (GEMINI_API_KEY belum di-set). Berikut ringkasan data keel: ${insightKeel}`,
        suggestedBias: keelSummary.action === "BUY" ? "BULLISH" : keelSummary.action === "SELL" ? "BEARISH" : "NEUTRAL",
        risks: [],
      },
      latencyMs: Date.now() - startTime,
    });
  });
}
