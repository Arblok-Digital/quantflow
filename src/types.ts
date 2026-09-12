export type TradeAction = "BUY" | "SELL" | "HOLD";
export type OrderStatus = "FILLED" | "REJECTED" | "CANCELLED" | "PENDING";
export type MarketType = "FUTURES" | "SPOT";
export type Timeframe = "1s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1D" | "1W";

/** Navigation tabs — each renders its panels exactly once (no cross-tab duplication). */
export type ModuleTab = "dashboard" | "analytics" | "feed" | "advisor" | "pump" | "replay";

export const MODULE_TABS: ModuleTab[] = ["dashboard", "analytics", "feed", "advisor", "pump", "replay"];

export const MODULE_TAB_LABELS: Record<ModuleTab, string> = {
  dashboard: "Dashboard",
  analytics: "Analytics",
  feed: "1s Feed",
  advisor: "Advisor",
  pump: "Pump Radar",
  replay: "Replay",
};

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// --- 1-Second Real-Time Micro-Tick & ML Telemetry Types ---
export interface MLFeatureVector {
  normPriceDelta: number;     // Normalized 1s price change [-1, 1]
  rollingVol10s: number;      // Rolling 10-second micro-volatility
  imbalanceRatio: number;     // (BidDepth - AskDepth) / (BidDepth + AskDepth)
  mtf15mRsi: number;          // Anchor 15m RSI [0, 100]
  sweepFlag: number;          // 1 = Active MTF Liquidity Sweep, 0 = In Range
  whaleNetflowZ: number;      // Standardized Smart Money Netflow [-3, 3]
  macroRiskIndex: number;     // Macro catalyst risk score [0, 100]
}

export interface MicroTick1s {
  id: string;
  timestamp: number;
  timeString: string;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tickDirection: "BUY_AGGRESSOR" | "SELL_AGGRESSOR" | "NEUTRAL";
  microSpreadUSD: number;
  orderFlowImbalance: number; // -1 to +1
  mlVector: MLFeatureVector;
}

export interface TechnicalIndicators {
  rsi: number;
  ema20: number;
  ema50: number;
  macd: {
    macdLine: number;
    signalLine: number;
    histogram: number;
  };
  orderBookImbalance: number; // Ratio of Bid Depth to Ask Depth (> 1 = buying pressure)
  volatility: string;
  atr?: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
  total: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  spread: number;
}

// --- MTF Liquidation Hunt Types ---
export type LiquidityPoolType = "BSL" | "SSL"; // BSL = Buy-Side Liquidity (Short Stop Loss/Liq), SSL = Sell-Side Liquidity (Long Stop Loss/Liq)

export type LiquidityHuntState = 
  | "HUNTING_BSL"      // Price expanding up to trigger short liquidation cluster
  | "HUNTING_SSL"      // Price expanding down to trigger long liquidation cluster
  | "SWEPT_BSL"        // Upper short liquidity swept; high probability bearish reversal / rejection
  | "SWEPT_SSL"        // Lower long liquidity swept; high probability bullish reversal / absorption
  | "EQUILIBRIUM";     // Range bound; building liquidity on both sides

export interface LiquidityZone {
  id: string;
  timeframe: Timeframe;
  type: LiquidityPoolType;
  priceMin: number;
  priceMax: number;
  midPrice: number;
  estimatedVolumeUSD: number; // In millions, e.g. 14.5 = $14.5M
  leverageTiers: string;       // e.g. "50x - 100x" or "20x - 50x"
  status: "ACTIVE" | "PARTIALLY_SWEPT" | "FULLY_SWEPT";
  touches: number;
  distancePercent: number;    // Difference relative to current price
}

export interface MTFLiquidityAnalysis {
  marketType: MarketType;
  primaryTimeframe: Timeframe;
  macroTimeframe: Timeframe;
  activeState: LiquidityHuntState;
  nearestBSL: LiquidityZone | null; // Upper short liquidation pool
  nearestSSL: LiquidityZone | null; // Lower long liquidation pool
  recentSweep: {
    zone: LiquidityZone;
    timestamp: number;
    wickRejectionPercent: number;
    type: "BULLISH_SSL_SWEEP" | "BEARISH_BSL_SWEEP";
    invalidationPrice: number;
  } | null;
  zones15m: LiquidityZone[];
  zones4h: LiquidityZone[];
  confluenceScore: number; // 0 - 100%
  confluenceSummary: string;
  huntingTarget: {
    targetType: LiquidityPoolType;
    targetPrice: number;
    potentialPnlPercent: number;
  } | null;
}

/** Provenance tag per pilar data — menandai asal angka (4.4). */
export interface DataProvenance {
  source: "REAL" | "SIMULATED" | "STALE";
  fetchedAt: number;
  ageMinutes?: number;
}

