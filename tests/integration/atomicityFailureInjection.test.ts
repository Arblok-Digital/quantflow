// =====================================================================
// P0-04 — Atomicity failure injection (DB gagal di commitTx)
//
// Expected:
//   Tiap jalur mutasi (open, close, partial-close, limit-new, limit-fill,
//   cancel, update SL/TP/exitPlan/breakEven) yang gagal di DB commit →
//     1. rollback in-memory: cash, posisi, orders, exit-plan == DB (unchanged)
//     2. tidak memancarkan success event palsu
//        (POSITION_CLOSED / POSITION_PARTIAL_CLOSED / ORDER_FILLED /
//         ORDER_CANCELLED / POSITION_UPDATED / EXIT_ENGINE_ACTION)
//     3. retry (tanpa fail) → sukses, DB == memori
//     4. restart/rehydrate → state setuju (DB == pre-failure state)
//
//   Tambahan:
//   - Concurrency: 2 close konkuren → 1 sukses + 1 POSITION_ALREADY_CLOSED
//   - Idempotency: same clientOrderId → 1 posisi, receipt sama
//   - Limit-fill gagal: order tetap NEW, posisi tidak ada, ERROR event tercatat
//
// Mock: commitTx di-wrap — throw once saat failCommit.value = true,
//       rollbackTx tetap nyata (ROLLBACK nyata di sandbox SQLite).
// =====================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

const INITIAL_CASH = 10000;
const TAKER_FEE = 0.0004;
const MAKER_FEE = 0.0002;
const originalCwd = process.cwd();
let sandboxDir = "";

// ── env ──────────────────────────────────────────────────────────────
vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.TRADING_MODE = "paper";
  process.env.AUTH_PASSCODE = "test-passcode";
  process.env.VITE_ENABLED = "false";
  process.env.BROKER_EVENT_SECRET = "atomicity-test-secret";
  process.env.AUDIT_HMAC_SECRET = "atomicity-test-audit-hmac-0123456789abcdef";
});

// ── conditional commitTx failure (single-shot) ───────────────────────
const failCommit = vi.hoisted(() => ({ value: false }));

// ── depth feed stub ──────────────────────────────────────────────────
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

// ── exchange stub ────────────────────────────────────────────────────
const exchangeStub = vi.hoisted(() => ({
  fetchOrderBook: async () => feed.next(),
  fetchTicker: async () => ({ bid: 99.9, ask: 100.1 }),
  loadMarkets: async () => {},
  fetchPositions: async () => [],
  fetchBalance: async () => ({ total: { USDT: INITIAL_CASH } }),
  fetchOpenOrders: async () => [],
}));

// ── mocks ────────────────────────────────────────────────────────────
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
    evaluateGuardrails: async () => {
      const reasons: string[] = [];
      if (guardState.killSwitch) reasons.push("KILL_SWITCH_ACTIVE");
      if (guardState.lossPercent >= 10) reasons.push("MAX_DAILY_LOSS_EXCEEDED");
      return {
        allowed: reasons.length === 0,
        reasons,
        details: { killSwitch: guardState.killSwitch, dailyLossPercent: guardState.lossPercent, maxDailyLossPercent: 10, realizedPnlUSD: 0, openCount: 0, maxOpenPositions: 5, cooldownRemainingMs: 0, guardsEnabled: true },
      };
    },
    setKillSwitch: (active: boolean) => { guardState.killSwitch = Boolean(active); return { killSwitch: guardState.killSwitch }; },
    setGuardsEnabled: (active: boolean) => ({ ok: true, guardsEnabled: Boolean(active) }),
    recordOrderPlaced: () => {},
    getTodayRealized: () => ({ realizedPnlUSD: 0, lossPercent: guardState.lossPercent }),
    getGuardrailsSnapshotSync: () => ({
      config: { killSwitchDefault: false, maxOpenPositions: 5, maxDailyLossPercent: 10, minOrderIntervalMs: 0 },
      state: { killSwitch: guardState.killSwitch, dailyLossPercent: guardState.lossPercent, openCount: 0, lastOrderAt: null, cooldownRemainingMs: 0, armedForLive: false, guardsEnabled: true },
      today: { realizedPnlUSD: 0, lossPercent: guardState.lossPercent },
    }),
    getGuardrailsSnapshotAsync: async () => ({
      config: { killSwitchDefault: false, maxOpenPositions: 5, maxDailyLossPercent: 10, minOrderIntervalMs: 0 },
      state: { killSwitch: guardState.killSwitch, dailyLossPercent: guardState.lossPercent, openCount: 0, lastOrderAt: null, cooldownRemainingMs: 0, armedForLive: false, guardsEnabled: true },
      today: { realizedPnlUSD: 0, lossPercent: guardState.lossPercent },
    }),
  };
});

