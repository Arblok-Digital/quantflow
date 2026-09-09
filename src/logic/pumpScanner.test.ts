import { describe, it, expect, afterEach, vi } from "vitest";
import { computePumpScore, computeVolSurge, scanGateMicrocapPumps, PumpScanResult } from "./pumpScanner";

describe("computePumpScore — deterministik & pure", () => {
  it("ticker yang sama → output identik (pure/deterministic)", () => {
    const a = computePumpScore({
      currency_pair: "FOO_USDT",
      last: "0.5",
      lowest_ask: "0.501",
      highest_bid: "0.499",
      change_percentage: "12.0",
    });
    const b = computePumpScore({
      currency_pair: "FOO_USDT",
      last: "0.5",
      lowest_ask: "0.501",
      highest_bid: "0.499",
      change_percentage: "12.0",
    });
    expect(a).toEqual(b);
  });

  it("momentum tinggi (>7 power) → HOT; power = min(10, momentum*1.5 + spread)", () => {
    const c = computePumpScore({ last: "1", lowest_ask: "1.005", highest_bid: "0.999", change_percentage: "30" });
    expect(c.heat).toBe("HOT");
    expect(c.power).toBe(10); // 30*1.5 + 1 = 46 → cap 10
    expect(c.score).toBe(1e10);
    expect(c.momentum).toBe(30);
    expect(c.spreadNarrow).toBe(1);
  });

  it("momentum sedang (power 5-6) → WATCH", () => {
    const w = computePumpScore({ last: "1", lowest_ask: "1.01", highest_bid: "0.99", change_percentage: "4.0" });
    // spread (1.01-0.99)/1 = 2% → narrow 0; 4*1.5 = 6 → WATCH
    expect(w.heat).toBe("WATCH");
    expect(w.power).toBe(6);
  });

  it("momentum rendah / negatif → COLD", () => {
    const c = computePumpScore({ last: "1", lowest_ask: "1.02", highest_bid: "0.98", change_percentage: "1.0" });
    // 1*1.5 + 0 = 1.5 → COLD
    expect(c.heat).toBe("COLD");
    const n = computePumpScore({ last: "1", lowest_ask: "1.02", highest_bid: "0.98", change_percentage: "-10" });
    expect(n.power).toBe(0); // -15 + 0 < 0 → clamp 0
    expect(n.score).toBe(1);
  });

  it("spreadNarrow: <1% = 1, <2% = 0.5, >=2% = 0, tanpa bid/ask = 0", () => {
    expect(computePumpScore({ last: "1", lowest_ask: "1.004", highest_bid: "0.999" }).spreadNarrow).toBe(1);
    expect(computePumpScore({ last: "1", lowest_ask: "1.009", highest_bid: "0.99" }).spreadNarrow).toBe(0.5);
    expect(computePumpScore({ last: "1", lowest_ask: "1.02", highest_bid: "0.98" }).spreadNarrow).toBe(0);
    expect(computePumpScore({ last: "1" }).spreadNarrow).toBe(0);
    expect(computePumpScore({ last: "1" }).spreadPct).toBeNull();
  });

  it("volSurge kontribusi *2, hanya bila > 1 (data intraday valid)", () => {
    const base = { last: "1", lowest_ask: "1.005", highest_bid: "0.999", change_percentage: "2.0" };
    const tanpa = computePumpScore(base);
    const dengan = computePumpScore(base, { volSurge: 5 });
    // tanpa: 2*1.5 + 1 = 4 ; dengan: 5*2 + 3 + 1 = 14 → 10
    expect(dengan.heat).toBe("HOT");
    expect(dengan.power).toBeGreaterThan(tanpa.power);
    // volSurge <= 1 diperlakukan 0 (tidak menambah skor trend volume turun)
    expect(computePumpScore(base, { volSurge: 0.4 }).power).toBe(tanpa.power);
  });

  it("ageBonus selalu 0 kalau tidak di-supply (fail-closed listing age)", () => {
    const c = computePumpScore({ last: "1", lowest_ask: "1.005", highest_bid: "0.999", change_percentage: "2.0" });
    expect(c.ageBonus).toBe(0);
  });
});

