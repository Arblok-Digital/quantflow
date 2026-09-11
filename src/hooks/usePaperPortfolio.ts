import { Portfolio } from "../types";

// ---------------------------------------------------------------------------
// usePaperPortfolio — derives the Portfolio from broker account + ledger stats.
// Pure derivation function (no separate fetch) — composing data from
// useBrokerPositions.account and useLedgerStats.
// Used by usePaperTrading as a shared domain calculator.
// ---------------------------------------------------------------------------

const INITIAL_PAPER_CASH = 10000;

const EMPTY_PORTFOLIO: Portfolio = {
  cash: 0,
  equity: 0,
  initialBalance: INITIAL_PAPER_CASH,
  realizedPnl: 0,
  winCount: 0,
  lossCount: 0,
  totalTrades: 0,
  maxDrawdownPercent: 0,
  currentDrawdownPercent: 0,
};

export interface DerivePortfolioOpts {
  account: { cash: number; equity: number; realizedPnl?: number } | null;
  totalTrades: number;
  closedTradesPnl: number[]; // realizedPnlUsd for each closed trade
  maxDrawdownPct: number;
  runningPeak: number; // running peak equity for honest current DD
}

export function derivePortfolio(opts: DerivePortfolioOpts): {
  portfolio: Portfolio;
  newPeak: number;
} {
  const { account, totalTrades, closedTradesPnl, maxDrawdownPct, runningPeak } = opts;
  const cash = account ? Number(account.cash ?? 0) : 0;
  const equity = account ? Number(account.equity ?? cash) : cash;
  const realizedPnl = account
    ? Number(account.realizedPnl ?? 0)
    : closedTradesPnl.reduce((s, v) => s + v, 0);

  let winCount = 0;
  let lossCount = 0;
  for (const pnl of closedTradesPnl) {
    if (pnl > 0) winCount++;
    else if (pnl < 0) lossCount++;
  }
  if (winCount + lossCount > totalTrades) {
    lossCount = Math.max(0, totalTrades - winCount);
  }

  const newPeak = Math.max(runningPeak, Number(equity) || 0);
  const currentDD =
    newPeak > 0 ? ((newPeak - (Number(equity) || 0)) / newPeak) * 100 : 0;

  return {
    portfolio: {
      cash: Number(cash.toFixed(2)),
      equity: Number(equity) || 0,
      initialBalance: INITIAL_PAPER_CASH,
      realizedPnl: Number(realizedPnl.toFixed(2)),
      winCount,
      lossCount,
      totalTrades,
      maxDrawdownPercent: Number(maxDrawdownPct.toFixed(2)),
      currentDrawdownPercent: Number(Math.max(0, currentDD).toFixed(2)),
    },
    newPeak,
  };
}

export { EMPTY_PORTFOLIO, INITIAL_PAPER_CASH };
