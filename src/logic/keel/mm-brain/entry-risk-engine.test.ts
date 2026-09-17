import { describe, it, expect } from "vitest";
import { deriveEntryStopTarget, MIN_STOP_DISTANCE_PCT, type MarketContext } from "./entry-risk-engine";

// Helper: book sintetis dengan wall bid/ask di jarak yang dikontrol dari entry.
function ctxWithWalls(opts: {
  entry: number;
  bidWallAt: number; // harga wall bid (harus < entry untuk BUY)
  askWallAt: number; // harga wall ask (harus > entry untuk SELL TP/BUY skip)
  volPct: number; // volatilitas langsung via budget atrPct
}): MarketContext {
  const { entry, bidWallAt, askWallAt } = opts;
  const mk = (price: number, qty: number) => ({ price, qty });
  return {
    depth: {
      // bestBid = entry - spread kecil, bestAsk = entry (BUY entry = bestAsk)
      bids: [mk(entry - 1, 0.01), mk(bidWallAt, 100)],
      asks: [mk(entry, 0.01), mk(askWallAt, 100)],
      bidDepthUsd: 1e6,
      askDepthUsd: 1e6,
      spreadPct: 0.01,
      imbalance: 1.0,
      capturedAtMs: Date.now(),
    } as any,
    trades: [],
  };
}

const ENTRY = 100_000;
const VOL = 0.02; // 2% → volStopFloor = 1.5%, minAllow ≈ 0.75% dari entry

describe("deriveEntryStopTarget — arah komparasi SL vs lantai minimum", () => {
  it("BUY: wall DEKAT (0.3% < lantai 0.75%) → fallback vol (1.5%), bukan wall", () => {
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.997, askWallAt: ENTRY * 1.05, volPct: VOL });
    const r = deriveEntryStopTarget(ctx, { action: "BUY" }, { maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: VOL, atrSource: "h4" });
    // stopAbs harus ≈ entry*(1-0.015) = 98500 (vol), BUKAN 99700 (wall dekat)
    expect(r.stopAbs).toBeCloseTo(ENTRY * (1 - VOL * 0.75), 0);
    expect(Math.abs(r.stopLossPct)).toBeGreaterThan(1);
  });

  it("BUY: wall JAUH (1.2% > lantai 0.75%) → pakai wall sebagai struktur", () => {
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.988, askWallAt: ENTRY * 1.05, volPct: VOL });
    const r = deriveEntryStopTarget(ctx, { action: "BUY" }, { maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: VOL, atrSource: "h4" });
    expect(r.stopAbs).toBeCloseTo(ENTRY * 0.988, 0);
    expect(r.reason).toContain("structure support");
  });

  it("SELL: wall DEKAT (0.3%) → fallback vol, bukan wall", () => {
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.95, askWallAt: ENTRY * 1.003, volPct: VOL });
    // SELL entry = bestBid; konstruksi ulang agar entry pas: pakai ctx manual
    const mk = (price: number, qty: number) => ({ price, qty });
    const sellCtx: MarketContext = {
      depth: {
        bids: [mk(ENTRY, 0.01), mk(ENTRY * 0.95, 100)],
        asks: [mk(ENTRY + 1, 0.01), mk(ENTRY * 1.003, 100)],
        bidDepthUsd: 1e6,
        askDepthUsd: 1e6,
        spreadPct: 0.01,
        imbalance: 1.0,
        capturedAtMs: Date.now(),
      } as any,
      trades: [],
    };
    const r = deriveEntryStopTarget(sellCtx, { action: "SELL" }, { maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: VOL, atrSource: "h4" });
    expect(r.stopAbs).toBeCloseTo(ENTRY * (1 + VOL * 0.75), 0);
    expect(Math.abs(r.stopLossPct)).toBeGreaterThan(1);
  });

  it("SELL: wall JAUH (1.2%) → pakai wall sebagai struktur", () => {
    const mk = (price: number, qty: number) => ({ price, qty });
    const sellCtx: MarketContext = {
      depth: {
        bids: [mk(ENTRY, 0.01), mk(ENTRY * 0.95, 100)],
        asks: [mk(ENTRY + 1, 0.01), mk(ENTRY * 1.012, 100)],
        bidDepthUsd: 1e6,
        askDepthUsd: 1e6,
        spreadPct: 0.01,
        imbalance: 1.0,
        capturedAtMs: Date.now(),
      } as any,
      trades: [],
    };
    const r = deriveEntryStopTarget(sellCtx, { action: "SELL" }, { maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: VOL, atrSource: "h4" });
    expect(r.stopAbs).toBeCloseTo(ENTRY * 1.012, 0);
    expect(r.reason).toContain("structure resistance");
  });

  it("tanpa wall di sisi SL → selalu fallback vol", () => {
    const mk = (price: number, qty: number) => ({ price, qty });
    const noWall: MarketContext = {
      depth: {
        bids: [mk(ENTRY - 1, 0.01)],
        asks: [mk(ENTRY, 0.01)],
        bidDepthUsd: 1e5,
        askDepthUsd: 1e5,
        spreadPct: 0.01,
        imbalance: 1.0,
        capturedAtMs: Date.now(),
      } as any,
      trades: [],
    };
    const r = deriveEntryStopTarget(noWall, { action: "BUY" }, { maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: VOL, atrSource: "h4" });
    expect(r.stopAbs).toBeCloseTo(ENTRY * (1 - VOL * 0.75), 0);
  });
});

