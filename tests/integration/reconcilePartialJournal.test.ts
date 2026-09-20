// =====================================================================
// P0-05 — Rekonsiliasi fee/PnL/journal untuk trade dengan partial close.
//
// Expected (dihitung dari persamaan ekonomi, BUKAN salinan output):
//   LONG BUY 10 BTC @100 lev10 (TAKER 0.0004), modal 10000:
//     open     : notional 1000, margin 100, entry fee 0.4
//               cash = 10000 − 100 − 0.4 = 9899.6
//     partial1 2 @101 : gross 2; fee-entry 0.4*(2/10)=0.08; exit 101*2*T=0.0808
//               realized 2−0.08−0.0808 = 1.8392 → r2 1.84; margin release 20
//               cash 9899.6+20+2−0.0808 = 9921.5192 → 9921.52
//               feesPaid 0.32 (sisa), feesTotal 0.4808 (kumulatif), openQty 10
//     partial2 2 @102 : gross 4; fee-entry 0.08; exit 102*2*T=0.0816
//               realized 4−0.08−0.0816 = 3.8384 → 3.84; release 20
//               cash 9921.52+20+4−0.0816 = 9945.4384 → 9945.44
//               feesPaid 0.24, feesTotal 0.5624, realized(kum) 5.68, qty 6
//     restart  : cash (snapshot) 9945.44; realizedPnl = SUM(positions) = 5.68
//     final 6 @103 : gross 18; fee exit 103*6*T=0.2472
//               realized 18 − 0.24 − 0.2472 = 17.5128 → 17.51; release 60
//               cash 9945.44+60+18−0.2472 = 10023.1928 → 10023.19
//               feesTotal 0.5624+0.2472 = 0.8096
//     TOTAL: realized 1.84+3.84+17.51 = 23.19 = cash−10000 (flat)
//            fees total = 0.4+0.0808+0.0816+0.2472 = 0.8096
//
// Identity yang diuji:
//   1. positions.fees_total_usd ≡ Σ fills.fee_usd posisi tsb (via orders.position_id)
//      — fee KUMULATIF, beda dari fees_usd (fee entry yang masih menempel sisa.
//   2. positions.realized_pnl_usd (kumulatif) ≡ Σ realized execution ≡
//      state.realizedPnl ≡ cash−10000 setelah FLAT (restart tidak menghilangkan).
//   3. Journal/stats: R = realized / (|entry−SL|·openQty) pakai qty ASAL (10),
//      CLOSE price = VWAP exit (102.4), amount tersimpan = qty sisa (6),
//      openQty = 10, totalFeesUSD = 0.8096.
//   4. Control (tanpa partial): feesTotal = entry+exit, openQty == amount, R normal.
//
// Restart disimulasikan storageRows() — koneksi SQLite read-only KEDUA ke file
// yang sama (disk = memori). Tidak memakai vi.resetModules (aman dengan app statis).
// =====================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  process.env.BROKER_EVENT_SECRET = "reconcile-test-secret";
  process.env.AUDIT_HMAC_SECRET = "reconcile-audit-hmac-0123456789abcdef";
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
      details: {
        killSwitch: false,
        dailyLossPercent: 0,
        maxDailyLossPercent: 10,
        realizedPnlUSD: 0,
        openCount: 0,
        maxOpenPositions: 5,
        cooldownRemainingMs: 0,
        guardsEnabled: true,
      },
    }),
    setKillSwitch: (active: boolean) => ({ killSwitch: Boolean(active) }),
    setGuardsEnabled: (active: boolean) => ({ ok: true, guardsEnabled: Boolean(active) }),
    recordOrderPlaced: () => {},
    getTodayRealized: () => ({ realizedPnlUSD: 0, lossPercent: 0 }),
    getGuardrailsSnapshotSync: () => ({
      config: { killSwitchDefault: false, maxOpenPositions: 5, maxDailyLossPercent: 10, minOrderIntervalMs: 0 },
      state: { killSwitch: false, dailyLossPercent: 0, openCount: 0, lastOrderAt: null, cooldownRemainingMs: 0, armedForLive: false, guardsEnabled: true },
      today: { realizedPnlUSD: 0, lossPercent: 0 },
    }),
    getGuardrailsSnapshotAsync: async () => ({
      config: { killSwitchDefault: false, maxOpenPositions: 5, maxDailyLossPercent: 10, minOrderIntervalMs: 0 },
      state: { killSwitch: false, dailyLossPercent: 0, openCount: 0, lastOrderAt: null, cooldownRemainingMs: 0, armedForLive: false, guardsEnabled: true },
      today: { realizedPnlUSD: 0, lossPercent: 0 },
    }),
  };
});

