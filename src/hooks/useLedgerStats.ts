import { useState, useEffect, useRef, useCallback } from "react";
import { authFetch, useAuth } from "./useAuth";

// ---------------------------------------------------------------------------
// useLedgerStats — shared domain hook for GET /api/ledger/stats
// Returns closed trades, win/loss counts, total trades, realized PnL, max DD.
// ---------------------------------------------------------------------------

export interface LedgerClosedTrade {
  id: string;
  symbol: string;
  side: string;
  entryPrice: number;
  closePrice: number;
  amount: number;
  /** P0-05: qty asal (trade size) + fee kumulatif hidup posisi. */
  openQty?: number;
  totalFeesUSD?: number | null;
  realizedPnlUsd?: number;
  realized_pnl_usd?: number;
  stopLoss?: number;
  openedAt?: number;
  closedAt?: number;
  exitReason?: string;
  entryReasoning?: string;
  entrySource?: string;
}

export interface SourceSplit {
  totalTrades: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  realizedPnlUSD: number;
}

export interface LedgerStatsResponse {
  success: boolean;
  closedTrades?: LedgerClosedTrade[];
  totalTrades?: number;
  realizedPnlUSD?: number;
  maxDrawdownPct?: number;
  bySource?: Record<string, SourceSplit>;
}

export interface LedgerStatsResult {
  closedTrades: LedgerClosedTrade[];
  totalTrades: number;
  realizedPnlUSD: number;
  maxDrawdownPct: number;
  bySource: Record<string, SourceSplit>;
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
}

const POLL_MS = 15000;

// Deduplikasi global — lihat useBrokerPositions.ts (satu timer untuk semua konsumen).
let sharedTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;
const subscribers = new Set<() => void>();
let lastSharedLoad = 0;

function subscribeShared(load: () => void): () => void {
  subscribers.add(load);
  subscriberCount += 1;
  if (!sharedTimer) {
    sharedTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastSharedLoad < 5000) return;
      lastSharedLoad = now;
      subscribers.forEach((fn) => fn());
    }, POLL_MS);
  }
  return () => {
    subscribers.delete(load);
    subscriberCount -= 1;
    if (subscriberCount <= 0 && sharedTimer) {
      clearInterval(sharedTimer);
      sharedTimer = null;
    }
  };
}

export function useLedgerStats(): LedgerStatsResult {
  const { isAuthenticated } = useAuth();
  const [closedTrades, setClosedTrades] = useState<LedgerClosedTrade[]>([]);
  const [totalTrades, setTotalTrades] = useState(0);
  const [realizedPnlUSD, setRealizedPnlUSD] = useState(0);
  const [maxDrawdownPct, setMaxDrawdownPct] = useState(0);
  const [bySource, setBySource] = useState<Record<string, SourceSplit>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isAuthenticated) return;
    try {
      const raw = await authFetch("/api/ledger/stats");
      // 429 → tampilkan cache terakhir (fail-closed visual), bukan error.
      if (raw.status === 429) return;
      const res = await raw.json().catch(() => null);
      if (res && res.success) {
        if (mountedRef.current) {
          setClosedTrades(Array.isArray(res.closedTrades) ? res.closedTrades : []);
          setTotalTrades(Number(res.totalTrades ?? 0));
          setRealizedPnlUSD(Number(res.realizedPnlUSD ?? 0));
          setMaxDrawdownPct(Number(res.maxDrawdownPct ?? 0));
          setBySource(res.bySource && typeof res.bySource === "object" ? res.bySource : {});
        }
      }
      setError(false);
    } catch {
      if (mountedRef.current) setError(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isAuthenticated) return;
    load();
    const unsubscribe = subscribeShared(load);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isAuthenticated, load]);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  return { closedTrades, totalTrades, realizedPnlUSD, maxDrawdownPct, bySource, loading, error, refresh: load };
}
