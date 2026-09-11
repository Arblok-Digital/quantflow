import React from "react";
import { Database, Activity } from "lucide-react";
import { ReplaySession } from "./replayTypes";

// ---------------------------------------------------------------------------
// ReplaySetupPanel — Config/setup controls (symbol, timeframe, dates, cash,
// speed, start button) + Auto Strategy section.
// Extracted from ReplayControlPanel.
// ---------------------------------------------------------------------------

interface ReplaySetupPanelProps {
  symbol: string;
  setSymbol: (v: string) => void;
  timeframe: string;
  setTimeframe: (v: string) => void;
  startMs: number;
  setStartMs: (v: number) => void;
  endMs: number;
  setEndMs: (v: number) => void;
  initialCash: number;
  setInitialCash: (v: number) => void;
  session: ReplaySession | null;
  busy: boolean;
  handleStart: () => void;
  handleSpeed: (speedMs: number) => void;
  handleStrategy: (mode: "manual" | "auto") => void;
  autoParams: ReplaySession["autoParams"];
  setAutoParams: React.Dispatch<React.SetStateAction<ReplaySession["autoParams"]>>;
  savingStrategy: boolean;
  fmtMoney: (n: number) => string;
}

export const ReplaySetupPanel: React.FC<ReplaySetupPanelProps> = ({
  symbol,
  setSymbol,
  timeframe,
  setTimeframe,
  startMs,
  setStartMs,
  endMs,
  setEndMs,
  initialCash,
  setInitialCash,
  session,
  busy,
  handleStart,
  handleSpeed,
  handleStrategy,
  autoParams,
  setAutoParams,
  savingStrategy,
  fmtMoney,
}) => {
  return (
    <>
      {/* Setup form */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 mb-3">
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          SYMBOL
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          TIMEFRAME
          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
          >
            {["1m", "5m", "15m", "30m", "1h", "4h", "1D"].map((tf) => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          START
          <input
            type="datetime-local"
            value={new Date(startMs).toISOString().slice(0, 16)}
            onChange={(e) => setStartMs(new Date(e.target.value).getTime())}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          END
          <input
            type="datetime-local"
            value={new Date(endMs).toISOString().slice(0, 16)}
            onChange={(e) => setEndMs(new Date(e.target.value).getTime())}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          INITIAL CASH
          <input
            type="number"
            value={initialCash}
            onChange={(e) => setInitialCash(Number(e.target.value))}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
          SPEED (ms/candle)
          <input
            type="number"
            value={session?.speedMs ?? 100}
            onChange={(e) => handleSpeed(Number(e.target.value))}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
          />
        </label>
        <div className="flex items-end">
          <button
            onClick={handleStart}
            disabled={busy}
            className="flex items-center gap-1 rounded bg-cyan-500 px-3 py-1.5 text-xs font-bold text-zinc-950 hover:bg-cyan-400 disabled:opacity-40 transition-colors w-full justify-center"
          >
            <Database className="h-3.5 w-3.5" />
            {busy ? "Fetching..." : "Start"}
          </button>
        </div>
      </div>

      {/* Auto Strategy — backtest otomatis (mode auto) */}
      {session && (
        <div className="mb-3 p-3 rounded-xl bg-zinc-950 border border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
              <Activity className="w-3.5 h-3.5 text-cyan-400" /> Auto Strategy (Backtest Otomatis)
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => handleStrategy("manual")}
                disabled={savingStrategy}
                className={`rounded px-2.5 py-1.5 text-[11px] font-bold border transition-colors ${
                  (session?.mode ?? "manual") === "manual"
                    ? "bg-zinc-700 text-zinc-200 border-zinc-600"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
                title="Eksekusi manual (kamu yang klik EXECUTE)"
              >
                MANUAL
              </button>
              <button
                onClick={() => handleStrategy("auto")}
                disabled={savingStrategy}
                className={`rounded px-2.5 py-1.5 text-[11px] font-bold border transition-colors ${
                  session?.mode === "auto"
                    ? "bg-emerald-500/25 text-emerald-300 border-emerald-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
                title="Strategi teknikal (RSI/EMA/volume) dieksekusi otomatis tiap candle — deterministik, tanpa LLM"
              >
                {savingStrategy ? "SAVING..." : "AUTO"}
              </button>
            </div>
          </div>

          {session?.mode === "auto" && (
            <>
              <div className="px-2 py-1.5 mb-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 font-mono text-[11px] text-emerald-300">
                AUTO AKTIF — strategi dijalankan di setiap candle. Tidak perlu klik EXECUTE.
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-2">
                {(
                  [
                    ["RSI LONG ≤", "rsiLong"],
                    ["RSI SHORT ≥", "rsiShort"],
                    ["SL (× ATR)", "slAtrMult"],
                    ["TP (× ATR)", "tpAtrMult"],
                    ["Risk/trade %", "riskPct"],
                  ] as const
                ).map(([label, key]) => (
                  <label key={key} className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
                    {label}
                    <input
                      type="number"
                      step="0.5"
                      value={autoParams?.[key] ?? 0}
                      onChange={(e) =>
                        setAutoParams((prev) => ({ ...prev!, [key]: Number(e.target.value) }))
                      }
                      className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
                    />
                  </label>
                ))}
              </div>

              {session.lastAutoSignal && (
                <div className="px-2 py-1.5 mb-2 rounded-lg bg-zinc-900/70 border border-zinc-800 font-mono text-[11px]">
                  <span className="text-zinc-500">
                    Sinyal terakhir (candle #{session.lastAutoSignal.index}):{" "}
                  </span>
                  <span
                    className={`font-bold ${
                      session.lastAutoSignal.action === "BUY"
                        ? "text-emerald-400"
                        : session.lastAutoSignal.action === "SELL"
                        ? "text-rose-400"
                        : "text-zinc-400"
                    }`}
                  >
                    {session.lastAutoSignal.action}
                  </span>
                  <span className="text-zinc-400">
                    {" "}
                    @ ${fmtMoney(session.lastAutoSignal.candleClose)}
                  </span>
                  <span className="text-zinc-500"> — {session.lastAutoSignal.reason}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
};
