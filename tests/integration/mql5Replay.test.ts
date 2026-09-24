/**
 * Integration test — MQL5 CSV import ke replay (S3).
 * Sandbox: mkdtemp + env MQL5_DATA_DIR per test; DB & fetch Binance di-mock
 * (tidak menyentuh trading.db/.env). Binance default path tetap diverifikasi
 * lewat fetchHistoricalCandles mock (importActual → fungsi start/step asli).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplayCandle } from "../../src/replay/replayEngine";
import { resetReplay } from "../../src/replay/replayEngine";

const mocks = vi.hoisted(() => {
  const auditCalls: Array<{ kind: string; payload: any }> = [];
  const savedRuns: Array<{ run: any; resultJson: string }> = [];
  const mockFetchCandles = vi.fn(async (): Promise<{ candles: ReplayCandle[]; error?: string }> => ({
    candles: [
      { timestamp: 1_700_000_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
      { timestamp: 1_700_000_090_000, open: 100.5, high: 101.5, low: 100, close: 101, volume: 1100 },
    ],
  }));
  return { auditCalls, savedRuns, mockFetchCandles };
});

vi.mock("@/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("@/db", () => ({
  appendAudit: (kind: string, payload: any) => { mocks.auditCalls.push({ kind, payload }); },
  saveReplayRunDb: (run: any) => { mocks.savedRuns.push({ run, resultJson: run.resultJson }); },
  listReplayRunsDb: () => mocks.savedRuns.map((r) => r.run),
  getReplayRunDb: (id: string) => mocks.savedRuns.find((r) => r.run.id === id) ?? null,
}));
vi.mock("@/src/replay/replayEngine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/replay/replayEngine")>();
  return { ...actual, fetchHistoricalCandles: mocks.mockFetchCandles };
});

import { registerReplayRoutes } from "../../src/server/routes/replay";

const app = express();
app.use(express.json());
registerReplayRoutes(app);

let sandbox = "";
const prevMql5Env = process.env.MQL5_DATA_DIR;

function writeFixture(name: string, content: string): string {
  const p = join(sandbox, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

const CSV_15M_4 = [
  "TICKER,DTYYYYMMDD,TIME,OPEN,HIGH,LOW,CLOSE,VOL",
  "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
  "BTCUSD,2024.01.15,10:15,100.5,101.5,100,101,1300",
  "BTCUSD,2024.01.15,10:30,101,102,100.5,101.5,1400",
  "BTCUSD,2024.01.15,10:45,101.5,102,101,102,1500",
].join("\n");

beforeAll(() => {
  // env MQL5_DATA_DIR di-stub di beforeEach — pastikan bersih dulu.
  delete process.env.MQL5_DATA_DIR;
});

beforeEach(() => {
  mocks.auditCalls.length = 0;
  mocks.savedRuns.length = 0;
  mocks.mockFetchCandles.mockClear();
  resetReplay(); // sesi replay adalah singleton module-level
  sandbox = mkdtempSync(join(tmpdir(), "mql5-replay-"));
  process.env.MQL5_DATA_DIR = sandbox;
});

afterEach(() => {
  if (prevMql5Env === undefined) delete process.env.MQL5_DATA_DIR;
  else process.env.MQL5_DATA_DIR = prevMql5Env;
  rmSync(sandbox, { recursive: true, force: true });
});

afterAll(() => {
  if (prevMql5Env === undefined) delete process.env.MQL5_DATA_DIR;
  else process.env.MQL5_DATA_DIR = prevMql5Env;
});

describe("MQL5 replay import (S3)", () => {
  it("start with source=mql5 parses file, steps, exports and audits feed=mql5", async () => {
    writeFixture("BTCUSD15.csv", CSV_15M_4);
    const start = await request(app).post("/api/paper/replay/start").send({
      source: "mql5",
      symbol: "BTC/USDT",
      timeframe: "15m",
      mql5File: "BTCUSD15.csv",
      utcOffsetMinutes: 0,
      initialCash: 10000,
    });
    expect(start.status).toBe(200);
    expect(start.body.success).toBe(true);
    expect(start.body.session.dataSource).toBe("mql5");
    expect(start.body.session.candles.length).toBe(4);
    expect(start.body.meta.spacingMs).toBe(900_000);
    expect(start.body.meta.spacingOk).toBe(true);

    const step = await request(app).post("/api/paper/replay/step").send({});
    expect(step.status).toBe(200);
    expect(step.body.session.currentIndex).toBe(0);

    const closeRes = await request(app).post("/api/paper/replay/order").send({
      symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10,
      stopLoss: 90, takeProfit: 120,
    });
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.order.status).toBe("FILLED");
    const close = await request(app).post("/api/paper/replay/close").send({
      positionId: closeRes.body.order.positionId,
    });
    expect(close.status).toBe(200);

    const exp = await request(app).post("/api/paper/replay/export").send({});
    expect(exp.status).toBe(200);
    expect(exp.body.success).toBe(true);
    const audit = mocks.auditCalls.find((a) => a.kind === "replay_export");
    expect(audit).toBeTruthy();
    expect(audit!.payload.feed).toBe("mql5");
    expect(audit!.payload.source).toBe("REAL");

    // CSV rebuild dari run tersimpan menyertakan data_source
    const csv = await request(app).get(`/api/paper/replay/runs/${exp.body.runId}?format=csv`);
    expect(csv.status).toBe(200);
    const csvText = csv.text;
    expect(csvText.split("\n")[0]).toContain("data_source");
    expect(csvText).toContain(",mql5");
  });

  it("binance default path masih jalan (fetchHistoricalCandles mock)", async () => {
    const res = await request(app).post("/api/paper/replay/start").send({
      symbol: "BTC/USDT", timeframe: "15m",
      startMs: 1_700_000_000_000, endMs: 1_700_100_000_000, initialCash: 10000,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.session.dataSource).toBe("binance");
    expect(mocks.mockFetchCandles).toHaveBeenCalledTimes(1);
  });

  it("missing file → 404 MQL5_FILE_NOT_FOUND", async () => {
    const res = await request(app).post("/api/paper/replay/start").send({
      source: "mql5", timeframe: "15m", mql5File: "nope.csv",
    });
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe("MQL5_FILE_NOT_FOUND");
  });

  it("traversal / invalid filename → 400 MQL5_INVALID_FILE", async () => {
    const bad = ["..\\secrets.csv", "C:/windows/evil.csv", "a/b.csv", "x.txt", ""];
    for (const name of bad) {
      const res = await request(app).post("/api/paper/replay/start").send({
        source: "mql5", timeframe: "15m", mql5File: name,
      });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("MQL5_INVALID_FILE");
    }
    const verify = await request(app).get("/api/paper/replay/mql5/verify").query({ mql5File: "../evil.csv", timeframe: "15m" });
    expect(verify.status).toBe(400);
    expect(verify.body.reason).toBe("MQL5_INVALID_FILE");
  });

  it("timeframe mismatch → 400 MQL5_TIMEFRAME_MISMATCH", async () => {
    writeFixture("BTC5m.csv", [
      "TICKER,DTYYYYMMDD,TIME,OPEN,HIGH,LOW,CLOSE,VOL",
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:05,100.5,101.5,100,101,1300",
      "BTCUSD,2024.01.15,10:10,101,102,100.5,101.5,1400",
      "BTCUSD,2024.01.15,10:15,101.5,102,101,102,1500",
      "BTCUSD,2024.01.15,10:20,102,103,101.5,102.5,1600",
    ].join("\n"));
    const res = await request(app).post("/api/paper/replay/start").send({
      source: "mql5", timeframe: "15m", mql5File: "BTC5m.csv",
    });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("MQL5_TIMEFRAME_MISMATCH");
  });

  it("mql5/verify returns summary without mutating the active session", async () => {
    writeFixture("ETHUSD15.csv", CSV_15M_4);
    const before = await request(app).get("/api/paper/replay/status");
    const verify = await request(app).get("/api/paper/replay/mql5/verify").query({
      mql5File: "ETHUSD15.csv", timeframe: "15m", utcOffsetMinutes: 0,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.success).toBe(true);
    expect(verify.body.summary.candles).toBe(4);
    expect(verify.body.summary.spacingMs).toBe(900_000);
    expect(verify.body.summary.tfMismatch).toBe(false);
    expect(verify.body.summary.symbol).toBe("ETHUSD/USDT");

    // verify hanya membaca — sesi (bila ada) tidak berubah.
    const after = await request(app).get("/api/paper/replay/status");
    expect(after.body.active).toBe(before.body.active);
    expect(after.body.session?.id).toBe(before.body.session?.id ?? null);
    expect(after.body.session?.currentIndex).toBe(before.body.session?.currentIndex ?? -1);
    expect(after.body.session?.dataSource).toBe(before.body.session?.dataSource ?? null);
  });

  it("verify bad rows → warning, summary tetap 200 dengan data valid", async () => {
    writeFixture("WARN.csv", [
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
      "BTCUSD,GARBAGE,10:00,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:15,100.5,101.5,100,101,1300",
    ].join("\n"));
    const verify = await request(app).get("/api/paper/replay/mql5/verify").query({ mql5File: "WARN.csv", timeframe: "15m" });
    expect(verify.status).toBe(200);
    expect(verify.body.success).toBe(true);
    expect(verify.body.summary.candles).toBe(2);
    expect(verify.body.summary.warnings.length).toBeGreaterThan(0);
  });
});