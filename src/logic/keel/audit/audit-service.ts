/**
 * Audit service — Keel `src/services/audit/audit-service.ts` light port.
 * Hash-chained audit records over the in-memory store. The PG advisory lock
 * serialization is naturally single-threaded in-memory (no concurrent writers).
 */
import { createHash } from 'node:crypto';
import { store, nextId, type QueryTx } from '../store.js';
import { timeService } from '../time-sync.js';

export interface AuditRecordParams {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  diff?: Record<string, unknown> | null;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export function computeAuditHash(input: {
  prevHash: string | null;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  diff: Record<string, unknown> | null;
  createdAtIso: string;
}): string {
  const payload = [
    input.prevHash ?? 'GENESIS',
    input.actorId,
    input.action,
    input.entity,
    input.entityId,
    canonicalJson(input.diff),
    input.createdAtIso,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

function getLastHash(): string | null {
  const last = store.auditLogs.at(-1);
  return last?.hash ?? null;
}

export async function audit(params: AuditRecordParams, _tx?: QueryTx): Promise<void> {
  const prevHash = getLastHash();
  const now = timeService.now();
  store.auditLogs.push({
    id: nextId(),
    prevHash,
    actorId: params.actorId,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    diff: params.diff ?? null,
    createdAt: now,
    hash: computeAuditHash({
      prevHash,
      actorId: params.actorId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId,
      diff: params.diff ?? null,
      createdAtIso: new Date(now).toISOString(),
    }),
  });
}

export interface ChainRow {
  id: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  diff: unknown;
  hash: string;
  createdAt: number;
}

export function verifyAuditRows(rows: ChainRow[]): string[] {
  const tampered: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const prevRow = rows[i + 1] ?? null;
    const expected = computeAuditHash({
      prevHash: prevRow?.hash ?? null,
      actorId: row.actorId,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId,
      diff: (row.diff ?? null) as Record<string, unknown> | null,
      createdAtIso: new Date(row.createdAt).toISOString(),
    });
    if (expected !== row.hash) tampered.push(row.id);
  }
  return tampered;
}

export function verifyStoredChain(): string[] {
  const rows: ChainRow[] = store.auditLogs.map((r) => ({
    id: r.id,
    actorId: r.actorId,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    diff: r.diff,
    hash: r.hash,
    createdAt: r.createdAt,
  }));
  return verifyAuditRows(rows);
}