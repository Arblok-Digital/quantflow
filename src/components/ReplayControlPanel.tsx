import React from "react";
import { History, Clock, Activity } from "lucide-react";
import { useReplaySession } from "../hooks/useReplaySession";
import { ReplaySetupPanel } from "./ReplaySetupPanel";
import { ReplayPlaybackControls } from "./ReplayPlaybackControls";
import { ReplayOrderPanel } from "./ReplayOrderPanel";
import { ReplayResultsTable } from "./ReplayResultsTable";

export const ReplayControlPanel: React.FC = () => {
  const replay = useReplaySession();
  const {
    session,
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
    verifying,
    handleMql5Verify,
    busy,
    error,
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
    exportedRunId,
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
  } = replay;

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
              {session
                ? session.dataSource === "mql5"
                  ? "MQL5 CFD backtest data · isolated book"
                  : "Real historical candles (Binance Vision) · isolated book"
                : "Real historical candles (Binance Vision) · isolated book"}
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
        source={source}
        setSource={setSource}
        mql5File={mql5File}
        setMql5File={setMql5File}
        utcOffsetMinutes={utcOffsetMinutes}
        setUtcOffsetMinutes={setUtcOffsetMinutes}
        verifySummary={verifySummary}
        verifying={verifying}
        handleMql5Verify={handleMql5Verify}
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
            Pilih sumber: BINANCE (candle real Binance Vision) atau MQL5 (file CSV ekspor backtest broker CFD), isi
            rentang/parameter lalu tekan Start.
          </p>
        </div>
      )}
    </div>
  );
};
