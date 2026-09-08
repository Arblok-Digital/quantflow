import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Header } from "./components/Header";
import { SubBar } from "./components/SubBar";
import { MarketChart } from "./components/MarketChart";
import { DecisionStream } from "./components/DecisionStream";
import { LiquidityHuntPanel } from "./components/LiquidityHuntPanel";
import { OnChainPanel } from "./components/OnChainPanel";
import { MacroCalendarPanel } from "./components/MacroCalendarPanel";
import { RiskManagementPanel } from "./components/RiskManagementPanel";
import { ExecutionMetrics } from "./components/ExecutionMetrics";
import { AuditLedgerModal } from "./components/AuditLedgerModal";
import { ArchitectureModal } from "./components/ArchitectureModal";
import { KeyVaultModal } from "./components/KeyVaultModal";
import { BrokerModal } from "./components/BrokerModal";
import { KeelEnginePanel, KeelAnalysisResult } from "./components/KeelEnginePanel";

import { Realtime1sMLFeed } from "./components/Realtime1sMLFeed";
import { PaperTradingPanel } from "./components/PaperTradingPanel";
import { ExecutionConsole } from "./components/ExecutionConsole";
import { PositionsPanel } from "./components/PositionsPanel";
import { ProbabilityBadge } from "./components/ProbabilityBadge";
import { ReconciliationPanel } from "./components/ReconciliationPanel";

import { Candle, MarketType, Timeframe, OnChainMetrics, MacroSummary, RiskConfig, ModuleTab } from "./types";
import { generateCandlesForTimeframe } from "./logic/indicators";

import { fetchOnChainMetrics } from "./data/onchainData";
import { fetchMacroCalendar } from "./data/macroData";
import { refreshOnChainRealData } from "./data/blockchainRealData";

import { usePaperTrading } from "./hooks/usePaperTrading";
import { useMarketData } from "./hooks/useMarketData";
import { useTradingPipeline } from "./hooks/useTradingPipeline";
import { useAuth, authFetch } from "./hooks/useAuth";
import { LoginGate } from "./components/LoginGate";
import { GuardrailsPanel } from "./components/GuardrailsPanel";
import { useLiveMode } from "./hooks/useLiveMode";
import { TradeJournalPanel } from "./components/TradeJournalPanel";

