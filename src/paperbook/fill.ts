import { createHmac, createHash } from "node:crypto";
import { getExchange, ensureMarketsLoaded } from "../../broker";
import { fetchTickerPrice } from "../data/marketFetcher";
import {
  state,
  appendEvent,
  newId,
  getPaperAccount,
  dbSavePosition,
  dbSaveOrder,
  dbSaveOrderTolerant,
  persistSnapshot,
  persistSnapshotTolerant,
  normalizeSymbol,
} from "./store";

import {
  TAKER_FEE_RATE,
  MAX_LEVERAGE,
  ORDERBOOK_LEVELS,
  EXCHANGE_LATENCY_MS_MIN,
  EXCHANGE_LATENCY_MS_MAX,
  MAINTENANCE_MARGIN_RATE,
} from "./config";
import {
  PaperSide,
  PaperPosition,
  PaperOrderReceipt,
  PaperOrderMeta,
  OpenPaperPositionInput,
  OpenPaperPositionResult,
  ClosePaperPositionResult,
  ExitReason,
  FillResult,
} from "./types";
import { PaperOrderError } from "./errors";
import { beginTx, commitTx, rollbackTx, appendAudit } from "../../db";
import { withPaperMutationLock } from "./mutex";
import {
  evaluateOrderRisk,
  describeOrderRiskRejection,
  isOrderRiskGateEnabled,
} from "../logic/orderRiskGate";

function roundTo(n: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round((n + Number.EPSILON) * f) / f;
}
const r2 = (n: number) => roundTo(Number(n), 2);
const r3 = (n: number) => roundTo(Number(n), 3);
const r4 = (n: number) => roundTo(Number(n), 4);
const r6 = (n: number) => roundTo(Number(n), 6);
const r8 = (n: number) => roundTo(Number(n), 8);

let warnedDefaultSecret = false;

export function signPayload(payload: string): { signature: string; payloadHash: string } {
  // F-06: fail-closed di production — jangan pernah default ke secret dev saat NODE_ENV=production.
  const rawSecret = process.env.BROKER_EVENT_SECRET;
  if (!rawSecret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "BROKER_EVENT_SECRET wajib disetel di production — menolak menandatangani event broker (fail-closed)."
      );
    }
    if (!warnedDefaultSecret) {
      console.warn("[paperBook] BROKER_EVENT_SECRET belum disetel — memakai default 'paper-dev-secret' (DEV ONLY).");
      warnedDefaultSecret = true;
    }
  }
  const secret = rawSecret || "paper-dev-secret";
  const payloadHash = createHash("sha256").update(payload, "utf-8").digest("hex");
  const signature = createHmac("sha256", secret).update(payload, "utf-8").digest("hex");
  return { signature, payloadHash };
}

// ------------------------------------------------------------------
// Fill engine
// ------------------------------------------------------------------