// P0-04: partial mock — real db except commitTx is conditionally overridden.
vi.mock("../../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db")>();
  return {
    ...actual,
    commitTx: () => {
      if (failCommit.value) {
        failCommit.value = false; // consume once
        throw new Error("injected DB failure at commit");
      }
      return actual.commitTx();
    },
  };
});

import { app } from "../../server";

const appHttp: Express = app;

// ── lifecycle ────────────────────────────────────────────────────────
beforeEach(() => {
  feed.reset();
  guardState.killSwitch = false;
  guardState.lossPercent = 0;
  failCommit.value = false;
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantflow-p04-atomicity-"));
  process.chdir(sandboxDir);
});

afterEach(() => {
  failCommit.value = false;
  process.chdir(originalCwd);
  if (sandboxDir) {
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* ignore */ }
    sandboxDir = "";
  }
});

// ── helpers ──────────────────────────────────────────────────────────
async function initTestDb() {
  const { initDb, getDb, getDbFilePath, closeDb } = await import("../../db");
  initDb();
  const store = await import("../../src/paperbook/store");
  Object.assign(store.state, store.freshState());
  return { db: getDb(), dbPath: getDbFilePath(), closeDb, store };
}

async function withDb<T>(fn: (s: Awaited<ReturnType<typeof initTestDb>>) => Promise<T>): Promise<T> {
  const s = await initTestDb();
  try { return await fn(s); } finally { s.closeDb(); }
}

async function login(): Promise<string> {
  const res = await request(appHttp).post("/api/auth/login").send({ passcode: "test-passcode" });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

// Restart simulation: rehydrate dari DISK secara independen (koneksi SQLite
// kedua, read-only) dan bandingkan dengan memori. Ini kontrak "restart tiap
// jalur": state yang bertahan di DB = state yang akan di-rehydrate proses baru.
import { DatabaseSync } from "node:sqlite";

function storageRows(dbPath: string): { positions: any[]; orders: any[] } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      positions: db.prepare("SELECT id, status, amount, stop_loss, take_profit, exit_config FROM positions ORDER BY id").all() as any[],
      orders: db.prepare("SELECT id, status, price FROM orders ORDER BY id").all() as any[],
    };
  } finally {
    db.close();
  }
}

function hasEvent(evts: { type: string; payload: Record<string, unknown> }[], type: string): boolean {
  return evts.some((e) => e.type === type);
}

function feeAwareBE(entryPrice: number, qty: number): number {
  const E = entryPrice;
  const q = qty;
  const F = E * q * TAKER_FEE;
  return (E * q + F) / (q * (1 - TAKER_FEE));
}

function expectTxFail(fn: () => void): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect((err as Error & { code?: string })?.code).toBe("DB_TX_FAILED");
}

// =====================================================================
// 1. MARKET OPEN — DB gagal → tidak ada posisi, cash utuh, retry aman
// =====================================================================
describe("P0-04 — market open: DB gagal → rollback + tidak ada phantom", () => {
  it("commitTx gagal → no position, no order, cash utuh, ORDER_FILLED tidak hantu; retry sukses + restart setuju", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] }); // for open

    await withDb(async (s) => {
      const { db, store } = s;
      const seq0 = store.getLatestEventSeq();

      // ── fail on first attempt ──
      failCommit.value = true;
      await expect(
        (await import("../../paperBook")).openPaperPosition({
          symbol: "BTC/USDT",
          side: "buy",
          qty: 10,
          leverage: 10,
          stopLoss: 98,
          takeProfit: 104,
        })
      ).rejects.toMatchObject({ code: "DB_TX_FAILED" });

      expect(store.state.positions).toHaveLength(0);
      expect(store.state.orders).toHaveLength(0);
      expect(store.state.cash).toBe(INITIAL_CASH);

      // DB empty (tx rolled back)
      expect(db.prepare("SELECT COUNT(*) n FROM positions").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) n FROM orders").get()).toEqual({ n: 0 });

      // Tidak ada event fill dari attempt gagal (ORDER_FILLED/ORDER_PARTIAL tidak boleh hantu)
      const evtsAfterFail = store.getPaperEvents(seq0);
      expect(hasEvent(evtsAfterFail, "ORDER_FILLED")).toBe(false);
      expect(hasEvent(evtsAfterFail, "ORDER_PARTIAL")).toBe(false);

      // ── retry (no failure) → sukses ──
      feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });
      const result = await (await import("../../paperBook")).openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 10,
        leverage: 10,
        stopLoss: 98,
        takeProfit: 104,
      });
      expect(result.position.qty).toBe(10);
      expect(store.state.cash).toBeLessThan(INITIAL_CASH);

      // DB & memori setuju
      const posRow = db.prepare("SELECT status, amount FROM positions WHERE id = ?").get(result.position.id) as any;
      expect(posRow.status).toBe("OPEN");
      expect(posRow.amount).toBe(10);

      // ── restart → disk berisi state yang sama dengan memori (rehydrate reproduksi) ──
      const storage = storageRows(s.dbPath);
      expect(storage.positions).toHaveLength(1);
      expect(storage.positions[0].amount).toBeCloseTo(10, 6);
      expect(storage.positions[0].status).toBe("OPEN");
      expect(Math.abs(store.state.cash - result.account.cash)).toBeLessThanOrEqual(0.02);
    });
  });
});

