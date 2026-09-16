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

const POLL_MS = 15000;

// Deduplikasi global: satu interval untuk SEMUA konsumen hook ini (StrictMode
// DEV me-mount hook 2x → tanpa ini request /api/broker/* ikut ganda).
let sharedTimer: ReturnType<typeof setInterval> | null = null;
let subscriberCount = 0;
const subscribers = new Set<() => void>();
let lastSharedLoad = 0;

function subscribeShared(load: () => void): () => void {
  subscribers.add(load);
  subscriberCount += 1;
  // Panggilan pertama tiap subscriber dibiarkan via load() di bawah;
  // timer global hanya satu, throttle min 5s antar fire.
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
        authFetch("/api/broker/positions").then((r) => (r.status === 429 ? null : r.json().catch(() => null))),
        authFetch("/api/broker/orders").then((r) => (r.status === 429 ? null : r.json().catch(() => null))),
      ]);
      // 429 → tampilkan cache terakhir (fail-closed visual), bukan error.
      if (posRes === null && ordersRes === null) return;

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

  const openPositions = positions.filter((p) => p.status === "OPEN");

  return { positions, openPositions, account, mode, pendingOrders, loading, error, refresh: load };
}
