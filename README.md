# ⚡ QuantFlow — AI Trading Terminal

> Full-stack trading terminal dengan **paper-trading engine yang realistis**, **backtest deterministik**, quant engine institusional, dan **live execution yang dijaga berlapis** — dibangun end-to-end oleh satu developer.

![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Node](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)
![Tests](https://img.shields.io/badge/tests-76%2F76_passing-22c55e)

**Screenshots:** *(tambahkan GIF dashboard di sini — replay mode, order ticket, guardrails cockpit)*

---

## ✨ Kenapa project ini beda

Kebanyakan "trading bot" di GitHub cuma wrapper API. QuantFlow dibangun seperti **exchange microservice sungguhan**:

- 🎯 **Paper engine yang jujur** — fill dihitung VWAP dari order book asli (top-20 level), dengan *partial fill* fail-closed, fee maker/taker terpisah (2/4 bps), slippage terukur, dan liquidation price per Binance USDT-M tier-1 (MMR 0.4%). Bukan simulasi harga random.
- 🧪 **Backtest deterministik, bebas lookahead bias** — replay engine mengolah candle historis asli per-candle (indikator hanya melihat data ≤ index aktif), isolated book yang 100% terpisah dari akun paper, dan **export dataset training CSV 18 kolom** (termasuk `risk_r`, `hold_candles`, `decision_id`) siap dipakai ML.
- 🔐 **Audit yang bisa diverifikasi** — setiap order ditandatangani HMAC-SHA256 dan dirantai ke hash-chain ledger append-only di SQLite. Verifikasi: `GET /api/ledger/verify`.
- 🛡️ **Guardrails berlapis** — kill switch, daily-loss limiter, max posisi, cooldown, rate limit di server; mode live butuh *double-lock* (credentials di vault AES-256-GCM + flag `armed`).
- 🧠 **Dual decision engine** — Gemini 2.0 Flash (validasi Zod + sanity check harga) dengan fallback **Keel Quant Engine** deterministik: smart-money tracker, absorption engine, wall dynamics, confluence matrix, dan 11 aturan risiko institusional.
- 🖥️ **UI terminal ala broker pro** — React 19: order ticket dengan confirmation gate live (ketik simbol + countdown), toast eksekusi real-time, guardrails cockpit dengan daily-loss meter, trade journal, replay playback, reconciliation panel.

---

## 🏗️ Arsitektur

Setiap keputusan trading melewati pipeline eksplisit dengan latensi terukur per tahap:

```
Data Feeder (Binance WS/REST → SSE, fallback chain Binance→Bybit→Synthetic)
   → MTF Liquidity-Hunt Analysis (15m futures / 4h spot, BSL/SSL pools)
   → Decision Engine (Gemini 2.0 Flash ⭄ Keel Quant Engine)
   → Risk Gate (Server Guardrails + Keel Institutional Risk)
   → Broker Gateway (paper book server-truth ⭄ ccxt live)
   → Audit Ledger (HMAC-SHA256 chain, SQLite)
```

### Struktur modul (full-stack, modular)

```
server.ts                 → thin bootstrap + security middleware (helmet, rate-limit, CORS)
src/server/routes/        → REST routes: auth, broker, market, ledger, ai, replay, wsProxy
src/broker/               → paperBroker.ts / liveBroker.ts (mode router, response contract seragam)
src/paperbook/            → fill engine (VWAP, partial fill), store, bracket monitor, mark cache
src/replay/               → deterministic backtest engine + training CSV export
src/pipeline/             → orchestrator: Data → MTF → Decision → Risk → Broker → Ledger
src/logic/                → decision engine, indicators, liquidity hunt, keel/** (subtree lengkap)
src/db/                   → SQLite core (WAL, synchronous=FULL) + persistence + audit chain
src/hooks/ + components/  → React 19 FE: domain hooks + ~30 panel, server-truth reader pattern
```

---

## 🚀 Quick Start

```bash
git clone https://github.com/Arblok-Digital/quantflow.git
cd quantflow
npm install
cp .env.example .env    # isi GEMINI_API_KEY (opsional) & AUTH_PASSCODE
npm run dev             # http://localhost:3000
```

Production:

```bash
npm run build && npm start
```

**Quality gates** (semua harus hijau sebelum merge):

```bash
npx tsc --noEmit        # type-safe, zero errors
npx vitest run          # 76/76 tests (unit + integration)
npm run test:smoke      # end-to-end API smoke test
```

---

## 🎮 Mode Paper vs Live

| | 📄 Paper (default) | 🔴 Live (opt-in) |
|---|---|---|
| Eksekusi | VWAP fill di order book asli | ccxt → exchange asli |
| SL/TP otomatis | Bracket monitor 3s (mark + 1m range) | Double-lock + guardrails |
| Persistensi | SQLite (WAL, synchronous=FULL) | Audit chain identik |
| Konfirmasi UI | 1 klik | Ketik simbol + countdown 3s |

Mode adalah **server-truth** — FE hanya reader, tidak pernah menghitung eksekusi sendiri. Satu dashboard, beda perilaku & visual per mode.

## 📊 Backtest & ML Pipeline

1. Jalankan replay pada candle historis asli (auto-strategy: RSI + EMA50/volume surge, SL/TP dari ATR).
2. Statistik otomatis: win rate, profit factor, expectancy, avg R, max drawdown.
3. Export **training dataset** (CSV/JSON) — setiap trade traceable ke `decisionId` dari engine (join decision → fill → trade → PnL).
4. Hasil backtest otomatis dikalibrasi ke prompt AI advisor (confidence gating).

---

## 🛠️ Tech Stack

**Backend:** Node 24 · TypeScript 5.8 · Express 4 · SQLite (`node:sqlite`) · ccxt 4 · Pino · WebSocket→SSE proxy
**Frontend:** React 19 · Vite 6 · Tailwind 4 · Zod
**AI/Quant:** Gemini 2.0 Flash (`@google/genai`) + Keel Quant Engine (custom, deterministik)
**Testing:** Vitest (unit + integration, supertest)

## 🔒 Security Notes

- Credential exchange disimpan terenkripsi **AES-256-GCM** di local vault (bukan plaintext, bukan env).
- Session auth 32-byte token; rate limiting berlapis; fail-closed signature di production.
- File sensitif (`.env`, vault, DB) di-gitignore — repo ini **tidak menyimpan secret apa pun**.

## 🗺️ Roadmap

- ✅ Paper engine, replay/backtest + training export, audit chain, FE terminal upgrade
- 🔜 Exchange-native TP/SL untuk live (stopMarket/takeProfitMarket), WebSocket user stream, reconciliation otomatis, backtest matrix paralel

Lihat [PRODUCTION_ROADMAP.md](./PRODUCTION_ROADMAP.md) & [IMPLEMENTATION.md](./IMPLEMENTATION.md) untuk detail teknis lengkap.

---

## 👤 Author

Dibangun end-to-end (arsitektur, backend, frontend, quant logic, testing) oleh **Arblok** — full-stack developer.

📌 **Terbuka untuk freelance/contract work** — full-stack TypeScript, trading systems, dashboards real-time.
📬 Hubungi saya via [GitHub](https://github.com/Arblok-Digital).

---

*⚠️ Disclaimer: software ini untuk edukasi & development. Trading crypto berisiko tinggi — gunakan mode live dengan pemahaman penuh atas risikonya.*
