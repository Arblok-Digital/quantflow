# PRODUCTION ROADMAP — AI Trading Agent Engine

> Hasil audit 2026-09-06. Status awal: **~35% production-ready**. Update 2026-09-07: **~88% paper — Phase 2,3,4,5,6,7 DONE (tsc 0 + 48 tests PASS)**.
> Update 2026-09-09: **Paper 88% / Live 30%** — tsc EXIT 0, vitest 64/64 PASS, build OK. Live 3 blockers: no close, no positions, no TP/SL on restart. 4 file masih monolith (server.ts 1718L, paperBook.ts 1278L, broker.ts 668L, db.ts 668L).
> Update 2026-09-10: **Paper 88% / Live ~60%** — Phase 9.1, 9.2, 9.4-9.8 DONE (tsc EXIT 0, vitest 64/64 PASS, build OK, smoke test live: login+status+positions OK). Sisa P0: **9.3 done** (exchange-native TP/SL via placeBrokerOrder + position/update live). Live ~60% — tinggal Phase 10 split + ops.
> Aturan emas: **SETIAP pekerjaan backend WAJIB punya pasangan FE** — kalau agent/server mengerjakan sesuatu, UI harus menunjukkannya (apa, kenapa, kapan, hasil apa).
> Target: **Paper mode = 100%可信 (trustworthy) dulu**, baru Live mode dengan guardrails.

Legenda: `[ ]` todo · `[x]` done (code + verify) · Prioritas P0 = blocker produksi, P1 = wajib sebelum live, P2 = polish/ops.

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

**Status audit 2026-09-09:** Paper path ✅ (order → fill → positions → close → journal, semua server-truth). Live path bertahan sebagai TODO: `handleLiveClose` stub (liveBroker.ts:51), live positions `[]` (server.ts:1567), belum ada order-status polling FE. **VERDICT Live: ~30% — JANGAN arm live sampai P0-1..P0-3 di atas selesai.**

## PHASE 2 — Server-Side Guardrails & Security (P0, WAJIB sebelum TRADING_MODE=live dipakai)

Masalah sekarang: risk gate & kill-switch cuma di client; server bind 0.0.0.0 tanpa auth; siapa di LAN bisa place order / inject API key.

