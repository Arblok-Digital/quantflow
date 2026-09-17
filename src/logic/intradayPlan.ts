export const INTRADAY_MAX_HOLD_MS = 86_400_000;
export const ADVISOR_PLAN_TTL_MS = 15 * 60_000;

export interface IntradayDraft {
  symbol: string;
  marketType: string;
  side: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  createdAt: number;
}

/** Strict, no fabricated prices. Draft creation never executes an order. */
export function makeIntradayDraft(symbol: string, marketType: string, bias: unknown, levels: unknown, createdAt: number, now = Date.now()): IntradayDraft | null {
  if (!symbol || !Number.isFinite(createdAt) || createdAt > now || now - createdAt > ADVISOR_PLAN_TTL_MS) return null;
  const side = bias === "LONG" || bias === "BULLISH" ? "LONG" : bias === "SHORT" || bias === "BEARISH" ? "SHORT" : null;
  if (!side || (marketType === "SPOT" && side === "SHORT") || !levels || typeof levels !== "object") return null;
  const { entry, stopLoss, takeProfit } = levels as Record<string, unknown>;
  if (![entry, stopLoss, takeProfit].every(v => typeof v === "number" && Number.isFinite(v) && v > 0)) return null;
  const e = entry as number, sl = stopLoss as number, tp = takeProfit as number;
  if (!(side === "LONG" ? sl < e && e < tp : tp < e && e < sl)) return null;
  return { symbol, marketType, side, entry: e, stopLoss: sl, takeProfit: tp, createdAt };
}

export function formatDeadlineWib(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(timestamp) + " WIB";
}
