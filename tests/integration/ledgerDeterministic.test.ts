// =====================================================================
// P0-00 — Ledger deterministik sebagai baseline.
//
// Prinsip (dari TODO.md): expected DITULIS DARI PERSAMAAN EKONOMI dahulu,
// bukan menyalin output aplikasi. Setiap angka di bawah dihitung manual:
//
//   Taker 0.0004 (4 bps). Isolated futures, margin = notional / leverage.
//
//   LONG 10@100, lev10:
//     entry fee        = 100 * 10 * 0.0004             = 0.4
//     cash setelah open = 10000 - 100 (margin) - 0.4    = 9899.6
//
//     partial close 2 @101:
//       gross        = (101 - 100) * 2                  = 2
//       entry fee %  = 0.4 * (2/10)                     = 0.08
//       exit fee     = 101 * 2 * 0.0004                 = 0.0808
//       net partial  = 2 - 0.08 - 0.0808                = 1.8392
//       margin lepas = 100 * 0.2                        = 20
//       cash after   = 9899.6 + 20 + 2 - 0.0808         = 9921.52
//       sisa entry fee menempel pada posisi             = 0.32
//
//     full close sisa 8 @103:
//       gross        = (103 - 100) * 8                  = 24
//       exit fee     = 103 * 8 * 0.0004                 = 0.3296
//       net close    = 24 - 0.32 - 0.3296               = 23.3504
//       cash after   = 9921.52 + 80 + 24 - 0.3296       = 10025.19
//
//     TOTAL realized = 1.8392 + 23.3504                 = 25.1896 ≈ 25.19
//     pos.feesPaidUSD final = sisa entry (0.32) + exit (0.3296) = 0.6496
//     (fee partial 0.0808 sudah ter-realisasi ke realized PnL/cash)
//
//   SHORT 5@100 lev10, close @95:
//     entry fee = 0.2 ; exit fee = 95*5*0.0004 = 0.19 ; gross = 25
//     net = 25 - 0.2 - 0.19 = 24.61 ; cash = 9949.8 + 50 + 25 - 0.19 = 10024.61
//
//   LONG loss 10@100, close @95 (STOP_LOSS):
//     gross = -50 ; fees = 0.4 + 0.38 = 0.78 ; net = -50.78
//     cash  = 9899.6 + 100 - 50 - 0.38 = 9949.22
//
//   HTTP full cycle 10@100 → close @103:
//     exit fee = 103*10*0.0004 = 0.412 ; net = 30 - 0.4 - 0.412 = 29.188 ≈ 29.19
//     cash = 9899.6 + 100 + 30 - 0.412 = 10029.19
//
// Toleransi pembulatan: aplikasi mem-ROUND ke 2 desimal (cents) di setiap
// mutasi (r2), jadi expected dibandingkan dengan toBeCloseTo(_, 2) (deviasi
// <= 0.005). Harga/fee per fill disimpan lebih presisi (6/4 desimal) dan
// diperiksa terpisah agar drift cents tidak menumpuk.
//
// Cakupan:
//   1) Unit (fungsi langsung)  — LONG partial+full, SHORT, LONG loss.
//   2) HTTP + SQLite NYATA (Supertest + node:sqlite di sandbox temp) —
//      auth login, order, balance/positions, close, ledger verify.
//   3) Restart/rehydrate — PnL tidak hilang dan tidak double-count.
//   Broker/exchange & marketFetcher di-mock (tanpa network); guardrails
//   di-mock (bukan subjek P0-00); DB TIDAK dimock — pakai SQLite asli.
//
// ISOLASI & URUTAN: seluruh file memakai SATU graph modul (static app dari
// server.ts) — rusak bila di-`vi.resetModules()` di tengah (DB singleton
// tertutup di instance lama, app menunjuk kematian → HTTP 400 DB_TX_FAILED).
// Karena itu describe restart SIMULASI diletakkan PALING AKHIR dan memakai
// `vi.resetModules()` bebas: sesudahnya tidak ada kode yang menautkan ke
// instance lama. Baris ini sengaja di darat: restart ≠ module graph baru,
// restart = rehydrate state in-memory dari SQLite (lihat initPaperBook).
// =====================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

