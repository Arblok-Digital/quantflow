import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch, useAuth } from "./useAuth";
import { ReplaySession, fmtMoney, fmtNum } from "../components/replayTypes";

function defaultEnd(): number {
  return Date.now();
}
function defaultStart(): number {
  return Date.now() - 7 * 24 * 60 * 60 * 1000;
}

export function useReplaySession() {
  const { isAuthenticated } = useAuth();
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [active, setActive] = useState(false);
  const [symbol, setSymbol] = useState("BTC/USDT");
  const [timeframe, setTimeframe] = useState("15m");
  const [startMs, setStartMs] = useState<number>(defaultStart);
  const [endMs, setEndMs] = useState<number>(defaultEnd);
  const [initialCash, setInitialCash] = useState(10000);
  const [source, setSource] = useState<"binance" | "mql5">("binance");
  const [mql5File, setMql5File] = useState("");
  const [utcOffsetMinutes, setUtcOffsetMinutes] = useState(0);
  const [verifySummary, setVerifySummary] = useState<Record<string, unknown> | null>(null);
  const [verifying, setVerifying] = useState(false);
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
        source,
        symbol,
        timeframe,
        startMs,
        endMs,
        initialCash,
        ...(source === "mql5" ? { mql5File, utcOffsetMinutes } : {}),
      });
      setSession(payload.session);
      setActive(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [post, source, symbol, timeframe, startMs, endMs, initialCash, mql5File, utcOffsetMinutes]);

  const handleMql5Verify = useCallback(async () => {
    setVerifying(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        mql5File,
        timeframe,
        utcOffsetMinutes: String(utcOffsetMinutes),
      });
      const res = await authFetch(`/api/paper/replay/mql5/verify?${q.toString()}`);
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload?.success) {
        throw new Error(payload?.message || `HTTP ${res.status}`);
      }
      setVerifySummary(payload.summary ?? null);
    } catch (err) {
      setVerifySummary(null);
      setError((err as Error).message);
    } finally {
      setVerifying(false);
    }
  }, [authFetch, mql5File, timeframe, utcOffsetMinutes]);

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
    post,
    session,
    symbol,
    orderSide,
    orderQty,
    orderLeverage,
    slPct,
    tpPct,
    orderType,
    slMode,
    tpMode,
    slPrice,
    tpPrice,
    limitPrice,
    decisionId,
    timeframe,
    loadStatus,
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

  return {
    session,
    setSession,
    active,
    setActive,
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
    source,
    setSource,
    mql5File,
    setMql5File,
    utcOffsetMinutes,
    setUtcOffsetMinutes,
    verifySummary,
    setVerifySummary,
    verifying,
    handleMql5Verify,
    busy,
    setBusy,
    error,
    setError,
    orderSide,
    setOrderSide,
    orderQty,
    setOrderQty,
    orderLeverage,
    setOrderLeverage,
    slPct,
    setSlPct,
    tpPct,
    setTpPct,
    decisionId,
    setDecisionId,
    exporting,
    setExporting,
    exportedRunId,
    setExportedRunId,
    orderType,
    setOrderType,
    limitPrice,
    setLimitPrice,
    slMode,
    setSlMode,
    tpMode,
    setTpMode,
    slPrice,
    setSlPrice,
    tpPrice,
    setTpPrice,
    autoParams,
    setAutoParams,
    savingStrategy,
    setSavingStrategy,
    mountedRef,
    sessionRef,
    loadStatus,
    post,
    handleStart,
    handleStep,
    handleRun,
    handlePause,
    handleReset,
    handleSpeed,
    handleStrategy,
    handleOrder,
    handleClose,
    handleCancel,
    handleExport,
    handleDownloadCsv,
    totalCandles,
    currentIndex,
    progressPct,
    currentCandle,
    openPositions,
    pendingOrders,
    wins,
    losses,
    winRate,
    equity,
    fmtMoney,
    fmtNum,
  };
}