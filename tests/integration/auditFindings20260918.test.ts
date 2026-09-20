/**
 * Regression pack untuk temuan LOGIC_AUDIT_2026-09-18.md.
 * Setiap test mengunci perilaku PERBAIKAN (bukan status quo bug):
 *  - CRIT-1  probabilitas shrink ≥ 50% pada sample tipis (bug lama 0.15× drift → 7.5%)
 *  - CRIT-2  kill-switch state bertahan melewati restart (persist .keel-kill-switch.json)
 *  - CRIT-3  equity live = kas + Σ unrealizedPnl posisi open
 *  - WARN-1  policy risiko default satu sumber: orderRiskGate === riskConstants,
 *            keelAdapter membaca dari keel RISK_CONSTANTS (maxPositionSizePct 5)
 *  - WARN-4  skor confluence bertanda sesuai arah (BEARISH → "-72%")
 *  - WARN-6  roundTo simetris untuk nilai negatif (.5 boundary)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shrinkAdjustedProbability } from "../../src/logic/probabilityEngine";
import {
  engageKillSwitch,
  disengageKillSwitch,
  isKillSwitchActiveTx,
  loadLatestEvents,
  loadKillSwitchEventsFromDisk,
  resetVolatileLatchForTests,
  resetPersistedLoadedFlagForTests,
} from "../../src/logic/keel/risk/kill-switch";
import { store } from "../../src/logic/keel/store";
import { lastKillSwitchEvent } from "../../src/logic/keel/store";
import { composeEquityFromPositions } from "../../broker";
import { defaultOrderRiskPolicy } from "../../src/logic/orderRiskGate";
import { DEFAULT_RISK_POLICY } from "../../src/logic/riskConstants";
import { evaluateKeelRisk } from "../../src/logic/keelAdapter";
import { signedConfluencePercent } from "../../src/logic/keel/mm-brain/signal-generator";
import { roundTo } from "../../src/paperbook/fill";
import { r2 as replayR2, r4 as replayR4 } from "../../src/replay/replayEngine";

// ---------------------------------------------------------------------------
// CRIT-1 — probabilityEngine: overdampening 0.15× menuju prior
// ---------------------------------------------------------------------------
describe("CRIT-1 probability shrinkage menuju prior dingin", () => {
  it("t=20 win=11 → p ≈ 0.5275 (bukan 0.194 dari bug 0.15×)", () => {
    // raw = 0.55; shrink = 20/80 = 0.25; p = 0.55*0.25 + 0.52*0.75 = 0.5275
    const p = shrinkAdjustedProbability(11, 20);
    expect(p).toBeCloseTo(0.5275, 4);
    expect(p).toBeGreaterThanOrEqual(0.5);
  });

  it("tanpa data → COLD_PRIOR_P (0.52), bukan 0.5 + shrink ke arah sama", () => {
    expect(shrinkAdjustedProbability(0, 0)).toBeCloseTo(0.52, 4);
  });

  it("sample penuh (total ≥ 80) → murni raw rate", () => {
    expect(shrinkAdjustedProbability(72, 80)).toBeCloseTo(0.9, 4);
  });
});

// ---------------------------------------------------------------------------
// CRIT-2 — kill-switch state persisten lintas restart
// ---------------------------------------------------------------------------
describe("CRIT-2 kill-switch persist", () => {
  let sandbox = "";
  const prevCwd = process.cwd();
  const ksFile = () => join(sandbox, ".keel-kill-switch.json");

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "audit-ks-"));
    process.chdir(sandbox);
  });
  afterEach(() => {
    resetVolatileLatchForTests();
    resetPersistedLoadedFlagForTests();
    process.chdir(prevCwd);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("engage menulis state ke disk dan AKTIF bertahan setelah restart", async () => {
    const { eventId } = await engageKillSwitch({ actorId: "auditor", reason: "CRIT-2 regression" });
    expect(eventId).toBeTruthy();
    expect(existsSync(ksFile())).toBe(true);

    // Simulasi restart: memory di-reset penuh, lalu load ulang dari disk.
    store.reset();
    resetVolatileLatchForTests();
    resetPersistedLoadedFlagForTests();
    await loadKillSwitchEventsFromDisk();

    expect(await isKillSwitchActiveTx()).toBe(true);
    const events = await loadLatestEvents();
    expect(events.at(-1)?.isActive).toBe(true);
  });

  it("disengage menulis state AKTIF=false dan bertahan setelah restart", async () => {
    await engageKillSwitch({ actorId: "auditor", reason: "engage lalu disengage" });
    await disengageKillSwitch("auditor");
    expect(existsSync(ksFile())).toBe(true);

    store.reset();
    resetVolatileLatchForTests();
    resetPersistedLoadedFlagForTests();
    await loadKillSwitchEventsFromDisk();

    expect(await isKillSwitchActiveTx()).toBe(false);
    expect((await loadLatestEvents()).at(-1)?.isActive).toBe(false);
  });

  it("tanpa file state → status clean (tidak ada aktivasi palsu)", async () => {
    expect(existsSync(ksFile())).toBe(false);
    resetPersistedLoadedFlagForTests();
    await loadKillSwitchEventsFromDisk();
    expect(await isKillSwitchActiveTx()).toBe(false);
  });

  it("WIRING: boot-load mengaktifkan KEEL gate (lastKillSwitchEvent) tanpa reload manual", async () => {
    // Gap yang dilaporkan verifier: keelAdapter.ts:496 baca store in-memory
    // (lastKillSwitchEvent) — mekanisme persistence ada, tapi TIDAK ada pemanggil
    // produksi setelah restart. Test ini mengunci bahwa fungsi yang server.ts
    // jalankan saat boot (loadKillSwitchEventsFromDisk) menyalakan gate tsb.
    const { eventId } = await engageKillSwitch({ actorId: "auditor", reason: "CRIT-2 wiring" });
    expect(eventId).toBeTruthy();
    expect(existsSync(ksFile())).toBe(true);

    // Restart penuh: memory, latch, dan flag 'sudah load' di-reset.
    store.reset();
    resetVolatileLatchForTests();
    resetPersistedLoadedFlagForTests();

    // PRE-FIX: keel gate buta walau file aktif ada.
    expect(lastKillSwitchEvent()).toBeUndefined();

    // BOOT WIRING = panggilan yang sama dengan server.ts (setelah initGuardrails).
    await loadKillSwitchEventsFromDisk();

    expect(lastKillSwitchEvent()?.isActive).toBe(true);
    expect(await isKillSwitchActiveTx()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CRIT-3 — equity live = kas + unrealized PnL
// ---------------------------------------------------------------------------
describe("CRIT-3 komposisi equity live", () => {
  it("menjumlahkan unrealizedPnl semua posisi di atas saldo kas", () => {
    expect(composeEquityFromPositions(10000, [
      { unrealizedPnl: 250 },
      { unrealizedPnl: -40 },
    ])).toBe(10210);
  });

  it("posisi kosong / util tanpa unrealized → USD cash", () => {
    expect(composeEquityFromPositions(10000, [])).toBe(10000);
    expect(composeEquityFromPositions(10000, [{ unrealizedPnl: null }, {}, { unrealizedPnl: undefined }])).toBe(10000);
  });

  it("fraksi dibulatkan 2 desimal", () => {
    expect(composeEquityFromPositions(10000, [{ unrealizedPnl: 0.565 }])).toBe(10000.57);
  });
});

// ---------------------------------------------------------------------------
// WARN-1 — policy default satu sumber
// ---------------------------------------------------------------------------
describe("WARN-1 risk constants single source", () => {
  it("defaultOrderRiskPolicy konsisten dengan DEFAULT_RISK_POLICY", () => {
    const policy = defaultOrderRiskPolicy();
    expect(policy.maxRiskPerTradePercent).toBe(DEFAULT_RISK_POLICY.MAX_RISK_PER_TRADE_PCT);
    expect(policy.maxNotionalPercent).toBe(DEFAULT_RISK_POLICY.MAX_NOTIONAL_PCT);
    expect(policy.minRiskRewardRatio).toBe(DEFAULT_RISK_POLICY.MIN_RISK_REWARD_RATIO);
  });

  it("keelAdapter memakai keel RISK_CONSTANTS (maxPositionSizePct = 5.0) — bukan literal lain", () => {
    store.reset();
    resetVolatileLatchForTests();
    expect(evaluateKeelRisk({ venue: "BINANCE_SPOT", action: "BUY", sizePct: 3.0, stopLossPct: -2.0 }, 10000).passed).toBe(true);
    store.reset();
    resetVolatileLatchForTests();
    expect(evaluateKeelRisk({ venue: "BINANCE_SPOT", action: "BUY", sizePct: 5.5, stopLossPct: -2.0 }, 10000).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WARN-4 — skor confluence bertanda sesuai arah
// ---------------------------------------------------------------------------
describe("WARN-4 signed confluence score", () => {
  it("BEARISH → minus", () => {
    expect(signedConfluencePercent("BEARISH", 0.8)).toBe("-80");
    expect(signedConfluencePercent("BEARISH", 0.43)).toBe("-43");
  });
  it("BULLISH → plus (tanpa tanda)", () => {
    expect(signedConfluencePercent("BULLISH", 0.6)).toBe("60");
  });
  it("NEUTRAL → 0", () => {
    expect(signedConfluencePercent("NEUTRAL", 0.55)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// WARN-6 — roundTo simetris untuk nilai negatif
// ---------------------------------------------------------------------------
describe("WARN-6 roundTo simetris", () => {
  it("boundary negatif TIDAK lagi bias ke arah nol (bug lama +EPS selalu)", () => {
    // Lama: (n+EPS)*f → -0.005 membulat menjadi -0 (kerugian dikecilkan).
    // Baru: epsilon bertanda → -0.005 → -0.01, +0.005 → +0.01 (simetris).
    expect(roundTo(-0.005, 2)).toBe(-0.01);
    expect(roundTo(0.005, 2)).toBe(0.01);
    expect(roundTo(-0.015, 2)).toBe(-0.02);
    expect(roundTo(0.015, 2)).toBe(0.02);
  });
  it("representasi di atas ambang membulat naik (half-up konsisten)", () => {
    expect(roundTo(0.34, 2)).toBe(0.34);
    expect(roundTo(0.345, 2)).toBe(0.35); // 0.345 float ≈ 34.5000…004 → half-up
    expect(roundTo(0.35, 2)).toBe(0.35);
  });
  it("regression: rounding loss ledger (non-boundary) tidak berubah & simetris", () => {
    expect(roundTo(-50.784, 2)).toBe(-50.78);
    expect(-roundTo(50.784, 2)).toBe(-50.78);
    expect(roundTo(-0.16, 2)).toBe(-roundTo(0.16, 2));
  });
});

// ---------------------------------------------------------------------------
// WARN-6 (extend) — polish: helpers replay harus memakai SAMA implementasi
// ---------------------------------------------------------------------------
describe("WARN-6 roundTo di jalur replay (satu implementasi)", () => {
  it("replay r2 mengikuti epsilon bertanda (bukan lambat bias +EPS)", () => {
    // Lama: replay r2 = Math.round((v + EPSILON)*100)/100 → -0.005 menjadi -0.
    expect(replayR2(-0.005)).toBe(-0.01);
    expect(replayR2(0.005)).toBe(0.01);
    expect(replayR2(-0.015)).toBe(-0.02);
    expect(replayR2(0.015)).toBe(0.02);
  });
  it("replay r2 identik dengan roundTo lib pada non-boundary", () => {
    expect(replayR2(-50.784)).toBe(roundTo(-50.784, 2));
    expect(replayR2(50.784)).toBe(roundTo(50.784, 2));
  });
  it("replay r4 simetris di ambang 3-desimal", () => {
    expect(replayR4(-0.0005)).toBe(roundTo(-0.0005, 4));
    expect(replayR4(0.0005)).toBe(roundTo(0.0005, 4));
  });
});