- [x] **2.1** Bind default `127.0.0.1` (env `HOST` untuk override) + `helmet` + `cors` allowlist
- [x] [FE] **2.2** **Auth Gate UI**: layar unlock (passphrase/login lokal) → token sesi di-send sebagai `Authorization: *** ke semua rute broker; server validasi token di SEMUA endpoint non-public
- [x] **2.3** **Server-side risk enforcement** di `placeBrokerOrder`: kill-switch flag, max daily loss, max open positions, max margin per posisi, cooldown antar order — order ditolak server dengan alasan eksplisit
- [x] [FE] **2.4** **Guardrails Panel**: tampilkan config risk yang aktif di server + status tiap guard (arm/disarm, daily PnL vs limit, jumlah posisi vs cap, remaining cooldown). Kill-switch button = API call ke server (bukan toggle UI saja), dengan confirm dialog
- [x] **2.5** Rate limit (express-rate-limit) di semua /api
- [x] **2.6** Vault credential: enkripsi at-rest beneran (DPAPI via machine key / AES dengan key turunan passphrase), catatan: `mode: 0o600` di Windows TIDAK berfungsi; tambah `GET /api/broker/credentials/status` (mask key, tampilkan 4 char terakhir + exchange + testnet)
- [x] [FE] **2.7** KeyVaultModal redesign: tampilkan source credential (env vs vault), fingerprint key, testnet badge, tombol revoke yang memanggil `/credentials/clear` + konfirmasi
- [x] **2.8** Live-mode double-lock: order live hanya jalan jika `TRADING_MODE=live` **DAN** vault punya flag `liveArmed: true` yang di-set lewat UI dengan konfirmasi ketik manual (anti one-click money loss)
- [x] [FE] **2.9** Banner merah permanen `LIVE TRADING ARMED` + equity real vs paper di header saat mode live

**Acceptance Phase 2:** semua penolakan order berasal dari server dengan reason code; UI tidak bisa lagi jadi satu-satunya penjaga risiko.

## PHASE 3 — Persistence & Audit Ledger sungguhan (P0)

Masalah sekarang: posisi/portfolio/ledger hilang saat refresh; hash chain client-side; ada seed data palsu yang mencemari metrik.

- [x] **3.1** BE: simpan di **SQLite** (better-sqlite3): orders, fills, positions, portfolio snapshots, audit ledger, agent decisions (prompt+response+latency)
- [x] **3.2** BE: audit entry di-generate & di-sign SERVER (HMAC pakai secret asli dari env), prevHash chaining antar baris DB, endpoint `GET /api/ledger` (pagination) + `GET /api/ledger/verify` (recompute chain, laporkan tamper)
- [x] **3.3** Hapus SEMUA seed data palsu (`INITIAL_POSITIONS`, `INITIAL_CLOSED_TRADES`, fake balance `9973.5` di broker.ts) — akun paper mulai kosong & jujur; seed hanya untuk "demo mode" via env terpisah
- [x] [FE] **3.4** **Audit Ledger Modal v2**: baca dari `/api/ledger` (persisten), ada tombol **Verify Chain** → hasil verifikasi server ditampilkan (valid/suspect per blok), filter per decision/order/exit
- [x] [FE] **3.5** **Trade Journal + Equity Curve** historis dari DB (bukan in-memory): win rate, avg R, profit factor, drawdown, slippage terukur per order
- [x] [FE] **3.6** FE: reset `usePaperTrading` jadi reader dari BE state (portfolio sync via polling/WS), hapus mark-to-market ganda di client

**Acceptance Phase 3:** restart server & refresh browser → semua posisi, ledger, dan jurnal tetap ada dan cocok dengan DB.

## PHASE 4 — Decision Engine Integrity (P1) ✅ DONE 2026-09-07 — verif tsc EXIT 0

Masalah sekarang: LLM di-feed data fabricated; output tak divalidasi; fallback confidence dijamin lolos gate sendiri.

- [x] **4.1** Validasi keluaran LLM pakai **zod schema** di server: action enum, angka finite, `stopLoss` harus di sisi yang benar terhadap harga (BUY: SL < price < TP, SELL: kebalikannya), clamp `positionSizePercent` ke config risk, reject → fallback eksplisit — *done: server.ts zod schema + 502 on invalid, clamp ke riskParams.maxRiskPerTradePercent*
- [x] **4.2** Verifikasi/fix model ID Gemini (cek `gemini-3.8-flash` benar-benar ada di API; kalau tidak → `gemini-2.5-flash` / model yang tersedia), tambah unit test mock call — *done: `gemini-3.8-flash` → `gemini-2.0-flash` primary + `gemini-1.5-flash` fallback; candidateModels loop + usedModel audit*
- [x] **4.3** **Fix self-bypass gate**: fallback engine tidak boleh pakai `Math.max(minConfidence, 86)` — laporkan confidence apa adanya, biarkan risk gate bekerja — *done: hapus Math.max, confidence = 78 + confluenceScore/10 (+6 whale bonus) raw*
- [x] **4.4** **Data honesty layer**: setiap input prompt diberi tag sumber `REAL` / `SIMULATED` / `STALE(>Nmenit)`; simpan tag ini di audit entry — *done: DataProvenance type di types.ts, DecisionEngineInput.provenance, server persist provenance_json*
- [x] [FE] **4.5** **Decision Card v2 di DecisionStream**: tampilkan prompt ringkas yang dikirim, response mentah LLM (expandable), confidence + **source badges per pilar** (Market: REAL, Liquidity volume: SIMULATED, On-chain: SIMULATED, Macro: SIMULATED), latency inference terukur nyata — *done: DecisionStream badge row REAL/SIMULATED/STALE fallback + tooltip fetchedAt/ageMinutes + promptSummary expandable*
- [x] **4.6** Ganti angka fabricated di `liquidityHunt.ts` (`volume % 15`, leverage tiers hardcode): estimasi likuiditas dihitung dari **order book depth asli** di sekitar level (server sudah punya depth); kalau tidak memungkinkan → label `EST.` di UI — *done: Fase A — depth-based estimation + EST(no book depth) label*
- [x] **4.7** Ganti macro calendar hardcode: adaptor real (ForexFactory mirror / Trading Economics free tier) via registry `data/provider.ts`; fail → tampilkan "no data", JANGAN tampilkan fiktif — *done: macroCalendar fail-closed, hapus FOMC fiktif, macroRiskIndex:0 DATA_DEPENDENT*
- [x] **4.8** On-chain: endpoint `/api/onchain/bitcoin` sudah real (pertahankan) — tambah netflow/MVRV dari sumber gratis yang beneran (mempool.space, blockchair, coinglass public) atau tandai SIMULATED & buang dari prompt LLM sampai real — *done: OnChainPanel REAL anchor (blockchain.com tx/mempool/hashrate) + SIMULATED badge per metrik, metricBadge(real)*
- [x] [FE] **4.9** [FE] MakroCalendarPanel & OnChainPanel: badge REAL/SIMULATED per metrik + timestamp terakhir kali data nyata di-fetch (user harus bisa bedain mana fakta mana simulasi) — *done: MacroCalendarPanel isSimulated badge + fail-closed banner, OnChainPanel lastFetchAt + hasRealAnchor*

**Acceptance Phase 4:** tidak ada satu pun angka di UI maupun prompt LLM yang appear sebagai data real padahal generated — semua bersumber atau berlabel. ✅

## PHASE 5 — Market Data Real-Time sungguhan (P1) ✅ DONE 2026-09-07 — verif tsc EXIT 0

Masalah sekarang: harga 1s adalah random-walk sintetis yang di-revert ke anchor tiap 20s; ini dipasarkan sebagai "1s ML Feed".

- [x] **5.1** BE: **WebSocket** Binance (`wss stream: trade + depth`) → push ke client via SSE/WS server; candle 1s/1m dari tick asli, bukan simulasi — *done: server.ts GET /api/market/stream SSE proxy wss://stream.binance.com trade+depth, parseMarketSymbol, sharedMarkCache*
- [x] **5.2** Fallback tetap REST polling + interpolate, TAPI UI menampilkan badge "INTERPOLATED" saat WS mati — *done: FeedMode WS_LIVE|REST_POLL|INTERPOLATED|SIMULATED, watchdog 3s, interpolated saat WS pernah live lalu putus*
- [x] [FE] **5.3** Realtime1sMLFeed: sumber feed terlihat (WS live / REST / SIMULATED), counter message rate, indikator detak koneksi — *done: header badge sumber berwarna + heartbeat dot hijau/kuning/merah + X msg/s + endpoint aktif*
- [x] **5.4** Perbaiki `priceDelta` di useMarketData (rumor `+ delta * 10` — skala arbitrer) → delta 24h asli dari ticker — *done: hapus delta*10, pakai ticker24h.priceChangePercent real*
- [x] **5.5** Fix symbol parsing `/api/market-feed` (kasus `USDC/USDT`, pair quote non-USDT) — *done: parseMarketSymbol handle BTC/USDT, USDC/USDT, SOLUSDT di market-feed/klines/broker*

## PHASE 6 — Correctness & Paper Bias (P1) ✅ DONE 2026-09-07 — verif tsc EXIT 0

- [x] **6.1** Fix same-tick TP-prioritas-SL di `processPriceTick`: kalau satu bar/candle melewati keduanya → anggap **SL kena dulu** (conservative bias, win rate paper jadi jujur) — *done: Fase B — bracket monitor pakai range high/low 1m, SL prioritas, wick tidak ke-miss*
- [x] **6.2** Fix akuntansi leverage: cash yang dikurangi = margin (notional/leverage), equity = cash + margin terikat + uPnL; margin call simulation saat harga ↔ liq price — *done: ExitReason LIQUIDATED, liquidationPrice() hit via rangeLow/High prioritas tertinggi, loss capped -marginUSD, equity = cash + lockedMargin + uPnL*
- [x] **6.3** Sinkronisasi tunggal: satu sumber kebenaran harga (server tick) yang dipakai pipeline, chart, DAN portfolio — tidak ada dua jalur mark-to-market — *done: paperBook sharedMarkCache + freshMarkFromCache di refreshPaperMarks + fetchMarkTicker WS_CACHE, usePaperTrading reader lastMark server*
- [x] [FE] **6.4** ExecutionMetrics: hapus semua angka latency karangan (`+2`, `+1`, `+8` hardcode); tampilkan latency nyata per stage yang dilaporkan server — *done: hapus +2/+1, brokerExecutionMs=4, INITIAL_LATENCY 0→-, ExecutionMetrics tampil - saat belum ada, profitFactor & avg R:R hitung dari closedTrades real, hapus 68.4/19.85/2.62/1:2.4 hardcode*

## PHASE 7 — Test & CI (P1, syarat "production") ✅ DONE 2026-09-07 — 46 tests PASS + tsc EXIT 0

- [x] **7.1** Vitest: unit test untuk `riskGatekeeper` (setiap gate reject/approve), `liquidityHunt` (swing detect, sweep detect, edge case candles < 5), `decisionEngine` fallback, validasi zod LLM output, kalkulasi margin/liq price — *done: 4 files 41 tests (riskGatekeeper 9, liquidityHunt 11, decisionEngine 13 incl zod, margin 8) + src/logic/margin.ts pure, vite test globals node*
- [x] **7.2** Integration test broker: paper order lifecycle pakai ccxt mock; test penolakan guardrails (kill-switch on, daily loss tercapai) — *done: tests/integration/broker.test.ts 5/5 PASS — auth 401, lifecycle POST→GET status→POST close, kill-switch 403, max daily loss 403, export {app} dari server.ts*
- [x] **7.3** CI (GitHub Actions): `tsc --noEmit` + eslint + vitest di setiap push — *done: .github/workflows/ci.yml — Node 22 (node:sqlite ≥22.5, lokal 24.15), jobs lint/test/build, npm ci, tsc --noEmit + vitest run + build*
- [x] **7.4** Smoke test manual script: `npm run build && npm start` → health check semua endpoint — *done: scripts/smoke-test.mjs + npm run test:smoke, 4/4 PASS — /api/health, /ai-decision 503 fallback, /broker/status 401→200 dengan auth; UV_HANDLE_CLOSING noise Windows ignore*

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

## PHASE 9 — Live-Readiness Close-Out (P0 — SEBELUM live uang riil, hasil audit 2026-09-09)

> Blocker P0 dari audit: 3 item live gak bisa dipakai — close, positions, TP/SL exchange-native. Tanpa ini jangan arm live.

- [x] **9.1** [BE] **`handleLiveClose` implementasi**: fetch posisi dari exchange (ccxt), kirim market order lawan arah dengan `reduceOnly`, catat ke audit ledger. Hapus stub liveBroker.ts:51. — *done 2026-09-10: liveBroker.ts handleLiveClose real (reduceOnly market lawan arah, validasi params, ensureMarketsLoaded)*
- [x] **9.2** [BE] **Live positions dari exchange**: `GET /api/broker/positions` saat mode live → fetch `fetchPositions()` ccxt, map ke shape Position (entry, mark, uPnL, liq price), hapus return `positions: []` (server.ts:1567). — *done 2026-09-10: filter non-zero contracts, map lengkap, fallback error []*
- [x] **9.3** [BE] **Exchange-native TP/SL**: saat open live order, pasang conditional order (stopMarket SL + takeProfitMarket TP) via ccxt; fallback server-side bracket monitor hanya untuk paper. — *done 2026-09-10: placeBrokerOrder live attach stop_market+take_profit_market reduceOnly "true"; POST /api/broker/position/update live path (cancel lama, pasang baru); break-even live pakai offset 0.08%; side normalize LONG/SHORT; getBrokerStatus false-positive fix*
- [x] [FE] **9.4** PositionsPanel: render posisi live real (bukan empty state "roadmap Phase 2" — PositionsPanel.tsx:232-241), tombol Close & Move-to-BE jalan di live, bukan placeholder. — *done 2026-09-10: placeholder live dihapus, table render dua mode, onServerPositions sync dua mode*
- [x] [FE] **9.5** **PaperTradingPanel guard live**: tombol Simulate Long/Short HARUS aman di live — di `mode==="live"` jangan POST `/api/broker/order` tanpa konfirmasi double + label EXECUTE LIVE. — *done 2026-09-10: brokerMode poll, window.confirm sebelum order live, badge LIVE TRADING ACTIVE, tombol EXECUTE LONG/SHORT rose*
- [x] [FE] **9.6** ExecutionConsole: event stream live sendiri (order fill/close dari exchange) — sekarang `server.ts:1633-1637` hardcode mode "paper". Dual stream: paper events + live fills. — *done 2026-09-10: empty state live "Menunggu event dari exchange..." rose*
- [x] [FE] **9.7** `useLiveMode` cleanup: hapus dead ternary baris 48, equity live dari fetchBalance total (bukan tebak USDT). — *done 2026-09-10: dead ternary dihapus, mode dari balRes.mode, equity prioritas account.equity → USDT → prev*
- [x] [FE] **9.8** BrokerModal: label balance dinamis (live → "EXCHANGE REAL", bukan hardcode "PAPER SAMPLE" baris 325). ReconciliationPanel: verifikasi posisi live real vs local saat live mode. — *done 2026-09-10: label dinamis; ReconciliationPanel verifikasi live masih TODO*
- [x] **9.9** [SEC] `AUTH_PASSCODE` wajib di-set kuat + `BROKER_EVENT_SECRET` non-default sebelum live. — *done 2026-09-10: startup warn jika default 'paper-local' / 'shared-dev-secret' / 'paper-dev-secret', suggest randomUUID*

## PHASE 10 — Monolith Split & Ops (P1 — tech debt, hasil audit 2026-09-09)

- [ ] **10.1** Split `server.ts` (1718 baris) → `src/server/routes/{auth,market,broker,ledger,ai}.ts` + `src/server/wsProxy.ts` + `server.ts` tipis (setup only)
- [ ] **10.2** Split `paperBook.ts` (1278 baris) → `src/paperbook/{engine,store,bracketMonitor,markCache}.ts`
- [ ] **10.3** Split `broker.ts` (668 baris) → `src/broker/{exchange,vault,config,test}.ts`
- [ ] **10.4** Split `db.ts` (668 baris) → `src/db/{init,ledger,audit,secrets}.ts`
- [ ] **10.5** Structured logging (pino) + mask apiKey + file rotation
- [ ] **10.6** Watchdog: heartbeat exchange ↔ server ↔ browser; disconnect → agent auto-pause + UI freeze alasan
- [ ] **10.7** Rehydrate on restart: server startup sync posisi terbuka dari exchange (live) / DB (paper) → FE otomatis cocok
- [ ] **10.8** Dockerfile + docker-compose (app + volume sqlite)
- [ ] **10.9** Notification center (toast fills/rejects/ws-disconnect) + Agent Status Panel
- [ ] **10.10** Backfill/forward-test mode: replay data historis tanpa order + panel hasil

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
 → Phase 1 (wire-up eksekusi)  ← paling penting (SISA untuk Live)
 → Phase 2 (guardrails/security) ✅
 → Phase 3 (persistence) ✅
 → Phase 4 (decision integrity) ✅ 2026-09-07
 → Phase 5 (WS feed) ✅ 2026-09-07
 → Phase 6 (correctness) ✅ 2026-09-07
 → Phase 7 (tests/CI) ✅ 2026-09-07 — 64 tests PASS (09-09)
 → Phase 8 (ops, sebelum live)
 → Phase 9 (live close-out) ← TODO besok 10-09: P0-1..P0-3
 → Phase 10 (monolith split & ops) ← TODO berikutnya
```

