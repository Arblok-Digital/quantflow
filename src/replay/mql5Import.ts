/**
 * src/replay/mql5Import.ts
 * PURE parser + validator untuk file CSV ekspor MT5 (History Center / backtest
 * data). Hasilnya langsung bisa dipakai oleh replayEngine (ReplayCandle[]).
 *
 * Format baku MT5 (8 kolom):  TICKER, DTYYYYMMDD, TIME, OPEN, HIGH, LOW, CLOSE, VOL
 * Format 10 kolom (opsional): TICKER, DTYYYYMMDD, TIME, OPEN, HIGH, LOW, CLOSE,
 *                             TICKVOL, VOL, SPREAD
 * Tanggal dicoba dalam format `YYYY.MM.DD HH:MM[:SS]` (satu kolom datetime)
 * atau kolom tanggal + kolom waktu terpisah. Delimiter `;`/`,` di-detect
 * otomatis. Semua parsing deterministik: sort naik, duplikat persis dibuang,
 * timestamp sama dengan candle beda → throw (tidak boleh menebak).
 */

import fs from "node:fs";
import path from "node:path";
import type { ReplayCandle } from "./replayEngine";

export type Mql5ErrorCode =
  | "MQL5_INVALID_FILE"
  | "MQL5_FILE_NOT_FOUND"
  | "MQL5_PARSE_ERROR"
  | "MQL5_DUPLICATE_CONFLICT"
  | "MQL5_TIMEFRAME_MISMATCH";

export class Mql5ImportError extends Error {
  code: Mql5ErrorCode;
  constructor(code: Mql5ErrorCode, message: string) {
    super(message);
    this.name = "Mql5ImportError";
    this.code = code;
  }
}

export interface Mql5ParseOptions {
  /** Offset zona waktu broker relatif UTC (menit). 0 = waktu file sudah UTC. */
  utcOffsetMinutes?: number;
  /** Index kolom (0-based) yang berisi volume. Absen → auto-detect kolom numerik ke-5. */
  volumeColumn?: number;
  /** Spacing expected antar candle (ms) untuk deteksi gap & spacingOk. */
  timeframeMs?: number;
}

export interface Mql5Gap {
  fromTs: number;
  toTs: number;
}

export interface Mql5FileMeta {
  rowsParsed: number;
  candles: number;
  droppedDuplicates: number;
  firstTs: number | null;
  lastTs: number | null;
  offsetMinutes: number;
  delimiter: string;
  hasHeader: boolean;
  gaps: Mql5Gap[];
  spacingOk: boolean;
  /** Interval dominan antar candle (ms) — untuk deteksi TF mismatch di route. */
  spacingMs: number | null;
}

export interface Mql5ParseResult {
  candles: ReplayCandle[];
  meta: Mql5FileMeta;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const RE_DATE = /^\d{4}[./-]\d{1,2}[./-]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?$/;
const RE_DATE_ONLY = /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/;
const RE_TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const RE_HEADER = /date|time|ticker|open|high|low|close|vol|dt|<ticker>/i;

function detectDelimiter(line: string): string {
  const comma = (line.match(/,/g) || []).length;
  const semi = (line.match(/;/g) || []).length;
  // Pilih delimiter yang lebih banyak (default koma bila imbang).
  return semi > comma ? ";" : ",";
}

function isHeaderLine(cols: string[]): boolean {
  if (cols.length === 0) return false;
  const joined = cols.join(" ").trim();
  if (!RE_HEADER.test(joined)) return false;
  // Header harus mengandung token non-numerik yang dikenal — bukan baris data
  // yang isinya hanya angka (ticker bisa "BTCUSD", tapi header tetap berisi label).
  return cols.some((c) => /date|time|open|high|low|close|vol/i.test(c));
}

export function parseMql5DateTime(
  datePart: string,
  timePart: string | null,
  utcOffsetMinutes: number
): number {
  const m = datePart.trim().match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (!m) throw new Error(`Format tanggal tidak dikenal: "${datePart}"`);
  const [, y, mo, d] = m;
  let hh = 0;
  let mm = 0;
  let ss = 0;
  if (timePart) {
    const t = timePart.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!t) throw new Error(`Format waktu tidak dikenal: "${timePart}"`);
    hh = Number(t[1]);
    mm = Number(t[2]);
    ss = Number(t[3] || 0);
  }
  const epochUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), hh, mm, ss);
  if (!Number.isFinite(epochUtc)) {
    throw new Error(`Tanggal/waktu tidak valid: "${datePart} ${timePart ?? ""}"`);
  }
  // Offset broker relatif UTC: timestamp internal = waktu UTC sebenarnya.
  return epochUtc - utcOffsetMinutes * 60_000;
}

