# AUDIT–ARSTEKTUR: KEEL vs AI Trading Agent Engine

**Tanggal audit:** 2026-09-07 · **Auditor:** Hermes (CC-arblok)
**Repo A:** `C:/Users/ARBLOK/Documents/ai-trading-agent-engine` (selanjutnya **AI-Engine**)
**Repo B:** `D:/DATA YAYAH/PROJECT YAYAH/keel` (selanjutnya **KEEL**)
**Fokus:** arsitektur, pipeline trading end-to-end, DB schema & keamanan, keamanan/compliance, skor kesiapan. (Kredensial di `.env` tidak dibaca.)

---

## 1. Ringkasan Eksekutif

Dua engine trading yang sama-sama dirancang Ardi untuk menggerakkan strategi "smart-money / liquidity-hunt", tapi berada di dua kutub kematangan **arsitektural** yang berbeda:

- **AI-Engine** adalah **prototype monolit tunggal yang hidup dan dipakai sekarang untuk paper trading** (roadmap produksi 87%, CDN build, unit+integration test, audit-hash-chain SQLite). Kekuatannya di **kecepatan iterasi, kesederhanaan, dan UX** (React 19 + Vite, 1-2 file server + pipeline). Kelemahannya: auth passcode single-user, state kill-switch & guardrail di file JSON (`.guardrails.json`) bukan DB, DB SQLite single-process, live broker via dependency `ccxt` yang belum di-separate sebagai adapter aman, dan auditi chain tanpa kontrol akses RBAC.

- **KEEL** adalah **fondasi institusional**: Hono + PostgreSQL + Drizzle + Redis, dipisah jadi **API server** dan **worker/pipeline**, RBAC 3 role (owner/viewer/system_agent), **Row-Level Security (RLS)** di level Postgres, **FSM order & decision** yang dijaga oleh trigger DB, **hash-chain audit** dengan advisory lock antar-proses, **vault AES-256-GCM** untuk API key dengan log-scrubber global, **kill-switch multi-trigger** (manual, drawdown, reconciliation breach, audit tamper), **idempotensi** order + fallback recovery di boot, dan **OCO** sebagai proteksi. Saat ini **terkunci di mode PAPER** (`__paperLocked = true`), meski sudah punya adapter live (binance-spot, uniswap-v3, raydium).

**Verdict utama:**
- **Untuk PAPER training / iterasi strategi:** **AI-Engine lebih unggul** — lebih ringan, langsung jalan, UI lebih baik, paper book penuh, feedback loop cepat. Cocok untuk menguji logika strategi & UX.
- **Untuk LIVE trading (siap produksi, dana riil):** **KEEL jelas lebih prover & lebih siap** — keamanan data, FSM, RLS, vault, recovery, reconciliation, dan kontrol risiko berlapis jauh di atas AI-Engine. KEEL punya satu satu blokir besar: **belum pernah benar-benar diakarkan ke LIVE** (mode-nya hard-locked PAPER, live adapter butuh bukti fill riil).

Rekomendasi: **pertahankan AI-Engine sebagai playground/paper**, tapi **jadikan KEEL sebagai calon satu-satunya engine LIVE**. Jangan pernah membawa AI-Engine langsung ke LIVE.

---

## 2. Tabel Skor (1–5 per dimensi)

| Dimensi | AI-Engine | KEEL | Catatan |
|---|---|---|---|
| 1. Arsitektur overall (framework/runtime/DB/infra) | **3** | **5** | KEEL modular API+worker; AI-Engine monolit |
| 2. Pipeline trading end-to-end (ingestion→brain→risk→exec →recon) | **3** | **5** | KEEL punya semua 5 stage + idempotensi + recovery |
| 3. DB schema & keamanan (SQLite vs PG RLS, audit, FSM) | **3** | **5** | PG RLS + FSM trigger + chain-lock jauh lebih kuat |
| 4. Keamanan & compliance (auth, RBAC, kill-switch) | **2** | **5** | KEEL RBAC+MFA+vault; AI-Engine passcode single |
| **Kesiapan PAPER training** | **5** | **4** | AI-Engine lebih cepat di-iterasi & UX lebih baik |
| **Kesiapan LIVE** | **2** | **4** | KEEL siap secara desain; AI-Engine belum |
| **Rata-rata kesiapan LIVE (1–4 tebobot)** | **~2.5** | **~4.8** | Lihat tabel rincian |