// env sebelum import (server.ts dibaca pada file-load) — lihat catatan HTTP.
vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  process.env.TRADING_MODE = "paper";
  process.env.AUTH_PASSCODE = "test-passcode";
  process.env.VITE_ENABLED = "false";
  process.env.BROKER_EVENT_SECRET = "ledger-http-test-secret";
  process.env.AUDIT_HMAC_SECRET = "ledger-audit-secret-0123456789abcdef0123456789abcdef";
});

const TAKER_FEE = 0.0004;
const INITIAL_CASH = 10000;
const originalCwd = process.cwd();
let sandboxDir = "";

// ------------------------------------------------------------------
// Feed orderbook deterministik (dipakai mock broker)
// ------------------------------------------------------------------
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

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-18T00:00:00.000Z"));
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantflow-ledger-test-"));
  process.chdir(sandboxDir);
  feed.reset();
});

afterEach(() => {
  // CWD harus dipulihkan SEBELUM rm: Windows menolak menghapus direktori
  // yang menjadi process.cwd() (EPERM). Timers dipulihkan dulu agar retry
  // pakai jam nyata.
  process.chdir(originalCwd);
  vi.useRealTimers();
  if (sandboxDir) rmSafe(sandboxDir);
  sandboxDir = "";
});

// rm dengan retry pendek berbasis jam nyata (pegang WAL/SHM windows).
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

// ------------------------------------------------------------------
// Helper: inisialisasi SQLite nyata di sandbox + state paperbook fresh.
// PREKONDISI modul: db singleton NULL dari test sebelumnya (finally dgn
// closeDb di setiap test) → initDb() membuka file BARU di cwd sandbox ini.
// ------------------------------------------------------------------
async function initTestDb() {
  const { initDb, getDb, getDbFilePath, closeDb } = await import("../../db");
  initDb();
  const store = await import("../../src/paperbook/store");
  Object.assign(store.state, store.freshState());
  return { db: getDb(), dbPath: getDbFilePath(), closeDb, store };
}

