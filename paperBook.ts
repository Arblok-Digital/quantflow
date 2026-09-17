/**
 * paperBook.ts — barrel re-export.
 * Logika bracket monitor & mark price refresh sudah dipindah ke src/paperbook/bracketMonitor.ts & markCache.ts.
 * File ini dipertahankan karena server.ts & consumer lain mengimpor dari "./paperBook" (root).
 */
import { getDbFilePath } from "./src/db/persistence";

export { updatePaperMarkCache } from "./src/paperbook/markCache";
export { signPayload, liquidationPrice, liquidationPriceWithFunding, openPaperPosition, closePaperPosition } from "./src/paperbook/fill";
export { startBracketMonitor, stopBracketMonitor, runBracketMonitorPass } from "./src/paperbook/bracketMonitor";
export { refreshPaperMarks, fetchMarkTicker } from "./src/paperbook/bracketMonitor";

export type {
  PaperSide, PaperPosition, PaperOrderReceipt, PaperAccountSnapshot, PaperBalanceEntry, PaperOrderMeta,
  OpenPaperPositionInput, OpenPaperPositionResult, ClosePaperPositionResult, ExitReason, FillResult,
  UpdatePaperPositionInput, PaperPositionStatus, PaperOrderStatus, PaperEventType,
  PositionExitConfig, PositionExitState, PositionExitPlan, PositionExitPartialLevel,
} from "./src/paperbook/types";

export {
  TAKER_FEE_RATE, MAKER_FEE_RATE, MAINTENANCE_MARGIN_RATE, MAX_LEVERAGE, ORDERBOOK_LEVELS,
  ERROR_LOG_THROTTLE_MS, EXCHANGE_LATENCY_MS_MIN, EXCHANGE_LATENCY_MS_MAX, MARK_TTL_MS,
  INITIAL_PAPER_CASH, EVENT_RING_SIZE,
} from "./src/paperbook/config";
export { PaperOrderError } from "./src/paperbook/errors";
export {
  initPaperBook, getPaperPositions, getPaperOrder, getPaperOrders, getPaperEvents,
  getLatestEventSeq, getPaperAccount, getPaperBalance, normalizeSymbol,
  updatePaperPosition, cancelPaperOrder, freshState, persistSnapshot, dbSavePosition, dbSaveOrder,
  persistSnapshotTolerant, dbSavePositionTolerant, dbSaveOrderTolerant, deriveIdSeqFromRows,
  appendEvent, newId, unrealizedPnlFor, state, bookInitialized,
} from "./src/paperbook/store";
export type { PaperBookState } from "./src/paperbook/store";
export function getBookFilePath(): string {
  try {
    return getDbFilePath();
  } catch {
    return "trading.db";
  }
}