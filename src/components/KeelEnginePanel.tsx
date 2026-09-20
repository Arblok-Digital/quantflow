import React from "react";
import { Zap, Activity, ShieldCheck, ShieldAlert, Target, TrendingUp, TrendingDown, PauseCircle, Clock, Layers } from "lucide-react";

export interface KeelAnalysisResult {
  action: string;
  confidence: number;
  targetPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  positionSizePercent?: number;
  reasoning?: string;
  rawSignal?: { signal: string | null; discardedReason?: string; compositeScore?: number; smartMoneyFlow?: string; liquidityDepthUsd?: number };
  riskGate?: { passed: boolean; reasons?: string[] };
  liquidityHuntAnalysis?: { targetPool?: string; targetZonePrice?: number; sweepTriggered?: boolean; mtfBias?: string; confluenceScore?: number; invalidationLevel?: number };
  futuresAnalysis?: {
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
    bias?: string;
    biasReason?: string;
    source?: string;
  };
  source?: string;
  inferenceLatencyMs?: number;
  promptSummary?: string;
}

interface KeelEnginePanelProps {
  result: KeelAnalysisResult | null;
  loading: boolean;
  onAnalyze: () => void;
}

function actionBadge(action: string) {
  const a = String(action || "HOLD").toUpperCase();
  if (a === "BUY" || a === "LONG") return { label: "BUY", cls: "bg-emerald-500 text-zinc-950 border-emerald-600", icon: <TrendingUp className="w-3.5 h-3.5" /> };
  if (a === "SELL" || a === "SHORT") return { label: "SELL", cls: "bg-rose-500 text-white border-rose-600", icon: <TrendingDown className="w-3.5 h-3.5" /> };
  return { label: "HOLD", cls: "bg-amber-500 text-zinc-950 border-amber-600", icon: <PauseCircle className="w-3.5 h-3.5" /> };
}