// =====================================================================
// 2. FULL CLOSE — DB gagal → posisi tetap OPEN, retry aman
// =====================================================================
describe("P0-04 — full close: DB gagal → rollback + tidak ada POSITION_CLOSED palsu", () => {
  it("commitTx gagal → posisi OPEN, cash utuh, POSITION_CLOSED tidak hantu; retry sukses + restart setuju", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },  // open
      { asks: [[101, 100]], bids: [[101, 100]] },   // close
    );

    await withDb(async (s) => {
      const { db, store } = s;
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });
      const cashBefore = store.state.cash;
      const realizedBefore = store.state.realizedPnl;
      const seq0 = store.getLatestEventSeq();

      // ── fail on close ──
      failCommit.value = true;
      await expect(closePaperPosition(pos.id, "MANUAL")).rejects.toMatchObject({ code: "DB_TX_FAILED" });

      const live = store.state.positions.find((p) => p.id === pos.id)!;
      expect(live.status).toBe("OPEN");
      expect(live.qty).toBe(10);
      expect(store.state.cash).toBe(cashBefore);
      expect(store.state.realizedPnl).toBe(realizedBefore);
      expect(store.state.orders).toHaveLength(1); // open order only

      const posRow = db.prepare("SELECT status, amount FROM positions WHERE id = ?").get(pos.id) as any;
      expect(posRow.status).toBe("OPEN");
      expect(posRow.amount).toBe(10);

      // Tidak ada event hantu
      const evts = store.getPaperEvents(seq0);
      expect(hasEvent(evts, "POSITION_CLOSED")).toBe(false);
      expect(hasEvent(evts, "ORDER_FILLED")).toBe(false);

      // ── retry → sukses ──
      feed.depths.push({ asks: [[101, 100]], bids: [[101, 100]] });
      const result = await closePaperPosition(pos.id, "MANUAL");
      expect(result.position.status).toBe("CLOSED");
      expect(result.realizedPnlUSD).toBeCloseTo((101 - 100) * 10 - 100 * 10 * TAKER_FEE - 101 * 10 * TAKER_FEE, 1);

      const posRowAfter = db.prepare("SELECT status, amount FROM positions WHERE id = ?").get(pos.id) as any;
      expect(posRowAfter.status).toBe("CLOSED");

      // ── restart ──
      const storage = storageRows(s.dbPath);
      expect(storage.positions.find((p) => p.id === pos.id)?.status).toBe("CLOSED");
      expect(storage.positions.find((p) => p.id === pos.id)?.amount).toBeCloseTo(10, 6);
      expect(storage.orders.length).toBe(2); // open + close
    });
  });
});