/** Wrap test body: koneksi SQLite DIJAMIN tertutup (finally) walau assert gagal
 *  → handle tidak bocor → rm sandbox tidak terkena EPERM. */
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
// Unit accounting
// ------------------------------------------------------------------
describe("P0-00 — Deterministic Ledger (unit)", () => {
  it("LONG: open 10@100 lev10, partial close 2@101, full close 8@103", async () => {
    feed.depths.push({ asks: [[100, 20]], bids: [[100, 20]] });
    feed.depths.push({ asks: [[100, 20]], bids: [[101, 5]] });
    feed.depths.push({ asks: [[100, 20]], bids: [[103, 10]] });

    await withDb(async ({ db, dbPath }) => {
      expect(dbPath.startsWith(sandboxDir)).toBe(true);

      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { getPaperAccount, getPaperEvents } = await import("../../src/paperbook/store");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const { position: pos1, account: acct1 } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      });
      // entry 10 @100, fee 0.4 → cash 9899.6, margin 100, equity 9999.6
      expect(pos1.qty).toBeCloseTo(10, 6);
      expect(pos1.entryPrice).toBeCloseTo(100, 2);
      expect(pos1.feesPaidUSD).toBeCloseTo(0.4, 4);
      expect(pos1.marginUSD).toBeCloseTo(100, 4);
      expect(acct1.cash).toBeCloseTo(9899.6, 2);
      expect(acct1.equity).toBeCloseTo(9999.6, 2);

      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      const { realizedPnlUSD: pnl2, cashAfter: cash2, remainingQty } = await closePaperPosition(pos1.id, "PARTIAL_TAKE_PROFIT", 2);
      const acct2 = getPaperAccount();
      const store2 = (await import("../../src/paperbook/store")).state;
      // partial 2 @101: net 1.8392 → r2 1.84; cash 9921.52; margin sisa 80
      expect(pnl2).toBeCloseTo(1.84, 2);
      expect(cash2).toBeCloseTo(9921.52, 2);
      expect(remainingQty).toBeCloseTo(8, 6);
      expect(acct2.cash).toBeCloseTo(9921.52, 2);
      expect(acct2.marginLocked).toBeCloseTo(80, 4);
      expect(store2.realizedPnl).toBeCloseTo(1.84, 2);
      // posisi sisa: qty 8, fee entry tersisa 0.32, PnL kumulatif 1.84
      const posAfterPartial = store2.positions.find((p) => p.id === pos1.id);
      expect(posAfterPartial).toBeDefined();
      expect(posAfterPartial!.qty).toBeCloseTo(8, 6);
      expect(posAfterPartial!.feesPaidUSD).toBeCloseTo(0.32, 4);
      expect(posAfterPartial!.realizedPnlUSD).toBeCloseTo(1.84, 2);

      vi.setSystemTime(Date.parse("2026-09-18T00:00:03.000Z"));
      const { position: pos3, realizedPnlUSD: pnl3, cashAfter: cash3 } = await closePaperPosition(pos1.id, "TAKE_PROFIT");
      const acct3 = getPaperAccount();
      // close 8 @103: net 23.3504 → r2 23.35; total 25.19; cash 10025.19
      expect(pnl3).toBeCloseTo(23.35, 2);
      expect(cash3).toBeCloseTo(10025.19, 2);
      expect(acct3.cash).toBeCloseTo(10025.19, 2);
      expect(acct3.equity).toBeCloseTo(10025.19, 2);
      expect(acct3.realizedPnl).toBeCloseTo(25.19, 2);
      expect(acct3.openCount).toBe(0);
      expect(acct3.marginLocked).toBeCloseTo(0, 2);
      expect((await import("../../src/paperbook/store")).state.realizedPnl).toBeCloseTo(25.19, 2);
      expect(pos3.status).toBe("CLOSED");
      expect(pos3.realizedPnlUSD).toBeCloseTo(25.19, 2);
      // fees melekat pada posisi = sisa entry (0.32) + exit (0.3296); fee partial sudah ter-realisasi
      expect(pos3.feesPaidUSD).toBeCloseTo(0.32 + 0.3296, 4);

      // DB — posisi tunggal, CLOSED, realized 25.19
      const posRows = asRows(db.prepare("SELECT status, realized_pnl_usd FROM positions WHERE symbol = ?").all("BTC/USDT"));
      expect(posRows.length).toBe(1);
      expect(posRows[0].status).toBe("CLOSED");
      expect(Number(posRows[0].realized_pnl_usd)).toBeCloseTo(25.19, 2);
      // DB — orders: entry + partial + full = 3, semua FILLED
      const orderRows = asRows(db.prepare("SELECT status, price FROM orders WHERE symbol = ? ORDER BY created_at").all("BTC/USDT"));
      expect(orderRows.length).toBe(3);
      expect(orderRows.every((r) => r.status === "FILLED")).toBe(true);
      // DB — fills: entry 10@100, partial 2@101, full 8@103 (harga/fee presisi)
      const fillRows = asRows(db.prepare("SELECT price, amount, fee_usd FROM fills WHERE symbol = ? ORDER BY created_at").all("BTC/USDT"));
      expect(fillRows.length).toBe(3);
      expect(Number(fillRows[0].price)).toBeCloseTo(100, 6);
      expect(Number(fillRows[0].amount)).toBeCloseTo(10, 6);
      expect(Number(fillRows[0].fee_usd)).toBeCloseTo(0.4, 4);
      expect(Number(fillRows[1].price)).toBeCloseTo(101, 6);
      expect(Number(fillRows[1].amount)).toBeCloseTo(2, 6);
      expect(Number(fillRows[1].fee_usd)).toBeCloseTo(0.0808, 4);
      expect(Number(fillRows[2].price)).toBeCloseTo(103, 6);
      expect(Number(fillRows[2].amount)).toBeCloseTo(8, 6);
      expect(Number(fillRows[2].fee_usd)).toBeCloseTo(0.3296, 4);

      // Events (ring buffer) — lifecycle utuh, tidak ada event palsu
      const types = getPaperEvents(0).map((e) => e.type);
      expect(types).toContain("ORDER_NEW");
      expect(types).toContain("ORDER_FILLED");
      expect(types).toContain("POSITION_PARTIAL_CLOSED");
      expect(types).toContain("POSITION_CLOSED");
      expect(types.filter((t) => t === "POSITION_CLOSED")).toHaveLength(1);
    });
  });

  it("SHORT: open 5@100 lev10 SL=102 TP=95, close @95", async () => {
    feed.depths.push({ asks: [[100, 10]], bids: [[100, 10]] });
    feed.depths.push({ asks: [[95, 10]], bids: [[95, 10]] });

    await withDb(async ({ db, dbPath, closeDb }) => {
      expect(dbPath.startsWith(sandboxDir)).toBe(true);
      void closeDb;

      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { getPaperAccount, getPaperEvents } = await import("../../src/paperbook/store");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const { position: pos, account: acct1 } = await openPaperPosition({
        symbol: "ETH/USDT", side: "sell", qty: 5, leverage: 10, stopLoss: 102, takeProfit: 95,
      });
      // SHORT entry 5@100: margin 50, fee 0.2 → cash 9949.8
      expect(pos.side).toBe("SHORT");
      expect(acct1.cash).toBeCloseTo(9949.8, 2);
      expect(acct1.equity).toBeCloseTo(9999.8, 2);

      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      const { realizedPnlUSD, cashAfter } = await closePaperPosition(pos.id, "TAKE_PROFIT");
      // close @95: gross 25, fees 0.2+0.19 → net 24.61; cash 10024.61
      expect(realizedPnlUSD).toBeCloseTo(24.61, 2);
      expect(cashAfter).toBeCloseTo(10024.61, 2);
      const acct2 = getPaperAccount();
      expect(acct2.cash).toBeCloseTo(10024.61, 2);
      expect(acct2.equity).toBeCloseTo(10024.61, 2);
      expect(acct2.realizedPnl).toBeCloseTo(24.61, 2);

      const posRow = asRows(db.prepare("SELECT status, realized_pnl_usd FROM positions WHERE symbol = ?").all("ETH/USDT"));
      expect(posRow[0].status).toBe("CLOSED");
      expect(Number(posRow[0].realized_pnl_usd)).toBeCloseTo(24.61, 2);
      const fillRows = asRows(db.prepare("SELECT fee_usd FROM fills WHERE symbol = ? ORDER BY created_at").all("ETH/USDT"));
      expect(fillRows.length).toBe(2);
      expect(Number(fillRows[0].fee_usd)).toBeCloseTo(0.2, 4);
      expect(Number(fillRows[1].fee_usd)).toBeCloseTo(0.19, 4);

      const types = getPaperEvents(0).map((e) => e.type);
      expect(types).toContain("ORDER_FILLED");
      expect(types.filter((t) => t === "POSITION_CLOSED")).toHaveLength(1);
    });
  });

  it("LONG loss: open 10@100 lev10, market close @ 95 (STOP_LOSS)", async () => {
    feed.depths.push({ asks: [[100, 20]], bids: [[100, 20]] });
    feed.depths.push({ asks: [[95, 20]], bids: [[95, 10]] });

    await withDb(async ({ db }) => {
      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");
      const { getPaperAccount } = await import("../../src/paperbook/store");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const { position: pos, account: acct1 } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      });
      expect(acct1.cash).toBeCloseTo(9899.6, 2);

      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      const { realizedPnlUSD, cashAfter } = await closePaperPosition(pos.id, "STOP_LOSS");
      // close @95: gross -50, fees 0.78 → net -50.78; cash 9949.22
      expect(realizedPnlUSD).toBeCloseTo(-50.78, 2);
      expect(cashAfter).toBeCloseTo(9949.22, 2);
      const acct2 = getPaperAccount();
      expect(acct2.cash).toBeCloseTo(9949.22, 2);
      expect(acct2.equity).toBeCloseTo(9949.22, 2);
      expect(acct2.realizedPnl).toBeCloseTo(-50.78, 2);

      const posRow = asRows(db.prepare("SELECT status, realized_pnl_usd FROM positions WHERE symbol = ?").all("BTC/USDT"));
      expect(posRow[0].status).toBe("CLOSED");
      expect(Number(posRow[0].realized_pnl_usd)).toBeCloseTo(-50.78, 2);
      const orderRows = asRows(db.prepare("SELECT status FROM orders WHERE symbol = ?").all("BTC/USDT"));
      expect(orderRows.length).toBe(2);
    });
  });
});

