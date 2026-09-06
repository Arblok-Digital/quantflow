# PRODUCTION ROADMAP — AI Trading Agent Engine

> Hasil audit 2026-09-06. Status awal: **~35% production-ready**.
> Aturan emas: **SETIAP pekerjaan backend WAJIB punya pasangan FE** — kalau agent/server mengerjakan sesuatu, UI harus menunjukkannya (apa, kenapa, kapan, hasil apa).
> Target: **Paper mode = 100%可信 (trustworthy) dulu**, baru Live mode dengan guardrails.

Legenda: `[ ]` todo · Prioritas P0 = blocker produksi, P1 = wajib sebelum live, P2 = polish/ops.

---

## PHASE 0 — Fund Ops (P0, sekali jalan)

- [ ] **0.1** `git init` + `.gitignore` dicek + commit awal (project belum version control!)
- [ ] **0.2** `package.json`: rename `"react-example"` → `ai-trading-agent-engine`; ganti README template AI Studio dengan README asli (arsitektur, cara run, mode paper/live)
- [ ] **0.3** Hapus artefak AI Studio yang tidak dipakai (`metadata.json`) atau repurpose jadi file manifest proyek
- [ ] [FE] — (tidak ada UI; ini fondasi)

## PHASE 1 — Execution Wire-Up: Pipeline → Broker Asli (P0, INTI DARI SEMUA PEKERJAAN)

Masalah sekarang: `src/pipeline/brokerService.ts` = simulator pura-pura (slippage random, HMAC secret dummy, latency karangan). Endpoint `/api/broker/order` di server tidak pernah dipanggil. Live path = dead code.

- [ ] **1.1** Ganti isi `executeBrokerOrder()` client → `fetch POST /api/broker/order`; hapus semua fake slippage/signature/latency dari client (server yang produce data eksekusi)
- [ ] **1.2** Tambah BE: `GET /api/broker/positions` (fetch positions/orders dari exchange + posisi paper yang tersimpan) — posisi TIDAK boleh hidup di React state saja
- [ ] **1.3** Tambah BE: `POST /api/broker/close` (close posisi: market order lawan arah; live pakai reduceOnly), `POST /api/broker/cancel` untuk limit order
- [ ] **1.4** Tambah BE: TP/SL exchange-native untuk live (conditional order: stopMarket + takeProfitMarket di Binance Futures; fallback: server-side bracket monitor yang polling harga & auto-close)
- [ ] **1.5** Tambah BE: `GET /api/broker/order-status/:id` (poll partial fill / rejected / filled) → status order real, bukan langsung `FILLED`
- [ ] **1.6** Paper fill realistis di server: pakai bid/ask + book depth untuk estimate slippage (bukan `Math.random()`), fee maker/taker beda, leverage → margin & liquidation price dihitung beneran (maintenance margin, bukan hardcode ±10%)
- [ ] [FE] **1.7** Panel **Execution Console**: setiap cycle pipeline menampilkan — order request (symbol/side/qty/leverage), rute yang dipanggil (`/api/broker/order`), response server (fill price, fee, slippage bps TERUKUR, order id, status lifecycle NEW→PARTIALLY_FILLED→FILLED/REJECTED), mode badge besar `PAPER` vs `LIVE`
- [ ] [FE] **1.8** **Open Positions Table real-time** dari `/api/broker/positions` (bukan state lokal): entry, mark, uPnL, SL/TP yang aktif di exchange, liq price, tombol Close / Move-to-BE yang memanggil BE & menampilkan response
- [ ] [FE] **1.9** **Order Lifecycle Stream** (decision → risk gate → submit → ack → fill) sebagai timeline per order, warna status jelas

**Acceptance Phase 1:** paper mode menghasilkan trade journal yang isinya 100% berasal dari server (tidak ada angka yang di-random di browser); kill server → UI menunjuk "disconnected", bukan lanjut trading diam-diam.

