import React from "react";
import { Play, Pause, StepForward, RotateCcw, Database, Download } from "lucide-react";
import { ReplaySession, fmtNum } from "./replayTypes";

// ---------------------------------------------------------------------------
// ReplayPlaybackControls — Progress bar + play/pause/step/reset/export buttons.
// Extracted from ReplayControlPanel.
// ---------------------------------------------------------------------------

interface ReplayPlaybackControlsProps {
  session: ReplaySession;
  totalCandles: number;
  currentIndex: number;
  progressPct: number;
  currentCandle: ReplaySession["currentCandle"];
  handleRun: () => void;
  handlePause: () => void;
  handleStep: () => void;
  handleReset: () => void;
  handleExport: () => void;
  handleDownloadCsv: (runId: string) => void;
  exportedRunId: string | null;
  exporting: boolean;
}

export const ReplayPlaybackControls: React.FC<ReplayPlaybackControlsProps> = ({
  session,
  totalCandles,
  currentIndex,
  progressPct,
  currentCandle,
  handleRun,
  handlePause,
  handleStep,
  handleReset,
  handleExport,
  handleDownloadCsv,
  exportedRunId,
  exporting,
}) => {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500 mb-1">
        <span>
          Candle {currentIndex + 1}/{totalCandles} ·{" "}
          {currentCandle
            ? new Date(currentCandle.timestamp).toLocaleString("en-GB", { hour12: false })
            : "—"}
        </span>
        <span>{progressPct}%</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-cyan-500/80 transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {session.status !== "running" && session.status !== "done" && (
          <button
            onClick={handleRun}
            className="flex items-center gap-1 rounded bg-emerald-500/15 border border-emerald-500/30 px-3 py-1.5 text-xs font-bold text-emerald-400 hover:bg-emerald-500/25 transition-colors"
          >
            <Play className="h-3.5 w-3.5" /> Run
          </button>
        )}
        {session.status === "running" && (
          <button
            onClick={handlePause}
            className="flex items-center gap-1 rounded bg-amber-500/15 border border-amber-500/30 px-3 py-1.5 text-xs font-bold text-amber-400 hover:bg-amber-500/25 transition-colors"
          >
            <Pause className="h-3.5 w-3.5" /> Pause
          </button>
        )}
        {session.status !== "done" && (
          <button
            onClick={handleStep}
            className="flex items-center gap-1 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs font-bold text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <StepForward className="h-3.5 w-3.5" /> Step
          </button>
        )}
        <button
          onClick={handleReset}
          className="flex items-center gap-1 rounded bg-rose-500/10 border border-rose-500/30 px-3 py-1.5 text-xs font-bold text-rose-400 hover:bg-rose-500/20 transition-colors"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </button>
        <button
          onClick={handleExport}
          disabled={exporting || currentIndex < 0}
          className="flex items-center gap-1 rounded bg-sky-500/15 border border-sky-500/30 px-3 py-1.5 text-xs font-bold text-sky-400 hover:bg-sky-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Simpan hasil sesi ke SQLite (training data)"
        >
          <Database className="h-3.5 w-3.5" /> {exporting ? "Saving..." : "Export"}
        </button>
        {exportedRunId && (
          <button
            onClick={() => handleDownloadCsv(exportedRunId)}
            className="flex items-center gap-1 rounded bg-emerald-500/15 border border-emerald-500/30 px-3 py-1.5 text-xs font-bold text-emerald-400 hover:bg-emerald-500/25 transition-colors"
            title={`Download training CSV untuk run ${exportedRunId}`}
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        )}
      </div>
    </div>
  );
};
