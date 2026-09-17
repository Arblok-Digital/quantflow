/**
 * src/broker/liveBroker.ts
 * LIVE MODE broker handler — eksekusi ke exchange asli (via ccxt), guarded + double-lock.
 * Behavior-preserving move dari server.ts /api/broker/order (branch live).
 */
import type { Request, Response } from "express";
import {
  placeBrokerOrder,
  getBrokerStatus,
  getExchange,
  ensureMarketsLoaded,
  fetchCcxtTicker,
  fetchBrokerBalance,
} from "../../broker";
import { evaluateGuardrails, GuardrailRejectedError, recordOrderPlaced } from "../../guardrails";
import { guardReject } from "./routerUtils";
import {
  evaluateOrderRisk,
  describeOrderRiskRejection,
  isOrderRiskGateEnabled,
  defaultOrderRiskPolicy,
  type OrderRiskEvaluation,
} from "../logic/orderRiskGate";

/**
 * F1/P0 — risk gate matematis untuk jalur LIVE.
 * Live TIDAK boleh lebih longgar dari paper: bracket sanity, lantai jarak SL,
 * dan R:R minimum selalu diperiksa; cap berbasis equity ikut diperiksa dan
 * WAJIB tersedia (requireEquity: true → fail-closed bila saldo tak terbaca).
 * Harga acuan: limitPrice (limit) atau ticker live (market); bila harga tidak
 * bisa diambil → order DITOLAK (bracket tak bisa diverifikasi).
 */
async function evaluateLiveRiskGate(body: any): Promise<OrderRiskEvaluation | null> {
  if (!isOrderRiskGateEnabled()) return null;
  const symbol = String(body.symbol || "BTC/USDT");
  const side: "buy" | "sell" = String(body.side || "buy").toLowerCase() === "sell" ? "sell" : "buy";
  const qty = Number(body.amount);
  const isLimit = String(body.type || "market").toLowerCase() === "limit";
  const limitPrice = Number(body.limitPrice);

  let price = isLimit && Number.isFinite(limitPrice) && limitPrice > 0 ? limitPrice : NaN;
  if (!Number.isFinite(price)) {
    try {
      const ticker = await fetchCcxtTicker(symbol);
      price = Number(ticker?.last ?? ticker?.bid ?? ticker?.ask ?? NaN);
    } catch {
      price = NaN;
    }
  }
  if (!Number.isFinite(price) || price <= 0) {
    return {
      approved: false,
      reasons: ["RISK_PRICE_UNAVAILABLE:harga live tidak bisa diambil — bracket & sizing tidak bisa diverifikasi"],
      metrics: null,
      capsSkipped: true,
    };
  }

  let equity: number | undefined;
  try {
    const balances = await fetchBrokerBalance();
    const usdt = balances.find((b) => b.currency === "USDT") ?? balances[0];
    equity = usdt ? Number(usdt.total) : undefined;
  } catch {
    equity = undefined;
  }

  return evaluateOrderRisk(
    {
      symbol,
      side,
      qty,
      price,
      stopLoss: Number(body.stopLoss),
      takeProfit: Number(body.takeProfit),
      leverage: Number(body.leverage),
      equity,
    },
    { ...defaultOrderRiskPolicy(), requireEquity: true },
  );
}

/**
 * Handle order masuk di LIVE MODE — pass-through guarded + double-lock.
 * Behavior persis seperti server.ts sebelumnya.
 */
export async function handleLiveOrder(req: Request, res: Response): Promise<Response> {
  const body = req.body || {};

  // ---------- LIVE MODE (pass-through, guarded + double-lock) ----------
  // Guardrails must also apply to live opens
  const guardLive = await evaluateGuardrails({ symbol: String(body.symbol || "BTC/USDT") });
  if (!guardLive.allowed) {
    const primary = guardLive.reasons[0] as string;
    return guardReject(res, primary, `Order ditolak guardrail: ${primary} (${guardLive.reasons.join(", ")})`, {
      dailyLossPercent: guardLive.details.dailyLossPercent,
      maxDailyLossPercent: guardLive.details.maxDailyLossPercent,
      realizedPnlUSD: guardLive.details.realizedPnlUSD,
      openCount: guardLive.details.openCount,
      maxOpenPositions: guardLive.details.maxOpenPositions,
      cooldownRemainingMs: guardLive.details.cooldownRemainingMs,
      killSwitch: guardLive.details.killSwitch,
      guardsEnabled: (guardLive.details as any).guardsEnabled ?? true,
      reasons: guardLive.reasons,
    });
  }
  // F1/P0: pre-trade risk gate matematis (bracket sanity, lantai SL, R:R, cap
  // equity) — live tidak boleh lebih longgar dari paper.
  const liveRisk = await evaluateLiveRiskGate(body);
  if (liveRisk && !liveRisk.approved) {
    console.warn(`[live] risk gate menolak order ${body.symbol}: ${liveRisk.reasons.join("; ")}`);
    return guardReject(res, liveRisk.reasons[0] as string, describeOrderRiskRejection(liveRisk), {
      riskGate: {
        approved: liveRisk.approved,
        reasons: liveRisk.reasons,
        metrics: liveRisk.metrics,
        capsSkipped: liveRisk.capsSkipped,
      },
    });
  }

  // Double-lock: liveArmed check is inside placeBrokerOrder via assertLiveAllowed, but we surface clearly
  try {
    const result = await placeBrokerOrder(body);
    recordOrderPlaced();
    return res.json({ success: true, ...result });
  } catch (err: any) {
    const code = err?.code;
    if (code === "LIVE_NOT_ARMED") {
      return guardReject(res, "LIVE_NOT_ARMED", err.message);
    }
    if (err instanceof GuardrailRejectedError) {
      return guardReject(res, err.reason, err.message);
    }
    // Map other errors to REJECTED shape if they look like guard
    if (String(err?.message).includes("ARM_REQUIRES_LIVE_AND_CREDENTIALS")) {
      return res.status(400).json({ success: false, status: "REJECTED", reason: "ARM_REQUIRES_LIVE_AND_CREDENTIALS", message: err.message });
    }
    return res.status(400).json({ success: false, status: "REJECTED", reason: "ORDER_FAILED", message: err?.message || "Order gagal." });
  }
}