export interface LLMDecision {
  action: TradeAction;
  confidence: number;
  targetPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizePercent: number;
  reasoning: string;
  source?: string;
  inferenceLatencyMs: number;
  liquidityHuntAnalysis?: {
    targetPool: LiquidityPoolType;
    targetZonePrice: number;
    sweepTriggered: boolean;
    mtfBias: string;
    confluenceScore: number;
    invalidationLevel: number;
  };
  onChainContext?: {
    smartMoneyBias: string;
    netflowStatus: string;
    mvrvZScore: number;
    whaleSignal: string;
  };
  macroContext?: {
    nearestEventName: string;
    volatilityRisk: string;
    fedStance: string;
  };
  futuresAnalysis?: {
    fundingRate?: number;
    fundingBps?: number;
    markPrice?: number;
    openInterest?: number;
    openInterestUsd?: number;
    lsrTaker?: number;
    lsrAccount?: number;
    longLiqUsd?: number;
    shortLiqUsd?: number;
    longLiqSize?: number;
    shortLiqSize?: number;
    topLongSize?: number;
    topShortSize?: number;
    topLsrSize?: number;
    volume24hUsd?: number;
    bias?: string;
    biasReason?: string;
    source?: string;
  };
  /** Provenance per pilar (4.4): dari mana tiap angka decision berasal. */
  provenance?: {
    market?: DataProvenance;
    liquidity?: DataProvenance;
    onChain?: DataProvenance;
    macro?: DataProvenance;
  };
  /** 3 baris ringkas prompt server yang meng-hasilkan decision ini (4.5). */
  promptSummary?: string;
}

export interface RiskConfig {
  maxRiskPerTradePercent: number;
  maxPositionPercent: number;
  maxDrawdownLimit: number;
  minConfidenceThreshold: number;
  minRiskRewardRatio: number;
  isEmergencyStopActive: boolean;
}

export interface RiskEvaluationResult {
  approved: boolean;
  maxDrawdownPassed: boolean;
  positionSizePassed: boolean;
  riskRewardRatio: number;
  notes: string;
}

export interface LatencyBreakdown {
  feederMs: number;
  inferenceMs: number;
  riskCheckMs: number;
  brokerExecutionMs: number;
  totalMs: number;
}

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  symbol: string;
  action: TradeAction;
  qty: number;
  requestedPrice: number;
  executedPrice: number;
  slippageBps: number;
  status: OrderStatus;
  reasoning: string;
  confidence: number;
  riskEvaluation: RiskEvaluationResult;
  latency: LatencyBreakdown;
  signature: string;
  payloadHash: string;
  previousHash: string;
  blockHash: string;
  timeframe?: Timeframe;
  marketType?: MarketType;
  liquidityContext?: string;
}

export interface Position {
  id?: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  notionalUSD?: number;
  leverage?: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  stopLoss: number; // Cut Loss (CL)
  takeProfit: number; // Target TP
  potentialProfitUSD?: number;
  potentialLossUSD?: number;
  riskRewardRatio?: number;
  openedAt: number;
  timeframe: Timeframe;
  marketType: MarketType;
  targetLiquidityPool?: string;
  entryReasoning?: string;
  confidence?: number;
  liquidationPrice?: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  notionalUSD: number;
  entryPrice: number;
  exitPrice: number;
  pnlUSD: number;
  pnlPercent: number;
  openedAt: number;
  closedAt: number;
  exitReason: "TAKE_PROFIT" | "CUT_LOSS" | "MANUAL_CLOSE" | "TRAILING_STOP" | "EMERGENCY_STOP" | "LIQUIDATED";
  entryReasoning: string;
  targetLiquidityPool?: string;
  rMultiple: number;
}

export interface Portfolio {
  cash: number;
  equity: number;
  initialBalance: number;
  realizedPnl: number;
  winCount: number;
  lossCount: number;
  totalTrades: number;
  maxDrawdownPercent: number;
  currentDrawdownPercent: number;
}

// --- Real Exchange Data Source Types ---
export type MarketDataSource = "BINANCE_LIVE" | "BYBIT_FALLBACK" | "KRAKEN_FALLBACK" | "SIMULATED";

/** Mode feed pasar real-time: sumber kebenaran harga untuk pipeline & UI. */
export type FeedMode = "WS_LIVE" | "REST_POLL" | "SIMULATED" | "INTERPOLATED";

export interface ExchangeFeedStatus {
  source: MarketDataSource;
  latencyMs: number;
  lastSyncTimestamp: number;
  isLive: boolean;
  activeEndpoint: string;
  /** Level kejujuran harga saat ini (5.2): WS live / REST poll / simulasi / interpolasi. */
  feedMode?: FeedMode;
  /** Price & depth message rate dari SSE (msg/sec). */
  messageRate?: number;
}