async function marketFill(
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  triggerPrice?: number,
  bracketMode: "none" | "stop" | "profit" = "none"
): Promise<FillResult> {
  const t0 = Date.now();
  const exchange = getExchange();
  try {
    await ensureMarketsLoaded(exchange);
    const book = await exchange.fetchOrderBook(symbol, ORDERBOOK_LEVELS);
    const asks: number[][] = book.asks || [];
    const bids: number[][] = book.bids || [];
    if (asks.length > 0 && bids.length > 0) {
      const bestAsk = Number(asks[0][0]);
      const bestBid = Number(bids[0][0]);
      const mid = (bestAsk + bestBid) / 2;
      const ladder = side === "buy" ? asks : bids;
      let remaining = qty;
      let weightedSum = 0;
      for (const level of ladder) {
        if (remaining <= 0) break;
        const price = Number(level[0]);
        const size = Number(level[1]);
        const take = Math.min(remaining, size);
        weightedSum += price * take;
        remaining -= take;
      }
      if (remaining > 0) {
        // Versi 2026-09-10: JANGAN extrapolate fill di luar visible depth.
        // Order yang melebihi kedalaman top-20 difill PARSIAL atas qty yang
        // kebagian book; sisanya diteruskan sebagai PARTIALLY_FILLED.
        // Extrapolate dengan penalty spread (logika lama, dihapus) justru
        // mengada-ada: harga fill bagian unfilled tidak terukur → tidak boleh
        // diproduksi sebagai fill.
        const filledQty = roundTo(qty - remaining, 8);
        if (filledQty <= 0) {
          throw new PaperOrderError("NO_DEPTH", `Orderbook tidak cukup likuid untuk ${symbol} ${side}. Depth top-20 habis.`);
        }
        let fillPrice = weightedSum / filledQty;
        if (bracketMode !== "none" && triggerPrice !== undefined && triggerPrice > 0) {
          fillPrice = side === "buy" ? Math.max(triggerPrice, fillPrice) : Math.min(triggerPrice, fillPrice);
        }
        const slippageBps = (Math.abs(fillPrice - mid) / mid) * 10000;
        return {
          fillPrice: roundTo(fillPrice, 6),
          slippageBps: roundTo(slippageBps, 2),
          feeUSD: roundTo(fillPrice * filledQty * TAKER_FEE_RATE, 4),
          method: "ORDERBOOK",
          latencyMs: Date.now() - t0,
          filledQty,
          unfilledQty: roundTo(remaining, 8),
        };
      }
      let fillPrice = weightedSum / qty;
      if (bracketMode !== "none" && triggerPrice !== undefined && triggerPrice > 0) {
        fillPrice = side === "buy" ? Math.max(triggerPrice, fillPrice) : Math.min(triggerPrice, fillPrice);
      }
      const slippageBps = (Math.abs(fillPrice - mid) / mid) * 10000;
      return {
        fillPrice: roundTo(fillPrice, 6),
        slippageBps: roundTo(slippageBps, 2),
        feeUSD: roundTo(fillPrice * qty * TAKER_FEE_RATE, 4),
        method: "ORDERBOOK",
        latencyMs: Date.now() - t0,
        filledQty: qty,
        unfilledQty: 0,
      };
    }
  } catch {}

  // F-03/P1: slippage DIUKUR dari mid-price pre-trade (bukan touch level).
  // Rasional: taker market menanggung ~setengah spread intrinsik BAHKAN pada
  // top-of-book fill sempurna (fill di ask vs mid untuk BUY), ditambah
  // adverse adverse-selection + walk-the-book per level yang dilewati.
  // Benchmark vs touch justru menghilangkan komponen spread dan
  // MERENDAHKAN biaya riil → backtest PnL overstated 1-3%. Lihat catatan
  // midVsTouchSlippageBps() di bawah untuk derivasi per-komponen.
  try {
    const ticker = await getExchange().fetchTicker(symbol);
    const bid = Number(ticker.bid);
    const ask = Number(ticker.ask);
    if (!isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) {
      throw new PaperOrderError("NO_PRICE", `Tidak ada harga (bid/ask) untuk ${symbol}.`);
    }
    const mid = (bid + ask) / 2;
    let fillPrice = side === "buy" ? ask : bid;
    if (bracketMode !== "none" && triggerPrice !== undefined && triggerPrice > 0) {
      fillPrice = side === "buy" ? Math.max(triggerPrice, fillPrice) : Math.min(triggerPrice, fillPrice);
    }
    const slippageBps = (Math.abs(fillPrice - mid) / mid) * 10000;
    return {
      fillPrice: roundTo(fillPrice, 6),
      slippageBps: roundTo(slippageBps, 2),
      feeUSD: roundTo(fillPrice * qty * TAKER_FEE_RATE, 4),
      method: "TICKER",
      latencyMs: Date.now() - t0,
      filledQty: qty,
      unfilledQty: 0,
    };
  } catch (err) {
    // CCXT exchange (Binance) tidak terjangkau / kena blokir ISP.
    // Fallback: pakai market-fetcher chain (Binance Vision → Gate.io → Bybit → Synthetic)
    // supaya open/close posisi paper tetap jalan tanpa bergantung pada api.binance.com.
    try {
      const tp = await fetchTickerPrice(symbol);
      if (tp.ok && isFinite(tp.price) && tp.price > 0) {
        const fillPrice = (bracketMode !== "none" && triggerPrice !== undefined && triggerPrice > 0)
          ? (side === "buy" ? Math.max(triggerPrice, tp.price) : Math.min(triggerPrice, tp.price))
          : tp.price;
        const slip = Math.max(0, (Math.abs(fillPrice - tp.price) / tp.price) * 10000);
        return {
          fillPrice: roundTo(fillPrice, 6),
          slippageBps: roundTo(slip, 2),
          feeUSD: roundTo(fillPrice * qty * TAKER_FEE_RATE, 4),
          method: "TICKER",
          latencyMs: Date.now() - t0,
          filledQty: qty,
          unfilledQty: 0,
        };
      }
    } catch (chainErr) {
      // fallthrough
    }
    if (err instanceof PaperOrderError) throw err;
    throw new PaperOrderError("NO_PRICE", `Tidak ada harga untuk ${symbol}: ${(err as Error).message}`);
  }
}

/**
 * F-03/P1 — dekomposisi slippage per-komponen untuk audit backtest.
 * Total vs mid  = half-spread (tak terhindarkan taker) + walk-the-book
 * (VWAP di atas/bawah touch). Total vs touch = HANYA walk-the-book.
 * Konsekuensi: benchmark vs touch mengabaikan half-spread → biaya taker
 * sistematis underreported ±(spread/2), kumulatif 20-50 bps per ratusan
 * order besar → PnL backtest overstated. Benchmark yang benar: MID.
 *
 * Contoh (audit report): BUY 200 BTC, depth 100@45000/50@45010/50@45020,
 * mid 44995, VWAP fill 45010 → vs mid ≈ 33 bps (benar), vs touch ≈ 22 bps
 * (salah — mengabaikan 11 bps half-spread yang riil dibayar taker).
 */
export function midVsTouchSlippageBps(
  fillPrice: number,
  bestLevel: number,
  mid: number
): { vsMidBps: number; vsTouchBps: number; halfSpreadBps: number } {
  const vsMidBps = mid > 0 ? (Math.abs(fillPrice - mid) / mid) * 10000 : 0;
  const vsTouchBps = bestLevel > 0 ? (Math.abs(fillPrice - bestLevel) / bestLevel) * 10000 : 0;
  const halfSpreadBps = mid > 0 ? (Math.abs(bestLevel - mid) / mid) * 10000 : 0;
  return {
    vsMidBps: roundTo(vsMidBps, 2),
    vsTouchBps: roundTo(vsTouchBps, 2),
    halfSpreadBps: roundTo(halfSpreadBps, 2),
  };
}

export function liquidationPrice(entryPrice: number, leverage: number, side: PaperSide): number {
  const lev = leverage > 0 ? leverage : 1;
  if (side === "LONG") {
    return roundTo(entryPrice * (1 - 1 / lev + MAINTENANCE_MARGIN_RATE), 6);
  }
  return roundTo(entryPrice * (1 + 1 / lev - MAINTENANCE_MARGIN_RATE), 6);
}

/**
 * F-04/P2 — liquidation dengan funding accrual.
 *
 * Formula statis liquidationPrice() mengabaikan biaya funding periodik
 * (±0.01%/8h tipikal, ekstrem ±0.1%/8h) yang menggerus margin dan
 * mempercepat likuidasi riil 0.5-2% (terutama leverage 20x+ dengan hold
 * berhari-hari). Fungsi ini eksplisit: base statis + akumulasi funding.
 *
 * Konvensi fundingRate: positif = LONG bayar SHORT per interval 8 jam.
 * LONG dengan funding positif → liq naik (lebih cepat); SHORT dengan
 * funding positif → liq turun (lebih lambat, menerima pembayaran).
 * Tanpa fundingRate/holdDurationHours → identik dengan base statis.
 */
