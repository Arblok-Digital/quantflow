// =====================================================================
// Phase 7.2 — Integration test: broker (paper) lifecycle + guardrails + auth
//
// Milik CC (sisi integration). Tidak menyentuh src/logic/* (unit OC).
// Mock yang dipakai:
//   - ./broker      → deterministik (tanpa network ccxt), mode paper
//   - ./guardrails  → kontrol kill-switch & daily loss via state mutable (hoisted)
//   - ./db          → aksi no-op (tidak menyentuh trading.db / .audit-signing-key)
// App diimpor dari server.ts (sudah diexport untuk supertest, line 1601).
// =====================================================================

import { describe, test, expect, beforeAll, vi, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";

// --- State mutable (hoisted) agar test bisa menggerakkan guardrails ---
const guardState = vi.hoisted(() => ({
  killSwitch: false as boolean,
  lossPercent: 0 as number, // > maxDailyLossPercent → ditolak; 0 = tidak melewati ambang
}));

vi.mock("../../broker", () => {
  const exchangeStub = {
    loadMarkets: async () => {},
    fetchOrderBook: async () => ({
      asks: [
        [100.0, 5],
        [100.1, 8],
      ],
      bids: [
        [99.9, 5],
        [99.8, 8],
      ],
    }),
    fetchTicker: async () => ({ bid: 99.9, ask: 100.0 }),
    fetchPositions: async () => [],
    fetchBalance: async () => ({ total: { USDT: 10000 } }),
  };
  return {
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
    fetchCcxtTicker: async (_s: string) => ({ symbol: _s, bid: 99.9, ask: 100.0 }),
    fetchCcxtOrderBook: async (_s: string) => ({
      symbol: _s,
      bids: [[99.9, 5]],
      asks: [[100.0, 5]],
    }),
    fetchCcxtOHLCV: async (_s: string) => ({ symbol: _s, candles: [] }),
    fetchBrokerBalance: async () => ({ total: { USDT: 10000 } }),
    placeBrokerOrder: async (b: any) => ({ success: true, ...b }),
    saveBrokerCredentials: async () => ({ success: true }),
    clearBrokerCredentials: async () => {},
    testBrokerConnection: async () => ({ success: true }),
    getVaultCredentialsStatus: () => ({
      configured: false,
      source: "none",
      testnet: false,
    }),
  };
});

// Mock guardrails: guardState (hoisted) menggerakkan kill-switch & daily loss.
// GuardrailRejectedError tetap kelas nyata sesuai kontrak, dipakai server.ts.
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

  const reasonsFor = (): string[] => {
    const reasons: string[] = [];
    if (guardState.killSwitch) reasons.push("KILL_SWITCH_ACTIVE");
    if (guardState.lossPercent >= 10) reasons.push("MAX_DAILY_LOSS_EXCEEDED");
    return reasons;
  };

  return {
    GuardrailRejectedError,
    initGuardrails: () => {},
    evaluateGuardrails: async () => {
      const reasons = reasonsFor();
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
        },
      };
    },
    setKillSwitch: (active: boolean) => {
      guardState.killSwitch = Boolean(active);
      return { killSwitch: guardState.killSwitch };
    },
    recordOrderPlaced: () => {},
    getTodayRealized: () => ({
      realizedPnlUSD: -Math.abs(guardState.lossPercent * 100),
      lossPercent: guardState.lossPercent,
    }),
    getGuardrailsSnapshotSync: () => ({
      config: { killSwitchDefault: false, maxOpenPositions: 5, maxDailyLossPercent: 10, minOrderIntervalMs: 0 },
      state: {
        killSwitch: guardState.killSwitch,
        dailyLossPercent: guardState.lossPercent,
        openCount: 0,
        lastOrderAt: null,
        cooldownRemainingMs: 0,
        armedForLive: false,
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
      },
      today: { realizedPnlUSD: 0, lossPercent: guardState.lossPercent },
    }),
  };
});

// Mock db: aksi no-op — jangan pernah buka/menulis trading.db di test.
vi.mock("../../db", () => ({
  initDb: () => ({ exec: () => {} }),
  getDb: () => {
    throw new Error("DB mock: initDb tidak dipanggil — tidak menyentuh trading.db");
  },
  beginTx: () => {},
  commitTx: () => {},
  rollbackTx: () => {},
  savePositionDb: () => {},
  saveOrderDb: () => {},
  saveFillDb: () => {},
  saveSnapshotDb: () => {},
  loadOpenPositionsDb: () => [],
  loadAllOrdersDb: () => [],
  getLatestSnapshotDb: () => null,
  getDbFilePath: () => "trading.db",
  appendAudit: () => ({ seq: 1, hash: "mock", sig: "mock", prevHash: "GENESIS" }),
  getLedgerEntries: () => ({ entries: [], nextCursor: null }),
  verifyLedger: () => ({ total: 0, valid: true, tampered: [], issues: [] }),
  getLedgerStats: () => ({ total: 0, lastSeq: 0, integrity: "valid" }),
  saveAgentDecisionDb: () => {},
  warnIfDefaultAuditSecret: () => {},
}));

