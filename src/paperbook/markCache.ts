// Shared mark cache dari server tick (task 6.3): satu sumber kebenaran harga
// untuk posisi/margin. Diisi oleh WS Binance proxy (server.ts) atau REST,
// dikonsumsi refreshPaperMarks & bracket monitor sebelum turun ke ccxt.
// F-02/P1: selain mark, cache juga jendela range 1m (high/low rolling 60 detik)
// dari setiap tick WS — jadi bracket SL/TP/liq dievaluasi terhadap range asli,
// bukan last-price doang (wick yang tembus lalu balik tetap ter-catch).
interface MarkCacheEntry {
  mark: number;
  ts: number;
  bucketStart: number;
  high: number;
  low: number;
}
const MARK_BUCKET_MS = 60_000; // jendela 1 menit
const sharedMarkCache = new Map<string, MarkCacheEntry>();

export function updatePaperMarkCache(symbol: string, mark: number): void {
  if (!isFinite(mark) || mark <= 0) return;
  const now = Date.now();
  const cached = sharedMarkCache.get(symbol);
  if (cached && now - cached.bucketStart < MARK_BUCKET_MS) {
    // masih dalam bucket 1m yang sama → update rolling high/low + mark
    cached.mark = mark;
    cached.ts = now;
    cached.high = Math.max(cached.high, mark);
    cached.low = Math.min(cached.low, mark);
    return;
  }
  // bucket baru (atau symbol baru): reset jendela high/low ke tick ini
  sharedMarkCache.set(symbol, { mark, ts: now, bucketStart: now, high: mark, low: mark });
}

import { MARK_TTL_MS } from "./config";

export function freshMarkFromCache(symbol: string, maxAgeMs = MARK_TTL_MS): { mark: number; ts: number; high: number; low: number } | null {
  const cached = sharedMarkCache.get(symbol);
  if (cached && Date.now() - cached.ts < maxAgeMs) {
    return { mark: cached.mark, ts: cached.ts, high: cached.high, low: cached.low };
  }
  return null;
}
