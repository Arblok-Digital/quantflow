/** Prompt data formatting: missing/invalid input is not a neutral market observation. */
export function promptNumber(value: unknown, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value}${suffix}`
    : "No data";
}

export function liquidityPoolContext(zone: unknown): string {
  const z = zone && typeof zone === "object" ? zone as Record<string, unknown> : {};
  const price = typeof z.midPrice === "number" && z.midPrice > 0
    ? promptNumber(z.midPrice)
    : "No data";
  const depth = typeof z.estimatedVolumeUSD === "number" && z.estimatedVolumeUSD >= 0
    ? promptNumber(z.estimatedVolumeUSD, "M USD")
    : "No data";
  return `zone price: ${price}; resting depth estimate: ${depth} (client-supplied, provenance unverified; NOT measured stop/liquidation volume)`;
}

/**
 * Current on-chain facade only supplies synthetic/real-anchored projections.
 * A realData anchor is network telemetry, NOT proof of netflow, SOPR, MVRV,
 * whale identity, or smart-money direction. No verified analytics adapter exists
 * here yet: exclude these values entirely, even if a client sends source=REAL.
 * Network telemetry remains available in its dedicated UI/endpoint.
 */
export function onChainDecisionContext(raw: unknown): string {
  const supplied = raw != null && typeof raw === "object";
  const anchored = supplied && !!(raw as Record<string, unknown>).realData;
  const provenance = !supplied ? "MISSING" : anchored ? "REAL_ANCHORED_PROJECTIONS" : "UNVERIFIED_OR_SIMULATED";
  return `[ON-CHAIN DATA POLICY: ${provenance}]\n` +
    "Netflow, MVRV, SOPR, whale alerts, active-address growth and smart-money bias: No data — excluded from decisions (no verified analytics provider).\n" +
    "A real network anchor does not validate derived analytics. On-chain directional weight must be ZERO; do not infer missing values.";
}