describe("deriveEntryStopTarget — lantai SL & R:R (F1/P0 audit)", () => {
  it("volatilitas tick sangat kecil → SL TIDAK boleh setipis 0.08% (lantai 0.35%)", () => {
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.9992, askWallAt: ENTRY * 1.02, volPct: 0.0008 });
    const r = deriveEntryStopTarget(ctx, { action: "BUY" }, {
      maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: 0.0008, atrSource: "tick",
    });
    // wall 0.08% ditolak (di dalam noise) → fallback vol, tapi vol pun di bawah lantai
    // → lantai 0.35% yang berlaku.
    expect(Math.abs(r.stopLossPct)).toBeGreaterThanOrEqual(0.35);
    expect(r.stopAbs).toBeCloseTo(ENTRY * (1 - MIN_STOP_DISTANCE_PCT), 0);
    expect(r.reason).toContain("floor SL");
  });

  it("lantai SL menskala spread book (8× spread) untuk instrumen spread lebar", () => {
    // spread 0.1% (bid 99899 / ask 100000) → lantai = 8 × 0.1% = 0.8% > 0.35%
    const mk = (price: number, qty: number) => ({ price, qty });
    const wideSpread: MarketContext = {
      depth: {
        bids: [mk(ENTRY * 0.999, 0.01), mk(ENTRY * 0.98, 100)],
        asks: [mk(ENTRY, 0.01), mk(ENTRY * 1.03, 100)],
        bidDepthUsd: 1e6,
        askDepthUsd: 1e6,
        spreadPct: 0.1,
        imbalance: 1.0,
        capturedAtMs: Date.now(),
      } as any,
      trades: [],
    };
    const r = deriveEntryStopTarget(wideSpread, { action: "BUY" }, {
      maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: 0.001, atrSource: "tick",
    });
    expect(Math.abs(r.stopLossPct)).toBeGreaterThanOrEqual(0.79);
  });

  it("TP dari wall hanya dipakai bila R:R ≥ minRewardRatio (1.5), bukan 0.6×reward", () => {
    // SL struktur 1.2% (wall 98800); wall ask hanya 1.2% di atas entry (RR 1.0
    // kalau dipakai) → harus FALLBACK ke rMultiple 1.5, bukan ambil wall.
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.988, askWallAt: ENTRY * 1.012, volPct: 0.016 });
    const r = deriveEntryStopTarget(ctx, { action: "BUY" }, {
      maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: 0.016, atrSource: "h4",
    });
    expect(r.stopAbs).toBeCloseTo(ENTRY * 0.988, 0);
    const rr = r.takeProfitPct / Math.abs(r.stopLossPct);
    expect(rr).toBeGreaterThanOrEqual(1.5);
    expect(r.takeProfitPct).toBeCloseTo(1.8, 1);
  });

  it("TP dari wall dipakai bila jarak wall memenuhi R:R minimum", () => {
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.988, askWallAt: ENTRY * 1.05, volPct: 0.016 });
    const r = deriveEntryStopTarget(ctx, { action: "BUY" }, {
      maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: 0.016, atrSource: "h4",
    });
    expect(r.takeProfitPct).toBeCloseTo(5, 0);
    expect(r.reason).toContain("ask wall");
  });

  it("buang minRewardRatio eksplisit → dipakai sebagai ambang (bukan default 1.5)", () => {
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.988, askWallAt: ENTRY * 1.02, volPct: 0.016 });
    const r = deriveEntryStopTarget(ctx, { action: "BUY" }, {
      maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: 0.016, atrSource: "h4", minRewardRatio: 2.0,
    });
    // wall 2% < SL 1.2% × 2.0 = 2.4% → fallback rMultiple (1.8%)
    expect(r.takeProfitPct).toBeCloseTo(1.8, 1);
  });
});

