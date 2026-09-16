import React, { useCallback, useEffect, useRef, useState } from "react";
import { Brain } from "lucide-react";
import { authFetch, useAuth } from "../hooks/useAuth";

// ---------------------------------------------------------------------------
// AgentDecisionsPanel — viewer tabel agent_decisions (DB).
// GET /api/agent-decisions -> list decision AI/Keel (action, confidence,
// model, latency, prompt/response ringkas). Sebelumnya tabel ini write-only
// dari /api/ai-decision tanpa ada pembaca FE.
// ---------------------------------------------------------------------------

interface AgentDecision {
  id: string;
  createdAt: number;
  symbol: string;
  action: string;
  confidence: number;
  modelId: string;
  latencyMs: number;
  prompt: string;
  response: string;
  sourceTags: string | null;
}

const POLL_MS = 10000;

const ACTION_COLOR: Record<string, string> = {
  BUY: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  SELL: "bg-rose-500/20 text-rose-300 border-rose-500/30",
  HOLD: "bg-zinc-800 text-zinc-400 border-zinc-700",
  REJECTED: "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

export const AgentDecisionsPanel: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [decisions, setDecisions] = useState<AgentDecision[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [conn, setConn] = useState<"ok" | "error" | "hidden" | "loading">("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const mountedRef = useRef(false);

  const load = useCallback(async (cursor?: number | null, append = false) => {
    if (!mountedRef.current) return;
    if (!isAuthenticated) return;
    if (!append && document.hidden) {
      setConn("hidden");
      return;
    }
    try {
      const qs = new URLSearchParams();
      qs.set("limit", "20");
      if (cursor) qs.set("cursor", String(cursor));
      const res = await authFetch(`/api/agent-decisions?${qs.toString()}`);
      if (res.status === 429) return; // cooldown global menangani retry; tampilkan cache
      if (res.status === 401) {
        setConn("error");
        return;
      }
      const payload = await res.json().catch(() => null);
      if (payload?.success && Array.isArray(payload.decisions)) {
        if (!mountedRef.current) return;
        if (append) {
          setDecisions((prev) => {
            const seen = new Set(prev.map((d) => d.id));
            return [...prev, ...payload.decisions.filter((d: AgentDecision) => !seen.has(d.id))];
          });
        } else {
          setDecisions(payload.decisions);
        }
        setNextCursor(payload.nextCursor ?? null);
        setConn("ok");
      } else if (!append) {
        setConn("error");
      }
    } catch {
      if (!append) setConn("error");
    } finally {
      setLoadingMore(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isAuthenticated) return;
    load(null, false);
    const iv = setInterval(() => load(null, false), POLL_MS);
    const onVis = () => {
      if (!document.hidden) load(null, false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isAuthenticated, load]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const nt = new Set(prev);
      if (nt.has(id)) nt.delete(id);
      else nt.add(id);
      return nt;
    });
  };

  const healthDot =
    conn === "ok" ? "bg-emerald-400" : conn === "error" ? "bg-rose-500" : "bg-zinc-600";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-zinc-800 rounded-xl flex items-center justify-center text-violet-400 border border-zinc-700/60">
            <Brain className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 font-sans flex items-center gap-2">
              Agent Decisions
              <span className="px-2 py-0.5 rounded border text-[10px] font-bold font-mono bg-violet-500/15 text-violet-300 border-violet-500/30">
                DB • /api/agent-decisions
              </span>
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
              Jejak keputusan AI/Keel — join ke order via decisionId
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
          <span className={`w-2 h-2 rounded-full ${healthDot}`} />
          <span>
            {decisions.length} decisions{nextCursor != null ? " • ada lagi" : ""}
          </span>
        </div>
      </div>

      {decisions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80">
          <Brain className="w-7 h-7 text-zinc-600 mb-2" />
          <p className="text-xs font-mono text-zinc-400">Belum ada decision tersimpan.</p>
          <p className="text-[11px] font-mono text-zinc-600 mt-1">
            Decision baru tercatat setiap pipeline cycle / AI advisor (server-side).
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {decisions.map((d) => {
            const isExpanded = expanded.has(d.id);
            return (
              <div
                key={d.id}
                className="rounded-lg bg-zinc-950 border border-zinc-800 hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-center gap-2.5 px-3 py-2 font-mono text-xs flex-wrap">
                  <span
                    className={`px-2 py-0.5 rounded border text-[10px] font-bold ${ACTION_COLOR[d.action] || "bg-zinc-800 text-zinc-300 border-zinc-700"}`}
                  >
                    {d.action}
                  </span>
                  <span className="text-zinc-200 font-bold">{d.symbol}</span>
                  <span className="text-zinc-500">conf {d.confidence}%</span>
                  <span className="text-zinc-600 text-[11px] truncate max-w-[220px]" title={d.modelId}>
                    {d.modelId}
                  </span>
                  <span className="text-zinc-600 text-[11px]">{d.latencyMs}ms</span>
                  <span className="text-zinc-600 text-[11px] ml-auto">
                    {new Date(d.createdAt).toLocaleString("id-ID")}
                  </span>
                  <button
                    onClick={() => toggleExpand(d.id)}
                    className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-violet-400 border border-zinc-800 text-[10px] transition-colors"
                  >
                    {isExpanded ? "Tutup" : "Prompt/Response"}
                  </button>
                </div>
                {isExpanded && (
                  <div className="px-3 pb-2.5 grid gap-1.5">
                    <pre className="overflow-x-auto p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[10px] text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap">
                      {truncate(d.prompt, 800)}
                    </pre>
                    <pre className="overflow-x-auto p-2.5 rounded-lg bg-zinc-900 border border-violet-500/20 text-[10px] text-violet-300/90 font-mono leading-relaxed whitespace-pre-wrap">
                      {truncate(d.response, 1200)}
                    </pre>
                    <p className="text-[10px] font-mono text-zinc-600">
                      id {d.id}
                      {d.sourceTags ? ` • tags ${truncate(d.sourceTags, 160)}` : ""}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {nextCursor != null && (
        <div className="pt-3 flex justify-center">
          <button
            onClick={() => {
              setLoadingMore(true);
              load(nextCursor, true);
            }}
            disabled={loadingMore}
            className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono border border-zinc-700 disabled:opacity-50"
          >
            {loadingMore ? "Memuat..." : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
};

export default AgentDecisionsPanel;
