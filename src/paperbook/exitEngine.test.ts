import { describe, it, expect } from "vitest";
import {
  evaluatePositionExits,
  normalizeExitConfig,
  slTightens,
  slOnSaneSide,
} from "./exitEngine";
import { TAKER_FEE_RATE } from "./config";
import type { PaperPosition } from "./types";

/** F9: harga SL break-even sadar-fee (net = 0 setelah fee entry+exit). */
const BE_LONG = 100_000 * ((1 + TAKER_FEE_RATE) / (1 - TAKER_FEE_RATE));
const BE_SHORT = 100_000 * ((1 - TAKER_FEE_RATE) / (1 + TAKER_FEE_RATE));

// ---------------------------------------------------------------------------
// Fixture: posisi LONG entry 100k, SL 98k (risiko awal 2000/unit, 2%), TP 104k.
// ---------------------------------------------------------------------------
function mkPos(over: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: "pos-test-1",
    symbol: "BTC/USDT",
    side: "LONG",
    qty: 0.01,
    entryPrice: 100_000,
    notionalUSD: 1000,
    leverage: 10,
    marginUSD: 100,
    stopLoss: 98_000,
    takeProfit: 104_000,
    liquidationPrice: 90_000,
    maintenanceMarginRate: 0.004,
    openedAt: 1_700_000_000_000,
    status: "OPEN",
    sourceOrderId: "ord-test-1",
    feesPaidUSD: 0.4,
    ...over,
  };
}

const W = (mark: number, high = mark, low = mark, now = 1_700_000_100_000) => ({
  mark,
  high1m: high,
  low1m: low,
  now,
});

function withPlan(pos: PaperPosition, config: any, state: any = {}): PaperPosition {
  return {
    ...pos,
    exitPlan: {
      config,
      state: {
        initialRiskPerUnit: Math.abs(pos.entryPrice - pos.stopLoss),
        breakevenArmed: false,
        takenPartialR: [],
        peakMark: pos.entryPrice,
        ...state,
      },
    },
  };
}

describe("exitEngine — opt-in & no-op", () => {
  it("posisi TANPA exitPlan → tidak ada aksi sama sekali (posisi lama aman)", () => {
    const r = evaluatePositionExits(mkPos(), W(101_000, 101_500, 100_500));
    expect(r.newStopLoss).toBeUndefined();
    expect(r.partialCloseQty).toBeUndefined();
    expect(r.fullCloseReason).toBeUndefined();
    expect(r.statePatch).toBeUndefined();
  });

  it("posisi CLOSED → tidak dievaluasi", () => {
    const r = evaluatePositionExits(mkPos({ status: "CLOSED" }), W(101_000));
    expect(r.newStopLoss).toBeUndefined();
  });
});

describe("exitEngine — break-even otomatis (ratchet + sane side)", () => {
  it("BE @1R: profit capai 1R → SL digeser ke break-even sadar-fee (DI ATAS entry) + armed", () => {
    const pos = withPlan(mkPos(), { breakEvenTriggerR: 1 });
    const r = evaluatePositionExits(pos, W(102_000, 102_300, 101_800));
    expect(r.statePatch?.breakevenArmed).toBe(true);
    expect(r.newStopLoss).toBeCloseTo(BE_LONG, 6);
    expect(r.newStopLoss!).toBeGreaterThan(100_000); // sisi profit, bukan sisi rugi
  });

  it("BE belum tercapai (1R − 1 tick) → tidak armed, SL tetap", () => {
    const pos = withPlan(mkPos(), { breakEvenTriggerR: 1 });
    const r = evaluatePositionExits(pos, W(101_999, 101_999, 101_000));
    expect(r.statePatch?.breakevenArmed ?? false).toBe(false);
    expect(r.newStopLoss).toBeUndefined();
  });

  it("SL sekarang SUDAH lebih ketat dari BE → armed tapi SL tidak digeser mundur", () => {
    // 100_100 > BE 100_080 → ratchet: BE tidak boleh melonggarkan SL.
    const pos = withPlan(mkPos({ stopLoss: 100_100 }), { breakEvenTriggerR: 1 });
    const r = evaluatePositionExits(pos, W(102_500, 102_500, 102_000));
    expect(r.statePatch?.breakevenArmed).toBe(true);
    expect(r.newStopLoss).toBeUndefined(); // BE 100.080 < 100.100 → jangan longgarkan
  });

  it("SHORT simetris: BE di bawah entry (sadar-fee), lebih ketat dari SL awal", () => {
    const pos = withPlan(
      mkPos({ side: "SHORT", stopLoss: 102_000, takeProfit: 96_000, liquidationPrice: 110_000 }),
      { breakEvenTriggerR: 1 }
    );
    const r = evaluatePositionExits(pos, W(98_000, 98_500, 97_800));
    expect(r.statePatch?.breakevenArmed).toBe(true);
    expect(r.newStopLoss).toBeCloseTo(BE_SHORT, 6);
    expect(r.newStopLoss!).toBeLessThan(100_000); // di bawah entry, sisi profit
    expect(r.newStopLoss!).toBeLessThan(102_000);
  });
});