---

## 3. Detail per Dimensi

### Dimensi 1 — Arsitektur Overall

| Aspek | AI-Engine | KEEL |
|---|---|---|
| **Kerangka** | Express 4 (single file `server.ts` ~1600 baris) + Vite dev proxy | **Hono 4** (`.fetch` edge-compatible) — `src/index.ts` API + `src/worker.ts` pipeline terpisah |
| **Runtime** | Node ESM, `tsx` dev, `esbuild` bundle prod | Node ≥20, `tsx --env-file` |
| **Frontend** | React 19 + Tailwind 4 + Vite (`src/App.tsx`, banyak komponen panel) | Public static HTML/JS (mockup + vanilla JS di `public/js/`) — frontend jauh lebih mentah |
| **DB** | **SQLite** (`node:sqlite`, single-process, WAL+FULL) | **PostgreSQL 16** via Drizzle ORM (**multi-process, server-side** — API & worker bisa scaler) |
| **Cache/pub-sub** | In-memory Map sesi & stream | **Redis 7** (pub/sub `manual:execute`, feed state, watchlist broadcast) |
| **Vault/secret** | `.broker-secrets.json` + `.broker-vault-key` (encrypt AES, sync-read manual di guardrails) | **AES-256-GCM vault** (`VAULT_MASTER_KEY`, ciphertext+iv+authTag di kolom DB), **global log-scrubber** |
| **Adapters** | `ccxt` langsung di server (broker.ts) — belum adapter interface terisolasi | `ExchangeAdapter` interface + 3 implementasi: **paper, binance-spot, uniswap-v3, raydium** |
| **Infra** | Single localhost (server+client+db di satu proses) | Docker Compose (Postgres+Redis), server & worker sebagai proses terpisah |
| **Test** | vitest (unit+integration) + smoke-test + CI GitHub Actions | vitest (banyak: auth-rls, idempotency, reconciliation, mfa, vault, dsb) + script verify (`verify_triggers.mjs`, `verify_transitions.mjs`) |
| **Dev-ektakular** | `.github/workflows/ci.yml` bundle build prod + smoke | eslint + typecheck; tidak ada CI terlihat |

**Analisis:** KEEL memilih stack yang lebih berat (Hono+PG+Redis+Docker) demi **modularitas, concurrency antar-proses, dan keamanan DB**. AI-Engine memilih monolit lokal untuk **kecepatan & UX**. Untuk LIVE, modularitas KEEL unggul: worker terpisah = pipeline bisa jalan meski API down, dan PostgreSQL memungkinkan multi-instance tanpa korupsi data (SQLite WAL hanya mengizinkan satu writer aktif).

---

### Dimensi 2 — Pipeline Trading End-to-End

Alur ditelusuri dari **ingestion → brain → risk → execution → reconciliation**:

#### a) Ingestion
- **AI-Engine:** proxy WebSocket **Binance** per-symbol (`/api/market/stream` SSE), fallback REST multi-exchange (Binance→Bybit→Kraken→Simulated), kline 15m/4h, depth 100ms. Single source dalam 1 proses.
- **KEEL:** `MultiSourceFeedManager` dengan **fallback berurutan Gate→Vision→Coinbase→Binance** per-kind (depth/trade) + auto-switch pada staleness 10s + metric msg/sec + `staleness-gate` (tick basi ditolak & di-audit) + **time-sync** dari Gate API (server-time tunggal, anti-timestamp-drift). Jauh lebih tangguh untuk LIVE.

