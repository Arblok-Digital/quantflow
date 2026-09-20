/**
 * Single source of truth policy risiko DEFAULT lintas lapisan.
 * Dipakai oleh:
 *  - server risk gate (`orderRiskGate.ts` — defaultOrderRiskPolicy)
 *  - panel FE (`src/App.tsx` — RiskConfig awal RiskManagementPanel)
 *  - keel (`src/logic/keel/config.ts` RISK_CONSTANTS = policy institusional sendiri;
 *    keelAdapter membaca dari RISK_CONSTANTS, bukan literal baru)
 *
 * Auditor WARN-1: sebelum file ini ada, nilai default terpisah di 3 tempat
 * (orderRiskGate 1%/25%/1.5, FE 2%/12%/1.8, keelAdapter 5% hardcode). Server
 * masih bisa di-override env (RISK_MAX_PER_TRADE_PCT dll) — konstanta ini hanya
 * memastikan DEFAULT konsisten; env hanya boleh memperketat, bukan melonggarkan
 * (validasi nilai dibaca memakai env positive-check).
 */
export const DEFAULT_RISK_POLICY = {
  /** Risiko maks per trade = (jarak SL × notional) sebagai % equity. */
  MAX_RISK_PER_TRADE_PCT: 1.0,
  /** Notional maksimum per posisi sebagai % equity. */
  MAX_NOTIONAL_PCT: 25,
  /** R:R minimum (reward / risk). */
  MIN_RISK_REWARD_RATIO: 1.5,
} as const;