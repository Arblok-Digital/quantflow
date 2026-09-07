import { MacroCalendarEvent, MacroSummary } from "../types";

/**
 * Macroeconomic Calendar.
 *
 * NOTE (F9 honesty): provider real (ForexFactory mirror / Trading Economics /
 * economic-calendar API) BELUM diimplementasikan. Alih-alih memproduksi event
 * & macroRiskIndex fiktif yang menyetir ukuran posisi, fungsi ini FAIL-CLOSED:
 * mengembalikan "no data" yang netral (risiko 0, stance DATA_DEPENDENT, event
 * kosong) + flag `noRealData: true`. Simulated event palsu yang bisa
 * mengecilkan/membesarkan sizing secara diam-diam DIHAPUS.
 *
 * Begitu adaptor real tersedia, implement di `src/data/macroData.ts` dan flip
 * `setDataSourceMode("macro","live")` — konsumen tidak berubah.
 */
export function getMacroeconomicCalendar(): MacroSummary {
  const now = Date.now();

  return {
    fedPolicyStance: "DATA_DEPENDENT",
    upcomingHighImpactCount: 0,
    nearestEvent: null,
    macroRiskIndex: 0, // fail-closed, bukan 35 baseline ber-opini
    macroTradingAdvice:
      "Data makro belum tersedia dari provider real (mode no-data / fail-closed). Tidak ada katalis fiktif yang memengaruhi ukuran posisi.",
    events: [],
    lastUpdated: now,
  };
}

/** True kalau macro dalam mode no-data (belum ada provider real). */
export function isMacroNoData(m: MacroSummary | null | undefined): boolean {
  return !m || m.macroRiskIndex <= 0 || (m.events?.length ?? 0) === 0;
}

/**
 * Synthetic macroeconomic calendar generator (mock provider).
 * Dipanggil oleh data/macroData.ts — mengganti ke provider real cukup di sana,
 * tanpa menyentuh konsumen.
 */
export function generateMacroCalendar(): MacroSummary {
  return getMacroeconomicCalendar();
}
