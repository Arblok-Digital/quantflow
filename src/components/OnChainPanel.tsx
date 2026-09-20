import React from "react";
import { OnChainMetrics, WhaleTransaction } from "../types";
import { getDataSourceMode } from "../data/provider";
import {
  Boxes,
  ArrowDownRight,
  ArrowUpRight,
  ShieldAlert,
  Layers,
  Activity,
  CheckCircle2,
  Wallet,
  TrendingUp,
  TrendingDown,
  ExternalLink,
  Sparkles
} from "lucide-react";

interface OnChainPanelProps {
  metrics: OnChainMetrics;
  onRefresh?: () => void;
}

export const OnChainPanel: React.FC<OnChainPanelProps> = ({ metrics, onRefresh }) => {
  const isNetflowOutflow = metrics.exchangeNetflow24hUSD < 0;
  // 4.9: Mode feed on-chain dari provider registry — REAL bila ada anchor blockchain.com atau mode "live".
  const onChainMode = getDataSourceMode("onChain");
  const hasRealAnchor = Boolean(metrics.realData);
  const isSimulated = !hasRealAnchor && onChainMode !== "live";
  const fetchTs = hasRealAnchor
    ? metrics.realData!.fetchedAt
    : typeof metrics.timestamp === "number" && metrics.timestamp > 0
    ? metrics.timestamp
    : null;
  const lastFetchAt = fetchTs
    ? new Date(fetchTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "--:--:--";
  /** Label sumber per pilar metrik (4.9): mana yang berasal dari anchor real, mana proyeksi deterministik. */
  const metricBadge = (real: boolean) => (
    <span
      className={`ml-auto text-[9px] font-mono uppercase font-bold px-1.5 py-0.5 rounded border ${
        real
          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
          : "bg-amber-500/10 text-amber-400 border-amber-500/20"
      }`}
    >
      {real ? "REAL" : "SIMULATED"}
    </span>
  );

  return (
    <div id="onchain-panel" className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
            <Boxes className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-slate-100 text-base">On-Chain Whale & Smart Money Radar</h3>
              {metrics.realData ? (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold bg-sky-500/10 text-sky-300 border border-sky-500/20">
                  {metrics.realData.source} &bull; REAL
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  SIMULATED ENGINE
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              Analisa aliran saldo bursa, pergerakan dompet whale institusi, dan valuasi MVRV Z-Score
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="text-[11px] text-slate-400 block">Smart Money Bias:</span>
            <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded border ${
              metrics.smartMoneyBias.includes("BULLISH")
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                : metrics.smartMoneyBias.includes("BEARISH")
                ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
                : "bg-slate-800 text-slate-300 border-slate-700"
            }`}>
              {metrics.smartMoneyBias.replace("_", " ")} ({metrics.onChainConfidence}%)
            </span>
          </div>

          {onRefresh && (
            <button type="button"
              id="refresh-onchain-btn"
              onClick={onRefresh}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition border border-slate-700"
            >
              Sinkronisasi
            </button>
          )}
        </div>
      </div>

      {/* Key Metric Bento Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 1. Exchange Netflow 24h */}
        <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Netflow Bursa 24 Jam</span>
            {metricBadge(hasRealAnchor)}
            {isNetflowOutflow ? (
              <span className="text-emerald-400 flex items-center text-[10px] font-mono font-medium">
                <ArrowDownRight className="w-3 h-3 mr-0.5" /> Outflow (Akumulasi)
              </span>
            ) : (
              <span className="text-rose-400 flex items-center text-[10px] font-mono font-medium">
                <ArrowUpRight className="w-3 h-3 mr-0.5" /> Inflow (Tekanan Jual)
              </span>
            )}
          </div>
          <div className="text-xl font-bold font-mono text-slate-100 flex items-baseline gap-1.5">
            <span className={isNetflowOutflow ? "text-emerald-400" : "text-rose-400"}>
              {metrics.exchangeNetflow24hUSD > 0 ? "+" : ""}${metrics.exchangeNetflow24hUSD}M
            </span>
            <span className="text-[11px] text-slate-500 font-normal">USD</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Cadangan koin di bursa berkurang {Math.abs(metrics.exchangeReserveChangePercent)}% dalam 24 jam.
          </p>
        </div>

        {/* 2. MVRV Z-Score */}
        <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>MVRV Z-Score</span>
            <span className="flex items-center gap-1">
              {metricBadge(hasRealAnchor)}
              <span className="text-[10px] font-mono text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded">
                {metrics.mvrvTerritory}
              </span>
            </span>
          </div>
          <div className="text-xl font-bold font-mono text-slate-100 flex items-baseline gap-1.5">
            <span className="text-cyan-400">{metrics.mvrvZScore}</span>
            <span className="text-[11px] text-slate-500 font-normal">Ratio (0 - 6)</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Valuasi pasar berada di zona ekspansi sehat tanpa sinyal overheat ekstrim (&gt; 3.8).
          </p>
        </div>

        {/* 3. SOPR (Spent Output Profit Ratio) */}
        <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>SOPR (Profit Ratio)</span>
            <span className="flex items-center gap-1">
              {metricBadge(hasRealAnchor)}
              <span className="text-[10px] font-mono text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                {metrics.soprStatus}
              </span>
            </span>
          </div>
          <div className="text-xl font-bold font-mono text-slate-100 flex items-baseline gap-1.5">
            <span className="text-amber-400">{metrics.sopr}</span>
            <span className="text-[11px] text-slate-500 font-normal">Baseline 1.0</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Holder mempertahankan koin; memantul dari level support 1.0 (conviction holding).
          </p>
        </div>

        {/* 4. Active Addresses & Whales */}
        <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-3.5 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Aktivitas Wallet 24 Jam</span>
            {metricBadge(hasRealAnchor)}
            <span className="text-emerald-400 text-[10px] font-mono">
              +{metrics.activeAddressesGrowth24h}%
            </span>
          </div>
          <div className="text-xl font-bold font-mono text-slate-100 flex items-baseline gap-1.5">
            <span>{(metrics.activeAddresses24h / 1000).toFixed(0)}k</span>
            <span className="text-[11px] text-slate-500 font-normal">Wallets</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-tight">
            Akumulasi bersih 7 hari whale wallet: {metrics.whale7dNetAccumulationUSD > 0 ? "+" : ""}${metrics.whale7dNetAccumulationUSD}M USD.
          </p>
        </div>
      </div>

      {/* Real Data Anchor Strip (blockchain.com) */}
      {metrics.realData && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 py-2 text-[11px] font-mono text-slate-400 border-t border-slate-800/70">
          <span>Tx 24j: <b className="text-slate-200">{metrics.realData.txCount24h.toLocaleString()}</b></span>
          <span>Mempool: <b className="text-slate-200">{metrics.realData.mempoolSizeMB}MB</b></span>
          <span>Fee: ~<b className="text-slate-200">{metrics.realData.mempoolFeesSatVByte.regular} sat/vB</b></span>
          <span>Hashrate: <b className="text-slate-200">{metrics.realData.hashrateEH} EH/s</b></span>
          <span>Supply: <b className="text-slate-200">{metrics.realData.supplyBTC.toLocaleString()} BTC</b></span>
          <span>Market Cap: <b className="text-slate-200">${(metrics.realData.marketCapUSD / 1e12).toFixed(2)}T</b></span>
          <span>Sign 24j: <b className={metrics.realData.priceChange24hPct >= 0 ? "text-emerald-400" : "text-rose-400"}>{metrics.realData.priceChange24hPct >= 0 ? "+" : ""}{metrics.realData.priceChange24hPct}%</b></span>
          <span className="ml-auto text-slate-500">di-update {new Date(metrics.realData.fetchedAt).toLocaleTimeString()}</span>
        </div>
      )}

      {/* 4.9: Timestamp fetch — selalu tampil; REAL bila ada anchor blockchain.com, SIMULATED bila hanya proyeksi */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-1.5 text-[11px] font-mono text-slate-500 border-t border-slate-800/70">
        <span className={`font-bold uppercase flex items-center gap-1.5 ${
          hasRealAnchor ? "text-emerald-400" : "text-amber-400"
        }`}>
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          {hasRealAnchor ? "REAL DATA (blockchain.com anchor)" : "SIMULATED ENGINE — DERIVED VALUES"}
        </span>
        <span>
          Terakhir fetch: <b className={hasRealAnchor ? "text-emerald-400" : "text-slate-300"}>{lastFetchAt}</b>
        </span>
      </div>

      {/* Synthesis Insight Callout */}
      <div className="p-3.5 rounded-lg bg-emerald-950/20 border border-emerald-500/30 flex items-start gap-3">
        <div className="p-1 rounded bg-emerald-500/20 text-emerald-400 mt-0.5 shrink-0">
          <Sparkles className="w-4 h-4" />
        </div>
        <div>
          <div className="text-xs font-semibold text-emerald-300">
            Sintesis On-Chain Intelligence untuk AI Decision Engine:
          </div>
          <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
            {metrics.summaryInsight}
          </p>
        </div>
      </div>

      {/* Whale Alerts Stream */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-indigo-400" />
            Live Whale & Large Transfer Alerts (&gt; $10,000,000 USD)
          </h4>
          <span className="text-[11px] text-slate-500">Mempool Monitor</span>
        </div>

        <div className="divide-y divide-slate-800/70 bg-slate-950/40 rounded-xl border border-slate-800 overflow-hidden">
          {metrics.whaleAlerts.map((tx) => (
            <div key={tx.id} className="p-3 hover:bg-slate-900/50 transition flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-start sm:items-center gap-2.5">
                <div className={`p-2 rounded-lg shrink-0 ${
                  tx.impact === "BULLISH"
                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                    : tx.impact === "BEARISH"
                    ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                    : "bg-slate-800 text-slate-300 border border-slate-700"
                }`}>
                  <Wallet className="w-4 h-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-200">
                      {tx.amount.toLocaleString()} {tx.asset}
                    </span>
                    <span className="text-xs font-mono text-slate-400">
                      (~${(tx.usdValue / 1e6).toFixed(1)}M USD)
                    </span>
                    <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded uppercase font-semibold ${
                      tx.impact === "BULLISH"
                        ? "bg-emerald-500/20 text-emerald-400"
                        : tx.impact === "BEARISH"
                        ? "bg-rose-500/20 text-rose-400"
                        : "bg-slate-800 text-slate-400"
                    }`}>
                      {tx.impact}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-slate-300 font-medium">{tx.from}</span>
                    <span className="text-slate-600">&rarr;</span>
                    <span className="text-slate-300 font-medium">{tx.to}</span>
                    <span className="text-slate-500 ml-1">({tx.type.replace(/_/g, " ")})</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-3 text-right">
                <span className="text-[10px] font-mono text-slate-500">
                  {new Date(tx.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <span className="text-[10px] font-mono text-slate-400 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                  {tx.txHash}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
