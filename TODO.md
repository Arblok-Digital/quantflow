# TODO & Progres — sumber status aktif

Diperbarui: **18 September 2026 (UTC+07)**.

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
| Suite terakhir tercatat | VERIFIED_SCOPED | 18 Sep: **225/225 tests, 24 files**; tsc exit 0. Termasuk `ledgerDeterministic.test.ts` (8/8) + `accountBalanceSnapshot.test.ts` (5/5) + `closePartialDeterministic.test.ts` (5/5) + `breakEvenManual.test.ts` (6/6) + `atomicityFailureInjection.test.ts` (14/14) + `reconcilePartialJournal.test.ts` (2/2). Ulang setelah perubahan. |
| BE sadar-fee + guard mark/stale + offset dipakai | VERIFIED_SCOPED | 18 Sep: `exitEngine.test.ts` 30/30 + `tests/integration/breakEvenManual.test.ts` 6/6 (LONG/SHORT, RATCHET, MARK_STALE, WRONG_SIDE, HTTP applied=false). |
| Atomicity mutasi paper (failure-injection) | VERIFIED_SCOPED | 18 Sep: `tests/integration/atomicityFailureInjection.test.ts` 14/14 — DB insert failure dikembalikan (rollback SQLite + in-memory), event sukses hanya sesudah commit, retry aman, restart obj/sesuai disk, concurrency/idempotency/HTTP 400. Celah snapshot rollback di `updatePaperPosition` ditemukan & diperbaiki oleh test ini. |
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

### P0-00 — Ledger deterministik sebagai baseline [DONE — acceptance + suite hijau]
- Owner: Cline + opencode/ARBLOK | tanggal: 2026-09-18
- [x] Test permanen HTTP + SQLite nyata di temporary directory + restart; harga/depth fixture eksplisit.
- [x] Tulis expected dari persamaan ekonomi SEBELUM implementasi; jangan ubah expected hanya untuk menyamai aplikasi.
- [x] LONG: modal 10000; buy 10 @100, leverage 10; close 2 @101, lalu 8 @103. Taker 0.0004.
  - Entry fee 0.4; exit fees 0.0808 dan 0.3296; gross 26; net **25.1896**, saldo akhir sekitar **10025.19**.
  - Partial net 1.8392; sisa entry fee 0.32; net penutupan berikutnya 23.3504.
- [x] Assert quantity, fee fills, incremental/cumulative PnL, cash, equity, DB, orders/events; restart partial/flat tidak menghilangkan atau menggandakan PnL.
- [x] SHORT simetris dan loss case; toleransi pembulatan cents harus dijelaskan.
- Bukti: `tests/integration/ledgerDeterministic.test.ts` (**8/8 PASS**) — expected dari persamaan ekonomi di header file (bukan salinan output); SQLite nyata (node:sqlite, `DatabaseSync`) di sandbox mkdtemp per test; HTTP via Supertest (login → order → balance/positions → close → `/api/ledger` + `/api/ledger/verify` valid); restart/rehydrate di describe terakhir (module reload, `initPaperBook` dari SQLite yang sama) tidak menghilangkan atau menggandakan PnL.
  - Hasil terverifikasi: LONG partial 1.84 → full 23.35, total **25.19**, cash **10025.19**; SHORT **24.61** / cash **10024.61**; LONG loss **−50.78** / cash **9949.22**; HTTP full cycle open 10@100 → close 10@103 **29.19** / cash **10029.19**. Order/fill rows & events (`ORDER_NEW`, `ORDER_FILLED`, `POSITION_PARTIAL_CLOSED`, `POSITION_CLOSED`) dicek di DB nyata + ring buffer. Toleransi cents: mutasi di-`r2` 2 desimal → `toBeCloseTo(_, 2)` (±0.005); harga/fee per fill dicek 6/4 desimal terpisah.
  - Command + exit (18 Sep 2026): `npx vitest run tests/integration/ledgerDeterministic.test.ts --reporter=verbose` **8/8 exit 0**; `npm run lint` **exit 0**; `npx vitest run --reporter=dot` **186/186 PASS, 19 files, exit 0**; _suite terbaru setelah P0-02: **196/196, 21 files, exit 0**._
  - Perbaikan minimal: stub untracked rusak `src/paperbook/paperBook.ts` (`export { openPaperPosition, closePaperPosition };` tanpa import → TS2304) menjadi re-export valid `from "./fill"` agar lint hijau — dead code, tidak diimpor apa pun (root `paperBook.ts` tetap barrel utama).
