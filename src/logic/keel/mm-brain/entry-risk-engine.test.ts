import { describe, it, expect } from "vitest";
import { deriveEntryStopTarget, type MarketContext } from "./entry-risk-engine";

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
