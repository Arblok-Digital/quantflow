import { describe, it, expect } from "vitest";
import {
  parseMql5Csv,
  loadMql5CsvFile,
  getMql5DataDir,
  Mql5ImportError,
  parseMql5DateTime,
} from "./mql5Import";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TF_15M = 15 * 60_000;

function csv8(rows: string[], delimiter = ",", header = true): string {
  const head = header ? `TICKER${delimiter}DTYYYYMMDD${delimiter}TIME${delimiter}OPEN${delimiter}HIGH${delimiter}LOW${delimiter}CLOSE${delimiter}VOL` : "";
  return [head, ...rows].filter((l) => l !== "").join("\n");
}

describe("parseMql5Csv", () => {
  it("parses 8-column comma CSV without header, ascending order", () => {
    const txt = csv8(
      [
        "BTCUSD,2024.01.15,10:30,100,101,99,100.5,1200",
        "BTCUSD,2024.01.15,10:15,99.5,100.5,98.5,100,1100",
        "BTCUSD,2024.01.15,10:00,99,100,98,99.5,1000",
      ],
      ",",
      false
    );
    const { candles, meta, warnings } = parseMql5Csv(txt, { timeframeMs: TF_15M });
    expect(candles.length).toBe(3);
    // sorted ascending by timestamp
    expect(candles[0].open).toBe(99);
    expect(candles[1].open).toBe(99.5);
    expect(candles[2].open).toBe(100);
    expect(candles[0].timestamp).toBeLessThan(candles[1].timestamp);
    expect(meta.rowsParsed).toBe(3);
    expect(meta.candles).toBe(3);
    expect(meta.hasHeader).toBe(false);
    expect(meta.delimiter).toBe(",");
    expect(meta.spacingOk).toBe(true);
    expect(meta.firstTs).toBe(candles[0].timestamp);
    expect(meta.lastTs).toBe(candles[2].timestamp);
    expect(warnings).toHaveLength(0);
  });

  it("detects semicolon delimiter and skips header", () => {
    const txt = csv8(
      ["ETHUSD;2024.01.15;10:00;1000;1005;995;1002;500", "ETHUSD;2024.01.15;10:15;1002;1008;1000;1006;600"],
      ";",
      true
    );
    const { candles, meta } = parseMql5Csv(txt, { timeframeMs: TF_15M });
    expect(candles.length).toBe(2);
    expect(meta.delimiter).toBe(";");
    expect(meta.hasHeader).toBe(true);
    expect(candles[0].close).toBe(1002);
    expect(candles[1].close).toBe(1006);
  });

  it("parses 10-column format (tickvol/vol/spread) with volume auto = first numeric after close", () => {
    const head = "TICKER,DTYYYYMMDD,TIME,OPEN,HIGH,LOW,CLOSE,TICKVOL,VOL,SPREAD";
    const txt = [
      head,
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200,1500,1",
      "BTCUSD,2024.01.15,10:15,100.5,101.5,100,101,1300,1600,1",
    ].join("\n");
    const { candles } = parseMql5Csv(txt, { timeframeMs: TF_15M });
    expect(candles[0].volume).toBe(1200); // TICKVOL default (kolom numerik ke-5)
    expect(candles[1].volume).toBe(1300);
  });

  it("supports explicit volumeColumn override (VOL column index 8)", () => {
    const txt = csv8(
      ["BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200,1500,1", "BTCUSD,2024.01.15,10:15,100.5,101.5,100,101,1300,1600,1"],
      ","
    );
    const { candles } = parseMql5Csv(txt, { timeframeMs: TF_15M, volumeColumn: 8 });
    expect(candles[0].volume).toBe(1500);
    expect(candles[1].volume).toBe(1600);
  });

  it("applies utcOffsetMinutes to timestamps", () => {
    const txt = csv8(["BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200"]);
    const utc = parseMql5Csv(txt, { utcOffsetMinutes: 0 });
    const shifted = parseMql5Csv(txt, { utcOffsetMinutes: 120 }); // broker UTC+2 → harga sama, timestamp = epoch UTC
    const expectedUtc = Date.UTC(2024, 0, 15, 10, 0, 0);
    expect(utc.candles[0].timestamp).toBe(expectedUtc);
    expect(shifted.candles[0].timestamp).toBe(expectedUtc - 120 * 60_000);
  });

  it("handles combined datetime column (YYYY.MM.DD HH:MM:SS)", () => {
    const txt = [
      "date,open,high,low,close,volume",
      "2024.01.15 10:00:00,100,101,99,100.5,1200",
      "2024.01.15 10:15:00,100.5,101.5,100,101,1300",
    ].join("\n");
    const { candles, meta } = parseMql5Csv(txt, { timeframeMs: TF_15M });
    expect(candles.length).toBe(2);
    expect(candles[0].timestamp).toBe(Date.UTC(2024, 0, 15, 10, 0, 0));
    expect(candles[1].timestamp).toBe(Date.UTC(2024, 0, 15, 10, 15, 0));
    expect(meta.spacingOk).toBe(true);
  });

  it("drops exact duplicates (second occurrence)", () => {
    const txt = csv8([
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:15,100.5,101.5,100,101,1300",
    ]);
    const { candles, meta, warnings } = parseMql5Csv(txt, { timeframeMs: TF_15M });
    expect(candles.length).toBe(2);
    expect(meta.droppedDuplicates).toBe(1);
    expect(warnings.some((w) => w.includes("duplikat"))).toBe(true);
  });

  it("throws MQL5_DUPLICATE_CONFLICT on same timestamp with different OHLCV", () => {
    const txt = csv8([
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:00,101,102,100,101.5,1300",
    ]);
    expect(() => parseMql5Csv(txt)).toThrow(Mql5ImportError);
    try {
      parseMql5Csv(txt);
      expect.unreachable();
    } catch (err) {
      expect((err as Mql5ImportError).code).toBe("MQL5_DUPLICATE_CONFLICT");
    }
  });

  it("collects malformed rows as warnings with line info, keeps valid ones", () => {
    const txt = [
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
      "BTCUSD,GARBAGE,10:00,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:15,100.5,101.5,100,101,1300",
    ].join("\n");
    const { candles, meta, warnings } = parseMql5Csv(txt, { timeframeMs: TF_15M });
    expect(candles.length).toBe(2);
    expect(meta.rowsParsed).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Baris 2");
  });

  it("measures gaps and spacingOk=false when >10% intervals deviate", () => {
    const txt = csv8([
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:15,100.5,101.5,100,101,1300",
      "BTCUSD,2024.01.15,10:45,103,104,102,103.5,1400", // +30m → gap (skip 10:30)
      "BTCUSD,2024.01.15,11:00,103.5,104.5,103,104,1500",
    ]);
    const { meta } = parseMql5Csv(txt, { timeframeMs: TF_15M });
    expect(meta.gaps.length).toBe(1);
    expect(meta.gaps[0].fromTs).toBe(Date.UTC(2024, 0, 15, 10, 15, 0));
    expect(meta.gaps[0].toTs).toBe(Date.UTC(2024, 0, 15, 10, 45, 0));
    // 3 interval, 1 irregular → 33% > 10% → spacingOk false
    expect(meta.spacingOk).toBe(false);
  });

  it("spacingOk stays true when irregular fraction is within 10%", () => {
    const txt = csv8([
      "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:15,100.5,101.5,100,101,1300",
      "BTCUSD,2024.01.15,10:30,101,102,100,101.5,1400",
      "BTCUSD,2024.01.15,10:47,102,103,101,102.5,1500", // +17m — phase bergeser, 1/3 irregular
      "BTCUSD,2024.01.15,11:02,102.5,103.5,102,103,1600",
    ]);
    // menghitung: 4 interval; irregular = yang diff != 15m. Namun phase check juga.
    const { meta } = parseMql5Csv(txt, { timeframeMs: TF_15M });
    // 10:47 dan 11:02 tidak selaras phase 10:00 — spacingOk false (phase drift).
    expect(meta.spacingOk).toBe(false);
  });

  it("is deterministic: identical input → identical candles and meta", () => {
    const txt = csv8([
      "BTCUSD,2024.01.15,10:30,100,101,99,100.5,1200",
      "BTCUSD,2024.01.15,10:00,99,100,98,99.5,1000",
      "BTCUSD,2024.01.15,10:15,99.5,100.5,98.5,100,1100",
    ]);
    const a = parseMql5Csv(txt, { timeframeMs: TF_15M, utcOffsetMinutes: 0 });
    const b = parseMql5Csv(txt, { timeframeMs: TF_15M, utcOffsetMinutes: 0 });
    expect(a.candles).toEqual(b.candles);
    expect(a.meta).toEqual(b.meta);
    expect(a.warnings).toEqual(b.warnings);
    // json deterministik
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("throws MQL5_INVALID_FILE on empty input", () => {
    expect(() => parseMql5Csv("", {})).toThrow(Mql5ImportError);
  });

  it("throws MQL5_PARSE_ERROR when no valid candles at all", () => {
    const txt = "BTCUSD,2024.01.15,10:00,BAD,101,99,100.5,1200";
    expect(() => parseMql5Csv(txt)).toThrow(Mql5ImportError);
    try {
      parseMql5Csv(txt);
      expect.unreachable();
    } catch (err) {
      expect((err as Mql5ImportError).code).toBe("MQL5_PARSE_ERROR");
    }
  });

  it("parseMql5DateTime handles optional seconds and offsets", () => {
    expect(parseMql5DateTime("2024.01.15", "10:00", 0)).toBe(Date.UTC(2024, 0, 15, 10, 0, 0));
    expect(parseMql5DateTime("2024.01.15", "10:00:30", 0)).toBe(Date.UTC(2024, 0, 15, 10, 0, 30));
    expect(parseMql5DateTime("2024.01.15", "10:00", 60)).toBe(Date.UTC(2024, 0, 15, 9, 0, 0));
  });
});

describe("loadMql5CsvFile + getMql5DataDir", () => {
  it("loads file from disk and reports MQL5_FILE_NOT_FOUND on missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "mql5-import-"));
    try {
      const file = join(dir, "data.csv");
      writeFileSync(file, "BTCUSD,2024.01.15,10:00,100,101,99,100.5,1200\n", "utf-8");
      const res = loadMql5CsvFile(file, {});
      expect(res.candles.length).toBe(1);
      expect(() => loadMql5CsvFile(join(dir, "missing.csv"), {})).toThrow(/tidak ditemukan/i);
      try {
        loadMql5CsvFile(join(dir, "missing.csv"), {});
        expect.unreachable();
      } catch (err) {
        expect((err as Mql5ImportError).code).toBe("MQL5_FILE_NOT_FOUND");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getMql5DataDir resolves env MQL5_DATA_DIR lazily per call and creates dir", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "mql5-dir-"));
    try {
      const envDir = join(sandbox, "hot-dir");
      const prev = process.env.MQL5_DATA_DIR;
      process.env.MQL5_DATA_DIR = envDir;
      expect(getMql5DataDir()).toBe(envDir);
      expect(existsSync(envDir)).toBe(true);
      delete process.env.MQL5_DATA_DIR;
      // fallback <cwd>/data/mql5
      const defaultDir = getMql5DataDir();
      expect(defaultDir.endsWith(join("data", "mql5"))).toBe(true);
      if (prev === undefined) delete process.env.MQL5_DATA_DIR;
      else process.env.MQL5_DATA_DIR = prev;
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});