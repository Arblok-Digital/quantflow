import { Candle, Position, Timeframe } from "../types";
import { calculateATR, getTimeframeIntervalMs } from "./indicators";

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
  /** ATR yang dipakai (USD per candle TF entry). */
  atr: number | null;
  /** Sisi mana yang lebih dekat dalam satuan candle (bukan USD). */
  nearer: "TP" | "CL" | null;
}

const DRIFT_FACTOR = 0.5;

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
  candles: Candle[]
): PositionEta {
  const empty: PositionEta = {
    tpCandles: null, clCandles: null, tpDurasi: null, clDurasi: null, atr: null, nearer: null,
  };
  if (!pos || !currentPrice || currentPrice <= 0) return empty;
  // TF entry posisi (kunci permanen dari server), fallback 15m untuk posisi lama.
  const tf = (pos.timeframe as Timeframe) || "15m";
  const intervalMs = getTimeframeIntervalMs(tf);
  // ATR butuh ≥2 candle; bila kosong (TF belum di-load) → null jujur.
  if (!candles || candles.length < 2) return empty;
  const atr = calculateATR(candles, 14);
  if (!isFinite(atr) || atr <= 0) return empty;
  const step = atr * DRIFT_FACTOR;
  if (step <= 0) return empty;

  const distTP = Math.abs(pos.takeProfit - currentPrice);
  const distCL = Math.abs(currentPrice - pos.stopLoss);
  if (distTP <= 0 || distCL <= 0) return { ...empty, atr };

  const tpCandles = Math.max(1, Math.ceil(distTP / step));
  const clCandles = Math.max(1, Math.ceil(distCL / step));
  return {
    tpCandles,
    clCandles,
    tpDurasi: formatDurasi(tpCandles * intervalMs),
    clDurasi: formatDurasi(clCandles * intervalMs),
    atr,
    nearer: tpCandles < clCandles ? "TP" : clCandles < tpCandles ? "CL" : null,
  };
}