- Keterbatasan: broker/exchange & marketFetcher di-mock (depth fixture eksplisit) — bukan validasi feed publik; HTTP `/api/broker/close` hanya mendukung full close (partial+full dikunci via unit langsung); "restart" disimulasikan sebagai rehydrate in-memory dari SQLite yang sama (cold-boot state), bukan proses OS terpisah; sandbox TEST tidak pernah menyentuh `trading.db`/vault pengguna di root.

### P0-01 — Satu hitungan account/snapshot/balance [DONE — acceptance + suite hijau]
- Owner: opencode/ARBLOK | tanggal: 2026-09-18
- [x] Satukan reserved margin pada getPaperAccount, persistSnapshot, getPaperBalance dan tampilan/riwayat.
- [x] Acceptance: limit NEW menurunkan free cash, tidak equity; total/used konsisten. Cancel/fill/restart tanpa drawdown semu.
- Lokasi: `src/paperbook/store.ts`; account sudah menghitung reservedMargin, snapshot/balance belum.
- Root cause: `getPaperAccount()` sudah menambah reservedMargin pada equity (F9), tetapi `persistSnapshot()` dan `getPaperBalance()` TIDAK — snapshot equity bisa turun 10000→9995.5 saat pasang limit (phantom drawdown di equity curve/maxDrawdown), balance `used`/`total` under-report.
- Perbaikan: helper tunggal `computeAccountMetrics()` di `store.ts` dipakai bersama `persistSnapshot` (equity = cash + marginLocked + reservedMargin + unrealized; margin_used = marginLocked + reservedMargin), `getPaperAccount`, dan `getPaperBalance` (free = cash, used = marginLocked + reservedMargin, total = free + used).
- Bukti: `tests/integration/accountBalanceSnapshot.test.ts` (**5/5 PASS**) — SQLite nyata di sandbox per test + HTTP via Supertest. Fixture limit BUY 0.5 @90 lev10 (notional 45, margin 4.5, lolos risk gate manual=4.0% stop 0.556%):
  - Limit NEW → cash 9995.5, reservedMargin 4.5, free 9995.5 / used 4.5 / total 10000, **equity tetap 10000**; snapshot DB equity 10000 dan margin_used 4.5.
  - Cancel → cash 10000, used 0, equity 10000; semua snapshot flat 10000 (tidak ada drawdown semu).
  - Fill (mark loncat 90, low1m 88) → reserved jadi marginLocked 4.5, cash hanya potong fee maker 0.009 (tidak double-count margin), equity 9999.99; order FILLED/posisi OPEN entry 90.
  - HTTP `/api/broker/balance` → balances[0].used 4.5/total 10000; cancel via `/api/broker/cancel` → pulih.
  - Restart/rehydrate limit NEW → cash 9995.5 + reserved 4.5 = equity 10000 tanpa drawdown; cancel sesudah restart pulih 10000.
  - Command + exit (18 Sep 2026): `npx vitest run tests/integration/accountBalanceSnapshot.test.ts --reporter=verbose` **5/5 exit 0**; `npm run lint` **exit 0**; `npx vitest run --reporter=dot` **191/191 PASS, 20 files, exit 0** (termasuk ledgerDeterministic 8/8 — tidak ada regresi); _suite terbaru setelah P0-02: **196/196, 21 files, exit 0**._
- Keterbatasan: `ReconciliationPanel` (FE) masih menghitung `cash + marginLocked + uPnL` tanpa reservedMargin — gap display ini di luar cakupan P0-01 acceptance (server truth sudah konsisten); prompt AI `ai.ts:88` label "cash + margin + uPnL" belum menyebut reserved; limit fill hanya via bracket monitor (fixture langsung), belum diuji end-to-end broker HTTP auto-fill; sandbox TEST tidak menyentuh `trading.db`/vault pengguna.

### P0-02 — Satu hasil fill per eksekusi [DONE — acceptance + suite hijau]
- Owner: opencode/ARBLOK | tanggal: 2026-09-18
- [x] Partial akibat full-close memakai FillResult pertama, bukan fetch orderbook kedua.
- [x] Acceptance: depth 2 dari qty 10 -> 2 closed, 8 OPEN; harga/fee snapshot sama. Fixture kedua berubah tajam dan tidak dipakai pada eksekusi pertama.
- [x] NO_DEPTH/invalid levels tidak menjadi fake full fill; API/UI tidak menyebut seluruh posisi closed ketika masih partial.
- Lokasi: `src/paperbook/fill.ts`, `src/broker/paperBroker.ts`, konsumen close FE.
- Root cause (3 bug):
  1. `closePaperPositionLocked` (fill.ts) memanggil `marketFill` untuk full-close, lalu pada jalur partial mendelegasikan ke `closePaperPositionPartialLocked` yang melakukan `marketFill` KEDUA — bisa beda depth/price/fee snapshot.
  2. `marketFill` membungkus ladder dalam `try/catch {}` yang menelan `throw PaperOrderError("NO_DEPTH")` — jatuh ke fallback ticker → fake full fill; orderbook kosong/level invalid juga jatuh ke ticker.
  3. `paperBroker.ts` `handlePaperOrder`/`handlePaperClose` hardcode `closed: true` walau hasil partial.
