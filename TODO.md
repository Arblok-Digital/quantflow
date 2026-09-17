# TODO & Progres — sumber status aktif

Diperbarui: **17 September 2026 (UTC+07)**.

> **PAPER BELUM TERVERIFIKASI MENYELURUH. LIVE BELUM DISETUJUI.**
> Menggantikan status IMPLEMENTATION.md / PRODUCTION_ROADMAP.md lama.
> Audit adalah riwayat bukti, bukan daftar pekerjaan selesai. Jangan memakai persentase kesiapan.

## Cara agent melanjutkan

1. Baca file ini dan AGENTS.md; cek git status, jangan menimpa perubahan agent lain.
2. Klaim satu ID: isi owner, tanggal dan status IN_PROGRESS sebelum edit.
3. Uji di sandbox/database baru. Jangan membaca credential, reset DB pengguna, mengaktifkan live atau restart server pengguna tanpa persetujuan.
4. Simpan regression test dalam repo. Catat perintah, exit code, expected vs actual, mock dan path bukti.
5. DONE hanya jika acceptance tugas lulus; test snapshot lama bukan bukti kode terkini.

Status: OPEN = belum selesai; PARTIAL = implementasi ada tapi kontrak belum lengkap;
VERIFIED_SCOPED = terbukti untuk cakupan tertulis; BLOCKED = menunggu prasyarat.
Owner semua tugas OPEN/PARTIAL: **belum ditugaskan**. Tidak ada implementasi berjalan pada handoff ini.

## Bukti historis yang boleh dipakai

| Area | Status | Bukti / batas |
|---|---|---|
| Prompt tanpa default angka palsu; proyeksi on-chain dikeluarkan | VERIFIED_SCOPED | `tests/integration/aiPrompt.test.ts`: dua route, tiga payload; menangkap prompt SDK. SDK/auth/DB/upstream dimock. Bukan real-only seluruh pipeline. |
| Suite terakhir tercatat | VERIFIED_SCOPED | 17 Sep: 167/167 tests, 15 files; tsc exit 0. Ulang setelah perubahan. |
| PnL normal, partial-restart, depth tetap, BE, rollback close | PARTIAL | Harness HTTP/SQLite pernah lulus; acceptance dibuka kembali karena celah di bawah. |
| Feed real paper | VERIFIED_SCOPED | Satu lifecycle audit feed publik; bukan validasi live order atau profitabilitas. |
| Profitabilitas / kesiapan live | BLOCKED | Belum terbukti. Jangan menyebut paper training-ready atau tinggal flip live. |

Bukti: [AUDIT_2026-09-17.md](./AUDIT_2026-09-17.md). Klaim F9 "lima selesai" di sana **bukan status terkini**.

## Advisor — permintaan pengguna sebelum ledger

### ADV-01 — Intraday 24 jam sejak fill [VERIFIED_SCOPED]
- Owner: Cline | tanggal: 2026-09-17. Paper only; live tidak disentuh dan tetap belum disetujui.
- File berubah: `src/paperbook/fill.ts` (filledAt = Date.now() SETELAH marketFill selesai; openedAt = filledAt; hapus filledAt sintetis), `src/paperbook/exitEngine.ts` (deadline dievaluasi lebih dulu, batas tepat >=, tidak terhalang guard risiko/partial), `src/paperbook/bracketMonitor.ts` (close TIMEOUT dieksekusi SEBELUM fetch mark → kegagalan mark tidak menyembunyikan deadline; FAILED tetap OPEN + retry pass berikutnya; posisi closed di-skip), `src/paperbook/types.ts` (deadlineAttempt pada exitPlan.state), `src/logic/intradayPlan.ts` (draft strict tanpa harga fiktif + format WIB).
- Bukti (sandbox `C:\Users\ARBLOK\AppData\Local\Temp\quantflow-intraday-implementation`; file root = salinan teruji, hash dicek per file):
  - `tests/integration/intradayDeadline.test.ts` (2/2): fill aktual 17 Sep 14.30 WIB; sebelum deadline OPEN; tepat deadline CLOSED/TIMEOUT tepat satu kali; mark feed throw → tetap close TIMEOUT.
  - `tests/integration/intradayDeadlinePersistence.test.ts` (1/1): SQLite nyata (node:sqlite, mkdtemp per test): positions.opened_at = 07:30:00Z, closed_at = tepat deadline, tepat satu order exit, pass kedua tidak menambah order. DB ditutup sebelum folder sandbox dihapus.
  - `src/logic/intradayPlan.test.ts` (7/7): draft menolak bias netral/kedaluwarsa (>15m)/bracket salah arah/SPOT SHORT; formatDeadlineWib eksplisit "WIB".
  - `npm test -- --reporter=dot` **178/178 PASS exit 0**; `npm run lint` **exit 0** (final-suite.log, lint-final2.log, sqlite-check3.log).
