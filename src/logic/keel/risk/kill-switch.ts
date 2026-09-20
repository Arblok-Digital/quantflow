/**
 * Kill switch — Keel `src/services/risk/kill-switch.ts` port.
 * Persisted state: latest event rows disimpan ke `.keel-kill-switch.json` (cwd,
 * serupa pola `.guardrails.json` di guardrails.ts) supaya latch AKTIF bertahan
 * melewati restart — auditor: sebelumnya state hanya di memory (in-memory store)
 * dan `volatileLatch`, hilang saat proses mati. Matikan persist dengan
 * env KILL_SWITCH_PERSIST=false|0|off|no.
 * Telegram / Redis / agent-events replaced with the keel in-memory agentEvents bus.
 */
import path from 'node:path';
import fs from 'node:fs';
import { store, lastKillSwitchEvent, nextId, type QueryTx } from '../store.js';
import { agentEvents } from '../ingestion/feed-manager.js';
import { timeService } from '../time-sync.js';

let volatileLatch = false;
let persistedLoaded = false;

function persistenceEnabled(): boolean {
  const raw = String(process.env.KILL_SWITCH_PERSIST ?? '').trim().toLowerCase();
  if (raw === '') return true;
  return !(raw === 'false' || raw === '0' || raw === 'no' || raw === 'off');
}

function stateFile(): string {
  return path.join(process.cwd(), '.keel-kill-switch.json');
}

/**
 * Load event rows dari file state; aman dipanggil berulang. Tidak menimpa
 * event yang SUDAH ada di memory (langsung di-scan, bukan di-skip).
 */
export function loadKillSwitchEventsFromDisk(): void {
  if (!persistenceEnabled()) return;
  try {
    if (!fs.existsSync(stateFile())) {
      persistedLoaded = true;
      return;
    }
    const raw: unknown = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (Array.isArray(raw)) {
      const rows = raw.filter(
        (r): r is { id: string; triggeredBy: string; reason: string; isActive: boolean; createdAt: number } =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as any).id === 'string' &&
          typeof (r as any).isActive === 'boolean',
      );
      if (rows.length > 0) store.killSwitchEvents = rows;
    }
  } catch (err) {
    console.warn('[kill-switch] gagal memuat state persisten:', err instanceof Error ? err.message : err);
  }
  persistedLoaded = true;
}

function ensureLoaded(): void {
  if (!persistedLoaded) loadKillSwitchEventsFromDisk();
}

function persistLatest(): void {
  if (!persistenceEnabled()) return;
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(store.killSwitchEvents.slice(-100), null, 2), 'utf8');
  } catch (err) {
    console.warn('[kill-switch] gagal menyimpan state:', err instanceof Error ? err.message : err);
  }
}

export async function isKillSwitchActiveTx(_tx?: QueryTx): Promise<boolean> {
  ensureLoaded();
  if (volatileLatch) return true;
  const latest = lastKillSwitchEvent();
  return latest?.isActive ?? false;
}

export interface EngageResult {
  eventId: string;
  cancelledOrdersCount: number;
}

export async function engageKillSwitch(params: {
  actorId: string;
  reason: string;
  cancelFn?: () => Promise<number>;
}): Promise<EngageResult> {
  volatileLatch = true;
  const event = {
    id: nextId(),
    triggeredBy: params.actorId,
    reason: params.reason,
    isActive: true,
    createdAt: timeService.now(),
  };
  store.killSwitchEvents.push(event);
  persistLatest();
  let cancelled = 0;
  if (params.cancelFn) {
    try {
      cancelled = await params.cancelFn();
    } catch (err) {
      console.error('[kill-switch] cancelAll failed:', err instanceof Error ? err.message : err);
    }
  }
  agentEvents.publish('kill-switch', { reason: params.reason, cancelledOrdersCount: cancelled });
  return { eventId: event?.id ?? '', cancelledOrdersCount: cancelled };
}

export async function disengageKillSwitch(ownerId: string): Promise<string> {
  const event = {
    id: nextId(),
    triggeredBy: ownerId,
    reason: 'manual disengage by owner',
    isActive: false,
    createdAt: timeService.now(),
  };
  store.killSwitchEvents.push(event);
  persistLatest();
  volatileLatch = false;
  agentEvents.publish('kill-switch-release', {});
  return event?.id ?? '';
}

export async function loadLatestEvents(limit = 20): Promise<Array<{ id: string; triggeredBy: string; reason: string; isActive: boolean; createdAt: number }>> {
  ensureLoaded();
  return store.killSwitchEvents.slice(-limit);
}

export function resetVolatileLatchForTests(): void {
  volatileLatch = false;
}

/** Simulasi restart: paksa mekanisme "sudah load" dibuka agar re-load dari disk. */
export function resetPersistedLoadedFlagForTests(): void {
  persistedLoaded = false;
}

export async function findEventById(id: string): Promise<{ id: string; triggeredBy: string; reason: string; isActive: boolean; createdAt: number } | undefined> {
  ensureLoaded();
  return store.killSwitchEvents.find((e) => e.id === id);
}

export function isKillSwitchVolatileLatch(): boolean {
  return volatileLatch;
}