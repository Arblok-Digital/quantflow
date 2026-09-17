import { describe, it, expect } from "vitest";
import {
  riskTargetedSizePct,
  DEFAULT_MIN_NOTIONAL_PCT,
  MISSING_STOP_FALLBACK_PCT,
} from "./positionSizing";

describe("riskTargetedSizePct — F2 sizing satu satuan (% equity NOTIONAL)", () => {
  it("formula tepat: size = riskTarget/stop × 100, dibulatkan KE BAWAH 1 desimal", () => {
    // raw = 0.5 / 10.13 × 100 = 4.9358… → floor 1dp = 4.9 (bukan 5.0!)
    const r = riskTargetedSizePct({ riskTargetPct: 0.5, stopDistancePct: 10.13, maxNotionalPct: 25 });
    expect(r.sizePct).toBe(4.9);
    expect(r.capped).toBe(false);
    expect(r.riskEffectivePct).toBeCloseTo((4.9 * 10.13) / 100, 4);
  });

  it("SL ketat → size di-cap notional; risiko efektif jauh di bawah target", () => {
    const r = riskTargetedSizePct({ riskTargetPct: 0.5, stopDistancePct: 0.35, maxNotionalPct: 5 });
    expect(r.sizePct).toBe(5);
    expect(r.capped).toBe(true);
    expect(r.riskEffectivePct).toBeCloseTo((5 * 0.35) / 100, 4);
  });

  it("INVARIAN: size × stop / 100 ≤ riskTarget untuk seluruh rentang SL (0.05%–20%)", () => {
    for (let stop = 0.05; stop <= 20.0001; stop += 0.13) {
      const r = riskTargetedSizePct({ riskTargetPct: 0.5, stopDistancePct: stop, maxNotionalPct: 25 });
      expect(r.sizePct).toBeLessThanOrEqual(25);
      expect(r.sizePct).toBeGreaterThanOrEqual(DEFAULT_MIN_NOTIONAL_PCT);
      expect(r.riskEffectivePct).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("INVARIAN juga berlaku di bawah executionMultiplier (macro/session 0–1)", () => {
    for (const mult of [0, 0.35, 0.5, 0.65, 1]) {
      for (const stop of [0.35, 0.8, 1.5, 3, 8, 15]) {
        const r = riskTargetedSizePct({
          riskTargetPct: 0.5,
          stopDistancePct: stop,
          maxNotionalPct: 25,
          executionMultiplier: mult,
        });
        expect(r.riskEffectivePct).toBeLessThanOrEqual(0.5 + 1e-9);
        expect(r.sizePct).toBeLessThanOrEqual(25);
      }
    }
  });

  it("executionMultiplier mengecilkan size (0.35 → ~35%) — tidak diangkat ke band lama", () => {
    const full = riskTargetedSizePct({ riskTargetPct: 0.5, stopDistancePct: 13, maxNotionalPct: 25 });
    const down = riskTargetedSizePct({
      riskTargetPct: 0.5,
      stopDistancePct: 13,
      maxNotionalPct: 25,
      executionMultiplier: 0.35,
    });
    // 0.5/13×100 = 3.846… → 3.8; ×0.35 = 1.346… → 1.3 (band lama akan paksa 2)
    expect(full.sizePct).toBe(3.8);
    expect(down.sizePct).toBe(1.3);
    expect(down.riskEffectivePct).toBeLessThanOrEqual(0.5);
  });

  it("stop tidak valid → fallback notional statis (perilaku legacy), risiko tidak dihitung", () => {
    const r = riskTargetedSizePct({ riskTargetPct: 0.5, stopDistancePct: 0, maxNotionalPct: 25 });
    expect(r.sizePct).toBe(MISSING_STOP_FALLBACK_PCT);
    expect(r.riskEffectivePct).toBe(0);
    expect(r.capped).toBe(false);
  });

  it("multiplier di luar 0..1 di-clamp; cap tidak bisa dilampaui", () => {
    const r = riskTargetedSizePct({
      riskTargetPct: 0.5,
      stopDistancePct: 0.1,
      maxNotionalPct: 5,
      executionMultiplier: 7,
    });
    expect(r.sizePct).toBe(5);
    expect(r.capped).toBe(true);
  });
});