import { describe, it, expect, beforeEach } from "vitest";
import {
  startReplay,
  stepReplay,
  placeReplayOrder,
  closeReplayPositionManual,
  cancelReplayOrder,
  resetReplay,
  getReplayStatus,
  setReplayMode,
  buildReplayTrainingDataset,
  buildReplayTrainingCsv,
  type ReplayCandle,
} from "../src/replay/replayEngine";

function makeCandles(n: number, startPrice = 100, step = 0.5): ReplayCandle[] {
  const candles: ReplayCandle[] = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + step;
    const high = Math.max(open, close) + 0.1;
    const low = Math.min(open, close) - 0.1;
    candles.push({ timestamp: 1_700_000_000_000 + i * 60_000, open, high, low, close, volume: 100 });
    price = close;
  }
  return candles;
}

// Downtrend 1%/bar + volume surge di index 40 → RSI oversold + volume surge → LONG auto.
function makeAutoLongCandles(n = 45): ReplayCandle[] {
  const candles: ReplayCandle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = i === 40 ? price * 1.005 : price * (1 - 0.009); // kecil bounce di index 40
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.997;
    const volume = i === 40 ? 1500 : 100; // volume surge 15x
    candles.push({ timestamp: 1_700_000_000_000 + i * 60_000, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

describe("replayEngine", () => {
  beforeEach(() => {
    resetReplay();
  });

  it("starts a session with candles and steps deterministically", () => {
    const candles = makeCandles(10, 100, 0.5);
    const s = startReplay("BTC/USDT", "15m", candles, 10000);
    expect(s.candles.length).toBe(10);
    expect(s.status).toBe("idle");
    expect(s.currentIndex).toBe(-1);

    const s1 = stepReplay();
    expect(s1.currentIndex).toBe(0);
    expect(s1.status).toBe("running");
    const s2 = stepReplay();
    expect(s2.currentIndex).toBe(1);
  });

  it("fills a market order at the current candle close (taker fee)", () => {
    const candles = makeCandles(5, 100, 0.5);
    startReplay("BTC/USDT", "15m", candles, 10000);
    stepReplay(); // currentIndex = 0, close = 100.5

    const order = placeReplayOrder({
      symbol: "BTC/USDT",
      side: "buy",
      type: "market",
      amount: 1,
      leverage: 10,
      stopLoss: 95,
      takeProfit: 110,
    });
    expect(order.status).toBe("FILLED");
    expect(order.fillPrice).toBe(100.5);
    expect(order.feeUSD).toBeCloseTo(100.5 * 0.0004, 4);

    const status = getReplayStatus();
    expect(status.session!.positions.length).toBe(1);
    expect(status.session!.positions[0].side).toBe("LONG");
    expect(status.session!.positions[0].marginUSD).toBeCloseTo(100.5 / 10, 2);
  });

  it("rejects duplicate direction and invalid stop", () => {
    const candles = makeCandles(5, 100, 0.5);
    startReplay("BTC/USDT", "15m", candles, 10000);
    stepReplay();
    placeReplayOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10, stopLoss: 95, takeProfit: 110 });
    const dup = placeReplayOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10, stopLoss: 95, takeProfit: 110 });
    expect(dup.status).toBe("REJECTED");
    expect(dup.reason).toBe("DUPLICATE_POSITION_DIRECTION");

    const bad = placeReplayOrder({ symbol: "BTC/USDT", side: "sell", type: "market", amount: 1, leverage: 10, stopLoss: 95, takeProfit: 110 });
    expect(bad.status).toBe("REJECTED");
    expect(bad.reason).toBe("INVALID_STOP");
  });

  it("triggers STOP_LOSS when candle low crosses SL", () => {
    // Uptrend candles, then a big down candle that crosses SL
    const candles = makeCandles(4, 100, 0.5);
    startReplay("BTC/USDT", "15m", candles, 10000);
    stepReplay(); // close 100.5
    placeReplayOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10, stopLoss: 99, takeProfit: 115 });
    stepReplay(); // close 101
    stepReplay(); // close 101.5

    // craft a down candle that crosses SL=99
    const s = getReplayStatus();
    const s3 = s.session!;
    // replace the last candle with a bearish one
    const bearish: ReplayCandle = { timestamp: Date.now(), open: 101.5, high: 101.6, low: 98.5, close: 99.2, volume: 100 };
    const candles2 = [...candles.slice(0, 3), bearish];
    resetReplay();
    startReplay("BTC/USDT", "15m", candles2, 10000);
    stepReplay();
    placeReplayOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10, stopLoss: 99, takeProfit: 115 });
    stepReplay();
    stepReplay();
    const final = stepReplay(); // 4th candle bearish
    expect(final.positions[0].status).toBe("CLOSED");
    expect(final.positions[0].exitReason).toBe("STOP_LOSS");
    expect(final.positions[0].exitPrice).toBe(99);
    expect(final.trades.length).toBe(1);
  });

  it("closes manually and cancels pending limit orders with refund", () => {
    const candles = makeCandles(5, 100, 0.5);
    startReplay("BTC/USDT", "15m", candles, 10000);
    stepReplay();
    placeReplayOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10, stopLoss: 95, takeProfit: 110 });
    const status = getReplayStatus();
    const posId = status.session!.positions[0].id;
    const closed = closeReplayPositionManual(posId);
    expect(closed.status).toBe("CLOSED");
    expect(closed.exitReason).toBe("MANUAL");

    // limit order + cancel refund
    const limit = placeReplayOrder({ symbol: "BTC/USDT", side: "buy", type: "limit", amount: 1, leverage: 10, limitPrice: 90, stopLoss: 85, takeProfit: 110 });
    expect(limit.status).toBe("NEW");
    const cashBefore = getReplayStatus().session!.cash;
    const cancelled = cancelReplayOrder(limit.id);
    expect(cancelled.status).toBe("CANCELLED");
    const cashAfter = getReplayStatus().session!.cash;
    expect(cashAfter).toBeCloseTo(cashBefore + 90 / 10, 2); // refund margin
  });

  it("limit order invalid bracket ditolak (INVALID_STOP)", () => {
    const candles = makeCandles(5, 100, 0.5);
    startReplay("BTC/USDT", "15m", candles, 10000);
    stepReplay(); // close 100.5
    // LONG buy limit, tapi SL > limit > TP → tidak konsisten
    const bad = placeReplayOrder({
      symbol: "BTC/USDT", side: "buy", type: "limit", amount: 1, leverage: 10,
      limitPrice: 100, stopLoss: 101, takeProfit: 99, decisionId: "d-bad",
    });
    expect(bad.status).toBe("REJECTED");
    expect(bad.reason).toBe("INVALID_STOP");
    // valid LONG limit → NEW, margin di-reserve
    const good = placeReplayOrder({
      symbol: "BTC/USDT", side: "buy", type: "limit", amount: 1, leverage: 10,
      limitPrice: 99, stopLoss: 95, takeProfit: 110, decisionId: "d-good",
    });
    expect(good.status).toBe("NEW");
    expect(good.reason).toBeUndefined();
    const cashAfter = getReplayStatus().session!.cash;
    expect(cashAfter).toBeCloseTo(10000 - 99 / 10 - 0, 2); // margin reserved
  });

  it("reaches done status at the end", () => {
    const candles = makeCandles(3, 100, 0.5);
    startReplay("BTC/USDT", "15m", candles, 10000);
    stepReplay();
    stepReplay();
    const final = stepReplay();
    expect(final.status).toBe("done");
  });

  it("decisionId flows order → position → trade (training join)", () => {
    const candles = makeCandles(6, 100, 0.5);
    startReplay("BTC/USDT", "15m", candles, 10000);
    stepReplay();
    placeReplayOrder({
      symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10,
      stopLoss: 95, takeProfit: 110, decisionId: "decision-abc-123",
    });
    const mid = getReplayStatus();
    expect(mid.session!.positions[0].decisionId).toBe("decision-abc-123");
    const closed = closeReplayPositionManual(mid.session!.positions[0].id);
    const final = getReplayStatus();
    expect(final.session!.trades.length).toBe(1);
    expect(final.session!.trades[0].decisionId).toBe("decision-abc-123");
    expect(closed.decisionId).toBe("decision-abc-123");
    // candle indexes tercatat untuk feature alignment
    expect(final.session!.trades[0].openedCandleIndex).toBe(0);
    expect(final.session!.trades[0].closedCandleIndex).toBeGreaterThanOrEqual(0);
  });

  it("buildReplayTrainingDataset menghasilkan stats + CSV yang benar", () => {
    const candles = makeCandles(8, 100, 0.5);
    startReplay("BTC/USDT", "15m", candles, 10000);
    stepReplay(); // idx 0, close 100.5
    // 1 win: LONG entry 100.5, tutup manual setelah 2 candle naik → exit 101.5
    placeReplayOrder({ symbol: "BTC/USDT", side: "buy", type: "market", amount: 1, leverage: 10, stopLoss: 95, takeProfit: 102, decisionId: "d-win" });
    stepReplay(); // idx 1
    stepReplay(); // idx 2, close 101.5
    const st1 = getReplayStatus();
    closeReplayPositionManual(st1.session!.positions[0].id);
    // 1 loss: SHORT entry 101.5, tutup manual di harga yang sama → pnl = -fee
    placeReplayOrder({ symbol: "BTC/USDT", side: "sell", type: "market", amount: 1, leverage: 10, stopLoss: 104, takeProfit: 98, decisionId: "d-loss" });
    const st2 = getReplayStatus();
    closeReplayPositionManual(st2.session!.positions.find((p) => p.status === "OPEN")!.id);

    const ds = buildReplayTrainingDataset();
    expect(ds.kind).toBe("replay-training-dataset");
    expect(ds.stats.totalTrades).toBe(2);
    expect(ds.stats.wins).toBe(1);
    expect(ds.stats.losses).toBe(1);
    expect(ds.stats.winRate).toBe(50);
    expect(ds.trades.every((t) => t.decisionId)).toBe(true);
    expect(ds.trades.every((t) => t.holdCandles >= 0)).toBe(true);
    expect(ds.trades.every((t) => t.riskR !== null)).toBe(true);

    const csv = buildReplayTrainingCsv();
    const lines = csv.split("\n");
    // header diawali trade_id & diakhiri decision_id (18 kolom)
    expect(lines[0].startsWith("trade_id,symbol,side")).toBe(true);
    expect(lines[0].endsWith("hold_candles,decision_id")).toBe(true);
    expect(lines.length).toBe(3); // header + 2 trades
    expect(lines[1]).toContain("d-win");
    expect(lines[2]).toContain("d-loss");
  });

  it("mode AUTO membuka LONG otomatis saat RSI oversold + volume surge", () => {
    const candles = makeAutoLongCandles(45);
    startReplay("BTC/USDT", "15m", candles, 10000);
    setReplayMode("auto", { minCandles: 30, rsiLong: 35, rsiShort: 65, riskPct: 2, leverage: 10 });
    expect(getReplayStatus().session!.mode).toBe("auto");

    for (let i = 0; i <= 40; i++) stepReplay();

    const st = getReplayStatus();
    expect(st.session!.lastAutoSignal?.action).toBe("BUY");
    expect(st.session!.lastAutoSignal?.index).toBe(40);
    const open = st.session!.positions.filter((p) => p.status === "OPEN");
    expect(open.length).toBe(1);
    expect(open[0].side).toBe("LONG");
    // decisionId auto tercatat untuk training join
    expect(open[0].decisionId).toContain("auto-40-BUY");
    // SL/TP valid untuk LONG
    expect(open[0].stopLoss).toBeLessThan(open[0].entryPrice);
    expect(open[0].takeProfit).toBeGreaterThan(open[0].entryPrice);
  });

  it("mode AUTO + params kustom (rsiShort rendah) → SHORT saat overbought + volume surge", () => {
    // Uptrend 1%/bar, volume surge di index 40 → RSI tinggi + volSurge → SHORT.
    const candles: ReplayCandle[] = [];
    let price = 100;
    for (let i = 0; i < 45; i++) {
      const open = price;
      const close = i === 40 ? price * 0.995 : price * 1.009;
      const high = Math.max(open, close) * 1.001;
      const low = Math.min(open, close) * 0.997;
      candles.push({
        timestamp: 1_700_000_000_000 + i * 60_000,
        open,
        high,
        low,
        close,
        volume: i === 40 ? 1500 : 100,
      });
      price = close;
    }
    startReplay("BTC/USDT", "15m", candles, 10000);
    setReplayMode("auto", { minCandles: 30, rsiLong: 25, rsiShort: 60, riskPct: 2, leverage: 10 });
    for (let i = 0; i <= 40; i++) stepReplay();

    const st = getReplayStatus();
    expect(st.session!.lastAutoSignal?.action).toBe("SELL");
    const open = st.session!.positions.filter((p) => p.status === "OPEN");
    expect(open.length).toBe(1);
    expect(open[0].side).toBe("SHORT");
    expect(open[0].stopLoss).toBeGreaterThan(open[0].entryPrice);
    expect(open[0].takeProfit).toBeLessThan(open[0].entryPrice);
  });
});