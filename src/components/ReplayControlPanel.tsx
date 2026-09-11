import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  StepForward,
  RotateCcw,
  Gauge,
  History,
  TrendingUp,
  TrendingDown,
  X,
  Clock,
  Activity,
  Database,
  Download,
} from "lucide-react";
import { authFetch, useAuth } from "../hooks/useAuth";

// ---------------------------------------------------------------------------
// ReplayControlPanel — Forward-test / backtest dengan REAL historical data
// (Binance Vision klines). Book replay TERPISAH dari paper book live.
// Polling GET /api/paper/replay/status tiap 1.5s saat sesi aktif.
// ---------------------------------------------------------------------------

interface ReplayCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ReplayPosition {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  notionalUSD: number;
  leverage: number;
  marginUSD: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  openedAt: number;
  status: "OPEN" | "CLOSED";
  lastMark?: number;
  realizedPnlUSD?: number;
  exitReason?: string;
}

interface ReplayOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  limitPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  leverage: number;
  status: "NEW" | "FILLED" | "CANCELLED" | "REJECTED";
  createdAt: number;
  fillPrice?: number;
  feeUSD?: number;
  reason?: string;
}

interface ReplayTrade {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  openedAt: number;
  closedAt: number;
  pnlUSD: number;
  pnlPercent: number;
  leverage: number;
}

interface ReplayEvent {
  seq: number;
  timestamp: number;
  candleIndex: number;
  type: string;
  payload: Record<string, unknown>;
}

interface ReplaySession {
  id: string;
  symbol: string;
  timeframe: string;
  candles: ReplayCandle[];
  totalCandles?: number;
  currentCandle?: ReplayCandle | null;
  currentIndex: number;
  status: "idle" | "running" | "paused" | "done";
  speedMs: number;
  initialCash: number;
  cash: number;
  realizedPnl: number;
  positions: ReplayPosition[];
  orders: ReplayOrder[];
  events: ReplayEvent[];
  trades: ReplayTrade[];
  peakEquity: number;
  maxDrawdownPct: number;
  mode?: "manual" | "auto";
  autoParams?: {
    rsiLong: number;
    rsiShort: number;
    slAtrMult: number;
    tpAtrMult: number;
    minCandles: number;
    cooldownCandles: number;
    riskPct: number;
    leverage: number;
  };
  lastAutoSignal?: {
    index: number;
    action: "BUY" | "SELL" | "HOLD";
    reason: string;
    candleClose: number;
  } | null;
}

const fmtMoney = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

function defaultEnd(): number {
  return Date.now();
}
function defaultStart(): number {
  return Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 hari kebelakang
}

export const ReplayControlPanel: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [active, setActive] = useState(false);
  const [symbol, setSymbol] = useState("BTC/USDT");
  const [timeframe, setTimeframe] = useState("15m");
  const [startMs, setStartMs] = useState<number>(defaultStart);
  const [endMs, setEndMs] = useState<number>(defaultEnd);
  const [initialCash, setInitialCash] = useState(10000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [orderSide, setOrderSide] = useState<"buy" | "sell">("buy");
  const [orderQty, setOrderQty] = useState(0.01);
  const [orderLeverage, setOrderLeverage] = useState(10);
  const [slPct, setSlPct] = useState(1.5);
  const [tpPct, setTpPct] = useState(3.0);
  const [decisionId, setDecisionId] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportedRunId, setExportedRunId] = useState<string | null>(null);
  // Order entry v2: MARKET (entry = close candle replay saat ini) atau
  // LIMIT (entry price manual). SL/TP bisa mode "%" (auto hitung dari
  // referensi) atau "manual $" (harga eksplisit).
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState<number | "">("");
  const [slMode, setSlMode] = useState<"pct" | "manual">("pct");
  const [tpMode, setTpMode] = useState<"pct" | "manual">("pct");
  const [slPrice, setSlPrice] = useState<number | "">("");
  const [tpPrice, setTpPrice] = useState<number | "">("");
  // Auto strategy state (mode + params untuk input)
  const [autoParams, setAutoParams] = useState<ReplaySession["autoParams"]>({
    rsiLong: 35,
    rsiShort: 65,
    slAtrMult: 1.2,
    tpAtrMult: 2.4,
    minCandles: 30,
    cooldownCandles: 3,
    riskPct: 2,
    leverage: 10,
  });
  const [savingStrategy, setSavingStrategy] = useState(false);
  const mountedRef = useRef(false);
  const sessionRef = useRef<ReplaySession | null>(null);
  sessionRef.current = session;

  const loadStatus = useCallback(async () => {
    if (!mountedRef.current || !isAuthenticated) return;
    try {
      const res = await authFetch("/api/paper/replay/status");
      const payload = await res.json().catch(() => null);
      if (payload?.success) {
        setActive(Boolean(payload.active));
        setSession(payload.session ?? null);
      }
    } catch {
      // keep previous state
    }
  }, [isAuthenticated]);

  useEffect(() => {
    mountedRef.current = true;
    loadStatus();
    const iv = setInterval(loadStatus, 1500);
    return () => {
      mountedRef.current = false;
      clearInterval(iv);
    };
  }, [loadStatus]);
