/**
 * Data source strategy registry.
 *
 * Domain data modules (market / on-chain / macro) resolve their backing source
 * through this registry instead of hardcoding simulated vs live. Swapping mock
 * data for a real API later only requires:
 *   1. implement the live adapter inside src/data/<domain>Data.ts
 *   2. flip the mode per feature via `setDataSourceMode`
 * Consumers (hooks / components / server) never change.
 */
export type DataSourceMode = "simulated" | "live";
export type DataFeature = "onChain" | "macro";

const modes: Record<DataFeature, DataSourceMode> = {
  onChain: "simulated",
  macro: "simulated",
};

export function getDataSourceMode(feature: DataFeature): DataSourceMode {
  return modes[feature];
}

export function setDataSourceMode(feature: DataFeature, mode: DataSourceMode): void {
  modes[feature] = mode;
}