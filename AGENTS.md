# Agent handoff — baca sebelum bekerja

## Status otoritatif

- **Baca [TODO.md](./TODO.md) terlebih dahulu.** Itu satu-satunya daftar progres aktif.
- [AUDIT_2026-09-17.md](./AUDIT_2026-09-17.md) adalah riwayat observasi/test. Klaim F9 "lima selesai" sudah dikoreksi: paper belum terverifikasi menyeluruh.
- README untuk pengantar/run, bukan sertifikat readiness. Dokumen di `.kilo/worktrees` adalah konteks branch lain, bukan status root terkini; sinkronkan dengan owner sebelum menggabungkan.

## Aturan kerja

1. Cek git status/diff dahulu; banyak perubahan pengguna/agent belum di-commit. Jangan reset, checkout atau overwrite perubahan lain.
2. Klaim satu ID TODO + owner/tanggal/status IN_PROGRESS. Jangan dua agent mengedit file yang sama bersamaan. Update progress dan bukti setelah selesai.
3. Tugas berikutnya: **P0-00 ledger deterministik**, sebelum klaim akuntansi benar. Expected dari hitungan manual, bukan menyalin output aplikasi.
4. Reproduksi -> perbaikan minimal -> regression test permanen -> lint/full suite/build -> acceptance. Bedakan mocked integration, real SQLite, browser E2E, public feed, testnet dan live.
5. Jalankan server/tests yang menulis state di sandbox dengan DB baru. DB dan vault mengikuti process.cwd(); mengimpor bootstrap di root dapat menyentuh state pengguna.
6. Jangan membuka `.env`, vault, session/key files atau menyalin secrets ke sandbox/log. Jangan reset/migrasi data pengguna atau mengaktifkan live tanpa persetujuan.
7. Jangan menghapus source/tests atau folder `.kilo/worktrees`, logs, dist hanya berdasarkan nama atau satu hasil pencarian. Jangan commit/push tanpa permintaan.
8. Jangan menyebut paper/live ready karena unit test hijau atau paper profit. Acceptance di TODO wajib dipenuhi. Pembulatan, fee, sisa quantity, funding, provenance dan event/DB consistency harus eksplisit.

## Navigasi singkat

- `server.ts`: bootstrap; `src/server/routes`: HTTP.
- `src/paperbook`: store/fill/bracket/exit; `src/db`: SQLite; `paperBook.ts` dan `db.ts`: barrels.
- `src/broker`: handlers paper/live; `broker.ts`: CCXT.
- `src/logic/decisionEngine.ts`, `src/logic/keelAdapter.ts`, `src/logic/keel`: keputusan/fitur.
- `src/replay/replayEngine.ts`: replay terpisah; jangan samakan dengan strategi live.
- `src/server/aiDataContext.ts`, `tests/integration/aiPrompt.test.ts`: kebijakan dan test prompt.
- FE Solana Scout (tab **Scout**) nyatu di aplikasi utama: `localhost:3000` (React → `src/components/SolanaScoutPanel.tsx`, API → `src/server/routes/scout.ts` membaca `solana-scout/output/report.json`). **SOT FE scout ada di sana**, bukan `solana-scout/ui` — dashboard `npm run serve` (port 4589) hanya view sekunder.
- Stack: TypeScript, Node 24, Express, SQLite node:sqlite, React/Vite, Vitest/Supertest.
- Perintah: `npm run lint`, `npm test -- --reporter=dot`, `npm run build`. `npm run test:smoke` perlu server terisolasi yang ditargetkan eksplisit; jangan memakai server pengguna tanpa izin.