- Batas: exchange masih dimock (bukan validasi feed publik menyeluruh); server pengguna tidak direstart — restart/rehydrate belum diuji; DB mock pada test deadline (persistensi ditutup test SQLite terpisah); tombol "isi tiket intraday" dari Advisor, countdown WIB di UI, dan tampilan deadlineAttempt BELUM ada — modul draft baru siap dipakai, belum di-wire; live autopilot/scheduler tidak diubah.
- [ ] Wiring UI: tombol isi tiket dari Advisor (tanpa auto-submit), countdown WIB, badge status deadline/kegagalan.
- [ ] Acceptance restart: rehydrate deadlineAttempt + policy dari DB; log kegagalan close terlihat di FE.
- Live tetap belum disetujui; P0-00 tetap prasyarat klaim accounting benar.

## Validasi LOGIC_AUDIT_2026-09-17 (owner: Cline, 2026-09-17)
- **P1-A test-isolation VALID & SUDAH DIPERBAIKI.** Forensik read-only `trading.db` membuktikan kontaminasi: 1 order sell BTC/USDT + 1 fill + 4 baris audit dengan `created_at` masa depan (1789716600000 = 2026-09-18 07:30Z — fake clock test) dan 4 `writer_id` berbeda menulis snapshot bertimestamp palsu. Akar: `DB_FILE`/`AUDIT_KEY_FILE` di-resolve module-scope (`core.ts:6-7`) padahal test `chdir` setelah import. Fix: keduanya jadi fungsi lazy (resolve saat `initDb`/`ensureAuditSecret`); regression guard `getDbFilePath().startsWith(sandbox)` masuk test persistensi. Bukti: full suite dari root **exit 0** (`root-suite-after-fix.log`), `npx vitest run tests/integration/intradayDeadlinePersistence.test.ts` **1/1 exit 0 dari root** (`single-persistence-root.log`), lint exit 0, forensik DB before == after (tidak ada baris baru). Sampah test lama DI DALAM trading.db belum dihapus (menunggu persetujuan): `ord-1789716600000-3`, 1 fill, 4 audit rows, `pos-1789630198000-1`.
- **Koreksi audit:** temuan gitignore sudah basi — `trading.db`, `.guardrails.json`, `.audit-signing-key`, `.auth-sessions.json`, `.broker-secrets.json` sudah ter-ignore. Klaim "penalti 25% duplikasi" tidak ketemu konstantanya di `decisionEngine`/`keelAdapter` — angka itu perlu tunjukkan file:line sebelum diperlakukan sebagai fakta. P1-B/P2-A/P2-B/P3 belum divalidasi tuntas (butuh baca live path + replay lebih dalam).
- Skor 7.8/10 itu opini auditor, bukan hasil terukur yang bisa direproduksi; yang bisa direproduksi dari laporan ini adalah P1-A dan itu sudah ditangani di atas.

## Tahap A — paper accounting (kerjakan pertama)

### P0-00 — Ledger deterministik sebagai baseline [OPEN]
- [ ] Test permanen HTTP + SQLite nyata di temporary directory + restart; harga/depth fixture eksplisit.
- [ ] Tulis expected dari persamaan ekonomi SEBELUM implementasi; jangan ubah expected hanya untuk menyamai aplikasi.
- [ ] LONG: modal 10000; buy 10 @100, leverage 10; close 2 @101, lalu 8 @103. Taker 0.0004.
  - Entry fee 0.4; exit fees 0.0808 dan 0.3296; gross 26; net **25.1896**, saldo akhir sekitar **10025.19**.
  - Partial net 1.8392; sisa entry fee 0.32; net penutupan berikutnya 23.3504.
- [ ] Assert quantity, fee fills, incremental/cumulative PnL, cash, equity, DB, orders/events; restart partial/flat tidak menghilangkan atau menggandakan PnL.
- [ ] SHORT simetris dan loss case; toleransi pembulatan cents harus dijelaskan.

### P0-01 — Satu hitungan account/snapshot/balance [PARTIAL]
- [ ] Satukan reserved margin pada getPaperAccount, persistSnapshot, getPaperBalance dan tampilan/riwayat.
- [ ] Acceptance: limit NEW menurunkan free cash, tidak equity; total/used konsisten. Cancel/fill/restart tanpa drawdown semu.
- Lokasi: `src/paperbook/store.ts`; account sudah menghitung reservedMargin, snapshot/balance belum.

