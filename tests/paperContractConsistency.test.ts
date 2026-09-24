/**
 * P1-03b — KONTRAK konsisten antara replay & paperbook, plus labelling
 * strategi replay yang jujur (beda dgn Keel/AI).
 *  1. liquidationPrice replay == paperbook/fill untuk matriks {entry, lev, side}.
 *  2. Fee/margin/leverage replay == paperbook/config (single source; drift
 *     dicegah oleh import; assertion menjaga nilai & env lega).
 *  3. entrySource/strategy: order manual → "MANUAL"; auto RSI (replay-auto)
 *     → source "replay-auto" + strategy "RSI-EMA-VOL-ATR"; ikut dataset & CSV.
 * Sandbox in-memory, tanpa DB/.env.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  startReplay,
  stepReplay,
  placeReplayOrder,
  setReplayMode,
  resetReplay,
  closeReplayPositionManual,
  getReplaySessionFull,
  buildReplayTrainingDataset,
  buildReplayTrainingCsv,
  liquidationPrice as replayLiquidationPrice,
  TAKER_FEE_RATE as replayTaker,
  MAKER_FEE_RATE as replayMaker,
  MAINTENANCE_MARGIN_RATE as replayMmr,
  MAX_LEVERAGE as replayMaxLev,
  type ReplayCandle,
} from "../src/replay/replayEngine";
import { liquidationPrice as paperLiquidationPrice } from "../src/paperbook/fill";
import { TAKER_FEE_RATE, MAKER_FEE_RATE, MAINTENANCE_MARGIN_RATE, MAX_LEVERAGE } from "../src/paperbook/config";

function makeAutoLongCandles(n = 46): ReplayCandle[] {
  const candles: ReplayCandle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = i === 40 ? price * 1.005 : price * (1 - 0.009);
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.997;
    const volume = i === 40 ? 1500 : 100;
    candles.push({ timestamp: 1_700_000_000_000 + i * 60_000, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

beforeEach(() => resetReplay());

describe("P1-03b kontrak replay vs paper", () => {
  it("liquidationPrice identik untuk semua matriks {entry, lev, side}", () => {
    const entries = [10, 100, 1_000_000];
    const levs = [1, 2, 5, 10, 20, 50];
    for (const e of entries) {
      for (const lev of levs) {
        expect(replayLiquidationPrice(e, lev, "LONG")).toBeCloseTo(paperLiquidationPrice(e, lev, "LONG"), 6);
        expect(replayLiquidationPrice(e, lev, "SHORT")).toBeCloseTo(paperLiquidationPrice(e, lev, "SHORT"), 6);
      }
    }
  });

  it("fee/margin/leverage satu sumber (paperbook/config)", () => {
    expect(replayTaker).toBe(TAKER_FEE_RATE);
    expect(replayMaker).toBe(MAKER_FEE_RATE);
    expect(replayMmr).toBe(MAINTENANCE_MARGIN_RATE);
    expect(replayMaxLev).toBe(MAX_LEVERAGE);
    expect(replayTaker).toBeCloseTo(0.0004, 10); // PAPER_FEE_TAKER_BPS default 4
    expect(replayMmr).toBe(0.004);
  });

  it("order manual → entrySource MANUAL (bukan AUTOPILOT, bukan replay-auto)", () => {
    startReplay("BTC/USDT", "15m", makeAutoLongCandles(10), 10_000);
    stepReplay();
    placeReplayOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10, stopLoss: 95, takeProfit: 110 });
    const pos = getReplaySessionFull()!.positions[0];
    expect(pos.entrySource).toBe("MANUAL");
    closeReplayPositionManual(pos.id);
    const trade = getReplaySessionFull()!.trades[0];
    expect(trade.entrySource).toBe("MANUAL");
    const csv = buildReplayTrainingCsv();
    expect(csv.split("\n")[0]).toContain("entry_source");
    expect(csv.split("\n")[1]).toContain(",MANUAL,");
  });

  it("mode AUTO (RSI) → entrySource replay-auto + strategy RSI-EMA-VOL-ATR, beda kelas strategi", () => {
    startReplay("BTC/USDT", "15m", makeAutoLongCandles(), 10_000);
    setReplayMode("auto", { minCandles: 30, rsiLong: 35, rsiShort: 65, riskPct: 2, leverage: 10 });
    for (let i = 0; i <= 40; i++) stepReplay(); // sinyal di idx 40 → posisi terbuka di candle tsb
    const s = getReplaySessionFull()!;
    const auto = s.positions.find((p) => p.status === "OPEN");
    expect(auto).toBeTruthy();
    expect(auto!.decisionId).toMatch(/^auto-/); // identitas strategi RSI
    expect(auto!.entrySource).toBe("replay-auto");
    expect(auto!.strategy).toBe("RSI-EMA-VOL-ATR");
    closeReplayPositionManual(auto!.id);
    const trade = getReplaySessionFull()!.trades[0];
    expect(trade.entrySource).toBe("replay-auto");
    expect(trade.strategy).toBe("RSI-EMA-VOL-ATR");
    // dataset & CSV membedakan strategi replay dari Keel/AI (entry_source+strategy)
    const ds = buildReplayTrainingDataset();
    expect(ds.trades[0].entrySource).toBe("replay-auto");
    expect(ds.trades[0].strategy).toBe("RSI-EMA-VOL-ATR");
    const csv = buildReplayTrainingCsv();
    expect(csv.split("\n")[0]).toContain("entry_source");
    expect(csv.split("\n")[0]).toContain("strategy");
    expect(csv.split("\n")[1]).toContain("replay-auto,");
    expect(csv.split("\n")[1]).toContain("RSI-EMA-VOL-ATR");
  });
});