// =====================================================================
// 3. PARTIAL CLOSE — DB gagal → qty tidak berubah, level utuh
// =====================================================================
describe("P0-04 — partial close: DB gagal → rollback + tidak ada POSITION_PARTIAL_CLOSED palsu", () => {
  it("partial DB gagal → qty/exitPlan tidak berubah; retry sukses + restart setuju", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },  // open
      { asks: [[101, 100]], bids: [[101, 100]] },   // close 3
    );

    await withDb(async (s) => {
      const { db, store } = s;
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });

      // Set exitPlan (partial levels) — should survive DB failure
      store.updatePaperPosition(pos.id, {
        exitConfig: { breakEvenTriggerR: 0.5, partialLevels: [{ rMultiple: 1, closePct: 30 }, { rMultiple: 2, closePct: 30 }] },
      });
      const planBefore = JSON.parse(JSON.stringify(store.state.positions.find((p) => p.id === pos.id)!.exitPlan!));
      const cashBefore = store.state.cash;
      const seq0 = store.getLatestEventSeq();

      // ── fail on partial ──
      failCommit.value = true;
      await expect(closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 3)).rejects.toMatchObject({ code: "DB_TX_FAILED" });

      const live = store.state.positions.find((p) => p.id === pos.id)!;
      expect(live.status).toBe("OPEN");
      expect(live.qty).toBe(10);
      expect(store.state.cash).toBe(cashBefore);
      expect(live.exitPlan).toEqual(planBefore); // exitPlan restored

      const posRow = db.prepare("SELECT status, amount, exit_config FROM positions WHERE id = ?").get(pos.id) as any;
      expect(posRow.status).toBe("OPEN");
      expect(posRow.amount).toBe(10);

      const evts = store.getPaperEvents(seq0);
      expect(hasEvent(evts, "POSITION_PARTIAL_CLOSED")).toBe(false);

      // ── retry → sukses ──
      feed.depths.push({ asks: [[101, 100]], bids: [[101, 100]] });
      const result = await closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 3);
      expect(result.partial).toBe(true);
      expect(result.remainingQty).toBeCloseTo(7, 8);

      const liveAfter = store.state.positions.find((p) => p.id === pos.id)!;
      expect(liveAfter.status).toBe("OPEN");
      expect(liveAfter.qty).toBeCloseTo(7, 8);
      expect(liveAfter.exitPlan).toBeDefined(); // level masih ada

      // ── restart ──
      const storage = storageRows(s.dbPath);
      expect(storage.positions.find((p) => p.id === pos.id)?.amount).toBeCloseTo(7, 6);
      expect(storage.positions.find((p) => p.id === pos.id)?.status).toBe("OPEN");
      expect(storage.positions.find((p) => p.id === pos.id)?.exit_config).toBeDefined(); // level survive restart
    });
  });
});

// =====================================================================
// 4. CANCEL — DB gagal → order tetap NEW, cash tidak ter-refund
// =====================================================================
describe("P0-04 — cancel: DB gagal → rollback + tidak ada ORDER_CANCELLED palsu", () => {
  it("cancel DB gagal → order NEW, cash utuh; retry cancel sukses + restart setuju", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] }); // limit new

    await withDb(async (s) => {
      const { db, store } = s;
      const { openPaperPosition, cancelPaperOrder } = await import("../../paperBook");
      const { order: limitOrder } = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 5,
        leverage: 10,
        orderType: "limit",
        limitPrice: 90,
        stopLoss: 85,
        takeProfit: 100,
      });
      expect(limitOrder.status).toBe("NEW");
      const cashBefore = store.state.cash;
      const seq0 = store.getLatestEventSeq();

      // ── fail on cancel ──
      failCommit.value = true;
      await expect(cancelPaperOrder(limitOrder.id)).rejects.toMatchObject({ code: "DB_TX_FAILED" });

      const orderAfterFail = store.state.orders.find((o) => o.id === limitOrder.id)!;
      expect(orderAfterFail.status).toBe("NEW");
      expect(store.state.cash).toBe(cashBefore);

      const orderRow = db.prepare("SELECT status FROM orders WHERE id = ?").get(limitOrder.id) as any;
      expect(orderRow.status).toBe("NEW");

      const evts = store.getPaperEvents(seq0);
      expect(hasEvent(evts, "ORDER_CANCELLED")).toBe(false);

      // ── retry → sukses ──
      const result = await cancelPaperOrder(limitOrder.id);
      expect(result.status).toBe("CANCELLED");
      expect(store.state.cash).toBeGreaterThan(cashBefore);

      const orderRowAfter = db.prepare("SELECT status FROM orders WHERE id = ?").get(limitOrder.id) as any;
      expect(orderRowAfter.status).toBe("CANCELLED");

      // ── restart ──
      const storage = storageRows(s.dbPath);
      expect(storage.orders.find((o: any) => o.id === limitOrder.id)?.status).toBe("CANCELLED");
    });
  });
});

