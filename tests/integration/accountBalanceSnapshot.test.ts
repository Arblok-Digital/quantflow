// =====================================================================
// P0-01 — Satu hitungan account/snapshot/balance.
//
// Prioritas: reserved margin (limit NEW) harus konsisten melalui tiga
// jalur — getPaperAccount(), persistSnapshot() ke SQLite, dan
// getPaperBalance() — sehingga:
//   1. limit NEW menurunkan free cash, TIDAK menurunkan equity.
//   2. equity di snapshot SEHARUSNYA = equity dari getPaperAccount()
//      (sebelumnya snapshot mengabaikan reservedMargin → phantom drawdown
//       pada equity curve / maxDrawdown).
//   3. balance.used = marginLocked + reservedMargin; total = free + used.
//   4. cancel/fill/restart tidak menghilangkan atau menggandakan PnL atau
//      menimbulkan drawdown semu.
//
// Semua expected dihitung manual dari ekonomi, bukan disalin dari output.
//
// Fee:
//   MAKER = 0.0002 (2 bps) — limit order fill.
//   TAKER = 0.0004 (4 bps) — market order fill.
//
// Fixture:
//   Limit BUY 0.5 BTC @ 90, lev 10 → notional 45, margin 4.5.
//   SL 89.5, TP 92:
//     stopDist = (90-89.5)/90 = 0.556%  (> 0.35%)
//     reward   = (92-90)/90 = 2.22%
//     RR       = 2.22 / 0.556 = 4.0     (> 1.5)
//     notional = 0.45% equity            (< 25%)
//     risk     = 0.5/90*45 = 0.25 → 0.0025% equity  (< 1%)
//   → passes orderRiskGate dengan equity 10000.
//
// Cakupan:
//   1) Unit — limit NEW, cancel, fill via store langsung + SQLite nyata.
//   2) HTTP — limit NEW → /api/broker/balance; cancel → pulih.
//   3) Restart — limit NEW tersimpan, rehydrate konsisten tanpa drawdown.
//
// ISOLASI: file ini mengikuti pola yang sama dengan
// ledgerDeterministic.test.ts — satu static app graph, describe restart
// di akhir memakai vi.resetModules().
// =====================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.TRADING_MODE = "paper";
  process.env.AUTH_PASSCODE = "test-passcode";
  process.env.VITE_ENABLED = "false";
  process.env.BROKER_EVENT_SECRET = "account-balance-snapshot-test-secret";
  process.env.AUDIT_HMAC_SECRET = "account-balance-snapshot-audit-hmac-0123456789abcdef";
});

const feed = vi.hoisted(() => ({
  stage: 0,
  depths: [] as Array<{ asks: number[][]; bids: number[][] }>,
  next() {
    const d = this.depths[this.stage] || this.depths[this.depths.length - 1];
    this.stage++;
    return d;
  },
  reset() {
    this.stage = 0;
    this.depths = [];
  },
}));

