/**
 * SRV-WATCH-1 — frontend boot gate + offline honesty (regression permanen).
 * Backend DOWN = semua /api/* dan direct-Binance gagal (mock fetch reject).
 * Tanpa server/DB — murni unit (node env).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BOOT_SYNTHETIC_AFTER_ATTEMPTS,
  bootBackoffDelay,
  classifyBootFeed,
  fetchLiveMarketData,
  fetchWithTimeout,
  probeServerHealth,
} from "../src/data/marketData";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bootBackoffDelay: 2s → 4s → 8s … cap 30s", () => {
  it("urutan backoff eksak", () => {
    expect(bootBackoffDelay(0)).toBe(2000);
    expect(bootBackoffDelay(1)).toBe(4000);
    expect(bootBackoffDelay(2)).toBe(8000);
    expect(bootBackoffDelay(3)).toBe(16000);
    expect(bootBackoffDelay(4)).toBe(30000);
  });
  it("cap 30s untuk attempt besar & input negatif dibulatkan ke 2s", () => {
    expect(bootBackoffDelay(5)).toBe(30000);
    expect(bootBackoffDelay(10)).toBe(30000);
    expect(bootBackoffDelay(-1)).toBe(2000);
  });
});

describe("classifyBootFeed: probe hanya menghalangi synthetic fallback", () => {
  it("server reachable → APPLY meski gagal beruntun tinggi", () => {
    expect(
      classifyBootFeed({ serverReachable: true, feedLive: false, consecutiveFailures: 99 })
    ).toBe("APPLY");
  });
  it("feed live (direct-Binance) → APPLY meski server down", () => {
    expect(
      classifyBootFeed({ serverReachable: false, feedLive: true, consecutiveFailures: 1 })
    ).toBe("APPLY");
  });
  it(`offline murni → HOLD sampai ${BOOT_SYNTHETIC_AFTER_ATTEMPTS} gagal, lalu APPLY (berlabel)`, () => {
    expect(BOOT_SYNTHETIC_AFTER_ATTEMPTS).toBe(3);
    expect(
      classifyBootFeed({ serverReachable: false, feedLive: false, consecutiveFailures: 1 })
    ).toBe("HOLD_RETRY");
    expect(
      classifyBootFeed({ serverReachable: false, feedLive: false, consecutiveFailures: 2 })
    ).toBe("HOLD_RETRY");
    expect(
      classifyBootFeed({ serverReachable: false, feedLive: false, consecutiveFailures: 3 })
    ).toBe("APPLY");
    expect(
      classifyBootFeed({ serverReachable: false, feedLive: false, consecutiveFailures: 4 })
    ).toBe("APPLY");
  });
  it("maxAttempts kustom dihormati", () => {
    expect(
      classifyBootFeed({ serverReachable: false, feedLive: false, consecutiveFailures: 1, maxAttempts: 1 })
    ).toBe("APPLY");
  });
});

describe("probeServerHealth: boolean murni, tak pernah throw", () => {
  it("200 → true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as Response));
    await expect(probeServerHealth(50)).resolves.toBe(true);
  });
  it("ERR_CONNECTION_REFUSED (reject) → false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(probeServerHealth(50)).resolves.toBe(false);
  });
  it("5xx (ok=false) → false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 }) as Response));
    await expect(probeServerHealth(50)).resolves.toBe(false);
  });
});

describe("fetchWithTimeout: abort saat backend gantung", () => {
  it("menolak setelah timeout bila fetch tak kunjung resolve", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      }))
    );
    const p = fetchWithTimeout("/api/health", 3000);
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
  });
});

describe("fetchLiveMarketData offline: synthetic tetap berlabel (audit F-02)", () => {
  it("server down + Binance ISP-blocked → SIMULATED, isLive:false, candlesReal:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const feed = await fetchLiveMarketData("BTC/USDT", 64250);
    expect(feed.currentPrice).toBe(64250);
    expect(feed.status.source).toBe("SIMULATED");
    expect(feed.status.isLive).toBe(false);
    expect(feed.candlesReal).toBe(false);
    expect(feed.candles15m.length).toBeGreaterThan(0);
    // Hook mengandalkan flag ini untuk badge SYNTHETIC — jangan hapus.
  });
});
