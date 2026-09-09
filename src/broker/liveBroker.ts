/**
 * src/broker/liveBroker.ts
 * LIVE MODE broker handler — eksekusi ke exchange asli (via ccxt), guarded + double-lock.
 * Behavior-preserving move dari server.ts /api/broker/order (branch live).
 */
import type { Request, Response } from "express";
import { placeBrokerOrder, getBrokerStatus } from "../../broker";
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
 * Close di LIVE MODE — belum diimplementasikan (roadmap Phase 2+).
 * Behavior persis server.ts /api/broker/close.
 */
export async function handleLiveClose(_req: Request, res: Response): Promise<Response> {
  return res.status(400).json({ success: false, message: "Live close via /api/broker/close belum diimplementasikan (roadmap Phase 2+)." });
}

export { getBrokerStatus } from "../../broker";