/**
 * F5: single-writer guard — cegah dua proses server menulis trading.db bersamaan.
 *
 * Forensik $123.01: dua lineage snapshot (cash/margin) bergantian tiap ~3s
 * selama berjam-jam — dua proses (dev + prod, atau dua terminal) berbagi satu
 * DB. Proses basi menimpa snapshot dengan state basi (melewatkan close
 * +$123.47), sehingga cash snapshot ≠ replay dari tabel positions.
 *
 * Guard ini: tulis pid + boot-id + heartbeat ke tabel writer_lease; proses yang
 * start KEDUA akan mendeteksi lease aktif (< 30s) milik pid lain yang MASIH
 * HIDUP, lalu FAIL-CLOSED (throw) sebelum menyentuh DB. Lease basi (pemilik
 * mati / heartbeat tua) diambil alih secara aman.
 */
import { getDb } from "./core";

const LEASE_TTL_MS = 30_000;

function leaseTable(): void {
  const _db = getDb();
  _db.exec(`
    CREATE TABLE IF NOT EXISTS writer_lease(
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pid INTEGER NOT NULL,
      boot_id TEXT NOT NULL,
      heartbeat INTEGER NOT NULL,
      started_at INTEGER NOT NULL
    );
  `);
}

function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Sinyal 0 = cek eksistensi tanpa membunuh (POSIX). Di Windows selalu
    // throw (tidak didukung) → fallback ke asumsi lease penjelasan di bawah.
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // ESRCH = tidak ada proses → mati. EPERM = ada tapi tak boleh sinyal → hidup.
    if (e?.code === "ESRCH") return false;
    if (e?.code === "EPERM") return true;
    // Windows (ENOSYS/UNKNOWN): tidak bisa memastikan — anggap lease basi
    // HANYA jika heartbeat juga tua (pengecekan umur di bawah tetap berlaku).
    return true;
  }
}

export function acquireWriterLease(bootId: string): { ok: true; stolen: boolean } {
  leaseTable();
  const _db = getDb();
  const now = Date.now();
  const row = _db.prepare("SELECT pid, boot_id, heartbeat FROM writer_lease WHERE id = 1").get() as any;
  if (row) {
    const age = now - Number(row.heartbeat || 0);
    const ownerAlive = processAlive(Number(row.pid));
    if (age < LEASE_TTL_MS && ownerAlive && String(row.boot_id) !== bootId) {
      const err = new Error(
        `DUPLICATE_WRITER: trading.db sudah ditulis proses pid=${row.pid} (heartbeat ${Math.round(age / 1000)}s lalu). ` +
        `Matikan proses lain dulu — dua server paper sharing satu DB merusak cash (insiden $123.01).`
      ) as Error & { code?: string };
      err.code = "DUPLICATE_WRINTER";
      (err as any).code = "DUPLICATE_WRITER";
      throw err;
    }
    const stolen = String(row.boot_id) !== bootId;
    _db.prepare("UPDATE writer_lease SET pid = ?, boot_id = ?, heartbeat = ?, started_at = ? WHERE id = 1").run(process.pid, bootId, now, now);
    return { ok: true, stolen };
  }
  _db.prepare("INSERT INTO writer_lease (id, pid, boot_id, heartbeat, started_at) VALUES (1, ?, ?, ?, ?)").run(process.pid, bootId, now, now);
  return { ok: true, stolen: false };
}

export function heartbeatWriterLease(bootId: string): void {
  try {
    const _db = getDb();
    _db.prepare("UPDATE writer_lease SET heartbeat = ? WHERE id = 1 AND boot_id = ?").run(Date.now(), bootId);
  } catch {
    /* best-effort — lease basi akan diambil alih proses berikutnya */
  }
}

export function getWriterLease(): { pid: number; bootId: string; heartbeat: number; startedAt: number } | null {
  try {
    leaseTable();
    const row = getDb().prepare("SELECT pid, boot_id, heartbeat, started_at FROM writer_lease WHERE id = 1").get() as any;
    if (!row) return null;
    return { pid: Number(row.pid), bootId: String(row.boot_id), heartbeat: Number(row.heartbeat), startedAt: Number(row.started_at) };
  } catch {
    return null;
  }
}