export function liquidationPriceWithFunding(
  entryPrice: number,
  leverage: number,
  side: PaperSide,
  fundingRate?: number,
  holdDurationHours?: number
): number {
  const baseLiq = liquidationPrice(entryPrice, leverage, side);
  if (fundingRate == null || holdDurationHours == null) return baseLiq;
  if (!isFinite(fundingRate) || !isFinite(holdDurationHours) || holdDurationHours <= 0) return baseLiq;
  const lev = leverage > 0 ? leverage : 1;
  // Akumulasi per interval 8 jam atas notional, dinormalisasi ke harga
  // (dibagi leverage karena margin = notional / leverage).
  const intervals = holdDurationHours / 8;
  const fundingPerUnit = entryPrice * fundingRate * intervals;
  const adj = fundingPerUnit / lev;
  if (side === "LONG") {
    // LONG membayar funding positif → margin terkikis → liq naik.
    return roundTo(baseLiq + Math.sign(fundingRate) * Math.abs(adj), 6);
  }
  // SHORT menerima funding positif → margin bertambah → liq turun (menjauh).
  return roundTo(baseLiq - Math.sign(fundingRate) * Math.abs(adj), 6);
}

// ------------------------------------------------------------------
// Pre-trade risk gate (F1/P0) — CHOKE POINT untuk semua order paper
// ------------------------------------------------------------------
//
// Kenapa di sini (bukan di router): router /api/broker/order hanya menjalankan
// guardrails (kill-switch, daily-loss, max posisi, cooldown) — tidak ada satu
// pun aturan matematis, sehingga RR 1.28 dan SL 0.08% lolos ke pasar (forensik
// trading.db). Gate di sini memakai HARGA EKSEKUSI AKTUAL + qty yang benar-benar
// terisi, jadi tidak ada jalur (manual, autopilot, replay, atau caller baru)
// yang bisa melewatinya. Ditolak SEBELUM state/DB tersentuh.
function enforceOrderRiskGate(
  orderId: string,
  input: {
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    stopLoss: number;
    takeProfit: number;
    leverage: number;
  }
): void {
  if (!isOrderRiskGateEnabled()) return;
  let equity: number | undefined;
  try {
    equity = getPaperAccount().equity;
  } catch {
    equity = undefined;
  }
  const evaluation = evaluateOrderRisk({ ...input, equity });
  if (evaluation.approved) return;
  const message = describeOrderRiskRejection(evaluation);
  appendEvent("ORDER_REJECTED", {
    orderId,
    symbol: input.symbol,
    side: input.side,
    reason: "RISK_GATE_REJECTED",
    message,
    metrics: evaluation.metrics,
  });
  throw new PaperOrderError("RISK_GATE_REJECTED", message);
}

// ------------------------------------------------------------------
// Idempotency (F1/P0) — clientOrderId dari FE
// ------------------------------------------------------------------
// Klik ganda / retry network dengan clientOrderId yang sama mengembalikan
// receipt yang SAMA (tidak membuka posisi kedua). In-memory + TTL: menutup
// double-submit dalam satu sesi server. Ini PELENGKAP, bukan pengganti cek
// duplikat simbol+side (yang tetap berlaku untuk semua order).
const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const clientOrderCache = new Map<string, { at: number; result: OpenPaperPositionResult }>();

function idempotentHit(clientOrderId: string | undefined, now: number): OpenPaperPositionResult | null {
  if (!clientOrderId) return null;
  for (const [key, value] of clientOrderCache) {
    if (now - value.at > IDEMPOTENCY_TTL_MS) clientOrderCache.delete(key);
  }
  const hit = clientOrderCache.get(clientOrderId);
  return hit ? hit.result : null;
}

function rememberClientOrder(clientOrderId: string | undefined, result: OpenPaperPositionResult, now: number): void {
  if (!clientOrderId) return;
  clientOrderCache.set(clientOrderId, { at: now, result });
}

/** Untuk test: bersihkan cache idempotency. */
export function _resetClientOrderCacheForTest(): void {
  clientOrderCache.clear();
}

// ------------------------------------------------------------------
// Open / close
// ------------------------------------------------------------------

/**
 * Wrapper serialisasi (F1/P0): cek duplikat + guardrail + mutasi cash harus
 * atomik terhadap request konkuren — lihat src/paperbook/mutex.ts untuk bukti
 * bug (5 posisi identik dalam 33 ms).
 */
export async function openPaperPosition(input: OpenPaperPositionInput): Promise<OpenPaperPositionResult> {
  return withPaperMutationLock(() => openPaperPositionLocked(input));
}

