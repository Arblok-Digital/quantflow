import React, { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "../hooks/useAuth";
import {
  ShieldCheck,
  ShieldAlert,
  Power,
  Zap,
  Clock,
  TrendingDown,
  Layers,
  AlertTriangle,
  RefreshCw,
  Lock,
  Unlock,
} from "lucide-react";

interface GuardrailsSnapshot {
  success?: boolean;
  config: {
    maxOpenPositions: number;
    maxDailyLossPercent: number;
    minOrderIntervalMs: number;
    killSwitchDefault?: boolean;
  };
  state: {
    killSwitch: boolean;
    dailyLossPercent: number;
    openCount: number;
    lastOrderAt: number | null;
    cooldownRemainingMs: number;
    armedForLive: boolean;
  };
  today: {
    realizedPnlUSD: number;
    lossPercent: number;
  };
}

const POLL_MS = 4000;

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const GuardrailsPanel: React.FC = () => {
  const [data, setData] = useState<GuardrailsSnapshot | null>(null);
  const [conn, setConn] = useState<"ok" | "error" | "hidden" | "loading">("loading");
  const [killBusy, setKillBusy] = useState(false);
  const [armBusy, setArmBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [cooldownTick, setCooldownTick] = useState(0);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (document.hidden) {
      setConn("hidden");
      return;
    }
    try {
      const res = await authFetch("/api/broker/guardrails");
      if (res.status === 401) {
        setConn("error");
        return;
      }
      const payload = (await res.json()) as GuardrailsSnapshot & { success?: boolean };
      if (payload && payload.config && payload.state) {
        setData(payload as GuardrailsSnapshot);
        setConn("ok");
      } else {
        setConn("error");
      }
    } catch {
      setConn("error");
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const iv = setInterval(() => load(), POLL_MS);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    load();
    return () => {
      mountedRef.current = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  // Local countdown for cooldown
  useEffect(() => {
    if (!data || data.state.cooldownRemainingMs <= 0) return;
    const t = setInterval(() => setCooldownTick((v) => v + 1), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.state.cooldownRemainingMs]);

  const cooldownRemaining = (() => {
    if (!data) return 0;
    const base = data.state.cooldownRemainingMs;
    // optimistic decay: reduce by elapsed ticks since last load
    // we estimate roughly 1000ms per tick, but reload will correct
    return Math.max(0, base - cooldownTick * 1000);
  })();

  // Reset tick when data refreshes
  useEffect(() => {
    setCooldownTick(0);
  }, [data?.state.cooldownRemainingMs, data?.state.lastOrderAt]);

  const handleKillToggle = async () => {
    if (!data) return;
    const nextActive = !data.state.killSwitch;
    const ok = window.confirm(
      nextActive
        ? "Aktifkan KILL SWITCH? Semua order baru akan ditolak guardrail sampai dimatikan lagi."
        : "Nonaktifkan KILL SWITCH? Order akan kembali bisa masuk (tetap dijaga guardrails lain)."
    );
    if (!ok) return;
    setKillBusy(true);
    setMsg(null);
    try {
      const res = await authFetch("/api/broker/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: nextActive }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        const errMsg = payload?.message || `Gagal toggle kill-switch (HTTP ${res.status})`;
        setMsg({ type: "err", text: errMsg });
      } else {
        setMsg({ type: "ok", text: nextActive ? "Kill-switch AKTIF — order diblokir." : "Kill-switch NONAKTIF — order kembali diizinkan." });
      }
      await load();
    } catch (e: any) {
      setMsg({ type: "err", text: e?.message || "Kill toggle gagal." });
    } finally {
      setKillBusy(false);
    }
  };

  const handleArm = async (arm: boolean) => {
    const action = arm ? "ARM" : "DISARM";
    if (arm) {
      const ok = window.confirm("ARM live trading? Pastikan TRADING_MODE=live dan credential sudah terisi. Order real akan terkirim ke exchange.");
      if (!ok) return;
    } else {
      const ok = window.confirm("DISARM live trading? Order live akan terkunci kembali ke paper.");
      if (!ok) return;
    }
    setArmBusy(true);
    setMsg(null);
    try {
      const res = await authFetch(arm ? "/api/broker/arm" : "/api/broker/disarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        // Brief says: cek juga field code vs status, kalau cuma message, baca $msg.code atau $msg.status
        const code = payload?.code || payload?.status || "";
        const message = payload?.message || payload?.msg || `Gagal ${action}`;
        const display = code ? `${code}: ${message}` : message;
        setMsg({ type: "err", text: display });
      } else {
        setMsg({ type: "ok", text: arm ? "LIVE ARMED — order live aktif." : "LIVE DISARMED — kembali ke paper." });
      }
      await load();
    } catch (e: any) {
      setMsg({ type: "err", text: e?.message || `${action} gagal.` });
    } finally {
      setArmBusy(false);
    }
  };

  if (!data) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 shadow-sm flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-400">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider font-mono">Guardrails</h2>
              <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">Live server /api/broker/guardrails</p>
            </div>
          </div>
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        </div>
        <div className="text-xs font-mono text-zinc-500 py-6 text-center border border-dashed border-zinc-800 rounded-xl bg-zinc-950/40">
          {conn === "error" ? "Gagal memuat guardrails — periksa auth / koneksi server." : "Memuat guardrails dari server..."}
        </div>
      </div>
    );
  }

  const { config, state, today } = data;
  const dailyPct = state.dailyLossPercent;
  const dailyLimit = config.maxDailyLossPercent;
  const dailyProgress = dailyLimit > 0 ? Math.min(100, (dailyPct / dailyLimit) * 100) : 0;
  const dailyColor =
    dailyPct >= dailyLimit
      ? "bg-rose-500"
      : dailyPct >= dailyLimit * 0.7
      ? "bg-amber-500"
      : "bg-emerald-500";
  const openAtCap = state.openCount >= config.maxOpenPositions;
  const cooldownActive = cooldownRemaining > 0;
  const isKillActive = state.killSwitch;
  const isArmed = state.armedForLive;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 relative overflow-hidden shadow-sm flex flex-col gap-4">
      <div className="absolute inset-0 opacity-10 pointer-events-none bento-dot-grid" />

      <div className="relative z-10 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-lg flex items-center justify-center border ${
                isKillActive ? "bg-rose-500/15 border-rose-500/30 text-rose-400" : "bg-emerald-500/15 border-emerald-500/30 text-emerald-400"
              }`}
            >
              {isKillActive ? <ShieldAlert className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
            </div>
            <div>
              <h2 className="text-xs font-semibold text-zinc-200 uppercase tracking-wider font-mono flex items-center gap-2">
                Guardrails — Live
                <span className={`w-2 h-2 rounded-full ${conn === "ok" ? "bg-emerald-400" : conn === "error" ? "bg-rose-500" : "bg-zinc-600"}`} />
              </h2>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
                config + state • poll 4s • server truth
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className={`px-2 py-0.5 rounded border text-[10px] font-mono font-bold uppercase ${
                isKillActive ? "bg-rose-500 text-white border-rose-600 animate-pulse" : "bg-zinc-800 text-zinc-400 border-zinc-700"
              }`}
            >
              kill {isKillActive ? "ON" : "OFF"}
            </span>
            <span
              className={`px-2 py-0.5 rounded border text-[10px] font-mono font-bold uppercase ${
                isArmed ? "bg-rose-600 text-white border-rose-500" : "bg-zinc-800 text-zinc-500 border-zinc-700"
              }`}
            >
              {isArmed ? "LIVE ARMED" : "PAPER"}
            </span>
          </div>
        </div>

        {/* Daily Loss bar */}
        <div className="bg-zinc-950/70 p-3 rounded-xl border border-zinc-800 font-mono space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-400 text-[11px] flex items-center gap-1">
              <TrendingDown className="w-3 h-3" /> Daily Loss Guard
            </span>
            <span className={`font-bold ${dailyPct >= dailyLimit ? "text-rose-400" : dailyPct >= dailyLimit * 0.5 ? "text-amber-400" : "text-zinc-100"}`}>
              {dailyPct.toFixed(2)}% / {dailyLimit}% limit
            </span>
          </div>
          <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${dailyColor}`} style={{ width: `${dailyProgress}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-zinc-500">
            <span>today realized ${fmtMoney(today.realizedPnlUSD)} • loss {today.lossPercent.toFixed(2)}%</span>
            <span>{dailyProgress.toFixed(0)}% of limit</span>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 font-mono text-xs">
          <div className={`p-3 rounded-xl border ${openAtCap ? "bg-rose-950/30 border-rose-500/30" : "bg-zinc-950/80 border-zinc-800"}`}>
            <span className="text-[10px] text-zinc-500 uppercase font-semibold flex items-center gap-1">
              <Layers className="w-3 h-3" /> Open Positions
            </span>
            <span className={`text-sm font-bold mt-1 block ${openAtCap ? "text-rose-400" : "text-zinc-100"}`}>
              {state.openCount} / {config.maxOpenPositions}
            </span>
            <span className="text-[10px] text-zinc-500">{openAtCap ? "CAP REACHED — reject open" : "guard: MAX_OPEN_POSITIONS"}</span>
          </div>
          <div className={`p-3 rounded-xl border ${cooldownActive ? "bg-amber-950/30 border-amber-500/30" : "bg-zinc-950/80 border-zinc-800"}`}>
            <span className="text-[10px] text-zinc-500 uppercase font-semibold flex items-center gap-1">
              <Clock className="w-3 h-3" /> Cooldown
            </span>
            <span className={`text-sm font-bold mt-1 block ${cooldownActive ? "text-amber-400" : "text-zinc-400"}`}>
              {cooldownActive ? `${Math.ceil(cooldownRemaining / 1000)}s` : "READY"}
            </span>
            <span className="text-[10px] text-zinc-500">min interval {config.minOrderIntervalMs}ms</span>
          </div>
          <div className="p-3 rounded-xl border bg-zinc-950/80 border-zinc-800 col-span-2 sm:col-span-1">
            <span className="text-[10px] text-zinc-500 uppercase font-semibold flex items-center gap-1">
              <Zap className="w-3 h-3" /> Last Order
            </span>
            <span className="text-sm font-bold mt-1 block text-zinc-100">
              {state.lastOrderAt ? new Date(state.lastOrderAt).toLocaleTimeString("en-GB", { hour12: false }) : "—"}
            </span>
            <span className="text-[10px] text-zinc-500">today PnL ${fmtMoney(today.realizedPnlUSD)}</span>
          </div>
        </div>

        {/* Config strip */}
        <div className="grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 text-center">
            <span className="text-zinc-500 block text-[9px] uppercase">maxOpenPositions</span>
            <span className="font-bold text-amber-400">{config.maxOpenPositions}</span>
          </div>
          <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 text-center">
            <span className="text-zinc-500 block text-[9px] uppercase">maxDailyLoss%</span>
            <span className="font-bold text-rose-400">{config.maxDailyLossPercent}%</span>
          </div>
          <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 text-center">
            <span className="text-zinc-500 block text-[9px] uppercase">minOrderInterval</span>
            <span className="font-bold text-cyan-400">{config.minOrderIntervalMs}ms</span>
          </div>
        </div>

        {/* Kill + Arm controls */}
        <div className="bg-zinc-950/80 p-3 rounded-xl border border-zinc-800 font-mono text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-zinc-400 text-[11px] uppercase tracking-wider font-semibold">Risk Controls — Server</span>
            {msg && (
              <span className={`text-[10px] px-2 py-0.5 rounded border ${msg.type === "ok" ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "bg-rose-500/15 text-rose-300 border-rose-500/30"}`}>
                {msg.text}
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleKillToggle}
              disabled={killBusy}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold text-xs border transition ${
                isKillActive
                  ? "bg-rose-500 hover:bg-rose-600 text-white border-rose-500 shadow shadow-rose-500/20"
                  : "bg-zinc-800 hover:bg-rose-500/20 text-rose-300 border-rose-500/30"
              } disabled:opacity-50`}
            >
              {killBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
              {isKillActive ? "Disable Kill-Switch" : "Enable Kill-Switch"}
            </button>

            {isArmed ? (
              <button
                onClick={() => handleArm(false)}
                disabled={armBusy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 font-bold text-xs disabled:opacity-50 transition"
              >
                {armBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Unlock className="w-3.5 h-3.5" />}
                DISARM Live
              </button>
            ) : (
              <button
                onClick={() => handleArm(true)}
                disabled={armBusy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-zinc-950 border border-amber-600 font-bold text-xs disabled:opacity-50 transition"
              >
                {armBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                ARM Live
              </button>
            )}
          </div>

          <p className="text-[10px] text-zinc-500 leading-relaxed">
            Kill-switch via <span className="text-zinc-300">POST /api/broker/kill</span> • ARM/DISARM via <span className="text-zinc-300">POST /api/broker/arm</span> — gagal dengan code
            <span className="text-amber-400"> ARM_REQUIRES_LIVE_AND_CREDENTIALS</span> jika TRADING_MODE ≠ live atau credential belum terisi. Pesan server ditampilkan di atas.
          </p>
        </div>

        {isKillActive && (
          <div className="flex items-center gap-2 p-2.5 rounded-xl bg-rose-950/40 border border-rose-500/30 font-mono text-xs text-rose-300">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              KILL SWITCH AKTIF — semua order baru ditolak dengan reason <span className="font-bold">KILL_SWITCH_ACTIVE</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default GuardrailsPanel;