export default function App() {
  const auth = useAuth();
  const live = useLiveMode(auth.isAuthenticated);
  // --- UI State ---
  const [symbol, setSymbol] = useState<string>("BTC/USDT");
  const [marketType, setMarketType] = useState<MarketType>("FUTURES");
  const [timeframe, setTimeframe] = useState<Timeframe>("15m");
  const [activeTab, setActiveTab] = useState<ModuleTab>("dashboard");
  const [geminiActive, setGeminiActive] = useState<boolean>(true);
  const [isArchitectureOpen, setIsArchitectureOpen] = useState<boolean>(false);
  const [isAuditLedgerOpen, setIsAuditLedgerOpen] = useState<boolean>(false);
  const [isKeyVaultOpen, setIsKeyVaultOpen] = useState<boolean>(false);
  const [isBrokerOpen, setIsBrokerOpen] = useState<boolean>(false);
  const [keelResult, setKeelResult] = useState<KeelAnalysisResult | null>(null);
  const [keelLoading, setKeelLoading] = useState<boolean>(false);

  // --- Risk Config (cross-cutting, diedit via RiskManagementPanel) ---
  const [riskConfig, setRiskConfig] = useState<RiskConfig>({
    maxRiskPerTradePercent: 2,
    maxPositionPercent: 12,
    maxDrawdownLimit: 6,
    minConfidenceThreshold: 60,
    minRiskRewardRatio: 1.8,
    isEmergencyStopActive: false,
  });

  // --- Intelligence Data (on-chain & makro) via data/ provider (mock -> real) ---
  const [onChainMetrics, setOnChainMetrics] = useState<OnChainMetrics>(() => fetchOnChainMetrics(symbol, 64250));
  const [macroSummary, setMacroSummary] = useState<MacroSummary>(() => fetchMacroCalendar());

  // Server ledger stats baseline for avgSlippage (Phase 3.4 requires server truth, not client avg)
  const [serverAvgSlippage, setServerAvgSlippage] = useState<number | null>(null);
  const [serverBlockTail, setServerBlockTail] = useState<string | null>(null);
  useEffect(() => {
    if (!auth.isAuthenticated) return;
    let alive = true;
    const loadLedgerBadge = async () => {
      try {
        const statsRes = await authFetch("/api/ledger/stats").then((r) => r.json().catch(() => null));
        if (!alive) return;
        if (statsRes && typeof statsRes.avgSlippageBps === "number") {
          setServerAvgSlippage(Number(statsRes.avgSlippageBps));
        } else {
          setServerAvgSlippage(null);
        }
      } catch {
        if (alive) setServerAvgSlippage(null);
      }
      try {
        const ledgerRes = await authFetch("/api/ledger?limit=1").then((r) => r.json().catch(() => null));
        if (!alive) return;
        const first = ledgerRes?.entries?.[0];
        if (first && first.hash) setServerBlockTail(String(first.hash));
        else setServerBlockTail(null);
      } catch {
        if (alive) setServerBlockTail(null);
      }
    };
    loadLedgerBadge();
    const iv = setInterval(loadLedgerBadge, 6000);
    const onVis = () => { if (!document.hidden) loadLedgerBadge(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [auth.isAuthenticated]);
  const avgSlippageDisplay: number | string = serverAvgSlippage != null && isFinite(serverAvgSlippage) ? serverAvgSlippage : "–";
  // prependAudit retained as no-op compat for pipeline (ledger now server-side)
  const prependAudit = useCallback((_entry: any) => {}, []);
  const latestBlockHash = serverBlockTail ?? "GENESIS_ROOT_AI_TRADING";

  // Refresh on-chain/makro ke harga feed live terbaru (dipanggil tiap sinkronisasi).
  // Snapshot real blockchain.com di-refresh lebih dulu -> simulasi di-anchor data asli.
  const handleFeedLive = useCallback(
    async (price: number) => {
      await refreshOnChainRealData();
      setOnChainMetrics(fetchOnChainMetrics(symbol, price));
      setMacroSummary(fetchMacroCalendar());
    },
    [symbol]
  );

  // --- Domain Hooks ---
  const market = useMarketData({
    symbol,
    timeframe,
    onChainMetrics,
    macroSummary,
    onFeedLive: handleFeedLive,
  });

  const paper = usePaperTrading({
    symbol,
    currentPrice: market.currentPrice,
  });

  const pipeline = useTradingPipeline({
    symbol,
    marketType,
    timeframe,
    currentPrice: market.currentPrice,
    candles15m: market.candles15m,
    candles4h: market.candles4h,
    technicals: market.technicals,
    portfolio: paper.portfolio,
    positions: paper.positions,
    riskConfig,
    onChainMetrics,
    macroSummary,
    latestBlockHash,
    prependAudit,
    onPositionOpened: paper.addPosition,
    onPortfolioUpdated: paper.commitPortfolio,
    orderBook: market.orderBook,
  });

  // Tombol "Sinkronisasi" OnChainPanel: refetch snapshot real lalu rebuild metrics.
  const handleRefreshOnChain = useCallback(async () => {
    await refreshOnChainRealData();
    setOnChainMetrics(fetchOnChainMetrics(symbol, market.currentPrice));
  }, [symbol, market.currentPrice]);

  const runKeelSignal = useCallback(async () => {
    setKeelLoading(true);
    try {
      const res = await authFetch("/api/keel/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, currentPrice: market.currentPrice }),
      });
      const data = await res.json();
      if (data?.decision) {
        const d = data.decision;
        setKeelResult({
          action: String(d.action ?? "HOLD"),
          confidence: Number(d.confidence ?? 0),
          targetPrice: d.targetPrice != null ? Number(d.targetPrice) : undefined,
          stopLoss: d.stopLoss != null ? Number(d.stopLoss) : undefined,
          takeProfit: d.takeProfit != null ? Number(d.takeProfit) : undefined,
          positionSizePercent: d.positionSizePercent != null ? Number(d.positionSizePercent) : undefined,
          reasoning: d.reasoning ? String(d.reasoning) : undefined,
          rawSignal: data.rawSignal
            ? {
                signal: data.rawSignal.signal ? String(data.rawSignal.signal?.action ?? data.rawSignal.signal) : null,
                discardedReason: data.rawSignal.discardedReason ? String(data.rawSignal.discardedReason) : undefined,
                compositeScore: data.rawSignal.compositeScore != null ? Number(data.rawSignal.compositeScore) : data.rawSignal.confluence?.score != null ? Number(data.rawSignal.confluence.score) : undefined,
                smartMoneyFlow: data.rawSignal.smartMoneyFlow ? String(data.rawSignal.smartMoneyFlow) : undefined,
                liquidityDepthUsd: data.rawSignal.liquidityDepthUsd != null ? Number(data.rawSignal.liquidityDepthUsd) : undefined,
              }
            : undefined,
          riskGate: data.riskGate ? { passed: Boolean(data.riskGate.passed), reasons: Array.isArray(data.riskGate.reasons) ? data.riskGate.reasons.map(String) : undefined } : undefined,
          liquidityHuntAnalysis: data.liquidityHuntAnalysis || d.liquidityHuntAnalysis || undefined,
          source: String(d.source || data.source || "keel-institutional-quant"),
          inferenceLatencyMs: Number(data.inferenceLatencyMs ?? d.inferenceLatencyMs ?? 0) || undefined,
          promptSummary: data.promptSummary ? String(data.promptSummary) : d.promptSummary ? String(d.promptSummary) : `policy=keel-quant symbol=${symbol} price=${market.currentPrice}`,
        });
      }
      console.log("Full Keel Analysis:", data);
    } catch (err) {
      console.error("Keel signal error:", err);
    } finally {
      setKeelLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, market.currentPrice]);

  // --- Health & Gemini status ---
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        if (data.geminiConfigured !== undefined) {
          setGeminiActive(data.geminiConfigured);
        }
      })
      .catch(() => {});
  }, []);

  // --- Timeframe / MarketType handlers ---
  const handleSelectTimeframe = useCallback(
    (newTf: Timeframe) => {
      if (newTf === "4h" || newTf === "1D" || newTf === "1W") {
        setMarketType("SPOT");
      } else {
        setMarketType("FUTURES");
      }
      setTimeframe(newTf);
      market.loadTimeframe(newTf);
    },
    [market.loadTimeframe]
  );

  const handleSelectMarketType = useCallback(
    (m: MarketType) => {
      setMarketType(m);
      handleSelectTimeframe(m === "FUTURES" ? "15m" : "4h");
    },
    [handleSelectTimeframe]
  );

  // Active candles depending on selected timeframe (1s to 1W)
  const activeDisplayCandles: Candle[] = useMemo(() => {
    const { microTicks, candles15m, candles4h, candlesByTimeframe } = market;
    if (timeframe === "1s") {
      if (microTicks.length >= 8) {
        return microTicks.slice(-45).map((t) => ({
          timestamp: t.timestamp,
          open: t.open,
          high: t.high,
          low: t.low,
          close: t.close,
          volume: t.volume,
        }));
      }
      if (candlesByTimeframe["1s"] && candlesByTimeframe["1s"].length > 0) {
        return candlesByTimeframe["1s"];
      }
      return generateCandlesForTimeframe(market.currentPrice, "1s", 35);
    }
    if (timeframe === "15m") {
      return candles15m.length > 0 ? candles15m : candlesByTimeframe["15m"] || [];
    }
    if (timeframe === "4h") {
      return candles4h.length > 0 ? candles4h : candlesByTimeframe["4h"] || [];
    }
    if (candlesByTimeframe[timeframe] && candlesByTimeframe[timeframe].length > 0) {
      return candlesByTimeframe[timeframe];
    }
    return generateCandlesForTimeframe(market.currentPrice, timeframe, 45);
  }, [timeframe, market.microTicks, market.candles15m, market.candles4h, market.candlesByTimeframe, market.currentPrice]);

  const floatingPnl = paper.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const openPositionsCount = paper.positions.length;

  // Server paper book is the single source of truth: whenever PositionsPanel
  // polls /api/broker/positions, prune client-side rows ("pos-...") that are no
  // longer OPEN on the server (closed by bracket monitor or the panel itself).
  const handleServerPositions = useCallback(
    (openServerIds: string[]) => {
      paper.pruneServerPositions(openServerIds);
    },
    [paper]
  );

  if (auth.isChecking) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center font-mono text-zinc-500 text-sm">
        <span className="flex items-center gap-2">
          <span className="w-3 h-3 border-2 border-zinc-700 border-t-amber-500 rounded-full animate-spin" />
          Checking session...
        </span>
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    return <LoginGate onLogin={auth.login} error={auth.error} />;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-amber-500 selection:text-zinc-950">
      {/* LIVE banner — non-dismissable, red when armed */}
      {live.armedForLive ? (
        <div className="sticky top-0 z-[60] w-full bg-rose-600 text-white text-center py-1.5 font-mono font-black tracking-widest text-xs border-b border-rose-700 shadow-lg shadow-rose-600/20">
          <span className="inline-flex items-center gap-2">
            <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
            🔴 LIVE TRADING ARMED — real orders enabled
            <span className="hidden sm:inline opacity-90">— {live.exchangeId.toUpperCase()} • {live.testnet ? "TESTNET" : "MAINNET"}</span>
          </span>
        </div>
      ) : (
        <div className="sticky top-0 z-[60] w-full bg-zinc-900 text-zinc-400 text-center py-1 font-mono font-bold tracking-widest text-[11px] border-b border-zinc-800">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full" />
            PAPER MODE — dry-run • LIVE equity vs PAPER shown below
          </span>
        </div>
      )}

      {/* Slim header: brand, exchange status, tabs, price, modal menu, live badge, logout */}
      <Header
        geminiActive={geminiActive}
        currentPrice={market.currentPrice}
        priceDelta={market.priceDelta}
        exchangeStatus={market.exchangeStatus}
        onSyncLiveExchange={market.syncLiveExchangeData}
        isSyncingFeed={market.isSyncingFeed}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        openPositionsCount={openPositionsCount}
        floatingPnl={floatingPnl}
        tickCount={market.microTicks.length}
        isLiveArmed={live.armedForLive}
        liveMode={live.mode}
        liveEquity={live.equity}
        onOpenArchitecture={() => setIsArchitectureOpen(true)}
        onOpenAuditLedger={() => setIsAuditLedgerOpen(true)}
        onOpenKeyVault={() => setIsKeyVaultOpen(true)}
        onOpenBroker={() => setIsBrokerOpen(true)}
        onLogout={auth.logout}
      />

      {/* Contextual sub-bar: pair, market type, timeframe, scan/auto/kill */}
      <SubBar
        symbol={symbol}
        onSelectSymbol={setSymbol}
        marketType={marketType}
        onSelectMarketType={handleSelectMarketType}
        timeframe={timeframe}
        onSelectTimeframe={handleSelectTimeframe}
        isAutoPilot={pipeline.isAutoPilot}
        onToggleAutoPilot={pipeline.toggleAutoPilot}
        onTriggerManualCycle={pipeline.runTradingCycle}
        isEmergencyStop={riskConfig.isEmergencyStopActive}
        onToggleEmergencyStop={() =>
          setRiskConfig((prev) => ({ ...prev, isEmergencyStopActive: !prev.isEmergencyStopActive }))
        }
        isAnalyzing={pipeline.isAnalyzing}
      />

      {/* Main Content — each tab renders its panels exactly once */}
      <main className="flex-1 p-3 sm:p-5 max-w-7xl w-full mx-auto space-y-4">
        {/* 📊 DASHBOARD */}
        {activeTab === "dashboard" && (
          <>
            {/* Real-time MTF Feeder Chart with Liquidation Hunt Bands */}
            <MarketChart
              candles={activeDisplayCandles}
              symbol={symbol}
              technicals={market.technicals}
              orderBook={market.orderBook}
              currentPrice={market.currentPrice}
              mtfLiquidity={market.mtfLiquidity}
              timeframe={timeframe}
              onSelectTimeframe={handleSelectTimeframe}
              candlesByTimeframe={market.candlesByTimeframe}
              feedMode={market.feedMode}
              exchangeStatus={market.exchangeStatus}
            />

            {/* Decision Engine Stream + LIVE Guardrails (server truth): 2-col */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <DecisionStream
                decision={pipeline.latestDecision}
                technicals={market.technicals}
                currentPrice={market.currentPrice}
                symbol={symbol}
                isAnalyzing={pipeline.isAnalyzing}
                mtfLiquidity={market.mtfLiquidity}
              />
              <GuardrailsPanel />
            </div>

            {/* Institutional Quant Engine (full width) */}
            <KeelEnginePanel result={keelResult} loading={keelLoading} onAnalyze={runKeelSignal} />

            {/* Risk Management + Probability Badge: 2-col */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <RiskManagementPanel
                config={riskConfig}
                onChangeConfig={setRiskConfig}
                lastEvaluation={pipeline.lastRiskEvaluation}
                currentDrawdown={paper.portfolio.currentDrawdownPercent}
              />
              <ProbabilityBadge
                currentPrice={market.currentPrice}
                probInput={{
                  confluenceScore: market.mtfLiquidity.confluenceScore / 100,
                  absorptionScore: 50,
                  wallAction: "NONE",
                  spreadPct: market.orderBook.spread,
                  imbalance: market.technicals.orderBookImbalance,
                }}
                side="LONG"
                stopLoss={paper.positions[0]?.stopLoss ?? pipeline.latestDecision?.stopLoss ?? null}
                takeProfit={paper.positions[0]?.takeProfit ?? pipeline.latestDecision?.takeProfit ?? null}
              />
            </div>

            {/* Swing Execution Metrics & Modular Pipeline Telemetry */}
            <ExecutionMetrics
              portfolio={paper.portfolio}
              positions={paper.positions}
              latestLatency={pipeline.latestLatency}
              onClosePosition={paper.closePosition}
              averageSlippageBps={typeof avgSlippageDisplay === "number" ? avgSlippageDisplay : 0}
              closedTrades={paper.closedTrades}
            />
          </>
        )}

        {/* 💰 PAPER TRADING */}
        {activeTab === "paper" && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-mono uppercase tracking-wider text-amber-400 font-semibold">
                Server-Backed Execution &amp; Positions
              </h3>
              <span className="text-[10px] font-mono text-zinc-500">
                data dari server broker &mdash; sumber kebenaran (polling /api/broker/events + /api/broker/positions)
              </span>
            </div>

            <ExecutionConsole />
            <PositionsPanel onServerPositions={handleServerPositions} />

            <PaperTradingPanel
              portfolio={paper.portfolio}
              positions={paper.positions}
              closedTrades={paper.closedTrades}
              currentPrice={market.currentPrice}
              symbol={symbol}
              mtfLiquidity={market.mtfLiquidity}
              latestDecision={pipeline.latestDecision}
              onClosePosition={paper.closePosition}
              onMoveToBreakEven={paper.moveToBreakEven}
              onResetPaperAccount={paper.resetPaperAccount}
              onSimulateTradeEntry={paper.simulateTradeEntry}
              actionableRunKeel={runKeelSignal}
            />

            <TradeJournalPanel />
          </>
        )}

        {/* 📈 ANALYTICS (on-chain + macro merged) */}
        {activeTab === "analytics" && (
          <>
            {/* MTF Liquidity Hunt Radar Panel (full width) */}
            <LiquidityHuntPanel
              mtfLiquidity={market.mtfLiquidity}
              currentPrice={market.currentPrice}
              marketType={marketType}
              timeframe={timeframe}
              orderBook={market.orderBook}
            />

            {/* On-Chain + Macro: 2-col */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <OnChainPanel metrics={onChainMetrics} onRefresh={() => handleRefreshOnChain()} />
              <MacroCalendarPanel
                macro={macroSummary}
                onRefresh={() => setMacroSummary(fetchMacroCalendar())}
              />
            </div>

            <ReconciliationPanel />
          </>
        )}

        {/* ⚡ 1s FEED */}
        {activeTab === "feed" && (
          <Realtime1sMLFeed
            ticks={market.microTicks}
            currentPrice={market.currentPrice}
            symbol={symbol}
            exchangeStatus={market.exchangeStatus}
            feedMode={market.feedMode}
            messageRate={market.messageRate}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 bg-zinc-950 px-4 py-2 text-center text-xs font-mono text-zinc-400">
        AI Trading Agent Pipeline • Gemini 3.8 Flash • MTF Liquidity Hunt • Non-custodial AES-GCM Vault • SHA-256 Audit Ledger
      </footer>

      {/* Interactive Modals */}
      <ArchitectureModal
        isOpen={isArchitectureOpen}
        onClose={() => setIsArchitectureOpen(false)}
      />

      <AuditLedgerModal
        isOpen={isAuditLedgerOpen}
        onClose={() => setIsAuditLedgerOpen(false)}
      />

      <KeyVaultModal
        isOpen={isKeyVaultOpen}
        onClose={() => setIsKeyVaultOpen(false)}
      />

      <BrokerModal
        isOpen={isBrokerOpen}
        onClose={() => setIsBrokerOpen(false)}
      />
    </div>
  );
}
