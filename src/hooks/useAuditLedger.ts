import { useCallback, useMemo, useState } from "react";
import { AuditLogEntry } from "../types";

export const GENESIS_ROOT_HASH = "GENESIS_ROOT_HASH_000000000000";

/**
 * Single owner dari audit ledger hash-chain client-side.
 * Semua entri (dari pipeline cycle, exit TP/CL, dan simulasi paper) masuk lewat
 * {@link prependAudit}. `latestBlockHash` jadi tail untuk chaining SHA-256
 * ketika entri baru dibuat oleh pipeline kriptografis.
 */
export function useAuditLedger() {
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);

  const prependAudit = useCallback((entry: AuditLogEntry) => {
    setAuditLogs((prev) => [entry, ...prev.slice(0, 99)]);
  }, []);

  const avgSlippage = useMemo(() => {
    if (auditLogs.length === 0) return 1.2;
    return auditLogs.reduce((sum, log) => sum + (log.slippageBps || 0), 0) / auditLogs.length;
  }, [auditLogs]);

  const latestBlockHash = auditLogs.length > 0 ? auditLogs[0].blockHash : GENESIS_ROOT_HASH;

  return { auditLogs, prependAudit, avgSlippage, latestBlockHash, entryCount: auditLogs.length };
}

export type AuditLedgerController = ReturnType<typeof useAuditLedger>;