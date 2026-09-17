/**
 * src/paperbook/mutex.ts
 * Antrean mutasi buku paper (P0 anti race-condition).
 *
 * Kenapa: `openPaperPosition()` melakukan cek duplikat posisi lalu `await
 * marketFill()` (network I/O). Dua request konkuren untuk simbol+side yang sama
 * sama-sama lolos cek duplikat SEBELUM fill selesai (TOCTOU) → posisi identik
 * berkali-kali. Bukti forensik trading.db: 5 posisi LONG BTC entry 80234.01
 * dibuka dalam 33 ms, semuanya kena stop bersamaan → −$52.95 dari satu klik
 * burst (0.53% equity).
 *
 * Semua mutasi buku (open/close/cancel) sekarang lewat satu antrean FIFO
 * per-proses, sehingga cek duplikat + guardrail + mutasi cash bersifat atomik
 * terhadap request lain. Mutasi lain (mark update, bracket monitor) tetap
 * berjalan seperti sebelumnya — hanya operasi yang mengubah posisi/cash.
 */

let chain: Promise<unknown> = Promise.resolve();

/** Jalankan `fn` setelah semua mutasi paper sebelumnya selesai (FIFO). */
export function withPaperMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Rantai tidak boleh putus karena error pemanggil — swallow di rantai saja,
  // error asli tetap dilempar ke pemanggil lewat `run`.
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Untuk test: tunggu semua mutasi yang sedang berjalan selesai. */
export function awaitPaperMutationIdle(): Promise<void> {
  return chain.then(
    () => undefined,
    () => undefined
  );
}