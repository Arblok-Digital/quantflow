import React, { useState } from "react";
import { LLMDecision, TechnicalIndicators, MTFLiquidityAnalysis } from "../types";
import { 
  Bot, 
  Sparkles, 
  ArrowUpRight, 
  ArrowDownRight, 
  PauseCircle, 
  Code,
  Target,
  ShieldCheck,
  Flame
} from "lucide-react";

interface DecisionStreamProps {
  decision: LLMDecision | null;
  technicals: TechnicalIndicators;
  currentPrice: number;
  symbol: string;
  isAnalyzing: boolean;
  mtfLiquidity?: MTFLiquidityAnalysis;
}

export const DecisionStream: React.FC<DecisionStreamProps> = ({
  decision,
  technicals,
  currentPrice,
  symbol,
  isAnalyzing,
  mtfLiquidity,
}) => {
  const [showPromptInspector, setShowPromptInspector] = useState(false);

  // Fallback defaults if no decision yet
  const action = decision?.action || "HOLD";
  const confidence = decision?.confidence || 75;
  const reasoning =
    decision?.reasoning ||
    "Mengawasi likuiditas swing high/low pada TF 15m & 4H. Menunggu konfirmasi stop-loss grab sebelum eksekusi order.";
  const targetPrice = decision?.targetPrice || currentPrice;
  const stopLoss = decision?.stopLoss || currentPrice * 0.985;
  const takeProfit = decision?.takeProfit || currentPrice * 1.035;
  const sizePercent = decision?.positionSizePercent || 7;

  const liqAnalysis = decision?.liquidityHuntAnalysis;

  // Sentiment mapping from confidence & action
  const sentimentScore = action === "BUY" ? (confidence / 100) : action === "SELL" ? (1 - confidence / 100) : 0.5;
  const sentimentLabel =
    sentimentScore >= 0.65
      ? `${sentimentScore.toFixed(2)} (Bullish Hunt)`
      : sentimentScore <= 0.35
      ? `${sentimentScore.toFixed(2)} (Bearish Hunt)`
      : "0.50 (Range Equilibrium)";

  // Estimated order weight in base currency
  const baseAsset = symbol.split("/")[0] || "BTC";
  const estimatedOrderWeight = ((10000 * (sizePercent / 100)) / (currentPrice || 1)).toFixed(3);

  const getActionColor = () => {
    switch (action) {
      case "BUY":
        return {
          bg: "bg-emerald-500/10",
          border: "border-emerald-500/30",
          text: "text-emerald-400",
          badge: "bg-emerald-500 text-zinc-950 font-bold",
          barColor: "bg-emerald-500/20 border-emerald-500",
          icon: <ArrowUpRight className="h-4 w-4" />,
        };
      case "SELL":
        return {
          bg: "bg-rose-500/10",
          border: "border-rose-500/30",
          text: "text-rose-400",
          badge: "bg-rose-500 text-white font-bold",
          barColor: "bg-rose-500/20 border-rose-500",
          icon: <ArrowDownRight className="h-4 w-4" />,
        };
      default:
        return {
          bg: "bg-zinc-800/50",
          border: "border-zinc-700/50",
          text: "text-amber-400",
          badge: "bg-amber-500 text-zinc-950 font-bold",
          barColor: "bg-amber-500/20 border-amber-500",
          icon: <PauseCircle className="h-4 w-4" />,
        };
    }
  };

  const colors = getActionColor();

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 relative overflow-hidden shadow-sm flex flex-col justify-between h-full">
      {/* Ambient Bento Dot Grid */}
      <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />

      <div className="relative z-10 flex flex-col h-full justify-between">
        {/* Bento Top Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-zinc-800 rounded-xl flex items-center justify-center text-zinc-400 border border-zinc-700/60">
              <Bot className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
                MTF Liquidity Decision Engine
              </h2>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest">
                Swing Structure &bull; Stop-Loss Sweep Recognition &bull; Multi-Timeframe Confluence
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-2 py-0.5 bg-amber-500/10 text-amber-400 text-[10px] font-bold rounded tracking-wider border border-amber-500/20 uppercase">
              STRATEGY: MTF_LIQUIDITY_HUNT
            </span>
            <span className="px-2 py-0.5 bg-zinc-800 text-zinc-400 text-[10px] rounded border border-zinc-700/50 font-mono">
              {decision?.source || "GEMINI-3.8-FLASH"}
            </span>
            <button
              onClick={() => setShowPromptInspector(!showPromptInspector)}
              className="px-2 py-0.5 text-[10px] font-mono rounded bg-zinc-950 hover:bg-zinc-800 text-zinc-400 hover:text-cyan-400 border border-zinc-800 transition-colors flex items-center gap-1"
            >
              <Code className="h-3 w-3" />
              <span>{showPromptInspector ? "Tutup" : "Prompt Schema"}</span>
            </button>
          </div>
        </div>

        {/* Bento Middle: Signal & Target Liquidity Pool */}
        <div className="my-2 bg-zinc-950/70 border border-zinc-800/80 rounded-xl p-3.5 space-y-3 font-mono">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-xs font-bold ${colors.badge}`}>
                {colors.icon}
                {action} SIGNAL
              </span>
              <span className="text-xs text-zinc-300 font-semibold">
                Entry @ ${targetPrice.toFixed(2)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 text-xs text-zinc-400">
              <span className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                Invalidation SL: <strong>${stopLoss.toFixed(2)}</strong>
              </span>
              <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Opposite Pool TP: <strong>${takeProfit.toFixed(2)}</strong>
              </span>
              <span className="text-zinc-200 font-bold">
                Conf: {confidence}%
              </span>
            </div>
          </div>

          {/* MTF Target Pool Highlight */}
          <div className="p-2.5 bg-zinc-900/80 rounded-lg border border-zinc-800 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-amber-400" />
              <span className="text-zinc-400 text-[11px]">TARGET LIQUIDITY POOL:</span>
              <span className="font-bold text-amber-300">
                {liqAnalysis?.targetPool === "BSL" ? "UPPER BSL (Short Stop-Losses)" : "LOWER SSL (Long Stop-Losses)"} @ ${liqAnalysis?.targetZonePrice?.toFixed(2) || takeProfit.toFixed(2)}
              </span>
            </div>

            <div className="flex items-center gap-2 text-[10px]">
              <span className={`px-2 py-0.5 rounded font-bold ${liqAnalysis?.sweepTriggered ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-zinc-800 text-zinc-400"}`}>
                {liqAnalysis?.sweepTriggered ? "SWEEP CONFIRMED" : "BUILDING RANGE"}
              </span>
              <span className="text-zinc-400">
                Confluence: <strong className="text-emerald-400">{liqAnalysis?.confluenceScore || mtfLiquidity?.confluenceScore || 75}%</strong>
              </span>
            </div>
          </div>

          {/* On-Chain & Macro Confluence Indicators */}
          {(decision?.onChainContext || decision?.macroContext) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
              {decision.onChainContext && (
                <div className="px-2.5 py-1.5 rounded-lg bg-emerald-950/30 border border-emerald-500/20 flex items-center justify-between">
                  <span className="text-emerald-400 font-semibold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    On-Chain: {decision.onChainContext.smartMoneyBias.replace("_", " ")}
                  </span>
                  <span className="text-zinc-400 font-mono text-[10px]">
                    MVRV: {decision.onChainContext.mvrvZScore}
                  </span>
                </div>
              )}

              {decision.macroContext && (
                <div className="px-2.5 py-1.5 rounded-lg bg-blue-950/30 border border-blue-500/20 flex items-center justify-between">
                  <span className="text-blue-400 font-semibold flex items-center gap-1 truncate max-w-[170px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                    Makro: {decision.macroContext.nearestEventName}
                  </span>
                  <span className="text-zinc-400 font-mono text-[10px]">
                    {decision.macroContext.volatilityRisk}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Visual Momentum & Liquidity Absorption Distribution */}
          <div className="h-20 flex items-end gap-1.5 pt-1 pb-1 relative">
            <div className="w-full h-10 bg-zinc-800/40 border-t border-zinc-700 rounded-t-sm" />
            <div className="w-full h-14 bg-zinc-800/40 border-t border-zinc-700 rounded-t-sm" />
            <div className="w-full h-8 bg-zinc-800/40 border-t border-zinc-700 rounded-t-sm" />
            <div className="w-full h-16 bg-amber-500/20 border-t-2 border-amber-500/60 rounded-t-sm" />
            <div className="w-full h-12 bg-zinc-800/40 border-t border-zinc-700 rounded-t-sm" />
            <div className="w-full h-18 bg-cyan-500/20 border-t-2 border-cyan-500/60 rounded-t-sm" />
            
            {/* Active Trigger bar with callout badge */}
            <div className={`w-full ${action === "SELL" ? "h-20 bg-rose-500/30 border-t-2 border-rose-400" : action === "BUY" ? "h-20 bg-emerald-500/40 border-t-2 border-emerald-400" : "h-12 bg-amber-500/20 border-t border-amber-400"} rounded-t-sm relative transition-all`}>
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-[9px] font-bold font-mono px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-200 shadow-sm">
                {action} ACTION
              </div>
            </div>
          </div>
        </div>

        {/* Bento Bottom 3-Column Split */}
        <div className="mt-3 pt-3 border-t border-zinc-800 grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {/* Col 1: Reasoning Context */}
          <div>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold font-mono">
              Liquidation Hunt Reasoning
            </p>
            <p className="text-xs text-zinc-300 mt-1 leading-relaxed italic bg-zinc-950/60 p-2.5 rounded-lg border border-zinc-800/60 min-h-[58px]">
              {isAnalyzing ? (
                <span className="text-amber-400 not-italic font-mono flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-ping" />
                  Memindai order flow, swing highs & MTF stop sweeps...
                </span>
              ) : (
                `"${reasoning}"`
              )}
            </p>
          </div>

          {/* Col 2: Sentiment Analysis */}
          <div>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold font-mono">
              MTF Order Flow Bias
            </p>
            <div className="mt-1 bg-zinc-950/60 p-2.5 rounded-lg border border-zinc-800/60 min-h-[58px] flex flex-col justify-between">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      sentimentScore >= 0.55 ? "bg-emerald-500" : sentimentScore <= 0.45 ? "bg-rose-500" : "bg-amber-500"
                    }`}
                    style={{ width: `${Math.min(100, Math.max(10, sentimentScore * 100))}%` }}
                  />
                </div>
                <span className="text-xs font-mono text-zinc-200 font-medium whitespace-nowrap">
                  {sentimentLabel}
                </span>
              </div>
              <div className="flex justify-between text-[9px] font-mono text-zinc-500">
                <span>Sell Sweep</span>
                <span>Equilibrium</span>
                <span>Buy Sweep</span>
              </div>
            </div>
          </div>

          {/* Col 3: Order Weight & Risk:Reward */}
          <div>
            <p className="text-[10px] text-zinc-500 uppercase tracking-wider font-semibold font-mono">
              Position Sizing & Risk:Reward
            </p>
            <div className="mt-1 bg-zinc-950/60 p-2.5 rounded-lg border border-zinc-800/60 flex items-baseline justify-between min-h-[58px]">
              <div>
                <p className="text-lg font-bold text-zinc-100 font-mono">
                  {estimatedOrderWeight} <span className="text-zinc-500 text-xs">{baseAsset}</span>
                </p>
                <p className="text-[10px] font-mono text-zinc-400">
                  {sizePercent}% Portfolio Sizing
                </p>
              </div>
              <span className="px-2 py-0.5 bg-zinc-900 border border-zinc-800 rounded text-[10px] font-mono text-emerald-400 font-bold">
                R:R 1:2.3
              </span>
            </div>
          </div>
        </div>

        {/* Collapsible Prompt Inspector */}
        {showPromptInspector && (
          <div className="mt-3 rounded-xl bg-zinc-950 p-3 border border-zinc-800 font-mono text-[11px] text-zinc-300">
            <div className="text-zinc-500 text-[10px] uppercase mb-1">
              // Strict JSON Prompt Payload Sent to Gemini 3.8 Flash Endpoint:
            </div>
            <pre className="overflow-x-auto p-2 rounded-lg bg-zinc-900 text-amber-400 border border-zinc-800/80 text-[10px]">
{`{
  "agent": "MTF Liquidity Hunt & Swing Execution Specialist",
  "symbol": "${symbol}",
  "markPrice": ${currentPrice},
  "mtfContext": {
    "activeState": "${mtfLiquidity?.activeState || 'EQUILIBRIUM'}",
    "nearestBSL": ${JSON.stringify(mtfLiquidity?.nearestBSL?.midPrice || null)},
    "nearestSSL": ${JSON.stringify(mtfLiquidity?.nearestSSL?.midPrice || null)},
    "confluenceScore": ${mtfLiquidity?.confluenceScore || 75}
  },
  "technicals": {
    "rsi14": ${technicals.rsi},
    "ema20": ${technicals.ema20},
    "orderBookImbalance": ${technicals.orderBookImbalance.toFixed(2)}
  }
}`}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