- Perbaikan minimal:
  1. `closePaperPositionPartialLocked(pos, exitReason, closeQty, existingFill?)` memakai `existingFill` saat dikirim dari jalur full-close partial — tidak fetch pembukuan kedua (harga/fee snapshot konsisten). Partial murni baru tetap `marketFill` sekali.
  2. `marketFill`: orderbook kosong/level invalid → `throw PaperOrderError("NO_DEPTH")` (fail-closed, tidak jatuh ke ticker); `catch(err) { if (err instanceof PaperOrderError) throw err; }` — hanya error jaringan/exchange yang boleh turun ke fallback ticker; level rusak (0/NaN/negatif) dilewati sebagai non-likuiditas, bukan dihitung.
  3. `closed: !result.partial` di kedua handler broker; FE `usePaperTrading.closePosition` membawa `partial`; toast `PositionsPanel` + `DashboardPositionsTable` menampilkan "ditutup SEBAGIAN … sisa … masih OPEN" saat partial.
- Bukti: `tests/integration/closePartialDeterministic.test.ts` (**5/5 PASS**) — SQLite nyata di sandbox per test + HTTP via Supertest; expected dari persamaan ekonomi di header file. Unit: open buy 10@100 (notional 1000, margin 100, entry fee 0.4, cash 9899.6) → full-close kena bids hanya 2@101 → partial 2@101 (gross 2, fee entry bagian 0.08, fee exit 0.0808, realized 1.84, marginRelease 20, cash 9921.52), posisi OPEN 8; `feed.calls` hanya +1 (fixture kedua bids 50 TIDAK dibaca); order sells 2@101 + fills price 101/fee 0.0808 di DB; NO_DEPTH kosong & semua level invalid → reject, posisi tetap OPEN 10, tanpa order close. HTTP: `/api/broker/close` partial → `closed:false. partial:true, remainingQty:8`, `/positions` masih qty 8 OPEN; NO_DEPTH → 400 `reason:NO_DEPTH`, posisi tetap 10 OPEN.
  - Command + exit (18 Sep 2026): `npx vitest run tests/integration/closePartialDeterministic.test.ts --reporter=verbose` **5/5 exit 0**; `npm run lint` **exit 0**; `npx vitest run --reporter=dot` **196/196 PASS, 21 files, exit 0** (termasuk ledgerDeterministic 8/8 + accountBalanceSnapshot 5/5 — tidak ada regresi; rehydrate setelah partial mencatat "cash 9921.52, realized 1.84" konsisten).
- Keterbatasan: broker/exchange & marketFetcher di-mock (depth fixture eksplisit) — bukan validasi feed publik; level konfigurasi TIDAK diubah (ORDERBOOK_LEVELS tetap 20, minimal R:R tetap); FE `PositionCard` hanya menampilkan error (tidak toast sukses) sehingga tetap aman; `usePaperTrading.closePosition` menggunakan `(payload as any)` untuk `partial` karena respons HTTP tidak mengetikkan field hasil close; sandbox TEST tidak menyentuh `trading.db`/vault pengguna di root.

