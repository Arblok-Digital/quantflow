# IMPLEMENTATION — AI Trading Agent Engine

> **Status:** 2026-09-11 · Dokumen tunggal "kondisi terkini" — **baca dulu ini sebelum kerja.**
> Semua dokumen audit lama / build-task per-fase sudah dihapus (sudah terimplementasi). Lihat `PRODUCTION_ROADMAP.md` untuk rencana fasa jangka panjang, `README.md` untuk intro & cara run.

---

## 1. Fakta Cepat

| Item | Nilai |
|------|-------|
| Stack | Node 24 · TypeScript (~5.8) · Express 4 · React 19 + Vite 6 · ccxt 4 · SQLite (`node:sqlite`) |
| Mode | **PAPER** default (buku posisi server + SQLite) · **LIVE** opt-in via env + credential + arm |
| Run dev | `npm run dev` (tsx server.ts, FE via Vite middleware di port 3000) |
| Build | `npm run build` → `dist/` (Vite client + esbuild `dist/server.cjs`) |
| Test | `npx vitest run` → **76/76 PASS** (9 files) · `npx tsc --noEmit` → EXIT 0 |
| Smoke | `npm run test:smoke` (login → status → positions) |
| AI | Gemini 2.0-flash primary / 1.5 Flash fallback (env `GEMINI_API_KEY`), + **Keel Quant Engine** deterministik |

---

## 2. Struktur Modul (peta navigasi)

```
server.ts                    → ROUTER MONOLITH (≈2300 baris, TODO: pecah ke src/server/routes/*)
paperBook.ts                 → PAPER BOOK MONOLITH (engine+state+fill+bracket+mark+auto) (TODO: pecah)
broker.ts                    → ccxt provider: exchange, vault AES-GCM, config, order (paper fill + live)
guardrails.ts                → kill-switch, max posisi, daily loss, rate limit, cooldown
auth.ts                      → passcode login + session 32-byte token

src/broker/                  → paperBroker.ts / liveBroker.ts / routerUtils.ts (handler terpisah)
src/replay/replayEngine.ts   → REPLAY / FORWARD-TEST + AUTO-STRATEGY + training dataset export
src/logic/                   → decisionEngine, keelAdapter, liquidityHunt, indicators, riskGatekeeper,
                               margin, pumpScanner, onchain, macroGate/Calendar, wallDynamics, scannerEngine,
                               probabilityEngine, + keel/** (subtree lengkap)
src/pipeline/                → tradingPipeline.ts (orchestrator) + brokerService.ts (client → POST /api/broker/order)
src/data/                    → marketFetcher (fallback chain), provider, onchainData, macroData, blockchainRealData
src/db/                      → core.ts (init+ledger+audit+stats) + persistence.ts (save/load) · barrel db.ts
src/hooks/                   → useAuth, usePaperTrading, useMarketData, useTradingPipeline,
                               useMarketStream, useLiveMode, useAuditLedger
src/components/              → panel FE (~30 file, 1 per panel). Raksasa: ReplayControlPanel (53KB),
                               PaperTradingPanel (42KB), MarketChart (39KB) → TODO dipecah
src/log/                     → pino + redaction apiKey/secret/token/passcode
src/utils/                   → crypto, indicators
```
---

## 3. Endpoint Server (grup)

| Grup | Endpoint |
|------|----------|
| Auth | `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/session` |
| Broker | `GET /api/broker/status` · `GET /api/broker/balance` · `POST /api/broker/order` · `POST /api/broker/close` · `POST /api/broker/cancel` · `GET /api/broker/orders` · `GET /api/broker/positions` · `GET /api/broker/order-status/:id` · `POST /api/broker/position/update` · `POST /api/broker/credentials` · `POST /api/broker/connection/test` · `GET /api/broker/events?sinceSeq=N` · `GET /api/broker/guardrails` |
| Market | `GET /api/market/feed` (SSE) · `GET /api/klines` · `GET /api/orderbook` · `GET /api/onchain/bitcoin` · `GET /api/market/keel-context` · `GET /api/scanner/pumps` |
| Ledger | `GET /api/ledger` · `GET /api/ledger/verify` · `GET /api/ledger/stats` |
| AI | `POST /api/ai-decision` (LLM eksekutif + backtest context) · `POST /api/ai-advisor` (insight/LLM + backtest context) · `POST /api/keel/signal` |
| Health | `GET /api/health` |

### Replay / Forward-Test (`/api/paper/replay/*`)
`POST start` · `GET status` · `POST step` · `POST run` · `POST pause` · `POST reset` · `POST speed`
`POST strategy` (mode manual/auto + params) · `POST order` · `POST close` · `POST cancel`
`POST export` (simpan ke SQLite) · `GET runs` (histori) · `GET runs/:id?format=csv`

---