#### b) Brain (decision)
- **AI-Engine:** `decisionEngine.ts` → POST `/api/ai-decision` (Gemini 3.8 Flash) + **fallback deterministik "algorithmic-mtf-hunter"** (analisis MTF liquidity-hunt). Ada provenance tagging per pilar (REAL/SIMULATED/STALE).
- **KEEL:** `mm-brain` penuh: **signal-generator → confluence-matrix → absorption-engine → wall-dynamics → smart-money-tracker → liquidity-mapper → entry-risk-engine → mtf-engine → temporal-memory → probability-engine (calibrated prob + EV, shadow-gate)**. Menggunakan depth/trades real, bukan cuma kline. Validasi zod `mmSignalSchema`. **Lebih "institusional" dan deterministik** (tidak bergantung LLM untuk integer eksekusi).

#### c) Risk
- **AI-Engine:** `riskGatekeeper.ts` deterministik (emergency-stop, max-drawdown, position-size%, risk-per-trade berbasis jarak SL, RR ≥1.5, confidence) + `guardrails.ts` (kill-switch, max daily loss, max open positions, cooldown). Keduanya di **in-memory/file JSON**.
- **KEEL:** `gatekeeper.ts` + `risk-constants` + `symbolGuard` (1 posisi/symbol, cooldown, max re-entry/hari) + macro-calendar FLAT-window + session-filter weekend + drawdown-monitor HWM + `risk_limits` singleton di DB yang di-`SELECT FOR UPDATE` (lock row saat evaluasi, mutation owner-only). Risk decision **di-persist + di-transition state machine + di-audit** dalam satu transaksi.

#### d) Execution
- **AI-Engine:** `tradingPipeline.ts` → `brokerService.ts`/`broker.ts` (ccxt) → paper atau live. Tidak ada idempotency key publik; order di-insert ke SQLite lalu ke broker.
- **KEEL:** `executor.ts`: alur **decision (PENDING) → insert order (PENDING, client_order_id idempoten) → adapter.placeOrder → REPORT → update order → transition decision (EXECUTED/REJECTED/FAILED) → insert position → arm OCO**. Terdapat: `ORDER_DISPATCHED`/`ORDER_RECONCILED` audit, **DB anti-race duplicate-position** (unique partial index `positions_one_open_per_symbol` → REJECT), **timeout → query exchange**, **recovery sweep** keputusan PENDING-yang-terjebak di boot, **reconcile OCO on boot**. Ini adalah standar eksekusi produksi.

#### e) Reconciliation
- **AI-Engine:** tidak ada stage reconciliation terpisah; hanya ada `generateLedgerStats` (win-rate, R, profit factor, max drawdown, equity curve) dari SQLite, dan `verifyLedger` (audit chain).
- **KEEL:** `ledger-sync.ts` → loop berkala membandingkan **local equity vs exchange equity**, breakdown per venue; bila selisih/`discrepancyUsd` tidak sinkron → **RECONCILIATION_BREACH → engage kill-switch + audit + Telegram alert**. Index record `reconciliation_reports` (append-only). Ini pilar yang **tidak dimiliki AI-Engine**, penting sekali untuk LIVE.

**Analisis:** KEEL lengkap 5 stage dengan *idempotensi, recovery, anti-race, OCO, reconciliation, dan auto-halt* — standar produksi. AI-Engine punya pipeline fungsional tapi **tanpa idempotensi, tanpa recovery crash, tanpa reconciliation vs exchange**. Untuk paper training itu cukup; untuk live itu resikonya besar (double-fill, posisi duplikat, mismatch balance tanpa deteksi).

---

### Dimensi 3 — DB Schema & Keamanan Data