export const KeelEnginePanel: React.FC<KeelEnginePanelProps> = ({ result, loading, onAnalyze }) => {
  const badge = result ? actionBadge(result.action) : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm relative overflow-hidden">
      <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />
      <div className="absolute right-0 top-0 translate-x-10 -translate-y-10 w-48 h-48 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
      <div className="relative z-10 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-amber-500/15 rounded-xl flex items-center justify-center text-amber-400 border border-amber-500/30">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                Keel Engine
                <span className="px-2 py-0.5 rounded border text-[10px] font-mono font-bold bg-amber-500/15 text-amber-300 border-amber-500/30">INSTITUTIONAL QUANT</span>
              </h2>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Decision Engine Router — AI server atau Keel quant lokal</p>
            </div>
          </div>
          <button type="button"
            onClick={onAnalyze}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-zinc-950 font-bold font-mono text-xs shadow-md shadow-amber-500/20 border border-amber-600 disabled:border-zinc-700 transition"
          >
            {loading ? <span className="w-3 h-3 border-2 border-zinc-700 border-t-amber-500 rounded-full animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {loading ? "Menganalisis..." : "Evaluasi Keel Engine"}
          </button>
        </div>

        {!result && !loading && (
          <div className="flex flex-col items-center justify-center py-8 text-center bg-zinc-950/60 rounded-xl border border-dashed border-zinc-800">
            <Activity className="w-7 h-7 text-zinc-600 mb-2" />
            <p className="text-xs font-mono text-zinc-400">Belum ada hasil analisis — tekan Evaluasi Keel Engine untuk menjalankan quant engine.</p>
            <p className="text-[10px] font-mono text-zinc-600 mt-1">Satu decision engine (router dua-mode) — hasil dari AI server atau Keel quant lokal (source label menandai yang decide)</p>
          </div>
        )}

        {loading && !result && (
          <div className="flex items-center justify-center py-10 text-center bg-zinc-950/60 rounded-xl border border-zinc-800">
            <span className="flex items-center gap-2 text-xs font-mono text-zinc-400">
              <span className="w-3 h-3 border-2 border-zinc-700 border-t-amber-400 rounded-full animate-spin" />
              Menjalankan Keel Engine...
            </span>
          </div>
        )}

        {result && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-black font-mono ${badge!.cls}`}>
                {badge!.icon}
                {badge!.label}
              </span>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-black font-mono text-amber-400">{Math.round(Number(result.confidence || 0))}%</span>
                <span className="text-xs font-mono text-zinc-500">confidence</span>
              </div>
              {result.inferenceLatencyMs != null && (
                <span className="ml-auto px-2 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-cyan-400 flex items-center gap-1">
                  <Clock className="w-3 h-3" /> {result.inferenceLatencyMs}ms
                </span>
              )}
            </div>

            {/* KESIMPULAN / VERDICT */}
            {(() => {
              const a = String(result.action || "HOLD").toUpperCase();
              const isLong = a === "BUY" || a === "LONG";
              const isShort = a === "SELL" || a === "SHORT";
              const isHold = a === "HOLD" || (!isLong && !isShort);
              const dirLabel = isLong ? "LONG" : isShort ? "SHORT" : "NETRAL";
              const dirColor = isLong ? "emerald" : isShort ? "rose" : "amber";
              const riskPassed = result.riskGate?.passed !== false;
              const riskBlocked = !!(result.riskGate && !result.riskGate.passed);
              const conf = Math.round(Number(result.confidence || 0));

              let recLabel: string;
              let recCls: string;
              if (isHold) {
                recLabel = "TUNGGU SINYAL";
                recCls = "bg-amber-500/15 text-amber-400 border-amber-500/30";
              } else if (riskBlocked) {
                recLabel = "JANGAN EKSEKUSI";
                recCls = "bg-rose-500/15 text-rose-400 border-rose-500/30";
              } else {
                recLabel = "SIAP EKSEKUSI";
                recCls = "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
              }

              const entry = result.targetPrice ?? ((result.stopLoss ?? 0) + (result.takeProfit ?? 0)) / 2;
              const rPct = result.stopLoss != null && entry > 0 ? Math.abs(entry - result.stopLoss) / entry * 100 : null;
              const vPct = result.takeProfit != null && entry > 0 ? Math.abs(result.takeProfit - entry) / entry * 100 : null;

              const fmtP = (n: number) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

              let conclusion: string;
              if (isHold) {
                const flow = result.rawSignal?.smartMoneyFlow ?? "tidak diketahui";
                const liq = result.rawSignal?.liquidityDepthUsd != null ? `$${(Number(result.rawSignal.liquidityDepthUsd) / 1000).toFixed(1)}k` : "tidak diketahui";
                const discarded = result.rawSignal?.discardedReason ?? "tidak ada sinyal spesifik";
                conclusion = `Belum ada sinyal institusional yang kuat. Flow ${flow}, kedalaman likuiditas ${liq}. ${discarded}. Saran: tunggu, jangan paksa entry.`;
              } else {
                const dir = isLong ? "LONG" : "SHORT";
                const slStr = result.stopLoss != null ? fmtP(result.stopLoss) : "—";
                const tpStr = result.takeProfit != null ? fmtP(result.takeProfit) : "—";
                const rStr = rPct != null ? `-${rPct.toFixed(1)}%` : "";
                const vStr = vPct != null ? `+${vPct.toFixed(1)}%` : "";
                const riskWord = riskPassed ? "lolos" : "DIBLOKIR";
                const reasoningShort = result.reasoning ? (result.reasoning.length > 120 ? result.reasoning.slice(0, 117) + "..." : result.reasoning) : "";
                conclusion = `Cenderung ${dir} dengan confidence ${conf}%. Masuk sekitar ${fmtP(entry)}, Stop Loss ${slStr} ${rStr}, Target ${tpStr} ${vStr}. Risk gate ${riskWord}.${reasoningShort ? " " + reasoningShort : ""}`;
              }

              const bdr: Record<string, string> = { emerald: "border-emerald-500/30", rose: "border-rose-500/30", amber: "border-amber-500/30" };
              const txt: Record<string, string> = { emerald: "text-emerald-400", rose: "text-rose-400", amber: "text-amber-400" };

              return (
                <div className={`rounded-xl bg-zinc-950/70 border ${bdr[dirColor]} p-4 space-y-3`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`text-4xl font-black font-mono ${txt[dirColor]}`}>{dirLabel}</span>
                    <span className={`inline-flex items-center px-3 py-1.5 rounded-lg border text-xs font-bold font-mono ${recCls}`}>{recLabel}</span>
                    <span className="text-xs font-mono text-zinc-500 ml-auto">{conf}% confidence</span>
                  </div>
                  {riskBlocked && result.riskGate?.reasons && result.riskGate.reasons.length > 0 && (
                    <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs font-mono">
                      {result.riskGate.reasons.join("; ")}
                    </div>
                  )}
                  <p className="text-sm text-zinc-300 leading-relaxed font-sans">{conclusion}</p>
                </div>
              );
            })()}

            {/* FUTURES DERIVATIVES — konteks institusional Gate.io perp */}
            {result.futuresAnalysis && (() => {
              const fa = result.futuresAnalysis;
              const fmtP = (n?: number) => n != null ? `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";
              const fmtUsd = (n?: number) => n != null ? `$${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—";
              const bias = String(fa.bias || "NEUTRAL").toUpperCase();
              const biasCls = bias === "BULLISH" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : bias === "BEARISH" ? "bg-rose-500/15 text-rose-400 border-rose-500/30" : "bg-amber-500/15 text-amber-400 border-amber-500/30";
              const fundingBps = fa.fundingBps;
              const fundingCls = fundingBps != null ? (fundingBps < 0 ? "text-emerald-400" : fundingBps > 0.5 ? "text-rose-400" : "text-amber-300") : "text-zinc-500";
              const longLiq = Number(fa.longLiqUsd || 0);
              const shortLiq = Number(fa.shortLiqUsd || 0);
              const maxLiq = Math.max(longLiq, shortLiq, 1);
              const longW = Math.max(6, Math.round(longLiq / maxLiq * 100));
              const shortW = Math.max(6, Math.round(shortLiq / maxLiq * 100));
              const liqMagnet = longLiq > shortLiq
                ? { txt: "↑ Magnet likuidasi LONG di atas", cls: "text-emerald-400" }
                : shortLiq > longLiq
                  ? { txt: "↓ Magnet likuidasi SHORT di bawah", cls: "text-rose-400" }
                  : { txt: "Likuidasi long/short seimbang", cls: "text-zinc-400" };
              const oiUsd = fa.openInterestUsd;
              const oiStr = oiUsd != null ? (oiUsd >= 1e9 ? `${(oiUsd / 1e9).toFixed(2)}B` : `$${(oiUsd / 1e6).toFixed(1)}M`) : "—";
              const oiSub = fa.openInterest != null ? `contracts: ${Number(fa.openInterest).toLocaleString()}` : "";

              return (
                <div className="rounded-xl bg-zinc-950/70 border border-zinc-800 p-3 space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold flex items-center gap-1">⚡ Futures Derivatives</p>
                    <span className="px-1.5 py-0.5 rounded border border-cyan-500/30 bg-cyan-500/10 text-[10px] font-mono font-bold text-cyan-300">{String(fa.source || "GATE_FUTURES")}</span>
                    <span title={fa.biasReason || "—"} className={`ml-auto inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-mono font-black ${biasCls} cursor-help`}>{bias}</span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
                    <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                      <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Funding / 8h</span>
                      <span className={`text-sm font-bold ${fundingCls}`}>{fundingBps != null ? `${fundingBps.toFixed(2)} bps` : "—"}</span>
                      <span className="text-[10px] text-zinc-600 block">crowded long &gt;5bps</span>
                    </div>
                    <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                      <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Open Interest</span>
                      <span className="text-sm font-bold text-zinc-100">{oiStr}</span>
                      {oiSub && <span className="text-[10px] text-zinc-600 block">{oiSub}</span>}
                    </div>
                    <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                      <span className="text-[10px] uppercase text-zinc-500 block font-semibold">LSR Taker</span>
                      <span className="text-sm font-bold text-zinc-100">{fa.lsrTaker != null ? fa.lsrTaker.toFixed(2) : "—"}</span>
                      <span className="text-[10px] text-zinc-600 block">acct: {fa.lsrAccount != null ? fa.lsrAccount.toFixed(2) : "—"}</span>
                    </div>
                    <div className="p-2 rounded-lg bg-zinc-900 border border-zinc-800">
                      <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Mark Price</span>
                      <span className="text-sm font-bold text-amber-300">{fmtP(fa.markPrice)}</span>
                      <span className="text-[10px] text-zinc-600 block">vol 24h: {fa.volume24hUsd != null ? `$${(fa.volume24hUsd / 1e6).toFixed(0)}M` : "—"}</span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider">
                      <span className="text-emerald-400 font-bold">Long Liq {fmtUsd(longLiq || undefined)}</span>
                      <span className="text-zinc-600">area likuidasi</span>
                      <span className="text-rose-400 font-bold">Short Liq {fmtUsd(shortLiq || undefined)}</span>
                    </div>
                    <div className="flex gap-1 h-2.5 rounded-full overflow-hidden bg-zinc-900 border border-zinc-800">
                      <div className={`bg-gradient-to-r from-emerald-700 to-emerald-500 ${longW > 0 ? "" : "opacity-0"}`} style={{ width: `${longW}%` }} />
                      <div className="w-px bg-zinc-700" />
                      <div className={`bg-gradient-to-r from-rose-700 to-rose-500 ${shortW > 0 ? "" : "opacity-0"}`} style={{ width: `${shortW}%` }} />
                    </div>
                    <p className={`text-[10px] font-mono font-bold ${liqMagnet.cls}`}>{liqMagnet.txt}</p>
                  </div>

                  {(fa.topLongSize != null || fa.topShortSize != null) && (
                    <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-zinc-400">
                      <span className="uppercase tracking-wider text-zinc-600">Top trader</span>
                      <span>long: <strong className="text-emerald-400">{fa.topLongSize != null ? Number(fa.topLongSize).toLocaleString() : "—"}</strong></span>
                      <span>short: <strong className="text-rose-400">{fa.topShortSize != null ? Number(fa.topShortSize).toLocaleString() : "—"}</strong></span>
                      {fa.topLsrSize != null && <span>top LSR: <strong className="text-zinc-100">{fa.topLsrSize.toFixed(2)}</strong></span>}
                    </div>
                  )}
                </div>
              );
            })()}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
              <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-[10px] uppercase text-zinc-500 block font-semibold">Target Price</span>
                <span className="text-sm font-bold text-zinc-100">{result.targetPrice != null ? `$${Number(result.targetPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-zinc-950 border border-rose-500/20">
                <span className="text-[10px] uppercase text-rose-400 block font-semibold flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> Stop Loss</span>
                <span className="text-sm font-bold text-rose-400">{result.stopLoss != null ? `$${Number(result.stopLoss).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-zinc-950 border border-emerald-500/20">
                <span className="text-[10px] uppercase text-emerald-400 block font-semibold flex items-center gap-1"><Target className="w-3 h-3" /> Take Profit</span>
                <span className="text-sm font-bold text-emerald-400">{result.takeProfit != null ? `$${Number(result.takeProfit).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-zinc-950 border border-amber-500/20">
                <span className="text-[10px] uppercase text-amber-400 block font-semibold flex items-center gap-1"><Layers className="w-3 h-3" /> Size %</span>
                <span className="text-sm font-bold text-amber-400">{result.positionSizePercent != null ? `${Number(result.positionSizePercent).toFixed(2)}%` : "—"}</span>
              </div>
            </div>

            {result.reasoning && (
              <div className="rounded-xl bg-zinc-950/70 border border-amber-500/20 p-3">
                <p className="text-[10px] font-mono uppercase tracking-wider text-amber-400 font-bold mb-1">Reasoning</p>
                <p className="text-xs text-zinc-300 leading-relaxed font-sans">{result.reasoning}</p>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3 space-y-2">
                <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold flex items-center gap-1"><Activity className="w-3 h-3 text-amber-400" /> Raw Signal</p>
                {!result.rawSignal ? (
                  <p className="text-[11px] font-mono text-zinc-500">Tidak ada rawSignal.</p>
                ) : (
                  <div className="space-y-1.5 font-mono text-[11px]">
                    {result.rawSignal.discardedReason ? (
                      <div className="px-2.5 py-2 rounded-lg bg-amber-950/30 border border-amber-500/30 text-amber-300">
                        <span className="font-bold">Filtered:</span> {result.rawSignal.discardedReason}
                      </div>
                    ) : (
                      <div className="px-2.5 py-1.5 rounded-lg bg-emerald-950/20 border border-emerald-500/20 text-emerald-300">
                        Signal: <strong>{String(result.rawSignal.signal ?? "—")}</strong>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex justify-between">
                        <span className="text-zinc-500">compositeScore</span>
                        <span className="text-amber-300 font-bold">{result.rawSignal.compositeScore != null ? Number(result.rawSignal.compositeScore).toFixed(2) : "—"}</span>
                      </div>
                      <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex justify-between">
                        <span className="text-zinc-500">liquidity $</span>
                        <span className="text-zinc-100 font-bold">{result.rawSignal.liquidityDepthUsd != null ? `$${(Number(result.rawSignal.liquidityDepthUsd) / 1000).toFixed(1)}k` : "—"}</span>
                      </div>
                    </div>
                    <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex justify-between">
                      <span className="text-zinc-500">smartMoneyFlow</span>
                      <span className="text-cyan-400 font-bold">{result.rawSignal.smartMoneyFlow ?? "—"}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-xl bg-zinc-950 border border-zinc-800 p-3 space-y-2">
                <p className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold flex items-center gap-1">
                  {result.riskGate?.passed ? <ShieldCheck className="w-3 h-3 text-emerald-400" /> : <ShieldAlert className="w-3 h-3 text-rose-400" />} Risk Gate
                  {result.riskGate && (
                    <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${result.riskGate.passed ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-rose-500/15 text-rose-400 border-rose-500/30"}`}>
                      {result.riskGate.passed ? "PASSED" : "BLOCKED"}
                    </span>
                  )}
                </p>
                {!result.riskGate ? (
                  <p className="text-[11px] font-mono text-zinc-500">Tidak ada riskGate.</p>
                ) : result.riskGate.reasons && result.riskGate.reasons.length > 0 ? (
                  <ul className="space-y-1">
                    {result.riskGate.reasons.map((r, i) => (
                      <li key={i} className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300">{r}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11px] font-mono text-zinc-400">{result.riskGate.passed ? "Semua risk check lolos." : "Diblokir — lihat reasons."}</p>
                )}
              </div>
            </div>

            {result.liquidityHuntAnalysis && (
              <div className="rounded-xl bg-zinc-950 border border-amber-500/20 p-3 space-y-2">
                <p className="text-[10px] font-mono uppercase tracking-wider text-amber-400 font-bold flex items-center gap-1"><Target className="w-3 h-3" /> Liquidity Hunt</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-[11px]">
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                    <span className="text-zinc-500 text-[10px] uppercase">targetPool</span>
                    <span className="text-amber-300 font-bold">{result.liquidityHuntAnalysis.targetPool ?? "—"}</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                    <span className="text-zinc-500 text-[10px] uppercase">zonePrice</span>
                    <span className="text-zinc-100 font-bold">{result.liquidityHuntAnalysis.targetZonePrice != null ? `$${Number(result.liquidityHuntAnalysis.targetZonePrice).toFixed(2)}` : "—"}</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                    <span className="text-zinc-500 text-[10px] uppercase">sweep</span>
                    <span className={`font-bold ${result.liquidityHuntAnalysis.sweepTriggered ? "text-emerald-400" : "text-zinc-400"}`}>{result.liquidityHuntAnalysis.sweepTriggered ? "TRIGGERED" : "PENDING"}</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                    <span className="text-zinc-500 text-[10px] uppercase">mtfBias</span>
                    <span className="text-zinc-200 font-bold">{result.liquidityHuntAnalysis.mtfBias ?? "—"}</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                    <span className="text-zinc-500 text-[10px] uppercase">confluence</span>
                    <span className="text-amber-300 font-bold">{result.liquidityHuntAnalysis.confluenceScore != null ? `${result.liquidityHuntAnalysis.confluenceScore}%` : "—"}</span>
                  </div>
                  <div className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex flex-col">
                    <span className="text-zinc-500 text-[10px] uppercase">invalidation</span>
                    <span className="text-rose-400 font-bold">{result.liquidityHuntAnalysis.invalidationLevel != null ? `$${Number(result.liquidityHuntAnalysis.invalidationLevel).toFixed(2)}` : "—"}</span>
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-zinc-800 font-mono text-[11px] text-zinc-500">
              <span>source: <strong className="text-amber-400">{result.source ?? "keel-institutional-quant"}</strong></span>
              {result.inferenceLatencyMs != null && <span>latency: <strong className="text-cyan-400">{result.inferenceLatencyMs}ms</strong></span>}
              {result.promptSummary && <span className="truncate max-w-[280px]" title={result.promptSummary}>prompt: {result.promptSummary}</span>}
            </div>

            {result.promptSummary && (
              <details className="rounded-lg bg-zinc-950 border border-zinc-800 font-mono">
                <summary className="px-3 py-2 text-[10px] text-zinc-400 hover:text-amber-400 cursor-pointer uppercase tracking-wider font-semibold select-none">Prompt Summary</summary>
                <p className="px-3 pb-2 text-[11px] text-zinc-400 whitespace-pre-wrap leading-relaxed">{result.promptSummary}</p>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default KeelEnginePanel;
