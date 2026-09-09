/**
 * src/broker/routerUtils.ts
 * Shared helpers untuk broker router — dipakai paperBroker & liveBroker.
 * Behavior-preserving move dari server.ts (guardReject).
 */
import type { Response } from "express";

/** Helper to map GuardrailRejectedError to 403 REJECTED JSON (dipindah dari server.ts). */
export function guardReject(res: Response, reason: string, message?: string) {
  return res.status(403).json({
    success: false,
    status: "REJECTED",
    reason,
    message: message || `Order ditolak guardrail: ${reason}`,
  });
}