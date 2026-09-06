import React, { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ChevronRight, ChevronDown, Radio } from "lucide-react";
import { authFetch } from "../hooks/useAuth";

// ---------------------------------------------------------------------------
// Execution Console — server-backed order lifecycle stream (roadmap 1.7 + 1.9).
// Polls GET /api/broker/events?sinceSeq=N every 3s (paused while the tab is
// hidden) and renders one timeline card per server event, newest first, with
// an expandable raw-JSON toggle for full transparency. The header shows the
// broker MODE badge (PAPER/LIVE), measured daily counts (fills / closed /
// open) and a connection health dot.
// ---------------------------------------------------------------------------

type PaperEventType =
  | "ORDER_FILLED"
  | "POSITION_CLOSED"
  | "BRACKET_MONITOR_ACTION"
  | "POSITION_UPDATED"
  | "ERROR";

interface PaperEvent {
  seq: number;
  timestamp: number;
  type: PaperEventType;
  payload: Record<string, unknown>;
}

interface EventsResponse {
  success: boolean;
  mode: string;
  events?: PaperEvent[];
  latestSeq?: number;
}

interface BrokerStatus {
  success: boolean;
  mode: string;
  exchangeId: string;
  testnet: boolean;
  credentialsConfigured: boolean;
  credentialSource: string;
  canPlaceLiveOrders: boolean;
}

interface PositionsLite {
  success: boolean;
  mode: string;
  positions?: Array<{ id: string; status: string }>;
  account?: { openCount: number } | null;
}

const POLL_MS = 3000;
const MAX_CLIENT_EVENTS = 50;

const fmtNum = (v: unknown): string => Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });
const fmtMoney = (v: unknown): string =>
  Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

interface EventDescription {
  badge: string;
  text: string;
  title?: string;
}

function describeEvent(e: PaperEvent): EventDescription {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "ORDER_FILLED": {
      const side = String(p.side || "?").toUpperCase();
      const symbol = String(p.symbol || "?");
      const qty = fmtNum(p.qty);
      const fill = fmtMoney(p.fillPrice);
      const slip = p.slippageBps === undefined ? "?" : `${fmtNum(p.slippageBps)}bps`;
      const fee = p.feeUSD === undefined ? "?" : `$${Number(p.feeUSD).toFixed(3)}`;
      const latency = p.executionLatencyMs === undefined ? "?" : `${fmtNum(p.executionLatencyMs)}ms`;
      return {
        badge: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
        text: `FILLED ${side} ${symbol} ${qty} @ ${fill} | slip ${slip} | fee ${fee} | ${latency}`,
      };
    }
    case "POSITION_CLOSED": {
      const side = String(p.side || "?");
      const symbol = String(p.symbol || "?");
      const exit = fmtMoney(p.exitPrice);
      const pnl = Number(p.realizedPnlUSD ?? 0);
      const reason = String(p.exitReason || "MANUAL");
      return {
        badge: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        text: `CLOSED ${side} ${symbol} ${fmtNum(p.qty)} @ ${exit} -> realized ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)} (${reason})`,
        title: `fees ${fmtMoney(p.feesPaidUSD)} | cashAfter ${fmtMoney(p.cashAfter)}`,
      };
    }
    case "BRACKET_MONITOR_ACTION": {
      const symbol = String(p.symbol || "?");
      const trig = p.triggered === "STOP_LOSS" ? "SL" : "TP";
      const mark = fmtMoney(p.mark);
      const latency = p.markLatencyMs === undefined ? "" : ` (mark ${fmtNum(p.markLatencyMs)}ms)`;
      return {
        badge: "bg-sky-500/15 text-sky-400 border-sky-500/30",
        text: `BRACKET: ${trig} hit ${symbol} @ ${mark}${latency} -> closing via server`,
      };
    }
    case "POSITION_UPDATED": {
      const symbol = String(p.symbol || "?");
      const sl = p.stopLoss === undefined ? "?" : fmtMoney(p.stopLoss);
      const tp = p.takeProfit === undefined ? "?" : fmtMoney(p.takeProfit);
      const be = p.breakEven === true ? " (BREAK-EVEN)" : "";
      return {
        badge: "bg-violet-500/15 text-violet-400 border-violet-500/30",
        text: `UPDATED ${symbol}: SL ${sl} | TP ${tp}${be}`,
      };
    }
    case "ERROR": {
      const code = p.reason ? String(p.reason) : "";
      const msg = String(p.message || "Unknown error");
      const src = p.source ? ` [${String(p.source)}]` : "";
      const label = code ? `REJECTED: ${code}` : "ERROR";
      const detail = code ? ` (${msg})` : `: ${msg}`;
      return {
        badge: "bg-rose-500/15 text-rose-400 border-rose-500/30",
        text: `${label}${detail}${src}`,
        title: msg,
      };
    }
    default:
      return { badge: "bg-zinc-800 text-zinc-300 border-zinc-700", text: String(e.type) };
  }
}

