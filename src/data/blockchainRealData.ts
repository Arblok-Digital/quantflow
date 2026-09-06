import { BitcoinRealDataSnapshot } from "../types";

/**
 * Real on-chain snapshot (blockchain.com/explorer — blockchain.info API gratis).
 *
 * Disimpan di modul cache. `fetchOnChainMetrics` membacanya via
 * `getBitcoinOnChainSnapshot()` untuk meng-*anchor* simulasi ke data asli.
 * Fat-fungsi ini TIDAK pernah melempar (graceful fallback ke simulasi murni).
 */

let cachedSnapshot: BitcoinRealDataSnapshot | null = null;

export function getBitcoinOnChainSnapshot(): BitcoinRealDataSnapshot | null {
  return cachedSnapshot;
}

function toSnapshot(data: any): BitcoinRealDataSnapshot | null {
  if (!data || typeof data !== "object" || !data.fetchedAt || !data.priceUSD) return null;
  return {
    source: String(data.source || "blockchain.com/explorer"),
    fetchedAt: Number(data.fetchedAt),
    blockHeight: Number(data.blockHeight) || 0,
    priceUSD: Number(data.priceUSD),
    priceChange24hPct: Number(data.priceChange24hPct) || 0,
    priceChange7dPct: Number(data.priceChange7dPct) || 0,
    txCount24h: Number(data.txCount24h) || 0,
    mempoolSizeMB: Number(data.mempoolSizeMB) || 0,
    mempoolFeesSatVByte: {
      economy: Number(data.mempoolFeesSatVByte?.economy) || 0,
      regular: Number(data.mempoolFeesSatVByte?.regular) || 0,
      priority: Number(data.mempoolFeesSatVByte?.priority) || 0,
    },
    hashrateEH: Number(data.hashrateEH) || 0,
    supplyBTC: Number(data.supplyBTC) || 0,
    marketCapUSD: Number(data.marketCapUSD) || 0,
  };
}

export async function refreshOnChainRealData(): Promise<boolean> {
  try {
    const res = await fetch("/api/onchain/bitcoin", { cache: "no-store" });
    if (!res.ok) {
      cachedSnapshot = null;
      return false;
    }
    const data = await res.json();
    const snapshot = toSnapshot(data);
    if (!snapshot) {
      cachedSnapshot = null;
      return false;
    }
    cachedSnapshot = snapshot;
    return true;
  } catch (err) {
    cachedSnapshot = null;
    return false;
  }
}