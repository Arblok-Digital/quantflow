import { OnChainMetrics } from "../types";
import { generateOnChainMetrics, generateRealAnchoredOnChainMetrics } from "../logic/onchain";
import { getDataSourceMode } from "./provider";
import { getBitcoinOnChainSnapshot } from "./blockchainRealData";

/**
 * On-Chain analytics data facade.
 *
 * Mode default "simulated" = simulasi, TAPI jika snapshot real blockchain.com
 * tersedia (lihat refreshOnChainRealData) dan asset BTC, hasil yang dikembalikan
 * di-anchor ke data asli (generateRealAnchoredOnChainMetrics) — simulasi base
 * on real data.
 *
 * Untuk swap penuh ke provider live lain (Glassnode/CryptoQuant), implement
 * adaptor di bawah ini lalu flip `setDataSourceMode("onChain", "live")`.
 */
export function fetchOnChainMetrics(symbol: string, price: number): OnChainMetrics {
  const asset = symbol.split("/")[0]?.toUpperCase() || "BTC";

  if (getDataSourceMode("onChain") === "live") {
    console.warn("[data] on-chain mode 'live' dipilih tapi provider penuh belum diimplementasikan — pakai simulated/real-anchored.");
  }

  if (asset === "BTC") {
    const snapshot = getBitcoinOnChainSnapshot();
    if (snapshot) {
      return generateRealAnchoredOnChainMetrics(symbol, price, snapshot);
    }
  }

  return generateOnChainMetrics(symbol, price);
}