import React, { createContext, useContext, useMemo } from "react";
import { useLiveMode } from "./useLiveMode";

// ---------------------------------------------------------------------------
// ModeContext — single source of truth untuk trading mode (paper | live).
// Server-truth: mode diambil dari polling useLiveMode (credentials/guardrails/
// balance). Provider menerima HASIL useLiveMode dari App (satu poller saja,
// tidak ada double-polling); semua panel konsum via useMode().
// ---------------------------------------------------------------------------

type LiveState = ReturnType<typeof useLiveMode>;

interface ModeContextValue {
  mode: "paper" | "live";
  isLive: boolean;
  liveArmed: boolean;
  credentialsConfigured: boolean;
  exchangeId: string;
  testnet: boolean;
  equity?: number;
  balances?: Array<{ currency: string; free: number; used: number; total: number }>;
  loading: boolean;
  refresh: () => Promise<void>;
}

const ModeContext = createContext<ModeContextValue | null>(null);

export const ModeProvider: React.FC<{ live: LiveState; children: React.ReactNode }> = ({ live, children }) => {
  const value = useMemo<ModeContextValue>(
    () => ({
      mode: live.mode,
      isLive: live.mode === "live",
      liveArmed: live.liveArmed,
      credentialsConfigured: live.credentialsConfigured,
      exchangeId: live.exchangeId,
      testnet: live.testnet,
      equity: live.equity,
      balances: live.balances,
      loading: live.loading,
      refresh: live.refresh,
    }),
    [live.mode, live.liveArmed, live.credentialsConfigured, live.exchangeId, live.testnet, live.equity, live.balances, live.loading, live.refresh]
  );
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
};

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) throw new Error("useMode harus dipakai di dalam <ModeProvider>.");
  return ctx;
}