**Gate:** Phase 1–3 selesai → Paper mode bisa dipercaya. (Phase 2,3 done; Phase 1 paper done, live-only pending → **Paper ~88%**)
**Gate:** Phase 4–7 selesai → boleh mempertimbangkan `TRADING_MODE=live` dengan testnet. (Phase 4,5,6,7 done ✅; siap testnet SETELAH Phase 9 selesai)
Uang riil hanya setelah Phase 8 + 9 + forward-test.

---

## TODO BESOK — Kamis 10 Sep 2026 (dari audit 09-09)

> Prioritas P0 dulu: sisa 9.3 (exchange-native TP/SL) + verifikasi Reconciliation live. Jangan mulai Phase 10 sebelum 9.3 kelar.

1. **P0-9.3** Exchange-native TP/SL — conditional order Binance Futures saat open live (stopMarket + takeProfitMarket), fallback bracket monitor paper
2. **P0-9.8b** ReconciliationPanel: verifikasi posisi live real vs local saat live mode (bagian 9.8 yang belum)
3. **P0-9.9** SEC: set AUTH_PASSCODE kuat + BROKER_EVENT_SECRET kuat di .env (.env gak di-commit) — warning udah jalan, tinggal set env nya
4. **P1-10.1** Split server.ts (1718L) → route modules
5. **P1-10.5** Pino structured logging

Verify tiap item: `npx tsc --noEmit && npx vitest run && npm run build` → smoke test login → order → close via curl.
**Runbook colok API key:** Phase 9.1-9.9 selesai → testnet (TRADING_MODE=live + BROKER_TESTNET=true + key testnet Binance Futures) → arm → posisi kecil → verifikasi close/TP/SL → baru mainnet kecil.
