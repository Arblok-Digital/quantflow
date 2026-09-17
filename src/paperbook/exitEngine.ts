/**
 * Exit engine (F3) — break-even otomatis, trailing chandelier, partial TP
 * berbasis R, dan time-stop untuk posisi paperbook.
 *
 * Prinsip desain:
 *  - OPT-IN per posisi: tanpa `pos.exitPlan` engine TIDAK melakukan apa pun
 *    (posisi lama / posisi operator tidak berubah perilaku sampai exit plan
 *    dipasang eksplisit via /api/broker/position/update).
 *  - RATCHET: SL hanya boleh MENYEMPIT (LONG: naik; SHORT: turun). Engine
 *    tidak pernah menghasilkan SL yang lebih longgar dari SL saat ini, dan
 *    tidak pernah menaruh SL di sisi harga yang salah (LONG: SL < mark).
 *  - PURE: evaluasi tidak memutasi state — monitor yang menerapkan hasil
 *    (patch state + persist + close). Semua invarian bisa diuji langsung.
 *  - R memakai risiko awal per unit (|entry − SL saat plan dipasang|) yang
 *    DIBEKUKAN di state, bukan SL yang sudah bergeser oleh BE/trailing.
 */

import type {
  ExitReason,
  PaperPosition,
  PositionExitConfig,
  PositionExitPartialLevel,
} from "./types";
import { TAKER_FEE_RATE } from "./config";

/** F9 (2026-09-17): BE sadar-fee — offset lama 0.08% di sisi rugi dihapus.
 * SL BE kini dihitung dari tarif fee: X = E*(1±f)/(1∓f) agar net = 0,
 * selaras store.ts (manual BE). Lihat evaluatePositionExits(). */
/** Batas jumlah level partial & total % yang boleh ditutup partial. */
export const PARTIAL_MAX_LEVELS = 5;
export const PARTIAL_MAX_TOTAL_PCT = 100;

export interface MarketWindow {
  mark: number;
  high1m: number;
  low1m: number;
  now: number;
}

export interface ExitEvalResult {
  /** SL baru bila engine memutuskan menggeser — SUDAH lolos ratchet & sanity side. */
  newStopLoss?: number;
  /** Tutup sebagian: qty positif (< pos.qty; = pos.qty bila sisa jadi debu). */
  partialCloseQty?: number;
  partialReason?: ExitReason;
  /** Tutup penuh (time stop). */
  fullCloseReason?: ExitReason;
  /** Patch state exit plan yang harus diterapkan + dipersist oleh pemanggil. */
  statePatch?: { breakevenArmed?: boolean; takenPartialR?: number[]; peakMark?: number };
  notes: string[];
}

const roundQty = (q: number): number => Math.round(q * 1e9) / 1e9;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** true bila kandidat lebih MENYEMPIT daripada SL sekarang (LONG: naik, SHORT: turun). */
export function slTightens(pos: PaperPosition, candidate: number): boolean {
  if (!Number.isFinite(candidate) || candidate <= 0) return false;
  return pos.side === "LONG" ? candidate > pos.stopLoss : candidate < pos.stopLoss;
}

/** SL harus di sisi yang benar dari mark (LONG: di bawah; SHORT: di atas) — cegah bracket kontradiktif. */
export function slOnSaneSide(pos: PaperPosition, candidate: number, mark: number): boolean {
  if (!Number.isFinite(mark) || mark <= 0) return false;
  return pos.side === "LONG" ? candidate < mark : candidate > mark;
}

/**
 * Validasi + clamp konfigurasi exit dari input eksternal (API/panel).
 * Return null bila tidak ada komponen valid (caller: tolak / no-op).
 */