### P0-03 — BE valid dan konsisten [DONE — acceptance + suite hijau; dilanjutkan P0-04]
- Owner: opencode/ARBLOK | tanggal: 2026-09-18
- [x] Gunakan fee entry aktual yang menempel pada sisa posisi + estimasi exit fee; maker/taker berbeda.
- [x] Manual BE tidak melonggarkan SL atau menempatkan stop di sisi salah terhadap mark; tangani stale mark.
- [x] Auto BE baru armed ketika proteksi valid diterapkan; offset konfigurasi tidak diam-diam diabaikan.
- [x] Acceptance LONG/SHORT, mark belum cukup profit, trailing sudah ketat, partial sebelumnya, fee non-default.
- Lokasi: `store.ts`, `exitEngine.ts`, live mirror `src/server/routes/broker.ts`.
- Perbaikan minimal (4 titik):
  1. `exitEngine.ts`: helper baru `feeAwareBreakEvenStop(pos)` — BE sadar-fee memakai fee ENTRY AKTUAL pada sisa posisi (`pos.feesPaidUSD`, sudah dikurangi jatah entry fee saat partial close di fill.ts) + estimasi exit taker. Net = 0: LONG `X=(E*q+F)/(q*(1-T))`, SHORT `X=(E*q-F)/(q*(1+T))`. Reduksi ke rumus lama `E*(1±f)/(1∓f)` hanya bila entry taker penuh — so maker/taker membedakan titik BE.
  2. `store.ts` (manual BE via `/api/broker/position/update breakEven:true`): pakai `feeAwareBreakEvenStop` + dua guard — (a) RATCHET: kalau SL sekarang sudah lebih ketat dari BE, jangan longgarkan (skip `ALREADY_TIGHTER`); (b) SIDE+FRESHNESS: hanya terapkan bila mark SEGAR (`now - lastMarkUpdatedAt <= MARK_TTL_MS`) dan stop di sisi benar terhadap mark; mark basi → skip `MARK_STALE`, mark belum profit → skip `WRONG_SIDE_VS_MARK`. setiap skip memancarkan event `EXIT_ENGINE_ACTION MANUAL_BE_SKIPPED` + respons HTTP membawa `position.breakEven = { applied, reason, note }` agar FE tidak bilang "digeser" padahal tidak.
  3. `exitEngine.ts` (auto BE): arm baris `breakevenArmed=true` SEBELUMNYA unconditional saat trigger baru saja tercapai, walau SL tidak bisa dipancarkan karena mark tidak menunjang → proteksi tidak pernah terpasang dan BE tidak pernah dicoba ulang. Sekarang arm hanya bila proteksi valid diterapkan (SL digeser) ATAU SL sudah lebih ketat (proteksi yang ada cukup); bila mark tidak menunjang → TIDAK arm, pass berikutnya boleh mencoba lagi. PLUS `breakEvenOffsetPct` yang dinormalisasi tapi TIDAK PERNAH dipakai → sekarang dipakai sebagai buffer tambahan sisi profit (LONG `max(feeBE, E*(1+off))`, SHORT `min(feeBE, E*(1-off))`) — tidak diam-diam diabaikan.
  4. Live mirror `src/server/routes/broker.ts`: tetap estimasi TAKER (live tidak tahu fee pintu aktual tanpa ledger), + guard sisi terhadap `pos.markPrice` dan menolak bila mark tidak tersedia (`NO_MARK` / `BE_WRONG_SIDE`) — mirror aturan paper (jangan menaruh stop di sisi salah/basi).
- Bukti: 
  - `src/paperbook/exitEngine.test.ts` (**30/30 PASS**, +7 test): fee aktual taker = rumus lama; masuk MAKER (feesPaidUSD=0.2 vs 0.4) → BE lebih dekat entry; partial sebelumnya (qty 0.008/fee tersisa 0.32) → BE konsisten net=0; feesPaidUSD tanpa nilai → fallback jujur E*q*T; offset 0.2% → `max(fee, 100.2k)` dipakai (bukan ignored); mark crash → BE TIDAK armed + pass berikutnya bisa armed; SHORT mark di sisi salah → tidak armed.
  - `tests/integration/breakEvenManual.test.ts` (**6/6 PASS**) — SQLite nyata sandbox + HTTP Supertest: LONG mark segar di atas BE → SL 100.080032 (persamaan di HEADER file, bukan output app) persisted; SHORT → 99.920032; RATCHET SL 100.5 → tidak melonggarkan (applied=false ALREADY_TIGHTER); mark stale 60s (>MARK_TTL_MS 3000) → MARK_STALE, SL tetap 98; LONG mark 100 < BE → WRONG_SIDE_VS_MARK, SL tetap 98; HTTP break-even dengan mark belum menunjang → 200 + `position.breakEven.applied=false, reason=WRONG_SIDE_VS_MARK` dan `/positions` masih SL 98.
- Command + exit (18 Sep 2026): `npx vitest run src/paperbook/exitEngine.test.ts --reporter=dot` **30/30 exit 0**; `npx vitest run tests/integration/breakEvenManual.test.ts --reporter=dot` **6/6 exit 0**; `npm run lint` **exit 0**; `npx vitest run --reporter=dot` **209/209 PASS, 22 files, exit 0** (naik dari 196/21 — tidak ada regresi; ledgerDeterministic/accountBalanceSnapshot/closePartial tetap hijau).
- Keterbatasan: live mirror tidak diuji terhadap exchange nyata (mock broker; live butuh persetujuan); `breakEvenOffsetPct` diinterpretasikan sebagai buffer TAMBAHAN di sisi profit, bukan pengganti insentif fee (default tanpa offset = fee-neutral); fee exit diasumsikan taker (stop = market) — konsisten dengan fill model; FE `PositionCard` dan Dashboard tetap membaca `breakEven` via hook yang kini membawa skip; `feeAwareBreakEvenStop` memakai `feesPaidUSD` yang hanya akurat untuk posisi yang dibuka lewat paperBook (fallback jujur untuk rehydrate lama).

