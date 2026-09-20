# ROADMAP EDGE — Fokus Win-Rate (bukan risk-gate lagi)

**Owner:** opencode | **Tanggal:** 2026-09-19 | **Status:** BELUM DIKERJAKAN (atrisk terputus antar-sesi → buat ini)
**Referensi:** `LOGIC_AUDIT_2026-09-18.md` (fix risk selesai + verifikasi), `LOGIC_REVIEW_LING_2026-09-19.md` (audit finansial Ling), council Ling Fin + Nemotron Ultra (2026-09-19).

## Konteks / Keputusan

- Engine eksekusi solid & risk-gate bug fix selesai (see AUDIT-FIX/GAP-1). Sisa temuan risk sengaja DITUNDA (lihat "Backlog tunda").
- Pemilik memutuskan: fokus berikutnya = **EDGE (arithmetic win-rate)**, pola Jim Simons — bobot diturunkan dari data, kalibrasi probabilitas, expectancy-based sizing, invalidation rigid, frekuensi.
- Council divergen tapi satu fondasi:
  - **Ling 3.0 Flash Fin:** #1 = B (signal validation via replay → ganti bobot heuristic `0.75` dsb dengan hasil ukur). B dibangun di atas E (feature attribution via join `decisionId→ProbInput`).
  - **Nemotron 3 Ultra:** #1 = A (calibration feedback loop di probabilityEngine — Brier/ECE/reliability per band). Tanpa join `ProbInput`, A = "dashboard kosong".
- Sintesis: kerjakan **fondasi data export terlebih dahulu** (join + split), lalu B dan A. C & D ditunda sampai B terbukti.

## Urutan Pengerjaan

### Fase 0 — Fondasi data (pintu masuk B & A)
1. Verifikasi sisa kode: `buildReplayTrainingDataset()` di `src/replay/replayEngine.ts` (sudah ada), join `decisionId` → `ReplayTrade` (ref: `replayEngine.ts` ~956 `riskR`, ~1016 `decision_id` CSV) → snapshot `ProbInput` saat `placeReplayOrder` (`meta.decisionId`).
2. Tambahkan **walk-forward split** (train 60 / val 20 / test 20 kronologis). LARANG tune bobot di test set.
3. Anti-leakage (aturan Nemotron): tiap trade log `bucketKey + timestampEntry + outcomeTimestamp`; hitung metrik hanya pada bucket **n≥30**, rolling 90 hari.

### Work-item B — Signal validation → bobot data-driven
- Per-feature WR & expectancy (confluence, absorption, wall, flow direction, duplicated-MTF) dari replay OOS.
- Ganti bobot heuristic (mis. `*0.75` di keelAdapter mtfDuplicated) dengan bobot terukur; hapus asumsi yang kontribusinya < 2×SE.
- Acceptance (Ling): OOS trades ≥200; WR ≥57% (n=200) / ≥55% (n=400), binomial p<0.05 vs 50%; expectancy net-fee >0; PF >1.5; maks DD OOS <20%; minimal 1 fitur dengan kontribusi >2×SE.

### Work-item A — Calibration feedback loop (paralel/berikutnya)
- Catat tiap p dari `probabilityEngine` vs outcome aktual; Brier + ECE + reliability per prob-band; rekalibrasi (shrink/EMS).
- Acceptance (Nemotron): Brier <0.22; ECE <0.05; band 0.60–0.65 → WR empiris ≥58%; expectancy net-fee >0.15R; PF ≥1.3; konsisten ≥3 bulan walk-forward.

### Work-item C & D (DITUNDA sampai B terbukti)
- C: regime detector (ATR%, ADX, vol-band) → size_down/flat otomatis. (Ling: percuma kalau sinyal dasar belum terbukti prediktif.)
- D: invalidation/time-stop + frekuensi granular replay.

## Pengingat jebakan (dari kedua council)
- Overfitting + look-ahead saat bucketing (36 kombinasi bucket mayoritas kosong → jangan turunkan threshold demi data).
- Survivorship/optimism bias replay: WR replay pasti di atas real, kurangi 3–5% untuk biaya+slippage.
- Regime non-stationarity: 2024 bull ≠ 2022 bear. Selalu split kronologis, bukan random.

