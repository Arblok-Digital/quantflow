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
  persistSnapshot,
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

export function liquidationPrice(entryPrice: number, leverage: number, side: PaperSide): number {
  const lev = leverage > 0 ? leverage : 1;
  if (side === "LONG") {
    return roundTo(entryPrice * (1 - 1 / lev + MAINTENANCE_MARGIN_RATE), 6);
  }
  return roundTo(entryPrice * (1 + 1 / lev - MAINTENANCE_MARGIN_RATE), 6);
}

// ------------------------------------------------------------------
// Open / close
// ------------------------------------------------------------------

export async function openPaperPosition(input: OpenPaperPositionInput): Promise<OpenPaperPositionResult> {
  const qty = Number(input.qty);
  if (!isFinite(qty) || qty <= 0) {
    throw new PaperOrderError("INVALID_QTY", "qty harus angka positif.");
  }
  const side: PaperSide = input.side === "sell" ? "SHORT" : "LONG";
  const direction = input.side === "sell" ? "sell" : "buy";
  const leverage = input.leverage && input.leverage > 0 ? Math.min(MAX_LEVERAGE, Number(input.leverage)) : 1;
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
    // Limit order: reserve margin, store pending; filled later via bracket monitor
    const estimatedNotional = limitPrice! * qty;
    const estimatedMargin = estimatedNotional / leverage;
    if (estimatedMargin > state.cash) {
      throw new PaperOrderError("INSUFFICIENT_CASH", `Estimated margin ${roundTo(estimatedMargin, 2)} melebihi cash paper ${roundTo(state.cash, 2)}.`);
    }
    state.cash = roundTo(state.cash - estimatedMargin, 2);
    state.orders.push(initialOrder);
    return { position: null as any, order: initialOrder, account: getPaperAccount() };
  }
  return handleMarketOpenFill(
    input, symbol, side, direction, qty, leverage, stopLoss, takeProfit,
    orderType, initialOrder, positionId, now, submittedAt, signed
  );
}

async function handleMarketOpenFill(
  input: OpenPaperPositionInput, symbol: string, side: PaperSide, direction: "buy" | "sell",
  qty: number, leverage: number, stopLoss: number, takeProfit: number,
  orderType: "market" | "limit", initialOrder: PaperOrderReceipt,
  positionId: string, now: number, submittedAt: number,
  signed: { signature: string; payloadHash: string }
): Promise<OpenPaperPositionResult> {
  const fill = await marketFill(symbol, direction, qty, undefined, "none");
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
  const marginUSD = notional / leverage;
  if (marginUSD > state.cash) {
    throw new PaperOrderError("INSUFFICIENT_CASH", `Margin ${roundTo(marginUSD, 2)} melebihi cash paper ${roundTo(state.cash, 2)}.`);
  }

  const feeUSD = roundTo(fill.feeUSD, 4); // market order => taker fee

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
    liquidationPrice: liquidationPrice(entryPrice, leverage, side),
    maintenanceMarginRate: MAINTENANCE_MARGIN_RATE,
    openedAt: now,
    status: "OPEN",
    entryReasoning: input.meta?.reasoning,
    confidence: input.meta?.confidence,
    timeframe: input.meta?.timeframe,
    marketType: input.meta?.marketType,
    targetPool: input.meta?.targetPool,
    sourceOrderId: initialOrder.id,
    lastMark: entryPrice,
    lastMarkUpdatedAt: now,
    feesPaidUSD: feeUSD,
  };

  const filledAt = submittedAt + Math.floor(Math.random() * 10) + 1; // 1-10ms additional fill time

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
  state.positions.push(position);
  state.orders.push(order);
  state.cash = roundTo(state.cash - marginUSD - feeUSD, 2);

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

  // P1: atomic — position + order + snapshot + audit dalam satu transaksi
  try {
    beginTx();
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
      timestamp: Date.now(),
    });
    commitTx();
  } catch (err) {
    rollbackTx();
    throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis posisi/order ke DB: ${(err as Error).message}`);
  }

  return { position, order, account: getPaperAccount() };
}

export async function closePaperPosition(positionId: string, reason?: ExitReason): Promise<ClosePaperPositionResult> {
  const pos = state.positions.find((p) => p.id === positionId);
  if (!pos) throw new PaperOrderError("POSITION_NOT_FOUND", `Posisi ${positionId} tidak ditemukan.`);
  if (pos.status !== "OPEN") {
    throw new PaperOrderError("POSITION_ALREADY_CLOSED", `Posisi ${positionId} sudah ${pos.status}.`);
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
    cashAfter: roundTo(state.cash + pos.marginUSD + realizedPnl, 2),
    exitFillPrice: roundTo(effectiveExitPrice, 6),
    exitSlippageBps: fill.slippageBps,
    exitFeeUSD: roundTo(fill.feeUSD, 4),
    exitReason: effectiveExitReason,
  };

  state.cash += pos.marginUSD + realizedPnl;
  state.cash = roundTo(state.cash, 2);
  state.realizedPnl += realizedPnl;
  state.realizedPnl = roundTo(state.realizedPnl, 2);

  pos.status = "CLOSED";
  pos.closedAt = now;
  pos.exitPrice = roundTo(effectiveExitPrice, 6);
  pos.exitReason = effectiveExitReason;
  pos.realizedPnlUSD = roundTo(realizedPnl, 2);
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
    rollbackTx();
    console.error(`[paperBook] Gagal menulis close ke DB: ${(err as Error).message}`);
    throw new PaperOrderError("DB_TX_FAILED", `Gagal menulis close ke DB: ${(err as Error).message}`);
  }

  result.position = { ...pos };
  return result;
}