## 4. Replay, Auto-Strategy & Training (fitur penting)

- **Replay** = backtest data HISTORIS candle (Binance Vision, paginated). 100% terpisah dari akun paper live. Deterministik.
- **Auto strategy** (`POST /api/paper/replay/strategy`, mode `auto`):
  Sinyal RSI(14) + konfirmasi trend EMA50 ATAU volume surge (1.4×, 20-candle).
  SL/TP dari ATR(14): `slAtrMult`, `tpAtrMult`. Sizing risiko `riskPct`% equity / |entry−SL|.
  Param: `{ rsiLong, rsiShort, slAtrMult, tpAtrMult, minCandles, cooldownCandles, riskPct, leverage }`.
  Tanpa lookahead (alpha = candle 0..currentIndex), event `AUTO_SIGNAL` + `lastAutoSignal` di status.
- **Export training CSV** — 18 kolom: `trade_id, symbol, side, qty, leverage, entry_price,
  entry_candle_index, entry_candle_ts, exit_price, exit_candle_index, exit_candle_ts,
  exit_reason, pnl_usd, pnl_percent, risk_r, fees_usd, hold_candles, decision_id`.
- **decisionId** — alur `order.meta.decisionId` → position → trade → CSV. Auto: `auto-<candle>-BUY|SELL`.
- **Advisor backtest bridge** — statistik replay terbaru per simbol di-inject ke prompt `/api/ai-advisor`
  & `/api/ai-decision` sebagai kalibrasi keyakinan (buat prompt: kalau PF<1 → turunkan confidence).

---

## 5. Paper Book & Lifecycle Order

- Order states: `NEW → (PARTIALLY_FILLED) → FILLED | REJECTED | CANCELLED`
- Fill realistis: orderbook top-20 (VWAP), partial fill kalau depth kurang, fee maker 0.02% / taker 0.04%
  (env `PAPER_FEE_*_BPS`), latensi simulasi 5–50ms, MMR 0.4% (Binance USDT-M tier-1).
- Bracket monitor: setiap ~3s cek SL/TP/liq terhadap mark real (range high/low 1m, SL prioritas).
- Env paper: `PAPER_INITIAL_CASH`, `PAPER_LEVERAGE_MAX`, `PAPER_FEE_TAKER_BPS`, `PAPER_FEE_MAKER_BPS`.

---

## 6. Database SQLite (`trading.db`, WAL + synchronous=FULL)

| Tabel | Isi |
|-------|-----|
| `audit_ledger` | Hash-chain + HMAC (append-only oleh kode) |
| `orders` / `fills` / `positions` | Paper book persistence |
| `portfolio_snapshots` | Equity curve |
| `agent_decisions` | Output LLM/keel per siklus |
| `replay_runs` | Hasil backtest (summary + `result_json` = training dataset) |

---

## 7. Status & TODO Berikutnya

### Sudah selesai (produksi-ubah)
- Paper mode training-ready: lifecycle order, maker/taker, partial fill, MMR tier-1, decisionId trace.
- Replay engine + auto-strategy + CSV export + SQLite `replay_runs`.
- Advisor & decision LLM dapat backtest context.
- DB split (`db.ts` barrel), broker handler split (paper/live), pino logging, Dockerfile.

### TODO (hasil audit struktur 2026-09-11)
1. **FE dedup** — shared data-hooks domain (`useBrokerPositions`, `useLedgerStats`, `usePaperPortfolio`);
   jurnal & metrik hanya 1 panel (TradeJournalPanel); hapus duplikasi di PaperTradingPanel/ExecutionMetrics.
2. **Close by positionId** — semua tombol CLOSE harus pakai `position.id` (server sudah support),
   bukan symbol (berbahaya saat LONG+SHORT symbol sama).
3. **Pecah panel raksasa** — ReplayControlPanel (53KB) & PaperTradingPanel (42KB) → komponen kecil.
4. **Split `server.ts`** (≈2300L) → `src/server/routes/{auth,market,broker,ledger,ai,advisor,keel,replay}.ts` + `wsFeed.ts`.
5. **Split `paperBook.ts`** (≈1600L) → `src/paperbook/{engine,store,fill,bracketMonitor,markCache,autoStrategy}.ts`.
6. Position sizing dari risk engine (keelAdapter), daily loss limit auto-pause.
7. Backtest matrix (bandingkan beberapa set params sekaligus).

---

## 8. Aturan Emas

- SETIAP pekerjaan backend WAJIB punya pasangan FE (golden rule roadmap).
- Tiap perintah kerja:
  `npx tsc --noEmit` → `npx vitest run` → `npm run build` harus hijau sebelum dianggap selesai.
- Server-truth: semua angka eksekusi/posisi dari server, FE hanya reader.
- Jangan baca `.env` (hanya `.env.example`).