const exchangeStub = vi.hoisted(() => ({
  fetchOrderBook: async () => feed.next(),
  fetchTicker: async () => ({ bid: 99.9, ask: 100.1 }),
  loadMarkets: async () => {},
  fetchPositions: async () => [],
  fetchBalance: async () => ({ total: { USDT: 10000 } }),
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
  fetchBrokerBalance: async () => ({ total: { USDT: 10000 } }),
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
      reasons: [] as string[],
      details: {
        killSwitch: guardState.killSwitch,
        dailyLossPercent: guardState.lossPercent,
        maxDailyLossPercent: 10,
        realizedPnlUSD: 0,
        openCount: 0,
        maxOpenPositions: 5,
        cooldownRemainingMs: 0,
        guardsEnabled: true,
      },
    }),
    setKillSwitch: (active: boolean) => {
      guardState.killSwitch = Boolean(active);
    },
    getKillSwitch: () => ({ killSwitch: guardState.killSwitch }),
    setGuardsEnabled: (active: boolean) => ({ ok: true, guardsEnabled: Boolean(active) }),
    recordOrderPlaced: () => {},
    getTodayRealized: () => ({ realizedPnlUSD: 0, lossPercent: guardState.lossPercent }),
    getGuardrailsSnapshotSync: () => ({
      config: { killSwitchDefault: false, maxOpenPositions: 5, maxDailyLossPercent: 10, minOrderIntervalMs: 0 },
      state: {
        killSwitch: guardState.killSwitch,
        dailyLossPercent: guardState.lossPercent,
        openCount: 0,
        lastOrderAt: null,
        cooldownRemainingMs: 0,
        armedForLive: false,
        guardsEnabled: true,
      },
      today: { realizedPnlUSD: 0, lossPercent: guardState.lossPercent },
    }),
    getGuardrailsSnapshotAsync: async () => ({
      config: { killSwitchDefault: false, maxOpenPositions: 5, maxDailyLossPercent: 10, minOrderIntervalMs: 0 },
      state: {
        killSwitch: guardState.killSwitch,
        dailyLossPercent: guardState.lossPercent,
        openCount: 0,
        lastOrderAt: null,
        cooldownRemainingMs: 0,
        armedForLive: false,
        guardsEnabled: true,
      },
      today: { realizedPnlUSD: 0, lossPercent: guardState.lossPercent },
    }),
  };
});

import { app } from "../../server";

const originalCwd = process.cwd();
let sandboxDir = "";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-18T00:00:00.000Z"));
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantflow-account-balance-test-"));
  process.chdir(sandboxDir);
  feed.reset();
});