let app: Express;

beforeAll(async () => {
  // Env deterministik: paper mode, auth passcode dikontrol, tanpa Vite dev server.
  process.env.TRADING_MODE = "paper";
  process.env.AUTH_PASSCODE = "test-passcode";
  process.env.VITE_ENABLED = "false";
  process.env.NODE_ENV = "test";
  process.env.GUARD_MAX_DAILY_LOSS_PERCENT = "10";
  process.env.GUARD_MIN_ORDER_INTERVAL_MS = "0";
  guardState.killSwitch = false;
  guardState.lossPercent = 0;

  vi.resetModules();
  const serverMod = await import("../../server.ts");
  app = serverMod.app;
});

afterAll(() => {
  vi.restoreAllMocks();
});

// Helper: login → token (passcode dikenal dari env)
async function getToken(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ passcode: "test-passcode" });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.token as string;
}

describe("7.2 auth gate", () => {
  test("GET /api/broker/status tanpa Authorization → 401", async () => {
    const res = await request(app).get("/api/broker/status");
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  test("login passcode benar → token → GET status terautentikasi 200 paper", async () => {
    const token = await getToken();
    const res = await request(app)
      .get("/api/broker/status")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.mode).toBe("paper");
  });
});

describe("7.2 paper order lifecycle", () => {
  test("POST /order(paper) → GET /order-status/:id → POST /close", async () => {
    const token = await getToken();

    // Open: BTC/USDT buy, SL=99.5 TP=101 (entry ~100 → LONG valid, R:R 3)
    // Catatan F1/P0: bracket lama SL=50/TP=150 = stop 50% & R:R 1.0, sekarang
    // ditolak risk gate matematis (RISK_MIN_RR 1.5) — bracket diperbaiki agar
    // test menguji lifecycle, bukan melanggar policy.
    const open = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        stopLoss: 99.5,
        takeProfit: 101,
      });
    expect(open.status).toBe(200);
    expect(open.body.success).toBe(true);
    expect(open.body.mode).toBe("paper");
    expect(open.body.order.id).toBeTruthy();
    expect(open.body.position.id).toBeTruthy();
    expect(open.body.order.status).toBe("FILLED");

    const orderId = open.body.order.id;
    const positionId = open.body.position.id;

    // Order status: receipt tersimpan & cocok
    const status = await request(app)
      .get(`/api/broker/order-status/${orderId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body.success).toBe(true);
    expect(status.body.order.id).toBe(orderId);
    expect(status.body.order.status).toBe("FILLED");

    // Close
    const close = await request(app)
      .post("/api/broker/close")
      .set("Authorization", `Bearer ${token}`)
      .send({ positionId });
    expect(close.status).toBe(200);
    expect(close.body.success).toBe(true);
    expect(close.body.closed).toBe(true);
    expect(close.body.position.id).toBe(positionId);
    expect(close.body.realizedPnlUSD).toBeTypeOf("number");
  });
});

describe("7.2 guardrail reject", () => {
  test("kill-switch ON → POST /order ditolak 403 REJECTED KILL_SWITCH_ACTIVE", async () => {
    const token = await getToken();
    guardState.killSwitch = true;

    const res = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        stopLoss: 50,
        takeProfit: 150,
      });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.reason).toBe("KILL_SWITCH_ACTIVE");

    guardState.killSwitch = false;
  });

  test("daily loss ambang tercapai → POST /order ditolak 403 MAX_DAILY_LOSS_EXCEEDED", async () => {
    const token = await getToken();
    guardState.lossPercent = 15; // > max 10

    const res = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        stopLoss: 50,
        takeProfit: 150,
      });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.reason).toBe("MAX_DAILY_LOSS_EXCEEDED");

    guardState.lossPercent = 0;
  });
});

describe("7.3 spot semantics (satu panel, mode-aware)", () => {
  test("SPOT buy → FILLED leverage 1x, margin = notional penuh, liq 0, marketType SPOT", async () => {
    const token = await getToken();

    const open = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        leverage: 10, // sengaja 10x → SPOT harus paksa jadi 1x
        stopLoss: 99.5,
        takeProfit: 101,
        meta: { marketType: "SPOT" },
      });
    expect(open.status).toBe(200);
    expect(open.body.success).toBe(true);
    expect(open.body.position.side).toBe("LONG");
    expect(open.body.position.leverage).toBe(1);
    expect(open.body.position.marketType).toBe("SPOT");
    // margin = notional penuh (bukan notional/10)
    expect(open.body.position.marginUSD).toBeCloseTo(open.body.position.notionalUSD, 2);
    expect(open.body.position.liquidationPrice).toBe(0);

    // cleanup: close agar tidak mengotori test lain
    const close = await request(app)
      .post("/api/broker/close")
      .set("Authorization", `Bearer ${token}`)
      .send({ positionId: open.body.position.id });
    expect(close.status).toBe(200);
  });

  test("SPOT sell (SHORT) → REJECTED SPOT_SHORT_NOT_ALLOWED", async () => {
    const token = await getToken();

    const res = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "sell",
        amount: 0.001,
        stopLoss: 150,
        takeProfit: 50,
        meta: { marketType: "SPOT" },
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.reason).toBe("SPOT_SHORT_NOT_ALLOWED");
  });

  test("FUTURES sell regresi → tetap bisa SHORT dengan leverage", async () => {
    const token = await getToken();

    const open = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "sell",
        amount: 0.001,
        leverage: 10,
        stopLoss: 100.5,
        takeProfit: 98.5,
        meta: { marketType: "FUTURES" },
      });
    expect(open.status).toBe(200);
    expect(open.body.success).toBe(true);
    expect(open.body.position.side).toBe("SHORT");
    expect(open.body.position.leverage).toBe(10);
    expect(open.body.position.liquidationPrice).toBeGreaterThan(0);

    const close = await request(app)
      .post("/api/broker/close")
      .set("Authorization", `Bearer ${token}`)
      .send({ positionId: open.body.position.id });
    expect(close.status).toBe(200);
  });
});

// =====================================================================
// F1/P0 — audit remediation regression tests
//   * risk gate matematis di choke point eksekusi (jalur manual)
//   * anti race-condition (burst order konkuren)
//   * idempotency clientOrderId
// Semua lewat HTTP endpoint nyata (server.ts) supaya jalur yang diuji identik
// dengan yang dipakai UI.
// =====================================================================
describe("F1/P0 risk gate matematis di /api/broker/order", () => {
  // fill mock: bestAsk 100 → entry BUY ≈ 100.
  test("R:R di bawah minimum (TP terlalu dekat) → 400 RISK_GATE_REJECTED", async () => {
    const token = await getToken();
    const res = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        stopLoss: 99.5, // 0.5% (lolos lantai 0.35%)
        takeProfit: 100.4, // 0.4% → R:R 0.8 < 1.5
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.reason).toBe("RISK_GATE_REJECTED");
    expect(String(res.body.message)).toContain("RISK_RR_BELOW_MIN");
  });

  test("SL di dalam noise (0.08%) → 400 RISK_GATE_REJECTED (RISK_STOP_TOO_TIGHT)", async () => {
    const token = await getToken();
    const res = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        stopLoss: 99.92, // 0.08% — kasus nyata di trading.db
        takeProfit: 101,
      });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("RISK_GATE_REJECTED");
    expect(String(res.body.message)).toContain("RISK_STOP_TOO_TIGHT");
  });

  test("bracket sehat + notional wajar → tetap FILLED (gate tidak memblokir alur normal)", async () => {
    const token = await getToken();
    const open = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send({
        symbol: "BTC/USDT",
        side: "buy",
        amount: 0.001,
        leverage: 10,
        stopLoss: 99.5,
        takeProfit: 101,
      });
    expect(open.status).toBe(200);
    expect(open.body.success).toBe(true);
    expect(open.body.order.status).toBe("FILLED");

    const close = await request(app)
      .post("/api/broker/close")
      .set("Authorization", `Bearer ${token}`)
      .send({ positionId: open.body.position.id });
    expect(close.status).toBe(200);
  });
});

describe("F1/P0 anti race-condition (burst order konkuren)", () => {
  test("5 request konkuren simbol+arah sama → HANYA 1 posisi terbuka", async () => {
    const token = await getToken();
    const body = {
      symbol: "ETH/USDT",
      side: "buy",
      amount: 0.001,
      leverage: 10,
      stopLoss: 99.5,
      takeProfit: 101,
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/broker/order").set("Authorization", `Bearer ${token}`).send(body)
      )
    );

    const filled = results.filter((r) => r.status === 200 && r.body?.success === true);
    const rejected = results.filter((r) => r.body?.status === "REJECTED");
    expect(filled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    // Sisanya ditolak karena posisi sudah ada — bukan karena error tak terduga.
    for (const r of rejected) {
      expect(r.body.reason).toBe("DUPLICATE_POSITION_DIRECTION");
    }

    // Request ke-6 (sekuensial) masih ditolak → posisi tunggal itu benar-benar ada.
    const after = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(after.status).toBe(400);
    expect(after.body.reason).toBe("DUPLICATE_POSITION_DIRECTION");
  });
});

describe("F1/P0 idempotency clientOrderId", () => {
  test("request ulang dengan clientOrderId sama → receipt sama, tidak dobel posisi", async () => {
    const token = await getToken();
    const body = {
      symbol: "SOL/USDT",
      side: "buy",
      amount: 0.001,
      leverage: 10,
      stopLoss: 99.5,
      takeProfit: 101,
      meta: { clientOrderId: "cli-test-sol-1" },
    };

    const first = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(first.status).toBe(200);
    const firstOrderId = first.body.order.id;

    const replay = await request(app)
      .post("/api/broker/order")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.success).toBe(true);
    expect(replay.body.order.id).toBe(firstOrderId);
    expect(replay.body.position.id).toBe(first.body.position.id);
  });
});
