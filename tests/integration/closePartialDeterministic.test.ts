// =====================================================================
// P0-02 — Satu hasil fill per eksekusi (partial dari full-close + NO_DEPTH)
//
// Expected (dihitung dari persamaan ekonomi, BUKAN salinan output):
//   - Open BUY 10 BTC @100 lev10 (taker 0.0004):
//       margin     = 100*10/10        = 100
//       entry fee  = 100*10*0.0004    = 0.4
//       cash       = 10000 - 100 - 0.4= 9899.6
//   - Full-close kena depth SEMPIT (bids hanya 2 @101):
//       filledQty  = 2, remaining 8 → partial close (bukan full), posisi OPEN 8
//       gross      = (101-100)*2      = 2.0
//       fee entry bagian = 0.4*(2/10)= 0.08
//       fee exit   = 101*2*0.0004     = 0.0808
//       realized   = 2 - 0.08 - 0.0808 = 1.8392
//       marginRelease = 100*(2/10)    = 20
//       cash       = 9899.6 + 20 + 2 - 0.0808 = 9921.5192 → round(2) 9921.52
//   - Fixture KEDUA (bids berubah tajam ke 50) HARUS TIDAK dipakai:
//     fetchOrderBook hanya 2x (open 1x + close 1x) — satu hasil fill per eksekusi.
//   - NO_DEPTH orderbook kosong / level invalid → REJECT (fail-closed), posisi
//     tetap OPEN 10 — TIDAK menjadi fake full fill (jangan jatuh ke ticker).
//   - HTTP /api/broker/close pada partial → closed:false, partial:true,
//     remainingQty:8 (API tidak menyebut seluruh posisi closed).
//
// ISOLASI: satu static app graph; describe restart tidak dipakai — skenario
// partial langsung dipanggil tanpa proses OS terpisah. Sandbox TEST per test.
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
  process.env.BROKER_EVENT_SECRET = "close-partial-test-secret";
  process.env.AUDIT_HMAC_SECRET = "close-partial-audit-hmac-0123456789abcdef";
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
    evaluateGuardrails: async () => {
      const reasons: string[] = [];
      if (guardState.killSwitch) reasons.push("KILL_SWITCH_ACTIVE");
      if (guardState.lossPercent >= 10) reasons.push("MAX_DAILY_LOSS_EXCEEDED");
      return {
        allowed: reasons.length === 0,
        reasons,
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
      };
    },
    setKillSwitch: (active: boolean) => {
      guardState.killSwitch = Boolean(active);
      return { killSwitch: guardState.killSwitch };
    },
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
const appHttp: Express = app;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-18T00:00:00.000Z"));
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantflow-close-partial-"));
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

async function login(): Promise<string> {
  const res = await request(appHttp).post("/api/auth/login").send({ passcode: "test-passcode" });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

// ------------------------------------------------------------------
// Skenario utama: full-close dengan depth sempit → partial, satu fetch
// ------------------------------------------------------------------
describe("P0-02 — satu hasil fill per eksekusi (unit)", () => {
  it("full-close 10 dengan bids hanya 2 @101 → 2 closed, 8 OPEN; fixture kedua TIDAK dipakai", async () => {
    // depth[0] untuk open (buy, ladder=asks) @100.
    // depth[1] untuk close #1: hanya 2 @101 di sisi bids → partial 2@101.
    // depth[2] HARUS TIDAK dipakai (bids berubah tajam ke 50): kalau kode lama
    // fetch orderbook kedua, exitFillPrice jadi 50 → test ini menggagalkannya.
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },
      { asks: [[101, 100]], bids: [[101, 2]] },
      { asks: [[50, 100]], bids: [[50, 100]] }
    );

    await withDb(async ({ db }) => {
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 10,
        leverage: 10,
        stopLoss: 98,
        takeProfit: 104,
      });
      expect(pos.qty).toBe(10);

      const callsBeforeClose = feed.calls;
      const result = await closePaperPosition(pos.id, "MANUAL");

      expect(result.partial).toBe(true);
      expect(result.remainingQty).toBeCloseTo(8, 8);
      expect(result.exitFillPrice).toBeCloseTo(101, 2); // depth pertama, bukan 50
      expect(result.exitFeeUSD).toBeCloseTo(101 * 2 * TAKER_FEE, 4); // 0.0808
      expect(result.realizedPnlUSD).toBeCloseTo(2 - 100 * 10 * TAKER_FEE * (2 / 10) - 101 * 2 * TAKER_FEE, 2);
      expect(result.realizedPnlUSD).toBeCloseTo(1.84, 2);
      expect(result.cashAfter).toBeCloseTo(9921.52, 2);

      // HANYA satu fetch tambahan untuk close — fixture kedua (50) tidak pernah dibaca.
      expect(feed.calls - callsBeforeClose).toBe(1);

      // Posisi masih OPEN dengan sisa 8 di memori.
      const store = await import("../../src/paperbook/store");
      const live = store.state.positions.find((p) => p.id === pos.id);
      expect(live?.status).toBe("OPEN");
      expect(live?.qty).toBeCloseTo(8, 8);

      // DB posisi setuju (qty 8, status OPEN) dan order partial tercatat.
      const posRow = db.prepare("SELECT status, amount, realized_pnl_usd FROM positions WHERE id = ?").get(pos.id) as any;
      expect(posRow.status).toBe("OPEN");
      expect(posRow.amount).toBeCloseTo(8, 8);
      const sellOrder = db.prepare("SELECT id, amount, price, status FROM orders WHERE symbol = ? AND side = 'sell' ORDER BY created_at DESC").get("BTC/USDT") as any;
      expect(sellOrder).toBeDefined();
      expect(sellOrder.status).toBe("FILLED");
      expect(sellOrder.amount).toBeCloseTo(2, 8);
      // Harga/fee snapshot dari fixture pertama (depth 2 @101) — BUKAN fetch kedua (50).
      const closeFill = db.prepare("SELECT price, amount, fee_usd FROM fills WHERE order_id = ?").get(sellOrder.id) as any;
      expect(Number(closeFill.price)).toBeCloseTo(101, 2);
      expect(Number(closeFill.amount)).toBeCloseTo(2, 8);
      expect(Number(closeFill.fee_usd)).toBeCloseTo(0.0808, 4);
    });
  });

  it("NO_DEPTH (orderbook kosong) saat close → REJECT, posisi tetap OPEN, bukan fake full fill", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },
      { asks: [], bids: [] } // orderbook kosong → NO_DEPTH fail-closed
    );

    await withDb(async ({ db }) => {
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 10,
        leverage: 10,
        stopLoss: 98,
        takeProfit: 104,
      });
      await expect(closePaperPosition(pos.id, "MANUAL")).rejects.toMatchObject({ code: "NO_DEPTH" });

      const store = await import("../../src/paperbook/store");
      const live = store.state.positions.find((p) => p.id === pos.id);
      expect(live?.status).toBe("OPEN");
      expect(live?.qty).toBe(10);

      const posRow = db.prepare("SELECT status, amount FROM positions WHERE id = ?").get(pos.id) as any;
      expect(posRow.status).toBe("OPEN");
      expect(posRow.amount).toBe(10);

      // Tidak ada order penutup phantoom.
      const closes = asRows(db.prepare("SELECT COUNT(*) n FROM orders WHERE symbol = ? AND side = 'sell'").all("BTC/USDT"));
      expect(Number(closes[0].n)).toBe(0);
    });
  });

  it("level orderbook invalid (harga/size 0 atau NaN) dilewati → NO_DEPTH bukan fake fill", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },
      { asks: [[100, 100]], bids: [[0, 5], [101, 0], [NaN, 2]] } // semua invalid → tidak ada likuiditas
    );

    await withDb(async () => {
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT",
        side: "buy",
        qty: 10,
        leverage: 10,
        stopLoss: 98,
        takeProfit: 104,
      });
      await expect(closePaperPosition(pos.id, "MANUAL")).rejects.toMatchObject({ code: "NO_DEPTH" });
      const store = await import("../../src/paperbook/store");
      const live = store.state.positions.find((p) => p.id === pos.id);
      expect(live?.status).toBe("OPEN");
      expect(live?.qty).toBe(10);
    });
  });
});

