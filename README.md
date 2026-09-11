# AI Trading Agent Engine

Autonomous AI-driven trading agent with **paper trading** (realistic fills on real order books, zero risk) and guarded **live trading** via [ccxt](https://github.com/ccxt/ccxt) (a single connector for 100+ exchanges). The decision layer runs on **Gemini 2.0 Flash** combined with the **Keel Quantitative Institutional MM Engine** and an algorithmic MTF liquidation-hunt fallback.

> This project is under active production hardening. See
> [PRODUCTION_ROADMAP.md](./PRODUCTION_ROADMAP.md) for the phased plan and
> [IMPLEMENTATION.md](./IMPLEMENTATION.md) for the **current implementation
> status** (module map, endpoints, replay/auto-strategy, DB, TODO) — read that
> one first before touching code.

## Architecture

The trading pipeline is an explicit chain of stages, each with measured latency, server-side risk gates, and an audit trail:

```
Data Feeder (Binance WS/REST -> SSE Proxy) 
   -> MTF Liquidity-Hunt Analysis 
   -> Decision Engine (Gemini 2.0 Flash + Keel Quant MM Engine Fallback)
   -> Risk Gate (Server Guardrails + Keel Institutional Risk Engine) 
   -> Broker Gateway (ccxt / paper book) 
   -> Audit Ledger (HMAC-Signed SHA-256 Chain in SQLite)
```

- **Feeder** — Real-time Binance WebSocket (trade + depth@100ms) streamed via Server-Sent Events (SSE) to frontend; multi-exchange fallback REST chain (Binance -> Bybit -> Synthetic), multi-timeframe candles (1s to 1W), order books, on-chain BTC snapshots (blockchain.com), macro calendar.
- **MTF Analysis** — Multi-timeframe liquidation-hunt engine (15m futures / 4h spot) locating buy-side (BSL) and sell-side (SSL) liquidity pools, sweep detection, and wick rejection absorption.
- **Decision Engine** — Dual-engine architecture:
  1. Primary: **Gemini 2.0 Flash** (`/api/ai-decision`) with Zod schema validation and price-order sanity check.
  2. Institutional Fallback: **Keel Quantitative Engine** (`keelAdapter.ts`) — featuring Smart Money Tracker (flow classification), Absorption Engine, Wall Dynamics, and Confluence Matrix.
  3. Direct Quant API: `POST /api/keel/signal` for direct Keel signal and risk assessment queries.
- **Risk Gate & Guardrails** — Dual-layer risk enforcement:
  1. Server Guardrails (`guardrails.ts`): Kill switch, max open positions, max daily loss limit, order rate limiter, cooldown window.
  2. Keel Institutional Risk Engine (`keelAdapter.ts`): Intraday High-Water Mark tracking, drawdown breach monitoring, and 11 institutional risk rules.
- **Broker Gateway** — `src/pipeline/brokerService.ts` executes through the server (`POST /api/broker/order`).
  - **Paper Mode** (default): Server fills orders against the real ccxt order book (measured VWAP slippage, 0.04% fee), stored in SQLite (`trading.db`).
  - **Bracket Monitor**: Background loop (every 3s) checks open positions against real mark price and auto-closes on SL/TP/Liquidation.
  - **Live Mode**: Pass-through to exchange via ccxt with double-lock protection (`liveArmed` flag + passcode authentication).
- **Audit Ledger** — Persistent SQLite table (`audit_ledger`) backed by HMAC-SHA256 signature chain. Verification endpoint at `GET /api/ledger/verify`.

## Setup & Run

Prerequisites: Node.js 18+ (tested on Node 22+).

```bash
npm install
cp .env.example .env    # then edit .env
npm run dev             # dev server (tsx + Vite HMR) on http://localhost:3000
```

Production build & run:

```bash
npm run build           # Vite client build + esbuild server bundle -> dist/
npm start               # node dist/server.cjs
```

Testing & Code Quality:

```bash
npm test                # Run Vitest test suite (48 tests PASS)
npm run lint            # Type-check with tsc --noEmit
```

### Environment (`.env`)

| Variable             | Purpose                                                                         |
| -------------------- | ------------------------------------------------------------------------------- |
| `PORT`               | HTTP port (default `3000`)                                                      |
| `TRADING_MODE`       | `paper` (default) or `live`                                                     |
| `GEMINI_API_KEY`     | Gemini key for AI decision layer (optional; falls back to Keel Quant Engine)    |
| `AUTH_PASSCODE`      | Security passcode for session authentication                                    |
| `AUDIT_SECRET`       | HMAC key for cryptographic audit ledger                                         |
| `BROKER_EXCHANGE`    | ccxt exchange id (default `binance`)                                            |
| `BROKER_API_KEY`     | Exchange API key (required for live)                                            |
| `BROKER_API_SECRET`  | Exchange API secret (required for live)                                         |
| `BROKER_TESTNET`     | `true` to use exchange sandbox/testnet where supported                          |

## Paper vs Live Mode

**Paper Mode (Default, `TRADING_MODE=paper`)**:

- Orders filled against real ccxt order book depth: VWAP execution through bid/ask ladder, measured slippage, 0.04% taker fee.
- Open positions & order history persisted to SQLite database (`trading.db`, WAL mode with synchronous=FULL for zero data loss).
- Server **bracket monitor** polls open positions every 3s against WebSocket mark price cache and executes automatic SL/TP/Liquidation closes.
- Equity, margin, unrealized PnL, and realized PnL computed server-side (`paperBook.ts`) and served via `/api/broker/positions` & `/api/broker/balance`.

**Live Mode (Opt-in, `TRADING_MODE=live` + credentials + armed)**:

- Guarded by `assertLiveAllowed` in `broker.ts`: orders execute only when mode is `live`, API credentials stored in encrypted AES-256-GCM vault, AND `liveArmed=true`.
- Requires explicit passcode login and manual arming via UI/API (`POST /api/broker/arm`).

## Production Roadmap & Status

- **Phase 1-3**: Real-time market feed, server paper position book, SQLite database, HMAC audit ledger — **100% Complete**
- **Phase 4**: Decision Integrity (Gemini 2.0 Flash + price-order validation) — **100% Complete**
- **Phase 5-6**: WebSocket-to-SSE Proxy & Keel Quant Engine Integration — **100% Complete**
- **Phase 7**: Integration Tests & Test Suite (48 unit/integration tests PASS) — **100% Complete**

See [PRODUCTION_ROADMAP.md](./PRODUCTION_ROADMAP.md) for full phase documentation.
