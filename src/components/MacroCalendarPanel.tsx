import React from "react";
import { MacroSummary, MacroCalendarEvent } from "../types";
import { 
  Calendar, 
  AlertTriangle, 
  ShieldCheck, 
  Flame, 
  Clock, 
  ArrowUpRight, 
  TrendingUp, 
  Globe2,
  Info,
  Sparkles
} from "lucide-react";

interface MacroCalendarPanelProps {
  macro: MacroSummary;
  onRefresh?: () => void;
}

export const MacroCalendarPanel: React.FC<MacroCalendarPanelProps> = ({ macro, onRefresh }) => {
  const isHighRisk = macro.macroRiskIndex > 70;

  return (
    <div id="macro-calendar-panel" className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
            <Calendar className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-slate-100 text-base">Kalender Makroekonomi & The Fed Policy</h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                GLOBAL ECONOMIC CATALYSTS
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Jadwal rilis data inflasi (CPI), suku bunga FOMC, data tenaga kerja (NFP), dan sentimen likuiditas global
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="text-[11px] text-slate-400 block">The Fed Policy Stance:</span>
            <span className="text-xs font-bold font-mono px-2 py-0.5 rounded border bg-blue-500/15 text-blue-400 border-blue-500/30">
              {macro.fedPolicyStance.replace("_", " ")}
            </span>
          </div>

          {onRefresh && (
            <button
              id="refresh-macro-btn"
              onClick={onRefresh}
              className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition border border-slate-700"
            >
              Sinkronisasi
            </button>
          )}
        </div>
      </div>

      {/* Top Banner: Nearest Catalyst & Risk Gauge */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Nearest High Impact Event */}
        <div className="md:col-span-2 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-amber-400 flex items-center gap-1.5">
              <Flame className="w-4 h-4 text-amber-500 animate-pulse" />
              Katalis Makro Terdekat:
            </span>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 font-bold">
              {macro.nearestEvent?.relativeTime || "Mendatang"}
            </span>
          </div>

          <div>
            <h4 className="text-sm font-bold text-slate-100">
              {macro.nearestEvent?.name}
            </h4>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
              {macro.nearestEvent?.implicationNotes}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs font-mono pt-1 text-slate-300 border-t border-slate-800/80">
            <span>Previous: <strong className="text-slate-400">{macro.nearestEvent?.previous}</strong></span>
            <span>Forecast: <strong className="text-amber-400">{macro.nearestEvent?.forecast}</strong></span>
            <span>Waktu: <strong className="text-slate-200">{macro.nearestEvent?.timeLabel}</strong></span>
          </div>
        </div>

        {/* Macro Risk Gauge */}
        <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Indeks Risiko Makro</span>
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
              isHighRisk ? "bg-rose-500/20 text-rose-400" : "bg-emerald-500/20 text-emerald-400"
            }`}>
              {isHighRisk ? "HIGH VOLATILITY" : "NORMAL RISK"}
            </span>
          </div>

          <div className="flex items-baseline gap-2">
            <span className={`text-3xl font-bold font-mono ${isHighRisk ? "text-rose-400" : "text-amber-400"}`}>
              {macro.macroRiskIndex}
            </span>
            <span className="text-xs text-slate-500 font-mono">/ 100</span>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
            <div 
              className={`h-full rounded-full ${isHighRisk ? "bg-rose-500" : "bg-amber-500"}`}
              style={{ width: `${macro.macroRiskIndex}%` }}
            />
          </div>

          <p className="text-[11px] text-slate-400 leading-tight">
            {isHighRisk 
              ? "Peristiwa rilis data suku bunga mendekat; Risk Gatekeeper memperketat buffer stop loss." 
              : "Lingkungan makro kondusif untuk eksekusi swing trading terukur."}
          </p>
        </div>
      </div>

      {/* Macro Advice Banner */}
      <div className="p-3.5 rounded-lg bg-blue-950/20 border border-blue-500/30 flex items-start gap-3">
        <div className="p-1 rounded bg-blue-500/20 text-blue-400 mt-0.5 shrink-0">
          <Sparkles className="w-4 h-4" />
        </div>
        <div>
          <div className="text-xs font-semibold text-blue-300">
            Arahan Makro untuk AI Agent & Risk Gatekeeper:
          </div>
          <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
            {macro.macroTradingAdvice}
          </p>
        </div>
      </div>

      {/* Events Table / List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Globe2 className="w-3.5 h-3.5 text-blue-400" />
            Jadwal Rilis Data Makro Ekonomi Utama
          </h4>
          <span className="text-[11px] text-slate-500">Dovish vs Hawkish Watchlist</span>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/80 text-slate-400 font-mono text-[11px] uppercase border-b border-slate-800">
              <tr>
                <th className="p-3">Peristiwa / Rilis Data</th>
                <th className="p-3">Waktu & Jadwal</th>
                <th className="p-3">Dampak</th>
                <th className="p-3">Previous</th>
                <th className="p-3">Forecast</th>
                <th className="p-3">Actual</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 font-sans">
              {macro.events.map((evt) => (
                <tr key={evt.id} className="hover:bg-slate-900/50 transition">
                  <td className="p-3 font-medium text-slate-200">
                    <div>{evt.name}</div>
                    <div className="text-[11px] text-slate-500 font-normal">{evt.country} ({evt.currency})</div>
                  </td>
                  <td className="p-3 font-mono text-[11px] text-slate-400">
                    <div>{evt.timeLabel}</div>
                    <div className="text-slate-500 text-[10px]">{evt.relativeTime}</div>
                  </td>
                  <td className="p-3">
                    <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${
                      evt.impact === "HIGH" 
                        ? "bg-rose-500/15 text-rose-400 border-rose-500/30" 
                        : evt.impact === "MEDIUM" 
                        ? "bg-amber-500/15 text-amber-400 border-amber-500/30" 
                        : "bg-slate-800 text-slate-400 border-slate-700"
                    }`}>
                      {evt.impact}
                    </span>
                  </td>
                  <td className="p-3 font-mono text-slate-400">{evt.previous}</td>
                  <td className="p-3 font-mono text-amber-400 font-semibold">{evt.forecast}</td>
                  <td className="p-3 font-mono">
                    {evt.actual ? (
                      <span className="text-emerald-400 font-bold">{evt.actual}</span>
                    ) : (
                      <span className="text-slate-600 italic">-</span>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold ${
                      evt.status === "COMPLETED"
                        ? "bg-slate-800 text-slate-400"
                        : evt.status === "LIVE"
                        ? "bg-rose-500 text-white animate-pulse"
                        : "bg-blue-500/20 text-blue-300"
                    }`}>
                      {evt.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