afterEach(() => {
  // CWD dipulihkan SEBELUM rm (Windows EPERM bila direktori = process.cwd()).
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
  const { initDb, getDb, getDbFilePath, closeDb } = await import("../../db");
  initDb();
  const store = await import("../../src/paperbook/store");
  Object.assign(store.state, store.freshState());
  return { db: getDb(), dbPath: getDbFilePath(), closeDb, store };
}

async function withDb<T>(fn: (s: Awaited<ReturnType<typeof initTestDb>>) => Promise<T>): Promise<T> {
  const s = await initTestDb();
  try {
    return await fn(s);
  } finally {
    s.closeDb();
  }
}

function asRows(rows: unknown): any[] {
  return rows as any[];
}

// ------------------------------------------------------------------
// Unit — limit NEW / cancel / fill (store langsung + SQLite nyata)
// ------------------------------------------------------------------
describe("P0-01 — account/snapshot/balance (unit)", () => {
  it("limit NEW: free cash turun, equity TIDAK turun; snapshot & balance konsisten", async () => {
    feed.depths.push({ asks: [[90, 5]], bids: [[90, 5]] });

    await withDb(async ({ db }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const { getPaperAccount, getPaperBalance } = await import("../../src/paperbook/store");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const res = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 0.5,
        leverage: 10,
        stopLoss: 89.5,
        takeProfit: 92,
        orderType: "limit",
        limitPrice: 90,
      });

      expect(res.order.status).toBe("NEW");
      expect(res.position).toBeNull();

      const acct = getPaperAccount();
      expect(acct.cash).toBeCloseTo(9995.5, 2);
      expect(acct.marginLocked).toBeCloseTo(0, 2);
      expect(acct.reservedMargin).toBeCloseTo(4.5, 2);
      expect(acct.equity).toBeCloseTo(10000, 2);

      const bal = getPaperBalance();
      expect(bal[0].free).toBeCloseTo(9995.5, 2);
      expect(bal[0].used).toBeCloseTo(4.5, 2);
      expect(bal[0].total).toBeCloseTo(10000, 2);

      const snapRow = db.prepare("SELECT equity, margin_used, cash FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1").get() as any;
      expect(Number(snapRow.equity)).toBeCloseTo(10000, 2);
      expect(Number(snapRow.margin_used)).toBeCloseTo(4.5, 4);
      expect(Number(snapRow.cash)).toBeCloseTo(9995.5, 2);

      const orderRow = asRows(db.prepare("SELECT status, price FROM orders WHERE symbol = ?").all("BTC/USDT"));
      expect(orderRow.length).toBe(1);
      expect(orderRow[0].status).toBe("NEW");
      expect(Number(orderRow[0].price)).toBeCloseTo(90, 6);

      const allEquities = asRows(db.prepare("SELECT equity FROM portfolio_snapshots ORDER BY ts ASC").all()).map((r) => Number(r.equity));
      expect(allEquities.every((e) => Math.abs(e - 10000) < 0.01)).toBe(true);
    });
  });

  it("cancel limit: cash pulih, used/total kembali, equity tetap 10000, snapshot konsisten", async () => {
    feed.depths.push({ asks: [[90, 5]], bids: [[90, 5]] });

    await withDb(async ({ db }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const { cancelPaperOrder, getPaperAccount, getPaperBalance } = await import("../../src/paperbook/store");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const res = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 0.5,
        leverage: 10,
        stopLoss: 89.5,
        takeProfit: 92,
        orderType: "limit",
        limitPrice: 90,
      });
      expect(res.order.status).toBe("NEW");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      const cancelled = await cancelPaperOrder(res.order.id);
      expect(cancelled.status).toBe("CANCELLED");

      const acct = getPaperAccount();
      expect(acct.cash).toBeCloseTo(10000, 2);
      expect(acct.reservedMargin).toBeCloseTo(0, 2);
      expect(acct.marginLocked).toBeCloseTo(0, 2);
      expect(acct.equity).toBeCloseTo(10000, 2);

      const bal = getPaperBalance();
      expect(bal[0].free).toBeCloseTo(10000, 2);
      expect(bal[0].used).toBeCloseTo(0, 2);
      expect(bal[0].total).toBeCloseTo(10000, 2);

      const snapRow = db.prepare("SELECT equity, margin_used FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1").get() as any;
      expect(Number(snapRow.equity)).toBeCloseTo(10000, 2);
      expect(Number(snapRow.margin_used)).toBeCloseTo(0, 4);

      const allEquities = asRows(db.prepare("SELECT equity FROM portfolio_snapshots ORDER BY ts ASC").all()).map((r) => Number(r.equity));
      expect(allEquities.every((e) => Math.abs(e - 10000) < 0.01)).toBe(true);

      const orderRow = asRows(db.prepare("SELECT status FROM orders WHERE symbol = ?").all("BTC/USDT"));
      expect(orderRow[0].status).toBe("CANCELLED");
    });
  });

  it("limit FILL: reserved → marginLocked tanpa double-count cash (hanya fee maker)", async () => {
    feed.depths.push({ asks: [[90, 5]], bids: [[90, 5]] });

    await withDb(async ({ db }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const { fillPendingLimitOrders } = await import("../../src/paperbook/bracketMonitor");
      const { getPaperAccount, getPaperBalance } = await import("../../src/paperbook/store");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const res = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 0.5,
        leverage: 10,
        stopLoss: 89.5,
        takeProfit: 92,
        orderType: "limit",
        limitPrice: 90,
      });
      expect(res.order.status).toBe("NEW");
      const orderId = res.order.id;

      const acct1 = getPaperAccount();
      expect(acct1.cash).toBeCloseTo(9995.5, 2);
      expect(acct1.reservedMargin).toBeCloseTo(4.5, 2);

      // Mark crosses limit: low1m <= 90; mark=90 → unrealized=0 saat fill.
      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      const marks = new Map([["BTC/USDT", { mark: 90, high1m: 96, low1m: 88, ok: true }]]);
      await fillPendingLimitOrders(marks);

      const acct2 = getPaperAccount();
      const makerFee = 90 * 0.5 * 0.0002; // 0.009
      expect(acct2.cash).toBeCloseTo(9995.5 - makerFee, 2);
      expect(acct2.marginLocked).toBeCloseTo(4.5, 2);
      expect(acct2.reservedMargin).toBeCloseTo(0, 2);
      expect(acct2.unrealizedPnl).toBeCloseTo(0, 2);
      expect(acct2.equity).toBeCloseTo(10000 - makerFee, 2);

      const bal2 = getPaperBalance();
      expect(bal2[0].free).toBeCloseTo(9995.5 - makerFee, 2);
      expect(bal2[0].used).toBeCloseTo(4.5, 2);
      expect(bal2[0].total).toBeCloseTo(10000 - makerFee, 2);

      const snapRow = db.prepare("SELECT equity, margin_used FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1").get() as any;
      expect(Number(snapRow.equity)).toBeCloseTo(10000 - makerFee, 2);
      expect(Number(snapRow.margin_used)).toBeCloseTo(4.5, 4);

      const orderRow = db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId) as any;
      expect(orderRow.status).toBe("FILLED");
      const posRow = db.prepare("SELECT status, entry_price FROM positions WHERE symbol = ?").get("BTC/USDT") as any;
      expect(posRow.status).toBe("OPEN");
      expect(Number(posRow.entry_price)).toBeCloseTo(90, 6);

      // Equity curve tidak pernah turun ke bagian "drawdown semu" (bug lama:
      // snapshot equity 9995.5 saat NEW → > 9999.9 membuktikan reserved dikembalikan).
      const allEquities = asRows(db.prepare("SELECT equity FROM portfolio_snapshots ORDER BY ts ASC").all()).map((r) => Number(r.equity));
      expect(allEquities[0]).toBeCloseTo(10000, 2);
      expect(Math.min(...allEquities)).toBeGreaterThan(9999.9);
      expect(allEquities[allEquities.length - 1]).toBeCloseTo(10000 - makerFee, 2);
    });
  });
});