// =====================================================================
// 5. LIMIT NEW — DB gagal → tidak ada order, cash utuh
// =====================================================================
describe("P0-04 — limit-new: DB gagal → rollback cash + tidak ada order", () => {
  it("limit new DB gagal → no order, cash 10000; retry sukses + restart setuju", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] }); // for openMarket (unused here)

    await withDb(async (s) => {
      const { db, store } = s;
      const seq0 = store.getLatestEventSeq();

      // ── fail on limit new ──
      failCommit.value = true;
      await expect(
        (await import("../../paperBook")).openPaperPosition({
          symbol: "BTC/USDT",
          side: "buy",
          qty: 5,
          leverage: 10,
          orderType: "limit",
          limitPrice: 90,
          stopLoss: 85,
          takeProfit: 100,
        })
      ).rejects.toMatchObject({ code: "DB_TX_FAILED" });

      expect(store.state.orders).toHaveLength(0);
      expect(store.state.cash).toBe(INITIAL_CASH);

      const ordersDb = db.prepare("SELECT COUNT(*) n FROM orders").get() as any;
      expect(ordersDb.n).toBe(0);

      // ── retry (no fail) → sukses ──
      const { order } = await (await import("../../paperBook")).openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 5,
        leverage: 10,
        orderType: "limit",
        limitPrice: 90,
        stopLoss: 85,
        takeProfit: 100,
      });
      expect(order.status).toBe("NEW");
      expect(store.state.cash).toBeLessThan(INITIAL_CASH);

      const orderRow = db.prepare("SELECT status, price FROM orders WHERE id = ?").get(order.id) as any;
      expect(orderRow.status).toBe("NEW");
      expect(Number(orderRow.price)).toBeCloseTo(90, 2);

      // ── restart ──
      const storage = storageRows(s.dbPath);
      expect(storage.orders).toHaveLength(1);
      expect(storage.orders[0].status).toBe("NEW");
      expect(Number(storage.orders[0].price)).toBeCloseTo(90, 2);
    });
  });
});

// =====================================================================
// 6. LIMIT FILL — DB gagal → order tetap NEW, ERROR event
// =====================================================================
describe("P0-04 — limit-fill: DB gagal → rollback + tidak ada ORDER_FILLED palsu", () => {
  it("fill limit DB gagal → order NEW, no position, ERROR event; retry sukses + restart setuju", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] }); // for marketFill inside fillPending

    await withDb(async (s) => {
      const { db, store } = s;
      // Place limit order (no failure)
      const { openPaperPosition } = await import("../../paperBook");
      const { order: limitOrder } = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 5,
        leverage: 10,
        orderType: "limit",
        limitPrice: 105,       // mark crosses when rangeLow >= 105 for buy? buy limit triggers on rangeLow <= 105
        stopLoss: 100,          // R:R = (113-105)/(105-100) = 1.6 → lolos risk gate
        takeProfit: 113,
      });
      expect(limitOrder.status).toBe("NEW");
      const cashBefore = store.state.cash;
      const seq0 = store.getLatestEventSeq();

      // ── fail on fill ──
      failCommit.value = true;
      const { fillPendingLimitOrders } = await import("../../src/paperbook/bracketMonitor");
      const marks = new Map([["BTC/USDT", { mark: 100, high1m: 106, low1m: 99, ok: true }]]);
      // buy limit at 105, rangeLow 99 ≤ 105 → crossed
      await fillPendingLimitOrders(marks);

      // order stays NEW, no position
      expect(store.state.orders.find((o) => o.id === limitOrder.id)!.status).toBe("NEW");
      expect(store.state.positions).toHaveLength(0);
      expect(store.state.cash).toBe(cashBefore);

      const orderRow = db.prepare("SELECT status FROM orders WHERE id = ?").get(limitOrder.id) as any;
      expect(orderRow.status).toBe("NEW");
      const posCount = db.prepare("SELECT COUNT(*) n FROM positions").get() as any;
      expect(posCount.n).toBe(0);

      // ERROR event tercatat
      const evts = store.getPaperEvents(seq0);
      expect(hasEvent(evts, "ERROR")).toBe(true);
      expect(hasEvent(evts, "ORDER_FILLED")).toBe(false);

      // ── retry (no fail) → sukses ──
      await fillPendingLimitOrders(marks);
      expect(store.state.orders.find((o) => o.id === limitOrder.id)!.status).toBe("FILLED");
      expect(store.state.positions).toHaveLength(1);
      expect(store.state.cash).toBeLessThan(cashBefore);

      const posRow = db.prepare("SELECT status, amount FROM positions WHERE id = ?").get(store.state.positions[0].id) as any;
      expect(posRow.status).toBe("OPEN");
      expect(posRow.amount).toBeCloseTo(5, 4);

      // ── restart ──
      const storage = storageRows(s.dbPath);
      expect(storage.positions).toHaveLength(1);
      expect(storage.positions[0].amount).toBeCloseTo(5, 6);
      expect(storage.orders.find((o: any) => o.id === limitOrder.id)?.status).toBe("FILLED");
    });
  });
});

