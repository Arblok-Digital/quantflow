/**
 * src/lib/sideNormalize.ts
 * Side normalization shared helper — exchange positions report sides as
 * "buy"/"sell" (ccxt) while the paper book reports "LONG"/"SHORT". All position
 * side badges in the UI must be consistent uppercase LONG/SHORT.
 */

export type NormalizedSide = "LONG" | "SHORT";

/**
 * Normalize any side representation ("buy", "long", "LONG", "Buy", "sell",
 * "short", undefined, ...) to a canonical "LONG" | "SHORT". Anything that is
 * not buy/long falls back to SHORT (fail-safe: shorts are the conservative
 * default for an unknown direction).
 */
export function normalizeSide(side: unknown): NormalizedSide {
  const s = String(side ?? "").toLowerCase();
  return s === "buy" || s === "long" ? "LONG" : "SHORT";
}

export default normalizeSide;