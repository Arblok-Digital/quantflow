import { describe, it, expect } from "vitest";
import { liquidationPrice, calculateMargin, calculateEquity, clampLeverage } from "./margin";

describe("liquidationPrice", () => {
  it("LONG lev10 entry 100 → harga likuidasi di ~90.x (100 × 0.905)", () => {
    expect(liquidationPrice(100, 10, "LONG")).toBe(90.5);
  });

  it("SHORT lev10 entry 100 → harga likuidasi di ~110.x", () => {
    expect(liquidationPrice(100, 10, "SHORT")).toBe(109.5);
  });

  it("lev50 lebih ketat (lebih dekat ke entry) daripada lev10", () => {
    const longLev10 = Math.abs(liquidationPrice(100, 10, "LONG") - 100);
    const longLev50 = Math.abs(liquidationPrice(100, 50, "LONG") - 100);
    const shortLev10 = Math.abs(liquidationPrice(100, 10, "SHORT") - 100);
    const shortLev50 = Math.abs(liquidationPrice(100, 50, "SHORT") - 100);
    expect(longLev50).toBeLessThan(longLev10);
    expect(shortLev50).toBeLessThan(shortLev10);
  });

  it("lev 0 diperlakukan sebagai leverage 1 (bukan divide-by-zero)", () => {
    expect(liquidationPrice(100, 0, "LONG")).toBe(0.5);
    expect(liquidationPrice(100, -3, "LONG")).toBe(0.5);
  });

  it("lev > 50 di-clamp ke maksimum 50", () => {
    expect(liquidationPrice(100, 100, "LONG")).toBe(liquidationPrice(100, 50, "LONG"));
    expect(liquidationPrice(100, 999, "SHORT")).toBe(liquidationPrice(100, 50, "SHORT"));
    expect(clampLeverage(999)).toBe(50);
  });
});

describe("calculateMargin", () => {
  it("margin = notional / leverage", () => {
    expect(calculateMargin(10000, 10)).toBe(1000);
    expect(calculateMargin(50000, 20)).toBe(2500);
  });

  it("lev 0 → margin penuh (notional / 1)", () => {
    expect(calculateMargin(10000, 0)).toBe(10000);
  });
});

describe("calculateEquity", () => {
  it("equity = cash + lockedMargin + uPnL", () => {
    expect(calculateEquity(5000, 2500, 125)).toBe(7625);
    expect(calculateEquity(5000, 2500, -300)).toBe(7200);
  });
});