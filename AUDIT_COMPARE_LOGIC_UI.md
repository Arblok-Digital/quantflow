# AUDIT — Perbandingan LOGIC / UI / FITUR: KEEL vs AI-ENGINE

**Tanggal:** 2026-09-07 · **Tipe:** Subagent (OC-big-pickle) · **Bahasa:** Indonesia

**Repos yang dibandingkan:**
- **Repo A — AI-ENGINE:** `C:/Users/ARBLOK/Documents/ai-trading-agent-engine` (React + Vite, logic di `src/logic/*`, server Node/Express)
- **Repo B — KEEL:** `D:/DATA YAYAH/PROJECT YAYAH/keel` (Hono backend + Postgres, frontend `public/index.html` modular `public/js/*`)

> Catatan: `.env` tidak dibaca. Analisis berbasis kode sumber & struktur repo.

---

## 1. Ringkasan

Kedua repo adalah **AI trading agent terminal** dengan filosofi berbeda:

- **AI-ENGINE** = **frontend-heavy training simulator**. React-Vite SPA dengan 19 komponen, 7 hooks, logic murni TS di `src/logic/*` (decisionEngine, liquidityHunt, riskGatekeeper), paper book 1212 baris, dan **Realtime1sMLFeed** (feed Binance 1 detik via SSE proxy + export dataset ML). Fokus: **visualisasi pipeline, paper trading interaktif, dan edukasi/eksperimen**.
- **KEEL** = **backend-heavy production engine**. Hono API + Drizzle ORM + Postgres 16 + Redis, worker autonomus (540 baris), 52 service files, mm-brain (market-maker lens), ingesti multi-exchange (Binance, Gate, Coinbase, Raydium, Uniswap), risk gate berbasis transaksi `FOR UPDATE`, RLS, audit chain hash. Fokus: **execution trade nyata/paper solid dengan integritas tinggi & observability**.

**Verdict inti:** KEEL **lebih kaya fitur & lebih pro (production-grade)**. AI-ENGINE **lebih baik sebagai UI training simulator interaktif** (React interaktif, chart, paper-trading panel langsung di browser).

---

## 2. Tabel Skor (1–5)

| # | Dimensi | AI-ENGINE | KEEL | Pemenang |
|---|---------|:--------:|:----:|:--------:|
| 1 | Engine Logic & Indikator (MTF, liquidity hunt, smart-money, probability, risk gate) | 3.5 | **5.0** | KEEL |
| 2 | Pipeline UI↔BE (poll vs WS, latency real) | 4.0 | **4.5** | KEEL (tipis) |
| 3 | UI/UX & Komponen (dashboard, paper trading, journal) | **4.5** | 4.0 | AI-ENGINE (tipis) |
| 4 | Fitur & DX (testing, CI, modularisasi, observability) | 3.5 | **5.0** | KEEL |
| 5 | **TOTAL / Kaya fitur** | 3.9 | **4.6** | **KEEL** |
| 6 | **UI paling pro untuk training** | **4.5** | 3.5 | **AI-ENGINE** |

---

## 3. Detail

### 3.1 Engine Logic & Indikator

#### MTF (Multi-Timeframe)
- **AI-ENGINE:** `analyzeMTFLiquidity` (liquidityHunt.ts) — **hanya 2 timeframe** (15m tactical + 4h macro). Deteksi swing high/low sederhana (lookback 3–4 candle), sweep detection di 3 candle terakhir, confluence score hardcoded (70/88/85/78/76).
- **KEEL:** `MTFEngine.computeAll` (mtf-engine.ts) — **4 timeframe** (m15, h1, h4, d1) dengan **market-structure penuh**: swing HH/HL/LH/LL + BOS (Break of Structure) + EMA regime + FVG (Fair Value Gap) + Supertrend. Skor MTF dibobot via `confluence-matrix.ts` (MTF_WEIGHTS: d1 0.4, h4 0.3, h1 0.2, m15 0.1; varian SWING). **Jauh lebih dalam.**

#### Liquidity Hunt
- **AI-ENGINE:** Deteksi BSL/SSL via swing high/low + estimasi volume dari order book (±0.3% band). `estimateLiquidationDepthFromBook` pakai book depth sungguhan. State machine: EQUILIBRIUM → HUNTING → SWEPT. Solid untuk simulasi.
- **KEEL:** `liquidity-mapper.ts` (band Bps + wall detection) + `wall-dynamics.ts` (PULLED_SELL_WALL, BID_SUPPORT_UP, WALL_ADDED — deteksi manipulasi wall nyata) + `orderbook-service.ts`. **Deteksi wall & order-flow manipulation** ini tidak ada di AI-ENGINE.