// ------------------------------------------------------------------
// HTTP + SQLite NYATA — jalur yang dipakai UI/autopilot (SEBELUM restart:
// apa pun yang pakai `vi.resetModules()` TIDAK boleh di sini — app statis
// menaut ke graph modul yang sama).
// ------------------------------------------------------------------
let appHttp: Express;
let token: string;

async function login(): Promise<string> {
  const res = await request(appHttp).post("/api/auth/login").send({ passcode: "test-passcode" });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.token as string;
}

describe("P0-00 — HTTP architecture + SQLite nyata (Supertest)", () => {
  beforeAll(() => {
    appHttp = app;
  });

  beforeEach(() => {
    token = "";
  });

  it("tanpa token → 401; dengan token → paper mode", async () => {
    const anon = await request(appHttp).get("/api/broker/balance");
    expect(anon.status).toBe(401);

    const t = await login();
    const status = await request(appHttp).get("/api/broker/status").set("Authorization", `Bearer ${t}`);
    expect(status.status).toBe(200);
    expect(status.body.mode).toBe("paper");
  });

  it("LONG open 10@100 lev10 via HTTP → balance/positions akurat; full close @103 → 29.19, cash 10029.19", async () => {
    feed.depths.push({ asks: [[100, 20]], bids: [[100, 20]] });
    feed.depths.push({ asks: [[100, 20]], bids: [[103, 20]] });

    await withDb(async ({ db }) => {
      token = await login();

      // ---- open ----
      const open = await request(appHttp)
        .post("/api/broker/order")
        .set("Authorization", `Bearer ${token}`)
        .send({
          symbol: "BTC/USDT",
          side: "buy",
          amount: 10,
          leverage: 10,
          stopLoss: 98,
          takeProfit: 104,
        });
      expect(open.status).toBe(200);
      expect(open.body.success).toBe(true);
      expect(open.body.order.status).toBe("FILLED");
      expect(open.body.order.fillPrice).toBeCloseTo(100, 6);
      expect(open.body.order.feeUSD).toBeCloseTo(0.4, 4);
      expect(open.body.position.feesPaidUSD).toBeCloseTo(0.4, 4);

      // ---- balance (paper) ----
      const bal = await request(appHttp).get("/api/broker/balance").set("Authorization", `Bearer ${token}`);
      expect(bal.status).toBe(200);
      expect(bal.body.account.cash).toBeCloseTo(9899.6, 2);
      expect(bal.body.account.marginLocked).toBeCloseTo(100, 2);
      expect(bal.body.account.equity).toBeCloseTo(9999.6, 2);
      expect(bal.body.balances[0].free).toBeCloseTo(9899.6, 2);
      expect(bal.body.balances[0].used).toBeCloseTo(100, 2);

      // ---- positions endpoint ----
      const posRes = await request(appHttp).get("/api/broker/positions").set("Authorization", `Bearer ${token}`);
      expect(posRes.status).toBe(200);
      expect(posRes.body.positions).toHaveLength(1);
      expect(posRes.body.positions[0].side).toBe("LONG");
      expect(posRes.body.positions[0].qty).toBeCloseTo(10, 6);
      expect(posRes.body.account.cash).toBeCloseTo(9899.6, 2);

      // ---- full close @103 ----
      const close = await request(appHttp)
        .post("/api/broker/close")
        .set("Authorization", `Bearer ${token}`)
        .send({ positionId: posRes.body.positions[0].id });
      expect(close.status).toBe(200);
      expect(close.body.closed).toBe(true);
      expect(close.body.exitFillPrice).toBeCloseTo(103, 6);
      // net 30 - 0.4 - 0.412 = 29.188 → 29.19 ; cash 9899.6+100+30-0.412 = 10029.19
      expect(close.body.realizedPnlUSD).toBeCloseTo(29.19, 2);
      expect(close.body.cashAfter).toBeCloseTo(10029.19, 2);
      expect(close.body.position.status).toBe("CLOSED");

      const bal2 = await request(appHttp).get("/api/broker/balance").set("Authorization", `Bearer ${token}`);
      expect(bal2.body.account.cash).toBeCloseTo(10029.19, 2);
      expect(bal2.body.account.equity).toBeCloseTo(10029.19, 2);
      expect(bal2.body.account.realizedPnl).toBeCloseTo(29.19, 2);
      expect(bal2.body.account.openCount).toBe(0);

      // ---- resiliency: posisi sudah CLOSED → close kedua 400 POSITION_ALREADY_CLOSED ----
      const dup = await request(appHttp)
        .post("/api/broker/close")
        .set("Authorization", `Bearer ${token}`)
        .send({ positionId: posRes.body.positions[0].id });
      expect(dup.status).toBe(400);
      expect(dup.body.reason).toBe("POSITION_ALREADY_CLOSED");

      // ---- DB nyata: posisi 1 CLOSED@29.19, fills 2, orders 2, ledger valid ----
      const rows = asRows(db.prepare("SELECT status, realized_pnl_usd, close_price FROM positions WHERE symbol = ?").all("BTC/USDT"));
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe("CLOSED");
      expect(Number(rows[0].realized_pnl_usd)).toBeCloseTo(29.19, 2);
      expect(Number(rows[0].close_price)).toBeCloseTo(103, 6);
      const fillsCount = db.prepare("SELECT COUNT(*) as n FROM fills").get() as any;
      expect(Number(fillsCount.n)).toBe(2);
      const ordersCount = db.prepare("SELECT COUNT(*) as n FROM orders").get() as any;
      expect(Number(ordersCount.n)).toBe(2);

      // ---- ledger (hash chain) via HTTP ----
      const led = await request(appHttp).get("/api/ledger").set("Authorization", `Bearer ${token}`);
      expect(led.status).toBe(200);
      expect(led.body.entries.length).toBeGreaterThan(0);
      const verify = await request(appHttp).get("/api/ledger/verify").set("Authorization", `Bearer ${token}`);
      expect(verify.status).toBe(200);
      expect(verify.body.valid).toBe(true);
    });
  });

  it("SHORT via HTTP: open 5@100 lev10, close @95 → 24.61, cash 10024.61", async () => {
    feed.depths.push({ asks: [[100, 10]], bids: [[100, 10]] });
    feed.depths.push({ asks: [[95, 10]], bids: [[95, 10]] });

    await withDb(async () => {
      token = await login();

      const open = await request(appHttp)
        .post("/api/broker/order")
        .set("Authorization", `Bearer ${token}`)
        .send({
          symbol: "ETH/USDT",
          side: "sell",
          amount: 5,
          leverage: 10,
          stopLoss: 102,
          takeProfit: 95,
        });
      expect(open.status).toBe(200);
      expect(open.body.position.side).toBe("SHORT");

      const posRes = await request(appHttp).get("/api/broker/positions").set("Authorization", `Bearer ${token}`);
      const close = await request(appHttp)
        .post("/api/broker/close")
        .set("Authorization", `Bearer ${token}`)
        .send({ positionId: posRes.body.positions[0].id });
      expect(close.status).toBe(200);
      expect(close.body.realizedPnlUSD).toBeCloseTo(24.61, 2);
      expect(close.body.cashAfter).toBeCloseTo(10024.61, 2);

      const bal2 = await request(appHttp).get("/api/broker/balance").set("Authorization", `Bearer ${token}`);
      expect(bal2.body.account.realizedPnl).toBeCloseTo(24.61, 2);
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });
});

// ------------------------------------------------------------------
// Restart / rehydrate — TIDAK double-count PnL & TIDAK menghilangkan PnL.
// DILETAKKAN PALING AKHIR: describe ini (dan hanya ini) memakai
// `vi.resetModules()` → instance modul baru. Sesudahnya tidak ada kode yang
// menaut ke graph lama, jadi tidak ada koneksi DB yang "terlantar" oleh app.
// ------------------------------------------------------------------
describe("P0-00 — restart & rehydrate (tidak double-count PnL)", () => {
  it("restart setelah partial: rehydrate posisi sisa + PnL kumulatif, lalu full close total 25.19", async () => {
    feed.depths.push({ asks: [[100, 20]], bids: [[100, 20]] });
    feed.depths.push({ asks: [[100, 20]], bids: [[101, 5]] });
    feed.depths.push({ asks: [[100, 20]], bids: [[103, 10]] });

    let closeX: (() => void) | null = null;
    let closeY: (() => void) | null = null;
    try {
      // ---- fase A: open + partial, lalu "mati" (DB ditutup = server off) ----
      const sA = await initTestDb();
      closeX = sA.closeDb;

      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      });
      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      const partial = await closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 2);
      expect(partial.realizedPnlUSD).toBeCloseTo(1.84, 2);

      closeX();
      closeX = null;
      vi.resetModules();

      // ---- fase B: proses baru, rehydrate dari SQLite yang sama ----
      const storeB = await import("../../src/paperbook/store");
      storeB.initPaperBook();
      const { closeDb: closeDbB, getDb: getDbB } = await import("../../db");
      closeY = closeDbB;

      const acctB = storeB.getPaperAccount();
      const posB = storeB.state.positions.find((p) => p.id === pos.id);
      expect(posB).toBeDefined();
      expect(posB!.status).toBe("OPEN");
      expect(posB!.qty).toBeCloseTo(8, 6);
      expect(posB!.feesPaidUSD).toBeCloseTo(0.32, 4);
      expect(posB!.realizedPnlUSD).toBeCloseTo(1.84, 2);
      expect(acctB.cash).toBeCloseTo(9921.52, 2); // snapshot partial
      expect(acctB.marginLocked).toBeCloseTo(80, 4);
      expect(storeB.state.realizedPnl).toBeCloseTo(1.84, 2); // tidak hilang

      // full close SISA 8 @103 — PnL partial 1.84 TIDAK dihitung ulang
      vi.setSystemTime(Date.parse("2026-09-18T00:00:03.000Z"));
      const { closePaperPosition: closeB } = await import("../../paperBook");
      const res = await closeB(pos.id, "TAKE_PROFIT");
      expect(res.realizedPnlUSD).toBeCloseTo(23.35, 2);
      expect(res.cashAfter).toBeCloseTo(10025.19, 2);
      const acctB2 = storeB.getPaperAccount();
      expect(acctB2.cash).toBeCloseTo(10025.19, 2);
      expect(storeB.state.realizedPnl).toBeCloseTo(25.19, 2); // 1.84 + 23.35, bukan dobel

      // DB tetap satu posisi, 3 fill, 3 order — tidak ada duplikasi setelah restart
      const dbB = getDbB();
      const posRows = asRows(dbB.prepare("SELECT status, realized_pnl_usd FROM positions WHERE symbol = ?").all("BTC/USDT"));
      expect(posRows.length).toBe(1);
      expect(posRows[0].status).toBe("CLOSED");
      expect(Number(posRows[0].realized_pnl_usd)).toBeCloseTo(25.19, 2);
      const fills = dbB.prepare("SELECT COUNT(*) as n FROM fills WHERE symbol = ?").get("BTC/USDT") as any;
      expect(Number(fills.n)).toBe(3);
      const orders = dbB.prepare("SELECT COUNT(*) as n FROM orders WHERE symbol = ?").get("BTC/USDT") as any;
      expect(Number(orders.n)).toBe(3);
    } finally {
      if (closeX) closeX();
      if (closeY) closeY();
    }
  });

  it("restart setelah FLAT: 0 posisi, cash/realized utuh, fill & order tidak digandakan", async () => {
    feed.depths.push({ asks: [[100, 20]], bids: [[100, 20]] });
    feed.depths.push({ asks: [[100, 20]], bids: [[101, 5]] });
    feed.depths.push({ asks: [[100, 20]], bids: [[103, 10]] });

    let closeX: (() => void) | null = null;
    let closeY: (() => void) | null = null;
    try {
      const sA = await initTestDb();
      closeX = sA.closeDb;

      const { openPaperPosition, closePaperPosition } = await import("../../paperBook");

      vi.setSystemTime(Date.parse("2026-09-18T00:00:01.000Z"));
      const { position: pos } = await openPaperPosition({
        symbol: "BTC/USDT", side: "buy", qty: 10, leverage: 10, stopLoss: 98, takeProfit: 104,
      });
      vi.setSystemTime(Date.parse("2026-09-18T00:00:02.000Z"));
      await closePaperPosition(pos.id, "PARTIAL_TAKE_PROFIT", 2);
      vi.setSystemTime(Date.parse("2026-09-18T00:00:03.000Z"));
      await closePaperPosition(pos.id, "TAKE_PROFIT");

      closeX();
      closeX = null;
      vi.resetModules();

      const storeB = await import("../../src/paperbook/store");
      storeB.initPaperBook();
      const { closeDb: closeDbB, getDb: getDbB } = await import("../../db");
      closeY = closeDbB;

      const acct = storeB.getPaperAccount();
      expect(acct.openCount).toBe(0);
      expect(acct.cash).toBeCloseTo(10025.19, 2);
      expect(acct.equity).toBeCloseTo(10025.19, 2);
      expect(acct.realizedPnl).toBeCloseTo(25.19, 2);
      expect(storeB.state.positions.length).toBe(0);

      const dbB = getDbB();
      const fills = dbB.prepare("SELECT COUNT(*) as n FROM fills").get() as any;
      expect(Number(fills.n)).toBe(3);
      const orders = dbB.prepare("SELECT COUNT(*) as n FROM orders").get() as any;
      expect(Number(orders.n)).toBe(3);
      const posCount = dbB.prepare("SELECT COUNT(*) as n FROM positions").get() as any;
      expect(Number(posCount.n)).toBe(1);
    } finally {
      if (closeX) closeX();
      if (closeY) closeY();
    }
  });
});