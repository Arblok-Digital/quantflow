/**
 * src/broker/liveBroker.ts
 * LIVE MODE broker handler — eksekusi ke exchange asli (via ccxt), guarded + double-lock.
 * Behavior-preserving move dari server.ts /api/broker/order (branch live).
 */
import type { Request, Response } from "express";
import { placeBrokerOrder, getBrokerStatus, getExchange, ensureMarketsLoaded } from "../../broker";
import { evaluateGuardrails, GuardrailRejectedError, recordOrderPlaced } from "../../guardrails";
import { guardReject } from "./routerUtils";

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
    return guardReject(res, primary, `Order ditolak guardrail: ${primary} (${guardLive.reasons.join(", ")})`);
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
 * Request body: { symbol: "BTC/USDT", side: "buy"|"sell", amount: 0.001 }
 *   - side = posisi yang mau ditutup (misal "buy" = long position → close sell)
 *   - amount = jumlah asset yang mau ditutup
 */
export async function handleLiveClose(req: Request, res: Response): Promise<Response> {
  const body = req.body || {};
  const symbol = String(body.symbol || "").trim();
  const side = String(body.side || "").toLowerCase(); // "buy" or "sell" = position side to close
  const amount = Number(body.amount);

  if (!symbol || (side !== "buy" && side !== "sell") || !isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      status: "REJECTED",
      reason: "MISSING_PARAMS",
      message: "symbol, side (buy|sell), and amount wajib diisi untuk live close.",
    });
  }

  // Close position = market order in the OPPOSITE direction with reduceOnly
  const closeSide: "buy" | "sell" = side === "buy" ? "sell" : "buy";
  const normalizedSymbol = symbol.includes("/") ? symbol : `${symbol.replace("USDT", "")}/USDT`;

  try {
    const exchange = getExchange();
    await ensureMarketsLoaded(exchange);
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