// =====================================================================
// 7. UPDATE SL/TP — DB gagal → tidak ada perubahan
// =====================================================================
describe("P0-04 — update SL/TP: DB gagal → rollback + tidak ada POSITION_UPDATED palsu", () => {
  it("update DB gagal → SL/TP utuh; retry sukses + restart setuju", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });

    await withDb(async (s) => {
      const { db, store } = s;
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });
      expect(pos.stopLoss).toBe(98);
      const seq0 = store.getLatestEventSeq();

      // ── fail on update ──
      failCommit.value = true;
      expectTxFail(() => store.updatePaperPosition(pos.id, { stopLoss: 97, takeProfit: 105 }));
      const live = store.state.positions.find((p) => p.id === pos.id)!;
      expect(live.stopLoss).toBe(98);
      expect(live.takeProfit).toBe(104);

      const posRow = db.prepare("SELECT stop_loss, take_profit FROM positions WHERE id = ?").get(pos.id) as any;
      expect(Number(posRow.stop_loss)).toBe(98);
      expect(Number(posRow.take_profit)).toBe(104);

      const evts = store.getPaperEvents(seq0);
      expect(hasEvent(evts, "POSITION_UPDATED")).toBe(false);

      // ── retry → sukses ──
      store.updatePaperPosition(pos.id, { stopLoss: 97, takeProfit: 105 });
      const liveAfter = store.state.positions.find((p) => p.id === pos.id)!;
      expect(liveAfter.stopLoss).toBe(97);
      expect(liveAfter.takeProfit).toBe(105);

      const posRowAfter = db.prepare("SELECT stop_loss, take_profit FROM positions WHERE id = ?").get(pos.id) as any;
      expect(Number(posRowAfter.stop_loss)).toBe(97);
      expect(Number(posRowAfter.take_profit)).toBe(105);

      // ── restart ──
      const storage = storageRows(s.dbPath);
      const rehy = storage.positions.find((p) => p.id === pos.id)!;
      expect(Number(rehy.stop_loss)).toBe(97);
      expect(Number(rehy.take_profit)).toBe(105);
    });
  });
});

// =====================================================================
// 8. UPDATE EXIT CONFIG — DB gagal → exitPlan tidak berubah
// =====================================================================
describe("P0-04 — update exitPlan: DB gagal → rollback + tidak ada EXIT_ENGINE_ACTION palsu", () => {
  it("set exitPlan DB gagal → exitPlan undefined; retry sukses + restart setuju", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });

    await withDb(async (s) => {
      const { db, store } = s;
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });
      expect(pos.exitPlan).toBeUndefined();
      const seq0 = store.getLatestEventSeq();

      // ── fail on set exitPlan ──
      failCommit.value = true;
      expectTxFail(() => store.updatePaperPosition(pos.id, { exitConfig: { breakEvenTriggerR: 1.0 } }));
      expect(store.state.positions.find((p) => p.id === pos.id)!.exitPlan).toBeUndefined();

      const posRow = db.prepare("SELECT exit_config FROM positions WHERE id = ?").get(pos.id) as any;
      expect(posRow.exit_config).toBeNull();

      const evts = store.getPaperEvents(seq0);
      expect(hasEvent(evts, "EXIT_ENGINE_ACTION")).toBe(false);

      // ── retry → sukses ──
      store.updatePaperPosition(pos.id, { exitConfig: { breakEvenTriggerR: 1.0 } });
      const plan = store.state.positions.find((p) => p.id === pos.id)!.exitPlan!;
      expect(plan.config.breakEvenTriggerR).toBe(1.0);

      const posRowAfter = db.prepare("SELECT exit_config FROM positions WHERE id = ?").get(pos.id) as any;
      expect(posRowAfter.exit_config).toBeDefined();

      // ── restart ──
      const storage = storageRows(s.dbPath);
      const storedExit = storage.positions.find((p) => p.id === pos.id)!.exit_config as string;
      expect(JSON.parse(storedExit).config.breakEvenTriggerR).toBe(1.0);
    });
  });

  it("remove exitPlan DB gagal → plan masih ada; retry sukses", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });

    await withDb(async (s) => {
      const { db, store } = s;
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });
      store.updatePaperPosition(pos.id, { exitConfig: { breakEvenTriggerR: 1.0 } });
      const planBefore = JSON.parse(JSON.stringify(store.state.positions.find((p) => p.id === pos.id)!.exitPlan));

      failCommit.value = true;
      expectTxFail(() => store.updatePaperPosition(pos.id, { exitConfig: null }));
      expect(store.state.positions.find((p) => p.id === pos.id)!.exitPlan).toEqual(planBefore);

      // retry
      store.updatePaperPosition(pos.id, { exitConfig: null });
      expect(store.state.positions.find((p) => p.id === pos.id)!.exitPlan).toBeUndefined();
    });
  });
});

