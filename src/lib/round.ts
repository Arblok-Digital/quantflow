/**
 * Pembulatan angka sadar-tanda — SATU implementasi untuk seluruh codebase
 * (paperbook fill/store/bracket, replay, dst).
 *
 * Mengapa epsilon bertanda: `Math.round((n + Number.EPSILON) * f)` bias ke nol
 * untuk nilai negatif — contoh -0.005 → -0.0 (kerugian/aksi terlihat lebih kecil
 * dari sebenarnya). Epsilon arah NEGATIF untuk n<0 membatalkan bias itu:
 *   roundTo(-0.005, 2) → -0.01 dan roundTo(+0.005, 2) → +0.01 (simetris).
 *
 * CATATAN float: pada ambang `.5` eksak hasil tidak deterministic secara bit —
 * representasi IEEE 754 bisa berada sedikit di atas/berada di bawah ambang.
 * Properti yang dijamin = hilangnya bias tanda untuk nilai non-konfliktual.
 *  - -0.005 → -0.01 ; +0.005 → +0.01
 *  - -50.784 → -50.78 ; +50.784 → +50.78
 */
export function roundTo(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  const eps = n < 0 ? -Number.EPSILON : Number.EPSILON;
  return Math.round(n * f + eps) / f;
}

export const r2 = (n: number) => roundTo(Number(n), 2);
export const r3 = (n: number) => roundTo(Number(n), 3);
export const r4 = (n: number) => roundTo(Number(n), 4);
export const r6 = (n: number) => roundTo(Number(n), 6);
export const r8 = (n: number) => roundTo(Number(n), 8);