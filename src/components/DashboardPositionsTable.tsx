import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Crosshair,
  Info,
  ShieldAlert,
  Target,
  XCircle,
} from "lucide-react";
import { Candle, Position } from "../types";
import { estimatePositionEta } from "../logic/positionEta";
import { authFetch } from "../hooks/useAuth";
import { useToast } from "./ExecutionToasts";
import { normalizeSide } from "../lib/sideNormalize";
import { formatDeadlineWib } from "../logic/intradayPlan";

// ---------------------------------------------------------------------------
// DashboardPositionsTable — satu-satunya tabel posisi di dashboard exchange.
// Server book via props (paper.positions, reader murni). Daftar PositionCard
// dihapus; SEMUA infonya dipertahankan sebagai expand-row collapsed-default.
// Tidak ada fetch/polling baru — data mengalir dari shared hooks di App.
// ---------------------------------------------------------------------------

type CloseResult =
  | { ok: boolean; reason?: string; message?: string; realizedPnlUSD?: number }
  | void;

// ---------------------------------------------------------------------------
// ADV-01 — deadline intraday (time-stop) & hasil attempt, dari exit engine.
// ---------------------------------------------------------------------------
interface DeadlineView {
  deadlineAt: number;
  remainingMs: number;
  overdue: boolean;
}

function deadlineInfo(pos: Position): DeadlineView | null {
  const maxHoldMs = (pos.exitConfig as { maxHoldMs?: number } | null | undefined)?.maxHoldMs;
  const hold = Number(maxHoldMs);
  const opened = Number(pos.openedAt);
  if (!(Number.isFinite(hold) && hold > 0 && Number.isFinite(opened) && opened > 0)) return null;
  const deadlineAt = opened + hold;
  const remainingMs = deadlineAt - Date.now();
  return { deadlineAt, remainingMs, overdue: remainingMs <= 0 };
}