## PHASE 2 — Server-Side Guardrails & Security (P0, WAJIB sebelum TRADING_MODE=live dipakai)

Masalah sekarang: risk gate & kill-switch cuma di client; server bind 0.0.0.0 tanpa auth; siapa di LAN bisa place order / inject API key.

- [x] **2.1** Bind default `127.0.0.1` (env `HOST` untuk override) + `helmet` + `cors` allowlist
- [ ] [FE] **2.2** **Auth Gate UI**: layar unlock (passphrase/login lokal) → token sesi di-send sebagai `Authorization: Bearer` ke semua rute broker; server validasi token di SEMUA endpoint non-public
- [x] **2.3** **Server-side risk enforcement** di `placeBrokerOrder`: kill-switch flag, max daily loss, max open positions, max margin per posisi, cooldown antar order — order ditolak server dengan alasan eksplisit
- [ ] [FE] **2.4** **Guardrails Panel**: tampilkan config risk yang aktif di server + status tiap guard (arm/disarm, daily PnL vs limit, jumlah posisi vs cap, remaining cooldown). Kill-switch button = API call ke server (bukan toggle UI saja), dengan confirm dialog
- [x] **2.5** Rate limit (express-rate-limit) di semua /api
- [x] **2.6** Vault credential: enkripsi at-rest beneran (DPAPI via machine key / AES dengan key turunan passphrase), catatan: `mode: 0o600` di Windows TIDAK berfungsi; tambah `GET /api/broker/credentials/status` (mask key, tampilkan 4 char terakhir + exchange + testnet)
- [ ] [FE] **2.7** KeyVaultModal redesign: tampilkan source credential (env vs vault), fingerprint key, testnet badge, tombol revoke yang memanggil `/credentials/clear` + konfirmasi
- [x] **2.8** Live-mode double-lock: order live hanya jalan jika `TRADING_MODE=live` **DAN** vault punya flag `liveArmed: true` yang di-set lewat UI dengan konfirmasi ketik manual (anti one-click money loss)
- [ ] [FE] **2.9** Banner merah permanen `LIVE TRADING ARMED` + equity real vs paper di header saat mode live

**Acceptance Phase 2:** semua penolakan order berasal dari server dengan reason code; UI tidak bisa lagi jadi satu-satunya penjaga risiko.

## PHASE 3 — Persistence & Audit Ledger sungguhan (P0)

Masalah sekarang: posisi/portfolio/ledger hilang saat refresh; hash chain client-side; ada seed data palsu yang mencemari metrik.

- [ ] **3.1** BE: simpan di **SQLite** (better-sqlite3): orders, fills, positions, portfolio snapshots, audit ledger, agent decisions (prompt+response+latency)
- [ ] **3.2** BE: audit entry di-generate & di-sign SERVER (HMAC pakai secret asli dari env), prevHash chaining antar baris DB, endpoint `GET /api/ledger` (pagination) + `GET /api/ledger/verify` (recompute chain, laporkan tamper)
- [ ] **3.3** Hapus SEMUA seed data palsu (`INITIAL_POSITIONS`, `INITIAL_CLOSED_TRADES`, fake balance `9973.5` di broker.ts) — akun paper mulai kosong & jujur; seed hanya untuk "demo mode" via env terpisah
- [ ] [FE] **3.4** **Audit Ledger Modal v2**: baca dari `/api/ledger` (persisten), ada tombol **Verify Chain** → hasil verifikasi server ditampilkan (valid/suspect per blok), filter per decision/order/exit
- [ ] [FE] **3.5** **Trade Journal + Equity Curve** historis dari DB (bukan in-memory): win rate, avg R, profit factor, drawdown, slippage terukur per order
- [ ] **3.6** FE: reset `usePaperTrading` jadi reader dari BE state (portfolio sync via polling/WS), hapus mark-to-market ganda di client

**Acceptance Phase 3:** restart server & refresh browser → semua posisi, ledger, dan jurnal tetap ada dan cocok dengan DB.

