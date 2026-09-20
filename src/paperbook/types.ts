export type PaperSide = "LONG" | "SHORT";
export type PaperPositionStatus = "OPEN" | "CLOSING" | "CLOSED";
export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL" | "LIQUIDATED" | "PARTIAL_TAKE_PROFIT" | "TIMEOUT";
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
  | "POSITION_PARTIAL_CLOSED"
  | "EXIT_ENGINE_ACTION"
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
  /**
   * F3 — Exit plan opt-in (BE otomatis / trailing / partial TP / time-stop).
   * TIDAK ADA pada posisi lama → engine tidak pernah menyentuh posisi yang
   * sudah open sampai exit plan dipasang eksplisit (API/panel).
   */
  exitPlan?: PositionExitPlan;
  entryReasoning?: string;
  confidence?: number;
  timeframe?: string;
  marketType?: string;
  targetPool?: string;
  /** MANUAL (klik panel) | AUTOPILOT (pipeline) | REPLAY — untuk split statistik journal. */
  entrySource?: string;
  /** Decision trace id dari order.meta.decisionId — join decision → fill (F-08/P1). */
  decisionId?: string;
  sourceOrderId: string;
  lastMark?: number;
  lastMarkUpdatedAt?: number;
  closedAt?: number;
  exitPrice?: number;
  exitReason?: ExitReason;
  realizedPnlUSD?: number;
  feesPaidUSD: number;
  /**
   * P0-05 — qty ASAL saat posisi dibuka (SEBELUM partial). Tidak pernah
   * berubah. Statistik R dan journal memakai ini sebagai ukuran trade
   * (risk = |entry−SL| × openQty), bukan qty sisa yang menyusut tiap partial.
   */
  openQty?: number;
  /**
   * P0-05 — fee KUMULATIF seumur hidup posisi (entry + seluruh exit fills).
   * Identity: `feesTotalUSD ≡ Σ fills.fee_usd` posisi tsb (via orders.position_id).
   * BEDA dari feesPaidUSD: yang itu fee entry yang masih menempel pada SISA
   * qty (di-consume tiap partial, dipakai BE) — BUKAN seluruh fee historis.
   */
  feesTotalUSD?: number;
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
  /** F9: margin tercadang order limit NEW — bagian equity, bukan loss. */
  reservedMargin: number;
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
  /** MANUAL | AUTOPILOT | REPLAY — asal entry, diteruskan ke posisi + DB. */
  entrySource?: string;
  /**
   * Idempotency key dari FE (satu nilai per klik order). Request ulang dengan
   * clientOrderId sama → receipt yang sama, TIDAK membuka posisi kedua.
   */
  clientOrderId?: string;
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
  /** F3: true bila ini partial close (posisi tetap OPEN, qty berkurang). */
  partial?: boolean;
  /** F3: sisa qty setelah partial close. */
  remainingQty?: number;
}

// ---------------------------------------------------------------------------
// F3 — Exit engine (opt-in per posisi): BE otomatis, trailing, partial TP, time-stop
// ---------------------------------------------------------------------------
export interface PositionExitPartialLevel {
  /** Level R (× risiko awal per unit) yang memicu partial close. */
  rMultiple: number;
  /** % dari qty SAAT TRIGGER yang ditutup di level ini (1–100). */
  closePct: number;
}

export interface PositionExitConfig {
  /** Auto break-even: SL digeser ke entry±offset begitu profit ≥ triggerR × risiko awal. */
  breakEvenTriggerR?: number;
  /** Offset BE dari entry sebagai fraksi harga (default 0.0008 ≈ 2× taker fee + buffer). */
  breakEvenOffsetPct?: number;
  /** Trailing chandelier sederhana: SL mengikuti puncak − trailingPct% harga. */
  trailingPct?: number;
  /** Tangga partial TP berbasis R (naik, tiap level dieksekusi sekali). */
  partialLevels?: PositionExitPartialLevel[];
  /** Time stop: tutup penuh setelah posisi berumur ≥ maxHoldMs. */
  maxHoldMs?: number;
}

export interface PositionExitState {
  deadlineAttempt?: { status: "FAILED" | "PARTIAL" | "CLOSED"; attemptedAt: number; message?: string };

  /** Risiko awal per unit ($/unit) = |entry − SL saat plan dipasang| — anchor R. */
  initialRiskPerUnit: number;
  breakevenArmed?: boolean;
  /** Level R partial yang sudah dieksekusi (tidak diulang). */
  takenPartialR?: number[];
  /** Puncak harga favorable sejak open — di-track monitor (persist ikut event tulis). */
  peakMark?: number;
}

export interface PositionExitPlan {
  config: PositionExitConfig;
  state: PositionExitState;
}

export interface UpdatePaperPositionInput {
  stopLoss?: number;
  takeProfit?: number;
  breakEven?: boolean;
  /**
   * F3: pasang/ubah/hapus exit plan. `undefined` = tidak mengubah;
   * `null` = hapus plan (kembali SL/TP statis murni); objek = pasang
   * (divalidasi + di-clamp oleh normalizeExitConfig()).
   */
  exitConfig?: PositionExitConfig | null;
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
