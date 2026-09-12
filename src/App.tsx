import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Header } from "./components/Header";
import { SubBar } from "./components/SubBar";
import { EnvironmentBar } from "./components/EnvironmentBar";
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
import { AiAdvisorPanel } from "./components/AiAdvisorPanel";
import { PumpRadarPanel } from "./components/PumpRadarPanel";

import { Realtime1sMLFeed } from "./components/Realtime1sMLFeed";
import { PaperTradingPanel } from "./components/PaperTradingPanel";
import { ExecutionConsole } from "./components/ExecutionConsole";
import { PositionsPanel } from "./components/PositionsPanel";
import { ReplayControlPanel } from "./components/ReplayControlPanel";
import { ReplayRunsPanel } from "./components/ReplayRunsPanel";
import { ProbabilityBadge } from "./components/ProbabilityBadge";
import { ReconciliationPanel } from "./components/ReconciliationPanel";

import { Candle, MarketType, Timeframe, OnChainMetrics, MacroSummary, RiskConfig, ModuleTab, OrderBook } from "./types";
import { generateCandlesForTimeframe } from "./logic/indicators";

import { fetchOnChainMetrics } from "./data/onchainData";
import { fetchMacroCalendar } from "./data/macroData";
import { refreshOnChainRealData } from "./data/blockchainRealData";

