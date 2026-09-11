export type PaperSide = "LONG" | "SHORT";
export type PaperPositionStatus = "OPEN" | "CLOSED";
export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL" | "LIQUIDATED";
export type PaperOrderStatus = "NEW" | "PARTIALLY_FILLED" | "FILLED" | "REJECTED" | "CANCELLED";
export type PaperEventType =
  | "ORDER_FILLED"
  | "POSITION_CLOSED"
  | "BRACKET_MONITOR_ACTION"
  | "POSITION_UPDATED"
  | "ORDER_NEW"
  | "ORDER_PARTIAL"
  | "ORDER_REJECTED"
  | "ORDER_CANCELLED"
  | "ERROR";

export interface PaperPosition {
  id: string;
  symbol: string;
  side: PaperSide;
  qty: number;
  entryPrice: number;
  notionalUSD: number;
  leverage: number;
  marginUSD: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  maintenanceMarginRate: number;
  openedAt: number;
  status: PaperPositionStatus;
  entryReasoning?: string;
  confidence?: number;
  timeframe?: string;
  marketType?: string;
  targetPool?: string;
  sourceOrderId: string;
  lastMark?: number;
  lastMarkUpdatedAt?: number;
  closedAt?: number;
  exitPrice?: number;
  exitReason?: ExitReason;
  realizedPnlUSD?: number;
  feesPaidUSD: number;
}

export interface PaperOrderReceipt {
  id: string;
  mode: "paper";
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  fillPrice?: number;
  slippageBps?: number;
  feeUSD: number;
  qty: number;
  notional?: number;
  limitPrice?: number;
  leverage?: number;
  marginRequired?: number;
  executionLatencyMs?: number;
  timestamp: number;
  status: PaperOrderStatus;
  positionId?: string;
  reason?: string;
  signature: string;
  payloadHash: string;
  // Lifecycle timestamps
  submittedAt?: number;
  filledAt?: number;
  cancelledAt?: number;
  // For partial fills
  filledQty?: number;
  remainingQty?: number;
  stopLoss?: number;
  takeProfit?: number;
  meta?: PaperOrderMeta;
}

export interface PaperEvent {
  seq: number;
  timestamp: number;
  type: PaperEventType;
  payload: Record<string, unknown>;
}

export interface PaperAccountSnapshot {
  cash: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openCount: number;
  marginLocked: number;
}

export interface PaperBalanceEntry {
  currency: string;
  free: number;
  used: number;
  total: number;
}

export interface PaperOrderMeta {
  reasoning?: string;
  confidence?: number;
  timeframe?: string;
  marketType?: string;
  targetPool?: string;
  /** AI decision id yang memicu order (untuk training join decision → fill). */
  decisionId?: string;
}

export interface OpenPaperPositionInput {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  leverage?: number;
  stopLoss?: number;
  takeProfit?: number;
  orderType?: "market" | "limit";
  limitPrice?: number;
  /**
   * Versi 2026-09-10: order yang orderbook depth-nya tidak cukup untuk full
   * qty difill PARSIAL — tidak lagi all-or-nothing. JANGAN pernah simulasikan
   * partial di client; seluruh state (NEW → PARTIALLY_FILLED → FILLED) hanya
   * diproduksi di sini dan disiarkan lewat ORDER_PARTIAL / ORDER_FILLED.
   */
  allowPartialFill?: boolean;
  meta?: PaperOrderMeta;
}

export interface OpenPaperPositionResult {
  position: PaperPosition;
  order: PaperOrderReceipt;
  account: PaperAccountSnapshot;
}

export interface ClosePaperPositionResult {
  position: PaperPosition;
  order: PaperOrderReceipt;
  realizedPnlUSD: number;
  cashAfter: number;
  exitFillPrice: number;
  exitSlippageBps: number;
  exitFeeUSD: number;
  exitReason: ExitReason;
}

export interface UpdatePaperPositionInput {
  stopLoss?: number;
  takeProfit?: number;
  breakEven?: boolean;
}

export interface FillResult {
  fillPrice: number;
  slippageBps: number;
  feeUSD: number;
  method: "ORDERBOOK" | "TICKER" | "LIQUIDATION";
  latencyMs: number;
  /** Qty yang benar-benar bisa didukung orderbook top-20 (sisa = partial). */
  filledQty: number;
  /** Qty yang tidak kebagian depth (0 = full fill). */
  unfilledQty: number;
}