async function openPaperPositionLocked(input: OpenPaperPositionInput): Promise<OpenPaperPositionResult> {
  // Idempotency: klik ganda / retry network dengan clientOrderId sama →
  // kembalikan receipt yang SAMA (tidak membuka posisi kedua).
  const clientOrderId = (input.meta as PaperOrderMeta | undefined)?.clientOrderId;
  const idempotencyNow = Date.now();
  const cachedResult = idempotentHit(clientOrderId, idempotencyNow);
  if (cachedResult) return cachedResult;

  const qty = Number(input.qty);
  if (!isFinite(qty) || qty <= 0) {
    throw new PaperOrderError("INVALID_QTY", "qty harus angka positif.");
  }
  // SPOT semantics (satu panel, mode-aware): marketType dari meta order.
  // SPOT = beli aset beneran: LONG-only (sell ditolak fail-closed),
  // leverage dipaksa 1x, margin = notional penuh, tanpa liquidation price.
  const marketType = String(input.meta?.marketType || "FUTURES").toUpperCase() === "SPOT" ? "SPOT" : "FUTURES";
  const isSpot = marketType === "SPOT";
  if (isSpot && String(input.side).toLowerCase() === "sell") {
    throw new PaperOrderError("SPOT_SHORT_NOT_ALLOWED", "SPOT hanya bisa BUY/LONG — SHORT butuh margin futures. Ganti ke FUTURES untuk SHORT.");
  }
  const side: PaperSide = input.side === "sell" ? "SHORT" : "LONG";
  const direction = input.side === "sell" ? "sell" : "buy";
  const leverage = isSpot ? 1 : (input.leverage && input.leverage > 0 ? Math.min(MAX_LEVERAGE, Number(input.leverage)) : 1);
  const symbol = normalizeSymbol(input.symbol);
  const stopLoss = Number(input.stopLoss);
  const takeProfit = Number(input.takeProfit);
  if (!isFinite(stopLoss) || stopLoss <= 0 || !isFinite(takeProfit) || takeProfit <= 0) {
    throw new PaperOrderError("MISSING_STOP", "stopLoss dan takeProfit wajib diisi untuk posisi baru.");
  }

  const duplicate = state.positions.find((p) => p.symbol === symbol && p.side === side && p.status === "OPEN");
  if (duplicate) {
    throw new PaperOrderError(
      "DUPLICATE_POSITION_DIRECTION",
      `Sudah ada posisi ${side} ${symbol} yang masih OPEN (${duplicate.id}). Tutup atau jangan duplikat arah.`
    );
  }

  const orderType = input.orderType || "market";
  const limitPrice = input.limitPrice ? Number(input.limitPrice) : undefined;

  // Validate limit order
  if (orderType === "limit" && (!limitPrice || !isFinite(limitPrice) || limitPrice <= 0)) {
    throw new PaperOrderError("INVALID_LIMIT_PRICE", "limitPrice wajib diisi untuk limit order.");
  }

  const positionId = newId("pos");
  const orderId = newId("ord");
  const now = Date.now();

  // Simulate exchange latency (5-50ms)
  const exchangeLatency = Math.floor(Math.random() * (EXCHANGE_LATENCY_MS_MAX - EXCHANGE_LATENCY_MS_MIN + 1)) + EXCHANGE_LATENCY_MS_MIN;
  const submittedAt = now + exchangeLatency;

  // Initial order payload + signature
  const payload = JSON.stringify({
    symbol,
    side: direction,
    type: orderType,
    amount: qty,
    leverage,
    marketType,
    stopLoss,
    takeProfit,
    ...(orderType === "limit" && limitPrice ? { limitPrice } : {}),
    meta: input.meta || {},
    timestamp: now,
    orderId,
  });
  const signed = signPayload(payload);

  const initialOrder: PaperOrderReceipt = {
    id: orderId,
    mode: "paper",
    symbol,
    side: direction,
    type: orderType,
    amount: qty,
    limitPrice,
    feeUSD: 0,
    qty,
    notional: 0,
    leverage: roundTo(leverage, 2),
    marginRequired: 0,
    executionLatencyMs: exchangeLatency,
    timestamp: now,
    status: "NEW",
    positionId,
    submittedAt,
    stopLoss,
    takeProfit,
    meta: input.meta,
    signature: signed.signature,
    payloadHash: signed.payloadHash,
  };

  // Emit ORDER_NEW so FE sees the lifecycle start
  appendEvent("ORDER_NEW", {
    orderId,
    positionId,
    symbol,
    side: direction,
    type: orderType,
    amount: qty,
    limitPrice,
    leverage,
    stopLoss,
    takeProfit,
    submittedAt,
  });

  if (orderType !== "market") {
    // Limit order: reserve margin, store pending; filled later via bracket monitor.
    // Persist NEW ke SQLite + snapshot + audit agar survive restart dan
    // terlihat di FE (orders NEW, ledger kind=order). Margin sudah dipotong
    // di memori SEBELUM persist agar cash konsisten dengan snapshot.
    // SPOT: margin = notional penuh (leverage sudah dipaksa 1x di atas).
    // F1/P0: risk gate matematis pada harga limit (harga eksekusi terencana).
    enforceOrderRiskGate(initialOrder.id, {
      symbol,
      side: direction,
      qty,
      price: limitPrice!,
      stopLoss,
      takeProfit,
      leverage,
    });
    const estimatedNotional = limitPrice! * qty;
    const estimatedMargin = estimatedNotional / leverage;
    if (estimatedMargin > state.cash) {
      throw new PaperOrderError("INSUFFICIENT_CASH", `Estimated margin ${roundTo(estimatedMargin, 2)} melebihi cash paper ${roundTo(state.cash, 2)}.`);
    }
    state.cash = roundTo(state.cash - estimatedMargin, 2);
    state.orders.push(initialOrder);
    dbSaveOrderTolerant(initialOrder);
    persistSnapshotTolerant();
    try {
      appendAudit("order", {
        id: initialOrder.id,
        symbol,
        side: direction,
        amount: qty,
        status: "NEW",
        orderType: "limit",
        limitPrice,
        leverage,
        stopLoss,
        takeProfit,
        reason: "PAPER_LIMIT_NEW",
        timestamp: now,
      });
    } catch (err) {
      console.error("[audit] GAGAL tulis audit limit NEW: ", (err as Error)?.message);
    }
    const limitResult: OpenPaperPositionResult = {
      position: null as unknown as PaperPosition,
      order: initialOrder,
      account: getPaperAccount(),
    };
    rememberClientOrder(clientOrderId, limitResult, Date.now());
    return limitResult;
  }
  const filled = await handleMarketOpenFill(
    input, symbol, side, direction, qty, leverage, stopLoss, takeProfit,
    orderType, initialOrder, positionId, now, submittedAt, signed, isSpot
  );
  rememberClientOrder(clientOrderId, filled, Date.now());
  return filled;
}

