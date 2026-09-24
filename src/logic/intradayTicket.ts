/**
 * src/logic/intradayTicket.ts
 * Store tiket intraday — penghubung Advisor → Order Entry Panel tanpa
 * auto-submit. Publisher (AiAdvisorPanel) hanya MENGISI draft yang sudah
 * divalidasi makeIntradayDraft; konsumen (OrderEntryPanel) menampilkan prefill
 * + hint deadline WIB; user tetap yang menekan tombol LONG/SHORT (manual).
 *
 * Module-level store kecil (pub-sub) — pola sama seperti toast/ring buffer
 * lain di FE; tidak ada state yang di-lift ke panel.
 */

export interface IntradayTicket {
  symbol: string;
  side: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  createdAt: number;
  /** Dari mana draft berasal (mis. "ai-advisor"). */
  source: string;
}

export const INTRADAY_HOLD_MS_FE_HINT = 86_400_000; // 24 jam — konsisten maxHoldMs engine

type TicketListener = (ticket: IntradayTicket | null) => void;

let current: IntradayTicket | null = null;
const listeners = new Set<TicketListener>();

export function publishIntradayTicket(ticket: IntradayTicket): void {
  current = { ...ticket };
  for (const fn of listeners) fn(current);
}

export function clearIntradayTicket(): void {
  current = null;
  for (const fn of listeners) fn(null);
}

/** Subscribe; langsung dipanggil dengan ticket saat ini (late-mount catch-up). */
export function subscribeIntradayTickets(fn: TicketListener): () => void {
  listeners.add(fn);
  fn(current ? { ...current } : null);
  return () => {
    listeners.delete(fn);
  };
}

export function getIntradayTicket(): IntradayTicket | null {
  return current ? { ...current } : null;
}

/** Test-only: reset state module. */
export function resetIntradayTicketStore(): void {
  current = null;
  listeners.clear();
}