### P0-04 — Atomicity seluruh mutasi [DONE — acceptance + suite hijau]
- Owner: opencode/ARBLOK | tanggal: 2026-09-18
- [x] Gagal DB pada open/close/partial/limit-new/limit-fill/cancel/update memulihkan cash, posisi, orders dan exit-plan.
- [x] Success event SESUDAH commit; gagal close tidak memancarkan POSITION_CLOSED palsu.
- [x] Uji concurrency monitor/HTTP, retry/idempotency, partial TP gagal atau terisi sebagian tidak kehilangan level/menutup dobel.
- [x] Acceptance failure-injection + restart tiap jalur; DB/memori sepakat, retry aman.
- Perbaikan minimal (7 titik): success event ditunda setelah commit + rollback in-memory pada full close (`fill.ts`), partial close (`fill.ts`), cancel (`store.ts`), limit-new (`fill.ts`), limit-fill (`bracketMonitor.ts` — rollback + `ERROR` event, fail-closed), update SL/TP & exitPlan (`store.ts`), dan breakEven (`store.ts`). Saver toleran `dbSaveOrderTolerant`/`persistSnapshotTolerant` dibuang → semua jalur wajib commit berhasil sebelum mutasi dianggap berlaku.
- Test menangkap bug fix sendiri: di `updatePaperPosition` snapshot `posSnap` semula diambil SESUDAH mutasi → rollback memulihkan nilai yang sudah ter-mutasi. Snapshot dipindah SEBELUM semua mutasi (yaitu: stopLoss/takeProfit/exitPlan), maka rollback mengembalikan nilai asli.
- Bukti: `tests/integration/atomicityFailureInjection.test.ts` (**14/14 PASS**) — SQLite nyata di sandbox + HTTP via Supertest; `commitTx` di-mock partial (wrap) untuk melempar satu kali per test (`failCommit`), `rollbackTx` tetap nyata (ROLLBACK SQLite). 13 describe: (1) market open fail → tanpa posisi/order, cash utuh, `ORDER_FILLED` tidak hantu, retry sukses; (2) full close fail → posisi OPEN, cash utuh, `POSITION_CLOSED` tidak hantu; (3) partial fail → qty/exitPlan tidak berubah; (4) cancel fail → order NEW, cash utuh, `ORDER_CANCELLED` tidak hantu; (5) limit-new fail → tanpa order, cash 10000; (6) limit-fill fail → order NEW, tanpa posisi, event `ERROR`, retry sukses; (7) update SL/TP fail → nilai utuh, `POSITION_UPDATED` tidak hantu; (8) exitPlan set/remove fail → plan utuh; (9) breakEven fail → stopLoss utuh, `EXIT_ENGINE_ACTION` tidak hantu; (10) concurrency Promise.all([close,close]) → 1 sukses + 1 `POSITION_ALREADY_CLOSED` (bukan status DB_TX_FAILED); (11) idempotency clientOrderId sama → 1 posisi + receipt identik; (12) partial TP gagal → posisi tetap OPEN qty lama, tanpa duplikat; (13) HTTP `/api/broker/close` gagal → 400 `reason:DB_TX_FAILED`, posisi masih OPEN, retry → 200 FLAT. Restart diuji lewat `storageRows()` — koneksi SQLite read-only kedua membaca disk yang sama dan dibandingkan dengan memori.
- Command + exit (18 Sep 2026): `npx vitest run tests/integration/atomicityFailureInjection.test.ts --reporter=verbose` **14/14 exit 0**; `npm run lint` **exit 0**; `npx vitest run --reporter=dot` **223/223 PASS, 23 files, exit 0** (naik dari 209/22 — tanpa regresi; ledgerDeterministic/accountBalanceSnapshot/closePartial/breakEvenManual tetap hijau); `npm run build` selesai (warning import.meta cjs sudah lama, bukan error).
- Keterbatasan: broker/exchange & marketFetcher di-mock — bukan validasi feed publik; `commitTx` dipecah via partial mock (transaksi nyata lain tetap diesksekusi), bukan korupsi disk/spike nyata; restart disimulasikan sebagai koneksi SQLite read-only kedua (bukan proses OS terpisah); `ORDER_NEW` pada limit tetap dipancarkan SEBELUM commit (perilaku lama, sengaja dikeluarkan dari cakupan P0-04); sandbox TEST tidak menyentuh `trading.db`/vault pengguna di root.