### P0-02 — Satu hasil fill per eksekusi [PARTIAL]
- [ ] Partial akibat full-close memakai FillResult pertama, bukan fetch orderbook kedua.
- [ ] Acceptance: depth 2 dari qty 10 -> 2 closed, 8 OPEN; harga/fee snapshot sama. Fixture kedua berubah tajam dan tidak dipakai pada eksekusi pertama.
- [ ] NO_DEPTH/invalid levels tidak menjadi fake full fill; API/UI tidak menyebut seluruh posisi closed ketika masih partial.
- Lokasi: `src/paperbook/fill.ts`, `src/broker/paperBroker.ts`, konsumen close FE.

### P0-03 — BE valid dan konsisten [PARTIAL]
- [ ] Gunakan fee entry aktual yang menempel pada sisa posisi + estimasi exit fee; maker/taker berbeda.
- [ ] Manual BE tidak melonggarkan SL atau menempatkan stop di sisi salah terhadap mark; tangani stale mark.
- [ ] Auto BE baru armed ketika proteksi valid diterapkan; offset konfigurasi tidak diam-diam diabaikan.
- [ ] Acceptance LONG/SHORT, mark belum cukup profit, trailing sudah ketat, partial sebelumnya, fee non-default.
- Lokasi: `store.ts`, `exitEngine.ts`, live mirror `src/server/routes/broker.ts`.

### P0-04 — Atomicity seluruh mutasi [PARTIAL]
- [ ] Gagal DB pada open/close/partial/limit-new/limit-fill/cancel/update memulihkan cash, posisi, orders dan exit-plan.
- [ ] Success event SESUDAH commit; gagal close tidak memancarkan POSITION_CLOSED palsu.
- [ ] Uji concurrency monitor/HTTP, retry/idempotency, partial TP gagal atau terisi sebagian tidak kehilangan level/menutup dobel.
- [ ] Acceptance failure-injection + restart tiap jalur; DB/memori sepakat, retry aman.

### P0-05 — Rekonsiliasi fee/PnL/journal & data lama [PARTIAL]
- [ ] Periksa total fee posisi vs fills, cumulative realized vs sisa qty, statistik R/journal dan profit partial posisi OPEN.
- [ ] Fee yang menempel pada sisa posisi bukan seluruh fee historis.
- [ ] Partial PnL lama tidak otomatis pulih; analisis read-only dahulu, jangan backfill tanpa bukti/persetujuan.
- [ ] Acceptance multi-partial/restart/final close: ledger/account/statistik dengan semantik waktu sama dapat direkonsiliasi.

## Tahap B — realisme & integritas data (sebelum menilai strategi)

### P1-01 — Real-only decision inputs [OPEN]
- [ ] Provenance per fitur: venue, spot/futures, exchange timestamp, receivedAt, source, freshness; jangan menyebut data real karena array tidak kosong.
- [ ] Synthetic/interpolated/stale/missing -> tahan entry sesuai policy; exit risiko jangan diblokir sembarangan. Tidak ada angka harga/indikator pengganti yang dianggap observasi.
- [ ] Acceptance: outage, stale, fallback lintas venue, book invalid dan fake client provenance diuji sampai keputusan/API/UI.
- Catatan: on-chain sudah diblokir di dua prompt saja. `liquidity-mapper` aktif; resting depth bukan ukuran stop atau niat institusi.

### P1-02 — Instrumen, biaya & simulasi fill [OPEN]
- [ ] Pilih instrumen target eksplisit; futures tidak menggunakan spot seolah identik.
- [ ] Modelkan funding timestamp/direction, margin isolated/cross yang didukung, maintenance tier, liquidation fees/mark; jangan klaim parity exchange sebelum diuji.
- [ ] Tick/step size, minimum notional, rounding, fee asset/rate; cash cukup untuk margin PLUS fee.
- [ ] Nyatakan kualitas fallback ticker dan limit-fill: spread, depth, latency, maker/taker, touch bukan jaminan full fill.
- [ ] Acceptance: long/short, low-priced assets, gap, tipis/no depth, funding settlement; biaya tidak dihitung dua kali.

### P1-03 — Bracket/replay kronologi & restart metadata [OPEN]
- [ ] Hindari menggunakan high/low sebelum entry atau sebelum SL baru aktif untuk mengeksekusi posisi.
- [ ] Jika SL/TP/liq tersentuh dalam satu candle, tandai ambiguity; jangan klaim mengetahui urutan dari OHLC.
- [ ] Restore metadata posisi/order dan mark freshness dengan benar; equity startup bukan data live sebelum refresh.
- [ ] Replay dan paper memakai kontrak biaya/risk konsisten; bedakan strategi replay RSI dari strategi Keel/AI.

