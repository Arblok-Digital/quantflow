import { MacroCalendarEvent, MacroSummary } from "../types";

/**
 * Curated high-impact Macroeconomic Calendar for Crypto & Global Asset Markets.
 * Supplies essential macro catalysts (FOMC, CPI, NFP, PCE, GDP) as knowledge for the AI agent.
 */
export function getMacroeconomicCalendar(): MacroSummary {
  const now = Date.now();
  const ONE_HOUR = 3600 * 1000;

  const events: MacroCalendarEvent[] = [
    {
      id: "macro-fomc-rate",
      name: "US FOMC Interest Rate Decision & Press Conf",
      country: "United States",
      currency: "USD",
      timestamp: now + 3.5 * ONE_HOUR, // 3.5 hours from now
      timeLabel: "18:00 UTC",
      relativeTime: "Dalam 3 Jam 30 Menit",
      impact: "HIGH",
      category: "CENTRAL_BANK",
      previous: "5.25% - 5.50%",
      forecast: "5.00% - 5.25%",
      actual: null,
      status: "UPCOMING",
      hawkishOrDovish: "DOVISH",
      implicationNotes: "Pemangkasan suku bunga 25 bps telah di-price in oleh pasar obligasi. Nada konferensi pers Jerome Powell akan menentukan arah likuiditas global dan risk-on crypto.",
      volatilityRisk: "HIGH_ALERT",
    },
    {
      id: "macro-us-cpi",
      name: "US CPI Inflation Rate (YoY / MoM)",
      country: "United States",
      currency: "USD",
      timestamp: now + 28 * ONE_HOUR, // Tomorrow
      timeLabel: "Besok 12:30 UTC",
      relativeTime: "Besok (T+1)",
      impact: "HIGH",
      category: "INFLATION",
      previous: "3.1% YoY",
      forecast: "2.9% YoY",
      actual: null,
      status: "UPCOMING",
      hawkishOrDovish: "TBD",
      implicationNotes: "Inflasi di bawah 3.0% mengonfirmasi jalur pelonggaran moneter. Jika CPI > 3.2%, ekspektasi pengetatan kembali meningkat dan dapat memicu aksi jual risk assets.",
      volatilityRisk: "HIGH_ALERT",
    },
    {
      id: "macro-us-nfp",
      name: "US Non-Farm Payrolls (NFP) & Unemployment",
      country: "United States",
      currency: "USD",
      timestamp: now - 48 * ONE_HOUR, // 2 days ago (completed)
      timeLabel: "Jumat Lalu",
      relativeTime: "Selesai (2 hari lalu)",
      impact: "HIGH",
      category: "EMPLOYMENT",
      previous: "142K",
      forecast: "165K",
      actual: "158K (Pengangguran 4.2%)",
      status: "COMPLETED",
      hawkishOrDovish: "NEUTRAL",
      implicationNotes: "Pasar tenaga kerja mendingin secara teratur ('soft landing'), mendukung narasi pelonggaran likuiditas bertahap tanpa ancaman resesi tajam.",
      volatilityRisk: "MODERATE",
    },
    {
      id: "macro-core-pce",
      name: "Core PCE Price Index (Fed Preferred Metric)",
      country: "United States",
      currency: "USD",
      timestamp: now + 120 * ONE_HOUR, // 5 days from now
      timeLabel: "Jumat Depan 12:30 UTC",
      relativeTime: "5 Hari Lagi",
      impact: "HIGH",
      category: "INFLATION",
      previous: "2.6% YoY",
      forecast: "2.5% YoY",
      actual: null,
      status: "UPCOMING",
      hawkishOrDovish: "TBD",
      implicationNotes: "Tolok ukur utama Dewan Gubernur The Fed dalam menentukan kecepatan pelonggaran suku bunga kuartal 4.",
      volatilityRisk: "MODERATE",
    },
    {
      id: "macro-us-gdp",
      name: "US GDP Growth Rate Q2 Final",
      country: "United States",
      currency: "USD",
      timestamp: now + 72 * ONE_HOUR,
      timeLabel: "Kamis 12:30 UTC",
      relativeTime: "3 Hari Lagi",
      impact: "MEDIUM",
      category: "GROWTH",
      previous: "3.0%",
      forecast: "3.0%",
      actual: null,
      status: "UPCOMING",
      hawkishOrDovish: "NEUTRAL",
      implicationNotes: "Menegaskan ketahanan ekonomi domestik AS; stabilitas pertumbuhan menyokong likuiditas institusional.",
      volatilityRisk: "LOW",
    },
  ];

  // Nearest upcoming event
  const upcomingEvents = events.filter((e) => e.status === "UPCOMING").sort((a, b) => a.timestamp - b.timestamp);
  const nearestEvent = upcomingEvents[0] || null;

  // Calculate Macro Risk Index (0 - 100)
  let macroRiskIndex = 35; // baseline moderate
  let fedStance: MacroSummary["fedPolicyStance"] = "DOVISH_PIVOT";
  let advice = "Kondisi makro kondusif untuk swing trading terarah. Likuiditas global mulai berekspansi seiring tren dovish bank sentral.";

  if (nearestEvent && nearestEvent.impact === "HIGH") {
    const hoursUntil = (nearestEvent.timestamp - now) / ONE_HOUR;
    if (hoursUntil < 4) {
      macroRiskIndex = 82; // high alert
      advice = `PERINGATAN MAKRO: ${nearestEvent.name} dalam hitungan jam (${nearestEvent.relativeTime}). Volatilitas spread dan potensi wick slippage meningkat. Risk Gatekeeper disarankan memperketat buffer stop loss dan membatasi ukuran posisi maksimal 6%.`;
    } else if (hoursUntil < 24) {
      macroRiskIndex = 58;
      advice = `Menjelang ${nearestEvent.name} dalam 24 jam ke depan. Disarankan fokus pada set-up swing liquidity sweep yang memiliki Rasio R:R minimal 1:2.`;
    }
  }

  return {
    fedPolicyStance: fedStance,
    upcomingHighImpactCount: upcomingEvents.filter((e) => e.impact === "HIGH").length,
    nearestEvent,
    macroRiskIndex,
    macroTradingAdvice: advice,
    events,
    lastUpdated: now,
  };
}

/**
 * Synthetic macroeconomic calendar generator (mock provider).
 * Dipanggil oleh data/macroData.ts — mengganti ke provider real cukup di sana,
 * tanpa menyentuh konsumen.
 */
export function generateMacroCalendar(): MacroSummary {
  return getMacroeconomicCalendar();
}