// --- On-Chain Analysis Types ---
export interface WhaleTransaction {
  id: string;
  timestamp: number;
  txHash: string;
  amount: number;
  asset: string;
  usdValue: number;
  from: string;
  to: string;
  type: "EXCHANGE_INFLOW" | "EXCHANGE_OUTFLOW" | "WHALE_ACCUMULATION" | "INTERNAL_COLD_STORAGE";
  impact: "BULLISH" | "BEARISH" | "NEUTRAL";
}

export interface OnChainMetrics {
  symbol: string;
  timestamp: number;
  // Exchange Flow
  exchangeNetflow24hUSD: number; // Negative = Outflows (accumulation/bullish), Positive = Inflows (potential sell)
  exchangeReserveChangePercent: number;
  netflowStatus: "STRONG_OUTFLOW_ACCUMULATION" | "MODERATE_OUTFLOW" | "NEUTRAL" | "STRONG_INFLOW_DISTRIBUTION";
  // Whale Activity
  whaleAlerts: WhaleTransaction[];
  whaleConcentrationScore: number; // 0 - 100
  whale7dNetAccumulationUSD: number;
  // Valuation Indicators
  mvrvZScore: number; // < 0.8 undervalued, 1 - 2.5 fair, > 3.8 overvalued/euphoria
  mvrvTerritory: "UNDERVALUED_ACCUMULATION" | "FAIR_VALUE" | "OVERHEATED";
  sopr: number; // Spent Output Profit Ratio (> 1 profit taking, < 1 capitulation)
  soprStatus: "RESET_TO_SUPPORT" | "PROFIT_TAKING" | "CAPITULATION";
  // Network Health
  activeAddresses24h: number;
  activeAddressesGrowth24h: number; // percentage
  // Smart Money Summary
  smartMoneyBias: "STRONG_BULLISH" | "LEAN_BULLISH" | "NEUTRAL" | "LEAN_BEARISH" | "STRONG_BEARISH";
  onChainConfidence: number; // 0 - 100%
  summaryInsight: string;
  /** Ancor real dari blockchain.com (BTC). Ada = nilai real ikut basis simulasi. */
  realData?: BitcoinRealDataSnapshot;
}

/**
 * Snapshot on-chain real dari blockchain.com/explorer (blockchain.info API gratis).
 * Dipakai sebagai "anchor" simulasi: nilai di sini ASLI, turunan lain di
 * OnChainMetrics (netflow/MVRV/SOPR) adalah proyeksi deterministik darinya.
 */
export interface BitcoinRealDataSnapshot {
  source: string;
  fetchedAt: number;
  blockHeight: number;
  priceUSD: number;
  priceChange24hPct: number;
  priceChange7dPct: number;
  txCount24h: number;
  mempoolSizeMB: number;
  mempoolFeesSatVByte: { economy: number; regular: number; priority: number };
  hashrateEH: number;
  supplyBTC: number;
  marketCapUSD: number;
}

// --- Scanner & Probability Types ---
export interface ScannerCandidate {
  symbol: string;
  price: number;
  change24hPct: number;
  volumeUsd24h: number;
  bid: number | null;
  ask: number | null;
  score: number;
  flow: "ACCUMULATION" | "DISTRIBUTION" | "NEUTRAL";
  liquidityUsd: number;
  liquidityDataSource: "ORDERBOOK" | "N/A";
  mtfAlignment: boolean;
}

export type WallAction = "PULLED_SELL_WALL" | "BID_SUPPORT_UP" | "WALL_ADDED" | "NONE";

export interface WallDynamicsVerdict {
  action: WallAction;
  pulledNotionalUsd: number;
  bidSupportShiftBps: number | null;
  detail: string;
  sellWallUsd: number;
  bidWallUsd: number;
}

// --- Macroeconomic Calendar Types ---
export type MacroImpact = "HIGH" | "MEDIUM" | "LOW";

export interface MacroCalendarEvent {
  id: string;
  name: string;
  country: string;
  currency: string;
  timestamp: number;
  timeLabel: string;
  relativeTime: string; // e.g. "Dalam 2 Jam", "Hari Ini", "Kemarin"
  impact: MacroImpact;
  category: "CENTRAL_BANK" | "INFLATION" | "EMPLOYMENT" | "GROWTH" | "SPEECH";
  previous: string;
  forecast: string;
  actual: string | null;
  status: "UPCOMING" | "LIVE" | "COMPLETED";
  hawkishOrDovish: "HAWKISH" | "DOVISH" | "NEUTRAL" | "TBD";
  implicationNotes: string;
  volatilityRisk: "HIGH_ALERT" | "MODERATE" | "LOW";
}

export interface MacroSummary {
  fedPolicyStance: "HAWKISH_PAUSE" | "DOVISH_PIVOT" | "DATA_DEPENDENT";
  upcomingHighImpactCount: number;
  nearestEvent: MacroCalendarEvent | null;
  macroRiskIndex: number; // 0 - 100 (high = avoid risky market orders)
  macroTradingAdvice: string;
  events: MacroCalendarEvent[];
  lastUpdated: number;
}