async function handleMarketOpenFill(
  input: OpenPaperPositionInput, symbol: string, side: PaperSide, direction: "buy" | "sell",
  qty: number, leverage: number, stopLoss: number, takeProfit: number,
  orderType: "market" | "limit", initialOrder: PaperOrderReceipt,
  positionId: string, now: number, submittedAt: number,
  signed: { signature: string; payloadHash: string },
  isSpot = false
): Promise<OpenPaperPositionResult> {
  const fill = await marketFill(symbol, direction, qty, undefined, "none");
  // Actual paper execution completion, not request time or synthetic latency.
  const filledAt = Date.now();
  const entryPrice = fill.fillPrice;

  if (side === "LONG" && !(stopLoss < entryPrice && entryPrice < takeProfit)) {
    throw new PaperOrderError("INVALID_STOP", "Untuk LONG: stopLoss harus < entryPrice < takeProfit.");
  }
  if (side === "SHORT" && !(takeProfit < entryPrice && entryPrice < stopLoss)) {
    throw new PaperOrderError("INVALID_STOP", "Untuk SHORT: takeProfit harus < entryPrice < stopLoss.");
  }

  // Depth > top-20 didukung penuh → full fill. Depth habis → emit PARTIAL:
  // posisi dibuka HANYA atas filledQty (terukur), sisa unfilledQty TIDAK
  // di-fill. Tanpa allowPartialFill eksplisit → REJECT (fail-closed, bukan
  // fake full fill).
  const filledQty = fill.filledQty > 0 ? fill.filledQty : qty;
  const unfilledQty = fill.unfilledQty > 0 ? fill.unfilledQty : 0;
  const isPartial = unfilledQty > 0;
  if (isPartial && !input.allowPartialFill) {
    appendEvent("ORDER_REJECTED", {
      orderId: initialOrder.id,
      symbol,
      side: direction,
      type: orderType,
      amount: qty,
      filledQty,
      unfilledQty,
      reason: "INSUFFICIENT_DEPTH",
      message: `Orderbook top-20 hanya mendukung ${filledQty}/${qty}. Kirim ulang dengan allowPartialFill=true untuk partial, atau kecilkan qty.`,
    });
    throw new PaperOrderError(
      "INSUFFICIENT_DEPTH",
      `Orderbook top-20 hanya mendukung ${filledQty}/${qty} ${symbol}. Kirim ulang dengan allowPartialFill=true untuk partial, atau kecilkan qty.`
    );
  }

  const notional = entryPrice * filledQty;
  // F1/P0: risk gate matematis — harga eksekusi AKTUAL (VWAP fill) + qty yang
  // benar-benar terisi. Ditolak sebelum state/DB tersentuh.
  enforceOrderRiskGate(initialOrder.id, {
    symbol,
    side: direction,
    qty: filledQty,
    price: entryPrice,
    stopLoss,
    takeProfit,
    leverage,
  });
  const marginUSD = notional / leverage;
  if (marginUSD > state.cash) {
    throw new PaperOrderError("INSUFFICIENT_CASH", `Margin ${roundTo(marginUSD, 2)} melebihi cash paper ${roundTo(state.cash, 2)}.`);
  }

  const feeUSD = roundTo(fill.feeUSD, 4); // market order => taker fee

  // F-08/P1: decision trace — order.meta.decisionId (dari pipeline /
  // /api/ai-decision) disalin ke posisi agar join decision → position →
  // trade utuh untuk training CSV.
  const positionDecisionId = (input.meta as PaperOrderMeta | undefined)?.decisionId;

  const position: PaperPosition = {
    id: positionId,
    symbol,
    side,
    qty: filledQty,
    entryPrice,
    notionalUSD: roundTo(notional, 2),
    leverage: roundTo(leverage, 2),
    marginUSD: roundTo(marginUSD, 2),
    stopLoss,
    takeProfit,
    ...(positionDecisionId ? { decisionId: positionDecisionId } : {}),
    // SPOT: tanpa liquidation (aset beneran, bukan margin) — liq 0 agar
    // bracket monitor skip cek liq untuk posisi ini.
    liquidationPrice: isSpot ? 0 : liquidationPrice(entryPrice, leverage, side),
    maintenanceMarginRate: isSpot ? 0 : MAINTENANCE_MARGIN_RATE,
    openedAt: filledAt,
    status: "OPEN",
    entryReasoning: input.meta?.reasoning,
    confidence: input.meta?.confidence,
    timeframe: input.meta?.timeframe,
    marketType: isSpot ? "SPOT" : (input.meta?.marketType || "FUTURES"),
    targetPool: input.meta?.targetPool,
    entrySource: input.meta?.entrySource || "MANUAL",
    sourceOrderId: initialOrder.id,
    lastMark: entryPrice,
    lastMarkUpdatedAt: now,
    feesPaidUSD: feeUSD,
  };


  const order: PaperOrderReceipt = {
    ...initialOrder,
    fillPrice: entryPrice,
    slippageBps: fill.slippageBps,
    feeUSD,
    qty: filledQty,
    notional: roundTo(notional, 2),
    marginRequired: roundTo(marginUSD, 2),
    executionLatencyMs: filledAt - now,
    timestamp: filledAt,
    status: isPartial ? "PARTIALLY_FILLED" : "FILLED",
    filledAt,
    filledQty,
    remainingQty: unfilledQty,
  };
  // P1: atomic — position + order + snapshot + audit dalam satu transaksi
  // Snapshot state for in-memory rollback if DB transaction fails
  const cashBefore = state.cash;
  const positionsLenBefore = state.positions.length;
  const ordersLenBefore = state.orders.length;

  try {
    beginTx();
    // Mutate in-memory state INSIDE the transaction boundary
    state.positions.push(position);
    state.orders.push(order);
    state.cash = roundTo(state.cash - marginUSD - feeUSD, 2);

    dbSavePosition(position);
    dbSaveOrder(order);
    persistSnapshot();
    appendAudit("order", {
      id: order.id,
      symbol: order.symbol,
      side: order.side,
      amount: order.amount,
      fillPrice: order.fillPrice,
      status: order.status,
      reason: "PAPER_OPEN",
      entrySource: position.entrySource,
      timestamp: Date.now(),
    });
    commitTx();
  } catch (err) {
    // In-memory rollback
    state.cash = cashBefore;
    state.positions.length = positionsLenBefore;
    state.orders.length = ordersLenBefore;
    rollbackTx();
    throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis posisi/order ke DB: ${(err as Error).message}`);
  }

  // Events emitted AFTER successful commit (notification only)
  if (isPartial) {
    appendEvent("ORDER_PARTIAL", {
      orderId: initialOrder.id,
      positionId,
      symbol,
      side: direction,
      type: orderType,
      fillPrice: entryPrice,
      filledQty,
      remainingQty: unfilledQty,
      slippageBps: fill.slippageBps,
      feeUSD,
      latencyMs: filledAt - now,
      method: fill.method,
    });
  }
  appendEvent("ORDER_FILLED", {
    orderId: initialOrder.id,
    positionId,
    symbol,
    side: direction,
    type: orderType,
    fillPrice: entryPrice,
    qty: filledQty,
    remainingQty: unfilledQty,
    slippageBps: fill.slippageBps,
    feeUSD,
    latencyMs: filledAt - now,
    method: fill.method,
  });

  return { position, order, account: getPaperAccount() };
}

export async function closePaperPosition(
  positionId: string,
  reason?: ExitReason,
  closeQty?: number
): Promise<ClosePaperPositionResult> {
  return withPaperMutationLock(() => closePaperPositionLocked(positionId, reason, closeQty));
}

async function closePaperPositionLocked(
  positionId: string,
  reason?: ExitReason,
  closeQtyIn?: number
): Promise<ClosePaperPositionResult> {
  const pos = state.positions.find((p) => p.id === positionId);
  if (!pos) throw new PaperOrderError("POSITION_NOT_FOUND", `Posisi ${positionId} tidak ditemukan.`);
  if (pos.status !== "OPEN") {
    throw new PaperOrderError("POSITION_ALREADY_CLOSED", `Posisi ${positionId} sudah ${pos.status}.`);
  }

  // F3: partial close (qty < pos.qty) — kurangi qty tanpa menutup posisi.
  // Taxing exit tetap lewat marketFill (harga eksekusi aktual, bukan mark).
  const requestedQty = closeQtyIn != null ? Number(closeQtyIn) : pos.qty;
  if (!Number.isFinite(requestedQty) || requestedQty <= 0) {
    throw new PaperOrderError("INVALID_CLOSE_QTY", `closeQty harus angka positif (dapat ${closeQtyIn}).`);
  }
  if (requestedQty < pos.qty - 1e-9) {
    return closePaperPositionPartialLocked(pos, reason || "PARTIAL_TAKE_PROFIT", requestedQty);
  }

  const exitReason: ExitReason = reason || "MANUAL";
  const closingSide = pos.side === "LONG" ? "sell" : "buy";
  let triggerPrice: number | undefined;
  let bracketMode: "none" | "stop" | "profit" = "none";

  // Task 6.2: likuidasi jujur — saat mark menyentuh liquidationPrice, posisi
  // di-close paksa di harga likuidasi dengan PnL terhitung (bukan hardcode).
  let fill: FillResult;
  if (exitReason === "LIQUIDATED") {
    const liqPrice = pos.liquidationPrice > 0 ? pos.liquidationPrice : liquidationPrice(pos.entryPrice, pos.leverage, pos.side);
    const exitFee = roundTo(liqPrice * pos.qty * TAKER_FEE_RATE, 4);
    fill = {
      fillPrice: roundTo(liqPrice, 6),
      slippageBps: 0,
      feeUSD: exitFee,
      method: "LIQUIDATION",
      latencyMs: 0,
      filledQty: pos.qty,
      unfilledQty: 0,
    };
  } else {
    if (exitReason === "STOP_LOSS") {
      triggerPrice = pos.stopLoss;
      bracketMode = "stop";
    } else if (exitReason === "TAKE_PROFIT") {
      triggerPrice = pos.takeProfit;
      bracketMode = "profit";
    }
    fill = await marketFill(pos.symbol, closingSide, pos.qty, triggerPrice, bracketMode);
  }

  // Depth-aware close: book PnL only for qty that actually filled. A partial
  // execution reduces the position by filledQty (with its realized PnL) and
  // leaves the remainder OPEN — never close qty that never filled.
  const filledQty = fill.filledQty != null && fill.filledQty > 0 ? fill.filledQty : pos.qty;
  if (filledQty < pos.qty - 1e-9) {
    return closePaperPositionPartialLocked(pos, exitReason, filledQty);
  }

  const exitPrice = fill.fillPrice;
  const grossPnl = pos.side === "LONG" ? (exitPrice - pos.entryPrice) * pos.qty : (pos.entryPrice - exitPrice) * pos.qty;
  const totalFees = pos.feesPaidUSD + fill.feeUSD;
  let realizedPnl = grossPnl - totalFees;
  let effectiveExitPrice = exitPrice;
  let effectiveExitReason = exitReason;

  if (realizedPnl <= -pos.marginUSD) {
    // Gap parah (SL tersentuh jauh di bawah/atas liq): realitasnya itu
    // likuidasi — catat jujur sebagai LIQUIDATED dengan max loss = margin.
    effectiveExitPrice = pos.liquidationPrice;
    effectiveExitReason = "LIQUIDATED";
    realizedPnl = -pos.marginUSD;
  }

  const now = Date.now();
  const orderId = newId("ord");
  const payload = JSON.stringify({
    symbol: pos.symbol,
    side: closingSide,
    type: "market",
    amount: pos.qty,
    positionId,
    exitReason: effectiveExitReason,
    timestamp: now,
    orderId,
  });
  const signed = signPayload(payload);

  const closeCashDelta = grossPnl - fill.feeUSD;
  const cashRelease = effectiveExitReason === "LIQUIDATED" && realizedPnl === -pos.marginUSD
    ? pos.marginUSD + realizedPnl + pos.feesPaidUSD
    : pos.marginUSD + closeCashDelta;

  const result: ClosePaperPositionResult = {
    position: { ...pos },
    order: {
      id: orderId,
      mode: "paper",
      symbol: pos.symbol,
      side: closingSide,
      type: "market",
      amount: pos.qty,
      fillPrice: roundTo(effectiveExitPrice, 6),
      slippageBps: fill.slippageBps,
      feeUSD: roundTo(fill.feeUSD, 4),
      qty: pos.qty,
      notional: roundTo(effectiveExitPrice * pos.qty, 2),
      leverage: pos.leverage,
      marginRequired: pos.marginUSD,
      executionLatencyMs: fill.latencyMs,
      timestamp: now,
      status: "FILLED",
      positionId: pos.id,
      signature: signed.signature,
      payloadHash: signed.payloadHash,
    },
    realizedPnlUSD: roundTo(realizedPnl, 2),
    cashAfter: roundTo(state.cash + cashRelease, 2),
    exitFillPrice: roundTo(effectiveExitPrice, 6),
    exitSlippageBps: fill.slippageBps,
    exitFeeUSD: roundTo(fill.feeUSD, 4),
    exitReason: effectiveExitReason,
  };

  // F9 (2026-09-17): snapshot in-memory SEBELUM mutasi agar DB gagal bisa
  // di-rollback paritas dengan openPaperPositionLocked (fail-closed konsisten).
  const closeSnap = {
    cash: state.cash,
    realizedPnl: state.realizedPnl,
    ordersLen: state.orders.length,
    status: pos.status,
    closedAt: pos.closedAt,
    exitPrice: pos.exitPrice,
    exitReason: pos.exitReason,
    realizedPnlUSD: pos.realizedPnlUSD,
    feesPaidUSD: pos.feesPaidUSD,
    lastMark: pos.lastMark,
    lastMarkUpdatedAt: pos.lastMarkUpdatedAt,
  };

  state.cash += cashRelease;
  state.cash = roundTo(state.cash, 2);
  state.realizedPnl += realizedPnl;
  state.realizedPnl = roundTo(state.realizedPnl, 2);

  pos.status = "CLOSED";
  pos.closedAt = now;
  pos.exitPrice = roundTo(effectiveExitPrice, 6);
  pos.exitReason = effectiveExitReason;
  // Position total is cumulative; receipt/account increment is this execution only.
  pos.realizedPnlUSD = roundTo((pos.realizedPnlUSD ?? 0) + roundTo(realizedPnl, 2), 2);
  pos.feesPaidUSD = roundTo(totalFees, 4);
  pos.lastMark = effectiveExitPrice;
  pos.lastMarkUpdatedAt = now;

  state.orders.push(result.order);
  appendEvent("POSITION_CLOSED", {
    orderId,
    positionId: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    qty: pos.qty,
    entryPrice: pos.entryPrice,
    exitPrice: roundTo(effectiveExitPrice, 6),
    exitReason: effectiveExitReason,
    realizedPnlUSD: roundTo(realizedPnl, 2),
    feesPaidUSD: roundTo(totalFees, 4),
    slippageBps: fill.slippageBps,
    fillMethod: fill.method,
    cashAfter: result.cashAfter,
  });

  // P1: atomic close — posisi + order + snapshot + audit dalam satu transaksi.
  try {
    beginTx();
    dbSavePosition(pos);
    dbSaveOrder(result.order);
    // also need to update the open position row's status already via dbSavePosition, and ensure fill for exit
    persistSnapshot();
    // F-01: jangan swallow error audit di dalam tx — error apa pun (termasuk
    // appendAudit) → rollbackTx() seluruh transaksi (fail-closed).
    appendAudit("order", {
      id: result.order.id,
      symbol: result.order.symbol,
      side: result.order.side,
      amount: result.order.amount,
      fillPrice: result.order.fillPrice,
      status: result.order.status,
      realizedPnlUSD: roundTo(realizedPnl, 2),
      reason: "PAPER_CLOSE",
      timestamp: Date.now(),
    });
    commitTx();
  } catch (err) {
    // F9: rollback in-memory menyeluruh — memori dan DB harus sama setelah gagal.
    state.cash = closeSnap.cash;
    state.realizedPnl = closeSnap.realizedPnl;
    state.orders.length = closeSnap.ordersLen;
    pos.status = closeSnap.status;
    pos.closedAt = closeSnap.closedAt;
    pos.exitPrice = closeSnap.exitPrice;
    pos.exitReason = closeSnap.exitReason;
    pos.realizedPnlUSD = closeSnap.realizedPnlUSD;
    pos.feesPaidUSD = closeSnap.feesPaidUSD;
    pos.lastMark = closeSnap.lastMark;
    pos.lastMarkUpdatedAt = closeSnap.lastMarkUpdatedAt;
    rollbackTx();
    console.error(`[paperBook] Gagal menulis close ke DB: ${(err as Error).message}`);
    throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis close ke DB: ${(err as Error).message}`);
  }

  result.position = { ...pos };
  return result;
}