#### Smart-Money
- **AI-ENGINE:** `onchain.ts` — **on-chain SEMUA di-simulasi** (netflow base konstan −142.5M + sin/cos variasi; whale tx hardcoded; txHash palsu `0x7f2a...8c4b`). Tidak ada data exchange real. Ini **kelemahan terbesar**.
- **KEEL:** `smart-money-tracker.ts` — flow real dari tick exchange (large-trade threshold dinamis by ADV, dominance ratio, largeTradeShare). + `absorption-engine.ts` (ACCUMULATION/DISTRIBUTION/pre-breakout) + `narrative-velocity.ts` + `temporal-memory.ts` (delta window). **Data real, multi-lens.**

#### Probability
- **AI-ENGINE:** Tidak ada probability engine. Confidence di decisionEngine hardcoded (78+confluence/10, 76, 68).
- **KEEL:** `probability-engine.ts` — **calibrated probability** `P(TP sebelum SL)` dari DB outcomes (signal_features + signal_outcomes join), Wilson lower-bound shrink, Laplace smoothing, EV (expected value) per bucket. **Fitur paling advanced di keel untuk training.**

#### Risk Gate
- **AI-ENGINE:** `riskGatekeeper.ts` (93 baris) — deterministic pre-trade: kill-switch flag, max drawdown, position size cap, risk-based sizing (SL distance × size), R:R ratio, confidence threshold. Bersih & readable, tapi single-thread client-side.
- **KEEL:** `gatekeeper.ts` (305 baris) — **production-grade, transaction-based** `FOR UPDATE` + `reserveAndPersistDecision`: 9+ alasan reject (RISK_REASONS), symbol guard (open-position/cooldown/max-reentry), macro-calendar flat window, weekend-liquidity flat, audit setiap decision. Plus `drawdown-monitor.ts`, `exit-monitor.ts`, `kill-switch.ts`. **Jauh lebih kuat & aman.**

**Skor: AI-ENGINE 3.5, KEEL 5.0**

### 3.2 Pipeline UI↔BE (Poll vs WS, Latency Real)

- **AI-ENGINE:** **SSE (Server-Sent Events) proxy** di server.ts — koneksi WebSocket native ke Binance `@trade`/`@depth@100ms`, disiarkan ke banyak client SSE. Fallback REST poll. `useMarketStream.ts` event-source + watchdog staleness. 1-second ML feed (`Realtime1sMLFeed.tsx`) dengan label WS_LIVE/REST_POLL/INTERPOLATED/SIMULATED. Latency 100ms depth, ~1s tick. Sangat bagus untuk UI real-time.
- **KEEL:** **WebSocket native** di `app.js` (`initWS` → `wssURL`) + **polling REST** (setInterval 7s feed/pipeline, 15s reconciliation, 10s perf). Multi-source ingestion backend (Binance/Gate/Coinbase WS stream, Raydium/Uniswap DEX indexer, Binance-vision REST). Staleness-gate 1500ms, time-sync server. Latency nyata dimonitor backend (time-sync.ts).

**Analisa latency real:** pendekatan AI-ENGINE (SSE push) **lebih responsive untuk UI**, tapi KEEL (WS + poll hybrid dengan reconciliation 15s) punya **integritas data yang lebih baik** (persist-before-execute, reconciliation). Keduanya hybrid, tapi hasil: KEEL unggul tipis karena backend multi-source + reconciliation + redis pub/sub.

**Skor: AI-ENGINE 4.0, KEEL 4.5**

### 3.3 UI/UX & Komponen

#### AI-ENGINE (React SPA — 19 komponen, 7 hooks)
- **Paper Trading:** `PaperTradingPanel.tsx` (569 baris) — panel interaktif penuh buy/sell, posisi, equity.
- **Chart:** `MarketChart.tsx` (813 baris) — chart candle real.
- **Feed ML:** `Realtime1sMLFeed.tsx` (503 baris) — tick 1 detik + **export dataset CSV/JSON untuk training ML**.
- **Journal:** `TradeJournalPanel.tsx` (375 baris) + AuditLedgerModal + ExecutionConsole + DecisionStream + GuardrailsPanel + RiskManagementPanel + BrokerModal + KeyVault (KMS demo) + LoginGate + ArchitectureModal + MacroCalendarPanel + OnChainPanel + PositionsPanel.
- **React interaktif** = layout dinamis, state management via hooks, re-render halus.

#### KEEL (Vanilla JS — index.html 565 baris + public/js/*)
- Frontend monolitik vanilla JS (`app.js` 899 baris), occupation martial: Human/Pro toggle, Macro Calendar, Early Feed, MM Brain, Decisions, Positions, Orders, Risk Gate, Reconciliation, Vault & Audit, Performance (winrate), Kill Switch, mode toggle PAPER/LIVE, role switcher (owner/viewer/system_agent), guide tour 2-menit, table timeline decision lifecycle.
- **Kuat di panel opsional/safety** (kill switch, vault, audit, reconciliation) tapi **tidak ada chart candle interaktif, tidak ada export dataset ML, DOM update manual via JS**.

