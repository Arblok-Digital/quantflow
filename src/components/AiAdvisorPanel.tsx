import React, { useCallback, useEffect, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import type { OnChainMetrics, MacroSummary } from "../types";

export interface AiAdvisorKeelSummary {
  action: string;
  confidence: number;
  flow: string;
  futuresBias: string;
  fundingBps: number | null;
  openInterestUsd: number | null;
  lsrTaker: number | null;
  confluenceScore: number | null;
  liquidityDepthUsd: number | null;
  reasoning: string;
  discardedReason: string | null;
  mtfState: {
    activeState: string;
    nearestBSL: { midPrice: number; estimatedVolumeUSD: number } | null;
    nearestSSL: { midPrice: number; estimatedVolumeUSD: number } | null;
    recentSweep: { type: string; wickRejectionPercent: number; invalidationPrice: number } | null;
  } | null;
}

export interface AiAdvisorResponse {
  success: boolean;
  mode: "ai" | "keel";
  geminiConfigured: boolean;
  timestamp: number;
  keelSummary: AiAdvisorKeelSummary;
  backtest?: { symbol: string; context: string };
  ai: {
    insight: string;
    suggestedBias?: "BULLISH" | "BEARISH" | "NEUTRAL";
    keyLevels?: { entry: number | null; stopLoss: number | null; takeProfit: number | null };
    risks?: string[];
    caveat?: string;
  };
  latencyMs?: number;
}

interface AiAdvisorPanelProps {
  symbol: string;
  currentPrice: number;
  onChainMetrics?: OnChainMetrics | null;
  macroSummary?: MacroSummary | null;
  geminiActive: boolean;
}

function biasBadge(bias?: string) {
  const b = String(bias || "NEUTRAL").toUpperCase();
  if (b === "BULLISH" || b === "LONG") return { label: "LONG", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
  if (b === "BEARISH" || b === "SHORT") return { label: "SHORT", cls: "bg-rose-500/15 text-rose-400 border-rose-500/30" };
  return { label: "NEUTRAL", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
}

function actionBadge(action: string) {
  const a = String(action || "HOLD").toUpperCase();
  if (a === "BUY" || a === "LONG") return { label: "BUY", cls: "bg-emerald-500 text-zinc-950 border-emerald-600" };
  if (a === "SELL" || a === "SHORT") return { label: "SELL", cls: "bg-rose-500 text-white border-rose-600" };
  return { label: "HOLD", cls: "bg-amber-500 text-zinc-950 border-amber-600" };
}

const fmtPrice = (n?: number | null) =>
  n != null ? `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";

const fmtUsd = (n?: number | null) =>
  n != null ? `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—";

export const AiAdvisorPanel: React.FC<AiAdvisorPanelProps> = ({
  symbol,
  currentPrice,
  onChainMetrics,
  macroSummary,
  geminiActive,
}) => {
  const [result, setResult] = useState<AiAdvisorResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedSymbol, setRequestedSymbol] = useState<string>(symbol);

  const requestInsight = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRequestedSymbol(symbol);
    try {
      const res = await authFetch("/api/ai-advisor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          currentPrice,
          onChainMetrics: onChainMetrics || null,
          macroCalendar: macroSummary || null,
        }),
      });
      if (!res.ok) {
        setError(`Gagal meminta insight (HTTP ${res.status}).`);
        return;
      }
      const data = await res.json();
      if (!data || !data.success) {
        setError("Endpoint tidak mengembalikan respons sukses.");
        return;
      }
      setResult(data as AiAdvisorResponse);
    } catch (e: any) {
      setError(e?.message || "Kesalahan jaringan saat meminta insight.");
    } finally {
      setLoading(false);
    }
  }, [symbol, currentPrice, onChainMetrics, macroSummary]);

  // Auto-load saat mount & symbol berubah (bukan setiap tick harga).
  useEffect(() => {
    requestInsight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const mode = result?.mode ?? "keel";
  const isAi = mode === "ai";
  const keel = result?.keelSummary;
  const ai = result?.ai;
  const act = keel ? actionBadge(keel.action) : null;
  const futuresBias = keel ? biasBadge(keel.futuresBias) : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm relative overflow-hidden">
      <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />
      <div className="absolute right-0 top-0 translate-x-10 -translate-y-10 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="relative z-10 flex flex-col gap-4">
        {/* HEADER */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-500/15 rounded-xl flex items-center justify-center text-emerald-400 border border-emerald-500/30 font-mono font-black text-sm">
              AI
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                AI ADVISOR
                <span
                  className={`px-2 py-0.5 rounded border text-[10px] font-mono font-bold ${
                    isAi
                      ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                      : "bg-amber-500/15 text-amber-300 border-amber-500/30"
                  }`}
                >
                  {isAi ? "AI ACTIVE" : "KEEL-ONLY"}
                </span>
              </h2>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
                {isAi
                  ? "Insight naratif AI — penasihat, bukan eksekutor"
                  : "Tanpa Gemini — insight deterministik dari keel"}
              </p>
            </div>
          </div>
          <button
            onClick={requestInsight}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-zinc-950 font-bold font-mono text-xs shadow-md shadow-emerald-500/20 border border-emerald-600 disabled:border-zinc-700 transition"
          >
            {loading ? (
              <span className="w-3 h-3 border-2 border-zinc-700 border-t-emerald-500 rounded-full animate-spin" />
            ) : (
              <span className="text-sm leading-none">+</span>
            )}
            {loading ? "Menganalisis..." : "Minta Insight"}
          </button>
        </div>

        {error && (
          <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-mono">
            {error}
          </div>
        )}

        {loading && !result && (
          <div className="flex items-center justify-center py-10 text-center bg-zinc-950/60 rounded-xl border border-zinc-800">
            <span className="flex items-center gap-2 text-xs font-mono text-zinc-400">
              <span className="w-3 h-3 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
              Menghitung keel & meramu insight...
            </span>
          </div>
        )}

        {!loading && !result && !error && (
          <div className="flex flex-col items-center justify-center py-8 text-center bg-zinc-950/60 rounded-xl border border-dashed border-zinc-800">
            <p className="text-xs font-mono text-zinc-400">
              Belum ada insight — tekan Minta Insight untuk menjalankan keel + AI advisor.
            </p>
            {!geminiActive && (
              <p className="text-[10px] font-mono text-zinc-600 mt-1">
                GEMINI_API_KEY belum terdeteksi — panel akan berjalan dalam mode KEEL-ONLY.
              </p>
            )}
          </div>
        )}

        {result && (
          <>
            {/* STRATEGIC RECOMMENDATION — Headline Arahan */}
            {ai?.suggestedBias && (
              <div className={`mb-4 rounded-2xl border-4 p-5 flex items-center justify-between shadow-[0_0_30px_rgba(0,0,0,0.5)] ${
                ai.suggestedBias === "LONG" ? "bg-emerald-950/60 border-emerald-500/80 shadow-emerald-500/20" : 
                ai.suggestedBias === "SHORT" ? "bg-rose-950/60 border-rose-500/80 shadow-rose-500/20" : 
                "bg-zinc-900/80 border-zinc-600/50"
              }`}>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-zinc-400 font-black">Strategic Guidance</p>
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[9px] text-zinc-500 font-bold border border-zinc-700">SWING 4H</span>
                  </div>
                  <h3 className={`text-3xl font-black font-mono tracking-tighter uppercase leading-none ${
                    ai.suggestedBias === "LONG" ? "text-emerald-400" : 
                    ai.suggestedBias === "SHORT" ? "text-rose-400" : 
                    "text-zinc-100"
                  }`}>
                    {ai.suggestedBias === "LONG" ? "INSTITUTIONAL LONG" : 
                     ai.suggestedBias === "SHORT" ? "INSTITUTIONAL SHORT" : 
                     "WAIT & OBSERVE"}
                  </h3>
                  <p className="text-[10px] font-medium text-zinc-500 italic">Targeting liquidity pools (BSL/SSL)</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className={`text-sm font-mono font-black px-4 py-1.5 rounded-full border-2 shadow-sm ${biasBadge(ai.suggestedBias).cls}`}>
                    {ai.suggestedBias}
                  </span>
                  <div className="flex gap-1">
                    {[1,2,3].map(i => (
                      <div key={i} className={`w-1.5 h-1.5 rounded-full ${
                        ai.suggestedBias === "NEUTRAL" ? "bg-zinc-700" : 
                        ai.suggestedBias === "LONG" ? "bg-emerald-500 animate-pulse" : "bg-rose-500 animate-pulse"
                      }`} style={{ animationDelay: `${i*0.2}s` }} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* INSIGHT — paling menonjol */}
            <div
              className={`rounded-xl bg-zinc-950/70 border p-4 space-y-2 ${
                isAi ? "border-emerald-500/30" : "border-amber-500/30"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-mono uppercase tracking-wider font-bold text-zinc-400">Insight</p>
                {ai?.suggestedBias && (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono font-black ${biasBadge(ai.suggestedBias).cls}`}>
                    BIAS: {ai.suggestedBias}
                  </span>
                )}
              </div>
              <p className="text-sm text-zinc-200 leading-relaxed font-sans">{ai?.insight}</p>
              {result.mode === "keel" && (
                <p className="text-[10px] font-mono text-amber-400/80">
                  Set GEMINI_API_KEY lalu refresh untuk insight AI lanjutan (on-chain + makro).
                </p>
              )}
            </div>

            {/* BACKTEST CONTEXT — hasil replay historis (kalibrasi keyakinan) */}
            {result.backtest && (
              <div className="rounded-xl bg-zinc-950/70 border border-sky-500/25 p-3">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-sky-400 font-bold">
                    Backtest Context (Replay Historis)
                  </p>
                  <span className="px-1.5 py-0.5 rounded border border-sky-500/30 bg-sky-500/10 text-[9px] font-mono font-bold text-sky-300">
                    {result.backtest.symbol?.toUpperCase()}
                  </span>
                </div>
                <p className="text-[10px] font-mono text-zinc-400 whitespace-pre-wrap leading-relaxed">
                  {result.backtest.context}
                </p>
              </div>
            )}

            {/* KEEL DATA — grid info */}
            {keel && (
              <div className="rounded-xl bg-zinc-950/70 border border-zinc-800 p-3 space-y-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold">Keel Data</p>
                  {act && (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-lg border text-[11px] font-black font-mono ${act.cls}`}>
                      {act.label}
                    </span>
                  )}
                  {futuresBias && (
                    <span className={`ml-auto inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono font-black ${futuresBias.cls}`}>
                      FUTURES {keel.futuresBias}
                    </span>
                  )}
                  <span className="px-1.5 py-0.5 rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] font-mono font-bold text-cyan-300">
                    {keel.confluenceScore != null ? `${keel.confluenceScore}%` : "—"} CONF
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-xs">
                  <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Flow</span>
                    <span className="text-sm font-bold text-cyan-300">{keel.flow}</span>
                  </div>
                  <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Funding</span>
                    <span className={`text-sm font-bold ${keel.fundingBps != null ? (keel.fundingBps < 0 ? "text-emerald-400" : keel.fundingBps > 0.5 ? "text-rose-400" : "text-amber-300") : "text-zinc-500"}`}>
                      {keel.fundingBps != null ? `${keel.fundingBps.toFixed(2)} bps` : "—"}
                    </span>
                  </div>
                  <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Open Interest</span>
                    <span className="text-sm font-bold text-zinc-100">
                      {keel.openInterestUsd != null ? (keel.openInterestUsd >= 1e9 ? `${(keel.openInterestUsd / 1e9).toFixed(2)}B` : `$${(keel.openInterestUsd / 1e6).toFixed(1)}M`) : "—"}
                    </span>
                  </div>
                  <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">LSR Taker</span>
                    <span className="text-sm font-bold text-zinc-100">{keel.lsrTaker != null ? keel.lsrTaker.toFixed(2) : "—"}</span>
                  </div>
                  <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Confidence</span>
                    <span className="text-sm font-bold text-amber-300">{keel.confidence}%</span>
                  </div>
                  <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Liquidity Depth</span>
                    <span className="text-sm font-bold text-zinc-100">
                      {keel.liquidityDepthUsd != null ? `$${(keel.liquidityDepthUsd / 1000).toFixed(1)}k` : "—"}
                    </span>
                  </div>
                </div>

                {/* MTF liquidity */}
                {keel.mtfState && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px]">
                    <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                      <span className="text-zinc-500 text-[10px] uppercase">MTF State</span>
                      <span className="text-amber-300 font-bold">{keel.mtfState.activeState}</span>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                      <span className="text-zinc-500 text-[10px] uppercase">BSL terdekat</span>
                      <span className="text-emerald-400 font-bold">{keel.mtfState.nearestBSL ? fmtPrice(keel.mtfState.nearestBSL.midPrice) : "—"}</span>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                      <span className="text-zinc-500 text-[10px] uppercase">SSL terdekat</span>
                      <span className="text-rose-400 font-bold">{keel.mtfState.nearestSSL ? fmtPrice(keel.mtfState.nearestSSL.midPrice) : "—"}</span>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                      <span className="text-zinc-500 text-[10px] uppercase">Sweep</span>
                      <span className="text-zinc-200 font-bold">
                        {keel.mtfState.recentSweep ? `${keel.mtfState.recentSweep.type} (${keel.mtfState.recentSweep.wickRejectionPercent}%)` : "belum ada"}
                      </span>
                    </div>
                  </div>
                )}

                {keel.reasoning && (
                  <p className="text-[11px] text-zinc-400 leading-relaxed font-sans">{keel.reasoning}</p>
                )}
              </div>
            )}

            {/* RISK & LEVELS (mode ai) */}
            {isAi && ai && (ai.risks?.length || ai.keyLevels) && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {ai.risks && ai.risks.length > 0 && (
                  <div className="rounded-xl bg-zinc-950/70 border border-rose-500/20 p-3 space-y-1.5">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-rose-400 font-bold">Risiko</p>
                    <ul className="space-y-1.5">
                      {ai.risks.map((r, i) => (
                        <li key={i} className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">
                          {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {ai.keyLevels && (
                  <div className="rounded-xl bg-zinc-950/70 border border-zinc-800 p-3 space-y-2">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold">Key Levels</p>
                    <div className="grid grid-cols-3 gap-2 font-mono text-xs">
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Entry</span>
                        <span className="text-sm font-bold text-amber-300">{fmtPrice(ai.keyLevels.entry)}</span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-rose-500/20">
                        <span className="text-[10px] uppercase text-rose-400 block font-semibold">Stop Loss</span>
                        <span className="text-sm font-bold text-rose-400">{fmtPrice(ai.keyLevels.stopLoss)}</span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-emerald-500/20">
                        <span className="text-[10px] uppercase text-emerald-400 block font-semibold">Take Profit</span>
                        <span className="text-sm font-bold text-emerald-400">{fmtPrice(ai.keyLevels.takeProfit)}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Caveat (mode ai) */}
            {isAi && ai?.caveat && (
              <p className="text-[10px] font-mono text-zinc-500">{ai.caveat}</p>
            )}

            {result.geminiConfigured === false && isAi === false && !loading && (
              <p className="text-[10px] font-mono text-zinc-500">
                geminiConfigured: {String(result.geminiConfigured)} • latency: {result.latencyMs != null ? `${result.latencyMs}ms` : "—"}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default AiAdvisorPanel;
