/**
 * P1-03 — Bracket/replay kronologi:
 *  - posisi yang BARU dibuka di candle k TIDAK boleh dieksekusi stop/TP dari
 *    range high/low candle k yang terjadi SEBELUM entry (pre-entry data).
 *  - SL/TP/liq tersentuh dalam SATU candle → urutan tidak diketahui → tandai
 *    `ambiguousExit` + event REPLAY_AMBIGUITY, tanpa mengklaim urutan asli.
 *  - flag honest ikut dataset & CSV (kolom ambiguous_exit) untuk training.
 * Semua sandbox in-memory (tidak menyentuh DB/.env).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  startReplay,
  stepReplay,
  placeReplayOrder,
  resetReplay,
  getReplaySessionFull,
  buildReplayTrainingDataset,
  buildReplayTrainingCsv,
  type ReplayCandle,
} from "../src/replay/replayEngine";

function candle(open: number, high: number, low: number, close: number, ts: number): ReplayCandle {
  return { timestamp: ts, open, high, low, close, volume: 100 };
}

beforeEach(() => resetReplay());

describe("P1-03 replay kronologi", () => {
  it("pre-entry guard: posisi limit terisi di candle k tidak di-stop oleh low candle k", () => {
    // c1: fill limit @97 terjadi SEPERTI low-nya 96.4 (menyentuh SL 96.6).
    // TANPA guard, SL akan "terkena" di candle yang sama dengan low pre-entry.
    const candles = [
      candle(100, 101, 99, 100, 1_700_001_000_000), // idx0: order limit dipasang
      candle(99, 99.5, 96.4, 97.5, 1_700_001_900_000), // idx1: limit terisi @97; low 96.4 <= SL 96.6 (pre-entry!)
      candle(97.5, 98, 96.2, 96.8, 1_700_002_800_000), // idx2: low 96.2 <= SL → STOP_LOSS normal
    ];
    startReplay("BTC/USDT", "15m", candles, 10_000);
    stepReplay(); // idx0
    placeReplayOrder({
      symbol: "BTC/USDT", side: "buy", type: "limit", amount: 1, leverage: 10,
      limitPrice: 97, stopLoss: 96.6, takeProfit: 98.5,
    });
    // idx1: limit terisi di candle ini
    stepReplay();
    const s1 = getReplaySessionFull()!;
    const pos = s1.positions[0];
    expect(pos.status).toBe("OPEN");
    expect(pos.openedCandleIndex).toBe(1);
    expect(s1.trades).toHaveLength(0); // tidak di-stop oleh low pre-entry candle yang sama
    // idx2: candle berikutnya menyentuh SL → close normal, TANPA ambiguity
    stepReplay();
    const s2 = getReplaySessionFull()!;
    expect(s2.positions[0].status).toBe("CLOSED");
    expect(s2.trades[0].exitReason).toBe("STOP_LOSS");
    expect(s2.trades[0].ambiguousExit).toBeUndefined();
  });

  it("SL+TP tersentuh satu candle → STOP_LOSS worst-case ditandai ambiguous", () => {
    const candles = [
      candle(100, 101, 99, 100, 1_700_001_000_000), // idx0: entry LONG market @100
      candle(99, 104.5, 95, 100.5, 1_700_001_900_000), // idx1: low 95 <= SL 97.5 DAN high 104.5 >= TP 103
    ];
    startReplay("BTC/USDT", "15m", candles, 10_000);
    stepReplay(); // idx0
    placeReplayOrder({
      symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10,
      stopLoss: 97.5, takeProfit: 103,
    });
    stepReplay(); // idx1
    const s = getReplaySessionFull()!;
    expect(s.positions[0].status).toBe("CLOSED");
    const trade = s.trades[0];
    // urutan deterministik worst-case: stop dulu — TAPI ditandai tidak tahu urutan.
    expect(trade.exitReason).toBe("STOP_LOSS");
    expect(trade.ambiguousExit).toBe(true);
    const ambEv = s.events.find((e) => e.type === "REPLAY_AMBIGUITY");
    expect(ambEv).toBeTruthy();
    expect(ambEv!.payload.touched).toEqual(["STOP_LOSS", "TAKE_PROFIT"]);
    // dataset + CSV jujur membawa flag
    const ds = buildReplayTrainingDataset();
    expect(ds.trades[0].ambiguousExit).toBe(true);
    const csv = buildReplayTrainingCsv();
    expect(csv.split("\n")[0]).toContain("ambiguous_exit");
    expect(csv.split("\n")[1]).toContain(",1,binance");
  });

  it("SHORT: liq+TP satu candle → LIQUIDATED ambiguous; TP saja → tidak ambiguous", () => {
    // (a) liq + TP tersentuh bersamaan
    const candlesA = [
      candle(100, 101, 99, 100, 1_700_001_000_000),
      candle(101, 112, 96, 100, 1_700_001_900_000), // short: high 112 >= SL/liq@~109;; low 96 <= TP 97
    ];
    startReplay("BTC/USDT", "15m", candlesA, 10_000);
    stepReplay();
    placeReplayOrder({ symbol: "BTC/USDT", side: "sell", type: "market", amount: 1, leverage: 10, stopLoss: 109, takeProfit: 97 });
    stepReplay();
    const s = getReplaySessionFull()!;
    expect(s.trades[0].exitReason).toBe("LIQUIDATED");
    expect(s.trades[0].ambiguousExit).toBe(true);

    // (b) hanya TP yang tersentuh
    resetReplay();
    const candlesB = [
      candle(100, 101, 99, 100, 1_700_001_000_000),
      candle(99, 100, 96.5, 98, 1_700_001_900_000), // low 96.5 <= TP 97, high tidak menyentuh SL
    ];
    startReplay("BTC/USDT", "15m", candlesB, 10_000);
    stepReplay();
    placeReplayOrder({ symbol: "BTC/USDT", side: "sell", type: "market", amount: 1, leverage: 10, stopLoss: 109, takeProfit: 97 });
    stepReplay();
    const sb = getReplaySessionFull()!;
    expect(sb.trades[0].exitReason).toBe("TAKE_PROFIT");
    expect(sb.trades[0].ambiguousExit).toBeUndefined();
    expect(sb.events.some((e) => e.type === "REPLAY_AMBIGUITY")).toBe(false);
  });
});