export function normalizeExitConfig(raw: unknown): PositionExitConfig | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: PositionExitConfig = {};

  const beR = num(r.breakEvenTriggerR);
  if (beR != null && beR > 0) out.breakEvenTriggerR = clamp(beR, 0.1, 10);
  const beOff = num(r.breakEvenOffsetPct);
  if (beOff != null && beOff > 0) out.breakEvenOffsetPct = clamp(beOff, 0.0001, 0.02);
  const trail = num(r.trailingPct);
  if (trail != null && trail > 0) out.trailingPct = clamp(trail, 0.05, 20);
  const hold = num(r.maxHoldMs);
  if (hold != null && hold >= 60_000) out.maxHoldMs = Math.min(hold, 30 * 24 * 60 * 60_000);

  if (Array.isArray(r.partialLevels)) {
    const levels: PositionExitPartialLevel[] = [];
    for (const item of r.partialLevels.slice(0, PARTIAL_MAX_LEVELS)) {
      if (item == null || typeof item !== "object") continue;
      const rr = num((item as Record<string, unknown>).rMultiple);
      const pct = num((item as Record<string, unknown>).closePct);
      if (rr == null || pct == null) continue;
      levels.push({ rMultiple: clamp(rr, 0.1, 20), closePct: clamp(pct, 1, 100) });
    }
    levels.sort((a, b) => a.rMultiple - b.rMultiple);
    const total = levels.reduce((s, l) => s + l.closePct, 0);
    if (levels.length > 0 && total <= PARTIAL_MAX_TOTAL_PCT) out.partialLevels = levels;
  }

  const hasAny =
    out.breakEvenTriggerR != null || out.trailingPct != null || out.partialLevels != null || out.maxHoldMs != null;
  return hasAny ? out : null;
}

/** Label manusiawi untuk event/log. */
export function describeExitConfig(cfg: PositionExitConfig): string {
  const parts: string[] = [];
  if (cfg.breakEvenTriggerR != null) parts.push(`BE@${cfg.breakEvenTriggerR}R`);
  if (cfg.trailingPct != null) parts.push(`trail ${cfg.trailingPct}%`);
  if (cfg.partialLevels?.length) {
    parts.push(`partial ${cfg.partialLevels.map((l) => `${l.rMultiple}R×${l.closePct}%`).join(", ")}`);
  }
  if (cfg.maxHoldMs != null) parts.push(`time-stop ${(cfg.maxHoldMs / 3_600_000).toFixed(1)}h`);
  return parts.join(" + ");
}

/**
 * Evaluasi exit plan satu posisi pada satu window mark. PURE — tidak mutasi.
 * Urutan: peak → partial TP → BE → trailing → time-stop. Semua hasil opsional.
 */