| Aspek | AI-Engine (SQLite) | KEEL (PostgreSQL) |
|---|---|---|
| Mesin | `node:sqlite` (DatabaseSync), WAL + synchronous=FULL, FK ON | PostgreSQL 16 (Docker) via Drizzle; `numeric` untuk uang/ukuran (bukan float) |
| Multi-proses | **Tidak** — single writer SQLite | **Ya** — API & worker shared, connection pool |
| Audit trail | `audit_ledger` (hash chain + HMAC) idempotent-migration di file `db.ts` | `audit_logs` hash-chain + **`pg_advisory_xact_lock`** untuk serialisasi antar-proses + `hash-verifier` |
| **RLS** | Tidak ada (satu proses, satu "aktor") | **Row-Level Security aktif di seluruh tabel**, role `keel_app` non-superuser, `withActorContext` set `app.current_user_id` per transaksi |
| **RBAC DB** | Tidak ada | 3 role: **owner/viewer/system_agent**; owner-only untuk credentials/risk-limits/system-mode; system_agent-only untuk tulis decision/order/position |
| **FSM (state machine)** | Tidak ada — status order/posisi hanya kolom | **Trigger DB**: `decision_transitions_guard` (NULL→PENDING, PENDING→EXECUTED/REJECTED/FAILED sekali), `orders_fsm_guard` (PENDING→FILLED/PARTIALLY/REJECTED/CANCELLED), `risk_limits_value_guard`, `forbid_mutation` (append-only) |
| Append-only | Hanya audit_ledger | `audit_logs`, `decision_transitions`, `reconciliation_reports`, `kill_switch_events` **dikunci append-only via trigger + REVOKE UPDATE/DELETE** |
| Credentials | `.broker-secrets.json` (file, AES) | **`credentials` table** ciphertext+iv+authTag, owner-only RLS, `get_credential_ciphertext` escape-hatch untuk system_agent |
| Status/equity | portfolio_snapshots + orders/positions/fills/decisions | positions (is_open, unique partial index) + orders + decision + outcome ledger `signal_outcomes` (winrate/R) |
| ML features | — (decision di agent_decisions) | `signal_features` (feature-pack ML: session, weekend, macro, sentiment, density) + `signal_outcomes` → **bahan training ML yang rapi** |

**Analisis:** Keunggulan terbesar KEEL ada di sini. **RLS + FSM trigger + append-only enforcement** menjadikan integritas data **dijamin oleh DB**, bukan kepercayaan pada kode aplikasi. AI-Engine mengandalkan kadang-belum-sepakat antara memory-maps, SQLite, dan file JSON — rawan inkonsistensi di kondisi crash. Ketikan uang riil, "siapa yang boleh ubah status order" harus dijamin DB; AI-Engine tidak punya itu.

---

### Dimensi 4 — Keamanan & Compliance

| Aspek | AI-Engine | KEEL |
|---|---|---|
| Auth | Passcode tunggal (`AUTH_PASSCODE`, default `"paper-local"`), session Bearer token in-memory (hash sha256), TTL 24h | **JWT access + refresh rotation family** (`jose`), session token hash, OWASP reuse-revocation (rotasi dalam family, family di-revoke bila replay), cookie httpOnly+SameSite=Strict, **MFA TOTP opsional** (`x-mfa-code`) |
| RBAC | Single user (semua akses setara) | **owner/viewer/system_agent** via `requireRole()` middleware + RLS DB |
| Kill-switch | `.guardrails.json` (`setKillSwitch`), hanya manual & daily-loss; di-proses in-memory | **Multi-trigger**: manual owner, `mayAutoHalt` (drawdown), `RECONCILIATION_BREACH`, `AUDIT_HASH_CHAIN_TAMPER`, staleness. `kill_switch_events` append-only, `volatileLatch` **segera memblokir** sebelum DB confirm, Telegram alert + resolve |
| Vault | `.broker-secrets.json` + key file (AES via crypto) | tabel `credentials` AES-256-GCM, kunci fingerprint, **scope probe (anti spot-only violation)**, **global log-scrubber** (redact API keys dari semua log) |
| Rate limiting | `express-rate-limit` (api 300/min, login 10/min) | `src/middleware/ratelimit.ts` |
| Input validation | zod di beberapa route | **zod di middleware validation** + schema di semua signal |
| Helmet/CORS | helmet + CORS allowlist | CORS allowlist eksplisit |
| Idempotency | Tidak ada | `client_order_id` unique → redirect double-dispatch |
| Time sync | `Date.now()` | **timeService** tersinkron ke exchange (anti order timestamp-drift) |
| Audit tamper | `verifyLedger` (HMAC chain) — tidak auto-lockdown | `verifyAuditChain` → tamper terdeteksi → **auto engage kill-switch** |