// ------------------------------------------------------------------
// F3: Partial close — kurangi qty posisi tanpa menutupnya (posisi OPEN).
// Akuntansi jujur: realized = gross(exit−entry × closeQty) − proporsi fee
// entry − fee exit. Cash += margin yang dilepas + gross − fee exit
// (fee entry sudah dipotong saat open; proporsinya diperhitungkan di
// realized). PnL gap-ke-liq & clamp margin bawaan TIDAK berlaku untuk
// partial (hanya full close yang bisa kena likuidasi).
// ------------------------------------------------------------------
async function closePaperPositionPartialLocked(
  pos: PaperPosition,
  exitReason: ExitReason,
  closeQtyIn: number
): Promise<ClosePaperPositionResult> {
  const closeQty = Math.min(roundTo(closeQtyIn, 8), pos.qty);
  const closingSide = pos.side === "LONG" ? "sell" : "buy";
  const fill = await marketFill(pos.symbol, closingSide, closeQty, undefined, "none");
  const exitPrice = fill.fillPrice;
  const filledQty = fill.filledQty > 0 ? fill.filledQty : closeQty;
  const fraction = Math.min(1, filledQty / pos.qty);

  const grossPnl =
    pos.side === "LONG" ? (exitPrice - pos.entryPrice) * filledQty : (pos.entryPrice - exitPrice) * filledQty;
  const entryFeePortion = roundTo(pos.feesPaidUSD * fraction, 4);
  const realizedPnl = grossPnl - entryFeePortion - fill.feeUSD;
  const marginRelease = roundTo(pos.marginUSD * fraction, 6);

  const now = Date.now();
  const orderId = newId("ord");
  const payload = JSON.stringify({
    symbol: pos.symbol,
    side: closingSide,
    type: "market",
    amount: filledQty,
    positionId: pos.id,
    exitReason,
    partial: true,
    timestamp: now,
    orderId,
  });
  const signed = signPayload(payload);
  const cashDelta = marginRelease + grossPnl - fill.feeUSD;

  const result: ClosePaperPositionResult = {
    position: { ...pos },
    order: {
      id: orderId,
      mode: "paper",
      symbol: pos.symbol,
      side: closingSide,
      type: "market",
      amount: filledQty,
      fillPrice: roundTo(exitPrice, 6),
      slippageBps: fill.slippageBps,
      feeUSD: roundTo(fill.feeUSD, 4),
      qty: filledQty,
      notional: roundTo(exitPrice * filledQty, 2),
      leverage: pos.leverage,
      marginRequired: roundTo(marginRelease, 2),
      executionLatencyMs: fill.latencyMs,
      timestamp: now,
      status: "FILLED",
      positionId: pos.id,
      reason: exitReason,
      signature: signed.signature,
      payloadHash: signed.payloadHash,
      filledQty,
      remainingQty: roundTo(pos.qty - filledQty, 8),
    },
    realizedPnlUSD: roundTo(realizedPnl, 2),
    cashAfter: roundTo(state.cash + cashDelta, 2),
    exitFillPrice: roundTo(exitPrice, 6),
    exitSlippageBps: fill.slippageBps,
    exitFeeUSD: roundTo(fill.feeUSD, 4),
    exitReason,
    partial: true,
    remainingQty: roundTo(pos.qty - filledQty, 8),
  };

  // Snapshot untuk rollback in-memory bila transaksi DB gagal.
  const snap = {
    qty: pos.qty,
    marginUSD: pos.marginUSD,
    notionalUSD: pos.notionalUSD,
    feesPaidUSD: pos.feesPaidUSD,
    realizedPnlUSD: pos.realizedPnlUSD,
    lastMark: pos.lastMark,
    lastMarkUpdatedAt: pos.lastMarkUpdatedAt,
  };

  state.cash = roundTo(state.cash + cashDelta, 2);
  state.realizedPnl = roundTo(state.realizedPnl + realizedPnl, 2);
  pos.qty = roundTo(pos.qty - filledQty, 8);
  pos.marginUSD = roundTo(pos.marginUSD - marginRelease, 6);
  pos.notionalUSD = roundTo(pos.notionalUSD * (1 - fraction), 2);
  pos.feesPaidUSD = roundTo(pos.feesPaidUSD - entryFeePortion, 4);
  pos.realizedPnlUSD = roundTo((pos.realizedPnlUSD ?? 0) + roundTo(realizedPnl, 2), 2);
  pos.lastMark = exitPrice;
  pos.lastMarkUpdatedAt = now;

  appendEvent("POSITION_PARTIAL_CLOSED", {
    orderId,
    positionId: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    closeQty: filledQty,
    remainingQty: pos.qty,
    exitPrice: roundTo(exitPrice, 6),
    exitReason,
    realizedPnlUSD: roundTo(realizedPnl, 2),
    feesUSD: roundTo(entryFeePortion + fill.feeUSD, 4),
    cashAfter: result.cashAfter,
  });

  try {
    beginTx();
    dbSavePosition(pos);
    dbSaveOrder(result.order);
    persistSnapshot();
    appendAudit("order", {
      id: result.order.id,
      symbol: pos.symbol,
      side: closingSide,
      amount: filledQty,
      fillPrice: result.order.fillPrice,
      status: "FILLED",
      realizedPnlUSD: roundTo(realizedPnl, 2),
      reason: "PAPER_PARTIAL_CLOSE",
      timestamp: Date.now(),
    });
    commitTx();
  } catch (err) {
    // Rollback in-memory: posisi tetap OPEN dengan qty lama.
    state.cash = roundTo(state.cash - cashDelta, 2);
    state.realizedPnl = roundTo(state.realizedPnl - realizedPnl, 2);
    pos.qty = snap.qty;
    pos.marginUSD = snap.marginUSD;
    pos.notionalUSD = snap.notionalUSD;
    pos.feesPaidUSD = snap.feesPaidUSD;
    pos.realizedPnlUSD = snap.realizedPnlUSD;
    pos.lastMark = snap.lastMark;
    pos.lastMarkUpdatedAt = snap.lastMarkUpdatedAt;
    rollbackTx();
    throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis partial close ke DB: ${(err as Error).message}`);
  }

  result.position = { ...pos };
  return result;
}
