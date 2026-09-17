import type { Candle, Position } from "../types";
import { calculateATR } from "./indicators";

// ---------------------------------------------------------------------------
// positionEta — estimasi JUMLAH CANDLE + DURASI dari harga sekarang ke TP/CL.
// Client-side (sesuai keputusan): dihitung di FE dari candle + ATR yang sudah
// ada, tanpa ubah server. Dilabel ESTIMASI — bukan prediksi, hanya menjawab
// "dengan volatilitas sekarang, butuh berapa candle untuk sampai TP/CL".
//
// Rumus: estCandles = jarakHarga / (ATR per candle × driftFactor).
// driftFactor 0.5 = asumsi harga bergerak searah hanya separuh ATR per candle
// (konservatif; harga nyata zig-zag). Hasil dibulatkan ke atas, min 1.
// Durasi = estCandles × interval TF entry posisi (bukan TF chart yang sedang
// dilihat — posisi dikunci ke TF entry-nya).
// ---------------------------------------------------------------------------

export interface PositionEta {
  /** Estimasi candle ke TP (arah profit). null bila tak bisa dihitung. */
  tpCandles: number | null;
  /** Estimasi candle ke CL (arah rugi). null bila tak bisa dihitung. */
  clCandles: number | null;
  /** Durasi manusiawi ke TP, mis. "±2j 15m". null bila tpCandles null. */
  tpDurasi: string | null;
  /** Durasi manusiawi ke CL. null bila clCandles null. */
  clDurasi: string | null;
  /** ATR yang dipakai (USD per candle dari series yang diberikan). */
  atr: number | null;
  /** Sisi mana yang lebih dekat dalam satuan candle (bukan USD). */
  nearer: "TP" | "CL" | null;
  /** true bila TP butuh > horizon wajar (>48 candle) — setup dianggap stale. */
  tpBeyondHorizon: boolean;
  /** Interval aktual (ms) yang dipakai untuk durasi — median delta timestamp
   *  candle, BUKAN asumsi TF entry. Menjamin ATR & durasi satu TF. */
  intervalMs: number | null;
}

const DRIFT_FACTOR = 0.5;
/** Horizon wajar thesis intraday dalam satuan candle TF entry. */
export const ETA_HORIZON_BARS = 48;

export function formatDurasi(totalMs: number): string {
  if (!isFinite(totalMs) || totalMs < 0) return "—";
  const mins = Math.round(totalMs / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `±${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem > 0 ? `±${hrs}j ${rem}m` : `±${hrs}j`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `±${days}h ${rh}j` : `±${days}h`;
}

export function estimatePositionEta(
  pos: Position,
  currentPrice: number,
  candles: Candle[],
  intervalMsOverride?: number
): PositionEta {
  const empty: PositionEta = {
    tpCandles: null, clCandles: null, tpDurasi: null, clDurasi: null, atr: null, nearer: null,
    tpBeyondHorizon: false, intervalMs: null,
  };
  if (!pos || !currentPrice || currentPrice <= 0) return empty;
  // ATR butuh ≥2 candle; bila kosong (TF belum di-load) → null jujur.
  if (!candles || candles.length < 2) return empty;
  const atr = calculateATR(candles, 14);
  if (!isFinite(atr) || atr <= 0) return empty;
  const step = atr * DRIFT_FACTOR;
  if (step <= 0) return empty;

  // P-A FIX: interval durasi = median delta timestamp candle yang dipakai
  // untuk ATR — BUKAN asumsi TF entry posisi (pos.timeframe). Sebelumnya:
  // ATR dihitung dari candle chart aktif (bisa 1s/microtick, ATR $5-15)
  // tapi durasi dikali interval TF entry 15m → error 60-900× ("±200j").
  // Override eksplisit (mis. interval TF entry bila caller menjamin candle
  // satu TF dengan posisi) tetap didukung untuk kompatibilitas.
  const intervalMs = intervalMsOverride != null && isFinite(intervalMsOverride) && intervalMsOverride > 0
    ? intervalMsOverride
    : inferIntervalMs(candles);
  if (intervalMs == null) return { ...empty, atr };

  const distTP = Math.abs(pos.takeProfit - currentPrice);
  const distCL = Math.abs(currentPrice - pos.stopLoss);
  if (distTP <= 0 || distCL <= 0) return { ...empty, atr, intervalMs };

  const tpCandles = Math.max(1, Math.ceil(distTP / step));
  const clCandles = Math.max(1, Math.ceil(distCL / step));
  const tpBeyondHorizon = tpCandles > ETA_HORIZON_BARS;
  return {
    tpCandles,
    clCandles,
    tpDurasi: formatDurasi(tpCandles * intervalMs),
    clDurasi: formatDurasi(clCandles * intervalMs),
    atr,
    nearer: tpCandles < clCandles ? "TP" : clCandles < tpCandles ? "CL" : null,
    tpBeyondHorizon,
    intervalMs,
  };
}

/**
 * Median delta timestamp antar candle berurutan (ms). Median — bukan mean —
 * agar satu gap libur/weekend tidak menggeser seluruh estimasi. null bila
 * <2 delta valid (timestamp duplikat/rusak semua).
 */
export function inferIntervalMs(candles: Candle[]): number | null {
  if (!candles || candles.length < 2) return null;
  const deltas: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const d = Number(candles[i]!.timestamp) - Number(candles[i - 1]!.timestamp);
    if (isFinite(d) && d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 1
    ? deltas[mid]!
    : Math.round((deltas[mid - 1]! + deltas[mid]!) / 2);
}
