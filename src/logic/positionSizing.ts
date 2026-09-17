/**
 * Sizing satu satuan (F2 — audit sizing).
 *
 * Sebelum F2 ada TIGA sumber sizing yang saling bertentangan:
 *  1. `entry-risk-engine` menghitung ukuran dari risiko (risk% / stop%) lalu
 *     meng-clamp hasilnya ke band 2–5% — sizing berbasis risiko SELALU ditimpa:
 *     untuk SL < 10% raw > 5% → dipaksa 5%, dan lantai 2% memaksa oversize
 *     melewati target risiko saat SL sangat lebar.
 *  2. `keelAdapter` hardcode `positionSizePercent: 5` — output engine dibuang.
 *  3. FE `sizePct` = notional % equity, tapi tooltip menyebut "margin" —
 *     operator mengira size 12% × lev 10 = margin, padahal notional.
 *
 * Satuan resmi (satu-satunya): **% equity sebagai NOTIONAL posisi** — identik
 * dengan satuan pre-trade risk gate (risiko riil = jarak SL × notional).
 * Margin = notional / leverage; leverage tidak mengubah risiko per 1%
 * pergerakan harga, jadi sizing TIDAK bergantung leverage.
 *
 * Formula risk-targeted (dipakai engine Keel):
 *   raw     = executionMultiplier × (riskTargetPct / stopDistancePct) × 100
 *   sizePct = clamp(floor1dp(raw), minNotionalPct, maxNotionalPct)
 *
 * Invarian yang DIJAMIN (lihat positionSizing.test.ts):
 *   sizePct × stopDistancePct / 100 ≤ riskTargetPct
 * Pembulatan dilakukan KE BAWAH 1 desimal supaya pembulatan tidak pernah
 * melanggar invarian di ambang batas (pelajaran F1: RR 1.4999999… < 1.5).
 */

/** Lantai bawah notional (% equity) — cegah size 0 akibat pembulatan/SL ekstrem. */
export const DEFAULT_MIN_NOTIONAL_PCT = 0.1;
/** Fallback notional bila jarak SL tidak valid (perilaku legacy engine lama). */
export const MISSING_STOP_FALLBACK_PCT = 3;

export interface RiskTargetedSizeInput {
  /** Target risiko per trade (% equity) = jarak SL × notional. */
  riskTargetPct: number;
  /** Jarak SL dari entry (% harga, positif). */
  stopDistancePct: number;
  /** Cap notional (% equity). */
  maxNotionalPct: number;
  /** Multiplier eksekusi macro/session (0..1; di luar rentang di-clamp). */
  executionMultiplier?: number;
  /** Lantai bawah notional (% equity). Default 0.1. */
  minNotionalPct?: number;
}

export interface RiskTargetedSize {
  /** Ukuran posisi: % equity sebagai NOTIONAL (bukan margin). */
  sizePct: number;
  /** Risiko efektif = sizePct × stopDistancePct / 100 (% equity). 0 bila stop tak valid. */
  riskEffectivePct: number;
  /** true bila size dipotong oleh cap notional (SL ketat). */
  capped: boolean;
}

/** Floor ke 1 desimal — selalu ke bawah, tidak pernah ke atas. */
function floor1dp(n: number): number {
  return Math.floor(n * 10 + 1e-9) / 10;
}

export function riskTargetedSizePct(input: RiskTargetedSizeInput): RiskTargetedSize {
  const cap =
    Number.isFinite(input.maxNotionalPct) && input.maxNotionalPct > 0
      ? input.maxNotionalPct
      : DEFAULT_MIN_NOTIONAL_PCT;
  const min = Math.max(0, Math.min(input.minNotionalPct ?? DEFAULT_MIN_NOTIONAL_PCT, cap));
  const mult = Math.max(0, Math.min(1, input.executionMultiplier ?? 1));
  const stop = input.stopDistancePct;
  const stopUsable = stop > 0 && Number.isFinite(stop);

  let raw = stopUsable ? (input.riskTargetPct / stop) * 100 : MISSING_STOP_FALLBACK_PCT;
  raw = Math.max(0, raw) * mult;

  const rawCapped = Math.min(cap, raw);
  const sizePct = Math.max(min, floor1dp(rawCapped));
  return {
    sizePct,
    riskEffectivePct: stopUsable ? Number(((sizePct * stop) / 100).toFixed(4)) : 0,
    capped: raw > cap,
  };
}