/**
 * Parse baris data → candle. Mengembalikan null bila baris tidak bisa dipetakan
 * (tidak dilempar — dikumpulkan jadi warning per-baris sesuai spec).
 */
export function parseMql5Row(
  cols: string[],
  offsetMinutes: number,
  volumeColumn: number | undefined
): ReplayCandle | null {
  // Cari kolom datetime (date+time) atau pasangan date/time.
  let dateIdx = -1;
  let timeIdx = -1;
  for (let i = 0; i < cols.length; i++) {
    const v = cols[i].trim();
    if (dateIdx === -1 && RE_DATE.test(v)) {
      // single combined datetime column
      dateIdx = i;
      timeIdx = -2; // -2 = time ada di kolom yang sama
      break;
    }
  }
  if (dateIdx === -1) {
    for (let i = 0; i < cols.length; i++) {
      const v = cols[i].trim();
      if (dateIdx === -1 && RE_DATE_ONLY.test(v)) dateIdx = i;
    }
    for (let i = 0; i < cols.length; i++) {
      const v = cols[i].trim();
      if (timeIdx === -1 && i !== dateIdx && RE_TIME.test(v)) timeIdx = i;
    }
  }
  if (dateIdx === -1) return null;

  let epoch: number;
  if (timeIdx === -2) {
    const parts = cols[dateIdx].trim().split(/\s+/);
    epoch = parseMql5DateTime(parts[0], parts.slice(1).join(" "), offsetMinutes);
  } else {
    epoch = parseMql5DateTime(
      cols[dateIdx].trim(),
      timeIdx >= 0 ? cols[timeIdx].trim() : null,
      offsetMinutes
    );
  }
  if (!Number.isFinite(epoch)) return null;

  // Kolom non-tanggal/waktu, urut apa adanya. Baris MT5 standar berawal dari
  // ticker (non-numerik) lalu O,H,L,C[,VOL...]. Posisi dijaga: open = kolom
  // data ke-0, dst — kalau salah satu gagal parse → baris dianggap rusak
  // (bukan digeser, agar kolom yang rusak tidak menipu nilai tetangga).
  const rest: string[] = [];
  for (let i = 0; i < cols.length; i++) {
    if (i === dateIdx || (timeIdx >= 0 && i === timeIdx)) continue;
    rest.push(cols[i].trim());
  }
  if (rest.length > 0 && !Number.isFinite(Number(rest[0]))) {
    // Kolom pertama = ticker (non-numerik) → buang, sisanya data murni.
    rest.shift();
  }
  const toNum = (s: string | undefined): number | null => {
    if (s === undefined || s === "") return null;
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  };
  const open = toNum(rest[0]);
  const high = toNum(rest[1]);
  const low = toNum(rest[2]);
  const close = toNum(rest[3]);
  if (open === null || high === null || low === null || close === null) return null;
  if (!(open > 0 && high > 0 && low > 0 && close > 0)) return null;

  let volume = toNum(rest[4]) ?? 0;
  if (volumeColumn !== undefined && volumeColumn >= 0 && volumeColumn < cols.length) {
    const v = toNum(cols[volumeColumn]);
    if (v !== null) volume = v;
  }
  if (!Number.isFinite(volume) || volume < 0) volume = 0;

  return {
    timestamp: epoch,
    open,
    high,
    low,
    close,
    volume,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function parseMql5Csv(text: string, opts: Mql5ParseOptions = {}): Mql5ParseResult {
  const warnings: string[] = [];
  const offsetMinutes = opts.utcOffsetMinutes ?? 0;

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    throw new Mql5ImportError("MQL5_INVALID_FILE", "File CSV kosong — tidak ada baris data.");
  }

  const delimiter = detectDelimiter(lines[0]);
  const split = (l: string): string[] => l.split(delimiter).map((c) => c.trim());

  const firstCols = split(lines[0]);
  const hasHeader = isHeaderLine(firstCols);
  let rowsParsed = 0;
  let malformed = 0;
  const candles: ReplayCandle[] = [];
  const byTs = new Map<number, ReplayCandle>();

  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cols = split(lines[i]);
    if (cols.length === 0) continue;
    try {
      const candle = parseMql5Row(cols, offsetMinutes, opts.volumeColumn);
      if (!candle) {
        malformed += 1;
        warnings.push(`Baris ${i + 1} tidak bisa dipetakan ke OHLCV (dilewati): ${lines[i].slice(0, 120)}`);
        continue;
      }
      rowsParsed += 1;
      const existing = byTs.get(candle.timestamp);
      if (existing) {
        const same =
          existing.open === candle.open &&
          existing.high === candle.high &&
          existing.low === candle.low &&
          existing.close === candle.close &&
          existing.volume === candle.volume;
        if (same) {
          warnings.push(`Baris ${i + 1}: duplikat persis timestamp ${candle.timestamp} dibuang.`);
          continue;
        }
        throw new Mql5ImportError(
          "MQL5_DUPLICATE_CONFLICT",
          `Timestamp ${candle.timestamp} muncul dua kali dengan OHLCV berbeda (baris ${i + 1}). ` +
            `Konflik — tidak bisa menentukan candle yang benar.`
        );
      }
      byTs.set(candle.timestamp, candle);
      candles.push(candle);
    } catch (err) {
      if (err instanceof Mql5ImportError) throw err;
      malformed += 1;
      warnings.push(`Baris ${i + 1}: parse gagal (${(err as Error).message}) — dilewati: ${lines[i].slice(0, 120)}`);
    }
  }

  if (candles.length === 0) {
    throw new Mql5ImportError(
      "MQL5_PARSE_ERROR",
      `Tidak ada candle valid dari ${lines.length} baris (${malformed} baris rusak).`
    );
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);

  // Spacing / gap detection.
  const timeframeMs = opts.timeframeMs;
  const gaps: Mql5Gap[] = [];
  let irregularIntervals = 0;
  let prevTs = candles[0].timestamp;
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].timestamp - prevTs;
    if (timeframeMs && diff > timeframeMs * 1.5) {
      gaps.push({ fromTs: prevTs, toTs: candles[i].timestamp });
    }
    if (timeframeMs && diff !== timeframeMs) irregularIntervals += 1;
    prevTs = candles[i].timestamp;
  }
  const totalIntervals = Math.max(1, candles.length - 1);
  const spacingOk = timeframeMs
    ? irregularIntervals / totalIntervals <= 0.1 &&
      candles.every((c) => c.timestamp % timeframeMs === candles[0].timestamp % timeframeMs)
    : true;

  // Interval dominan (mode dari seluruh diff) — dipakai route untuk menolak
  // file yang spacing-nya tidak cocok dengan timeframe yang diminta user.
  let spacingMs: number | null = null;
  if (candles.length >= 2) {
    const freq = new Map<number, number>();
    for (let i = 1; i < candles.length; i++) {
      const d = candles[i].timestamp - candles[i - 1].timestamp;
      freq.set(d, (freq.get(d) ?? 0) + 1);
    }
    let bestCount = -1;
    for (const [d, c] of freq) {
      if (c > bestCount) {
        bestCount = c;
        spacingMs = d;
      }
    }
  }

  return {
    candles,
    meta: {
      rowsParsed,
      candles: candles.length,
      droppedDuplicates: candles.length === rowsParsed ? 0 : rowsParsed - candles.length,
      firstTs: candles[0].timestamp,
      lastTs: candles[candles.length - 1].timestamp,
      offsetMinutes,
      delimiter,
      hasHeader,
      gaps,
      spacingOk,
      spacingMs,
    },
    warnings,
  };
}

/** Baca file lalu parse. Gunakan ini dari route server (guard traversal di route, bukan di sini). */
export function loadMql5CsvFile(absPath: string, opts: Mql5ParseOptions = {}): Mql5ParseResult {
  let text: string;
  try {
    text = fs.readFileSync(absPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Mql5ImportError("MQL5_FILE_NOT_FOUND", `File MQL5 tidak ditemukan: ${absPath}`);
    }
    throw new Mql5ImportError("MQL5_INVALID_FILE", `Gagal membaca file MQL5: ${(err as Error).message}`);
  }
  return parseMql5Csv(text, opts);
}

/**
 * Path folder data MQL5 — LAZY per pemanggilan (mirror getDbFilePath di
 * src/db/core.ts): env `MQL5_DATA_DIR` || `<cwd>/data/mql5`. Pelajari ulang
 * per request karena test/process bisa `chdir` — jangan simpan di module scope.
 */
export function getMql5DataDir(): string {
  const envDir = process.env.MQL5_DATA_DIR?.trim();
  const dir = envDir ? path.resolve(envDir) : path.join(process.cwd(), "data", "mql5");
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Best effort — route yang membaca akan error MQL5_FILE_NOT_FOUND lebih jelas.
    }
  }
  return dir;
}