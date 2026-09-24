import React, { useCallback, useEffect, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import type { OnChainMetrics, MacroSummary } from "../types";
import { makeIntradayDraft, formatDeadlineWib } from "../logic/intradayPlan";
import { publishIntradayTicket, INTRADAY_HOLD_MS_FE_HINT } from "../logic/intradayTicket";

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

export interface AiAdvisorTechnicals {
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  macdHistogram: number | null;
  orderBookImbalance: number | null;
  volatility: string | null;
}

export interface AiAdvisorFuturesDetail {
  fundingBps: number | null;
  markPrice: number | null;
  openInterestUsd: number | null;
  lsrTaker: number | null;
  lsrAccount: number | null;
  longLiqUsd: number | null;
  shortLiqUsd: number | null;
  volume24hUsd: number | null;
  biasReason: string | null;
  source: string | null;
}

export interface AiAdvisorDataHealth {
  source: string;
  ok: boolean;
  detail: string;
}

export interface AiAdvisorMultiTfEntry {
  rsi: number | null;
  ema20: number | null;
  ema50: number | null;
  macdHistogram: number | null;
  trend: string | null;
}

export interface AiAdvisorMacroReal {
  source: string;
  vix: number | null;
  riskIndex: number;
  upcomingCount: number;
  upcoming: Array<{ title: string; dateUtc: string; forecast: string; previous: string }>;
  fetchedAt: number;
}

export interface AiAdvisorResponse {
  success: boolean;
  mode: "ai" | "keel";
  geminiConfigured: boolean;
  /** Penyebab mode keel-only: KEY_MISSING | KEY_LEGACY_REVOKED | AI_CALL_FAILED. */
  aiDisabledReason?: "KEY_MISSING" | "KEY_LEGACY_REVOKED" | "AI_CALL_FAILED";
  timestamp: number;
  model?: string;
  keelSummary: AiAdvisorKeelSummary;
  technicals?: AiAdvisorTechnicals | null;
  multiTfTechnicals?: Record<string, AiAdvisorMultiTfEntry | null> | null;
  futuresDetail?: AiAdvisorFuturesDetail | null;
  macroReal?: AiAdvisorMacroReal | null;
  onChainEcho?: {
    netflowStatus: string | null;
    smartMoneyBias: string | null;
    onChainConfidence: number | null;
    sopr: number | null;
    soprStatus: string | null;
    activeAddressesGrowth24h: number | null;
    hasRealAnchor?: boolean;
  } | null;
  macroEcho?: {
    upcomingHighImpactCount: number | null;
    macroTradingAdvice: string | null;
    nearestEventImpact: string | null;
    nearestEventImplication: string | null;
  } | null;
  backtest?: { symbol: string; context: string };
  dataHealth?: AiAdvisorDataHealth[];
  /** Keputusan terstruktur (Jev System One) — source: jev-zen/jev-openrouter/gemini/keel. */
  decision?: {
    action: "BUY" | "SELL" | "HOLD";
    confidence: number;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
    source: string;
    probabilities?: unknown;
  };
  decisionSource?: string;
  jevDecision?: {
    action: "BUY" | "SELL" | "HOLD";
    confidence: number;
    riskLevel: "LOW" | "MEDIUM" | "HIGH";
    source: string;
  } | null;
  ai: {
    insight: string;
    suggestedBias?: "LONG" | "SHORT" | "NEUTRAL" | "BULLISH" | "BEARISH";
    keyLevels?: { entry: number | null; stopLoss: number | null; takeProfit: number | null };
    risks?: string[];
    caveat?: string;
    dataGaps?: string[];
  };
  latencyMs?: number;
}

interface AiAdvisorPanelProps {
  symbol: string;
  currentPrice: number;
  onChainMetrics?: OnChainMetrics | null;
  macroSummary?: MacroSummary | null;
  geminiActive: boolean;
  /** Health flag dari /api/health — hanya boolean, TIDAK pernah berisi key. */
  jevConfigured?: boolean;
  openrouterConfigured?: boolean;
  /** Market aktif (SubBar) — SPOT menolak SHORT di draft intraday. */
  marketType?: string;
  /** TF chart aktif — cooldown cache insight diskala per TF (15m < 1h < 4h). */
  timeframe?: string;
}

// ---------------------------------------------------------------------------
// Cache smart per (symbol, TF) — komponen unmount saat tab ditutup (state React
// hilang), tapi insight terakhir tetap di-ingat agar membuka panel lagi TIDAK
// menghitung ulang dari nol. Cooldown diskala TF aktif.
// ---------------------------------------------------------------------------
const TF_COOLDOWN_MS: Record<string, number> = {
  "15M": 3 * 60_000,
  "1H": 15 * 60_000,
  "4H": 30 * 60_000,
  "1D": 60 * 60_000,
};

const cooldownFor = (tf: string): number => {
  const t = String(tf || "15m").toUpperCase();
  return TF_COOLDOWN_MS[t] ?? 3 * 60_000;
};

const cacheKey = (symbol: string, tf: string): string => `${symbol}@${String(tf || "15m").toUpperCase()}`;

interface AdvisorCacheEntry {
  result: AiAdvisorResponse | null;
  ts: number;
}

const advisorCache = new Map<string, AdvisorCacheEntry>();

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
  jevConfigured = false,
  openrouterConfigured = false,
  marketType = "FUTURES",
  timeframe = "15m",
}) => {
  const [result, setResult] = useState<AiAdvisorResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [requestedSymbol, setRequestedSymbol] = useState<string>(symbol);
  // True saat menampilkan hasil cache segar (dalam cooldown TF) — tanpa auto-request.
  const [usingCache, setUsingCache] = useState<boolean>(false);

  const requestInsight = useCallback(async () => {
    const diagT0 = Date.now();
    // Logging diagnostik: payload yang dikirim ke LLM (sumber data per pilar).
    try {
      // eslint-disable-next-line no-console
      console.log("[advisor-diag] request", {
        symbol,
        currentPrice,
        hasOnChain: !!onChainMetrics,
        hasMacro: !!macroSummary,
        onChainKeys: onChainMetrics ? Object.keys(onChainMetrics) : [],
        macroKeys: macroSummary ? Object.keys(macroSummary) : [],
      });
    } catch {}
    setLoading(true);
    setError(null);
    setRequestedSymbol(symbol);
    setUsingCache(false);
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
      // Logging diagnostik: sumber data yang benar-benar dipakai server + mode.
      try {
        // eslint-disable-next-line no-console
        console.log("[advisor-diag] response", {
          ms: Date.now() - diagT0,
          symbol,
          mode: data.mode,
          geminiConfigured: data.geminiConfigured,
          model: (data as any).model ?? null,
          hasKeelSummary: !!data.keelSummary,
          keelAction: data.keelSummary?.action,
          hasTechnicals: !!(data as any).technicals,
          hasFuturesDetail: !!(data as any).futuresDetail,
          hasOnChainEcho: !!(data as any).onChainEcho,
          hasMacroEcho: !!(data as any).macroEcho,
          hasBacktest: !!(data as any).backtest,
        });
      } catch {}
      setResult(data as AiAdvisorResponse);
      advisorCache.set(cacheKey(symbol, timeframe), { result: data as AiAdvisorResponse, ts: Date.now() });
    } catch (e: any) {
      setError(e?.message || "Kesalahan jaringan saat meminta insight.");
    } finally {
      setLoading(false);
    }
  }, [symbol, currentPrice, onChainMetrics, macroSummary, timeframe]);

  // Auto-load saat mount / symbol / TF berubah. Cache fresh (dalam cooldown TF)
  // langsung ditampilkan tanpa hit ulang; cache basi ditampilkan dulu lalu
  // di-refresh di background (tidak blank dari nol).
  useEffect(() => {
    const k = cacheKey(symbol, timeframe);
    const cached = advisorCache.get(k);
    if (cached?.result) {
      setResult(cached.result);
      setError(null);
      setRequestedSymbol(symbol);
    }
    if (cached?.result && Date.now() - cached.ts < cooldownFor(timeframe)) {
      setUsingCache(true);
      setLoading(false);
      return;
    }
    setUsingCache(false);
    void requestInsight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe]);

  const mode = result?.mode ?? "keel";
  const isAi = mode === "ai";
  const keel = result?.keelSummary;
  const ai = result?.ai;
  // Tiket intraday (ADV-01): draft STRICT dari makeIntradayDraft — hanya
  // diisi bila bias tegas + keyLevels valid + fresh (TTL 15m). TIDAK pernah
  // auto-submit; user yang menekan eksekusi di Order Entry.
  const intradayDraft = (() => {
    if (!ai?.suggestedBias || !ai?.keyLevels) return null;
    const ts = Number(result?.timestamp || 0);
    return makeIntradayDraft(symbol, String(marketType).toUpperCase(), ai.suggestedBias, ai.keyLevels, ts);
  })();
  const patchTime = formatDeadlineWib(Date.now() + INTRADAY_HOLD_MS_FE_HINT);
  const [ticketNote, setTicketNote] = useState<string | null>(null);
  const fillIntradayTicket = useCallback(() => {
    if (!intradayDraft) return;
    publishIntradayTicket({
      symbol: intradayDraft.symbol,
      side: intradayDraft.side,
      entry: intradayDraft.entry,
      stopLoss: intradayDraft.stopLoss,
      takeProfit: intradayDraft.takeProfit,
      createdAt: intradayDraft.createdAt,
      source: "ai-advisor",
    });
    setTicketNote(
      `Tiket ${intradayDraft.side} ${intradayDraft.symbol} @ $${Number(intradayDraft.entry).toFixed(2)} terisi di panel Order Entry — TANPA auto-submit. Klik LONG/SHORT untuk eksekusi.`
    );
  }, [intradayDraft]);
  // Umur insight (menit) dari timestamp server — buat indikator cache/refresh.
  const fetchedAgeMin = result?.timestamp ? Math.max(0, Math.floor((Date.now() - Number(result.timestamp)) / 60000)) : null;
  const cooldownMin = Math.round(cooldownFor(timeframe) / 60000);
  const tech = result?.technicals ?? null;
  const fut = result?.futuresDetail ?? null;
  const multiTf = result?.multiTfTechnicals ?? null;
  const macroReal = result?.macroReal ?? null;
  const TF_ORDER = ["15m", "1h", "4h"] as const;
  const TF_ROLE: Record<string, string> = {
    "15m": "Scalping / timing entry",
    "1h": "Intraday / konfirmasi",
    "4h": "Swing / arah utama",
  };
  const hasMultiTf = multiTf != null && TF_ORDER.some((tf) => multiTf[tf] != null);
  const act = keel ? actionBadge(keel.action) : null;
  const futuresBias = keel ? biasBadge(keel.futuresBias) : null;
  const hasTech = tech != null && (
    (tech.rsi != null && isFinite(Number(tech.rsi))) ||
    (tech.ema20 != null && isFinite(Number(tech.ema20))) ||
    (tech.macdHistogram != null && isFinite(Number(tech.macdHistogram))) ||
    (tech.orderBookImbalance != null && isFinite(Number(tech.orderBookImbalance)))
  );
  const hasFutDetail = fut != null && (
    fut.fundingBps != null || fut.lsrTaker != null || fut.openInterestUsd != null ||
    fut.longLiqUsd != null || fut.shortLiqUsd != null || fut.volume24hUsd != null
  );
  const dataHealth = Array.isArray(result?.dataHealth) ? result.dataHealth : [];
  const failedHealth = dataHealth.filter((d) => !d.ok);
  const llmGaps: string[] = Array.isArray(ai?.dataGaps) ? ai.dataGaps : [];

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
                {(jevConfigured || openrouterConfigured) && (
                  <span
                    className="px-2 py-0.5 rounded border text-[10px] font-mono font-bold bg-violet-500/15 text-violet-300 border-violet-500/30"
                    title={[
                      jevConfigured ? "JEV ZEN terkonfigurasi" : null,
                      openrouterConfigured ? "OPENROUTER terkonfigurasi" : null,
                    ].filter(Boolean).join(" • ")}
                  >
                    JEV {jevConfigured ? (openrouterConfigured ? "ZEN+OR" : "ZEN") : "OR"}
                  </span>
                )}
              </h2>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
                {isAi
                  ? "Insight naratif AI — penasihat, bukan eksekutor"
                  : "Tanpa Gemini — insight deterministik dari keel"}
                {fetchedAgeMin != null && (
                  <>
                    {" "}— diperbarui{" "}
                    {fetchedAgeMin < 1 ? "<1m" : fetchedAgeMin < 60 ? `${fetchedAgeMin}m` : `${Math.floor(fetchedAgeMin / 60)}h ${fetchedAgeMin % 60}m`} lalu
                  </>
                )}
                {usingCache && (
                  <span className="ml-1 px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[9px] font-bold font-mono align-middle">
                    cache aktif
                  </span>
                )}
                {loading && result && (
                  <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[9px] font-bold font-mono align-middle">
                    refreshing…
                  </span>
                )}
              </p>
            </div>
          </div>
          <button type="button"
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
          {!loading && (
            <span className="hidden sm:inline text-[9px] font-mono text-zinc-600" title="Dalam cooldown, membuka panel memakai cache tanpa hit ulang. Tombol Minta Insight memaksa refresh.">
              cache {cooldownMin}m / TF {String(timeframe).toUpperCase()}
            </span>
          )}
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
            {/* DATA HEALTH — konfirmasi sumber per pilar (LLM wajib akui yang GAGAL) */}
            {dataHealth.length > 0 && (
              <div className={`rounded-xl border p-3 ${failedHealth.length > 0 ? "bg-amber-950/30 border-amber-500/40" : "bg-emerald-950/20 border-emerald-500/30"}`}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className={`text-[10px] font-mono uppercase tracking-wider font-bold ${failedHealth.length > 0 ? "text-amber-300" : "text-emerald-300"}`}>
                    Status Data {failedHealth.length > 0 ? `— ${failedHealth.length} sumber GAGAL` : "— semua OK"}
                  </p>
                  {result.model && (
                    <span className="px-1.5 py-0.5 rounded border border-zinc-700 bg-zinc-900 text-[9px] font-mono text-zinc-400">
                      {result.model}
                    </span>
                  )}
                  {result.decisionSource && (
                    <span
                      className={`px-1.5 py-0.5 rounded border text-[9px] font-mono font-bold ${
                        result.decisionSource === "keel"
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                          : result.decisionSource === "gemini"
                            ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
                            : "border-violet-500/40 bg-violet-500/10 text-violet-300"
                      }`}
                      title="Provider keputusan terstruktur"
                    >
                      decide: {result.decisionSource}
                    </span>
                  )}
                </div>
                <div className="grid gap-1">
                  {dataHealth.map((d) => {
                    // F-08: state visual ketiga — ok:true tapi detail simulasi/no-data
                    // = PARTIAL (kuning pudar), bukan hijau solid. Hijau hanya untuk real.
                    const detailLower = String(d.detail || "").toLowerCase();
                    const isPartial = d.ok && (
                      detailLower.includes("simulasi") ||
                      detailLower.includes("no-data") ||
                      detailLower.includes("tanpa anchor")
                    );
                    const dotCls = !d.ok ? "bg-amber-400 animate-pulse" : isPartial ? "bg-yellow-200" : "bg-emerald-400";
                    const labelCls = !d.ok ? "text-amber-300" : isPartial ? "text-yellow-200" : "text-zinc-300";
                    const textCls = !d.ok ? "text-amber-200" : isPartial ? "text-yellow-100/80" : "text-zinc-400";
                    return (
                      <div key={d.source} className="flex items-start gap-2 font-mono text-[11px]">
                        <span className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${dotCls}`} />
                        <span className={`font-bold uppercase w-24 shrink-0 ${labelCls}`}>
                          {d.source}{isPartial ? " ~" : ""}
                        </span>
                        <span className={textCls}>{d.detail}</span>
                      </div>
                    );
                  })}
                </div>
                {isAi && llmGaps.length > 0 && (
                  <p className="mt-2 text-[10px] font-mono text-cyan-300">
                    LLM konfirmasi gap: {llmGaps.join(", ")}
                  </p>
                )}
                {isAi && failedHealth.length > 0 && llmGaps.length === 0 && (
                  <p className="mt-2 text-[10px] font-mono text-rose-300">
                    Peringatan: LLM tidak mengembalikan dataGaps — anggap insight terdegradasi.
                  </p>
                )}
              </div>
            )}
            {/* STRATEGIC RECOMMENDATION — Headline Arahan */}
            {ai?.suggestedBias && (
              <div className={`mb-4 rounded-2xl border-4 p-5 flex items-center justify-between shadow-[0_0_30px_rgba(0,0,0,0.5)] ${
                ai.suggestedBias === "LONG" || ai.suggestedBias === "BULLISH" ? "bg-emerald-950/60 border-emerald-500/80 shadow-emerald-500/20" :
                ai.suggestedBias === "SHORT" || ai.suggestedBias === "BEARISH" ? "bg-rose-950/60 border-rose-500/80 shadow-rose-500/20" :
                "bg-zinc-900/80 border-zinc-600/50"
              }`}>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-zinc-400 font-black">Strategic Guidance</p>
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-[9px] text-zinc-500 font-bold border border-zinc-700">SWING 4H</span>
                  </div>
                  <h3 className={`text-3xl font-black font-mono tracking-tighter uppercase leading-none ${
                    ai.suggestedBias === "LONG" || ai.suggestedBias === "BULLISH" ? "text-emerald-400" :
                    ai.suggestedBias === "SHORT" || ai.suggestedBias === "BEARISH" ? "text-rose-400" :
                    "text-zinc-100"
                  }`}>
                    {ai.suggestedBias === "LONG" || ai.suggestedBias === "BULLISH" ? "INSTITUTIONAL LONG" :
                     ai.suggestedBias === "SHORT" || ai.suggestedBias === "BEARISH" ? "INSTITUTIONAL SHORT" :
                     "WAIT & OBSERVE"}
                  </h3>
                  <p className="text-[10px] font-medium text-zinc-500 italic">Targeting liquidity pools (BSL/SSL)</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className={`text-sm font-mono font-black px-4 py-1.5 rounded-full border-2 shadow-sm ${biasBadge(ai.suggestedBias).cls}`}>
                    {biasBadge(ai.suggestedBias).label}
                  </span>
                  <div className="flex gap-1">
                    {[1,2,3].map(i => (
                      <div key={i} className={`w-1.5 h-1.5 rounded-full ${
                        ai.suggestedBias === "NEUTRAL" ? "bg-zinc-700" :
                        ai.suggestedBias === "LONG" || ai.suggestedBias === "BULLISH" ? "bg-emerald-500 animate-pulse" : "bg-rose-500 animate-pulse"
                      }`} style={{ animationDelay: `${i*0.2}s` }} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* TIKET INTRADAY (ADV-01) — isi form order, tanpa auto-submit */}
            {result && (
              <div className="rounded-xl bg-zinc-950/70 border border-zinc-800 p-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-[10px] font-mono text-zinc-500">
                  <span className="uppercase tracking-wider font-bold text-zinc-400">Tiket Intraday (WIB)</span>
                  {intradayDraft ? (
                    <span className="block mt-0.5 text-zinc-400">
                      {intradayDraft.side} {intradayDraft.symbol} · Entry ${Number(intradayDraft.entry).toFixed(2)} · SL $
                      {Number(intradayDraft.stopLoss).toFixed(2)} / TP ${Number(intradayDraft.takeProfit).toFixed(2)} · time-stop{" "}
                      {INTRADAY_HOLD_MS_FE_HINT / 3_600_000}h dari fill ({patchTime}).
                    </span>
                  ) : (
                    <span className="block mt-0.5 text-zinc-600">
                      Bias NEUTRAL / keyLevels belum lengkap / SPOT-SHORT → tidak ada draft yang valid.
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  disabled={!intradayDraft}
                  onClick={fillIntradayTicket}
                  className="rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 px-3 py-1.5 text-[11px] font-mono font-bold hover:bg-cyan-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  title="Isi form Order Entry dengan level dari insight ini — eksekusi tetap manual (dilarang auto-submit)."
                >
                  Isi Tiket Intraday
                </button>
                {ticketNote && <p className="w-full text-[10px] font-mono text-emerald-400/90">{ticketNote}</p>}
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
                    BIAS: {biasBadge(ai.suggestedBias).label}
                  </span>
                )}
              </div>
              <p className="text-sm text-zinc-200 leading-relaxed font-sans">{ai?.insight}</p>
              {result.mode === "keel" && (
                <p className="text-[10px] font-mono text-amber-400/80">
                  {result.aiDisabledReason === "KEY_LEGACY_REVOKED"
                    ? "Key AIza lama dicabut Google — ganti key baru (format AQ.x) di .env lalu restart server."
                    : result.aiDisabledReason === "AI_CALL_FAILED"
                      ? "Gemini gagal dihubungi (transien/overload) — tekan Minta Insight untuk retry."
                      : "Set GEMINI_API_KEY lalu refresh untuk insight AI lanjutan (on-chain + makro)."}
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

                {/* TEKNIKAL MULTI-TF — tiap TF dilabel eksplisit (15m/1h/4h) */}
                {(hasMultiTf || hasTech) && (
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-bold mb-1.5">
                      Teknikal per Timeframe (RSI/EMA/MACD)
                    </p>
                    {hasMultiTf && multiTf ? (
                      <div className="grid gap-2">
                        {TF_ORDER.map((tf) => {
                          const t = multiTf[tf];
                          return (
                            <div key={tf} className="rounded-lg bg-zinc-900 border border-zinc-800 p-2">
                              <div className="flex items-center gap-2 mb-1.5">
                                <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-[10px] font-mono font-black">
                                  TF {tf}
                                </span>
                                <span className="text-[10px] font-mono text-zinc-500">{TF_ROLE[tf]}</span>
                                {t?.trend && (
                                  <span className={`ml-auto px-1.5 py-0.5 rounded border text-[10px] font-mono font-bold ${t.trend === "UP" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : t.trend === "DOWN" ? "bg-rose-500/15 text-rose-300 border-rose-500/30" : "bg-zinc-800 text-zinc-400 border-zinc-700"}`}>
                                    {t.trend}
                                  </span>
                                )}
                              </div>
                              {t ? (
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
                                  <div>
                                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">RSI 14</span>
                                    <span className={`text-sm font-bold ${Number(t.rsi) < 30 ? "text-emerald-400" : Number(t.rsi) > 70 ? "text-rose-400" : "text-zinc-100"}`}>
                                      {t.rsi != null ? Number(t.rsi).toFixed(1) : "—"}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">EMA 20/50</span>
                                    <span className="text-sm font-bold text-zinc-100">
                                      {t.ema20 != null ? fmtPrice(Number(t.ema20)) : "—"}
                                      <span className="text-zinc-600"> / </span>
                                      {t.ema50 != null ? fmtPrice(Number(t.ema50)) : "—"}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">MACD hist</span>
                                    <span className={`text-sm font-bold ${Number(t.macdHistogram) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                      {t.macdHistogram != null ? (Number(t.macdHistogram) >= 0 ? "+" : "") + Number(t.macdHistogram).toFixed(2) : "—"}
                                    </span>
                                  </div>
                                  <div>
                                    <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Sumber candle</span>
                                    <span className="text-[11px] text-zinc-400">server klines</span>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-[11px] font-mono text-amber-300">TF {tf} GAGAL fetch — tidak dianalisis.</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                    tech && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-xs">
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 col-span-2 sm:col-span-3">
                        <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-[10px] font-mono font-black">TF 15m (legacy)</span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">RSI 14</span>
                        <span className={`text-sm font-bold ${Number(tech.rsi) < 30 ? "text-emerald-400" : Number(tech.rsi) > 70 ? "text-rose-400" : "text-zinc-100"}`}>
                          {tech.rsi != null && isFinite(Number(tech.rsi)) ? Number(tech.rsi).toFixed(1) : "—"}
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">EMA 20 / 50</span>
                        <span className="text-sm font-bold text-zinc-100">
                          {tech.ema20 != null && isFinite(Number(tech.ema20)) ? fmtPrice(Number(tech.ema20)) : "—"}
                          <span className="text-zinc-600"> / </span>
                          {tech.ema50 != null && isFinite(Number(tech.ema50)) ? fmtPrice(Number(tech.ema50)) : "—"}
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">MACD hist</span>
                        <span className={`text-sm font-bold ${Number(tech.macdHistogram) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {tech.macdHistogram != null && isFinite(Number(tech.macdHistogram)) ? Number(tech.macdHistogram).toFixed(2) : "—"}
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">OB Imbalance</span>
                        <span className="text-sm font-bold text-zinc-100">
                          {tech.orderBookImbalance != null && isFinite(Number(tech.orderBookImbalance)) ? Number(tech.orderBookImbalance).toFixed(2) : "—"}
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Volatilitas</span>
                        <span className="text-sm font-bold text-zinc-100">{tech.volatility ?? "—"}</span>
                      </div>
                    </div>
                    )
                    )}
                  </div>
                )}

                {/* FUTURES DETAIL — sebelumnya hanya funding yang tampil */}
                {hasFutDetail && fut && (
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-bold mb-1.5">
                      Futures Detail (Gate.io perp)
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-xs">
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Mark Price</span>
                        <span className="text-sm font-bold text-zinc-100">{fut.markPrice != null ? fmtPrice(Number(fut.markPrice)) : "—"}</span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">LSR Taker / Akun</span>
                        <span className="text-sm font-bold text-zinc-100">
                          {fut.lsrTaker != null ? Number(fut.lsrTaker).toFixed(2) : "—"}
                          <span className="text-zinc-600"> / </span>
                          {fut.lsrAccount != null ? Number(fut.lsrAccount).toFixed(2) : "—"}
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Liq LONG / SHORT</span>
                        <span className="text-sm font-bold text-zinc-100">
                          {fut.longLiqUsd != null ? `$${(Number(fut.longLiqUsd) / 1000).toFixed(0)}k` : "—"}
                          <span className="text-zinc-600"> / </span>
                          {fut.shortLiqUsd != null ? `$${(Number(fut.shortLiqUsd) / 1000).toFixed(0)}k` : "—"}
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 col-span-2 sm:col-span-3">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Bias Reason</span>
                        <span className="text-[11px] text-zinc-300">{fut.biasReason || "—"}</span>
                      </div>
                    </div>
                  </div>
                )}

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

                {/* MACRO REAL — FF mirror + VIX (sebelumnya selalu no-data) */}
                {macroReal && (
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 font-bold mb-1.5">
                      Makro Real ({macroReal.source})
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-xs">
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">VIX</span>
                        <span className={`text-sm font-bold ${macroReal.vix != null && macroReal.vix >= 30 ? "text-rose-400" : macroReal.vix != null && macroReal.vix >= 22 ? "text-amber-300" : "text-emerald-400"}`}>
                          {macroReal.vix != null ? Number(macroReal.vix).toFixed(2) : "—"}
                        </span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Risk Index</span>
                        <span className="text-sm font-bold text-amber-300">{macroReal.riskIndex}/100</span>
                      </div>
                      <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                        <span className="text-[10px] uppercase text-zinc-500 block font-semibold">HIGH upcoming</span>
                        <span className="text-sm font-bold text-zinc-100">{macroReal.upcomingCount}</span>
                      </div>
                      {macroReal.upcoming.slice(0, 3).map((e, i) => (
                        <div key={i} className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 col-span-2 sm:col-span-3">
                          <span className="text-[10px] uppercase text-zinc-500 block font-semibold">
                            {e.title} • {new Date(e.dateUtc).toLocaleString("id-ID")}
                          </span>
                          <span className="text-[11px] text-zinc-300">
                            forecast {e.forecast || "?"} vs prev {e.previous || "?"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ON-CHAIN + MACRO ECHO — sebelumnya panel buta konteks yang dikirimnya */}
                {(result.onChainEcho || result.macroEcho) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-[11px]">
                    {result.onChainEcho && (
                      <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col gap-0.5">
                        <span className="text-zinc-500 text-[10px] uppercase font-bold">On-chain dipakai LLM</span>
                        <span className="text-zinc-200">{result.onChainEcho.smartMoneyBias || "—"} <span className="text-zinc-500">({result.onChainEcho.netflowStatus || "?"})</span></span>
                        <span className="text-zinc-400">SOPR {result.onChainEcho.sopr ?? "—"} ({result.onChainEcho.soprStatus || "?"}) • conf {result.onChainEcho.onChainConfidence ?? "—"}%</span>
                      </div>
                    )}
                    {result.macroEcho && (
                      <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col gap-0.5">
                        <span className="text-zinc-500 text-[10px] uppercase font-bold">Makro dipakai LLM</span>
                        <span className="text-zinc-200">{result.macroEcho.upcomingHighImpactCount ?? "—"} high-impact upcoming{result.macroEcho.nearestEventImpact ? ` • ${result.macroEcho.nearestEventImpact}` : ""}</span>
                        <span className="text-zinc-400 whitespace-pre-wrap">{result.macroEcho.macroTradingAdvice || result.macroEcho.nearestEventImplication || "—"}</span>
                      </div>
                    )}
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
