#!/usr/bin/env node
/**
 * scripts/mql5-import.mts — CLI verifier untuk file CSV ekspor MT5.
 *
 * Usage:
 *   npm run mql5:verify -- --file BTCUSD15.csv --timeframe 15m [--offset 0] [--out summary.json]
 *
 * --file       nama file (relatif ke MQL5_DATA_DIR / data/mql5 / cwd) atau path absolut
 * --timeframe  1m|5m|15m|30m|1h|4h|1D dst (untuk deteksi gap & TF mismatch)
 * --offset     offset zona waktu broker relatif UTC dalam menit (default 0)
 * --out        path JSON untuk menulis ringkasan (opsional)
 *
 * Murni memakai parser yang sama dengan route server (src/replay/mql5Import.ts).
 * Tidak menulis apa pun ke DB / sesi replay — hanya verifikasi file.
 */
import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { loadMql5CsvFile, getMql5DataDir, Mql5ImportError } from "../src/replay/mql5Import.ts";

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "8h": 28_800_000, "12h": 43_200_000, "1D": 86_400_000, "1W": 604_800_000,
};

function resolveFile(name: string): string | null {
  const direct = path.resolve(name);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const envDir = process.env.MQL5_DATA_DIR?.trim();
  const dirs = envDir ? [envDir] : [];
  dirs.push(getMql5DataDir(), path.join(process.cwd(), "data", "mql5"), process.cwd());
  for (const d of dirs) {
    const p = path.resolve(d, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      timeframe: { type: "string", default: "15m" },
      offset: { type: "string", default: "0" },
      out: { type: "string" },
    },
  });

  const fileArg = values.file;
  if (!fileArg) {
    console.error("Usage: mql5:verify -- --file <file.csv> --timeframe <tf> [--offset <minutes>] [--out <json>]");
    process.exitCode = 1;
    return;
  }
  const abs = resolveFile(fileArg);
  if (!abs) {
    console.error(`FILE_NOT_FOUND: ${fileArg} (cari di MQL5_DATA_DIR, data/mql5, dan cwd)`);
    process.exitCode = 1;
    return;
  }

  const offsetMinutes = Math.floor(Number(values.offset) || 0);
  const timeframe = String(values.timeframe);
  const timeframeMs = TIMEFRAME_MS[timeframe];
  try {
    const { candles, meta, warnings } = loadMql5CsvFile(abs, {
      utcOffsetMinutes: offsetMinutes,
      timeframeMs,
    });
    const range = (ts: number | null) =>
      ts != null ? new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z" : "?";
    const tfMismatch = !!(timeframeMs && meta.spacingMs && Math.abs(meta.spacingMs - timeframeMs) > timeframeMs * 0.1);

    console.log(`file       : ${abs}`);
    console.log(`timeframe  : ${timeframe} (requested)`);
    console.log(`offset UTC : ${offsetMinutes} menit`);
    console.log(`rows parsed: ${meta.rowsParsed} (${meta.droppedDuplicates} dupes dropped)`);
    console.log(`candles    : ${candles.length}`);
    console.log(`range      : ${range(meta.firstTs)} → ${range(meta.lastTs)}`);
    console.log(`spacing    : ${meta.spacingMs != null ? Math.round(meta.spacingMs / 60000) + "m" : "?"} (spacingOk=${meta.spacingOk})`);
    console.log(`delimiter  : "${meta.delimiter}" header=${meta.hasHeader}`);
    console.log(`gaps       : ${meta.gaps.length}`);
    for (const g of meta.gaps.slice(0, 5)) {
      console.log(`  gap ${range(g.fromTs)} → ${range(g.toTs)}`);
    }
    if (meta.gaps.length > 5) console.log(`  … ${meta.gaps.length - 5} gap lagi`);
    if (tfMismatch) {
      console.warn(`WARNING TF MISMATCH: spacing file ${Math.round((meta.spacingMs ?? 0) / 60000)}m != ${timeframe} — sesi replay akan ditolak.`);
      process.exitCode = 2;
    }
    for (const w of warnings) console.warn(`WARN: ${w}`);

    if (values.out) {
      const out = {
        file: fileArg,
        timeframe,
        utcOffsetMinutes: offsetMinutes,
        candles: candles.length,
        rowsParsed: meta.rowsParsed,
        droppedDuplicates: meta.droppedDuplicates,
        firstTs: meta.firstTs,
        lastTs: meta.lastTs,
        spacingMs: meta.spacingMs,
        spacingOk: meta.spacingOk,
        gaps: meta.gaps,
        tfMismatch,
        warnings: warnings.slice(0, 50),
      };
      fs.writeFileSync(path.resolve(values.out), JSON.stringify(out, null, 2), "utf-8");
      console.log(`summary    : ${path.resolve(values.out)}`);
    }
  } catch (err) {
    if (err instanceof Mql5ImportError) {
      console.error(`${err.code}: ${err.message}`);
    } else {
      console.error(`PARSE_ERROR: ${(err as Error).message}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err?.message ?? err}`);
  process.exitCode = 1;
});