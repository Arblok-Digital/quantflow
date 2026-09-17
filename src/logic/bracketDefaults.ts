import type { Timeframe } from "../types";

/**
 * bracketDefaults — default SL%/TP% panel entry & fallback server-side,
 * diskala ke TF entry (bukan satu angka untuk semua TF).
 *
 * Rasional: default lama 1.5%/3.5% dipilih dari ATR H4 (~1.5-2%+) — benar
 * untuk SWING/4h, tapi tidak koheren untuk eksekusi 15m (TP 3.5% ≈ 17-25×
 * ATR 15m → butuh hari-minggu sementara thesis liquidity hunt 15m mati
 * dalam hitungan jam). TF intraday pakai skala rMultiple 1.5 (selaras
 * SCALP config: minTpPct 0.9).
 */
export interface BracketDefaults {
  slPct: number;
  tpPct: number;
}

export function bracketDefaultsForTf(tf: Timeframe | string | undefined | null): BracketDefaults {
  const t = String(tf ?? "").toUpperCase();
  if (t === "4H" || t === "1D" || t === "1W") return { slPct: 1.5, tpPct: 3.5 };
  return { slPct: 0.8, tpPct: 1.2 };
}