// =====================================================================
// 9. BREAK-EVEN — DB gagal → stopLoss tidak berubah
// =====================================================================
describe("P0-04 — breakEven: DB gagal → rollback", () => {
  it("BE DB gagal → stopLoss utuh, EXIT_ENGINE_ACTION tidak hantu; retry sukses + restart setuju", async () => {
    feed.depths.push({ asks: [[100, 100]], bids: [[100, 100]] });

    await withDb(async (s) => {
      const { db, store } = s;
      const { openPaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });

      // Set fresh profitable mark so BE is tighter and applicable
      const live = store.state.positions.find((p) => p.id === pos.id)!;
      live.lastMark = 101;
      live.lastMarkUpdatedAt = Date.now();
      const beSl = feeAwareBE(100, 10);
      // BE must tighten vs current SL=98 for this test to be meaningful
      expect(beSl).toBeGreaterThan(98);
      const seq0 = store.getLatestEventSeq();

      // ── fail on breakEven ──
      failCommit.value = true;
      expectTxFail(() => store.updatePaperPosition(pos.id, { breakEven: true }));
      expect(store.state.positions.find((p) => p.id === pos.id)!.stopLoss).toBe(98);

      const posRow = db.prepare("SELECT stop_loss FROM positions WHERE id = ?").get(pos.id) as any;
      expect(Number(posRow.stop_loss)).toBe(98);

      const evts = store.getPaperEvents(seq0);
      expect(hasEvent(evts, "EXIT_ENGINE_ACTION")).toBe(false);

      // ── retry → sukses ──
      const result = store.updatePaperPosition(pos.id, { breakEven: true });
      expect((result as unknown as { breakEven?: { applied: boolean } }).breakEven?.applied).toBe(true);
      expect(store.state.positions.find((p) => p.id === pos.id)!.stopLoss).toBeCloseTo(beSl, 2);

      const posRowAfter = db.prepare("SELECT stop_loss FROM positions WHERE id = ?").get(pos.id) as any;
      expect(Number(posRowAfter.stop_loss)).toBeCloseTo(beSl, 2);

      // ── restart ──
      const storage = storageRows(s.dbPath);
      expect(Number(storage.positions.find((p) => p.id === pos.id)!.stop_loss)).toBeCloseTo(beSl, 2);
    });
  });
});

// =====================================================================
// 10. CONCURRENCY — dua close konkuren → 1 sukses + 1 already-closed
// =====================================================================
describe("P0-04 — concurrency: dua close konkuren → serialized", () => {
  it("Promise.all([close, close]) → 1 success + 1 POSITION_ALREADY_CLOSED (bukan DB_TX_FAILED)", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },  // open
      { asks: [[101, 100]], bids: [[101, 100]] },   // close #1
    );

    await withDb(async () => {
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });

      feed.depths.push({ asks: [[101, 100]], bids: [[101, 100]] });
      const results = await Promise.allSettled([
        closePaperPosition(pos.id, "MANUAL"),
        closePaperPosition(pos.id, "MANUAL"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({ code: "POSITION_ALREADY_CLOSED" });
    });
  });
});

// =====================================================================
// 11. IDEMPOTENCY — same clientOrderId → single position
// =====================================================================
describe("P0-04 — idempotency: same clientOrderId → tidak buka posisi kedua", () => {
  it("dua openPaperPosition dengan clientOrderId sama → 1 posisi, receipt identik", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },
      { asks: [[100, 100]], bids: [[100, 100]] },
    );

    await withDb(async ({ store }) => {
      const { openPaperPosition } = await import("../../paperBook");
      const result1 = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 10,
        leverage: 10,
        stopLoss: 98,
        takeProfit: 104,
        meta: { clientOrderId: "idem-001" } as any,
      });
      const result2 = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 10,
        leverage: 10,
        stopLoss: 98,
        takeProfit: 104,
        meta: { clientOrderId: "idem-001" } as any,
      });

      expect(result2.order.id).toBe(result1.order.id);
      expect(store.state.positions).toHaveLength(1);
      expect(store.state.positions[0].qty).toBe(10);
    });
  });
});