**Skor: AI-ENGINE 4.5 (lebih interaktif/modern untuk training), KEEL 4.0 (lebih padat fitur opsional tapi kurang interaktif)**

### 3.4 Fitur & DX (Testing, CI, Modularisasi, Observability)

| Sub-dimensi | AI-ENGINE | KEEL |
|---|---|---|
| **Testing** | Vitest unit (5 test files: decisionEngine, liquidityHunt, riskGatekeeper, margin) + integration broker. **Lapisan logic cukup di-test** | Vitest unit luas (14 test files: risk-gatekeeper, mm-brain-advanced, staleness, signals, vault, mfa, jwt-sessions, idempotency, drawdown, entry-risk, reconciliation-live-halt, rls-matrix) + db migrations. **Lapisan risk/keamanan di-test menyeluruh** |
| **CI** | `.github/workflows/ci.yml` — **3 job (lint, test, build)** | Tidak ada `.github/workflows` (tanpa CI GitHub; ada verify_transitions.mjs, verify_triggers.mjs manual) |
| **Modularisasi** | Logic modular di `src/logic/*` + pipeline + hooks. Tapi 3 bug: logic campur dengan UI click | **Service layer 52 files terstruktur** (ingestion/execution/mm-brain/risk/reconciliation/audit/scanner/features), schema Drizzle, migrations |
| **Observability** | Audit ledger hash-chain (crypto.ts) + Guardrails + latency breakdown | Audit service (hash-verifier.ts), reconciliation real, RLS multi-tenant, **Telegram notifikasi**, Redis pub/sub, retention-export, drawdown-monitor |
| **Extras** | Export ML data CSV/JSON, KMS demo, paper book 1212 baris | OpenAPI spec, RLS, DEX multi-chain, kill-switch telegram, docker-compose, backup script |

**Skor: AI-ENGINE 3.5, KEEL 5.0** (KEEL unggul di testing, modularisasi, observability; AI-ENGINE hanya unggul di CI otomatis & export ML)

---

## 4. Rekomendasi

### Fitur mana yang lebih kaya? **KEEL**
- MTF 4-TF dengan market-structure penuh (BOS/FVG/Supertrend) vs 2-TF AI-ENGINE.
- Smart-money real (trade flow, absorption, wall dynamics) vs simulasi hardcode AI-ENGINE.
- Probability-calibrated engine (P/EV dari data outcome) — tidak ada di AI-ENGINE.
- Risk gate production-grade (9+ reject reasons, symbol guard, macro/weekend flat, audit semua decision) vs single pre-trade check.
- Multi-exchange ingestion (Binance, Gate, Coinbase, Uniswap, Raydium) vs Binance saja.
- Observability lengkap (audit hash, reconciliation, Telegram, Redis pub/sub).

### UI mana yang paling pro untuk training? **AI-ENGINE**
Jika "pro training" = **interaktif, visual, mudah dieskplor manual**: AI-ENGINE menang karena React SPA + chart candle interaktif + paper-trading panel langsung + export dataset ML (feeding data untuk training model). Cocok untuk **belajar alur pipeline, eksperimen strategi, dan latihan decision-making**.

Jika "pro training" = **belajar arsitektur produksi & keamanan trading nyata** (autonomous execution, risk integrity, emission), maka KEEL yang lebih pro—tapi ini lebih cocok dibaca kode/backend daripada di-demo di UI.

### Saran terbaik (gabungkan keduanya)
1. **Bawa engine logic KEEL ke AI-ENGINE UI:** Jadikan MTF 4-TF + smart-money + probability-calibrated + risk gate KEEL sebagai backend, dengan UI React AI-ENGINE sebagai frontend. Ini memberi **UI paling pro + engine paling kaya** dalam satu terminal.
2. **Tambahkan export ML dari KEEL:** Ambil pola `Realtime1sMLFeed` AI-ENGINE (export CSV) dan hubungkan ke recorder/feature-store KEEL (`signal-recorder.ts`, `feature-pack.ts`).
3. **Bawa chart interaktif & paper-trading panel ke KEEL:** Tambahkan React atau charting library ke frontend KEEL untuk menggantikan tabel statis.
4. **Backfill CI untuk KEEL:** Tambahkan `.github/workflows/ci.yml` (lint+test+build) mengikuti pola AI-ENGINE, karena KEEL saat ini tanpa CI otomatis padahal test-nya paling banyak.

---

*Laporan dibuat otomatis oleh subagent berdasar inspeksi kode langsung kedua repo. Skor bersifat subjektif-terstruktur (rubrik 1–5 per dimensi).*