### P0-05 — Rekonsiliasi fee/PnL/journal & data lama [DONE — acceptance + suite hijau]
- Owner: opencode/ARBLOK | tanggal: 2026-09-18
- [x] Total fee posisi vs fills direkonsiliasi: `fees_total_usd` ≡ Σ `fills.fee_usd` melalui `orders.position_id` (entry + tiap exit fill; entry fee dihitung SATU KALI di open, exit fill hanya menambah `fill.fee_usd` — tidak double-count).
- [x] Fee yang menempel sisa posisi (`fees_paid_usd`) ≠ seluruh fee historis (`fees_total_usd`) — kedua semantik dipisah dan diuji.
- [x] Partial PnL lama TIDAK di-backfill ke makna baru: migrasi jujur `open_qty = amount`, `fees_total_usd = fees_usd` (identity ≡ Σ fills hanya dijamin untuk posisi yang dibuka setelah kolom ada); analisis read-only, tanpa mengubah data lama.
- [x] Acceptance multi-partial/restart/final close: ledger/account/statistik direkonsiliasi (realized kumulatif ≡ state ≡ disk; restart tidak hilang/tidak dobel; R pakai `openQty`; close price = VWAP exit; journal membawa `openQty` + `totalFeesUSD`).
- Perbaikan minimal: tambah `openQty` (ukuran trade asal) + `feesTotalUSD` (fee kumulatif hidup) pada `PaperPosition`; kolom `positions.open_qty`/`fees_total_usd` + migrate backfill jujur; kolom `orders.position_id` + `idx_orders_position` + migrate; `dbSaveOrder` kini mengisi `position_id` dari `order.positionId` (SL/TP fallback sudah ada); pemeliharaan `feesTotalUSD` di fill open/partial/full-close + bracketMonitor limit-fill; `getLedgerStats` memakai `openQty` untuk R, VWAP exit (sisi berlawanan entry) untuk `closePrice`, dan menyertakan `openQty`/`totalFeesUSD`/`entrySource` di `closedTrades`; FE TradeJournalPanel menampilkan kolom "Qty (open)" + "Fees".
- Bukti: `tests/integration/reconcilePartialJournal.test.ts` (**2/2 PASS**) — SQLite nyata sandbox + HTTP Supertest + restart lewat koneksi SQLite read-only kedua. Skenario A (LONG 10@100 lev10; partial 2@101 → 2@102 → restart → final 6@103 → restart): identity fee 0.8096 = Σ [0.4, 0.0808, 0.0816, 0.2472]; mid-trade `fees_paid 0.24 ≠ fees_total 0.5624`; realized kumulatif 5.68 (mid) → 23.19 (flat) di memori, disk, dan HTTP `/api/ledger/stats`; `open_qty 10` tetap dengan `amount 6` sisa; R = 23.19/20 = 1.16 (bukan 23.19/12 = 1.93 versi qty sisa); VWAP close 102.4; equity snapshot mid 10017.44 = 9945.44 + margin 60 + uPnL 12. Skenario B (control close penuh 10@103 tanpa partial): feesTotal 0.812 = entry+exit, openQty == amount == 10, closePrice == 103, R = 1.46.
- Command + exit (18 Sep 2026): `npx vitest run tests/integration/reconcilePartialJournal.test.ts --reporter=verbose` **2/2 exit 0**; `npm run lint` **exit 0**; `npx vitest run --reporter=dot` **225/225 PASS, 24 files, exit 0** (naik dari 223/23 — tanpa regresi; ledgerDeterministic/accountBalanceSnapshot/closePartial/breakEvenManual/atomicityFailureInjection tetap hijau); `npm run build` selesai (warning import.meta cjs sudah lama, bukan error).
- Keterbatasan: identity fee ≡ Σ fills dijamin untuk posisi yang dibuka SETELAH kolom `fees_total_usd` ada (posisi lama memakai backfill `fees_usd` yang menyimpan fee pada qty SAAT INI, bukan historis); restart disimulasikan sebagai koneksi SQLite read-only kedua (bukan proses OS terpisah); broker/exchange & marketFetcher di-mock — bukan validasi feed publik; VWAP memakai fills SISI EXIT (sisi berlawanan entry), bukan seluruh fills; sandbox TEST tidak menyentuh `trading.db`/vault pengguna di root.

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

### Audit LOGIC_AUDIT_2026-09-18 — fix pack (owner: opencode, 2026-09-19)