export function evaluatePositionExits(pos: PaperPosition, w: MarketWindow): ExitEvalResult {
  const plan = pos.exitPlan;
  if (!plan || pos.status !== "OPEN") return { notes: [] };
  const cfg = plan.config;
  const st = plan.state;
  const isLong = pos.side === "LONG";
  const notes: string[] = [];
  const result: ExitEvalResult = { notes };

  // Deadline is independent of mark, initial risk, BE and partial targets.
  if (cfg.maxHoldMs != null && Number.isFinite(cfg.maxHoldMs) && cfg.maxHoldMs > 0 && Number.isFinite(pos.openedAt) && w.now >= pos.openedAt + cfg.maxHoldMs) {
    result.fullCloseReason = "TIMEOUT";
    notes.push(`time-stop ${Math.round((w.now - pos.openedAt) / 60_000)}m`);
    return result;
  }
  if (!Number.isFinite(w.mark) || w.mark <= 0) return result;

  // 1. Peak favorable (wick window ikut dihitung — konsisten dgn bracket monitor).
  const favorable = isLong ? w.high1m : w.low1m;
  const prevPeak = st.peakMark;
  const peak =
    prevPeak != null && Number.isFinite(prevPeak) && prevPeak > 0
      ? isLong
        ? Math.max(prevPeak, favorable)
        : Math.min(prevPeak, favorable)
      : favorable;
  result.statePatch = { peakMark: peak };

  // Anchor R — dibekukan saat plan dipasang; fallback jujur ke SL sekarang.
  const risk = st.initialRiskPerUnit > 0 ? st.initialRiskPerUnit : Math.abs(pos.entryPrice - pos.stopLoss);
  if (!(risk > 0)) return result;

  // 2. Partial TP — level yang TERCAPI di window ini (gap bisa memicu >1 level;
  //    qty digabung, semua ditandai taken agar tidak dobel).
  if (cfg.partialLevels?.length) {
    const taken = new Set(st.takenPartialR ?? []);
    let totalPct = 0;
    const newlyHit: number[] = [];
    for (const lvl of [...cfg.partialLevels].sort((a, b) => a.rMultiple - b.rMultiple)) {
      if (taken.has(lvl.rMultiple)) continue;
      const target = isLong ? pos.entryPrice + lvl.rMultiple * risk : pos.entryPrice - lvl.rMultiple * risk;
      const hit = isLong ? favorable >= target : favorable <= target;
      if (!hit) continue;
      totalPct += lvl.closePct;
      newlyHit.push(lvl.rMultiple);
    }
    if (totalPct > 0 && newlyHit.length > 0) {
      result.statePatch.takenPartialR = [...(st.takenPartialR ?? []), ...newlyHit];
      const closeQty = roundQty((pos.qty * Math.min(totalPct, 100)) / 100);
      const remaining = roundQty(pos.qty - closeQty);
      // Sisa debu (pembulatan float) → tutup penuh sekalian.
      result.partialCloseQty = remaining <= 1e-9 ? pos.qty : closeQty;
      result.partialReason = "PARTIAL_TAKE_PROFIT";
      notes.push(`partial TP @R${newlyHit.join("+")} (${totalPct.toFixed(0)}% qty)`);
    }
  }

  // 3. Break-even otomatis (sekali arm).
  if (cfg.breakEvenTriggerR != null && !st.breakevenArmed) {
    const trigger = isLong
      ? pos.entryPrice + cfg.breakEvenTriggerR * risk
      : pos.entryPrice - cfg.breakEvenTriggerR * risk;
    const hit = isLong ? favorable >= trigger : favorable <= trigger;
    if (hit) {
      result.statePatch.breakevenArmed = true;
      // F9 (2026-09-17): SL BE sadar-fee — LONG DI ATAS entry, SHORT DI BAWAH,
      // sehingga fill stop menutup fee entry+exit (net ≈ 0):
      //   X = E * (1 + f) / (1 - f)  (LONG) ; X = E * (1 - f) / (1 + f)  (SHORT)
      // Rumus lama E*(1∓0.08%) menaruh SL di sisi rugi → net ≈ -2*f*E*qty.
      const f = TAKER_FEE_RATE;
      const beSl = isLong
        ? pos.entryPrice * ((1 + f) / (1 - f))
        : pos.entryPrice * ((1 - f) / (1 + f));
      if (slTightens(pos, beSl) && slOnSaneSide(pos, beSl, w.mark)) {
        result.newStopLoss = beSl;
        notes.push(`BE armed @${cfg.breakEvenTriggerR}R → SL ${Number(beSl.toFixed(6))}`);
      } else {
        notes.push(`BE armed @${cfg.breakEvenTriggerR}R (SL sekarang sudah lebih ketat dari BE)`);
      }
    }
  }

  // 4. Trailing chandelier sederhana: SL = peak ± trail%. Ratchet + sane side.
  if (cfg.trailingPct != null && cfg.trailingPct > 0) {
    const candidate = isLong ? peak * (1 - cfg.trailingPct / 100) : peak * (1 + cfg.trailingPct / 100);
    const betterThanEmitted =
      result.newStopLoss === undefined ||
      (isLong ? candidate > result.newStopLoss : candidate < result.newStopLoss);
    if (betterThanEmitted && slTightens(pos, candidate) && slOnSaneSide(pos, candidate, w.mark)) {
      result.newStopLoss = candidate;
      notes.push(`trail ${cfg.trailingPct}% dari peak ${Number(peak.toFixed(6))}`);
    }
  }

  // 5. Time stop (full close).
  if (cfg.maxHoldMs != null && cfg.maxHoldMs > 0 && w.now - pos.openedAt >= cfg.maxHoldMs) {
    result.fullCloseReason = "TIMEOUT";
    notes.push(`time-stop ${Math.round((w.now - pos.openedAt) / 60_000)}m`);
  }

  return result;
}