import { app } from "../../server";
const appHttp: Express = app;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-18T00:00:00.000Z"));
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantflow-reconcile-"));
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

/** Restart disimulasikan: koneksi SQLite read-only kedua ke file yang sama. */
function storageRows(dbPath: string) {
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  const positions = conn.prepare("SELECT id, status, amount, open_qty, fees_total_usd, realized_pnl_usd, close_price FROM positions ORDER BY opened_at").all() as any[];
  const orders = conn.prepare("SELECT id, position_id, side, amount, price, status FROM orders ORDER BY created_at").all() as any[];
  const fills = conn.prepare("SELECT id, order_id, side, price, amount, fee_usd FROM fills ORDER BY created_at").all() as any[];
  const snap = conn.prepare("SELECT ts, cash, equity, unrealized_pnl FROM portfolio_snapshots ORDER BY ts DESC").all() as any[];
  conn.close();
  return { positions, orders, fills, snap, totalFeesFor: (pid: string) => sumFeesFor(dbPath, pid) };
}

// Bantuan: Σ fills fee per posisi via orders.position_id (DB terpisah read-only).
function sumFeesFor(dbPath: string, positionId: string): number {
  const conn = new DatabaseSync(dbPath, { readOnly: true });
  const row = conn
    .prepare(
      "SELECT COALESCE(SUM(f.fee_usd),0) as s FROM fills f JOIN orders o ON f.order_id = o.id WHERE o.position_id = ?"
    )
    .get(positionId) as any;
  conn.close();
  return Number(row.s);
}