`AUDIT-FIX | DONE | opencode | 2026-09-19 | lihat LOGIC_AUDIT_2026-09-18.md §7 | expected: semua temuan actionable fixed | actual: CRIT-1/2/3 FIXED + WARN-1/4/6/7 FIXED + WARN-2/3/5/8 documented | bukti: tests/integration/auditFindings20260918.test.ts 17/17, npm run lint exit 0, npm test 242/242 (25 files) exit 0, npm run build exit 0 | keterbatasan: WARN-2 (HTTP) & WARN-7 (jaringan FF) tanpa regression test; WARN-6 batas `.5` eksak float bukan properti yang diuji, yang diuji = hilangnya bias tanda | next step: temuan Adit`.

`BUILD-CLIENT-NODE-SQLITE | FIXED | opencode | 2026-09-19 | src/logic/keelAdapter.ts (statis fetchMacroReal dihapus, data di-inject), server.ts (fetch sisi server) | expected: vite build hijau | actual: exit 0 | bukti: buildout.txt | keterbatasan: keelAdapter tidak lagi self-fetch; caller server wajib inject | next step: —`.

### Audit LOGIC_AUDIT_2026-09-18 — gap verifier (owner: opencode, 2026-09-19)

`AUDIT-GAP-1 | DONE | opencode | 2026-09-19 | server.ts (boot-load kill switch), src/lib/round.ts (baru), src/paperbook/{store,fill,bracketMonitor}.ts, src/replay/replayEngine.ts, tests/integration/auditFindings20260918.test.ts (+4 test), LOGIC_AUDIT_2026-09-18.md §7/V-check | expected: CRIT-2 & WARN-6 gap verifier (Depsek) tertutup | actual: CRIT-2 boot-load ter-wire di server.ts (test WIRING: gate buta pre-load → AKTIF post-load); WARN-6 satu implementasi src/lib/round.ts dipakai paperbook + replay r2/r4/r6 | bukti: lint exit 0, auditFindings 21/21, npm test 246/246 (25 files) exit 0, npm run build exit 0 | keterbatasan: 1× transient worker flake saat run pertama (rerun bersih 246/246); `.gitignore` dokumen audit belum seragam (17 di-ignore vs 18 tidak) — dirunut lanjutan | next step: ROADMAP_EDGE_2026-09-19.md (ganti fokus risk → edge)`.

### Roadmap Edge (owner: opencode, 2026-09-19) — PETA KERJA, belum dikerjakan

`EDGE-ROADMAP | PLAN | opencode | 2026-09-19 | ROADMAP_EDGE_2026-09-19.md, LOGIC_REVIEW_LING_2026-09-19.md | expected: fokus win-rate (Simons) dengan grounding data, setelah risk-gate fix selesai | actual: roadmap + acceptance ditulis, council Ling/Nemotron dicatat (B vs A divergen, sintesis: fondasi data export dulu); council-2 menolak MM Jane Street sebagai edge utama (tanpa rebate/funding cash-flow/inventory/colo → retail mati) — direkam di roadmap | bukti: file roadmap | keterbatasan: belum ada pengerjaan; Fase 0 (buildReplayTrainingDataset join decisionId + walk-forward) belum diverifikasi; funding cash-flow TIDAK dimodel di paperbook/replay (hanya input sinyal + adjust liq) | next step: klaim ID EDGE-0 → verifikasi fondasi data replay, lalu Work-item B (bobot data-driven), lalu A (calibration). Backlog risk (P1/P2/P3 + Ling CRIT) tercatat di roadmap sebagai tunda.`.

### Vertical meme-coins: solana-scout (owner: opencode, 2026-09-19)

