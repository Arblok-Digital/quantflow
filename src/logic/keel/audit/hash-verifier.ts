/**
 * Audit hash-verifier — Keel `src/services/audit/hash-verifier.ts` light port.
 * Engages kill switch on tamper detection; in-memory store.
 */
import { store } from '../store.js';
import { verifyStoredChain, verifyAuditRows } from './audit-service.js';
import { engageKillSwitch } from '../risk/kill-switch.js';

export interface VerificationSummary {
  checked: number;
  tamperedIds: string[];
  lockedDown: boolean;
}

export async function verifyAuditChain(limit = 10_000): Promise<VerificationSummary> {
  const all = store.auditLogs.slice(-limit);
  const rows = all.map((r) => ({
    id: r.id,
    actorId: r.actorId,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    diff: r.diff,
    hash: r.hash,
    createdAt: r.createdAt,
  }));
  const tamperedIds = verifyAuditRows(rows);

  if (tamperedIds.length > 0) {
    await engageKillSwitch({
      actorId: '00000000-0000-0000-0000-00000000a001',
      reason: `AUDIT_HASH_CHAIN_TAMPER detected on ${tamperedIds.length} rows`,
    });
    return { checked: rows.length, tamperedIds, lockedDown: true };
  }
  return { checked: rows.length, tamperedIds, lockedDown: false };
}

export function decisionsAuditTrail(decisionId: string): Array<{ id: string; actorId: string; action: string; entity: string; entityId: string; diff: Record<string, unknown> | null; createdAt: number; hash: string }> {
  return store.auditLogs.filter((a) => a.entityId === decisionId);
}

export async function verifyStoredAuditChain(): Promise<VerificationSummary> {
  const tamperedIds = verifyStoredChain();
  if (tamperedIds.length > 0) {
    await engageKillSwitch({
      actorId: '00000000-0000-0000-0000-00000000a001',
      reason: `AUDIT_HASH_CHAIN_TAMPER detected on ${tamperedIds.length} rows`,
    });
  }
  return { checked: store.auditLogs.length, tamperedIds, lockedDown: tamperedIds.length > 0 };
}