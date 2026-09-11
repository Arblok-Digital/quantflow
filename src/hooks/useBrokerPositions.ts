import { useState, useEffect, useRef, useCallback } from "react";
import { authFetch, useAuth } from "./useAuth";

// ---------------------------------------------------------------------------
// useBrokerPositions — shared domain hook for GET /api/broker/positions
// and GET /api/broker/orders.  Used by usePaperTrading and any other consumer
// that needs live server positions + pending orders.
// ---------------------------------------------------------------------------

export interface ServerPosition {
  id: string;
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  entryPrice: number;
  notionalUSD: number;
  leverage: number;
  marginUSD: number;
  stopLoss: number;
  takeProfit: number;
  liquidationPrice: number;
  openedAt: number;
  status: "OPEN" | "CLOSED";
  lastMark?: number;
}

export interface ServerAccount {
  cash: number;
  equity: number;
  unrealizedPnl: number;
  realizedPnl: number;
  openCount: number;
  marginLocked: number;
}

export interface ServerOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell" | "LONG" | "SHORT";
  type: "limit";
  qty: number;
  filledQty?: number;
  remainingQty?: number;
  limitPrice: number;
  state: "NEW" | "PARTIALLY_FILLED" | "CANCELED" | "REJECTED";
  createdAt?: number;
}

interface PositionsResponse {
  success: boolean;
  mode?: "paper" | "live";
  positions: ServerPosition[] | null;
  account: ServerAccount | null;
  pendingOrders?: ServerOrder[];
}

interface OrdersResponse {
  success: boolean;
  orders?: ServerOrder[];
}

export interface BrokerPositionsResult {
  positions: ServerPosition[];
  openPositions: ServerPosition[];
  account: ServerAccount | null;
  mode: "paper" | "live";
  pendingOrders: ServerOrder[];
  loading: boolean;
  error: boolean;
  refresh: () => Promise<void>;
}

const POLL_MS = 5000;

export function useBrokerPositions(): BrokerPositionsResult {
  const { isAuthenticated } = useAuth();
  const [positions, setPositions] = useState<ServerPosition[]>([]);
  const [account, setAccount] = useState<ServerAccount | null>(null);
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [pendingOrders, setPendingOrders] = useState<ServerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mountedRef = useRef(false);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!isAuthenticated) return;
    try {
      const [posRes, ordersRes] = await Promise.all([
        authFetch("/api/broker/positions").then((r) => r.json().catch(() => null)),
        authFetch("/api/broker/orders").then((r) => r.json().catch(() => null)),
      ]);

      if (posRes && posRes.success) {
        const rawPositions: ServerPosition[] = Array.isArray(posRes.positions)
          ? posRes.positions
          : [];
        if (mountedRef.current) {
          setPositions(rawPositions);
          setAccount((posRes as PositionsResponse).account ?? null);
          if (posRes.mode) setMode(posRes.mode);
        }

        // Pending orders: prefer server /api/broker/orders, fallback to positions response
        const serverOrders: ServerOrder[] =
          ordersRes && Array.isArray(ordersRes.orders) ? ordersRes.orders : [];
        if (Array.isArray(posRes.pendingOrders) && serverOrders.length === 0) {
          if (mountedRef.current) setPendingOrders(posRes.pendingOrders);
        } else if (mountedRef.current) {
          setPendingOrders(serverOrders);
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

  const openPositions = positions.filter((p) => p.status === "OPEN");

  return { positions, openPositions, account, mode, pendingOrders, loading, error, refresh: load };
}
