import React, { useState } from "react";
import { 
  MicroTick1s, 
  ExchangeFeedStatus 
} from "../types";
import { 
  Activity, 
  Download, 
  Cpu, 
  Database, 
  ArrowUpRight, 
  ArrowDownRight, 
  Radio, 
  Terminal, 
  TrendingUp, 
  Sliders, 
  Sparkles,
  Layers
} from "lucide-react";
import { exportMLDataCSV, exportMLDataJSON } from "../logic/microTickStream";

interface Realtime1sMLFeedProps {
  ticks: MicroTick1s[];
  currentPrice: number;
  symbol: string;
  exchangeStatus?: ExchangeFeedStatus;
}

export const Realtime1sMLFeed: React.FC<Realtime1sMLFeedProps> = ({
  ticks,
  currentPrice,
  symbol,
  exchangeStatus,
}) => {
  const [activeSubTab, setActiveSubTab] = useState<"ticks" | "tensors" | "docs">("ticks");
  const latestTick = ticks[ticks.length - 1];

  // Calculate quick tick statistics
  const buyAggressors = ticks.filter((t) => t.tickDirection === "BUY_AGGRESSOR").length;
  const sellAggressors = ticks.length - buyAggressors;
  const buyRatio = ticks.length > 0 ? ((buyAggressors / ticks.length) * 100).toFixed(1) : "50.0";

  // Min and max for the 1s sparkline
  const prices = ticks.map((t) => t.close);
  const minP = prices.length > 0 ? Math.min(...prices) : currentPrice * 0.999;
  const maxP = prices.length > 0 ? Math.max(...prices) : currentPrice * 1.001;
  const rangeP = maxP - minP || 1;

  return (
    <div className="space-y-4 font-sans">
      {/* Top Banner: Clear Separation of 1s Data Stream vs 15m Execution */}
      <div className="bg-gradient-to-r from-cyan-950/50 via-zinc-900 to-indigo-950/40 border border-cyan-500/30 rounded-2xl p-4 sm:p-5 shadow-lg relative overflow-hidden">
        <div className="absolute right-0 top-0 translate-x-8 -translate-y-8 w-44 h-44 bg-cyan-500/10 rounded-full blur-2xl pointer-events-none" />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="px-2.5 py-0.5 rounded-md bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 text-[10px] font-mono font-bold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
                1-SECOND HIGH-FREQUENCY FEED
              </span>
              <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 text-[10px] font-mono border border-zinc-700">
                1000ms SAMPLING INTERVAL
              </span>
              <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[10px] font-mono font-bold border border-amber-500/30">
                AGENT EXECUTION: STRICTLY 15m MTF
              </span>
            </div>
            <h2 className="text-lg sm:text-xl font-bold text-zinc-100 font-sans tracking-tight">
              Real-Time 1s Data Feeder & Machine Learning Feature Store
            </h2>
            <p className="text-xs text-zinc-400 mt-1 max-w-2xl leading-relaxed">
              Feed harga dan order flow dicatat setiap <strong>1 detik</strong> untuk kebutuhan rekam data kuantitatif & pipeline <strong>Machine Learning (Feature Store)</strong>, sementara agent AI tetap berfokus mengeksekusi sinyal pada timeframe <strong>15m</strong> guna memfilter noise pasar.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => exportMLDataCSV(ticks, symbol)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-zinc-950 font-bold font-mono text-xs shadow-md shadow-cyan-600/20 transition"
              title="Download 1-second dataset as CSV"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
            <button
              onClick={() => exportMLDataJSON(ticks, symbol)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 font-mono text-xs transition"
              title="Download ML Feature Vector Tensors as JSON"
            >
              <Database className="w-3.5 h-3.5 text-cyan-400" />
              <span>Export Tensors</span>
            </button>
          </div>
        </div>
      </div>

      {/* Metric Cards Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card 1: 1s Live Price & Micro-Delta */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-3.5">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] font-mono mb-1">
            <span>1s LIVE PRICE</span>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-zinc-100">
            ${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
          <div className="flex items-center gap-1.5 mt-1 text-xs font-mono">
            {latestTick?.tickDirection === "BUY_AGGRESSOR" ? (
              <span className="text-emerald-400 font-bold flex items-center">
                <ArrowUpRight className="w-3 h-3" /> +${(latestTick.close - latestTick.open).toFixed(2)} (1s)
              </span>
            ) : (
              <span className="text-rose-400 font-bold flex items-center">
                <ArrowDownRight className="w-3 h-3" /> ${(latestTick ? latestTick.close - latestTick.open : 0).toFixed(2)} (1s)
              </span>
            )}
            <span className="text-zinc-500 text-[10px]">Spread: ${latestTick?.microSpreadUSD || "0.45"}</span>
          </div>
        </div>

        {/* Card 2: Micro Flow Imbalance */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-3.5">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] font-mono mb-1">
            <span>1s FLOW AGGRESSION</span>
            <Activity className="w-3.5 h-3.5 text-cyan-400" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-cyan-400">
            {buyRatio}% <span className="text-xs text-zinc-400 font-normal">BUY</span>
          </div>
          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden flex">
            <div className="bg-emerald-500 h-full" style={{ width: `${buyRatio}%` }} />
            <div className="bg-rose-500 h-full" style={{ width: `${100 - Number(buyRatio)}%` }} />
          </div>
        </div>

        {/* Card 3: Rolling Micro-Volatility */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-3.5">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] font-mono mb-1">
            <span>10s ROLLING VOLATILITY</span>
            <Sliders className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-amber-400">
            ±${latestTick?.mlVector?.rollingVol10s || "0.00"}
          </div>
          <div className="text-[10px] text-zinc-500 font-mono mt-1">
            Standard deviation on micro-ticks
          </div>
        </div>

        {/* Card 4: ML Buffer & Source */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-3.5">
          <div className="flex items-center justify-between text-zinc-400 text-[11px] font-mono mb-1">
            <span>DATA STORE BUFFER</span>
            <Cpu className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-purple-400">
            {ticks.length} <span className="text-xs text-zinc-400 font-normal">Ticks</span>
          </div>
          <div className="text-[10px] text-zinc-500 font-mono mt-1">
            {exchangeStatus?.source || "BINANCE_LIVE"} &bull; {exchangeStatus?.latencyMs || 12}ms
          </div>
        </div>
      </div>

      {/* Real-time 1s Sparkline Tape (Last 60 Ticks) */}
      <div className="bg-zinc-900/80 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            <span className="text-xs font-mono font-bold text-zinc-300 uppercase tracking-wider">
              1-Second Micro Tick Tape ({symbol})
            </span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-400">
            <span>Low: ${minP.toFixed(2)}</span>
            <span>High: ${maxP.toFixed(2)}</span>
            <span className="text-cyan-400 font-bold">Window: {ticks.length}s</span>
          </div>
        </div>

        {/* SVG Sparkline */}
        <div className="h-28 w-full bg-zinc-950 rounded-lg p-2 relative overflow-hidden border border-zinc-800/80">
          <div className="absolute inset-0 opacity-15 pointer-events-none bento-dot-grid" />
          <svg className="w-full h-full overflow-visible" preserveAspectRatio="none" viewBox={`0 0 ${Math.max(10, ticks.length - 1)} 100`}>
            <defs>
              <linearGradient id="cyanLineGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Area Fill */}
            {ticks.length > 1 && (
              <polygon
                fill="url(#cyanLineGrad)"
                points={`
                  0,100 
                  ${ticks.map((t, idx) => {
                    const y = 90 - ((t.close - minP) / rangeP) * 80;
                    return `${idx},${y}`;
                  }).join(" ")}
                  ${ticks.length - 1},100
                `}
              />
            )}

            {/* Polyline */}
            {ticks.length > 1 && (
              <polyline
                fill="none"
                stroke="#06b6d4"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={ticks.map((t, idx) => {
                  const y = 90 - ((t.close - minP) / rangeP) * 80;
                  return `${idx},${y}`;
                }).join(" ")}
              />
            )}

            {/* Latest point circle */}
            {ticks.length > 0 && (
              <circle
                cx={ticks.length - 1}
                cy={90 - ((latestTick.close - minP) / rangeP) * 80}
                r="4"
                fill="#22d3ee"
                className="animate-pulse"
              />
            )}
          </svg>
        </div>
      </div>

      {/* Tabs for Detailed View: 1s Ticks Table vs ML Feature Vector Tensors */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-1.5 bg-zinc-950 p-1 rounded-xl border border-zinc-800 font-mono text-xs">
            <button
              onClick={() => setActiveSubTab("ticks")}
              className={`px-3 py-1 rounded-lg transition font-semibold flex items-center gap-1.5 ${
                activeSubTab === "ticks"
                  ? "bg-zinc-800 text-cyan-300 border border-zinc-700"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Live Tick Stream ({ticks.length})</span>
            </button>
            <button
              onClick={() => setActiveSubTab("tensors")}
              className={`px-3 py-1 rounded-lg transition font-semibold flex items-center gap-1.5 ${
                activeSubTab === "tensors"
                  ? "bg-zinc-800 text-purple-300 border border-zinc-700"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>ML Feature Vector (7D Tensor)</span>
            </button>
            <button
              onClick={() => setActiveSubTab("docs")}
              className={`px-3 py-1 rounded-lg transition font-semibold flex items-center gap-1.5 ${
                activeSubTab === "docs"
                  ? "bg-zinc-800 text-amber-300 border border-zinc-700"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Model Integration Guide</span>
            </button>
          </div>

          <div className="text-[11px] font-mono text-zinc-500">
            Buffer: <strong className="text-zinc-300">{ticks.length} / 120 ticks</strong>
          </div>
        </div>

        {/* Sub-view 1: Live Ticks Table */}
        {activeSubTab === "ticks" && (
          <div className="overflow-x-auto max-h-96">
            <table className="w-full text-left font-mono text-xs">
              <thead className="sticky top-0 bg-zinc-900 border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
                <tr>
                  <th className="pb-2">TIME (1s)</th>
                  <th className="pb-2">PRICE ($)</th>
                  <th className="pb-2">OPEN</th>
                  <th className="pb-2">HIGH/LOW</th>
                  <th className="pb-2">FLOW</th>
                  <th className="pb-2">VOLUME</th>
                  <th className="pb-2">IMBALANCE</th>
                  <th className="pb-2 text-right">ML TENSOR PREVIEW</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {[...ticks].reverse().slice(0, 30).map((t) => {
                  const isUp = t.tickDirection === "BUY_AGGRESSOR";
                  return (
                    <tr key={t.id} className="hover:bg-zinc-800/30 transition">
                      <td className="py-2 text-zinc-400 text-[11px]">{t.timeString}</td>
                      <td className="py-2 font-bold text-zinc-100">
                        ${t.close.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-2 text-zinc-400">${t.open.toFixed(2)}</td>
                      <td className="py-2 text-zinc-400 text-[11px]">
                        ${t.high.toFixed(1)} / ${t.low.toFixed(1)}
                      </td>
                      <td className="py-2">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            isUp
                              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                              : "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                          }`}
                        >
                          {isUp ? "BUY" : "SELL"}
                        </span>
                      </td>
                      <td className="py-2 text-zinc-300">{t.volume}</td>
                      <td className={`py-2 font-mono ${t.orderFlowImbalance >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {t.orderFlowImbalance > 0 ? "+" : ""}{t.orderFlowImbalance}
                      </td>
                      <td className="py-2 text-right text-[10px] text-zinc-500 font-mono">
                        [{t.mlVector.normPriceDelta}, {t.mlVector.rollingVol10s}, {t.mlVector.mtf15mRsi}]
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Sub-view 2: ML Feature Vector Matrix */}
        {activeSubTab === "tensors" && (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 font-mono text-xs">
              <div className="flex items-center justify-between text-zinc-400 text-[11px] mb-2 border-b border-zinc-800/80 pb-2">
                <span className="text-purple-300 font-bold flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5" />
                  CURRENT 1-SECOND FEATURE VECTOR (X_t)
                </span>
                <span className="text-[10px] text-zinc-500">Shape: [1, 7] float32</span>
              </div>

              {latestTick ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 text-center mt-2">
                  <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                    <span className="text-[9px] text-zinc-500 uppercase block">Norm Delta</span>
                    <span className="text-xs font-bold text-cyan-400">{latestTick.mlVector.normPriceDelta}</span>
                  </div>
                  <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                    <span className="text-[9px] text-zinc-500 uppercase block">Roll Vol (10s)</span>
                    <span className="text-xs font-bold text-amber-400">{latestTick.mlVector.rollingVol10s}</span>
                  </div>
                  <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                    <span className="text-[9px] text-zinc-500 uppercase block">Order Flow</span>
                    <span className="text-xs font-bold text-emerald-400">{latestTick.mlVector.imbalanceRatio}</span>
                  </div>
                  <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                    <span className="text-[9px] text-zinc-500 uppercase block">Anchor 15m RSI</span>
                    <span className="text-xs font-bold text-indigo-400">{latestTick.mlVector.mtf15mRsi}</span>
                  </div>
                  <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                    <span className="text-[9px] text-zinc-500 uppercase block">MTF Sweep Flag</span>
                    <span className="text-xs font-bold text-rose-400">{latestTick.mlVector.sweepFlag}</span>
                  </div>
                  <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                    <span className="text-[9px] text-zinc-500 uppercase block">Whale Flow Z</span>
                    <span className="text-xs font-bold text-teal-400">{latestTick.mlVector.whaleNetflowZ}</span>
                  </div>
                  <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
                    <span className="text-[9px] text-zinc-500 uppercase block">Macro Risk</span>
                    <span className="text-xs font-bold text-amber-300">{latestTick.mlVector.macroRiskIndex}</span>
                  </div>
                </div>
              ) : (
                <div className="text-zinc-500 text-center py-4">Menunggu tick pertama...</div>
              )}
            </div>

            {/* Code Snippet for Python ML Ingestion */}
            <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 font-mono text-xs">
              <div className="text-zinc-400 text-[11px] mb-2 flex items-center justify-between">
                <span>Contoh Skrip Integrasi Python / PyTorch / Scikit-Learn:</span>
                <span className="text-emerald-400">REST / WebSocket Ready</span>
              </div>
              <pre className="text-[11px] text-zinc-300 bg-zinc-900/80 p-3 rounded-lg overflow-x-auto leading-relaxed">
{`import pandas as pd
import torch
import torch.nn as nn

# 1. Load exported 1s CSV dataset
df = pd.read_csv("ML_Feed_1s_${symbol.replace("/", "_")}.csv")

# 2. Extract feature columns (7D Vector)
feature_cols = [
    'ml_normPriceDelta', 'ml_rollingVol10s', 'ml_imbalanceRatio',
    'ml_mtf15mRsi', 'ml_sweepFlag', 'ml_whaleNetflowZ', 'ml_macroRiskIndex'
]
X = torch.tensor(df[feature_cols].values, dtype=torch.float32)

# 3. Shape ready for LSTM / Transformer / XGBoost
print("Loaded feature tensor shape:", X.shape)  # e.g. [120, 7]`}
              </pre>
            </div>
          </div>
        )}

        {/* Sub-view 3: Model Integration Guide */}
        {activeSubTab === "docs" && (
          <div className="space-y-3 font-mono text-xs text-zinc-300">
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 leading-relaxed">
              <h4 className="text-cyan-400 font-bold text-sm mb-2 font-sans">
                Kenapa Data Feed 1s dan Eksekusi 15m Dipisahkan?
              </h4>
              <p className="text-zinc-400 text-xs mb-3">
                Arsitektur ini dirancang khusus untuk memenuhi standar <strong>Quantitative Trading System</strong> tingkat institusi:
              </p>
              <ul className="list-disc pl-5 space-y-2 text-xs text-zinc-300">
                <li>
                  <strong className="text-zinc-100">1s Real-Time Sampling untuk Machine Learning:</strong> Model ML (seperti LSTM, Transformer, atau Gradient Boosting) memerlukan densitas data tinggi (tick-level volatility, micro-spread, micro order flow) untuk melatih model prediksi pergerakan harga mikro dan estimasi slippage.
                </li>
                <li>
                  <strong className="text-zinc-100">15m Tactical Execution untuk Trading Agent:</strong> Eksekusi order swing/positional pada 15m Futures atau 4h Spot menjaga agent dari <em>whipsaw</em> (fakeout) dan fee churning akibat false break di timeframe 1 detik.
                </li>
                <li>
                  <strong className="text-zinc-100">Zero Leakage Feature Store:</strong> Setiap baris data 1s di-export dengan penanda waktu epoch ISO yang konsisten sehingga data training ML tidak mengalami lookahead bias.
                </li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