// ------------------------------------------------------------------
// Skenario A: 2 partial + restart + final close → kembali flat.
// Rekonsiliasi fee (Σ fills), realized kumulatif, R, VWAP, journal.
// ------------------------------------------------------------------
describe("P0-05 — multi-partial + restart + final close: fee/PnL/journal rekonsiliasi", () => {
  it("fee ≡ Σ fills per posisi; realized kumulatif ≡ state ≡ disk; R pakai openQty; VWAP close; HTTP journal", async () => {
    feed.depths.push(
      { asks: [[100, 20]], bids: [[100, 20]] }, // open 10 @100
      { asks: [[100, 20]], bids: [[101, 20]] }, // partial1 2 @101
      { asks: [[100, 20]], bids: [[102, 20]] }, // partial2 2 @102
      { asks: [[100, 20]], bids: [[103, 20]] } // final 6 @103
    );

    await withDb(async ({ db, dbPath, store }) => {
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      });

      // ── open ──
      expect(store.state.cash).toBeCloseTo(9899.6, 2);
      const p0 = store.state.positions.find((p) => p.id === pos.id)!;
      expect(p0.openQty).toBeCloseTo(10, 8);
      expect(p0.feesPaidUSD).toBeCloseTo(0.4, 4);
      expect(p0.feesTotalUSD).toBeCloseTo(0.4, 4);

      // ── partial1 2@101 ──
      const pr1 = await closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 2);
      expect(pr1.realizedPnlUSD).toBeCloseTo(1.84, 2);
      expect(store.state.cash).toBeCloseTo(9921.52, 2);
      let lp = store.state.positions.find((p) => p.id === pos.id)!;
      expect(lp.qty).toBeCloseTo(8, 8);
      expect(lp.feesPaidUSD).toBeCloseTo(0.32, 4); // fee entry SISA di posisi
      expect(lp.feesTotalUSD).toBeCloseTo(0.4808, 4); // kumulatif hidup posisi
      expect(lp.openQty).toBeCloseTo(10, 8); // TIDAK menyusut
      expect(lp.realizedPnlUSD).toBeCloseTo(1.84, 2);
      expect(store.state.realizedPnl).toBeCloseTo(1.84, 2);

      // ── partial2 2@102 ──
      const pr2 = await closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 2);
      expect(pr2.realizedPnlUSD).toBeCloseTo(3.84, 2);
      expect(store.state.cash).toBeCloseTo(9945.44, 2);
      lp = store.state.positions.find((p) => p.id === pos.id)!;
      expect(lp.qty).toBeCloseTo(6, 8);
      expect(lp.feesPaidUSD).toBeCloseTo(0.24, 4); // tersisa
      expect(lp.feesTotalUSD).toBeCloseTo(0.5624, 4); // = 0.4+0.0808+0.0816
      expect(lp.realizedPnlUSD).toBeCloseTo(5.68, 2);
      expect(store.state.realizedPnl).toBeCloseTo(5.68, 2);

      // Semantik: fee menempel SISA ≠ seluruh fee historis (P0-05 item 2).
      expect(lp.feesPaidUSD).toBeLessThan(lp.feesTotalUSD!);

      // ── total fee posisi vs Σ fills (identity) — MID-TRADE ──
      expect(sumFeesFor(dbPath, pos.id)).toBeCloseTo(0.5624, 4);

      // DB open_qty/fees_total tercatat benar.
      const rowMid = db.prepare("SELECT amount, open_qty, fees_total_usd FROM positions WHERE id = ?").get(pos.id) as any;
      expect(Number(rowMid.amount)).toBeCloseTo(6, 8);
      expect(Number(rowMid.open_qty)).toBeCloseTo(10, 8);
      expect(Number(rowMid.fees_total_usd)).toBeCloseTo(0.5624, 4);

      // ── restart #1 (disk read-only = memori; STORE rehydrate ekuivalen) ──
      const diskMid = storageRows(dbPath);
      expect(Number(diskMid.snap[0].cash)).toBeCloseTo(9945.44, 2);
      // equity = cash + marginLocked 60 + uPnL 6×(mark 102 − 100) = 10017.44.
      expect(Number(diskMid.snap[0].equity)).toBeCloseTo(10017.44, 2);
      const posDiskMid = diskMid.positions.find((p) => p.id === pos.id)!;
      expect(posDiskMid.status).toBe("OPEN");
      expect(Number(posDiskMid.amount)).toBeCloseTo(6, 8);
      expect(Number(posDiskMid.open_qty)).toBeCloseTo(10, 8);
      expect(Number(posDiskMid.fees_total_usd)).toBeCloseTo(0.5624, 4);
      expect(Number(posDiskMid.realized_pnl_usd)).toBeCloseTo(5.68, 2);

      // ── final close 6@103 ──
      const fr = await closePaperPosition(pos.id, "TAKE_PROFIT");
      expect(fr.realizedPnlUSD).toBeCloseTo(17.51, 2);
      expect(store.state.cash).toBeCloseTo(10023.19, 2);
      expect(store.state.realizedPnl).toBeCloseTo(23.19, 2); // 5.68 + 17.51
      const closed = store.state.positions.find((p) => p.id === pos.id)!;
      expect(closed.status).toBe("CLOSED");
      expect(closed.feesTotalUSD).toBeCloseTo(0.8096, 4); // 0.5624+0.2472
      expect(closed.openQty).toBeCloseTo(10, 8);

      // ── identity total fee vs Σ fills — FINAL ──
      expect(sumFeesFor(dbPath, pos.id)).toBeCloseTo(0.8096, 4);
      const fillsSum = asRows(
        db.prepare("SELECT f.side, f.price, f.amount, f.fee_usd FROM fills f JOIN orders o ON f.order_id = o.id WHERE o.position_id = ? ORDER BY f.created_at").all(pos.id)
      );
      const expectFees = [0.4, 0.0808, 0.0816, 0.2472];
      expect(fillsSum.map((f: any) => Number(f.fee_usd))).toEqual(expectFees.map((v) => expect.closeTo(v, 4)));
      expect(fillsSum.reduce((s: number, f: any) => s + Number(f.fee_usd), 0)).toBeCloseTo(0.8096, 4);

      // ── restart #2 (flat): realized kumulatif TIDAK hilang / TIDAK dobel ──
      const diskFinal = storageRows(dbPath);
      const closedRow = diskFinal.positions.find((p) => p.id === pos.id)!;
      expect(closedRow.status).toBe("CLOSED");
      expect(Number(closedRow.amount)).toBeCloseTo(6, 8); // qty sisa saat ditutup
      expect(Number(closedRow.open_qty)).toBeCloseTo(10, 8); // ukuran trade asal
      expect(Number(closedRow.realized_pnl_usd)).toBeCloseTo(23.19, 2);
      expect(Number(closedRow.fees_total_usd)).toBeCloseTo(0.8096, 4);
      expect(Number(diskFinal.snap[0].cash)).toBeCloseTo(10023.19, 2);
      expect(Number(diskFinal.snap[0].equity)).toBeCloseTo(10023.19, 2); // flat → equity = cash

      // ── statistik/journal (ledger): R pakai openQty, VWAP close, totalFees ──
      const { getLedgerStats } = await import("../../db");
      const stats = getLedgerStats();
      expect(stats.totalTrades).toBe(1);
      expect(stats.realizedPnlUSD).toBeCloseTo(23.19, 2);
      // R = 23.19 / (|100−98| × openQty 10 = 20) = 1.1595 → r2 1.16 — BUKAN qty sisa 6.
      expect(stats.avgR).toBeCloseTo(1.16, 2);
      expect(stats.avgR).toBeLessThan(23.19 / 12); // versi salah (qty sisa 6) = 1.93 lebih besar
      expect(stats.closedTrades.length).toBe(1);
      const t = stats.closedTrades[0];
      expect(t.openQty).toBeCloseTo(10, 8);
      expect(t.amount).toBeCloseTo(6, 8); // kolom as-is = qty sisa
      expect(t.totalFeesUSD).toBeCloseTo(0.8096, 4);
      expect(t.realizedPnlUsd).toBeCloseTo(23.19, 2);
      expect(t.closePrice).toBeCloseTo((2 * 101 + 2 * 102 + 6 * 103) / 10, 2); // VWAP 102.4

      // ── HTTP journal membawa openQty/totalFeesUSD (serialisasi route) ──
      const token = await login();
      const res = await request(appHttp).get("/api/ledger/stats").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const body = res.body as any;
      expect(body.realizedPnlUSD).toBeCloseTo(23.19, 2);
      expect(body.closedTrades[0].openQty).toBeCloseTo(10, 8);
      expect(body.closedTrades[0].totalFeesUSD).toBeCloseTo(0.8096, 4);
      expect(body.closedTrades[0].closePrice).toBeCloseTo(102.4, 2);
    });
  });
});

