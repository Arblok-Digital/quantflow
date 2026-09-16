import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch, useAuth } from "./useAuth";

interface LiveModeState {
  armedForLive: boolean;
  liveArmed: boolean;
  credentialsConfigured: boolean;
  mode: "paper" | "live";
  exchangeId: string;
  testnet: boolean;
  equity?: number;
  balances?: Array<{ currency: string; free: number; used: number; total: number }>;
}

const POLL_MS = 15000;

export function useLiveMode(isAuthenticated?: boolean) {
  const [state, setState] = useState<LiveModeState>({
    armedForLive: false,
    liveArmed: false,
    credentialsConfigured: false,
    mode: "paper",
    exchangeId: "binance",
    testnet: false,
  });
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(false);

  const auth = useAuth();
  const effectiveAuth = typeof isAuthenticated === "boolean" ? isAuthenticated : auth.isAuthenticated;

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    if (!effectiveAuth) return;
    if (document.hidden) return;
    try {
      const [credRes, guardRes, balRes] = await Promise.all([
        authFetch("/api/broker/credentials/status").then((r) => (r.status === 429 ? null : r.json().catch(() => null))),
        authFetch("/api/broker/guardrails").then((r) => (r.status === 429 ? null : r.json().catch(() => null))),
        authFetch("/api/broker/balance").then((r) => (r.status === 429 ? null : r.json().catch(() => null))),
      ]);
      // Semua throttled → tampilkan cache terakhir.
      if (!credRes && !guardRes && !balRes) return;

      const armedFromCred = Boolean(credRes?.armedForLive ?? credRes?.liveArmed);
      const armedFromGuard = Boolean(guardRes?.state?.armedForLive);
      const armed = armedFromCred || armedFromGuard;

      const credConfigured = Boolean(credRes?.credentialsConfigured ?? credRes?.configured ?? (credRes?.credentialSource && credRes.credentialSource !== "none"));
      // Mode real diambil dari balance response (balRes.mode) — paling reliable.
      const m = balRes?.mode === "live" ? "live" : credRes?.success ? (armed ? "live" : "paper") : "paper";

      const balances = Array.isArray(balRes?.balances) ? balRes.balances : undefined;
      // Equity: prioritas account.equity dari balance response, lalu USDT total
      // sebagai proxy, terakhir pertahankan nilai lama (prev.equity).
      let equity: number | undefined;
      if (balRes?.account?.equity !== undefined) {
        equity = Number(balRes.account.equity);
      } else if (balances) {
        const usdt = balances.find((b: any) => b.currency === "USDT");
        if (usdt) equity = Number(usdt.total);
      }

      setState((prev) => ({
        ...prev,
        armedForLive: armed,
        liveArmed: armed,
        credentialsConfigured: credConfigured,
        mode: (balRes?.mode as any) || m || prev.mode,
        exchangeId: credRes?.exchange || prev.exchangeId,
        testnet: typeof credRes?.testnet === "boolean" ? credRes.testnet : prev.testnet,
        balances,
        equity: equity ?? prev.equity,
      }));
    } catch {
      // ignore
    }
  }, [effectiveAuth]);

  useEffect(() => {
    mountedRef.current = true;
    if (!effectiveAuth) return;
    setLoading(true);
    load().finally(() => setLoading(false));
    const iv = setInterval(() => load(), POLL_MS);
    const onVis = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [effectiveAuth, load]);

  // Keep mountedRef true after first mount so load can be called manually
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  return { ...state, loading, refresh: load };
}