## Council-2 — Market Making (Jane Street) → DITOLAK sebagai edge utama (2026-09-19)

Ditanyakan ke Ling Fin + Nemotron Ultra: apakah prototype MM ala Jane Street di crypto perp lebih simple/masuk akal daripada directional? **Dua-duanya verdict sama: TIDAK untuk dev solo modal 1–10k.**

Alasan umum (terverifikasi di kode):
- **Tidak ada maker rebate** — Binance/Bybit futures retail: maker +2bps, taker +4bps → spread tipis 1–5bps dihabiskan fee. MM untung dari spread hanya kalau fee < 0 (rebate/VIP).
- **Funding cash-flow TIDAK dimodel** di paperbook/replay (grep: funding hanya sebagai input sinyal di `marketFetcher.ts:717`/`keelAdapter.ts:52` dan adjust liq di `fill.ts:269` `liquidationPriceWithFunding`). MM yang tahan inventory akan bleed funding — belum terhitung di PnL.
- Adverse selection / toxic flow (quote jadi korban informed flow), latency 50–200ms vs HFT <1ms (co-lo), inventory risk, perlu modal ≥$100k/pair & queue-priority dari exchange. Semua belum ada di engine.

Keputusan: **Edge utama tetap directional (ROADMAP di atas).** MM dicatat sebagai prototype OPSIONAL sampingan untuk belajar (bukan primary): fitur wajib jika dipaksa = inventory tracker, funding cash-flow, quote lifecycle (post/cancel/replace), skew (Avellaneda-Stoikov), adverse-selection filter, PnL attribution. Acceptance-nya (kalau suatu saat dikerjakan): Sharpe net >1.5, fill rate 15–40%, turnover inventory <30 menit, funding bleed <15% spread capture, sample n≥200 — kalau salah satu merah, buang.

## Backlog tunda (risk, jangan lupa dikerjakan setelah edge landing)
Prioritas Sep-17 audit (Depsek & Ling sepakat belum ditangani):
- P1: reconcile live `fetchOrder`; P2: mutex jalur live; P3: clamp bracket+latency, timestamp replay, decision trace `*0.75` (keelAdapter:381) + provenance.
- Ling CRITICAL: HWM harian reset (`keelAdapter` pakai `IntradayHighWaterMark`), kill-switch write atomic (`writeFileSync`+`rename`), fallback equity cash-only → jangan fail-open (retry/throw).
- WARN: live risk gate tidak macro-aware; leverage cap di `orderRiskGate`; macro kalender mati Des 2026 (refresh terjadwal).

## Vertical B — Meme-coin scout (Solana) — KEPUTUSAN: mesin TERPISAH (2026-09-19)

Pemilik menambah vertical non-futures: **deteksi dini token meme baru di Solana** lewat akumulasi wallet KOL (4–48 jam sebelum sosial). Ini skenario **venture/lottery**, BUKAN konsistensi ala Simons — alokasi kecil 1–3 SOL/bet, mayoritas token rug.

**Keputusan arsitektur:** satu repo, dua mesin. `solana-scout/` = folder sibling TERPISAH. DILARANG mencampur token scout ke `paperbook`/HMAC ledger engine — rantai berbeda (Solana vs CEX futures), book-keeping tidak bisa di-mark konsisten, rug/unmetered akan mengotori akuntansi engine.

