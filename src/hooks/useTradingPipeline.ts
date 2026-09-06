import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuditLogEntry,
  Candle,
  LatencyBreakdown,
  LLMDecision,
  MacroSummary,
  MarketType,
  OnChainMetrics,
  Portfolio,
  Position,
  RiskConfig,
  RiskEvaluationResult,
  TechnicalIndicators,
  Timeframe,
} from "../types";
import { runTradingPipelineCycle } from "../pipeline/tradingPipeline";

export interface UseTradingPipelineOptions {
  symbol: string;
  marketType: MarketType;
  timeframe: Timeframe;
  currentPrice: number;
  candles15m: Candle[];
  candles4h: Candle[];
  technicals: TechnicalIndicators;
  portfolio: Portfolio;
  positions: Position[];
  riskConfig: RiskConfig;
  onChainMetrics: OnChainMetrics;
  macroSummary: MacroSummary;
  /** Tail hash dari useAuditLedger untuk chaining SHA-256. */
  latestBlockHash: string;
  prependAudit: (entry: AuditLogEntry) => void;
  onPositionOpened: (position: Position) => void;
  onPortfolioUpdated: (portfolio: Portfolio) => void;
}

const INITIAL_LATENCY: LatencyBreakdown = {
  feederMs: 2,
  inferenceMs: 210,
  riskCheckMs: 1,
  brokerExecutionMs: 9,
  totalMs: 222,
};

/**
 * Orchestrator siklus trading pipeline (feeder -> decision -> risk -> broker
 * -> ledger). Semua input volatile disimpan di snapshot ref, jadi
 * `runTradingCycle` stabil dan loop auto-pilot tidak re-subscribe setiap tick.
 */
export function useTradingPipeline(options: UseTradingPipelineOptions) {
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [isAutoPilot, setIsAutoPilot] = useState<boolean>(false);
  const [latestDecision, setLatestDecision] = useState<LLMDecision | null>(null);
  const [lastRiskEvaluation, setLastRiskEvaluation] = useState<RiskEvaluationResult | null>(null);
  const [latestLatency, setLatestLatency] = useState<LatencyBreakdown>(INITIAL_LATENCY);

  const snapshotRef = useRef(options);
  snapshotRef.current = options;
  const isAnalyzingRef = useRef(isAnalyzing);
  isAnalyzingRef.current = isAnalyzing;

  const runTradingCycle = useCallback(async () => {
    const s = snapshotRef.current;
    if (isAnalyzingRef.current || s.riskConfig.isEmergencyStopActive) return;

    setIsAnalyzing(true);
    isAnalyzingRef.current = true;
    try {
      const result = await runTradingPipelineCycle({
        symbol: s.symbol,
        currentPrice: s.currentPrice,
        candles15m: s.candles15m,
        candles4h: s.candles4h,
        technicals: s.technicals,
        marketType: s.marketType,
        timeframe: s.timeframe,
        portfolio: s.portfolio,
        activePositions: s.positions,
        riskConfig: s.riskConfig,
        lastBlockHash: s.latestBlockHash,
        onChainMetrics: s.onChainMetrics,
        macroCalendar: s.macroSummary,
      });

      if (result.decision) {
        setLatestDecision(result.decision);
      }
      if (result.auditEntry) {
        s.prependAudit(result.auditEntry);
        setLastRiskEvaluation(result.auditEntry.riskEvaluation);
        setLatestLatency(result.auditEntry.latency);
      }
      if (result.newPosition) {
        s.onPositionOpened(result.newPosition);
      }
      if (result.updatedPortfolio) {
        s.onPortfolioUpdated(result.updatedPortfolio);
      }
    } catch (err) {
      console.error("Pipeline cycle error:", err);
    } finally {
      setIsAnalyzing(false);
      isAnalyzingRef.current = false;
    }
  }, []);

  // --- Auto-Pilot Loop (runs every 5 seconds) ---
  useEffect(() => {
    if (!isAutoPilot) return;
    const timer = setInterval(() => {
      runTradingCycle();
    }, 5000);
    return () => clearInterval(timer);
  }, [isAutoPilot, runTradingCycle]);

  const toggleAutoPilot = useCallback(() => {
    setIsAutoPilot((v) => !v);
  }, []);

  return {
    isAnalyzing,
    isAutoPilot,
    toggleAutoPilot,
    latestDecision,
    lastRiskEvaluation,
    latestLatency,
    runTradingCycle,
  };
}

export type TradingPipelineController = ReturnType<typeof useTradingPipeline>;