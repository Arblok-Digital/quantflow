import React from "react";
import { Layers } from "lucide-react";
import {
  buildDecisionPipeline,
  type PipelineInput,
  type PipelineRow,
  type PipelineStatus,
} from "../logic/decisionPipeline";

// ---------------------------------------------------------------------------
// DecisionPipelineTable (FE-PIPELINE-1) — SATU tabel: KEEL → JEV → LLM → FINAL.
// Komponen presentasional: seluruh perhitungan ada di src/logic/decisionPipeline.ts
// (murni + ber-test). Komponen ini TIDAK memanggil network/DB dan tidak
// mengarang angka — nilai kosong ditampilkan sebagai "—" dengan catatan jujur.
// Kelas badge disengaja paralel dengan actionBadge() di AiAdvisorPanel.
// ---------------------------------------------------------------------------

interface DecisionPipelineTableProps {
  /** Snapshot respons /api/ai-advisor (subset yang dibutuhkan). */
  snapshot: PipelineInput | null;
}

function actionBadgeCls(action: string | null): string {
  if (action === "BUY") return "bg-emerald-500/20 text-emerald-300 border-emerald-500/40";
  if (action === "SELL") return "bg-rose-500/20 text-rose-300 border-rose-500/40";
  if (action === "HOLD") return "bg-amber-500/15 text-amber-300 border-amber-500/40";
  return "bg-zinc-800 text-zinc-500 border-zinc-700";
}

const STATUS_CLS: Record<PipelineStatus, string> = {
  OK: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  FALLBACK: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  GATED: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  NO_DATA: "bg-zinc-800 text-zinc-400 border-zinc-700",
  DISABLED: "bg-zinc-800 text-zinc-500 border-zinc-700",
};

const CONSENSUS_CLS: Record<string, string> = {
  SEARAH: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  DIVERGEN: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  TIDAK_LENGKAP: "bg-zinc-800 text-zinc-400 border-zinc-700",
};

const fmtConf = (v: number | null): string => (v != null ? `${Math.round(v)}%` : "—");

function rowTint(row: PipelineRow): string {
  if (row.id === "final") return "bg-zinc-900/70";
  if (row.status === "NO_DATA" || row.status === "DISABLED") return "bg-zinc-950/40";
  return "";
}

export const DecisionPipelineTable: React.FC<DecisionPipelineTableProps> = ({ snapshot }) => {
  if (!snapshot) return null;
  const pipeline = buildDecisionPipeline(snapshot);

  return (
    <div className="rounded-xl bg-zinc-950/70 border border-zinc-800 p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold">
          <Layers className="w-3.5 h-3.5 text-zinc-500" />
          Decision Pipeline
        </span>
        <span className="text-[10px] font-mono text-zinc-600">keel → Jev → LLM → final (satu snapshot)</span>
        <span
          className={`ml-auto px-2 py-0.5 rounded border text-[10px] font-mono font-bold ${CONSENSUS_CLS[pipeline.consensus.label] ?? CONSENSUS_CLS.TIDAK_LENGKAP}`}
          title={pipeline.consensus.detail}
        >
          {pipeline.consensus.label.replace("_", " ")}
          {pipeline.consensus.total > 0 ? ` ${pipeline.consensus.agree}/${pipeline.consensus.total}` : ""}
        </span>
        {pipeline.gateActive && (
          <span className="px-2 py-0.5 rounded border text-[10px] font-mono font-bold bg-rose-500/15 text-rose-300 border-rose-500/30">
            PROVENANCE GATE AKTIF
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-xs min-w-[860px]">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
              <th className="pb-2 pr-2">Engine</th>
              <th className="pb-2 pr-2">Action</th>
              <th className="pb-2 pr-2 text-right">Conf</th>
              <th className="pb-2 pr-2">Risk/Bias</th>
              <th className="pb-2 pr-2">Sumber</th>
              <th className="pb-2 pr-2 text-right">Latency</th>
              <th className="pb-2 pr-2">Status</th>
              <th className="pb-2">Catatan</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {pipeline.rows.map((row) => (
              <tr key={row.id} className={`align-top transition-colors ${rowTint(row)}`}>
                <td className="py-2 pr-2 whitespace-nowrap">
                  <span className={`font-black ${row.id === "final" ? "text-zinc-100" : "text-zinc-300"}`}>{row.label}</span>
                  <span className="block text-[10px] text-zinc-500 font-normal">{row.role}</span>
                </td>
                <td className="py-2 pr-2 whitespace-nowrap">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-black ${actionBadgeCls(row.action)}`}>
                    {row.action ?? "—"}
                  </span>
                </td>
                <td className="py-2 pr-2 text-right whitespace-nowrap">
                  <span className="font-bold text-zinc-200">{fmtConf(row.confidence)}</span>
                  {row.raw?.confidence != null && row.raw.confidence !== row.confidence && (
                    <span className="block text-[9px] text-zinc-500">raw {Math.round(row.raw.confidence)}%</span>
                  )}
                </td>
                <td className="py-2 pr-2 whitespace-nowrap text-zinc-300">{row.risk ?? "—"}</td>
                <td className="py-2 pr-2 whitespace-nowrap text-zinc-400">{row.source ?? "—"}</td>
                <td className="py-2 pr-2 text-right whitespace-nowrap text-zinc-400">
                  {row.latencyMs != null ? `${row.latencyMs}ms` : "—"}
                </td>
                <td className="py-2 pr-2 whitespace-nowrap">
                  <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold ${STATUS_CLS[row.status]}`}>
                    {row.status.replace("_", " ")}
                  </span>
                </td>
                <td className="py-2 text-zinc-400 max-w-[380px]">
                  {row.notes.map((n, i) => (
                    <span key={i} className="block text-[10px] leading-relaxed">
                      {n}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10px] font-mono text-zinc-600">
        CONF kosong = engine tidak mengirim confidence terstruktur (bukan nol). Kolom{" "}
        <span className="text-zinc-500">raw</span> di baris FINAL = nilai mentah sebelum clamp/provenance gate.
        {pipeline.failedSources.length > 0 && (
          <span className="text-amber-400/90"> Sumber GAGAL: {pipeline.failedSources.join(", ")}.</span>
        )}
      </p>
    </div>
  );
};

export default DecisionPipelineTable;
