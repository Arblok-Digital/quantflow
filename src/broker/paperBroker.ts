/**
 * src/broker/paperBroker.ts
 * PAPER MODE broker handler — lifecycle SINKRON (instan, deterministik) simulasi paper.
 * Behavior-preserving move dari server.ts /api/broker/order + /api/broker/close.
 */
import type { Request, Response } from "express";
import {
  openPaperPosition,
  closePaperPosition,
  PaperOrderError,
} from "../../paperBook";
import { evaluateGuardrails, recordOrderPlaced } from "../../guardrails";
import { appendAudit } from "../../db";
import { getBrokerStatus } from "../../broker";
import { guardReject } from "./routerUtils";

/**
 * Handle order masuk di PAPER MODE.
 * - Closing order: { closePositionId } — closing de-risks, no guardrail.
 * - Opening order: guardrails dulu baru open.
 * Behavior persis seperti server.ts sebelumnya.
 */
export async function handlePaperOrder(req: Request, res: Response): Promise<Response> {
  const body = req.body || {};

  // ---------- PAPER MODE ----------
  if (getBrokerStatus().mode !== "live") {
    // Closing order: { closePositionId } — closing de-risks, no guardrail
    if (body.closePositionId) {
      try {
        const result = await closePaperPosition(String(body.closePositionId), "MANUAL");
        try {
          appendAudit("exit", {
            positionId: result.position.id,
            symbol: result.position.symbol,
            side: result.position.side,
            exitReason: "MANUAL",
            exitPrice: result.exitFillPrice,
            realizedPnlUSD: result.realizedPnlUSD,
            orderId: result.order.id,
          });
        } catch (err) {
          // P3: audit failure TIDAK boleh silent — log selalu biar operator tau.
          console.error("[audit] GAGAL tulis audit close: ", (err as Error)?.message);
        }
        return res.json({ success: true, mode: "paper", closed: true, ...result });
      } catch (err: any) {
        if (err instanceof PaperOrderError) {
          return res.status(400).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
        }
        return res.status(400).json({ success: false, status: "REJECTED", reason: "CLOSE_FAILED", message: err?.message || "Gagal menutup posisi." });
      }
    }

    // Opening order — evaluate guardrails before placement
    // Only guard OPENs, not closes
    const guard = await evaluateGuardrails({ symbol: String(body.symbol || "BTC/USDT") });
    if (!guard.allowed) {
      const primary = guard.reasons[0] as string;
      return guardReject(res, primary, `Order ditolak guardrail: ${primary} (${guard.reasons.join(", ")})`);
    }

    // Opening order
    try {
      // decisionId: datang dari meta pipeline (saveAgentDecisionDb di
      // /api/ai-decision) ATAU top-level body (panel manual). Disimpan di
      // order.meta.decisionId → receipt → posisi → audit → training join.
      const meta = body.meta && typeof body.meta === "object" ? { ...body.meta } : {};
      if (!meta.decisionId && body.decisionId) meta.decisionId = String(body.decisionId);
      const result = await openPaperPosition({
        symbol: body.symbol,
        side: String(body.side || "buy").toLowerCase() === "sell" ? "sell" : "buy",
        qty: Number(body.amount),
        leverage: body.leverage,
        stopLoss: body.stopLoss,
        takeProfit: body.takeProfit,
        orderType: String(body.type || "market").toLowerCase() === "limit" ? "limit" : "market",
        limitPrice: body.limitPrice ? Number(body.limitPrice) : undefined,
        allowPartialFill: body.allowPartialFill === true,
        meta,
      });
      recordOrderPlaced();
      try {
        appendAudit("order", {
          orderId: result.order.id,
          positionId: result.position?.id,
          symbol: result.position?.symbol || String(body.symbol || "BTC/USDT"),
          side: result.order.side,
          amount: result.order.amount,
          fillPrice: result.order.fillPrice,
          leverage: result.order.leverage,
          stopLoss: body.stopLoss,
          takeProfit: body.takeProfit,
          orderType: result.order.type,
          status: result.order.status,
          filledQty: result.order.filledQty,
          remainingQty: result.order.remainingQty,
          decisionId: (result.order.meta as any)?.decisionId ?? meta.decisionId ?? null,
        });
      } catch (err) {
        console.error("[audit] GAGAL tulis audit order: ", (err as Error)?.message);
      }
      const { position, order } = result;
      return res.json({
        success: true,
        mode: "paper",
        order: {
          id: order.id,
          status: order.status,
          fillPrice: order.fillPrice,
          slippageBps: order.slippageBps,
          feeUSD: order.feeUSD,
          qty: order.qty,
          filledQty: order.filledQty,
          remainingQty: order.remainingQty,
          notional: order.notional,
          leverage: order.leverage,
          marginRequired: order.marginRequired,
          executionLatencyMs: order.executionLatencyMs,
          timestamp: order.timestamp,
          signature: order.signature,
          payloadHash: order.payloadHash,
          decisionId: (order.meta as any)?.decisionId ?? meta.decisionId ?? null,
        },
        position,
      });
    } catch (err: any) {
      if (err instanceof PaperOrderError) {
        return res.status(400).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
      }
      return res.status(400).json({ success: false, status: "REJECTED", reason: "ORDER_FAILED", message: err?.message || "Order paper gagal." });
    }
  }

  // NOT paper (shouldn't reach here — live router handles live)
  return res.status(400).json({ success: false, message: "Bukan mode paper." });
}

/**
 * Handle close di PAPER MODE — dipindah dari server.ts /api/broker/close.
 */
export async function handlePaperClose(req: Request, res: Response): Promise<Response> {
  try {
    const positionId = String((req.body || {}).positionId || "");
    if (!positionId) {
      return res.status(400).json({ success: false, status: "REJECTED", reason: "MISSING_POSITION_ID", message: "positionId wajib diisi." });
    }
    const result = await closePaperPosition(positionId, "MANUAL");
    try {
      appendAudit("exit", {
        positionId: result.position.id,
        symbol: result.position.symbol,
        side: result.position.side,
        exitReason: "MANUAL",
        exitPrice: result.exitFillPrice,
        realizedPnlUSD: result.realizedPnlUSD,
        orderId: result.order.id,
      });
    } catch (err) {
      console.error("[audit] GAGAL tulis audit close (manual): ", (err as Error)?.message);
    }
    return res.json({ success: true, mode: "paper", closed: true, ...result });
  } catch (err: any) {
    if (err instanceof PaperOrderError) {
      const status = err.code === "POSITION_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ success: false, status: "REJECTED", reason: err.code, message: err.message });
    }
    return res.status(400).json({ success: false, message: err?.message || "Close gagal." });
  }
}

/** Re-export status helper biar router gak perlu import paperBook langsung. */
export { getBrokerStatus } from "../../broker";