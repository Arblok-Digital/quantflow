import { describe, it, expect } from "vitest";
import {
  estimatePositionEta,
  inferIntervalMs,
  formatDurasi,
  ETA_HORIZON_BARS,
  type PositionEta,
} from "./positionEta";
import type { Candle, Position } from "../types";

// ---------------------------------------------------------------------------
// positionEta — mengunci P-A (interval dari candle, bukan asumsi TF) +
// P-B (alarm horizon) agar "±200j" tidak terulang.
// ---------------------------------------------------------------------------

/** Candle sintetis: spacing tetap + TR konstan (ATR mudah diprediksi). */
function candles(opts: { n: number; startTs: number; intervalMs: number; price: number; tr: number }): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < opts.n; i++) {
    const base = opts.price + i * (opts.tr / 4); // drift naik pelan
    out.push({
      timestamp: opts.startTs + i * opts.intervalMs,
      open: base,
      high: base + opts.tr / 2,
      low: base - opts.tr / 2,
      close: base + opts.tr / 4,
      volume: 100,
    });
  }
  return out;
}

function posAt(price: number, tpPct: number, slPct: number): Position {
  return {
    id: "pos-test",
    symbol: "BTC/USDT",
    side: "LONG",
    qty: 0.01,
    notionalUSD: price * 0.01,
    leverage: 10,
    entryPrice: price,
    currentPrice: price,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    stopLoss: price * (1 - slPct),
    takeProfit: price * (1 + tpPct),
    openedAt: Date.now(),
    timeframe: "15m",
    marketType: "FUTURES",
  } as Position;
}

describe("inferIntervalMs — median delta timestamp", () => {
  it("candle 15m rapi → 900_000ms", () => {
    const c = candles({ n: 20, startTs: 1_700_000_000_000, intervalMs: 900_000, price: 100_000, tr: 100 });
    expect(inferIntervalMs(c)).toBe(900_000);
  });

  it("satu gap weekend tidak menggeser median", () => {
    const c = candles({ n: 20, startTs: 1_700_000_000_000, intervalMs: 60_000, price: 100_000, tr: 10 });
    // Sisipkan gap 2 hari di tengah (libur) — median harus tetap 60s.
    for (let i = 10; i < c.length; i++) c[i]!.timestamp += 2 * 24 * 60 * 60_000;
    expect(inferIntervalMs(c)).toBe(60_000);
  });

  it("timestamp rusak semua → null (bukan 0/crash)", () => {
    const c = candles({ n: 5, startTs: 1_700_000_000_000, intervalMs: 60_000, price: 100_000, tr: 10 });
    for (const k of c) k.timestamp = 1_700_000_000_000; // semua duplikat
    expect(inferIntervalMs(c)).toBeNull();
    const r = estimatePositionEta(posAt(100_000, 0.012, 0.008), 100_000, c);
    expect(r.tpCandles).toBeNull();
    expect(r.atr).not.toBeNull(); // ATR tetap dihitung, durasi yang null jujur
  });
});

describe("P-A: ATR & durasi dari series yang sama (bukan asumsi TF entry)", () => {
  it("REGRESI 200j: ATR microtick-1s × interval 15m TIDAK boleh terjadi", () => {
    // Simulasi bug lama: ATR dari candle 1s (TR $5) tapi interval dipaksa 15m.
    // TP 3.5% @100k = $3500 → 3500/(5*0.5)=1400 candle × 15m = 350 jam. BUG.
    const micro = candles({ n: 45, startTs: 1_700_000_000_000, intervalMs: 1_000, price: 100_000, tr: 5 });
    const p = posAt(100_000, 0.035, 0.015);
    const r = estimatePositionEta(p, 100_000, micro);
    // Fix: interval = 1s (dari candle), bukan 900_000.
    expect(r.intervalMs).toBe(1_000);
    // Durasi sekarang orde menit-jam untuk series 1s, bukan ratusan jam.
    expect(r.tpDurasi).not.toContain("h ");
    expect(r.tpDurasi).toMatch(/±\d+(m|j)/);
  });

  it("candle 15m normal + bracket intraday 1.2/0.8 → durasi jam, bukan hari", () => {
    // ATR 15m BTC ≈ $150 (0.15%) → step $75; TP 1.2% @100k = $1200 → 16 candle × 15m = 4 jam.
    const c = candles({ n: 30, startTs: 1_700_000_000_000, intervalMs: 900_000, price: 100_000, tr: 150 });
    const p = posAt(100_000, 0.012, 0.008);
    const r = estimatePositionEta(p, 100_000, c);
    expect(r.intervalMs).toBe(900_000);
    expect(r.tpCandles).not.toBeNull();
    expect(r.tpCandles!).toBeLessThanOrEqual(ETA_HORIZON_BARS);
    expect(r.tpBeyondHorizon).toBe(false);
    expect(r.tpDurasi).toMatch(/±\d+j/);
  });

  it("override eksplisit tetap dihormati (kompatibilitas)", () => {
    const c = candles({ n: 20, startTs: 1_700_000_000_000, intervalMs: 60_000, price: 100_000, tr: 20 });
    const p = posAt(100_000, 0.012, 0.008);
    const r = estimatePositionEta(p, 100_000, c, 900_000);
    expect(r.intervalMs).toBe(900_000);
  });
});

describe("P-B: alarm horizon — TP di luar jangkauan TF", () => {
  it("TP 3.5% skala H4 di ATR 15m → tpBeyondHorizon true", () => {
    // ATR 15m $150 → step $75; TP 3.5% = $3500 → 47 candle… pakai ATR lebih kecil
    // agar jelas di luar horizon: TR $60 → step $30 → 117 candle > 48.
    const c = candles({ n: 30, startTs: 1_700_000_000_000, intervalMs: 900_000, price: 100_000, tr: 60 });
    const p = posAt(100_000, 0.035, 0.015);
    const r = estimatePositionEta(p, 100_000, c);
    expect(r.tpCandles!).toBeGreaterThan(ETA_HORIZON_BARS);
    expect(r.tpBeyondHorizon).toBe(true);
  });

  it("candle kosong → null jujur (bukan 0)", () => {
    const r = estimatePositionEta(posAt(100_000, 0.012, 0.008), 100_000, []);
    const e: PositionEta = r;
    expect(e.tpCandles).toBeNull();
    expect(e.tpBeyondHorizon).toBe(false);
  });
});

describe("formatDurasi — smoke", () => {
  it("<1m / menit / jam / hari", () => {
    expect(formatDurasi(10_000)).toBe("<1m");
    expect(formatDurasi(5 * 60_000)).toBe("±5m");
    expect(formatDurasi(2 * 3_600_000 + 15 * 60_000)).toBe("±2j 15m");
    expect(formatDurasi(26 * 3_600_000)).toBe("±1h 2j");
  });
});
