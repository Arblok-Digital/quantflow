import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const feed = vi.hoisted(() => ({ delay: 0, calls: 0 }));
vi.mock("../../broker", () => ({
  getExchange: () => ({
    fetchOrderBook: async () => {
      feed.calls++;
      vi.setSystemTime(Date.now() + feed.delay);
      return { asks: [[100, 100]], bids: [[100, 100]] };
    },
    fetchTicker: async () => { throw new Error("ticker unavailable"); },
  }),
  ensureMarketsLoaded: async () => {},
}));
vi.mock("../../src/data/marketFetcher", () => ({
  fetchTickerPrice: async () => ({ ok: true, price: 100 }),
}));

import { closeDb } from "../../db";

let sandboxDir = "";
const originalCwd = process.cwd();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-17T07:29:58.000Z"));
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantflow-sqlite-"));
  process.chdir(sandboxDir);
  Object.assign(feed, { delay: 0, calls: 0 });
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.useRealTimers();
  closeDb();
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

it("deadline close persists to real SQLite with actual fill timestamps", async () => {
  const { initDb, getDb, getDbFilePath } = await import("../../db");
  initDb();
  // P1-A guard: DB singleton wajib terbentuk di sandbox cwd (resolve saat initDb, bukan module-scope).
  expect(getDbFilePath().startsWith(sandboxDir)).toBe(true);
  const { openPaperPosition } = await import("../../src/paperbook/fill");
  const { state, freshState, updatePaperPosition } = await import("../../src/paperbook/store");
  const { runBracketMonitorPass } = await import("../../src/paperbook/bracketMonitor");
  Object.assign(state, freshState());
  feed.delay = 2_000;
  const { position } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 1, leverage: 10, stopLoss: 98, takeProfit: 104 });
  feed.delay = 0;
  const filledAt = Date.parse("2026-09-17T07:30:00.000Z");
  expect(position.openedAt).toBe(filledAt);
  updatePaperPosition(position.id, { exitConfig: { maxHoldMs: 86_400_000 } });
  const deadline = filledAt + 86_400_000;
  vi.setSystemTime(deadline);
  await runBracketMonitorPass();
  expect(state.positions[0].status).toBe("CLOSED");
  const db = getDb();
  const row = db.prepare("SELECT status, closed_at, close_price, opened_at FROM positions WHERE id = ?").get(position.id) as any;
  expect(row.status).toBe("CLOSED");
  expect(row.closed_at).toBe(deadline);
  expect(row.opened_at).toBe(filledAt);
  await runBracketMonitorPass();
  const exitRows = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE symbol = ? AND side = 'sell'").get("BTC/USDT") as any;
  expect(Number(exitRows.n)).toBe(1);
});
