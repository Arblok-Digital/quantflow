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
  realizedPnlUsd?: number;
  realized_pnl_usd?: number;
  stopLoss?: number;
  openedAt?: number;
  closedAt?: number;
  exitReason?: string;
  entryReasoning?: string;
}

export interface LedgerStatsResponse {
  success: boolean;
  closedTrades?: LedgerClosedTrade[];
  totalTrades?: number;
  realizedPnlUSD?: number;
  maxDrawdownPct?: number;
}

export interface LedgerStatsResult {
  closedTrades: LedgerClosedTrade[];
  totalTrades: number;
  realizedPnlUSD: number;
  maxDrawdownPct: number;
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
}

const POLL_MS = 5000;

export function useLedgerStats(): LedgerStatsResult {
  const { isAuthenticated } = useAuth();
  const [closedTrades, setClosedTrades] = useState<LedgerClosedTrade[]>([]);
  const [totalTrades, setTotalTrades] = useState(0);
  const [realizedPnlUSD, setRealizedPnlUSD] = useState(0);
  const [maxDrawdownPct, setMaxDrawdownPct] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isAuthenticated) return;
    try {
      const res = await authFetch("/api/ledger/stats").then((r) => r.json().catch(() => null));
      if (res && res.success) {
        if (mountedRef.current) {
          setClosedTrades(Array.isArray(res.closedTrades) ? res.closedTrades : []);
          setTotalTrades(Number(res.totalTrades ?? 0));
          setRealizedPnlUSD(Number(res.realizedPnlUSD ?? 0));
          setMaxDrawdownPct(Number(res.maxDrawdownPct ?? 0));
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
    const iv = setInterval(load, POLL_MS);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isAuthenticated, load]);

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  return { closedTrades, totalTrades, realizedPnlUSD, maxDrawdownPct, loading, error, refresh: load };
}
