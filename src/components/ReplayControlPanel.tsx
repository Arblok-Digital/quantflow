import React, { useCallback, useEffect, useRef, useState } from "react";
import { History, Clock, Activity } from "lucide-react";
import { authFetch, useAuth } from "../hooks/useAuth";
import { ReplaySetupPanel } from "./ReplaySetupPanel";
import { ReplayPlaybackControls } from "./ReplayPlaybackControls";
import { ReplayOrderPanel } from "./ReplayOrderPanel";
import { ReplayResultsTable } from "./ReplayResultsTable";
import { ReplaySession, fmtMoney, fmtNum } from "./replayTypes";

// ---------------------------------------------------------------------------
// ReplayControlPanel — thin shell composing ReplaySetupPanel,
// ReplayPlaybackControls, ReplayOrderPanel, and ReplayResultsTable.
// All state & handler logic remains here; JSX is delegated.
// ---------------------------------------------------------------------------

function defaultEnd(): number {
  return Date.now();
}
function defaultStart(): number {
  return Date.now() - 7 * 24 * 60 * 60 * 1000;
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
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPrice, setLimitPrice] = useState<number | "">("");
  const [slMode, setSlMode] = useState<"pct" | "manual">("pct");
  const [tpMode, setTpMode] = useState<"pct" | "manual">("pct");
  const [slPrice, setSlPrice] = useState<number | "">("");
  const [tpPrice, setTpPrice] = useState<number | "">("");
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

    const effectiveType = orderType;
    const entryPrice = effectiveType === "limit" ? Number(limitPrice) : ref;
    if (effectiveType === "limit" && (!Number(limitPrice) || Number(limitPrice) <= 0)) {
      setError("Entry price wajib diisi untuk limit order.");
      return;
    }

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

    if (isLong && !(sl < entryPrice && entryPrice < tp)) {
      setError(`SL ${sl} harus < entry ${entryPrice} < TP ${tp} (LONG).`);
      return;
    }
    if (!isLong && !(tp < entryPrice && entryPrice < sl)) {
      setError(`TP ${tp} harus < entry ${entryPrice} < SL ${sl} (SHORT).`);
      return;
    }

    try {
      await post("/api/paper/replay/order", {
        symbol,
        side: orderSide,
        type: effectiveType,
        amount: orderQty,
        leverage: orderLeverage,
        stopLoss: sl,
        takeProfit: tp,
        ...(effectiveType === "limit" ? { limitPrice: entryPrice } : {}),
        ...(decisionId.trim() ? { decisionId: decisionId.trim() } : {}),
        meta: { source: "replay-panel-manual", timeframe, refPrice: ref },
      });
      await loadStatus();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [
    post, session, symbol, orderSide, orderQty, orderLeverage, slPct, tpPct,
    orderType, slMode, tpMode, slPrice, tpPrice, limitPrice, decisionId,
    timeframe, loadStatus,
  ]);

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
  const progressPct =
    totalCandles > 0 ? Math.min(100, Math.round(((currentIndex + 1) / totalCandles) * 100)) : 0;
  const currentCandle =
    session?.currentCandle ?? (session && currentIndex >= 0 ? session.candles[currentIndex] : null);
  const openPositions = session?.positions.filter((p) => p.status === "OPEN") ?? [];
  const pendingOrders = session?.orders.filter((o) => o.status === "NEW") ?? [];
  const wins = (session?.trades ?? []).filter((t) => t.pnlUSD > 0).length;
  const losses = (session?.trades ?? []).filter((t) => t.pnlUSD < 0).length;
  const winRate =
    (session?.trades.length ?? 0) > 0
      ? Math.round((wins / session!.trades.length) * 100)
      : 0;
  const equity = session
    ? session.cash + openPositions.reduce((s, p) => s + p.marginUSD, 0)
    : 0;

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

      {/* Usage guide */}
      <div className="mb-3 px-3 py-2 rounded-lg bg-cyan-500/5 border border-cyan-500/15 text-[10px] font-mono text-zinc-400 leading-relaxed">
        <span className="text-cyan-400 font-bold">CARA PAKAI:</span> 1) isi rentang tanggal &amp; klik{" "}
        <strong className="text-zinc-200">Start</strong> → 2) majukan waktu dengan{" "}
        <strong className="text-zinc-200">Step</strong>/<strong className="text-zinc-200">Run</strong>{" "}
        (harga = candel{" "}
        <strong className="text-amber-400">HISTORIS</strong> di timestamp itu, bukan harga live —
        normal &amp; valid) → 3) isi entry/SL/TP lalu{" "}
        <strong className="text-cyan-300">EXECUTE</strong>. Replay terpisah total dari akun paper
        live.
      </div>

      {/* Setup + Auto Strategy */}
      <ReplaySetupPanel
        symbol={symbol}
        setSymbol={setSymbol}
        timeframe={timeframe}
        setTimeframe={setTimeframe}
        startMs={startMs}
        setStartMs={setStartMs}
        endMs={endMs}
        setEndMs={setEndMs}
        initialCash={initialCash}
        setInitialCash={setInitialCash}
        session={session}
        busy={busy}
        handleStart={handleStart}
        handleSpeed={handleSpeed}
        handleStrategy={handleStrategy}
        autoParams={autoParams}
        setAutoParams={setAutoParams}
        savingStrategy={savingStrategy}
        fmtMoney={fmtMoney}
      />

      {/* Error display */}
      {error && (
        <div className="mb-3 p-3 rounded-lg border border-rose-500/30 bg-rose-500/10 font-mono text-[11px] text-rose-300">
          {error}
        </div>
      )}

      {/* Playback Controls */}
      {session && (
        <ReplayPlaybackControls
          session={session}
          totalCandles={totalCandles}
          currentIndex={currentIndex}
          progressPct={progressPct}
          currentCandle={currentCandle}
          handleRun={handleRun}
          handlePause={handlePause}
          handleStep={handleStep}
          handleReset={handleReset}
          handleExport={handleExport}
          handleDownloadCsv={handleDownloadCsv}
          exportedRunId={exportedRunId}
          exporting={exporting}
        />
      )}

      {/* Order Entry */}
      {session && session.status !== "done" && currentIndex >= 0 && (
        <ReplayOrderPanel
          session={session}
          currentCandle={currentCandle}
          currentIndex={currentIndex}
          orderSide={orderSide}
          setOrderSide={setOrderSide}
          orderType={orderType}
          setOrderType={setOrderType}
          limitPrice={limitPrice}
          setLimitPrice={setLimitPrice}
          orderQty={orderQty}
          setOrderQty={setOrderQty}
          orderLeverage={orderLeverage}
          setOrderLeverage={setOrderLeverage}
          slPct={slPct}
          setSlPct={setSlPct}
          tpPct={tpPct}
          setTpPct={setTpPct}
          slMode={slMode}
          setSlMode={setSlMode}
          tpMode={tpMode}
          setTpMode={setTpMode}
          slPrice={slPrice}
          setSlPrice={setSlPrice}
          tpPrice={tpPrice}
          setTpPrice={setTpPrice}
          decisionId={decisionId}
          setDecisionId={setDecisionId}
          handleOrder={handleOrder}
        />
      )}

      {/* Positions + Orders + Trades Tables */}
      {session && (
        <ReplayResultsTable
          session={session}
          openPositions={openPositions}
          pendingOrders={pendingOrders}
          handleClose={handleClose}
          handleCancel={handleCancel}
        />
      )}

      {/* Empty state */}
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