const post = useCallback(
    async (url: string, body?: unknown): Promise<any> => {
      const res = await authFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        throw new Error(payload?.message || `HTTP ${res.status}`);
      }
      return payload;
    },
    []
  );

  const handleStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await post("/api/paper/replay/start", {
        symbol,
        timeframe,
        startMs,
        endMs,
        initialCash,
      });
      setSession(payload.session);
      setActive(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [post, symbol, timeframe, startMs, endMs, initialCash]);

  const handleStep = useCallback(async () => {
    try {
      const payload = await post("/api/paper/replay/step");
      setSession(payload.session);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [post]);

  const handleRun = useCallback(async () => {
    try {
      const payload = await post("/api/paper/replay/run");
      setSession(payload.session);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [post]);

  const handlePause = useCallback(async () => {
    try {
      const payload = await post("/api/paper/replay/pause");
      setSession(payload.session);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [post]);

  const handleReset = useCallback(async () => {
    try {
      const payload = await post("/api/paper/replay/reset");
      setSession(payload.session);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [post]);

  const handleSpeed = useCallback(
    async (speedMs: number) => {
      try {
        const payload = await post("/api/paper/replay/speed", { speedMs });
        setSession(payload.session);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [post]
  );

  // Simpan mode strategi (manual/auto) + params ke server.
  const handleStrategy = useCallback(
    async (mode: "manual" | "auto") => {
      setSavingStrategy(true);
      setError(null);
      try {
        const payload = await post("/api/paper/replay/strategy", { mode, params: autoParams });
        setSession(payload.session);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSavingStrategy(false);
      }
    },
    [post, autoParams]
  );

  // Sinkronkan params auto dari server session (jika berbeda / sudah tersimpan).
  useEffect(() => {
    if (session?.autoParams) {
      setAutoParams((prev) => ({ ...prev, ...session.autoParams }));
    }
  }, [session?.autoParams]);

  const handleOrder = useCallback(async () => {
    if (!session || session.currentIndex < 0) {
      setError("Jalankan step dulu sebelum order (butuh candle aktif).");
      return;
    }
    const candle = session.currentCandle ?? session.candles[session.currentIndex];
    if (!candle) {
      setError("Candle belum ready — tunggu step berikutnya.");
      return;
    }
    setError(null);
    const ref = candle.close;
    const isLong = orderSide === "buy";

    // Entry: LIMIT → user input (limitPrice); MARKET → close candle replay.
    const effectiveType = orderType;
    const entryPrice = effectiveType === "limit" ? Number(limitPrice) : ref;
    if (effectiveType === "limit" && (!Number(limitPrice) || Number(limitPrice) <= 0)) {
      setError("Entry price wajib diisi untuk limit order.");
      return;
    }

    // SL/TP: mode manual → harga eksplisit; mode % → hitung dari referensi close.
    const sl =
      slMode === "manual" && Number(slPrice) > 0
        ? Number(slPrice)
        : isLong
        ? Number((ref * (1 - slPct / 100)).toFixed(2))
        : Number((ref * (1 + slPct / 100)).toFixed(2));
    const tp =
      tpMode === "manual" && Number(tpPrice) > 0
        ? Number(tpPrice)
        : isLong
        ? Number((ref * (1 + tpPct / 100)).toFixed(2))
        : Number((ref * (1 - tpPct / 100)).toFixed(2));

    // Sanity: LONG sl < entry < tp ; SHORT tp < entry < sl (server juga validasi).
    if (isLong && !(sl < entryPrice && entryPrice < tp)) {
      setError(`SL ${sl} harus < entry ${entryPrice} < TP ${tp} (LONG).`);
      return;
    }
    if (!isLong && !(tp < entryPrice && entryPrice < sl)) {
      setError(`TP ${tp} harus < entry ${entryPrice} < SL ${sl} (SHORT).`);
      return;
    }

    try {
      const payload = await post("/api/paper/replay/order", {
        symbol,
        side: orderSide,
        type: effectiveType,
        amount: orderQty,
        leverage: orderLeverage,
        stopLoss: sl,
        takeProfit: tp,
        ...(effectiveType === "limit" ? { limitPrice: entryPrice } : {}),
        // decisionId opsional untuk training join (join trade → AI decision)
        ...(decisionId.trim() ? { decisionId: decisionId.trim() } : {}),
        meta: { source: "replay-panel-manual", timeframe, refPrice: ref },
      });
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [post, session, symbol, orderSide, orderQty, orderLeverage, slPct, tpPct, orderType, slMode, tpMode, slPrice, tpPrice, limitPrice, decisionId, timeframe, loadStatus]);

  const handleClose = useCallback(
    async (positionId: string) => {
      try {
        await post("/api/paper/replay/close", { positionId });
        await loadStatus();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [post, loadStatus]
  );

  const handleCancel = useCallback(
    async (orderId: string) => {
      try {
        await post("/api/paper/replay/cancel", { orderId });
        await loadStatus();
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [post, loadStatus]
  );

  // Simpan hasil sesi ke SQLite → dapatkan runId untuk download CSV.
  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const payload = await post("/api/paper/replay/export");
      setExportedRunId(payload.runId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }, [post]);

  // Download CSV dari run yang tersimpan (authFetch → blob → anchor click).
  const handleDownloadCsv = useCallback(async (runId: string) => {
    try {
      const res = await authFetch(`/api/paper/replay/runs/${encodeURIComponent(runId)}?format=csv`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `replay-${runId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
const totalCandles = session?.totalCandles ?? session?.candles?.length ?? 0;
  const currentIndex = session?.currentIndex ?? -1;
  const progressPct = totalCandles > 0 ? Math.min(100, Math.round(((currentIndex + 1) / totalCandles) * 100)) : 0;
  const currentCandle =
    session?.currentCandle ?? (session && currentIndex >= 0 ? session.candles[currentIndex] : null);
  const openPositions = session?.positions.filter((p) => p.status === "OPEN") ?? [];
  const pendingOrders = session?.orders.filter((o) => o.status === "NEW") ?? [];
  const wins = (session?.trades ?? []).filter((t) => t.pnlUSD > 0).length;
  const losses = (session?.trades ?? []).filter((t) => t.pnlUSD < 0).length;
  const winRate = (session?.trades.length ?? 0) > 0 ? Math.round((wins / session!.trades.length) * 100) : 0;
  const equity = session ? session.cash + openPositions.reduce((s, p) => s + p.marginUSD, 0) : 0;

  // Sinkronkan harga SL/TP absolut dari % referensi saat candle/side berubah.
  // Mode "manual" tidak disentuh (user kontrol penuh).
  useEffect(() => {
    if (!currentCandle) return;
    const ref = currentCandle.close;
    const isLong = orderSide === "buy";
    if (slMode === "pct") {
      const v = isLong ? ref * (1 - slPct / 100) : ref * (1 + slPct / 100);
      setSlPrice(Number(v.toFixed(2)));
    }
    if (tpMode === "pct") {
      const v = isLong ? ref * (1 + tpPct / 100) : ref * (1 - tpPct / 100);
      setTpPrice(Number(v.toFixed(2)));
    }
  }, [currentCandle, orderSide, slMode, tpMode, slPct, tpPct]);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 sm:p-5 shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-zinc-800 rounded-xl flex items-center justify-center text-cyan-400 border border-zinc-700/60">
            <History className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-200 font-sans flex items-center gap-2">
              Replay / Forward-Test
              {session && (
                <span
                  className={`px-2 py-0.5 rounded border text-[10px] font-bold font-mono ${
                    session.status === "running"
                      ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                      : session.status === "done"
                      ? "bg-sky-500/15 text-sky-400 border-sky-500/30"
                      : session.status === "paused"
                      ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                      : "bg-zinc-800 text-zinc-400 border-zinc-700"
                  }`}
                >
                  {session.status.toUpperCase()}
                </span>
              )}
            </h2>
            <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
              Real historical candles (Binance Vision) · isolated book
            </p>
          </div>
        </div>
        {session && (
          <div className="flex items-center gap-2 flex-wrap font-mono text-[11px]">
            <span className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300">
              Equity: <strong className="text-cyan-400">${fmtMoney(equity)}</strong>
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300">
              PnL:{" "}
              <strong className={session.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                {session.realizedPnl >= 0 ? "+" : ""}${fmtMoney(session.realizedPnl)}
              </strong>
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300">
              MaxDD: <strong className="text-amber-400">{fmtNum(session.maxDrawdownPct)}%</strong>
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-300">
              WinRate: <strong className="text-emerald-400">{winRate}%</strong> ({wins}W/{losses}L)
            </span>
          </div>
        )}
      </div>

      {/* Panduan singkat cara pakai — sekali lihat langsung paham */}
      <div className="mb-3 px-3 py-2 rounded-lg bg-cyan-500/5 border border-cyan-500/15 text-[10px] font-mono text-zinc-400 leading-relaxed">
        <span className="text-cyan-400 font-bold">CARA PAKAI:</span> 1) isi rentang tanggal &amp; klik{" "}
        <strong className="text-zinc-200">Start</strong> → 2) majukan waktu dengan{" "}
        <strong className="text-zinc-200">Step</strong>/<strong className="text-zinc-200">Run</strong> (harga = candel{" "}
        <strong className="text-amber-400">HISTORIS</strong> di timestamp itu, bukan harga live — normal &amp; valid) → 3) isi{" "}
        entry/SL/TP lalu <strong className="text-cyan-300">EXECUTE</strong>. Replay terpisah total dari akun paper live.
      </div>

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
{/* Progress + controls */}
      {session && (
        <div className="mb-3">
          <div className="flex items-center justify-between font-mono text-[10px] text-zinc-500 mb-1">
            <span>
              Candle {currentIndex + 1}/{totalCandles} ·{" "}
              {currentCandle ? new Date(currentCandle.timestamp).toLocaleString("en-GB", { hour12: false }) : "—"}
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-cyan-500/80 transition-all" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {session.status !== "running" && session.status !== "done" && (
              <button onClick={handleRun} className="flex items-center gap-1 rounded bg-emerald-500/15 border border-emerald-500/30 px-3 py-1.5 text-xs font-bold text-emerald-400 hover:bg-emerald-500/25 transition-colors">
                <Play className="h-3.5 w-3.5" /> Run
              </button>
            )}
            {session.status === "running" && (
              <button onClick={handlePause} className="flex items-center gap-1 rounded bg-amber-500/15 border border-amber-500/30 px-3 py-1.5 text-xs font-bold text-amber-400 hover:bg-amber-500/25 transition-colors">
                <Pause className="h-3.5 w-3.5" /> Pause
              </button>
            )}
            {session.status !== "done" && (
              <button onClick={handleStep} className="flex items-center gap-1 rounded bg-zinc-800 border border-zinc-700 px-3 py-1.5 text-xs font-bold text-zinc-300 hover:bg-zinc-700 transition-colors">
                <StepForward className="h-3.5 w-3.5" /> Step
              </button>
            )}
            <button onClick={handleReset} className="flex items-center gap-1 rounded bg-rose-500/10 border border-rose-500/30 px-3 py-1.5 text-xs font-bold text-rose-400 hover:bg-rose-500/20 transition-colors">
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
      )}

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
                      onChange={(e) => setAutoParams((prev) => ({ ...prev!, [key]: Number(e.target.value) }))}
                      className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
                    />
                  </label>
                ))}
              </div>

              {session.lastAutoSignal && (
                <div className="px-2 py-1.5 mb-2 rounded-lg bg-zinc-900/70 border border-zinc-800 font-mono text-[11px]">
                  <span className="text-zinc-500">Sinyal terakhir (candle #{session.lastAutoSignal.index}): </span>
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
                  <span className="text-zinc-400"> @ ${fmtMoney(session.lastAutoSignal.candleClose)}</span>
                  <span className="text-zinc-500"> — {session.lastAutoSignal.reason}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <div className="mb-3 p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 font-mono text-[11px] text-rose-300">
          {error}
        </div>
      )}
{/* Order entry (manual, ke replay book) */}
      {session && session.status !== "done" && currentIndex >= 0 && (
        <div className="mb-3 p-3 rounded-xl bg-zinc-950 border border-zinc-800">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
              <Activity className="w-3.5 h-3.5 text-cyan-400" /> Place Order (replay book)
            </div>
            <span
              className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[9px] font-mono font-bold text-amber-400"
              title="Replay memakai harga candel HISTORIS di timestamp itu, bukan harga realtime sekarang (backtest valid, tanpa lookahead)"
            >
              <Clock className="w-3 h-3" /> HISTORIS · {session.symbol} {session.timeframe}
            </span>
          </div>

          {/* Referensi harga candle replay saat ini */}
          {currentCandle && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 px-2 py-1.5 rounded-lg bg-zinc-900/80 border border-zinc-800/60 font-mono text-[11px]">
              <span className="text-zinc-500">
                Candle <strong className="text-zinc-200">#{currentIndex + 1}</strong> ·{" "}
                {new Date(currentCandle.timestamp).toLocaleString("en-GB", { hour12: false })}
              </span>
              <span className="text-zinc-500">
                Ref close:{" "}
                <strong className="text-cyan-300">${fmtMoney(currentCandle.close)}</strong>
                <span className="text-zinc-600"> (entry MARKET = harga ini)</span>
              </span>
              <span className="text-zinc-500">
                O/H/L: ${fmtMoney(currentCandle.open)} / ${fmtMoney(currentCandle.high)} / ${fmtMoney(currentCandle.low)}
              </span>
            </div>
          )}
          {/* Order type + arah */}
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <div className="flex gap-1">
              <button
                onClick={() => setOrderType("market")}
                className={`rounded px-2.5 py-1.5 text-xs font-bold border transition-colors ${
                  orderType === "market"
                    ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
                title="Entry = close candel replay saat ini (taker fee 0.04%)"
              >
                MARKET
              </button>
              <button
                onClick={() => setOrderType("limit")}
                className={`rounded px-2.5 py-1.5 text-xs font-bold border transition-colors ${
                  orderType === "limit"
                    ? "bg-sky-500/20 text-sky-400 border-sky-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
                title="Entry manual di bawah ini — posisi terisi saat range candel cross harga (maker fee 0.02%)"
              >
                LIMIT
              </button>
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setOrderSide("buy")}
                className={`flex-1 rounded px-2.5 py-1.5 text-xs font-bold border transition-colors ${
                  orderSide === "buy"
                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
              >
                <TrendingUp className="w-3 h-3 inline mr-1" />LONG
              </button>
              <button
                onClick={() => setOrderSide("sell")}
                className={`flex-1 rounded px-2.5 py-1.5 text-xs font-bold border transition-colors ${
                  orderSide === "sell"
                    ? "bg-rose-500/20 text-rose-400 border-rose-500/40"
                    : "bg-zinc-900 text-zinc-500 border-zinc-800"
                }`}
              >
                <TrendingDown className="w-3 h-3 inline mr-1" />SHORT
              </button>
            </div>
          </div>

          {/* Entry + qty + leverage + margin */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 items-end mb-2">
            <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
              ENTRY $
              {orderType === "market" ? (
                <input
                  value={currentCandle ? `$${fmtMoney(currentCandle.close)}` : "—"}
                  readOnly
                  className="bg-zinc-900/50 border border-zinc-800 rounded px-2 py-1.5 text-xs text-cyan-300 font-mono"
                />
              ) : (
                <input
                  type="number"
                  step="0.01"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder={currentCandle ? currentCandle.close.toFixed(2) : ""}
                  className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-700"
                />
              )}
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
              QTY
              <input
                type="number"
                step="0.001"
                value={orderQty}
                onChange={(e) => setOrderQty(Number(e.target.value))}
                className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
              LEVERAGE
              <input
                type="number"
                value={orderLeverage}
                onChange={(e) => setOrderLeverage(Number(e.target.value))}
                className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-mono text-zinc-500">
              MARGIN (est.)
              <input
                value={
                  currentCandle
                    ? `$${fmtMoney(((orderType === "limit" ? Number(limitPrice) : currentCandle.close) * orderQty) / Math.max(1, orderLeverage))}`
                    : "—"
                }
                readOnly
                className="bg-zinc-900/50 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 font-mono"
              />
            </label>
          </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-mono text-rose-400 uppercase tracking-widest">Stop Loss</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setSlMode("pct")}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                      slMode === "pct"
                        ? "bg-rose-500/25 text-rose-300 border-rose-500/40"
                        : "bg-zinc-900 text-zinc-500 border-zinc-800"
                    }`}
                    title="Hitung dari % referensi close"
                  >
                    AUTO %
                  </button>
                  <button
                    onClick={() => setSlMode("manual")}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                      slMode === "manual"
                        ? "bg-rose-500/25 text-rose-300 border-rose-500/40"
                        : "bg-zinc-900 text-zinc-500 border-zinc-800"
                    }`}
                    title="Input harga SL eksplisit"
                  >
                    MANUAL $
                  </button>
                </div>
              </div>
              {slMode === "pct" ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    step="0.1"
                    value={slPct}
                    onChange={(e) => setSlPct(Number(e.target.value))}
                    className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
                  />
                  <span className="text-[10px] text-zinc-500 font-mono">%</span>
                  <span className="text-[11px] text-rose-300 font-mono font-bold">
                    → ${slPrice ? fmtMoney(Number(slPrice)) : "—"}
                  </span>
                </div>
              ) : (
                <input
                  type="number"
                  step="0.01"
                  value={slPrice}
                  onChange={(e) => setSlPrice(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder="SL $"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-700"
                />
              )}
            </div>
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest">Take Profit</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setTpMode("pct")}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                      tpMode === "pct"
                        ? "bg-emerald-500/25 text-emerald-300 border-emerald-500/40"
                        : "bg-zinc-900 text-zinc-500 border-zinc-800"
                    }`}
                  >
                    AUTO %
                  </button>
                  <button
                    onClick={() => setTpMode("manual")}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold border transition-colors ${
                      tpMode === "manual"
                        ? "bg-emerald-500/25 text-emerald-300 border-emerald-500/40"
                        : "bg-zinc-900 text-zinc-500 border-zinc-800"
                    }`}
                  >
                    MANUAL $
                  </button>
                </div>
              </div>
              {tpMode === "pct" ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    step="0.1"
                    value={tpPct}
                    onChange={(e) => setTpPct(Number(e.target.value))}
                    className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono"
                  />
                  <span className="text-[10px] text-zinc-500 font-mono">%</span>
                  <span className="text-[11px] text-emerald-300 font-mono font-bold">
                    → ${tpPrice ? fmtMoney(Number(tpPrice)) : "—"}
                  </span>
                </div>
              ) : (
                <input
                  type="number"
                  step="0.01"
                  value={tpPrice}
                  onChange={(e) => setTpPrice(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder="TP $"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-700"
                />
              )}
            </div>
          </div>
            <div className="flex flex-wrap items-end gap-2">
            <label
              className="flex-1 min-w-[180px] flex flex-col gap-1 text-[10px] font-mono text-zinc-500"
              title="ID keputusan AI (opsional) — join trade ke decision untuk training"
            >
              DECISION ID (opsional)
              <input
                value={decisionId}
                onChange={(e) => setDecisionId(e.target.value)}
                placeholder="decision-..."
                className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-700"
              />
            </label>
            <button
              onClick={handleOrder}
              className="rounded bg-cyan-500/15 border border-cyan-500/30 px-4 py-1.5 text-xs font-bold text-cyan-400 hover:bg-cyan-500/25 transition-colors"
            >
              EXECUTE
            </button>
          </div>
        </div>
      )}
{/* Positions + orders + trades */}
      {session && (
        <div className="space-y-3">
          <div className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
            <div className="px-3 py-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest border-b border-zinc-800">
              Open Positions ({openPositions.length})
            </div>
            {openPositions.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] font-mono text-zinc-600">Belum ada posisi terbuka</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead className="bg-zinc-900 text-zinc-500 text-[10px] uppercase">
                    <tr>
                      <th className="px-3 py-2">SYM</th>
                      <th className="px-3 py-2">SIDE</th>
                      <th className="px-3 py-2 text-right">QTY</th>
                      <th className="px-3 py-2 text-right">ENTRY</th>
                      <th className="px-3 py-2 text-right">MARK</th>
                      <th className="px-3 py-2 text-right">uPnL</th>
                      <th className="px-3 py-2 text-right">SL</th>
                      <th className="px-3 py-2 text-right">TP</th>
                      <th className="px-3 py-2 text-right">LIQ</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {openPositions.map((pos) => {
                      const mark = pos.lastMark ?? pos.entryPrice;
                      const upnl = pos.side === "LONG" ? (mark - pos.entryPrice) * pos.qty : (pos.entryPrice - mark) * pos.qty;
                      return (
                        <tr key={pos.id} className="hover:bg-zinc-900/40">
                          <td className="px-3 py-2 text-zinc-300">{pos.symbol}</td>
                          <td className="px-3 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${pos.side === "LONG" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}`}>
                              {pos.side}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right text-zinc-300">{fmtNum(pos.qty)}</td>
                          <td className="px-3 py-2 text-right text-zinc-300">${fmtMoney(pos.entryPrice)}</td>
                          <td className="px-3 py-2 text-right text-zinc-100">${fmtMoney(mark)}</td>
                          <td className={`px-3 py-2 text-right font-bold ${upnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                            {upnl >= 0 ? "+" : ""}${fmtMoney(upnl)}
                          </td>
                          <td className="px-3 py-2 text-right text-rose-400">${fmtMoney(pos.stopLoss)}</td>
                          <td className="px-3 py-2 text-right text-emerald-400">${fmtMoney(pos.takeProfit)}</td>
                          <td className="px-3 py-2 text-right text-amber-400">${fmtMoney(pos.liquidationPrice)}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => handleClose(pos.id)}
                              className="px-2 py-1 rounded bg-zinc-800 hover:bg-rose-600 hover:text-white text-slate-300 border border-zinc-700 text-[10px] font-bold transition-colors"
                            >
                              Close
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
{/* Pending orders */}
          <div className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
            <div className="px-3 py-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest border-b border-zinc-800">
              Pending Orders ({pendingOrders.length})
            </div>
            {pendingOrders.length === 0 ? (
              <div className="px-3 py-3 text-center text-[11px] font-mono text-zinc-600">Tidak ada order pending</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead className="bg-zinc-900 text-zinc-500 text-[10px] uppercase">
                    <tr>
                      <th className="px-3 py-2">SYM</th>
                      <th className="px-3 py-2">SIDE</th>
                      <th className="px-3 py-2 text-right">QTY</th>
                      <th className="px-3 py-2 text-right">LIMIT</th>
                      <th className="px-3 py-2 text-right">LEV</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {pendingOrders.map((o) => (
                      <tr key={o.id} className="hover:bg-zinc-900/40">
                        <td className="px-3 py-2 text-zinc-300">{o.symbol}</td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${o.side === "buy" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}`}>
                            {o.side}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-300">{fmtNum(o.amount)}</td>
                        <td className="px-3 py-2 text-right text-zinc-100">${o.limitPrice ? fmtMoney(o.limitPrice) : "—"}</td>
                        <td className="px-3 py-2 text-right text-zinc-400">{o.leverage}x</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => handleCancel(o.id)}
                            className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-slate-300 border border-zinc-700 text-[10px] font-bold transition-colors"
                          >
                            Cancel
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
{/* Closed trades */}
          {session.trades.length > 0 && (
            <div className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
              <div className="px-3 py-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest border-b border-zinc-800">
                Closed Trades ({session.trades.length})
              </div>
              <div className="overflow-x-auto max-h-48 overflow-y-auto">
                <table className="w-full text-left font-mono text-[11px]">
                  <thead className="bg-zinc-900 text-zinc-500 text-[10px] uppercase sticky top-0">
                    <tr>
                      <th className="px-3 py-2">SIDE</th>
                      <th className="px-3 py-2 text-right">ENTRY</th>
                      <th className="px-3 py-2 text-right">EXIT</th>
                      <th className="px-3 py-2 text-right">PnL</th>
                      <th className="px-3 py-2 text-right">R%</th>
                      <th className="px-3 py-2">REASON</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/60">
                    {[...session.trades].reverse().map((t) => (
                      <tr key={t.id} className="hover:bg-zinc-900/40">
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${t.side === "LONG" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"}`}>
                            {t.side}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-zinc-300">${fmtMoney(t.entryPrice)}</td>
                        <td className="px-3 py-2 text-right text-zinc-100">${fmtMoney(t.exitPrice)}</td>
                        <td className={`px-3 py-2 text-right font-bold ${t.pnlUSD >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {t.pnlUSD >= 0 ? "+" : ""}${fmtMoney(t.pnlUSD)}
                        </td>
                        <td className={`px-3 py-2 text-right ${t.pnlPercent >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {t.pnlPercent >= 0 ? "+" : ""}{fmtNum(t.pnlPercent)}%
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            t.exitReason === "TAKE_PROFIT" ? "bg-emerald-950 text-emerald-300 border border-emerald-500/40"
                            : t.exitReason === "STOP_LOSS" ? "bg-rose-950 text-rose-300 border border-rose-500/40"
                            : t.exitReason === "LIQUIDATED" ? "bg-amber-950 text-amber-300 border border-amber-500/40"
                            : "bg-zinc-800 text-zinc-300"
                          }`}>
                            {t.exitReason}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {!session && !busy && (
        <div className="flex flex-col items-center justify-center py-8 text-center bg-zinc-950/60 rounded-xl border border-zinc-800/80">
          <Clock className="w-8 h-8 text-zinc-600 mb-2" />
          <p className="text-xs font-mono text-zinc-400">Belum ada sesi replay.</p>
          <p className="text-[10px] font-mono text-zinc-600 mt-1">
            Isi simbol, timeframe, dan rentang tanggal lalu tekan Start untuk memuat candle real.
          </p>
        </div>
      )}
    </div>
  );
};