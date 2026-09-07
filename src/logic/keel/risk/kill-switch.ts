/**
 * Kill switch — Keel `src/services/risk/kill-switch.ts` port.
 * Volatile in-memory latch + persisted event rows (in-memory store).
 * Telegram / Redis / agent-events replaced with the keel in-memory agentEvents bus.
 */
import { store, lastKillSwitchEvent, nextId, type QueryTx } from '../store.js';
import { agentEvents } from '../ingestion/feed-manager.js';
import { timeService } from '../time-sync.js';

let volatileLatch = false;

export async function isKillSwitchActiveTx(_tx?: QueryTx): Promise<boolean> {
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
  volatileLatch = false;
  agentEvents.publish('kill-switch-release', {});
  return event?.id ?? '';
}

export async function loadLatestEvents(limit = 20): Promise<Array<{ id: string; triggeredBy: string; reason: string; isActive: boolean; createdAt: number }>> {
  return store.killSwitchEvents.slice(-limit);
}

export function resetVolatileLatchForTests(): void {
  volatileLatch = false;
}

export async function findEventById(id: string): Promise<{ id: string; triggeredBy: string; reason: string; isActive: boolean; createdAt: number } | undefined> {
  return store.killSwitchEvents.find((e) => e.id === id);
}

export function isKillSwitchVolatileLatch(): boolean {
  return volatileLatch;
}