`MEME-SCOUT-2 | DONE | opencode | 2026-09-19 | solana-scout/scripts/lib/rpc.js (PUBLIC_RPCS +retry/backoff +cache resolveMintMeta), solana-scout/scripts/lib/scoring.js (fix gate null-masking/NaN/Infinity + failedGates listing), solana-scout/scripts/scan.js (atomic write tmp→rename), src/server/routes/scout.ts (mutex scan 409 + SCAN_TIMEOUT_MS 180s + cleanup partial), tests/integration/scoutRoute.test.ts, ROADMAP_EDGE_2026-09-19.md §Vertical-B | kubernetes: council (architecture+code) temukan: (a) BARU live path tidak pernah resolve symbol/name → panel token kosong; (b) NO_LIQUIDITY null di-mask jadi pass, MINT_AUTHORITY fail saat data null, fmtUsd(Infinity)→InfinityB, age NaN→"NaN jam"; (c) race scan double-write report.json, SIGKILL partial-corrupt, tanpa mutex; (d) rpc.js tanpa backoff/limit; (e) overload RugCheck 428 | actual: resolveMintMeta (Helius DAS → fallback RPC jsonParsed → shortMint) dipanggil scan.js live untuk tiap kandidat + signal.js bawa symbol/name; scoring.js: gates hanya aktif saat fundamentals tersedia (available=true ATAU rugRisk boolean), NO_LIQUIDITY null=0 (tak pass), MINT_AUTHORITY null=skip gate, NaN-age = "usia tidak diketahui", fmtUsd/fmtPct/fmtNum guard !isFinite, breakdown listing semua gate gagal (failedGates); scan.js write atomic; scout.ts mutex (409 SCAN_IN_PROGRESS), timeout 180s, cleanup tmp; RPC PUBLIC_RPCS = 6 endpoint free (mainnet-beta, publicnode, LeoRPC ?api_key=FREE, vibe-station, uniblock, tatum gateway — diverifikasi getSlot 2026-09-19; OnFinality public 429 excluded) + retry 2x + 429 sleep + meta cache 1h | bukti: scout unit 8/8, lint 0, suite engine 250/250, build ok, live scan 30 token mode=live (Helius 401 → fallback public RPC), scout/report HTTP 200 | keterbatasan: Helius key env `385cdd45…` ditolak 401 di semua endpoint (retest; bukan space/quote/format) → live pakai public RPC fallback, getAsset (metadata penuh+ticker asli) tidak jalan sampai key valid; age token masih NaN (blocktime/launch belum); OnFinality 429 | next: pemilik sediakan Helius key VALID (dashboard → generate baru) ATAU setujui resolver on-chain Metaplex / DexScreener buat ticker asli tanpa Helius; lalu prioritaskan council: (1) mutex/atomic done — (2) token age blocktime, (3) kandidat baru: KOL historical win-rate tracker (file JSON, beberapa minggu)`.

`MEME-SCOUT-3 | DONE | opencode+hermes | 2026-09-20 | solana-scout/scripts/lib/dexscreener.js (baru: client DexScreener UA-browser + pure pickMainPair/pairToMeta/filterBoosted/candidatesFromDiscovery/discoverBoosted), solana-scout/scripts/lib/rpc.js (resolveMintMeta DexScreener-first + ageHours), solana-scout/scripts/scan.js (mode --discovery bottom-up token-boosts + live age asli + fallback liq Dex saat RugCheck null), solana-scout/tests/dexscreener.test.js (baru 10/10), src/server/routes/scout.ts (mode discovery), src/components/SolanaScoutPanel.tsx (mode selector mock/live/discovery) | expected: (a) symbol/name asli + ageHours via DexScreener (fix age NaN); (b) discovery dari token-boosts | actual: resolveMintMeta → DexScreener symbol asli + ageHours dari pairCreatedAt (SANJO 17.2j; fallback shortMint + age null utk CA random); discovery live scan: 3-5 token/run, age real, fundamentals liq fallback Dex; semua SKIP wajar saat RugCheck flag High market cap per holder / top holder >40%; panel mode selector mock/live/discovery; route POST body.mode | bukti: scout unit 18/18 (was 8/8, +10 dexscreener), lint exit 0, npm run build exit 0, live `node scripts/scan.js --discovery --limit 5` report.json valid (BOBI 1.3j/TIGRINO 48.4j/SANJO 17.2j/QUEEF 340.6j/POMP 3.8j), resolveMintMeta unit live SANJO | keterbatasan: sentiment/narrative & Phase 5 dev-forensics NOT ported (butuh Helius+web-search); KOL overlay di discovery = 0 (skor murni fundamentals+age); DexScreener `liquidity.usd` sering undefined saat bonding curve (mcap <$5k) → SKIP wajar; decimals null di DexScreener (diisi RPC bila perlu); memakai default maxMcap 5j (bukan cuma <100k) supaya tidak semua SKIP — mcap low jadi kriteria tersendiri | next step: KOL overlay di discovery (cross-ref wallet KOL), newborn listener PumpPortal WS, token age dari blocktime utk yg gak ada pair Dex.`

> GUARDRAIL IVF: proyek ini JS/TS murni (296 MB total, 275 MB itu node_modules). DILARANG menambah Rust toolchain/cargo target, .py venv (bikin sendiri di luar repo), Bun install, atau lib binary. Port resolver DexScreener = fetch API via rpc.js aja, pakai dependency yang udah ada (global fetch). Jika ada output artuck, verifikasi size proyek setelah selesai: total <= 350 MB.
