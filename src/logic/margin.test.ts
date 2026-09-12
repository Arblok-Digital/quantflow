import { describe, it, expect } from "vitest";
import { liquidationPrice, calculateMargin, calculateEquity, clampLeverage, MAINTENANCE_MARGIN_RATE, TIER1_NOTIONAL_CAP_USD } from "./margin";

describe("liquidationPrice", () => {
  it("LONG lev10 entry 100 → 100 × (1 - 0.1 + 0.004) = 90.4 (Binance USDT-M tier-1 MMR 0.4%)", () => {
    expect(liquidationPrice(100, 10, "LONG")).toBe(90.4);
  });

  it("SHORT lev10 entry 100 → 100 × (1 + 0.1 - 0.004) = 109.6 (Binance USDT-M tier-1 MMR 0.4%)", () => {
    expect(liquidationPrice(100, 10, "SHORT")).toBe(109.6);
  });

  it("MMR uses Binance USDT-M tier-1 rate (0.004), not 0.005", () => {
    expect(MAINTENANCE_MARGIN_RATE).toBe(0.004);
    expect(TIER1_NOTIONAL_CAP_USD).toBe(2_000_000);
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
    expect(liquidationPrice(100, 0, "LONG")).toBe(0.4);
    expect(liquidationPrice(100, -3, "LONG")).toBe(0.4);
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

describe("Binance USDT-M liquidation invariants", () => {
  it("liquidation consumes initial margin net of maintenance buffer before fees", () => {
    const entry = 100;
    const qty = 1;
    const lev = 10;
    const margin = entry * qty / lev;
    const longGrossLoss = (entry - liquidationPrice(entry, lev, "LONG")) * qty;
    const shortGrossLoss = (liquidationPrice(entry, lev, "SHORT") - entry) * qty;
    expect(longGrossLoss).toBeCloseTo(margin - entry * qty * MAINTENANCE_MARGIN_RATE, 6);
    expect(shortGrossLoss).toBeCloseTo(margin - entry * qty * MAINTENANCE_MARGIN_RATE, 6);
  });
});