## PHASE 4 — Decision Engine Integrity (P1)

Masalah sekarang: LLM di-feed data fabricated; output tak divalidasi; fallback confidence dijamin lolos gate sendiri.

- [ ] **4.1** Validasi keluaran LLM pakai **zod schema** di server: action enum, angka finite, `stopLoss` harus di sisi yang benar terhadap harga (BUY: SL < price < TP, SELL: kebalikannya), clamp `positionSizePercent` ke config risk, reject → fallback eksplisit
- [ ] **4.2** Verifikasi/fix model ID Gemini (cek `gemini-3.8-flash` benar-benar ada di API; kalau tidak → `gemini-2.5-flash` / model yang tersedia), tambah unit test mock call
- [ ] **4.3** **Fix self-bypass gate**: fallback engine tidak boleh pakai `Math.max(minConfidence, 86)` — laporkan confidence apa adanya, biarkan risk gate bekerja
- [ ] **4.4** **Data honesty layer**: setiap input prompt diberi tag sumber `REAL` / `SIMULATED` / `STALE(>Nmenit)`; simpan tag ini di audit entry
- [ ] [FE] **4.5** **Decision Card v2 di DecisionStream**: tampilkan prompt ringkas yang dikirim, response mentah LLM (expandable), confidence + **source badges per pilar** (Market: REAL, Liquidity volume: SIMULATED, On-chain: SIMULATED, Macro: SIMULATED), latency inference terukur nyata
- [ ] **4.6** Ganti angka fabricated di `liquidityHunt.ts` (`volume % 15`, leverage tiers hardcode): estimasi likuiditas dihitung dari **order book depth asli** di sekitar level (server sudah punya depth); kalau tidak memungkinkan → label `EST.` di UI
- [ ] **4.7** Ganti macro calendar hardcode: adaptor real (ForexFactory mirror / Trading Economics free tier) via registry `data/provider.ts`; fail → tampilkan "no data", JANGAN tampilkan fiktif
- [ ] **4.8** On-chain: endpoint `/api/onchain/bitcoin` sudah real (pertahankan) — tambah netflow/MVRV dari sumber gratis yang beneran (mempool.space, blockchair, coinglass public) atau tandai SIMULATED & buang dari prompt LLM sampai real
- [ ] **4.9** [FE] MakroCalendarPanel & OnChainPanel: badge REAL/SIMULATED per metrik + timestamp terakhir kali data nyata di-fetch (user harus bisa bedain mana fakta mana simulasi)

**Acceptance Phase 4:** tidak ada satu pun angka di UI maupun prompt LLM yang appear sebagai data real padahal generated — semua bersumber atau berlabel.

## PHASE 5 — Market Data Real-Time sungguhan (P1)

Masalah sekarang: harga 1s adalah random-walk sintetis yang di-revert ke anchor tiap 20s; ini dipasarkan sebagai "1s ML Feed".

- [ ] **5.1** BE: **WebSocket** Binance (`wss stream: trade + depth`) → push ke client via SSE/WS server; candle 1s/1m dari tick asli, bukan simulasi
- [ ] **5.2** Fallback tetap REST polling + interpolate, TAPI UI menampilkan badge "INTERPOLATED" saat WS mati
- [ ] [FE] **5.3** Realtime1sMLFeed: sumber feed terlihat (WS live / REST / SIMULATED), counter message rate, indikator detak koneksi
- [ ] **5.4** Perbaiki `priceDelta` di useMarketData (rumor `+ delta * 10` — skala arbitrer) → delta 24h asli dari ticker
- [ ] **5.5** Fix symbol parsing `/api/market-feed` (kasus `USDC/USDT`, pair quote non-USDT)

## PHASE 6 — Correctness & Paper Bias (P1)

