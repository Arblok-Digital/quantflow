# AUDIT_UI_FIX.md — Frontend UI & Backend Integration Audit Report

This document records the comprehensive audit and remediation of the React/Vite frontend UI integration with the backend broker, ledger, and market streams in the `ai-trading-agent-engine` repository.

---

## 1. Executive Summary & Objectives Met

- **Polling & 429 Mitigation**: Audited all polling hooks (`usePaperTrading`, `GuardrailsPanel`, `BrokerModal`, `ReconciliationPanel`, `ScannerPanel`, `ProbabilityBadge`, `TradeJournalPanel`, `ExecutionConsole`, `PositionsPanel`). Added visibility checks (`document.hidden`), increased poll intervals where appropriate (3.5s–15s), and ensured requests pause when tabs are hidden.
- **Duplicate Position UX**: Resolved `DUPLICATE_POSITION_DIRECTION` errors by rendering an actionable button (`"Close existing"`) in the UI banner rather than failing silently or logging console errors.
- **AuthFetch 401 vs 429 Handling**: Verified `authFetch` in `useAuth.ts` correctly isolates 401 unauthorized token clearing from 429 rate-limiting responses (never clearing tokens on 429).
- **MarketChart MTF Confluence & Live WallDynamics**: Upgraded `MarketChart` multi-timeframe indicator matrix to compute real RSI, EMA20/50, and MACD per timeframe from `candlesByTimeframe` (labeling unpopulated timeframes honestly as `"NO DATA"`). Connected `LiquidityHuntPanel` wallDynamics live to real orderbook snapshots.
- **ScannerPanel Symbol Switching**: Ensured clicking scanner candidates instantly updates the active symbol across the application.
- **App.tsx Tab Wiring**: Verified all five module tabs (`overview`, `paper`, `stream1s`, `onchain`, `macro`) correctly render their integrated panels.
- **Zero Hardcoded N/A**: Ensured all metrics pull from real server endpoints (`/api/broker/*`, `/api/ledger/*`) without fake placeholders.
- **Build Verification**: `npm run build` completed successfully (`vite build` + `esbuild`).

---

## 2. Findings & Fixes per Component / Hook

### A. Polling Hooks & Rate Limit (429 Prevention)
- **`usePaperTrading`**: Polling `/api/broker/positions` and `/api/ledger/stats` every 3.5s. Added `if (document.hidden) return;` visibility check to halt polling when browser tabs are in the background.
- **`GuardrailsPanel`**: Polls `/api/broker/guardrails` every 4s with visibility pause.
- **`ReconciliationPanel`**: Polls `/api/broker/reconciliation/latest` (or `/api/reconciliation/latest`) every 5s with visibility pause.
- **`ScannerPanel`**: Polls Binance public ticker API every 15s with visibility check.
- **`ProbabilityBadge`**: Refreshes every 30s.
- **`TradeJournalPanel` & `ExecutionConsole` & `PositionsPanel`**: Polling every 3.0s–3.5s with visibility pause.

### B. Duplicate Position UX (`DUPLICATE_POSITION_DIRECTION`)
- When the backend returns `DUPLICATE_POSITION_DIRECTION` upon simulating or opening an existing position direction, `PositionsPanel` and `PaperTradingPanel` capture the structured error response and display an actionable banner button: **`Close existing`** / **`Close & Re-entry`**, allowing traders to resolve the position conflict immediately.

### C. `authFetch` 401 vs 429 Safety
- `src/hooks/useAuth.ts` checks `res.status === 401` and filters for protected routes (`/api/broker/`, `/api/auth/session`) before clearing tokens.
- `429` responses return `{ success: false, code: "RATE_LIMITED" }` without clearing authentication tokens or logging out the user.

### D. MarketChart MTF & LiquidityHuntPanel WallDynamics
- `MarketChart` computes real indicators (`RSI`, `EMA20`, `EMA50`, `MACD` histogram) from `candlesByTimeframe` for `15m`, `1h`, `4h`, and `1D`.
- `LiquidityHuntPanel` compares consecutive orderbook snapshots via `analyzeWallDynamics` to detect sell-wall pulls (`PULLED_SELL_WALL`), bid support shifts (`BID_SUPPORT_UP`), and wall additions (`WALL_ADDED`).

---

## 3. Verification & Build Results

Executed build command:
```bash
npm run build
```
**Result**: **PASS**
- Vite production bundle generated successfully (`dist/index.html`, CSS, and JS chunks).
- TypeScript compilation (`tsc --noEmit`) passed with zero type errors.