// ------------------------------------------------------------------
// HTTP — balance route memakai satu hitungan
// ------------------------------------------------------------------
let appHttp: Express;
let token = "";

async function login(): Promise<string> {
  const res = await request(appHttp).post("/api/auth/login").send({ passcode: "test-passcode" });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

describe("P0-01 — HTTP balance + reserved margin (Supertest)", () => {
  beforeAll(() => {
    appHttp = app;
  });

  beforeEach(() => {
    token = "";
  });

  it("limit NEW via HTTP → balance.used=4.5, total=10000; cancel → pulih", async () => {
    feed.depths.push({ asks: [[90, 5]], bids: [[90, 5]] });

    await withDb(async () => {
      token = await login();

      const open = await request(appHttp)
        .post("/api/broker/order")
        .set("Authorization", `Bearer ${token}`)
        .send({
          symbol: "BTC/USDT",
          side: "buy",
          amount: 0.5,
          leverage: 10,
          stopLoss: 89.5,
          takeProfit: 92,
          type: "limit",
          limitPrice: 90,
        });
      expect(open.status).toBe(200);
      expect(open.body.success).toBe(true);
      expect(open.body.order.status).toBe("NEW");

      const orderId = open.body.order.id as string;

      const bal = await request(appHttp).get("/api/broker/balance").set("Authorization", `Bearer ${token}`);
      expect(bal.status).toBe(200);
      expect(bal.body.account.reservedMargin).toBeCloseTo(4.5, 2);
      expect(bal.body.account.equity).toBeCloseTo(10000, 2);
      expect(bal.body.account.cash).toBeCloseTo(9995.5, 2);
      expect(bal.body.account.marginLocked).toBeCloseTo(0, 2);
      expect(bal.body.balances[0].free).toBeCloseTo(9995.5, 2);
      expect(bal.body.balances[0].used).toBeCloseTo(4.5, 2);
      expect(bal.body.balances[0].total).toBeCloseTo(10000, 2);

      const posRes = await request(appHttp).get("/api/broker/positions").set("Authorization", `Bearer ${token}`);
      expect(posRes.body.positions).toHaveLength(0);
      expect(posRes.body.account.reservedMargin).toBeCloseTo(4.5, 2);

      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      const cancel = await request(appHttp)
        .post("/api/broker/cancel")
        .set("Authorization", `Bearer ${token}`)
        .send({ orderId });
      expect(cancel.status).toBe(200);
      expect(cancel.body.cancelled).toBe(true);

      const bal2 = await request(appHttp).get("/api/broker/balance").set("Authorization", `Bearer ${token}`);
      expect(bal2.body.account.reservedMargin).toBeCloseTo(0, 2);
      expect(bal2.body.account.equity).toBeCloseTo(10000, 2);
      expect(bal2.body.balances[0].free).toBeCloseTo(10000, 2);
      expect(bal2.body.balances[0].used).toBeCloseTo(0, 2);
      expect(bal2.body.balances[0].total).toBeCloseTo(10000, 2);
    });
  });
});

// ------------------------------------------------------------------
// Restart / rehydrate — tanpa drawdown semu
// DILETAKKAN PALING AKHIR: vi.resetModules() hanya boleh di sini.
// ------------------------------------------------------------------
describe("P0-01 — restart & rehydrate (tanpa drawdown semu reserved)", () => {
  it("restart dengan limit NEW tersimpan: rehydrate cash + reserved = equity 10000 tanpa drawdown", async () => {
    feed.depths.push({ asks: [[90, 5]], bids: [[90, 5]] });

    let closeX: (() => void) | null = null;
    let closeY: (() => void) | null = null;
    try {
      // ---- fase A: limit NEW → cash 9995.5, reserved 4.5 → "server mati" ----
      const sA = await initTestDb();
      closeX = sA.closeDb;

      const { openPaperPosition } = await import("../../paperBook");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const res = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 0.5,
        leverage: 10,
        stopLoss: 89.5,
        takeProfit: 92,
        orderType: "limit",
        limitPrice: 90,
      });
      expect(res.order.status).toBe("NEW");
      const orderId = res.order.id;

      closeX();
      closeX = null;
      vi.resetModules();

      // ---- fase B: proses baru, rehydrate dari SQLite yang sama ----
      const storeB = await import("../../src/paperbook/store");
      storeB.initPaperBook();
      const { closeDb: closeDbB } = await import("../../db");
      closeY = closeDbB;

      const acctB = storeB.getPaperAccount();
      expect(acctB.cash).toBeCloseTo(9995.5, 2);
      expect(acctB.reservedMargin).toBeCloseTo(4.5, 2);
      expect(acctB.marginLocked).toBeCloseTo(0, 2);
      expect(acctB.equity).toBeCloseTo(10000, 2);

      const balB = storeB.getPaperBalance();
      expect(balB[0].free).toBeCloseTo(9995.5, 2);
      expect(balB[0].used).toBeCloseTo(4.5, 2);
      expect(balB[0].total).toBeCloseTo(10000, 2);

      // cancel dalam fase B → cash pulih, tidak ada sisa reserved
      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      await storeB.cancelPaperOrder(orderId);
      const acctB2 = storeB.getPaperAccount();
      expect(acctB2.cash).toBeCloseTo(10000, 2);
      expect(acctB2.reservedMargin).toBeCloseTo(0, 2);
      expect(acctB2.equity).toBeCloseTo(10000, 2);

      const balB2 = storeB.getPaperBalance();
      expect(balB2[0].free).toBeCloseTo(10000, 2);
      expect(balB2[0].used).toBeCloseTo(0, 2);
      expect(balB2[0].total).toBeCloseTo(10000, 2);
    } finally {
      if (closeX) closeX();
      if (closeY) closeY();
    }
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});