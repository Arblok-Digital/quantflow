import { describe, expect, it } from "vitest";
import { makeIntradayDraft, formatDeadlineWib, ADVISOR_PLAN_TTL_MS } from "./intradayPlan";

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const LONG = { entry: 100, stopLoss: 98, takeProfit: 104 };

describe("makeIntradayDraft — strict, tanpa harga fiktif", () => {
  it("LONG valid → draft dengan deadline anchor createdAt", () => {
    const d = makeIntradayDraft("BTC/USDT", "FUTURES", "BULLISH", LONG, NOW - 1000, NOW);
    expect(d).toEqual({ symbol: "BTC/USDT", marketType: "FUTURES", side: "LONG", ...LONG, createdAt: NOW - 1000 });
  });

  it("bias netral/tidak dikenal → null (jangan mengarang arah)", () => {
    expect(makeIntradayDraft("BTC/USDT", "FUTURES", "NEUTRAL", LONG, NOW - 1000, NOW)).toBeNull();
  });

  it("insight kedaluwarsa (>TTL atau dari masa depan) → null", () => {
    expect(makeIntradayDraft("BTC/USDT", "FUTURES", "BULLISH", LONG, NOW - ADVISOR_PLAN_TTL_MS - 1, NOW)).toBeNull();
    expect(makeIntradayDraft("BTC/USDT", "FUTURES", "BULLISH", LONG, NOW + 1, NOW)).toBeNull();
  });

  it("bracket salah arah / level tidak berhingga → null", () => {
    expect(makeIntradayDraft("BTC/USDT", "FUTURES", "LONG", { entry: 100, stopLoss: 102, takeProfit: 104 }, NOW - 1000, NOW)).toBeNull();
    expect(makeIntradayDraft("BTC/USDT", "FUTURES", "LONG", { entry: 100, stopLoss: Number.NaN, takeProfit: 104 }, NOW - 1000, NOW)).toBeNull();
  });

  it("SPOT SHORT ditolak", () => {
    expect(makeIntradayDraft("BTC/USDT", "SPOT", "SHORT", { entry: 100, stopLoss: 102, takeProfit: 98 }, NOW - 1000, NOW)).toBeNull();
  });

  it("SHORT valid: TP < entry < SL", () => {
    const d = makeIntradayDraft("BTC/USDT", "FUTURES", "BEARISH", { entry: 100, stopLoss: 102, takeProfit: 98 }, NOW - 1000, NOW);
    expect(d?.side).toBe("SHORT");
  });
});

describe("formatDeadlineWib", () => {
  it("menampilkan WIB eksplisit (UTC+7), bukan tanggal server lokal", () => {
    expect(formatDeadlineWib(Date.parse("2026-09-18T07:30:00.000Z"))).toContain("WIB");
    expect(formatDeadlineWib(Date.parse("2026-09-18T07:30:00.000Z"))).toMatch(/18/);
    expect(formatDeadlineWib(Number.NaN)).toBe("—");
  });
});