// ------------------------------------------------------------------
// Skenario B (control): close PENUH tanpa partial — fees = entry+exit,
// openQty == amount, closePrice = harga exit, R normal.
// ------------------------------------------------------------------
describe("P0-05 — control: close penuh tanpa partial tetap konsisten", () => {
  it("feesTotal = entry+exit; openQty == amount; closePrice == exit price; R normal", async () => {
    feed.depths.push(
      { asks: [[100, 20]], bids: [[100, 20]] }, // open
      { asks: [[100, 20]], bids: [[103, 20]] } // final penuh 10 @103
    );

    await withDb(async ({ dbPath, store }) => {
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      });
      const p0 = store.state.positions.find((p) => p.id === pos.id)!;
      expect(p0.openQty).toBeCloseTo(10, 8);
      expect(p0.feesTotalUSD).toBeCloseTo(0.4, 4);

      const fr = await closePaperPosition(pos.id, "TAKE_PROFIT");
      expect(fr.realizedPnlUSD).toBeCloseTo(29.19, 2); // gross 30 − 0.4 − 0.412
      expect(store.state.cash).toBeCloseTo(10029.19, 2);
      const closed = store.state.positions.find((p) => p.id === pos.id)!;
      expect(closed.feesTotalUSD).toBeCloseTo(0.812, 4); // 0.4 + 0.412
      expect(closed.openQty).toBeCloseTo(10, 8);

      // fee per posisi vs Σ fills.
      expect(sumFeesFor(dbPath, pos.id)).toBeCloseTo(0.812, 4);

      const { getLedgerStats } = await import("../../db");
      const stats = getLedgerStats();
      expect(stats.totalTrades).toBe(1);
      expect(stats.avgR).toBeCloseTo(1.46, 2); // 29.19/20 = 1.4595 → r2
      const t = stats.closedTrades[0];
      expect(t.openQty).toBeCloseTo(10, 8);
      expect(t.amount).toBeCloseTo(10, 8); // tanpa partial: amount == openQty
      expect(t.closePrice).toBeCloseTo(103, 2); // satu exit -> harga itu sendiri
      expect(t.totalFeesUSD).toBeCloseTo(0.812, 4);
    });
  });
});