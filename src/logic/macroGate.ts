/**
 * Macro FLAT Gate — Ported from Keel `services/macro/calendar.ts`.
 *
 * Risk level around high-impact macro catalysts (FOMC / CPI / NFP):
 * - FLAT: no new entries within 15 min before / 30 min after a HIGH event
 * - SIZE_DOWN: reduced size within the pre-window (FOMC: 90 min pre / 60 min post)
 * - NORMAL: outside any window
 *
 * Keel semantics (sizeFor):
 *   post: minsSince<=30 → FLAT; <=postMin → SIZE_DOWN(0.35)
 *   pre:  minsTo<=15   → FLAT; <=30 → SIZE_DOWN(0.35); <=60 → SIZE_DOWN(0.5); <=preMin → SIZE_DOWN(0.65)
 *
 * Neural adaptation: uses the MacroCalendarEvent list (when data is real /
 * present). Fail-closed no-data state → NORMAL with explicit `noData: true`
 * so the UI labels it honestly ("no catalyst data — gate open", not "safe").
 */

import { MacroCalendarEvent, MacroSummary } from "../types";

export type MacroRiskLevel = "FLAT" | "SIZE_DOWN" | "NORMAL";

export interface MacroGateVerdict {
  level: MacroRiskLevel;
  mult: number; // position size multiplier (0 = flat, 0.35-1 = reduced)
  active: MacroCalendarEvent | null;
  next: MacroCalendarEvent | null;
  minsTo: number | null;
  minsSince: number | null;
  reason: string;
  noData: boolean;
  eventType: string | null;
}

// High-impact event → window configuration
const EVENT_WINDOWS: Record<string, { preMin: number; postMin: number; volPct: number }> = {
  FOMC: { preMin: 90, postMin: 60, volPct: 3 },
  NFP: { preMin: 60, postMin: 45, volPct: 3 },
  CPI: { preMin: 60, postMin: 45, volPct: 2.5 },
  PPI: { preMin: 45, postMin: 40, volPct: 2 },
  GDP: { preMin: 45, postMin: 40, volPct: 2 },
  ECB: { preMin: 60, postMin: 45, volPct: 2.5 },
};

function windowOf(ev: MacroCalendarEvent): { preMin: number; postMin: number } {
  const w = EVENT_WINDOWS[ev.name.split(" ")[0].toUpperCase()] ?? EVENT_WINDOWS[ev.category === "CENTRAL_BANK" ? "FOMC" : "CPI"];
  if (w) return { preMin: w.preMin, postMin: w.postMin };
  return { preMin: 60, postMin: 45 };
}

function sizeFor(
  minsTo: number | null,
  minsSince: number | null,
  ev: MacroCalendarEvent | null
): { level: MacroRiskLevel; mult: number } {
  if (!ev || (minsTo === null && minsSince === null)) return { level: "NORMAL", mult: 1 };
  const { postMin, preMin } = windowOf(ev);

  if (minsSince !== null && minsSince >= 0) {
    if (minsSince <= 30) return { level: "FLAT", mult: 0 };
    if (minsSince <= postMin) return { level: "SIZE_DOWN", mult: 0.35 };
    return { level: "NORMAL", mult: 1 };
  }
  if (minsTo !== null && minsTo >= 0) {
    if (minsTo <= 15) return { level: "FLAT", mult: 0 };
    if (minsTo <= 30) return { level: "SIZE_DOWN", mult: 0.35 };
    if (minsTo <= 60) return { level: "SIZE_DOWN", mult: 0.5 };
    if (minsTo <= preMin) return { level: "SIZE_DOWN", mult: 0.65 };
  }
  return { level: "NORMAL", mult: 1 };
}

/**
 * Evaluate the macro gate at the given time (default now).
 * Only HIGH-impact events are considered (Keel seeds all events as HIGH).
 */
export function evaluateMacroGate(macro: MacroSummary, now: number = Date.now()): MacroGateVerdict {
  const events = (macro.events ?? []).filter((e) => e.status !== "COMPLETED");

  if (events.length === 0) {
    return {
      level: "NORMAL",
      mult: 1,
      active: null,
      next: null,
      minsTo: null,
      minsSince: null,
      reason: "no catalyst data — gate open (fail-closed no-data)",
      noData: true,
      eventType: null,
    };
  }

  // Find active window event (within pre/post window) or next upcoming HIGH event
  let active: MacroCalendarEvent | null = null;
  let minsTo: number | null = null;
  let minsSince: number | null = null;
  let next: MacroCalendarEvent | null = null;

  for (const e of events) {
    const d = (e.timestamp - now) / 60_000;
    const { preMin, postMin } = windowOf(e);
    if (d >= -postMin && d <= preMin) {
      active = e;
      if (d >= 0) minsTo = d; else minsSince = -d;
      break;
    }
  }

  if (!active) {
    // next upcoming event (regardless of impact for lookahead)
    const upcoming = events.filter((e) => e.timestamp > now).sort((a, b) => a.timestamp - b.timestamp);
    next = upcoming[0] ?? null;
    minsTo = next ? (next.timestamp - now) / 60_000 : null;
  }

  const { level, mult } = sizeFor(minsTo, minsSince, active ?? next);

  let reason = "NORMAL";
  if (active) {
    reason = `${level} ${active.name} ${minsSince !== null ? `${minsSince.toFixed(0)}m post` : `${minsTo?.toFixed(0)}m pre`}`;
  } else if (next && minsTo !== null && minsTo <= 90) {
    reason = `${level} → ${next.name} ${minsTo.toFixed(0)}m`;
  } else if (next) {
    reason = `${level} — next catalyst ${next.name} in ${minsTo?.toFixed(0)}m`;
  }

  return {
    level,
    mult,
    active,
    next: next ?? active,
    minsTo,
    minsSince,
    reason,
    noData: false,
    eventType: (active ?? next)?.name ?? null,
  };
}

/** Convenience: true when trades should be halted. */
export function isMacroFlat(macro: MacroSummary, now: number = Date.now()): boolean {
  return evaluateMacroGate(macro, now).level === "FLAT";
}