describe("deriveEntryStopTarget — sizing satu satuan (F2)", () => {
  it("SL ketat (lantai 0.35%) → size di-cap notional 5%, risiko efektif 0.175% ≤ target 0.5%", () => {
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.9992, askWallAt: ENTRY * 1.02, volPct: 0.0008 });
    const r = deriveEntryStopTarget(ctx, { action: "BUY" }, {
      maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: 0.0008, atrSource: "tick",
    });
    expect(Math.abs(r.stopLossPct)).toBeGreaterThanOrEqual(0.35);
    // Cap notional 5% — bukan karena band 2–5% dipaksa, tapi raw (142.8%) di-cap.
    expect(r.sizePct).toBe(5);
    expect((r.sizePct * Math.abs(r.stopLossPct)) / 100).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("SL lebar (13%) → size KECIL sesuai risiko (3.8%), bukan dipaksa ke band 2–5%", () => {
    const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.87, askWallAt: ENTRY * 1.4, volPct: 0.174 });
    const r = deriveEntryStopTarget(ctx, { action: "BUY" }, {
      maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: 0.174, atrSource: "h4",
    });
    expect(Math.abs(r.stopLossPct)).toBeGreaterThanOrEqual(12);
    // 0.5/13.05×100 = 3.83… → dibulatkan KE BAWAH 3.8. Band lama: clamp ke 5
    // (atau lantai 2% oversize) → risiko 0.65% > target 0.5% — bug F2.
    expect(r.sizePct).toBe(3.8);
    expect((r.sizePct * Math.abs(r.stopLossPct)) / 100).toBeLessThanOrEqual(0.5 + 1e-9);
  });

  it("INVARIANT: risiko efektif ≤ 0.5% equity & size ≤ cap untuk spektrum volatilitas", () => {
    for (const vol of [0.0008, 0.004, 0.01, 0.02, 0.04, 0.08, 0.2]) {
      const ctx = ctxWithWalls({ entry: ENTRY, bidWallAt: ENTRY * 0.97, askWallAt: ENTRY * 1.2, volPct: vol });
      const r = deriveEntryStopTarget(ctx, { action: "BUY" }, {
        maxRiskPct: 0.5, rewardRatio: 1.5, volatilityWindowMs: 30_000, atrPct: vol, atrSource: "h4",
      });
      const riskPctOfEquity = (r.sizePct * Math.abs(r.stopLossPct)) / 100;
      expect(riskPctOfEquity).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(r.sizePct).toBeLessThanOrEqual(5);
      expect(r.sizePct).toBeGreaterThanOrEqual(0.1);
    }
  });
});