### P1-04 — Acceptance paper end-to-end permanen [BLOCKED: Tahap A + P1-01..03]
- [ ] Regression test masuk repo (bukan hanya TEMP); jalankan lint, full tests, build di sandbox.
- [ ] HTTP + SQLite + full startup/scheduler + restart/failure; browser UI account/journal/order sesuai server.
- [ ] Forward paper data real dengan konfigurasi tercatat; logging backlog/disconnect/concurrency, soak test dengan durasi & kriteria diumumkan sebelumnya.
- [ ] Lulus bila invariant dan rekonsiliasi terjaga, bukan karena profit atau banyak test hijau.

## Tahap C — validasi strategi [BLOCKED: acceptance paper]
- [ ] Bekukan versi kode/config/data provenance; tandai hasil sebelum fix sebagai dataset berbeda.
- [ ] Pisahkan MANUAL, AUTOPILOT, REPLAY dan strategi; gross/fee/funding/net, expectancy, PF, drawdown, exposure, turnover, sample size.
- [ ] Out-of-sample / walk-forward, beberapa regime; cegah leakage dan parameter tuning pada test set.
- [ ] Stress biaya/spread/slippage; tentukan batas risiko dan kriteria keputusan sebelum evaluasi, bukan pilih hasil terbaik sesudahnya.
- [ ] Laporan jujur: paper profit bukan jaminan edge bertahan atau profit live.

## Tahap D — validasi live [BLOCKED: A–C + persetujuan pengguna]
- [ ] SL/TP harus terkonfirmasi; entry tanpa proteksi ditangani secara aman, bukan warning saja.
- [ ] Uji exchange testnet: leverage/margin mode, reduce-only, precision, partial fill, timeout/unknown order state, retry/idempotency, reconnect, reconciliation.
- [ ] Testnet tidak mereplikasi likuiditas produksi. Jika disetujui, canary modal kecil dengan batas loss, kill switch, monitoring dan rollback plan.
- [ ] Tidak ada auto-arm/auto-promote hanya karena paper profit.

## Bukti & handoff

Format wajib tiap tugas yang dikerjakan:
`ID | status | owner | tanggal | file berubah | expected/actual | command + exit | bukti | keterbatasan | next step`.
Jangan ubah checkbox menjadi DONE untuk pekerjaan baru sebatas review kode.

Baseline terdahulu (lihat audit untuk detail):
- `C:\Users\ARBLOK\AppData\Local\Temp\quantflow-prompt-74c9d6b5`: tests prompt/full suite/typecheck terakhir.
- `C:\Users\ARBLOK\AppData\Local\Temp\quantflow-audit-ab88e992`: harness finansial historis, cakupan terbatas; folder cases pernah diganti nama.
- TEMP dapat dibersihkan OS. P0-00 harus memindahkan kontrak penting menjadi test permanen yang bisa diulang, bukan mengandalkan log TEMP.

### Handoff dokumentasi 2026-09-17
- [x] TODO tunggal + petunjuk agent; README diarahkan ke status terkini.
- [x] Audit historis dipertahankan dengan peringatan koreksi F9.
- [x] Dua dokumen status lama digantikan/dihapus dari root setelah backup terverifikasi.
- Tidak mengubah logic trading atau menjalankan order live. Self-check ulang 17 Sep 21:19: `npm test -- --reporter=verbose` **167/167 PASS, exit 0**; `npm run lint` **exit 0** pada salinan terbaru di `C:\Users\ARBLOK\AppData\Local\Temp\quantflow-selfcheck-e03ffac7` (suite.log, typecheck.log). Tidak ada assertion gagal pada suite tersedia; acceptance ledger baru belum dijalankan dan tidak otomatis selesai.
- Verifikasi ulang 21:25: `npx vitest run` **167/167 PASS, exit 0**, log `final-suite.log` di sandbox selfcheck yang sama. 167 file source/tests/scripts/public cocok dengan salinan yang diuji; tautan lokal dokumentasi tidak putus. Tidak membuat commit atau push.
- Backup dua dokumen yang dihapus dari root: `C:\Users\ARBLOK\Documents\quantflow-doc-backups\2026-09-17-212417`. SHA256 asli dan backup cocok sebelum penghapusan.
- `.kilo/worktrees`, plans UI, source/tests, dist, logs runtime, database dan secrets dipertahankan. Status branch/worktree lain harus diselaraskan oleh owner-nya, bukan dihapus massal.