**Analisis:** AI-Engine aman untuk **single-user lokal**, tapi passcode tunggal + session in-memory + guardrail file JSON tidak memadai untuk akun multi-user atau operasional live. KEEL memenuhi pola **defense-in-depth**: auth berlapis (JWT+MFA), RBAC di dua lapis (middleware **dan** RLS), vault terenkripsi dengan scrubber, kill-switch yang tidak bisa di-bypass, dan **audit yang mematikan eksekusi** bila di-tamper.

---

## 4. Rekomendasi

### Praktis: mana dipakai kapan
1. **AI-Engine → PAPER training / eksperimen strategi / demo UX.** Teruskan sebagai playground: cepat diputar, UI kaya, paper book solid, feedback loop instan. Gunakan untuk menguji **logika strategi, parameter, dan UI** tanpa biaya infra.
2. **KEEL → calon LIVE.** Jangan pakai AI-Engine untuk dana riil. Migrasi harus ke KEEL.

### Langkah konkret untuk menaikkan KEEL dari PAPER ke LIVE (berurutan)
1. **Validasi live adapter dengan paper-to-live toggle aman**: nyalakan `system_mode` LIVE hanya setelah *paper-full* harness berjalan 100% identik (sama format `OrderExecutionReport` di paper & binance-spot) & idempotency terverifikasi dengan exchange riil (test kecil, mis. $10 sekali).
2. **Buktikan reconciliation live** : konfirmasi `reconciliation_reports` akurat terhadap balance riil (flash-green) sebelum order riil apa pun.
3. **Uji kill-switch live** : engage & pastikan cancel-All + OCO cancel berjalan terhadap exchange sungguhan (test paper-broker-switch).
4. **Lengkapi UI KEEL** (frontend masih vanilla JS mentah vs React AI-Engine) — pindahkan komponen UX terbaik AI-Engine (RiskManagementPanel, PositionsPanel, AuditLedgerModal) ke KEEL bila ingin operasional sehari-hari.
5. **Hardening keamanan** : aktifkan MFA untuk owner, nonaktifkan default passcode/password (KEEL sudah hindari default), set `NODE_ENV=production` (cookie Secure), kunci `VAULT_MASTER_KEY`.

### Prioritas gap (jika mau terus AI-Engine untuk keperluan lain)
- Tambahkan **idempotency key** & **reconciliation vs broker** bila ingin AI-Engine dipakai semi-live.
- Pindah state guardrails (kill-switch/daily-loss) dari `.json` ke **DB** (SQLite boleh) agar konsisten dengan book.
- Pisahkan **adapter exchange** dari server monolit, dan tambahkan audit tamper → auto-block.

### Kesimpulan akhir
> **AI-Engine = lab untuk strategi (PAPER). KEEL = engine produksi (LIVE).**
> Keduanya melengkapi: iterasi strategi cepat di AI-Engine, lalu porting logika (MTF, risk, sizing) ke pipeline KEEL yang sudah punya keamanan, FSM, reconciliation, dan recovery. Di kondisi sekarang **hanya KEEL yang layak dibuka ke LIVE**, dan itupun setelah live-smoke-test kecil dilakukan.

---
*Audit berbasis pembacaan kode sumber kedua repo (tidak membaca `.env`/secret). Skor 1–5 relatif terhadap ketentuan produksi trading-keuangan, bukan sekadar "berfungsi".*
