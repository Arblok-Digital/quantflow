export type MarginSide = "LONG" | "SHORT";

export const MAINTENANCE_MARGIN_RATE = 0.005;
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