import { MacroSummary } from "../types";
import { generateMacroCalendar } from "../logic/macroCalendar";
import { getDataSourceMode } from "./provider";

/**
 * Macroeconomic calendar data facade.
 *
 * Mock -> real swap point. Untuk migrasi: implementasikan adaptor live di
 * bawah ini (mis. forexfactory / investing.com / NFP API), lalu flip
 * `setDataSourceMode("macro", "live")`.
 */
export function fetchMacroCalendar(): MacroSummary {
  if (getDataSourceMode("macro") === "live") {
    console.warn("[data] macro mode 'live' dipilih tapi provider real belum diimplementasikan — pakai simulated.");
  }
  return generateMacroCalendar();
}