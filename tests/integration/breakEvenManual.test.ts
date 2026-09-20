// =====================================================================
// P0-03 — BE manual & BE otomatis: fee AKTUAL entry, offset dipakai,
// arm hanya saat proteksi valid, jangan longgarkan SL.
//
// Expected (dihitung dari persamaan ekonomi, BUKAN salinan output):
//   - Entry taker E=100, qty=10, fee T=0.0004 → feesPaidUSD=0.40.
//       LONG  X = (E*q + F)/(q*(1-T)) = (1000 + 0.40)/(10*0.9996) ≈ 100.080...
//       SHORT X = (E*q - F)/(q*(1+T)) = (1000 - 0.40)/(10*1.0004) ≈ 99.920...
//   - Manual BE (updatePaperPosition breakEven:true, mark segar di sisi benar):
//       LONG  mark 101 → BE 100.08 diterapkan, SL tidak lebih besar dari mark.
//       SHORT mark 99  → BE 99.92 diterapkan, SL tidak lebih kecil dari mark.
//   - RATCHET: SL sudah > BE (LONG, mis. 100.5) → BE TIDAK melonggarkan SL.
//   - Stale mark (lastMarkUpdatedAt lama) → MANUAL_BE_SKIPPED MARK_STALE.
//   - Mark di sisi salah (LONG mark 100 < BE 100.08) → SKIP, SL tidak digeser.
//   - HTTP: position/update breakEven:true mengembalikan position.breakEven,
//     FE tidak menampilkan "digeser" padahal di-skip.
//   - BE otomatis MENGGUNAKAN offset config (bukan diam-diam diabaikan) dan
//     TIDAK arm bila mark tidak menunjang BE.
//
// ISOLASI: sandbox TEST per test (bukan DB pengguna). App static, satu graph.
// =====================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TAKER_FEE = 0.0004;
const INITIAL_CASH = 10000;
const originalCwd = process.cwd();
let sandboxDir = "";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.TRADING_MODE = "paper";
  process.env.AUTH_PASSCODE = "test-passcode";
  process.env.VITE_ENABLED = "false";
  process.env.BROKER_EVENT_SECRET = "be-manual-test-secret";
  process.env.AUDIT_HMAC_SECRET = "be-manual-audit-hmac-0123456789abcdef";
});

const feed = vi.hoisted(() => ({
  stage: 0,
  calls: 0,
  depths: [] as Array<{ asks: number[][]; bids: number[][] }>,
  next() {
    const d = this.depths[this.stage] || this.depths[this.depths.length - 1];
    this.stage++;
    this.calls++;
    return d;
  },
  reset() {
    this.stage = 0;
    this.calls = 0;
    this.depths = [];
  },
}));

const exchangeStub = vi.hoisted(() => ({
  fetchOrderBook: async () => feed.next(),
  fetchTicker: async () => ({ bid: 99.9, ask: 100.1 }),
  loadMarkets: async () => {},
  fetchPositions: async () => [],
  fetchBalance: async () => ({ total: { USDT: INITIAL_CASH } }),
  fetchOpenOrders: async () => [],
}));

vi.mock("../../broker", () => ({
  getExchange: () => exchangeStub,
  ensureMarketsLoaded: async () => {},
  clearExchangeCache: () => {},
  getBrokerStatus: () => ({
    mode: "paper",
    canPlaceLiveOrders: false,
    exchangeId: "binance",
    testnet: false,
    credentialsConfigured: false,
    credentialSource: "none",
    liveArmed: false,
    armedForLive: false,
  }),
  setLiveArmed: async () => {},
  fetchCcxtTicker: async (_s: string) => ({ symbol: _s, bid: 99.9, ask: 100.1 }),
  fetchCcxtOrderBook: async (_s: string) => ({ symbol: _s, bids: [[99.9, 5]], asks: [[100.0, 5]] }),
  fetchCcxtOHLCV: async (_s: string) => ({ symbol: _s, candles: [] }),
  fetchBrokerBalance: async () => ({ total: { USDT: INITIAL_CASH } }),
  placeBrokerOrder: async (b: any) => ({ success: true, ...b }),
  saveBrokerCredentials: async () => ({ success: true }),
  clearBrokerCredentials: async () => {},
  testBrokerConnection: async () => ({ success: true }),
  getVaultCredentialsStatus: () => ({ configured: false, source: "none", testnet: false }),
}));

vi.mock("../../src/data/marketFetcher", () => ({
  fetchTickerPrice: async () => ({ ok: true, price: 100 }),
}));