const EventRow: React.FC<{ event: PaperEvent }> = ({ event }) => {
  const [expanded, setExpanded] = useState(false);
  const desc = describeEvent(event);
  const time = new Date(event.timestamp).toLocaleTimeString("en-GB", { hour12: false });

  return (
    <div className="rounded-lg bg-zinc-950 border border-zinc-800 hover:border-zinc-700 transition-colors">
      <div className="flex items-center gap-2.5 px-3 py-2 font-mono text-xs">
        <span className="text-[10px] text-zinc-600 w-10 shrink-0 text-right">#{event.seq}</span>
        <span className={`px-2 py-0.5 rounded border text-[10px] font-bold shrink-0 ${desc.badge}`}>
          {event.type}
        </span>
        <span className="text-zinc-500 shrink-0 text-[11px]">{time}</span>
        <span className="text-zinc-300 min-w-0 flex-1 truncate" title={desc.title || desc.text}>
          {desc.text}
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-cyan-400 border border-zinc-800 text-[10px] transition-colors shrink-0"
          title="Tampilkan payload JSON mentah dari server"
        >
          {expanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          RAW
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-2.5">
          <pre className="overflow-x-auto p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[10px] text-amber-300/90 font-mono leading-relaxed">
{JSON.stringify({ seq: event.seq, timestamp: event.timestamp, type: event.type, payload: event.payload }, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export const ExecutionConsole: React.FC = () => {
  const [events, setEvents] = useState<PaperEvent[]>([]);
  const [mode, setMode] = useState<string>("paper");
  const [conn, setConn] = useState<"ok" | "error" | "hidden">("hidden");
  const [fillsToday, setFillsToday] = useState(0);
  const [closedToday, setClosedToday] = useState(0);
  const [openCount, setOpenCount] = useState(0);

  const lastSeqRef = useRef(0);
  const dayRef = useRef(new Date().toDateString());
  const countsRef = useRef({ fills: 0, closed: 0 });
  const mountedRef = useRef(false);

  const tick = useCallback(async () => {
    if (!mountedRef.current) return;
    if (document.hidden) {
      setConn("hidden");
      return;
    }
    try {
      const [eventsRes, statusRes, posRes] = await Promise.all([
        authFetch(`/api/broker/events?sinceSeq=${lastSeqRef.current}`).then((r) => r.json()),
        authFetch("/api/broker/status").then((r) => r.json()),
        authFetch("/api/broker/positions").then((r) => r.json()),
      ]);

      const evData = eventsRes as EventsResponse;
      const evs = Array.isArray(evData.events) ? evData.events : [];

      if (typeof evData.latestSeq === "number" && evData.latestSeq > lastSeqRef.current) {
        lastSeqRef.current = evData.latestSeq;
      }

      // Daily counters (reset when the calendar day flips).
      const today = new Date().toDateString();
      if (today !== dayRef.current) {
        dayRef.current = today;
        countsRef.current = { fills: 0, closed: 0 };
      }
      const c = countsRef.current;
      for (const ev of evs) {
        if (!isToday(ev.timestamp)) continue;
        if (ev.type === "ORDER_FILLED") c.fills += 1;
        else if (ev.type === "POSITION_CLOSED") c.closed += 1;
      }
      setFillsToday(c.fills);
      setClosedToday(c.closed);

      if (evs.length > 0) {
        const sortedNewestFirst = evs.slice().reverse();
        setEvents((prev) => [...sortedNewestFirst, ...prev].slice(0, MAX_CLIENT_EVENTS));
      }

      const posData = posRes as PositionsLite;
      const open =
        posData?.account?.openCount !== undefined && posData.account.openCount !== null
          ? posData.account.openCount
          : Array.isArray(posData?.positions)
          ? posData.positions.filter((p) => p.status === "OPEN").length
          : 0;
      setOpenCount(open);

      const status = statusRes as BrokerStatus;
      if (status?.mode) setMode(status.mode);

      setConn("ok");
    } catch {
      setConn("error");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const interval = setInterval(() => {
      tick();
    }, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    tick();
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tick]);

  const healthDot =
    conn === "ok" ? "bg-emerald-400" : conn === "error" ? "bg-rose-500" : "bg-zinc-600";
  const healthLabel =
    conn === "ok" ? "TERHUBUNG" : conn === "error" ? "GAGAL POLL" : "PAUSED (HIDDEN)";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-zinc-800 rounded-xl flex items-center justify-center text-amber-400 border border-zinc-700/60">
            <Activity className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 font-sans flex items-center gap-2">
              Execution Console
              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-bold font-mono ${
                  mode === "live"
                    ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
                    : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                }`}
              >
                {mode === "live" ? "LIVE" : "PAPER"}
              </span>
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
              Order Lifecycle Stream /api/broker/events
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap font-mono text-[11px]">
          <span className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300">
            Fills hari ini: <strong className="text-emerald-400">{fillsToday}</strong>
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300">
            Closed: <strong className="text-amber-400">{closedToday}</strong>
          </span>
          <span className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300">
            Open: <strong className="text-sky-400">{openCount}</strong>
          </span>
          <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-400">
            <span className={`w-2 h-2 rounded-full ${healthDot}`} />
            {healthLabel}
          </span>
        </div>
      </div>

      {/* Timeline */}
      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80">
          <Radio className="w-8 h-8 text-zinc-600 mb-2" />
          <p className="text-xs font-mono text-zinc-400">
            Belum ada event &mdash; tunggu pipeline cycle atau auto-pilot.
          </p>
          <p className="text-[10px] font-mono text-zinc-600 mt-1">
            Event ORDER_FILLED / POSITION_CLOSED / BRACKET_MONITOR_ACTION akan muncul di sini
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {events.map((ev) => (
            <EventRow key={ev.seq} event={ev} />
          ))}
        </div>
      )}
    </div>
  );
};