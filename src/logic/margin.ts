export type MarginSide = "LONG" | "SHORT";

// ---------------------------------------------------------------------------
// Binance USDT-M Futures — tiered maintenance margin (verified 2026-09-10)
// Tier-1 (BTC notional 0–2,000,000 USDT): MMR 0.4%, cushion 0.
// Paper sizes are ALWAYS tier-1 (notional « 2M), so the training engine uses
// MMR 0.4%. The old 0.005 was close but slightly conservative.
// Positions that ever exceed the tier-1 cap keep tier-1 liquidations so the
// replay book fails closed deterministically instead of guessing unknown
// symbol brackets.
// ---------------------------------------------------------------------------
export const MAINTENANCE_MARGIN_RATE = 0.004;
export const TIER1_NOTIONAL_CAP_USD = 2_000_000;
export const MAX_LEVERAGE = 50;

export function clampLeverage(leverage: number): number {
  if (!Number.isFinite(leverage) || leverage <= 0) return 1;
  return Math.min(leverage, MAX_LEVERAGE);
}

export function liquidationPrice(entryPrice: number, leverage: number, side: MarginSide): number {
  const lev = clampLeverage(leverage);
  const rate = side === "LONG" ? 1 - 1 / lev + MAINTENANCE_MARGIN_RATE : 1 + 1 / lev - MAINTENANCE_MARGIN_RATE;
  return Number((entryPrice * rate).toFixed(6));
}

export function calculateMargin(notional: number, leverage: number): number {
  return Number((notional / clampLeverage(leverage)).toFixed(2));
}

export function calculateEquity(cash: number, lockedMargin: number, unrealizedPnl: number): number {
  return Number((cash + lockedMargin + unrealizedPnl).toFixed(2));
}