const guardState = vi.hoisted(() => ({ killSwitch: false as boolean, lossPercent: 0 as number }));

vi.mock("../../guardrails", () => {
  class GuardrailRejectedError extends Error {
    reason: string;
    code: string;
    constructor(reason: string, message: string) {
      super(message);
      this.name = "GuardrailRejectedError";
      this.reason = reason;
      this.code = reason;
    }
  }
  return {
    GuardrailRejectedError,
    initGuardrails: () => {},
    evaluateGuardrails: async () => ({
      allowed: true,
      reasons: [],
      details: { killSwitch: false, dailyLossPercent: 0, maxDailyLossPercent: 10, realizedPnlUSD: 0 },
    }),
    setKillSwitch: (active: boolean) => ({ killSwitch: Boolean(active) }),
    setGuardsEnabled: (active: boolean) => ({ ok: true, guardsEnabled: Boolean(active) }),
    recordOrderPlaced: () => {},
    getTodayRealized: () => ({ realizedPnlUSD: 0, lossPercent: guardState.lossPercent }),
    getGuardrailsSnapshotSync: () => ({
      config: {},
      state: { killSwitch: false, openCount: 0, armedForLive: false, guardsEnabled: true },
      today: { realizedPnlUSD: 0, lossPercent: 0 },
    }),
    getGuardrailsSnapshotAsync: async () => ({
      config: {},
      state: { killSwitch: false, openCount: 0, armedForLive: false, guardsEnabled: true },
      today: { realizedPnlUSD: 0, lossPercent: 0 },
    }),
  };
});

import { app } from "../../server";
const appHttp: Express = app;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-18T00:00:00.000Z"));
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantflow-be-manual-"));
  process.chdir(sandboxDir);
  feed.reset();
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.useRealTimers();
  if (sandboxDir) rmSafe(sandboxDir);
  sandboxDir = "";
});

function rmSafe(dir: string): void {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (Date.now() > deadline) {
        fs.rmSync(dir, { recursive: true, force: true });
        return;
      }
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* busy-wait singkat */
      }
    }
  }
}

async function initTestDb() {
  const { initDb, closeDb } = await import("../../db");
  initDb();
  const store = await import("../../src/paperbook/store");
  Object.assign(store.state, store.freshState());
  return { closeDb, store };
}

async function withDb<T>(fn: (s: Awaited<ReturnType<typeof initTestDb>>) => Promise<T>): Promise<T> {
  const s = await initTestDb();
  try {
    return await fn(s);
  } finally {
    s.closeDb();
  }
}