Alur 5 fase (sudah diimplementasi v0.1):
1. KOL scan (138 wallet, `reference/kol-wallets.json`) → 2. anomaly/concurrency → 3. rug/fundamental gate (hard-fail → SKIP) → 4. sentimen gap (stub jujur, belum di-scrape) → 5. sinyal deterministic 0–200 (ALPHA ≥150, BUY 110–149, WATCH 70–109, SKIP <70).
- UI dashboard baca `output/report.json` (zero-dependency, `npm run serve`).
- Acceptance v0.1 (sudah): `npm test` 8/8 deterministic; `npm run scan:mock` → report JSON valid; UI render.
- **Integrasi (sesi ini):** scout di-EMBED ke UI engine futures sebagai **tab "Scout"** (BUKAN server terpisah — arahan user). Route `/api/scout/report` READ-ONLY membaca `solana-scout/output/report.json` + `/api/scout/scan` trigger re-scan (child process node, mock default). `SOLANA_SCOUT_DIR` di-resolve per-request. Panel React Tailwind gaya aplikasi. Prinsip tetap: mesin scout TIDAK pernah menulisi paperbook/HMAC ledger engine — route hanya membaca file report.
- **Council audit (arsitektur + kode, 2026-09-19)** → perbaikan applied:
  - (a) live path TIBA-tiba tidak resolve symbol/name → fixed: `resolveMintMeta` (Helius DAS → fallback RPC jsonParsed → shortMint) + `signal.js` bawa symbol/name.
  - (b) scoring.js: `NO_LIQUIDITY` null di-mask jadi pass → fixed (`?? 0`), `MINT_AUTHORITY` fail saat data null → gate hanya aktif bila fundamentals tersedia, `fmtUsd(Infinity)`/NaN-age → guard `!isFinite` + "usia tidak diketahui", breakdown listing semua gate gagal (`failedGates`).
  - (c) route: race double-scan → **mutex 409 SCAN_IN_PROGRESS**, timeout 180s, cleanup file `.tmp` partial; scan.js **atomic write** (tmp → rename) supaya pembaca tak pernah lihat report parsiil.
  - (d) RPC: `PUЯBLIC_RPCS` = **6 endpoint publik free terverifikasi 2026-09-19** (`api.mainnet-beta.solana.com`, `solana-rpc.publicnode.com`, `solana.leorpc.com/?api_key=FREE`, `public.rpc.solanavibestation.com`, `api.uniblock.dev/uni/v1/json-rpc?chainId=solana`, `solana-mainnet.gateway.tatum.io/`) + retry 2 attempt + sleep pada 429 + cache metadata 1 jam. OnFinality public (429) tidak dipakai.
- Verdict audit: scale tetap **venture/lottery kecil, mesin terpisah**. Header prioritas lanjutan (belum dikerjakan): **(1)** token age dari blocktime/launch (unlock credit NEWBORN & INSIDE_KOL_WINDOW), **(2)** KOL historical win-rate tracking (JSON + cek harga 24/72j), **(3)** holder distribution gate top-10>80%, **(4)** newborn listener PumpPortal WS.
- Catatan penting: kunci Helius yang dipakai (`385cdd45…`) ditolak **401 di semua endpoint** saat retest 2026-09-19 (bukan format/key env) → live scan memakai fallback public RPC. Tanpa key valid, `getAsset` DAS (ticker asli, metadata penuh) tidak jalan. Opsi: generate key baru di dashboard Helius, atau resolver on-chain Metaplex/DexScreener.
- Batas yang jujur: newborn real-time (PumpPortal WS) & usia token dari blocktime belum diimplementasi; RugCheck hanya 1 sumber; feed real rate-limited RPC publik; Helius key aktif belum ada.
- **MEME-SCOUT-3 (DONE 2026-09-20, hermes):** DexScreener di-port ke scout engine — `scripts/lib/dexscreener.js` (client + pure functions), `resolveMintMeta` DexScreener-first (symbol/name ASLI + `ageHours` dari `pairCreatedAt`; fix age NaN), scan mode `--discovery` bottom-up dari token-boosts API, route `/api/scout/scan` + panel terima mode `mock | live | discovery`. Live scan terbukti: symbol asli (SANJO/TIGRINO/BOBI), age nyata (1.3j–340j), kasus bonding-curve (mcap ~$5k) → SKIP wajar. KOL overlay untuk mode discovery + listener PumpPortal WS tetap fase lanjutan.
- Next: fase lanjutan diputuskan oleh pemilik (realtime listener, age dari blocktime, narasi gap, eksekusi via sniper terpisah BOLEH — tetapi tidak pernah ke paperbook engine).

## Aturan eksekusi (AGENTS.md berlaku)
- Klaim satu ID TODO + owner/tanggal/status sebelum kerja. Update setelah selesai.
- Perbaikan minimal + regression test permanen → lint → full suite → build → acceptance.
- Jangan ubah risk-gate behavior tanpa koordinasi; dua dialog kill-switch sistem tetap dirunut.