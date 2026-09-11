import type { Express } from "express";
import { requireAuth } from "@/auth";
import { appendAudit, getLedgerEntries, verifyLedger, getLedgerStats } from "@/db";

export function registerLedgerRoutes(app: Express): void {
  app.get("/api/ledger", requireAuth, (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const cursorRaw = req.query.cursor != null ? String(req.query.cursor) : undefined;
    const cursor = cursorRaw ? parseInt(cursorRaw, 10) : undefined;
    const { entries, nextCursor } = getLedgerEntries({ limit, cursor: cursor && isFinite(cursor) ? cursor : undefined });
    const mapped = entries.map((e) => ({
      seq: e.seq,
      kind: e.kind,
      payload: e.payload,
      createdAt: e.createdAt,
      prevHash: e.prevHash,
      hash: e.hash,
    }));
    res.json({ success: true, entries: mapped, nextCursor });
  });

  app.get("/api/ledger/verify", requireAuth, (_req, res) => {
    const result = verifyLedger();
    res.json({ success: true, ...result, clientLedgerNote: "Server ledger (HMAC) is authoritative; client SHA-256 ledger is display-only." });
  });

  app.get("/api/ledger/stats", requireAuth, (_req, res) => {
    const stats = getLedgerStats();
    res.json({ success: true, ...stats });
  });
}