async function login(): Promise<string> {
  const res = await request(appHttp).post("/api/auth/login").send({ passcode: "test-passcode" });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

// Persamaan BE sadar-fee (P0-03) — dihitung di test, BUKAN dari kode aplikasi.
const beLong = (entry: number, q: number, feesPaidUSD: number) =>
  (entry * q + feesPaidUSD) / (q * (1 - TAKER_FEE));
const beShort = (entry: number, q: number, feesPaidUSD: number) =>
  (entry * q - feesPaidUSD) / (q * (1 + TAKER_FEE));

describe("P0-03 — BE manual (store.updatePaperPosition)", () => {
  it("LONG: mark segar di atas BE → SL digeser ke titik BE sadar-fee; breakEven.applied=true", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });
    await withDb(async ({ store }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      } as any);
      expect(Number(pos.feesPaidUSD)).toBeCloseTo(10 * 100 * TAKER_FEE, 4); // 0.4
      // Mark SEGAR (mengikuti bracketMonitor: lastMark/lastMarkUpdatedAt ditulis tiap pass).
      const live = store.state.positions.find((p) => p.id === pos.id)!;
      live.lastMark = 101;
      live.lastMarkUpdatedAt = Date.now();

      const updated = store.updatePaperPosition(pos.id, { breakEven: true });
      const expected = beLong(100, 10, 0.4); // ≈ 100.080032
      expect(updated.stopLoss).toBeCloseTo(expected, 6);
      expect((updated as any).breakEven?.applied).toBe(true);

      // DB persist konsisten.
      const { getDb } = await import("../../db");
      const row = getDb().prepare("SELECT stop_loss FROM positions WHERE id = ?").get(pos.id) as any;
      expect(Number(row.stop_loss)).toBeCloseTo(expected, 6);
    });
  });

  it("SHORT: BE di bawah entry sadar-fee; mark segar di sisi benar → diterapkan", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });
    await withDb(async ({ store }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "sell", qty: 10, leverage: 10, stopLoss: 102, takeProfit: 96,
      } as any);
      const live = store.state.positions.find((p) => p.id === pos.id)!;
      live.lastMark = 99; // di atas BE SHORT ≈ 99.92? NO: 99 < 99.92 → sisi SALAH.
      // Gunakan mark 99.95 → di bawah BE? SHORT: SL harus > mark. BE≈99.92, mark 99.5 → sane.
      live.lastMark = 99.5;
      live.lastMarkUpdatedAt = Date.now();

      const updated = store.updatePaperPosition(pos.id, { breakEven: true });
      const expected = beShort(100, 10, 0.4); // ≈ 99.920032
      expect(updated.stopLoss).toBeCloseTo(expected, 6);
      expect((updated as any).breakEven?.applied).toBe(true);
    });
  });

  it("RATCHET: SL sudah lebih ketat dari BE → tidak melonggarkan SL; applied=false ALREADY_TIGHTER", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });
    await withDb(async ({ store }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      } as any);
      const live = store.state.positions.find((p) => p.id === pos.id)!;
      // Simulasi trailing sudah mengetat: SL sekarang 100.5 > BE 100.08.
      live.stopLoss = 100.5;
      live.lastMark = 101;
      live.lastMarkUpdatedAt = Date.now();
      const slBefore = live.stopLoss;

      const updated = store.updatePaperPosition(pos.id, { breakEven: true });
      expect(updated.stopLoss).toBe(slBefore); // 100.5 > BE 100.08 → tidak digeser mundur
      expect((updated as any).breakEven?.applied).toBe(false);
      expect((updated as any).breakEven?.reason).toBe("ALREADY_TIGHTER");
    });
  });

  it("mark STALE (lastMarkUpdatedAt basi) → SKIP MARK_STALE, SL tidak digeser", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });
    await withDb(async ({ store }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      } as any);
      const live = store.state.positions.find((p) => p.id === pos.id)!;
      live.lastMark = 101; // harga cocok, tapi STALE:
      live.lastMarkUpdatedAt = Date.now() - 60_000; // >> MARK_TTL_MS (3000)

      const updated = store.updatePaperPosition(pos.id, { breakEven: true });
      expect(updated.stopLoss).toBe(98);
      expect((updated as any).breakEven?.applied).toBe(false);
      expect((updated as any).breakEven?.reason).toBe("MARK_STALE");
    });
  });

  it("mark di sisi SALAH (LONG mark < BE) → SKIP WRONG_SIDE_VS_MARK, SL tidak digeser", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });
    await withDb(async ({ store }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      } as any);
      const live = store.state.positions.find((p) => p.id === pos.id)!;
      live.lastMark = 100; // BELUM profit: mark 100 < BE 100.08
      live.lastMarkUpdatedAt = Date.now();

      const updated = store.updatePaperPosition(pos.id, { breakEven: true });
      expect(updated.stopLoss).toBe(98);
      expect((updated as any).breakEven?.applied).toBe(false);
      expect((updated as any).breakEven?.reason).toBe("WRONG_SIDE_VS_MARK");
    });
  });
});

describe("P0-03 — BE manual via HTTP (respons jujur untuk FE)", () => {
  it("mark belum menunjang → 200 tapi position.breakEven.applied=false + reason", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });
    await withDb(async () => {
      const token = await login();
      const open = await request(appHttp)
        .post("/api/broker/order")
        .set("Authorization", `Bearer ${token}`)
        .send({ symbol: "BTC/USDT", side: "buy", amount: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });
      expect(open.status).toBe(200);
      const positionId = open.body.position.id as string;

      const be = await request(appHttp)
        .post("/api/broker/position/update")
        .set("Authorization", `Bearer ${token}`)
        .send({ positionId, breakEven: true });
      expect(be.status).toBe(200);
      expect(be.body.success).toBe(true);
      // Mark default dari open = entry 100 < BE → tidak menunjang.
      expect(be.body.position.breakEven.applied).toBe(false);
      expect(be.body.position.breakEven.reason).toBe("WRONG_SIDE_VS_MARK");

      const posRes = await request(appHttp).get("/api/broker/positions").set("Authorization", `Bearer ${token}`);
      const p = posRes.body.positions.find((x: any) => x.id === positionId);
      expect(p).toBeDefined();
      expect(p.stopLoss).toBeCloseTo(98, 6); // tidak digeser
    });
  });
});