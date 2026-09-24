/**
 * ADV-01 acceptance — deadline-close GAGAL: deadlineAttempt FAILED dipersist,
 * bertahan RESTART (rehydrate dari SQLite), lalu retry pass berikutnya menutup
 * posisi saat deadline terlewat. Log kegagalan terlihat via /api/broker/events
 * (ERROR source=deadline-close) & EXIT_ENGINE_ACTION saat berhasil.
 *
 * Sandbox mkdtemp + fake timers. closePaperPosition di-mock (sisanya fill asli).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const feed = vi.hoisted(() => ({ delay: 0, calls: 0 }));
// closePaperPosition dikontrol: gagal 1x (injected) lalu delegasi ke implementasi asli.
const fillCtrl = vi.hoisted(() => ({
  failNext: true,
  actualClose: null as unknown,
  spy: null as unknown,
}));

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
vi.mock("../../src/paperbook/fill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/paperbook/fill")>();
  fillCtrl.actualClose = actual.closePaperPosition;
  const spy = vi.fn(async (positionId: string, reason: string) => {
    if (fillCtrl.failNext) {
      fillCtrl.failNext = false;
      throw new Error("injected deadline close failure");
    }
    return (fillCtrl.actualClose as (id: string, r: string) => Promise<unknown>)(positionId, reason);
  });
  fillCtrl.spy = spy;
  return { ...actual, closePaperPosition: spy };
});

let sandboxDir = "";
const originalCwd = process.cwd();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-09-17T07:29:58.000Z"));
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantflow-sqlite-fail-"));
  process.chdir(sandboxDir);
  Object.assign(feed, { delay: 0, calls: 0 });
  fillCtrl.failNext = true;
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.useRealTimers();
  try {
    const { closeDb } = await import("../../db");
    closeDb();
  } catch {
    /* db mungkin belum dibuka */
  }
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

it("FAILED deadline close dipersist, rehydrate setelah restart, retry menutup posisi", async () => {
  const { initDb, getDb, getDbFilePath, closeDb } = await import("../../db");
  initDb();
  expect(getDbFilePath().startsWith(sandboxDir)).toBe(true);

  const { openPaperPosition } = await import("../../src/paperbook/fill");
  const store = await import("../../src/paperbook/store");
  const { runBracketMonitorPass } = await import("../../src/paperbook/bracketMonitor");
  Object.assign(store.state, store.freshState());

  feed.delay = 2_000;
  const { position } = await openPaperPosition({
    symbol: "BTC/USDT", side: "buy", qty: 1, leverage: 10, stopLoss: 98, takeProfit: 104,
  });
  feed.delay = 0;
  const filledAt = Date.parse("2026-09-17T07:30:00.000Z");
  expect(position.openedAt).toBe(filledAt);

  store.updatePaperPosition(position.id, { exitConfig: { maxHoldMs: 86_400_000 } });
  const deadline = filledAt + 86_400_000;
  vi.setSystemTime(deadline);

  // Pass 1 → close GAGAL (injected) → posisi tetap OPEN + deadlineAttempt FAILED.
  await runBracketMonitorPass();
  const pos = store.state.positions[0];
  expect(pos.status).toBe("OPEN");
  expect(pos.exitPlan?.state?.deadlineAttempt?.status).toBe("FAILED");
  expect(pos.exitPlan?.state?.deadlineAttempt?.message).toContain("injected");
  expect(pos.exitPlan?.state?.deadlineAttempt?.attemptedAt).toBe(deadline);

  const events = store.getPaperEvents(0);
  const errEv = events.find((e) => e.type === "ERROR" && (e.payload as any).source === "deadline-close");
  expect(errEv).toBeTruthy();
  expect((errEv!.payload as any).message).toContain("injected");
  // Tanpa EXIT_ENGINE_ACTION DEADLINE_RESULT saat gagal.
  expect(events.some((e) => e.type === "EXIT_ENGINE_ACTION" && (e.payload as any).action === "DEADLINE_RESULT")).toBe(false);

  // Persist di SQLite nyata: exit_config membawa deadlineAttempt FAILED.
  const row = getDb().prepare("SELECT exit_config FROM positions WHERE id = ?").get(pos.id) as any;
  expect(String(row.exit_config)).toContain('"deadlineAttempt"');
  expect(String(row.exit_config)).toContain('"FAILED"');
  expect(String(row.exit_config)).toContain('"maxHoldMs"');

  // === RESTART (rehydrate ulang dari SQLite — reset guard init di store) ===
  // fill tetap registri yang sama (spy & delegasi konsisten); state di-bangun
  // ulang penuh oleh initPaperBook dari DB yang sama.
  fillCtrl.failNext = false; // retry boleh sukses
  const dbCheck = await import("../../db");
  expect(dbCheck.getDbFilePath().startsWith(sandboxDir)).toBe(true);
  store.resetPaperBookInitializedForTests();
  store.initPaperBook();

  // Rehydrate membawa POLICY (maxHoldMs) + deadlineAttempt FAILED.
  const revived = store.state.positions.find((p: { id: string }) => p.id === pos.id);
  expect(revived).toBeTruthy();
  expect(revived.exitPlan?.config?.maxHoldMs).toBe(86_400_000);
  expect(revived.exitPlan?.state?.deadlineAttempt?.status).toBe("FAILED");
  expect(revived.exitPlan?.state?.deadlineAttempt?.message).toContain("injected");
  // P1-03c: equity startup BUKAN data live — setelah restart mark bukan "segar";
  // lastMark hanyalah entryPrice & lastMarkUpdatedAt = 0 (basi) sampai ada refresh.
  expect(revived.lastMark).toBe(revived.entryPrice);
  expect(revived.lastMarkUpdatedAt).toBe(0);

  // Retry pass berikutnya (deadline sudah terlewat) → close sukses via real fill.
  vi.setSystemTime(deadline + 5_000);
  await runBracketMonitorPass();
  const after = store.state.positions.find((p: { id: string }) => p.id === pos.id);
  expect(after.status).toBe("CLOSED");
  expect(after.exitPlan?.state?.deadlineAttempt?.status).toBe("CLOSED");
  // Event sukses terlihat (EXIT_ENGINE_ACTION DEADLINE_RESULT di ring baru).
  const ev2 = store.getPaperEvents(0);
  expect(ev2.some((e: any) => e.type === "EXIT_ENGINE_ACTION" && e.payload?.action === "DEADLINE_RESULT")).toBe(true);
});