describe("computeVolSurge — candle 15m (oldest-first)", () => {
  it("< 6 candle → 0 (fail-closed, data tak cukup)", () => {
    expect(computeVolSurge([100, 200])).toBe(0);
    expect(computeVolSurge([])).toBe(0);
  });

  it("recent x2 vs avg before → surge ~2x", () => {
    const vols = [10, 10, 10, 10, 10, 10, 20, 20];
    const s = computeVolSurge(vols);
    expect(s).toBeGreaterThan(1.9);
    expect(s).toBeLessThanOrEqual(20);
  });

  it("volume flat → surge ~1 (tidak HOT dari vol)", () => {
    const s = computeVolSurge([10, 10, 10, 10, 10, 10, 10, 10]);
    expect(s).toBeGreaterThan(0.9);
    expect(s).toBeLessThan(1.1);
  });

  it("recent volume 0 → 0", () => {
    expect(computeVolSurge([10, 10, 10, 10, 10, 10, 0, 0])).toBe(0);
  });
});

describe("scanGateMicrocapPumps — fail-closed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetch tickers error → [] (jangan fabricate)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const res = await scanGateMicrocapPumps();
    expect(res).toEqual([]);
  });

  it("fetch tickers HTTP error → []", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 })));
    const res = await scanGateMicrocapPumps();
    expect(res).toEqual([]);
  });

  it("response bukan array → []", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
    const res = await scanGateMicrocapPumps();
    expect(res).toEqual([]);
  });

  it("array kosong → []", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })));
    const res = await scanGateMicrocapPumps();
    expect(res).toEqual([]);
  });

  it("filter + sort + score + reasons pada kandidat valid", async () => {
    const j = (x: unknown) => ({ ok: true, status: 200, json: async () => x });
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).includes("/spot/tickers")) {
        return j([
          // microcap pump: quote USDT, valid, marketCap last*baseVol < 5M, quoteVolume > 10k
          { currency_pair: "MOON_USDT", last: "0.5", lowest_ask: "0.502", highest_bid: "0.499", change_percentage: "28.0", base_volume: "200000", quote_volume: "100000" },
          // microcap tapi volume rendah → dibuang (quoteVolume <= 10k)
          { currency_pair: "DEAD_USDT", last: "0.5", lowest_ask: "0.502", highest_bid: "0.499", change_percentage: "30.0", base_volume: "1000", quote_volume: "500" },
          // quote bukan USDT → dibuang
          { currency_pair: "FOO_BTC", last: "0.5", lowest_ask: "0.502", highest_bid: "0.499", change_percentage: "30.0", base_volume: "300000", quote_volume: "150000" },
          // stablecoin base → dibuang
          { currency_pair: "USDC_USDT", last: "1.0", lowest_ask: "1.001", highest_bid: "0.999", change_percentage: "30.0", base_volume: "300000", quote_volume: "300000" },
          // big-cap → dibuang (marketCap proxy >= 5M)
          { currency_pair: "BIG_USDT", last: "10", lowest_ask: "10.01", highest_bid: "9.99", change_percentage: "60.0", base_volume: "1000000", quote_volume: "10000000" },
        ]);
      }
      // candle fallback volume data (15m, newest-first 10 candle)
      return j([[0, "500", "0.51", "0.52", "0.49", "0.46", "2000"], [0, "300", "0.5", "0.51", "0.48", "0.47", "1000"], [0, "100", "0.49", "0.5", "0.47", "0.46", "100"], [0, "100", "0.48", "0.49", "0.46", "0.45", "100"], [0, "100", "0.48", "0.49", "0.46", "0.45", "100"], [0, "100", "0.48", "0.49", "0.46", "0.45", "100"], [0, "100", "0.48", "0.49", "0.46", "0.45", "100"], [0, "100", "0.48", "0.49", "0.46", "0.45", "100"], [0, "100", "0.48", "0.49", "0.46", "0.45", "100"], [0, "100", "0.48", "0.49", "0.46", "0.45", "100"]]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const res: PumpScanResult[] = await scanGateMicrocapPumps();
    expect(res).toHaveLength(1);
    expect(res[0].symbol).toBe("MOON/USDT");
    expect(res[0].price).toBe(0.5);
    expect(res[0].changePct24h).toBe(28);
    expect(res[0].quoteVolumeUsd).toBe(100000);
    expect(res[0].marketCapUsd).toBe(100000); // 0.5 * 200000
    expect(res[0].heat).toBe("HOT");
    expect(res[0].score).toBe(1e10);
    expect(res[0].reasons.join(" ")).toContain("momentum +28.0%");
  });
});