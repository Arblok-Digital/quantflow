import { afterEach, beforeEach, expect, it, vi } from "vitest";

const feed = vi.hoisted(() => ({ delay: 2_000, fail: false, markFail: false, calls: 0 }));
vi.mock("../../broker", () => ({
  getExchange: () => ({
    fetchOrderBook: async () => {
      feed.calls++;
      if (feed.fail) throw new Error("exchange unavailable");
      vi.setSystemTime(Date.now() + feed.delay);
      return { asks: [[100, 100]], bids: [[100, 100]] };
    },
    fetchTicker: async () => { throw new Error("ticker unavailable"); },
  }),
  ensureMarketsLoaded: async () => {},
}));
vi.mock("../../src/data/marketFetcher", () => ({
  fetchTickerPrice: async () => {
    if (feed.markFail) throw new Error("mark feed unavailable");
    return { ok: !feed.fail, price: 100 };
  },
}));
vi.mock("../../db", () => ({
  initDb: vi.fn(), getDb: vi.fn(), loadAllOrdersDb: () => [], loadOpenPositionsDb: () => [],
  getLatestSnapshotDb: () => null, savePositionDb: vi.fn(), saveOrderDb: vi.fn(),
  saveFillDb: vi.fn(), saveSnapshotDb: vi.fn(), beginTx: vi.fn(), commitTx: vi.fn(),
  rollbackTx: vi.fn(), appendAudit: vi.fn(),
}));
import { openPaperPosition } from "../../src/paperbook/fill";
import { state, freshState, updatePaperPosition } from "../../src/paperbook/store";
import { runBracketMonitorPass } from "../../src/paperbook/bracketMonitor";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-17T07:29:58.000Z"));
  Object.assign(state, freshState());
  Object.assign(feed, { delay: 2_000, fail: false, markFail: false, calls: 0 });
});
afterEach(() => vi.useRealTimers());

it("deadline closes even when mark fetch fails but execution depth is available", async () => {
  const { position } = await openPaperPosition({ symbol: "ETH/USDT", side: "buy", qty: 1, leverage: 10, stopLoss: 98, takeProfit: 104 });
  updatePaperPosition(position.id, { exitConfig: { maxHoldMs: 86_400_000 } });
  feed.delay = 0;
  feed.markFail = true;
  vi.setSystemTime(position.openedAt + 86_400_000);
  await runBracketMonitorPass();
  expect(state.positions[0].status).toBe("CLOSED");
  expect(state.positions[0].exitReason).toBe("TIMEOUT");
});

it("actual market fill anchors 24h; monitor closes exactly once at deadline", async () => {
  const { position, order } = await openPaperPosition({ symbol: "BTC/USDT", side: "buy", qty: 1, leverage: 10, stopLoss: 98, takeProfit: 104 });
  const filledAt = Date.parse("2026-09-17T07:30:00.000Z");
  expect(position.openedAt).toBe(filledAt);
  expect(order.filledAt).toBe(filledAt);
  updatePaperPosition(position.id, { exitConfig: { maxHoldMs: 86_400_000 } });
  feed.delay = 0;
  const deadline = Date.parse("2026-09-18T07:30:00.000Z");
  vi.setSystemTime(deadline - 1);
  await runBracketMonitorPass();
  expect(state.positions[0].status).toBe("OPEN");
  expect(feed.calls).toBe(1);
  vi.setSystemTime(deadline);
  await runBracketMonitorPass();
  expect(state.positions[0].status).toBe("CLOSED");
  expect(state.positions[0].exitReason).toBe("TIMEOUT");
  expect(state.positions[0].closedAt).toBe(deadline);
  expect(feed.calls).toBe(2);
  await runBracketMonitorPass();
  expect(feed.calls).toBe(2);
  expect(state.events.filter(e => e.type === "POSITION_CLOSED")).toHaveLength(1);
});