import { usePaperTrading } from "./hooks/usePaperTrading";
import { useMarketData } from "./hooks/useMarketData";
import { useTradingPipeline } from "./hooks/useTradingPipeline";
import { useAuth, authFetch } from "./hooks/useAuth";
import { evaluateTradingDecision } from "./logic/decisionEngine";
import { LoginGate } from "./components/LoginGate";
import { GuardrailsPanel } from "./components/GuardrailsPanel";
import { useLiveMode } from "./hooks/useLiveMode";
import { ModeProvider } from "./hooks/useMode";
import { ToastProvider } from "./components/ExecutionToasts";
import { TradeJournalPanel } from "./components/TradeJournalPanel";
import { AgentDecisionsPanel } from "./components/AgentDecisionsPanel";
import type { RecentTrade, FuturesMetrics } from "./data/marketFetcher";

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

  // Keel Context — data order-flow + futures yang di-fetch server-side (endpoint
  // /api/market/keel-context), di-refresh per-menit / saat symbol berubah.
  // Hanya dibutuhkan mode KEEL (gemini non-aktif); AI mode tidak memakainya.
  const [keelContext, setKeelContext] = useState<{
    orderBook?: OrderBook;
    recentTrades?: RecentTrade[];
    futures?: FuturesMetrics;
  }>({});

  const refreshKeelContext = useCallback(async () => {
    try {
      const res = await fetch(`/api/market/keel-context?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) return;
      const data = await res.json();
      setKeelContext({
        orderBook: data.orderBook ?? undefined,
        recentTrades: data.recentTrades ?? undefined,
        futures: data.futures ?? undefined,
      });
    } catch (err) {
      // Fail-closed jujur: kalau fetch gagal, lanjut tanpa data (keel HOLD).
      console.warn("Keel context fetch failed:", err);
    }
  }, [symbol]);

  // Refresh saat symbol berubah + tiap menit ketika mode KEEL aktif. Pipeline
  // 5s-tick tetap bebas fetch (data sedikit stale ok — keel toleran).
  useEffect(() => {
    if (!geminiActive) {
      refreshKeelContext();
      const iv = setInterval(refreshKeelContext, 60000);
      return () => clearInterval(iv);
    }
  }, [symbol, geminiActive, refreshKeelContext]);

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
    onPendingOrder: paper.addPendingOrder,
    orderBook: market.orderBook,
    recentTrades: keelContext.recentTrades,
    futures: keelContext.futures,
    aiEnabled: geminiActive,
  });

  // Tombol "Sinkronisasi" OnChainPanel: refetch snapshot real lalu rebuild metrics.
  const handleRefreshOnChain = useCallback(async () => {
    await refreshOnChainRealData();
    setOnChainMetrics(fetchOnChainMetrics(symbol, market.currentPrice));
  }, [symbol, market.currentPrice]);

  const runKeelSignal = useCallback(async () => {
    setKeelLoading(true);
    try {
      const decision = await evaluateTradingDecision({
        symbol,
        currentPrice: market.currentPrice,
        candles: timeframe === "4h" ? market.candles4h : market.candles15m,
        technicals: market.technicals,
        mtfLiquidity: market.mtfLiquidity,
        onChainMetrics,
        macroCalendar: macroSummary,
        activePositions: paper.positions,
        portfolioEquity: paper.portfolio.equity,
        riskConfig,
        aiEnabled: geminiActive,
        orderBook: market.orderBook,
        recentTrades: keelContext.recentTrades,
        futures: keelContext.futures,
      });
      setKeelResult({
        action: String(decision.action ?? "HOLD"),
        confidence: Number(decision.confidence ?? 0),
        targetPrice: decision.targetPrice != null ? Number(decision.targetPrice) : undefined,
        stopLoss: decision.stopLoss != null ? Number(decision.stopLoss) : undefined,
        takeProfit: decision.takeProfit != null ? Number(decision.takeProfit) : undefined,
        positionSizePercent: decision.positionSizePercent != null ? Number(decision.positionSizePercent) : undefined,
        reasoning: decision.reasoning ? String(decision.reasoning) : undefined,
        liquidityHuntAnalysis: decision.liquidityHuntAnalysis || undefined,
        futuresAnalysis: decision.futuresAnalysis || undefined,
        source: String(decision.source || "keel-institutional-quant"),
        inferenceLatencyMs: decision.inferenceLatencyMs ? Number(decision.inferenceLatencyMs) : undefined,
        promptSummary: `policy=${decision.source ?? "router"} symbol=${symbol} price=${market.currentPrice}`,
      });
    } catch (err) {
      console.error("Decision engine error:", err);
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
      // Pill indikator (RSI/EMA/MACD) mengikuti TF yang diklik — bukan 15m.
      market.setActiveIndicatorTimeframe(newTf);
    },
    [market.setActiveIndicatorTimeframe]
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
    <ToastProvider>
    <ModeProvider live={live}>
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-amber-500 selection:text-zinc-950">
      {/* Zone 1 — Environment bar (sticky, single source of truth paper/live;
          banner duplikat lama dihapus — EnvironmentBar yang menangani semua state) */}
      <EnvironmentBar
        liveMode={live.mode}
        isLiveArmed={live.armedForLive}
        exchangeId={live.exchangeId}
        testnet={live.testnet}
        equity={live.equity}
      />

      {/* Zone 2 + 3 — Brand/Account + Navigation */}
      <Header
        geminiActive={geminiActive}
        currentPrice={market.currentPrice}
        priceDelta={market.priceDelta}
        exchangeStatus={market.exchangeStatus}
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        openPositionsCount={openPositionsCount}
        floatingPnl={floatingPnl}
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
        activeTab={activeTab}
      />

      {/* Main Content — each tab renders its panels exactly once */}
      <main className="flex-1 p-3 sm:p-5 max-w-7xl w-full mx-auto space-y-4">
        {/* 📊 DASHBOARD — High-level summary + trading interface */}
        {activeTab === "dashboard" && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
                <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Equity</div>
                <div className="text-lg font-mono font-bold text-zinc-100">${paper.portfolio.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
                <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Open P&L</div>
                <div className={`text-lg font-mono font-bold ${floatingPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{floatingPnl >= 0 ? "+" : ""}${floatingPnl.toFixed(2)}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
                <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Positions</div>
                {/* Server book hanya mengirim posisi OPEN — count = length (status tidak dimapping di reader hook) */}
                <div className="text-lg font-mono font-bold text-zinc-100">{paper.positions.length}</div>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
                <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">Win Rate</div>
                <div className="text-lg font-mono font-bold text-zinc-100">
                  {paper.portfolio.totalTrades > 0
                    ? ((paper.portfolio.winCount / paper.portfolio.totalTrades) * 100).toFixed(1)
                    : "0.0"}
                  %
                </div>
              </div>
            </div>

            {pipeline.latestDecision && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <div className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider mb-2">Latest AI Signal</div>
                <div className="flex items-center gap-4">
                  <span className={`px-2 py-1 rounded text-xs font-mono font-bold ${pipeline.latestDecision.action === "BUY" ? "bg-emerald-500/20 text-emerald-300" : pipeline.latestDecision.action === "SELL" ? "bg-rose-500/20 text-rose-300" : "bg-zinc-800 text-zinc-400"}`}>
                    {pipeline.latestDecision.action}
                  </span>
                  <span className="text-xs font-mono text-zinc-400">{pipeline.latestDecision.reasoning?.slice(0, 120)}...</span>
                </div>
              </div>
            )}

            <ExecutionConsole />
            <PositionsPanel onServerPositions={handleServerPositions} />

            <PaperTradingPanel
              portfolio={paper.portfolio}
              positions={paper.positions}
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

        {/* 📈 ANALYTICS — Full chart + indicators + confluence + order book */}
        {activeTab === "analytics" && (
          <>
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
              activeTfCandleCount={activeDisplayCandles.length}
            />

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

            <KeelEnginePanel result={keelResult} loading={keelLoading} onAnalyze={runKeelSignal} />

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

            <LiquidityHuntPanel
              mtfLiquidity={market.mtfLiquidity}
              currentPrice={market.currentPrice}
              marketType={marketType}
              timeframe={timeframe}
              orderBook={market.orderBook}
            />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <OnChainPanel metrics={onChainMetrics} onRefresh={() => handleRefreshOnChain()} />
              <MacroCalendarPanel
                macro={macroSummary}
                onRefresh={() => setMacroSummary(fetchMacroCalendar())}
              />
            </div>

            <ExecutionMetrics
              portfolio={paper.portfolio}
              latestLatency={pipeline.latestLatency}
              averageSlippageBps={typeof avgSlippageDisplay === "number" ? avgSlippageDisplay : 0}
              closedTrades={paper.closedTrades}
            />

            <AgentDecisionsPanel />

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

        {/* 🧭 AI ADVISOR — insight naratif (keel+MTF+on-chain+macro); eksekusi tetap manual oleh user */}
        {activeTab === "advisor" && (
          <AiAdvisorPanel
            symbol={symbol}
            currentPrice={market.currentPrice}
            onChainMetrics={onChainMetrics}
            macroSummary={macroSummary}
            geminiActive={geminiActive}
          />
        )}

        {/* 📡 PUMP RADAR — scanner microcap Gate.io SPOT (alert only, tanpa eksekusi) */}
        {activeTab === "pump" && (
          <PumpRadarPanel />
        )}

        {/* 🕰️ REPLAY — forward-test isolated book + riwayat runs tersimpan (DB) */}
        {activeTab === "replay" && (
          <>
            <ReplayControlPanel />
            <ReplayRunsPanel />
          </>
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
    </ModeProvider>
    </ToastProvider>
  );
}