/**
 * Close di LIVE MODE — kirim reduceOnly market order lawan arah via ccxt.
 * Request body (dipakai FE): { positionId: "SYMBOL-SIDE-ts", symbol?, side?, amount? }
 *   - Bentuk utama { positionId } — encode dari id posisi live
 *     `${symbol}-${side}-${ts}` (dibuat di routes/broker.ts GET positions).
 *     side di id bisa LONG/SHORT/buy/sell (case-insensitive).
 *   - Bentuk legacy eksplisit { symbol, side: buy|sell, amount } tetap
 *     didukung untuk kompatibilitas.
 * Lookup ke exchange (fetchPositions) dipakai untuk amount aktual +
 * validasi posisi masih open sebelum reduceOnly close dikirim.
 */
export async function handleLiveClose(req: Request, res: Response): Promise<Response> {
  const body = req.body || {};
  // 1) Bentuk utama dari FE: { positionId: "SYMBOL-SIDE-ts" }
  const positionId = String(body.positionId || "").trim();
  let symbol = String(body.symbol || "").trim();
  let side = String(body.side || "").toLowerCase(); // "buy" or "sell" = position side to close
  let amount = Number(body.amount);

  if (positionId) {
    const m = /^(.*)-((?:LONG|SHORT|long|short|buy|sell))-\d+$/.exec(positionId);
    if (!m) {
      return res.status(400).json({
        success: false,
        status: "REJECTED",
        reason: "INVALID_POSITION_ID",
        message: "positionId live tidak valid.",
      });
    }
    if (!symbol) symbol = m[1];
    if (!side) {
      const raw = m[2].toLowerCase();
      side = raw === "long" || raw === "buy" ? "buy" : "sell";
    }
  }

  if (!symbol || (side !== "buy" && side !== "sell")) {
    return res.status(400).json({
      success: false,
      status: "REJECTED",
      reason: "MISSING_PARAMS",
      message: "positionId (atau symbol + side buy|sell) wajib diisi untuk live close.",
    });
  }

  // Close position = market order in the OPPOSITE direction with reduceOnly
  const closeSide: "buy" | "sell" = side === "buy" ? "sell" : "buy";
  const normalizedSymbol = symbol.includes("/") ? symbol : `${symbol.replace("USDT", "")}/USDT`;

  try {
    const exchange = getExchange();
    await ensureMarketsLoaded(exchange);
    // Resolve amount aktual dari posisi open di exchange bila tidak disebut
    // eksplisit — FE hanya mengirim positionId.
    if (!isFinite(amount) || amount <= 0) {
      try {
        const rawPositions: any[] = await exchange.fetchPositions();
        const match = rawPositions.find(
          (p: any) =>
            String(p.symbol) === normalizedSymbol && Number(p.contracts || p.amount || 0) !== 0
        );
        const resolved = Number(match?.contracts ?? match?.amount ?? 0);
        if (isFinite(resolved) && resolved > 0) {
          amount = resolved;
        }
      } catch (lookupErr: any) {
        console.warn(`[live] fetchPositions lookup gagal (close ${normalizedSymbol}): ${lookupErr?.message}`);
      }
    }
    if (!isFinite(amount) || amount <= 0) {
      return res.status(404).json({
        success: false,
        status: "REJECTED",
        reason: "POSITION_NOT_FOUND",
        message: `Posisi ${normalizedSymbol} tidak ditemukan / amount tidak diketahui di exchange.`,
      });
    }
    const order = await exchange.createOrder(
      normalizedSymbol,
      "market",
      closeSide,
      amount,
      undefined, // market order — no price
      { reduceOnly: true },
    );
    return res.json({
      success: true,
      mode: "live",
      closed: true,
      order: {
        id: order.id,
        status: order.status,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        amount: order.amount,
        price: order.average || order.price,
        cost: order.cost,
        fee: order.fee,
        timestamp: order.timestamp || Date.now(),
      },
    });
  } catch (err: any) {
    return res.status(400).json({
      success: false,
      status: "REJECTED",
      reason: "CLOSE_FAILED",
      message: err?.message || "Gagal menutup posisi live.",
    });
  }
}

export { getBrokerStatus } from "../../broker";