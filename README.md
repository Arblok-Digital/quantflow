# AI Trading Agent Engine

Autonomous AI-driven trading agent with **paper trading** (realistic fills on real
order books, zero risk) and guarded **live trading** via [ccxt](https://github.com/ccxt/ccxt)
(a single connector for 100+ exchanges). The decision layer runs on **Gemini**
with a deterministic algorithmic fallback; liquidity targeting is driven by a
multi-timeframe (MTF) liquidation-hunt engine.

> This project is under active production hardening. See
> [PRODUCTION_ROADMAP.md](./PRODUCTION_ROADMAP.md) for the phased plan, current
> status, and the definition of done for each item.

## Architecture

The trading pipeline is an explicit chain of stages, each with measured latency
and an audit trail:

```
Data Feeder -> MTF Liquidity-Hunt Analysis -> Decision Engine (Gemini + fallback)
   -> Risk Gate -> Broker Gateway (ccxt / paper book) -> Audit Ledger (hash chain)
```

- **Feeder** — real exchange market data (Binance primary, Bybit fallback),
  multi-timeframe candles, order books, on-chain BTC snapshots, macro calendar.
- **MTF analysis** — multi-timeframe liquidation-hunt engine (15m futures / 4h
  spot) locating buy-side (BSL) and sell-side (SSL) liquidity pools.
- **Decision engine** — Gemini (`/api/ai-decision`) or an algorithmic MTF hunter
  fallback; outputs action, confidence, stop loss, take profit, position size.
- **Risk gate** — client-side pre-trade checks (max drawdown, position size,
  min risk/reward, confidence threshold, emergency stop).
- **Broker gateway** — `src/pipeline/brokerService.ts` executes through the
  server (`POST /api/broker/order`). In **paper** mode the server fills orders
  against the real ccxt order book (measured slippage, real fees) and manages a
  persistent paper position book (`paperBook.ts`). In **live** mode orders are
  passed through to the exchange via ccxt.
- **Audit ledger** — SHA-256 hash-chained log of every cycle and order.

## Setup & Run

Prerequisites: Node.js 18+ (developed on Node 24).

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

Useful scripts: `npm run lint` (`tsc --noEmit`), `npm run clean`.

### Environment (`.env`)

| Variable            | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `PORT`              | HTTP port (default `3000`)                                     |
| `TRADING_MODE`      | `paper` (default) or `live`                                    |
| `GEMINI_API_KEY`    | Gemini key for the AI decision layer                           |
| `BROKER_EXCHANGE`   | ccxt exchange id (default `binance`)                           |
| `BROKER_API_KEY`    | Exchange API key (required for live)                           |
| `BROKER_API_SECRET` | Exchange API secret (required for live)                        |
| `BROKER_TESTNET`    | `true` to use an exchange sandbox/testnet where supported      |
| `BROKER_EVENT_SECRET` | HMAC secret for server-signed order payloads (dev fallback: `paper-dev-secret`) |

## Paper vs Live Mode

**Paper (default, `TRADING_MODE=paper`)**:

- Orders are filled server-side against the **real** ccxt order book (limit ~20
  levels): VWAP fill through the ask/bid ladder, slippage measured against the
  mid price, taker fee 0.04% per side. No `Math.random` anywhere in fills.
- Positions are stored in `paperBook.ts`, persisted to `.paper-book.json` so a
  server restart rehydrates the book (positions, account, event log).
- A **bracket monitor** polls open positions every 3 s against the live ticker
  and auto-closes on stop-loss / take-profit (conservative: a poll crossing both
  levels assumes stop-loss first).
- Margin, liquidation price (maintenance margin included) and realized PnL are
  computed server-side and returned from `/api/broker/positions`,
  `/api/broker/balance`, etc.

**Live (opt-in, `TRADING_MODE=live` + credentials)**:

- Guarded by `assertLiveAllowed` in `broker.ts`: orders only execute when the
  mode is `live` **and** API credentials are configured.
- Live orders pass straight through to the exchange via ccxt
  (`POST /api/broker/order`). Live positions are not yet stored in the paper
  book — do not run live with real capital until Phases 2 and 8 of the roadmap
  are complete.

## Production Roadmap

Phase 0 (repo hygiene), Phase 1 (execution wire-up), Phases 2-8 (guardrails,
persistence, decision integrity, real-time feed, correctness, tests/CI, ops) —
all tracked in [PRODUCTION_ROADMAP.md](./PRODUCTION_ROADMAP.md).