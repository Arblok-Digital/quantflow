import { describe, it, expect } from "vitest";
import { analyzeMTFLiquidity, detectLiquidityZones, estimateLiquidationDepthFromBook } from "./liquidityHunt";
import type { Candle, OrderBook, Timeframe } from "../types";

const T0 = 1_700_000_000_000;

function series(highs: number[], lows: number[], closes: number[], timeframe: Timeframe = "15m"): Candle[] {
  return highs.map((h, i) => {
    const c = closes[i];
    return {
      timestamp: T0 + i * (timeframe === "4h" ? 3_600_000 * 4 : 900_000),
      open: i === 0 ? c : closes[i - 1],
      high: h,
      low: lows[i],
      close: c,
      volume: 1000,
    };
  });
}

function shortSeries(): Candle[] {
  return series([100, 101, 100, 99], [99.5, 100, 99, 98.5], [100, 100.5, 99.5, 99]);
}

describe("analyzeMTFLiquidity", () => {
  it("candles < 5 → fallback EQUILIBRIUM, tanpa zones, confluence 50 (netral, F4 dihitung)", () => {
    const res = analyzeMTFLiquidity(shortSeries(), shortSeries(), 100);
    expect(res.activeState).toBe("EQUILIBRIUM");
    expect(res.zones15m).toHaveLength(0);
    expect(res.zones4h).toHaveLength(0);
    expect(res.confluenceScore).toBe(50);
    expect(res.huntingTarget).toBeNull();
    expect(res.recentSweep).toBeNull();
  });

  it("mendeteksi swing high/low jadi BSL/SSL dengan midPrice & jarak dari harga", () => {
    const highs = [100.5, 100.8, 101.2, 101.5, 101.9, 102.3, 101.8, 101.4, 101.0, 100.0];
    const lows = [99.8, 100.0, 100.4, 99.4, 100.9, 101.2, 101.0, 100.8, 100.6, 99.0];
    const closes = [100.3, 100.6, 101.0, 101.2, 101.5, 102.0, 101.4, 101.0, 100.8, 99.4];
    const res = analyzeMTFLiquidity(series(highs, lows, closes), shortSeries(), 101);

    const bsl = res.zones15m.find((z) => z.type === "BSL");
    const ssl = res.zones15m.find((z) => z.type === "SSL");
    expect(bsl).toBeDefined();
    expect(ssl).toBeDefined();

    expect(bsl!.priceMax).toBeGreaterThan(bsl!.priceMin);
    expect(bsl!.midPrice).toBeGreaterThanOrEqual(bsl!.priceMin);
    expect(bsl!.midPrice).toBeLessThanOrEqual(bsl!.priceMax);
    expect(ssl!.priceMax).toBeGreaterThan(ssl!.priceMin);
    expect(ssl!.midPrice).toBeGreaterThanOrEqual(ssl!.priceMin);
    expect(ssl!.midPrice).toBeLessThanOrEqual(ssl!.priceMax);

    expect(res.nearestBSL?.distancePercent).toBeGreaterThan(0);
    expect(res.nearestSSL?.distancePercent).toBeLessThan(0);
  });

  it("deteksi sweep bullish SSL (pierce bawah lalu close atas) → SWEPT_SSL + target BSL", () => {
    const highs = [101.0, 101.5, 101.8, 101.4, 101.2, 101.6, 101.9, 103.0, 102.6, 102.2, 100.8];
    const lows = [100.9, 100.7, 101.0, 100.6, 100.0, 100.6, 100.8, 100.9, 100.7, 100.5, 99.4];
    const closes = [100.9, 101.2, 101.5, 100.8, 100.5, 101.3, 101.6, 102.7, 101.9, 101.0, 100.2];
    const res = analyzeMTFLiquidity(series(highs, lows, closes), shortSeries(), 100.5);

    expect(res.activeState).toBe("SWEPT_SSL");
    expect(res.recentSweep?.type).toBe("BULLISH_SSL_SWEEP");
    expect(res.recentSweep?.wickRejectionPercent).toBe(57.1);
    expect(res.recentSweep?.invalidationPrice).toBe(99.3);
    expect(res.recentSweep?.zone.type).toBe("SSL");
    expect(res.huntingTarget?.targetType).toBe("BSL");
    expect(res.huntingTarget?.targetPrice).toBeCloseTo(103.13, 2);
    // F4: dihitung dari struktur riil — sweep +15, target +6, 1 TF zona +5 → 76
    expect(res.confluenceScore).toBe(76);
  });

  it("deteksi sweep bearish BSL (pierce atas lalu close bawah) → SWEPT_BSL + target SSL", () => {
    const highs = [100.5, 100.8, 101.2, 101.5, 101.9, 102.3, 101.8, 101.4, 101.0, 103.5];
    const lows = [99.8, 100.0, 100.4, 99.4, 100.9, 101.2, 101.0, 100.8, 100.6, 99.5];
    const closes = [100.3, 100.6, 101.0, 101.2, 101.5, 102.0, 101.4, 101.0, 100.8, 102.0];
    const res = analyzeMTFLiquidity(series(highs, lows, closes), shortSeries(), 101);

    expect(res.activeState).toBe("SWEPT_BSL");
    expect(res.recentSweep?.type).toBe("BEARISH_BSL_SWEEP");
    expect(res.recentSweep?.wickRejectionPercent).toBe(37.5);
    expect(res.recentSweep?.invalidationPrice).toBe(103.6);
    expect(res.huntingTarget?.targetType).toBe("SSL");
    expect(res.huntingTarget?.targetPrice).toBeCloseTo(99.28, 2);
    // F4: sweep +15, target +6, 1 TF zona +5 → 76 (bukan 85 konstanta)
    expect(res.confluenceScore).toBe(76);
  });

  it("jarak BSL < 0.6% tanpa sweep → HUNTING_BSL, confluence 61 (dihitung)", () => {
    const highs = [100, 100.5, 101, 101.5, 102, 101.5, 101, 100.5, 100];
    const lows = [99.7, 99.6, 99.5, 99.4, 99.3, 99.2, 99.1, 99.0, 98.9];
    const closes = [99.9, 100.3, 100.8, 101.3, 101.8, 101.3, 100.8, 100.3, 99.1];
    const res = analyzeMTFLiquidity(series(highs, lows, closes), shortSeries(), 101.6);

    expect(res.activeState).toBe("HUNTING_BSL");
    expect(res.recentSweep).toBeNull();
    expect(res.huntingTarget?.targetType).toBe("BSL");
    expect(res.huntingTarget?.targetPrice).toBeCloseTo(102.13, 2);
    // F4: target +6, 1 TF zona +5, tanpa sweep → 61 (bukan 78 konstanta)
    expect(res.confluenceScore).toBe(61);
  });

  it("jarak SSL < 0.6% tanpa sweep → HUNTING_SSL, confluence 61 (dihitung)", () => {
    const highs = [101.5, 101.4, 101.3, 101.2, 101.1, 101.0, 101.0, 100.8, 100.6];
    const lows = [101, 100.8, 100.6, 100.4, 99, 100.4, 100.6, 100.8, 101];
    const closes = [101.4, 101.2, 101.1, 100.9, 99.3, 100.7, 100.9, 101.0, 101.2];
    const res = analyzeMTFLiquidity(series(highs, lows, closes), shortSeries(), 99.3);

    expect(res.activeState).toBe("HUNTING_SSL");
    expect(res.huntingTarget?.targetType).toBe("SSL");
    expect(res.huntingTarget?.targetPrice).toBeCloseTo(98.88, 2);
    expect(res.confluenceScore).toBe(61);
  });

  it("F4: depth book TERUKUR di zona sweep → +5 (skor dihitung, bukan konstanta 88)", () => {
    const highs = [101.0, 101.5, 101.8, 101.4, 101.2, 101.6, 101.9, 103.0, 102.6, 102.2, 100.8];
    const lows = [100.9, 100.7, 101.0, 100.6, 100.0, 100.6, 100.8, 100.9, 100.7, 100.5, 99.4];
    const closes = [100.9, 101.2, 101.5, 100.8, 100.5, 101.3, 101.6, 102.7, 101.9, 101.0, 100.2];
    const book: OrderBook = {
      bids: [
        // SSL zone price = 100.0; window depth ±0.3% → level di 100.0/99.9.
        // Hasil ≥ $0.1M supaya toFixed(1) tidak membulatkan ke 0.
        { price: 100.0, size: 1200, total: 1200 },
        { price: 99.9, size: 1200, total: 2400 },
      ],
      asks: [{ price: 100.6, size: 5, total: 5 }],
      spread: 0.7,
    };
    const res = analyzeMTFLiquidity(series(highs, lows, closes), shortSeries(), 100.5, "FUTURES", book);
    expect(res.activeState).toBe("SWEPT_SSL");
    // sweep +15, target +6, covered 1 TF +5, depth terukur +5 → 81 (bukan 88 konstanta)
    expect(res.confluenceScore).toBe(81);
  });

  it("confluenceScore selalu dalam range 0-100 untuk tiap state", () => {
    const states = [
      analyzeMTFLiquidity(shortSeries(), shortSeries(), 100),
      {
        ...analyzeMTFLiquidity(
          series(
            [101.0, 101.5, 101.8, 101.4, 101.2, 101.6, 101.9, 103.0, 102.6, 102.2, 100.8],
            [100.9, 100.7, 101.0, 100.6, 100.0, 100.6, 100.8, 100.9, 100.7, 100.5, 99.4],
            [100.9, 101.2, 101.5, 100.8, 100.5, 101.3, 101.6, 102.7, 101.9, 101.0, 100.2]
          ),
          shortSeries(),
          100.5
        ),
      },
      {
        ...analyzeMTFLiquidity(
          series([100, 100.5, 101, 101.5, 102, 101.5, 101, 100.5, 100], [99.7, 99.6, 99.5, 99.4, 99.3, 99.2, 99.1, 99.0, 98.9], [99.9, 100.3, 100.8, 101.3, 101.8, 101.3, 100.8, 100.3, 99.1]),
          shortSeries(),
          101.6
        ),
      },
    ];
    for (const a of states) {
      expect(a.confluenceScore).toBeGreaterThanOrEqual(0);
      expect(a.confluenceScore).toBeLessThanOrEqual(100);
    }
  });

  it("deteksi zone 4h memakai leverageTiers '20x - 50x' dan id berisi '4h'", () => {
    const highs = [100, 100.5, 101, 101.5, 102, 101.5, 101, 100.5, 100, 100];
    const lows = [99.5, 99.4, 99.3, 99.2, 99.1, 99.0, 98.9, 98.8, 98.7, 98.6];
    const closes = [100, 100.4, 100.8, 101.2, 101.8, 101.3, 100.8, 100.3, 99.9, 99.7];
    const res = analyzeMTFLiquidity(shortSeries(), series(highs, lows, closes, "4h"), 101.6);

    const bsl4h = res.zones4h.find((z) => z.type === "BSL");
    expect(bsl4h).toBeDefined();
    expect(bsl4h!.timeframe).toBe("4h");
    expect(bsl4h!.leverageTiers).toBe("20x - 50x");
    expect(bsl4h!.id).toContain("4h");
  });
});

describe("estimateLiquidationDepthFromBook", () => {
  const book: OrderBook = {
    bids: [{ price: 100, size: 80000, total: 80000 }],
    asks: [{ price: 100, size: 50000, total: 50000 }],
    spread: 0.01,
  };

  it("menjumlahkan depth ask di sekitar zone untuk BSL", () => {
    expect(estimateLiquidationDepthFromBook(book, 100.1, true)).toBe(5);
  });

  it("menjumlahkan depth bid di sekitar zone untuk SSL", () => {
    expect(estimateLiquidationDepthFromBook(book, 99.95, false)).toBe(8);
  });

  it("tanpa level di sekitar zone → 0 (tidak memfabrikasi angka)", () => {
    const empty: OrderBook = { bids: [{ price: 100, size: 1, total: 1 }], asks: [], spread: 0 };
    expect(estimateLiquidationDepthFromBook(empty, 200, true)).toBe(0);
  });
});