// =====================================================================
// 12. PARTIAL TP gagal → tidak menutup posisi / kehilangan level
// =====================================================================
describe("P0-04 — partial TP failure → posisi tidak tertutup, level utuh", () => {
  it("partial close gagal DB → posisi masih OPEN qty lama, qty terisi berikutnya tidak ada duplikat", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },  // open
      { asks: [[101, 100]], bids: [[101, 100]] },   // partial close 3
    );

    await withDb(async (s) => {
      const { db, store } = s;
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });

      // Set exitPlan with partial levels — simulating exit engine state
      store.updatePaperPosition(pos.id, {
        exitConfig: { partialLevels: [{ rMultiple: 0.5, closePct: 30 }, { rMultiple: 1, closePct: 30 }] },
      });
      const planBefore = JSON.parse(JSON.stringify(store.state.positions.find((p) => p.id === pos.id)!.exitPlan!));

      // ── fail on partial ──
      failCommit.value = true;
      await expect(closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 3)).rejects.toMatchObject({ code: "DB_TX_FAILED" });

      // Level utuh, qty tidak berkurang
      const live = store.state.positions.find((p) => p.id === pos.id)!;
      expect(live.qty).toBe(10);
      expect(live.exitPlan).toEqual(planBefore);

      // ── first successful partial ──
      feed.depths.push({ asks: [[101, 100]], bids: [[101, 100]] });
      const r1 = await closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 3);
      expect(r1.partial).toBe(true);
      expect(r1.remainingQty).toBeCloseTo(7, 8);

      // ── second partial on same position — no duplicate close ──
      feed.depths.push({ asks: [[101, 100]], bids: [[101, 100]] });
      const r2 = await closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 3);
      expect(r2.partial).toBe(true);
      expect(r2.remainingQty).toBeCloseTo(4, 8);

      // Only 1 position, total closed qty sums correctly
      const finalPos = store.state.positions.find((p) => p.id === pos.id)!;
      expect(finalPos.status).toBe("OPEN");
      expect(finalPos.qty).toBeCloseTo(4, 8);

      // DB agrees
      const posRow = db.prepare("SELECT amount, status FROM positions WHERE id = ?").get(pos.id) as any;
      expect(posRow.status).toBe("OPEN");
      expect(posRow.amount).toBeCloseTo(4, 8);
    });
  });
});

// =====================================================================
// 13. HTTP — DB gagal → error jujur; retry via HTTP sukses
// =====================================================================
describe("P0-04 — HTTP: DB gagal close → 400 DB_TX_FAILED; retry sukses", () => {
  it("via /api/broker/close: fail → 400 reason=DB_TX_FAILED, positions masih OPEN; retry → 200, FLAT", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },
      { asks: [[101, 100]], bids: [[101, 100]] },
    );

    await withDb(async () => {
      const token = await login();

      const openRes = await request(appHttp)
        .post("/api/broker/order")
        .set("Authorization", `Bearer ${token}`)
        .send({ symbol: "BTC/USDT", side: "buy", amount: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });
      expect(openRes.status).toBe(200);
      const positionId = openRes.body.position.id as string;

      // ── fail close ──
      failCommit.value = true;
      const closeFail = await request(appHttp)
        .post("/api/broker/close")
        .set("Authorization", `Bearer ${token}`)
        .send({ positionId });
      expect(closeFail.status).toBe(400);
      expect(closeFail.body.reason).toBe("DB_TX_FAILED");

      const posRes = await request(appHttp).get("/api/broker/positions").set("Authorization", `Bearer ${token}`);
      const stillOpen = posRes.body.positions.find((p: any) => p.id === positionId);
      expect(stillOpen).toBeDefined();
      expect(stillOpen.qty).toBe(10);
      expect(stillOpen.status).toBe("OPEN");

      // ── retry ──
      feed.depths.push({ asks: [[101, 100]], bids: [[101, 100]] });
      const closeOk = await request(appHttp)
        .post("/api/broker/close")
        .set("Authorization", `Bearer ${token}`)
        .send({ positionId });
      expect(closeOk.status).toBe(200);
      expect(closeOk.body.closed).toBe(true);

      const flatRes = await request(appHttp).get("/api/broker/positions").set("Authorization", `Bearer ${token}`);
      const openPositions = flatRes.body.positions.filter((p: any) => p.status === "OPEN");
      expect(openPositions).toHaveLength(0);
    });
  });
});