- [ ] **6.1** Fix same-tick TP-prioritas-SL di `processPriceTick`: kalau satu bar/candle melewati keduanya → anggap **SL kena dulu** (conservative bias, win rate paper jadi jujur)
- [ ] **6.2** Fix akuntansi leverage: cash yang dikurangi = margin (notional/leverage), equity = cash + margin terikat + uPnL; margin call simulation saat harga ↔ liq price
- [ ] **6.3** Sinkronisasi tunggal: satu sumber kebenaran harga (server tick) yang dipakai pipeline, chart, DAN portfolio — tidak ada dua jalur mark-to-market
- [ ] [FE] **6.4** ExecutionMetrics: hapus semua angka latency karangan (`+2`, `+1`, `+8` hardcode); tampilkan latency nyata per stage yang dilaporkan server

## PHASE 7 — Test & CI (P1, syarat "production")

- [ ] **7.1** Vitest: unit test untuk `riskGatekeeper` (setiap gate reject/approve), `liquidityHunt` (swing detect, sweep detect, edge case candles < 5), `decisionEngine` fallback, validasi zod LLM output, kalkulasi margin/liq price
- [ ] **7.2** Integration test broker: paper order lifecycle pakai ccxt mock; test penolakan guardrails (kill-switch on, daily loss tercapai)
- [ ] **7.3** CI (GitHub Actions): `tsc --noEmit` + eslint + vitest di setiap push
- [ ] **7.4** Smoke test manual script: `npm run build && npm start` → health check semua endpoint

## PHASE 8 — Ops & Go-Live Hardening (P2, sebelum live uang riil)

- [ ] **8.1** Logging terstruktur (pino) + file log request/response broker (mask apiKey), error tracking (Sentry opsional)
- [ ] **8.2** Dockerfile + docker-compose (app + volume sqlite) buat deploy konsisten
- [ ] **8.3** Watchdog: heartbeat exchange ↔ server ↔ browser; kalau salah satu putus, agent auto-pause DAN UI freeze dengan alasan
- [ ] **8.4** Reconnect/rehydrate: setelah restart, server re-sync posisi open dari exchange (live) / DB (paper) → UI otomatis cocok
- [ ] **8.5** [FE] **Agent Status Panel** (baru): uptime, RPC/exchange latency, last cycle time, jumlah cycle, error counter, mode — "kotak hitam" agent yang bisa dibaca user dalam 5 detik
- [ ] [FE] **8.6** [FE] **Notification Center**: toast + list untuk decision taken, order filled/rejected, guardrail menolak, WS disconnect, drawdown warning
- [ ] **8.7** Backfill/forward-test mode: replay data historis melalui pipeline tanpa order (validasi strategi sebelum modal) + [FE] panel hasil forward-test
- [ ] **8.8** Checklist go-live paper → live: documented di README (testnet dulu → small capital → scale)

---

## Definisi Selesai (Definition of Done per item BE)

Setiap task backend baru dianggap selesai kalau:
1. Endpoint/server logic bekerja & di-test (minimal 1 test).
2. **ADA UI yang menampilkan kerjanya** — request, response, status, error, dan timestamp.
3. Error state UI ditangani (loading, failed, disconnected) — bukan silent fallback ke angka palsu.
4. Audit ledger mencatat kejadian tersebut dengan sumber `REAL`.

## Urutan Eksekusi (buat delegasi)

```
Phase 0 (fondasi, <1 hari)
 → Phase 1 (wire-up eksekusi)  ← paling penting
 → Phase 2 (guardrails/security)
 → Phase 3 (persistence)
 → Phase 4 (decision integrity)
 → Phase 5 (WS feed)
 → Phase 6 (correctness)
 → Phase 7 (tests/CI)          ← bisa paralel mulai Phase 3
 → Phase 8 (ops, sebelum live)
```

**Gate:** Phase 1–3 selesai → Paper mode bisa dipercaya.
**Gate:** Phase 4–7 selesai → boleh mempertimbangkan `TRADING_MODE=live` dengan testnet.
Uang riil hanya setelah Phase 8 + forward-test.
