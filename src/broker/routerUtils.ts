/**
 * src/broker/routerUtils.ts
 * Shared helpers untuk broker router — dipakai paperBroker & liveBroker.
 * Behavior-preserving move dari server.ts (guardReject).
 */
import type { Response } from "express";

/** Helper to map GuardrailRejectedError to 403 REJECTED JSON (dipindah dari server.ts).
 * details opsional: snapshot guard (dailyLoss%, maxDailyLoss, realized hari ini,
 * baseline, openCount, cooldown) agar FE bisa tampilkan PENYEBAB jelas, bukan
 * sekadar kode reason. */
export function guardReject(res: Response, reason: string, message?: string, details?: Record<string, unknown>) {
  return res.status(403).json({
    success: false,
    status: "REJECTED",
    reason,
    message: message || `Order ditolak guardrail: ${reason}`,
    ...(details ? { guard: details } : {}),
  });
}