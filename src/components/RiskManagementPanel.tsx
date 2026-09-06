import React from "react";
import { RiskConfig, RiskEvaluationResult } from "../types";
import { ShieldCheck, ShieldAlert, Sliders, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

interface RiskManagementPanelProps {
  config: RiskConfig;
  onChangeConfig: (newConfig: RiskConfig) => void;
  lastEvaluation: RiskEvaluationResult | null;
  currentDrawdown: number;
}

export const RiskManagementPanel: React.FC<RiskManagementPanelProps> = ({
  config,
  onChangeConfig,
  lastEvaluation,
  currentDrawdown,
}) => {
  const isCircuitBreakerTripped = config.isEmergencyStopActive || currentDrawdown >= config.maxDrawdownLimit;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 relative overflow-hidden shadow-sm flex flex-col justify-between h-full">
      {/* Ambient Bento Dot Grid */}
      <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />

      <div className="relative z-10 flex flex-col h-full justify-between space-y-4">
        {/* Bento Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-lg flex items-center justify-center border ${
                isCircuitBreakerTripped
                  ? "bg-rose-500/10 border-rose-500/30 text-rose-400"
                  : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              }`}
            >
              {isCircuitBreakerTripped ? <ShieldAlert className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
            </div>
            <div>
              <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
                Risk Management
              </h2>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest">
                Deterministic Gatekeeper
              </p>
            </div>
          </div>

          <span
            className={`px-2 py-0.5 text-[10px] font-mono font-bold rounded border uppercase tracking-wider ${
              isCircuitBreakerTripped
                ? "bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse"
                : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
            }`}
          >
            {isCircuitBreakerTripped ? "CIRCUIT BREAKER TRIPPED" : "GATE ACTIVE"}
          </span>
        </div>

        {/* Bento Signature Drawdown Meter */}
        <div className="space-y-1.5 bg-zinc-950/70 p-3 rounded-xl border border-zinc-800/80 font-mono">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-400 text-[11px]">Max Drawdown Guard</span>
            <span className="text-zinc-100 font-bold">{config.maxDrawdownLimit}% Limit (Curr: {currentDrawdown.toFixed(1)}%)</span>
          </div>
          <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                currentDrawdown >= config.maxDrawdownLimit
                  ? "bg-rose-500"
                  : currentDrawdown >= config.maxDrawdownLimit * 0.7
                  ? "bg-amber-500"
                  : "bg-emerald-500"
              }`}
              style={{ width: `${Math.min(100, (currentDrawdown / config.maxDrawdownLimit) * 100)}%` }}
            />
          </div>
        </div>

        {/* Bento 2x2 Risk Stat Matrix from Template */}
        <div className="grid grid-cols-2 gap-2.5 font-mono">
          <div className="p-3 bg-zinc-950/80 rounded-xl border border-zinc-800">
            <p className="text-[10px] text-zinc-500 uppercase font-semibold">Account Risk</p>
            <p className="text-sm font-bold text-emerald-400 mt-0.5">
              {config.maxRiskPerTradePercent || 0.5}% / Trade
            </p>
          </div>
          <div className="p-3 bg-zinc-950/80 rounded-xl border border-zinc-800">
            <p className="text-[10px] text-zinc-500 uppercase font-semibold">Kill Switch</p>
            <p className={`text-sm font-bold mt-0.5 ${config.isEmergencyStopActive ? "text-rose-400" : "text-zinc-400"}`}>
              {config.isEmergencyStopActive ? "MANUAL_KILL_ON" : "AUTO_ACTIVE"}
            </p>
          </div>
        </div>

        {/* Interactive Sliders */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 font-mono text-xs">
          <div className="bg-zinc-950/60 p-2.5 rounded-xl border border-zinc-800">
            <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
              <span>POSITION CAP</span>
              <span className="font-bold text-zinc-200">{config.maxPositionPercent}%</span>
            </div>
            <input
              type="range"
              min="2"
              max="30"
              step="1"
              value={config.maxPositionPercent}
              onChange={(e) =>
                onChangeConfig({ ...config, maxPositionPercent: Number(e.target.value) })
              }
              className="w-full accent-emerald-500 cursor-pointer"
            />
          </div>

          <div className="bg-zinc-950/60 p-2.5 rounded-xl border border-zinc-800">
            <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
              <span>MIN CONFIDENCE</span>
              <span className="font-bold text-zinc-200">{config.minConfidenceThreshold}%</span>
            </div>
            <input
              type="range"
              min="40"
              max="85"
              step="5"
              value={config.minConfidenceThreshold}
              onChange={(e) =>
                onChangeConfig({ ...config, minConfidenceThreshold: Number(e.target.value) })
              }
              className="w-full accent-emerald-500 cursor-pointer"
            />
          </div>
        </div>

        {/* Pre-Trade Rule Verification Checks */}
        <div className="bg-zinc-950/80 p-3 rounded-xl border border-zinc-800 font-mono text-xs">
          <div className="flex items-center justify-between mb-2">
            <span className="text-zinc-500 text-[10px] uppercase tracking-wider font-semibold">
              Pre-Trade Rule Verification
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-bold ${
                lastEvaluation?.approved
                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
              }`}
            >
              {lastEvaluation?.approved ? (
                <>
                  <CheckCircle2 className="h-3 w-3" /> ORDER APPROVED
                </>
              ) : (
                <>
                  <XCircle className="h-3 w-3" /> ORDER BLOCKED
                </>
              )}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="flex items-center gap-1.5 p-1.5 rounded-lg bg-zinc-900 border border-zinc-800/80">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <div>
                <div className="text-zinc-500 text-[9px] uppercase">Position Size</div>
                <div className="text-zinc-200">Compliant (&le;{config.maxPositionPercent}%)</div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 p-1.5 rounded-lg bg-zinc-900 border border-zinc-800/80">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <div>
                <div className="text-zinc-500 text-[9px] uppercase">Drawdown Guard</div>
                <div className="text-zinc-200">{currentDrawdown < config.maxDrawdownLimit ? "Safe Margin" : "Halted"}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