const fmtDurShort = (ms: number): string => {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}j ${m % 60}m`;
};

interface DashboardPositionsTableProps {
  positions: Position[];
  currentPrice: number;
  activeCandles?: Candle[];
  mode: "paper" | "live";
  marketType?: string;
  onClosePosition: (
    positionId: string,
    reason?: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE"
  ) => Promise<CloseResult>;
  onMoveToBreakEven: (positionId: string) => Promise<CloseResult>;
  onSimulateLong: () => void;
  onSimulateShort: () => void;
  onServerPositions?: (openServerIds: string[]) => void;
}

const fmtMoney = (n: number): string =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n: number): string =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });

// ---------------------------------------------------------------------------
// F3 — Preset exit plan otomatis (server-side exit engine: BE/trailing/
// partial TP/time-stop). Dipasang per posisi via /api/broker/position/update
// (exitConfig); dievaluasi bracket monitor tiap pass. PAPER saja.
// ---------------------------------------------------------------------------
const AUTO_EXIT_PRESETS: Array<{ key: string; label: string; config: Record<string, unknown> | null; hint: string }> = [
  { key: "off", label: "Off (statis)", config: null, hint: "SL/TP statis murni — tanpa exit otomatis" },
  { key: "be1", label: "BE @1R", config: { breakEvenTriggerR: 1 }, hint: "Begitu profit ≥ 1R, SL digeser ke entry (+buffer fee)" },
  { key: "trail05", label: "Trail 0.5%", config: { trailingPct: 0.5 }, hint: "SL mengikuti puncak − 0.5% (ratchet: hanya mengetat)" },
  { key: "trail1", label: "Trail 1%", config: { trailingPct: 1 }, hint: "SL mengikuti puncak − 1% (ratchet: hanya mengetat)" },
  { key: "be1-trail1", label: "BE @1R + Trail 1%", config: { breakEvenTriggerR: 1, trailingPct: 1 }, hint: "BE sekali di 1R, lalu trailing dari puncak harga" },
  { key: "ladder", label: "Ladder 1R/2R + BE", config: { breakEvenTriggerR: 1, partialLevels: [{ rMultiple: 1, closePct: 50 }, { rMultiple: 2, closePct: 50 }] }, hint: "Tutup 50% qty di 1R, sisanya 50% di 2R, BE otomatis" },
];
function autoExitKeyOf(cfg?: Record<string, unknown> | null): string {
  if (!cfg) return "off";
  const s = JSON.stringify(cfg);
  const hit = AUTO_EXIT_PRESETS.find((p) => p.config && JSON.stringify(p.config) === s);
  return hit?.key ?? "custom";
}

export const DashboardPositionsTable: React.FC<DashboardPositionsTableProps> = ({
  positions,
  currentPrice,
  activeCandles = [],
  mode,
  marketType = "FUTURES",
  onClosePosition,
  onMoveToBreakEven,
  onSimulateLong,
  onSimulateShort,
  onServerPositions,
}) => {
  const { pushToast } = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSL, setEditSL] = useState("");
  const [editTP, setEditTP] = useState("");
  const [editErr, setEditErr] = useState<string | null>(null);
  const [autoExitBusyId, setAutoExitBusyId] = useState<string | null>(null);

  const isLiveMode = mode === "live";
  const isSpotMarket = String(marketType).toUpperCase() === "SPOT";

  const openPositions = useMemo(
    () => [...positions].sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0)),
    [positions]
  );

  // Prune callback ke App — hanya bila SET id berubah (trace join string),
  // agar refresh-after-prune tidak memicu loop fetch tanpa henti.
  const lastIdsRef = useRef<string>("__init__");
  const onServerPositionsRef = useRef(onServerPositions);
  onServerPositionsRef.current = onServerPositions;
  useEffect(() => {
    const ids = openPositions
      .map((p) => String(p.id ?? ""))
      .filter(Boolean);
    const key = ids.join(",");
    if (key !== lastIdsRef.current) {
      lastIdsRef.current = key;
      onServerPositionsRef.current?.(ids);
    }
  }, [openPositions]);

  const handleClose = async (pos: Position) => {
    const pid = String(pos.id ?? "");
    if (!pid) return;
    if (
      !window.confirm(
        `Tutup posisi ${pos.symbol} ${pos.side}? PnL floating $${Number(pos.unrealizedPnl).toFixed(2)} akan direalisasi.`
      )
    )
      return;
    setBusyId(pid);
    setRowError(null);
    try {
      const res = await onClosePosition(pid, "MANUAL_CLOSE");
      if (res && !res.ok) {
        const text = `${res.reason || "GAGAL"}: ${res.message || "Close ditolak."}`;
        setRowError({ id: pid, text });
        pushToast("error", `Close ${pos.symbol} gagal`, text);
      } else {
        pushToast(
          "success",
          res.partial ? `Posisi ${pos.symbol} ditutup SEBAGIAN` : `Posisi ${pos.symbol} ditutup`,
          res.partial ? "Sisa qty masih OPEN — reload book server." : "PnL direalisasi — detail di tab History."
        );
      }
    } catch (err) {
      const text = `NETWORK: ${(err as Error).message}`;
      setRowError({ id: pid, text });
      pushToast("error", `Close ${pos.symbol} gagal`, text);
    } finally {
      setBusyId(null);
    }
  };

  const handleBreakEven = async (pos: Position) => {
    const pid = String(pos.id ?? "");
    if (!pid) return;
    setBusyId(pid);
    setRowError(null);
    try {
      const res = await onMoveToBreakEven(pid);
      if (res && !res.ok) {
        const text = `${res.reason || "GAGAL"}: ${res.message || "Break-even ditolak."}`;
        setRowError({ id: pid, text });
        pushToast("error", `Break-even ${pos.symbol} gagal`, text);
      } else {
        pushToast(
          "success",
          `SL ${pos.symbol} → Break-even`,
          "Stop loss digeser ke harga entry (+buffer fee)."
        );
      }
    } catch (err) {
      const text = `NETWORK: ${(err as Error).message}`;
      setRowError({ id: pid, text });
      pushToast("error", `Break-even ${pos.symbol} gagal`, text);
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveBracket = async (pos: Position) => {
    const pid = String(pos.id ?? "");
    const sl = Number(editSL);
    const tp = Number(editTP);
    if (!isFinite(sl) || sl <= 0 || !isFinite(tp) || tp <= 0) {
      setEditErr("SL & TP harus angka > 0.");
      return;
    }
    if (pos.side === "LONG" && !(sl < currentPrice && currentPrice < tp)) {
      setEditErr("LONG: harus SL < harga sekarang < TP.");
      return;
    }
    if (pos.side === "SHORT" && !(tp < currentPrice && currentPrice < sl)) {
      setEditErr("SHORT: harus TP < harga sekarang < SL.");
      return;
    }
    setBusyId(pid);
    setEditErr(null);
    try {
      const res = await authFetch("/api/broker/position/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: pid, stopLoss: sl, takeProfit: tp }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        setEditErr(
          `${payload?.reason || `HTTP ${res.status}`}: ${payload?.message || "Update ditolak."}`
        );
        return;
      }
      setEditingId(null);
      pushToast("success", `Bracket ${pos.symbol} diupdate`, `SL $${fmtMoney(sl)} / TP $${fmtMoney(tp)}`);
    } catch (err) {
      setEditErr(`NETWORK: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleSetAutoExit = async (pos: Position, config: Record<string, unknown> | null) => {
    const pid = String(pos.id ?? "");
    if (!pid) return;
    if (isLiveMode) {
      // Live path butuh conditional orders exchange — engine ini PAPER saja.
      setRowError({ id: pid, text: "Auto-exit engine hanya untuk posisi PAPER (live: kelola manual di exchange)." });
      return;
    }
    setAutoExitBusyId(pid);
    setRowError(null);
    try {
      const res = await authFetch("/api/broker/position/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId: pid, exitConfig: config }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        const text = `${payload?.reason || `HTTP ${res.status}`}: ${payload?.message || "Auto-exit ditolak."}`;
        setRowError({ id: pid, text });
        pushToast("error", `Auto-exit ${pos.symbol} gagal`, text);
      } else {
        pushToast(
          "success",
          `Auto-exit ${pos.symbol} ${config ? "diaktifkan" : "dimatikan"}`,
          config
            ? "Exit engine berlaku di bracket monitor server (evaluasi tiap ~3 detik)."
            : "Kembali ke SL/TP statis murni."
        );
      }
    } catch (err) {
      const text = `NETWORK: ${(err as Error).message}`;
      setRowError({ id: pid, text });
      pushToast("error", `Auto-exit ${pos.symbol} gagal`, text);
    } finally {
      setAutoExitBusyId(null);
    }
  };

  if (openPositions.length === 0) {
    return (
      <div className="text-center py-10 px-4 bg-zinc-950/60 rounded-xl border border-zinc-800/80">
        <Crosshair className="w-10 h-10 text-zinc-600 mx-auto mb-2" />
        <h4 className="text-sm font-semibold text-zinc-300">Belum Ada Posisi Terbuka</h4>
        <p className="text-xs text-zinc-500 max-w-md mx-auto mt-1 mb-4">
          Agent sedang memindai pola <strong>MTF Liquidity Sweep</strong> dan menunggu
          konfirmasi on-chain whale. Anda juga dapat menekan tombol simulasi di bawah untuk
          menguji sistem.
        </p>
        <div className="flex justify-center gap-2 flex-wrap">
          <button type="button"
            onClick={onSimulateLong}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition ${
              isLiveMode
                ? "bg-rose-600 hover:bg-rose-500 text-white"
                : "bg-emerald-600 hover:bg-emerald-500 text-zinc-950"
            }`}
          >
            {isLiveMode ? "⚠ EXECUTE LONG (live)" : "+ Simulasikan Entry LONG"}
          </button>
          <button type="button"
            onClick={onSimulateShort}
            disabled={isSpotMarket}
            className="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold font-mono transition disabled:opacity-40 disabled:cursor-not-allowed"
            title={
              isSpotMarket
                ? "SPOT hanya bisa BUY/LONG — ganti ke FUTURES untuk SHORT"
                : "Simulasikan entry SHORT"
            }
          >
            {isLiveMode ? "⚠ EXECUTE SHORT (live)" : "+ Simulasikan Entry SHORT"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left font-mono text-xs min-w-[880px]">
        <thead>
          <tr className="border-b border-zinc-800 text-zinc-500 text-[10px] uppercase">
            <th className="pb-2 pr-2">Symbol</th>
            <th className="pb-2 pr-2">Side</th>
            <th className="pb-2 pr-2 text-right">Qty</th>
            <th className="pb-2 pr-2 text-right">Entry</th>
            <th className="pb-2 pr-2 text-right">Mark</th>
            <th className="pb-2 pr-2 text-right">uPnL $</th>
            <th className="pb-2 pr-2 text-right">uPnL %</th>
            <th className="pb-2 pr-2 text-right">SL</th>
            <th className="pb-2 pr-2 text-right">TP</th>
            <th className="pb-2 pr-2 text-right">Lev</th>
            <th className="pb-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60">
          {openPositions.map((pos) => {
            const pid = String(pos.id ?? "");
            const side = normalizeSide(pos.side);
            const profitable = Number(pos.unrealizedPnl) >= 0;
            const busy = busyId === pid;
            const expanded = expandedId === pid;
            const canBreakEven = Math.abs(Number(pos.stopLoss) - Number(pos.entryPrice)) > 1e-9;
            const rowTint = profitable
              ? "bg-emerald-500/[0.04] hover:bg-emerald-500/[0.08]"
              : "bg-rose-500/[0.04] hover:bg-rose-500/[0.08]";
            return (
              <React.Fragment key={pid}>
                <tr className={`transition-colors ${rowTint}`}>
                  <td className="py-2.5 pr-2 font-bold text-zinc-200 whitespace-nowrap">
                    {pos.symbol}
                  </td>
                  <td className="py-2.5 pr-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                        side === "LONG"
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                          : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                      }`}
                    >
                      {side}
                    </span>
                  </td>
                  <td className="py-2.5 pr-2 text-right">
                    <span className="text-zinc-300">{fmtNum(pos.qty)}</span>
                    <span className="block text-[10px] text-zinc-500">
                      ≈ ${fmtMoney(Number(pos.notionalUSD || Number(pos.qty) * Number(pos.entryPrice)))}
                    </span>
                  </td>
                  <td className="py-2.5 pr-2 text-right text-zinc-300">${fmtMoney(pos.entryPrice)}</td>
                  <td className="py-2.5 pr-2 text-right text-zinc-100 font-semibold">
                    ${fmtMoney(pos.currentPrice)}
                  </td>
                  <td
                    className={`py-2.5 pr-2 text-right font-bold ${
                      profitable ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {profitable ? "+" : "-"}${fmtMoney(Math.abs(Number(pos.unrealizedPnl)))}
                  </td>
                  <td
                    className={`py-2.5 pr-2 text-right ${
                      profitable ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {profitable ? "+" : "-"}
                    {fmtMoney(Math.abs(Number(pos.unrealizedPnlPercent)))}%
                  </td>
                  <td className="py-2.5 pr-2 text-right text-rose-400">${fmtMoney(pos.stopLoss)}</td>
                  <td className="py-2.5 pr-2 text-right text-emerald-400">
                    ${fmtMoney(pos.takeProfit)}
                  </td>
                  <td className="py-2.5 pr-2 text-right text-zinc-300">{fmtNum(pos.leverage || 1)}x</td>
                  <td className="py-2.5 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1.5">
                      {canBreakEven && (
                        <button type="button"
                          onClick={() => handleBreakEven(pos)}
                          disabled={busy}
                          className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[10px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Geser Stop Loss ke harga entry (break-even)"
                        >
                          BE
                        </button>
                      )}
                      <button type="button"
                        onClick={() => handleClose(pos)}
                        disabled={busy}
                        className="px-2 py-1 rounded bg-zinc-800 hover:bg-rose-600 hover:text-white text-slate-300 border border-zinc-700 hover:border-rose-500 text-[10px] font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Tutup posisi via /api/broker/close"
                      >
                        {busy && !expanded ? "…" : "Close"}
                      </button>
                      <button type="button"
                        onClick={() => setExpandedId(expanded ? null : pid)}
                        className={`px-1.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 text-[10px] transition-colors ${
                          expanded ? "border-amber-500/50 text-amber-300" : ""
                        }`}
                        title={expanded ? "Tutup detail" : "Buka detail (gauge, EST, reasoning, edit SL/TP)"}
                      >
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
                        />
                      </button>
                    </div>
                  </td>
                </tr>
                {rowError && rowError.id === pid && (
                  <tr>
                    <td colSpan={11} className="pb-1">
                      <p className="text-[11px] font-mono text-rose-400 bg-rose-950/30 border border-rose-500/30 rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-2">
                        <span>Aksi gagal — {rowError.text}</span>
                        <button type="button"
                          onClick={() => setRowError(null)}
                          className="text-rose-400 hover:text-rose-200 shrink-0"
                          title="Tutup"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                        </button>
                      </p>
                    </td>
                  </tr>
                )}
                {expanded && (
                  <tr>
                    <td colSpan={11} className="pb-3">
                      <PositionExpandRow
                        pos={pos}
                        currentPrice={currentPrice}
                        activeCandles={activeCandles}
                        busy={busy}
                        editing={editingId === pid}
                        editSL={editSL}
                        editTP={editTP}
                        editErr={editingId === pid ? editErr : null}
                        onStartEdit={() => {
                          setEditingId(pid);
                          setEditSL(String(pos.stopLoss));
                          setEditTP(String(pos.takeProfit));
                          setEditErr(null);
                        }}
                        onCancelEdit={() => setEditingId(null)}
                        onEditSL={setEditSL}
                        onEditTP={setEditTP}
                        onSaveEdit={() => handleSaveBracket(pos)}
                        onBreakEven={() => handleBreakEven(pos)}
                        onClose={() => handleClose(pos)}
                        autoExitKey={autoExitKeyOf(pos.exitConfig)}
                        autoExitBusy={autoExitBusyId === pid}
                        onSetAutoExit={(config) => handleSetAutoExit(pos, config)}
                      />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Expand-row: SEMUA info ex-PositionCard (gauge, EST, stats, reasoning,
// edit SL/TP, BE/close). Collapsed-default; dirender hanya saat expanded.
// Field meta (reasoning/confidence/TF/targetPool) bisa undefined untuk posisi
// lama (tidak persist di DB) — tampilkan fallback jujur, bukan fabrikasi.
// ---------------------------------------------------------------------------

interface ExpandRowProps {
  pos: Position;
  currentPrice: number;
  activeCandles: Candle[];
  busy: boolean;
  editing: boolean;
  editSL: string;
  editTP: string;
  editErr: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onEditSL: (v: string) => void;
  onEditTP: (v: string) => void;
  onSaveEdit: () => void;
  onBreakEven: () => void;
  onClose: () => void;
  /** F3: preset auto-exit yang sedang aktif untuk posisi ini. */
  autoExitKey: string;
  autoExitBusy: boolean;
  onSetAutoExit: (config: Record<string, unknown> | null) => void;
}

const PositionExpandRow: React.FC<ExpandRowProps> = ({
  pos,
  currentPrice,
  activeCandles,
  busy,
  editing,
  editSL,
  editTP,
  editErr,
  onStartEdit,
  onCancelEdit,
  onEditSL,
  onEditTP,
  onSaveEdit,
  onBreakEven,
  onClose,
  autoExitKey,
  autoExitBusy,
  onSetAutoExit,
}) => {
  const isPosProfitable = Number(pos.unrealizedPnl) >= 0;
  const isSpotPos = String(pos.marketType || "").toUpperCase() === "SPOT";

  const distToTPUSD = Math.abs(Number(pos.takeProfit) - currentPrice);
  const distToCLUSD = Math.abs(currentPrice - Number(pos.stopLoss));
  const distToTPPercent = currentPrice > 0 ? ((distToTPUSD / currentPrice) * 100).toFixed(2) : "—";
  const distToCLPercent = currentPrice > 0 ? ((distToCLUSD / currentPrice) * 100).toFixed(2) : "—";

  const potentialProfitCashflow =
    pos.potentialProfitUSD || Number(pos.qty) * Math.abs(Number(pos.takeProfit) - Number(pos.entryPrice));
  const potentialLossCashflow =
    pos.potentialLossUSD || Number(pos.qty) * Math.abs(Number(pos.entryPrice) - Number(pos.stopLoss));
  const rr =
    potentialLossCashflow > 0
      ? (potentialProfitCashflow / potentialLossCashflow).toFixed(2)
      : "2.5";

  let progressPercent = 50;
  if (pos.side === "LONG") {
    const totalSpan = Number(pos.takeProfit) - Number(pos.stopLoss);
    if (totalSpan > 0) {
      progressPercent = Math.min(100, Math.max(0, ((currentPrice - Number(pos.stopLoss)) / totalSpan) * 100));
    }
  } else {
    const totalSpan = Number(pos.stopLoss) - Number(pos.takeProfit);
    if (totalSpan > 0) {
      progressPercent = Math.min(100, Math.max(0, ((Number(pos.stopLoss) - currentPrice) / totalSpan) * 100));
    }
  }

  const eta = useMemo(
    () => estimatePositionEta(pos, currentPrice, activeCandles),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pos.id, pos.takeProfit, pos.stopLoss, pos.timeframe, currentPrice, activeCandles.length]
  );

  const baseSym = String(pos.symbol).split("/")[0];

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 sm:p-4 space-y-3">
      {/* Badges: TF entry permanen + market + confidence */}
      <div className="flex items-center gap-1.5 flex-wrap font-mono">
        <span
          className="text-[10px] font-black px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
          title={`Entry dicatat di TF ${pos.timeframe || "?"} — estimasi durasi memakai interval TF ini`}
        >
          TF {pos.timeframe || "?"}
        </span>
        <span
          className={`text-[10px] font-black px-1.5 py-0.5 rounded border ${
            isSpotPos
              ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
              : "bg-amber-500/10 text-amber-300/80 border-amber-500/20"
          }`}
          title={isSpotPos ? "SPOT: aset beneran — tanpa liquidation, leverage 1x" : "FUTURES: margin + liquidation berlaku"}
        >
          {pos.marketType || "FUTURES"}
        </span>
        {!isSpotPos && pos.leverage ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
            {pos.leverage}x
          </span>
        ) : null}
        <span className="text-[10px] text-zinc-500">
          Confidence: <strong className="text-emerald-400">{pos.confidence != null ? `${pos.confidence}%` : "—"}</strong>
        </span>
        <span className="text-[10px] text-zinc-600 ml-auto">
          Open: {pos.openedAt ? new Date(pos.openedAt).toLocaleString("en-GB", { hour12: false }) : "—"}
        </span>
        {(() => {
          const ddl = deadlineInfo(pos);
          const att = pos.exitState?.deadlineAttempt;
          if (!ddl && !att) return null;
          return (
            <span className="ml-auto flex items-center gap-1.5 flex-wrap justify-end">
              {ddl &&
                (ddl.overdue ? (
                  <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 font-mono" title={`Deadline WIB: ${formatDeadlineWib(ddl.deadlineAt)}`}>
                    ⏰ time-stop lewat — close retry
                  </span>
                ) : (
                  <span className="text-[9.5px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 font-mono" title={`Deadline WIB: ${formatDeadlineWib(ddl.deadlineAt)}`}>
                    ⏳ time-stop sisa {fmtDurShort(ddl.remainingMs)} (WIB)
                  </span>
                ))}
              {att && (
                <span
                  className={`text-[9.5px] font-bold px-1.5 py-0.5 rounded border font-mono ${
                    att.status === "FAILED"
                      ? "bg-rose-500/25 text-rose-300 border-rose-500/50"
                      : att.status === "PARTIAL"
                        ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                        : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  }`}
                  title={att.message || `Attempted ${new Date(att.attemptedAt).toLocaleString("en-GB", { hour12: false })}`}
                >
                  deadline: {att.status}
                  {att.status === "FAILED" ? " — retry pass berikutnya" : att.message ? ` — ${att.message.slice(0, 90)}` : ""}
                </span>
              )}
            </span>
          );
        })()}
      </div>

      {/* Stats grid: entry / live / qty / notional (+ liq FUTURES) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
          <span className="text-[10px] text-zinc-500 block uppercase">Harga Entry</span>
          <span className="font-bold text-zinc-200">${fmtMoney(pos.entryPrice)}</span>
        </div>
        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
          <span className="text-[10px] text-zinc-500 block uppercase">Harga Live (1s)</span>
          <span className="font-bold text-zinc-100">${fmtMoney(currentPrice)}</span>
        </div>
        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
          <span className="text-[10px] text-zinc-500 block uppercase">Posisi Qty</span>
          <span className="font-bold text-zinc-300">
            {fmtNum(pos.qty)} {baseSym}
          </span>
          <span className="block text-[10px] text-zinc-500">
            ≈ ${fmtMoney(Number(pos.notionalUSD || Number(pos.qty) * Number(pos.entryPrice)))}
          </span>
        </div>
        <div className="p-2 rounded-lg bg-zinc-900/60 border border-zinc-800">
          <span className="text-[10px] text-zinc-500 block uppercase">Nilai Notional ($)</span>
          <span className="font-bold text-amber-400">
            $
            {Number(pos.notionalUSD || Number(pos.qty) * Number(pos.entryPrice)).toLocaleString(undefined, {
              maximumFractionDigits: 0,
            })}
          </span>
        </div>
      </div>
      {!isSpotPos && (
        <div className="font-mono text-[11px] text-zinc-400">
          Liq:{" "}
          <strong className="text-zinc-200">
            {pos.liquidationPrice ? `$${fmtMoney(pos.liquidationPrice)}` : "—"}
          </strong>
          <span className="text-zinc-600"> • PnL floating: </span>
          <strong className={isPosProfitable ? "text-emerald-400" : "text-rose-400"}>
            {isPosProfitable ? "+" : ""}${Number(pos.unrealizedPnl).toFixed(2)} (
            {isPosProfitable ? "+" : ""}
            {Number(pos.unrealizedPnlPercent).toFixed(2)}%)
          </strong>
        </div>
      )}

      {/* Gauge SL→TP */}
      <div className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800">
        <div className="flex items-center justify-between text-xs font-mono mb-1.5 gap-2">
          <div className="text-left">
            <span className="text-rose-400 font-bold flex items-center gap-1 text-[11px]">
              <ShieldAlert className="w-3 h-3" /> Target CL: ${fmtMoney(pos.stopLoss)}
            </span>
            <span className="text-[10px] text-zinc-500 block">
              Max Loss: <strong className="text-rose-400">-${potentialLossCashflow.toFixed(2)}</strong> ({distToCLPercent}%)
            </span>
            <span
              className="text-[10px] font-mono block mt-0.5"
              title={eta.atr != null ? `ATR ${pos.timeframe || "15m"} $${eta.atr}/candle × drift 0.5 — ESTIMASI, bukan prediksi` : "Candle TF entry belum tersedia — estimasi tidak bisa dihitung"}
            >
              {eta.clCandles != null ? (
                <>EST CL: <strong className="text-rose-300">~{eta.clCandles} 🕯 {eta.clDurasi}</strong></>
              ) : (
                <span className="text-zinc-600">EST CL: — (no candle)</span>
              )}
            </span>
          </div>
          <div className="text-center px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-[10px] font-mono text-amber-400 font-bold shrink-0">
            R:R 1 : {rr}
          </div>
          <div className="text-right">
            <span className="text-emerald-400 font-bold flex items-center justify-end gap-1 text-[11px]">
              <Target className="w-3 h-3" /> Target TP: ${fmtMoney(pos.takeProfit)}
            </span>
            <span className="text-[10px] text-zinc-500 block">
              Cashflow Gain: <strong className="text-emerald-400">+${potentialProfitCashflow.toFixed(2)}</strong> ({distToTPPercent}%)
            </span>
            <span
              className="text-[10px] font-mono block mt-0.5"
              title={eta.atr != null ? `ATR $${eta.atr}/candle × drift 0.5 — ESTIMASI, bukan prediksi` : "Candle belum tersedia — estimasi tidak bisa dihitung"}
            >
              {eta.tpCandles != null ? (
                eta.tpBeyondHorizon ? (
                  <><span className="text-amber-300 font-bold">EST TP: di luar horizon TF</span><span className="text-zinc-500"> • setup stale, pertimbangkan BE/close</span></>
                ) : (
                  <>EST TP: <strong className="text-emerald-300">~{eta.tpCandles} 🕯 {eta.tpDurasi}</strong>{eta.nearer ? <span className="text-zinc-500"> • {eta.nearer} dulu</span> : null}</>
                )
              ) : (
                <span className="text-zinc-600">EST TP: — (no candle)</span>
              )}
            </span>
          </div>
        </div>
        <div className="relative w-full h-2.5 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800 my-1">
          <div className="absolute left-0 top-0 bottom-0 w-1/2 bg-gradient-to-r from-rose-500/40 to-transparent" />
          <div className="absolute right-0 top-0 bottom-0 w-1/2 bg-gradient-to-l from-emerald-500/40 to-transparent" />
          <div
            className="absolute top-0 bottom-0 w-2 bg-amber-400 rounded-full shadow-lg shadow-amber-400/80 transition-all duration-300"
            style={{ left: `calc(${progressPercent}% - 4px)` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mt-1">
          <span>Zona Cut Loss (CL)</span>
          <span className="text-amber-300 font-semibold">Progress ke TP: {progressPercent.toFixed(0)}%</span>
          <span>Zona Take Profit (TP)</span>
        </div>
      </div>

      {/* Alasan entry */}
      <div className="rounded-xl bg-zinc-900/90 border border-zinc-800 p-3">
        <div className="flex items-center justify-between text-xs font-mono font-bold text-zinc-300 mb-1">
          <span className="flex items-center gap-1.5 text-amber-400">
            <Info className="w-3.5 h-3.5" />
            ALASAN ENTRY AGENT (WHY AGENT ENTERED):
          </span>
          <span className="text-[10px] font-mono text-zinc-500">
            Confidence: <strong className="text-emerald-400">{pos.confidence != null ? `${pos.confidence}%` : "— (posisi lama)"}</strong>
          </span>
        </div>
        <p className="text-xs text-zinc-300 leading-relaxed font-sans mt-1">
          {pos.entryReasoning || "— (posisi lama: reasoning tidak persist di DB, hanya entry_source tercatat)."}
        </p>
        {pos.targetLiquidityPool && (
          <div className="mt-2 pt-2 border-t border-zinc-800 flex items-center justify-between text-[11px] font-mono">
            <span className="text-zinc-500">Target Liquidity Pool:</span>
            <span className="text-amber-400 font-bold">{pos.targetLiquidityPool}</span>
          </div>
        )}
      </div>

      {/* Defensive controls */}
      <div className="flex items-center justify-end gap-2 pt-1 font-mono text-xs flex-wrap">
        {!isSpotPos && (
          <label
            className="flex items-center gap-1 text-[11px] text-zinc-400"
            title="Exit engine otomatis server-side: break-even, trailing, partial TP, time-stop. Ratchet — SL hanya mengetat. PAPER saja."
          >
            Auto Exit
            <select
              value={autoExitKey}
              disabled={autoExitBusy}
              onChange={(e) => {
                const preset = AUTO_EXIT_PRESETS.find((p) => p.key === e.target.value);
                if (preset) onSetAutoExit(preset.config);
              }}
              className="px-1.5 py-1 rounded bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-[11px] focus:outline-none focus:border-amber-500/60 disabled:opacity-50"
            >
              {autoExitKey === "custom" && <option value="custom">custom…</option>}
              {AUTO_EXIT_PRESETS.map((p) => (
                <option key={p.key} value={p.key} title={p.hint}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {!editing ? (
          <button type="button"
            onClick={onStartEdit}
            className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 text-[11px] transition"
            title="Ubah SL & TP manual (validasi LONG: SL < harga < TP)"
          >
            Edit SL/TP
          </button>
        ) : (
          <span className="flex items-center gap-1.5 flex-wrap">
            <label className="flex items-center gap-1 text-[11px] text-zinc-400">
              SL <input type="number" step="any" value={editSL} onChange={(e) => onEditSL(e.target.value)} className="w-24 px-1.5 py-1 rounded bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-[11px] focus:outline-none focus:border-amber-500/60" />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-zinc-400">
              TP <input type="number" step="any" value={editTP} onChange={(e) => onEditTP(e.target.value)} className="w-24 px-1.5 py-1 rounded bg-zinc-950 border border-zinc-700 text-zinc-100 font-mono text-[11px] focus:outline-none focus:border-amber-500/60" />
            </label>
            <button type="button" onClick={onSaveEdit} disabled={busy} className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold transition disabled:opacity-50">
              {busy ? "…" : "Simpan"}
            </button>
            <button type="button" onClick={onCancelEdit} className="px-2 py-1 rounded text-zinc-500 hover:text-zinc-300 text-[11px] transition">
              Batal
            </button>
          </span>
        )}
        <button type="button"
          onClick={onBreakEven}
          disabled={busy}
          className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 text-[11px] transition disabled:opacity-50"
          title="Geser Cut Loss ke harga Entry sehingga posisi bebas risiko (Risk-Free Trade)"
        >
          Set Break-Even (Risk-Free)
        </button>
        <button type="button"
          onClick={onClose}
          disabled={busy}
          className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-rose-600 text-zinc-300 hover:text-white font-mono text-[11px] font-bold border border-zinc-700 hover:border-rose-500 transition disabled:opacity-50 disabled:cursor-wait"
          title="Tutup posisi ini sekarang dengan market order"
        >
          {busy ? "Closing…" : "Market Close"}
        </button>
      </div>
      {editErr && (
        <p className="text-[11px] font-mono text-amber-400 bg-amber-950/30 border border-amber-500/30 rounded-lg px-2.5 py-1.5">
          SL/TP gagal — {editErr}
        </p>
      )}
    </div>
  );
};
