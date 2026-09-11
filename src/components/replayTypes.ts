// ---------------------------------------------------------------------------
// Shared types for ReplayControlPanel sub-components.
// ---------------------------------------------------------------------------

export interface ReplayCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ReplayPosition {
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

export interface ReplayOrder {
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

export interface ReplayTrade {
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

export interface ReplayEvent {
  seq: number;
  timestamp: number;
  candleIndex: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface ReplaySession {
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

export const fmtMoney = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtNum = (n: number): string =>
  n.toLocaleString("en-US", { maximumFractionDigits: 4 });
