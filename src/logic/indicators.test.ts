import { describe, it, expect } from "vitest";
import { calculateMACD, calculateRSI, calculateEMA } from "./indicators";

describe("calculateMACD (standar EMA 12/26/9)", () => {
  it("histogram BUKAN 15% macdLine yang konstan", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 2);
    const r = calculateMACD(closes);
    const ratio = r.histogram / r.macdLine;
    // Formula lama yang salah selalu menghasilkan rasio tepat 0.15.
    expect(Math.abs(ratio - 0.15)).toBeGreaterThan(0.01);
    // Signal harus dekat macd (EMA dari series), bukan 85% macd.
    expect(Math.abs(r.signalLine - r.macdLine)).toBeLessThan(Math.abs(r.macdLine * 0.85 - r.macdLine) + Math.abs(r.macdLine) * 0.5);
    expect(r.histogram).toBeCloseTo(r.macdLine - r.signalLine, 1);
  });

  it("flat market -> nol semua", () => {
    const flat = Array.from({ length: 60 }, () => 100);
    expect(calculateMACD(flat)).toEqual({ macdLine: 0, signalLine: 0, histogram: 0 });
  });

  it("data kurang dari 26 -> nol (fail-closed)", () => {
    expect(calculateMACD([1, 2, 3])).toEqual({ macdLine: 0, signalLine: 0, histogram: 0 });
  });

  it("RSI/EMA tetap konsisten", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    expect(calculateRSI(closes, 14)).toBeGreaterThan(50);
    expect(calculateEMA(closes, 20)).toBeGreaterThan(calculateEMA(closes, 50));
  });
});