describe("exitEngine — trailing (ratchet murni, sane side)", () => {
  it("trailing LONG: SL = peak×(1−1%), lebih ketat dari SL awal", () => {
    const pos = withPlan(mkPos(), { trailingPct: 1 });
    const r = evaluatePositionExits(pos, W(100_500, 101_000, 100_200));
    expect(r.statePatch?.peakMark).toBe(101_000);
    expect(r.newStopLoss).toBeCloseTo(101_000 * 0.99, 6); // 99,990
    expect(r.newStopLoss!).toBeGreaterThan(98_000);
  });

  it("INVARIAN ratchet: kandidat di bawah SL sekarang → TIDAK pernah longgarkan", () => {
    const pos = withPlan(mkPos({ stopLoss: 99_900 }), { trailingPct: 1 }, { peakMark: 100_000 });
    const r = evaluatePositionExits(pos, W(99_950, 100_000, 99_900));
    expect(r.newStopLoss).toBeUndefined(); // kandidat 99,000 < 99,900
  });

  it("INVARIAN sane side: kandidat ≥ mark (mark crash) → tidak dipancarkan (biar bracket statis menutup)", () => {
    const pos = withPlan(mkPos(), { trailingPct: 1 }, { peakMark: 101_000 });
    const r = evaluatePositionExits(pos, W(98_500, 101_000, 98_400));
    expect(r.newStopLoss).toBeUndefined(); // kandidat 99,990 > mark 98,500
  });

  it("SHORT: trailing dari LEMBAH (peak favorable = low), hanya mengetat", () => {
    const pos = withPlan(
      mkPos({ side: "SHORT", stopLoss: 102_000, takeProfit: 96_000 }),
      { trailingPct: 1 },
      { peakMark: 99_000 }
    );
    const r = evaluatePositionExits(pos, W(99_500, 99_800, 98_800));
    expect(r.statePatch?.peakMark).toBe(98_800);
    expect(r.newStopLoss).toBeCloseTo(98_800 * 1.01, 6); // 99,788
    expect(r.newStopLoss!).toBeLessThan(102_000);
  });
});

describe("exitEngine — partial TP (basis R dibekukan, sekali per level)", () => {
  it("1R tercapai → tutup 50% qty, level ditandai taken", () => {
    const pos = withPlan(mkPos(), {
      partialLevels: [
        { rMultiple: 1, closePct: 50 },
        { rMultiple: 2, closePct: 50 },
      ],
    });
    const r = evaluatePositionExits(pos, W(102_200, 102_200, 101_500));
    expect(r.partialCloseQty).toBeCloseTo(0.005, 9);
    expect(r.partialReason).toBe("PARTIAL_TAKE_PROFIT");
    expect(r.statePatch?.takenPartialR).toEqual([1]);
  });

  it("tidak dobel: window sama dipanggil ulang → tidak ada partial kedua", () => {
    const pos = withPlan(mkPos(), {
      partialLevels: [{ rMultiple: 1, closePct: 50 }],
    });
    const once = evaluatePositionExits(pos, W(102_200, 102_200, 102_000));
    expect(once.partialCloseQty).toBeDefined();
    const after = { ...pos.exitPlan!.state, ...once.statePatch };
    const twice = evaluatePositionExits(withPlan(mkPos(), pos.exitPlan!.config, after), W(102_200, 102_200, 102_000));
    expect(twice.partialCloseQty).toBeUndefined();
  });

  it("gap menembus 2 level sekaligus → qty digabung; total 100% → tutup penuh", () => {
    const pos = withPlan(mkPos(), {
      partialLevels: [
        { rMultiple: 1, closePct: 50 },
        { rMultiple: 2, closePct: 50 },
      ],
    });
    const r = evaluatePositionExits(pos, W(104_500, 104_500, 104_000));
    expect(r.statePatch?.takenPartialR).toEqual([1, 2]);
    expect(r.partialCloseQty).toBe(0.01); // sisa debu 0 → full qty
  });

  it("anchor R dari risiko AWAL (dibekukan), bukan SL yang sudah digeser BE", () => {
    const pos = withPlan(mkPos({ stopLoss: 99_920 }), { partialLevels: [{ rMultiple: 1, closePct: 50 }] }, {
      initialRiskPerUnit: 2_000, // tetap 2% saat plan dipasang
    });
    const r = evaluatePositionExits(pos, W(102_000, 102_000, 101_000));
    // Target 1R = 100,000 + 2,000 = 102,000 — tercapai walau SL sekarang sudah BE.
    expect(r.partialCloseQty).toBeCloseTo(0.005, 9);
  });
});