describe("P0-02 — satu hasil fill per eksekusi (HTTP + UI truth)", () => {
  it("partial dari full-close via HTTP → closed:false, partial:true, remainingQty:8, posisi OPEN", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },
      { asks: [[101, 100]], bids: [[101, 2]] },
      { asks: [[50, 100]], bids: [[50, 100]] }
    );

    await withDb(async () => {
      const token = await login();

      const open = await request(appHttp)
        .post("/api/broker/order")
        .set("Authorization", `Bearer ${token}`)
        .send({ symbol: "BTC/USDT", side: "buy", amount: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });
      expect(open.status).toBe(200);
      expect(open.body.order.status).toBe("FILLED");
      const positionId = open.body.position.id as string;

      const close = await request(appHttp)
        .post("/api/broker/close")
        .set("Authorization", `Bearer ${token}`)
        .send({ positionId });
      expect(close.status).toBe(200);
      expect(close.body.success).toBe(true);
      expect(close.body.closed).toBe(false); // sisa qty masih OPEN
      expect(close.body.partial).toBe(true);
      expect(close.body.remainingQty).toBeCloseTo(8, 8);
      expect(close.body.exitFillPrice).toBeCloseTo(101, 2); // fixture pertama, bukan 50
      expect(close.body.partial).toBe(true);

      const posRes = await request(appHttp).get("/api/broker/positions").set("Authorization", `Bearer ${token}`);
      expect(posRes.body.success).toBe(true);
      const stillOpen = posRes.body.positions.find((p: any) => p.id === positionId);
      expect(stillOpen).toBeDefined();
      expect(stillOpen.side).toBe("LONG");
      expect(stillOpen.qty).toBeCloseTo(8, 8);
      expect(stillOpen.status).toBe("OPEN");
    });
  });

  it("NO_DEPTH saat close via HTTP → 400 REJECTED, posisi masih 10 OPEN, bukan closed", async () => {
    feed.depths.push(
      { asks: [[100, 100]], bids: [[100, 100]] },
      { asks: [], bids: [] }
    );

    await withDb(async () => {
      const token = await login();
      const open = await request(appHttp)
        .post("/api/broker/order")
        .set("Authorization", `Bearer ${token}`)
        .send({ symbol: "BTC/USDT", side: "buy", amount: 10, leverage: 10, stopLoss: 98, takeProfit: 104 });
      expect(open.status).toBe(200);
      const positionId = open.body.position.id as string;

      const close = await request(appHttp)
        .post("/api/broker/close")
        .set("Authorization", `Bearer ${token}`)
        .send({ positionId });
      expect(close.status).toBe(400);
      expect(close.body.success).toBe(false);
      expect(close.body.reason).toBe("NO_DEPTH");

      const posRes = await request(appHttp).get("/api/broker/positions").set("Authorization", `Bearer ${token}`);
      const stillOpen = posRes.body.positions.find((p: any) => p.id === positionId);
      expect(stillOpen).toBeDefined();
      expect(stillOpen.side).toBe("LONG");
      expect(stillOpen.qty).toBe(10);
      expect(stillOpen.status).toBe("OPEN");
    });
  });
});