describe("exitEngine — time stop", () => {
  it("tepat 24 jam sejak openedAt → TIMEOUT; 1 ms sebelumnya belum", () => {
    // 17 Sep 14:30 WIB → 18 Sep 14:30 WIB, bukan pergantian tanggal.
    const openedAt = Date.parse("2026-09-17T07:30:00.000Z");
    const deadline = Date.parse("2026-09-18T07:30:00.000Z");
    const pos = withPlan(mkPos({ openedAt }), { maxHoldMs: 86_400_000 });
    expect(evaluatePositionExits(pos, W(100_500, 100_500, 100_500, deadline - 1)).fullCloseReason).toBeUndefined();
    expect(evaluatePositionExits(pos, W(100_500, 100_500, 100_500, deadline)).fullCloseReason).toBe("TIMEOUT");
  });

  it("umur ≥ maxHoldMs → full close TIMEOUT", () => {
    const pos = withPlan(mkPos(), { maxHoldMs: 24 * 3_600_000 });
    const r = evaluatePositionExits(pos, W(100_500, 100_600, 100_400, 1_700_000_000_000 + 25 * 3_600_000));
    expect(r.fullCloseReason).toBe("TIMEOUT");
  });

  it("belum cukup umur → tidak ada aksi", () => {
    const pos = withPlan(mkPos(), { maxHoldMs: 24 * 3_600_000 });
    const r = evaluatePositionExits(pos, W(100_500, 100_600, 100_400, 1_700_000_000_000 + 2 * 3_600_000));
    expect(r.fullCloseReason).toBeUndefined();
  });
});

describe("normalizeExitConfig — validasi & clamp", () => {
  it("garbage → null", () => {
    expect(normalizeExitConfig(null)).toBeNull();
    expect(normalizeExitConfig("x")).toBeNull();
    expect(normalizeExitConfig([])).toBeNull();
    expect(normalizeExitConfig({})).toBeNull();
    expect(normalizeExitConfig({ trailingPct: 0 })).toBeNull();
  });

  it("clamp: trailingPct 50 → 20; breakEvenTriggerR 99 → 10", () => {
    const cfg = normalizeExitConfig({ trailingPct: 50, breakEvenTriggerR: 99 })!;
    expect(cfg.trailingPct).toBe(20);
    expect(cfg.breakEvenTriggerR).toBe(10);
  });

  it("partialLevels: di-sort naik, item invalid dibuang, total > 100% ditolak", () => {
    const cfg = normalizeExitConfig({
      partialLevels: [
        { rMultiple: 2, closePct: 40 },
        { rMultiple: 1, closePct: 30 },
        { rMultiple: "bukan-angka", closePct: 10 },
      ],
    })!;
    expect(cfg.partialLevels).toEqual([
      { rMultiple: 1, closePct: 30 },
      { rMultiple: 2, closePct: 40 },
    ]);
    expect(
      normalizeExitConfig({ partialLevels: [{ rMultiple: 1, closePct: 60 }, { rMultiple: 2, closePct: 60 }] })
    ).toBeNull();
  });

  it("maxHoldMs di bawah 1 menit ditolak", () => {
    expect(normalizeExitConfig({ maxHoldMs: 5_000 })).toBeNull();
    expect(normalizeExitConfig({ maxHoldMs: 3_600_000 })?.maxHoldMs).toBe(3_600_000);
  });
});

describe("helper ratchet", () => {
  it("slTightens: LONG naik = ketat, turun = longgar; SHORT kebalikannya", () => {
    const long = mkPos();
    const short = mkPos({ side: "SHORT", stopLoss: 102_000, takeProfit: 96_000 });
    expect(slTightens(long, 98_500)).toBe(true);
    expect(slTightens(long, 97_500)).toBe(false);
    expect(slTightens(short, 101_500)).toBe(true);
    expect(slTightens(short, 103_000)).toBe(false);
  });

  it("slOnSaneSide: LONG SL harus di bawah mark; SHORT di atas", () => {
    const long = mkPos();
    const short = mkPos({ side: "SHORT", stopLoss: 102_000, takeProfit: 96_000 });
    expect(slOnSaneSide(long, 99_000, 100_000)).toBe(true);
    expect(slOnSaneSide(long, 100_500, 100_000)).toBe(false);
    expect(slOnSaneSide(short, 101_000, 100_000)).toBe(true);
    expect(slOnSaneSide(short, 99_500, 100_000)).toBe(false);
  });
});