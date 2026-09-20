// ---------------------------------------------------------------------------
// scout.ts — Solana Scout (vertical meme, mesin TERPISAH)
// Routes: GET /api/scout/report   -> baca output/report.json (read-only, tidak
//                                    menyentuh paperbook/HMAC ledger engine)
//         POST /api/scout/scan    -> jalankan ulang scan via child process
//                                    node (real: live atau discovery; mock
//                                    dilarang — 400 MOCK_DISABLED)
// Prinsip: mesin scout TIDAK pernah dicampur ke akuntansi engine futures.
// Verdict hanya bacaan informasi untuk keputusan alokasi venture kecil.
// ---------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireAuth } from "@/auth";

const DEFAULT_SCOUT_DIR = path.resolve(process.cwd(), "solana-scout");

function getScoutDir(): string {
  return process.env.SOLANA_SCOUT_DIR || DEFAULT_SCOUT_DIR;
}

function reportFile(): string {
  return path.join(getScoutDir(), "output", "report.json");
}

function readReport(): { body: any; missing: boolean; error: string | null } {
  const file = reportFile();
  try {
    if (!fs.existsSync(file)) {
      return { body: null, missing: true, error: null };
    }
    const raw = fs.readFileSync(file, "utf8");
    return { body: JSON.parse(raw), missing: false, error: null };
  } catch (e: any) {
    return { body: null, missing: false, error: e?.message || "corrupt report" };
  }
}

function getReportMeta(): { dir: string; reportExists: boolean; reportMtime: string | null } {
  const file = reportFile();
  try {
    const st = fs.statSync(file);
    return { dir: getScoutDir(), reportExists: true, reportMtime: st.mtime.toISOString() };
  } catch {
    return { dir: getScoutDir(), reportExists: false, reportMtime: null };
  }
}

export function registerScoutRoutes(app: Express): void {
  const SCAN_TIMEOUT_MS = 180_000; // live scan 138 wallet bisa lama
  let scanLock = false;

  function cleanupPartial(): void {
    // File tmp dihapus — report lama tetap utuh (scan.js menulis atomic rename).
    try {
      const tmp = `${reportFile()}.tmp`;
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* noop */
    }
  }

  app.get("/api/scout/report", requireAuth, (_req: Request, res: Response) => {
    const { body, missing, error } = readReport();
    if (missing) {
      res.status(404).json({
        success: false,
        reason: "NO_REPORT",
        message: `Belum ada report di ${reportFile()}. Jalankan scan dulu (mis. POST /api/scout/scan).`,
        meta: getReportMeta(),
      });
      return;
    }
    if (error) {
      res.status(500).json({ success: false, reason: "CORRUPT_REPORT", message: error, meta: getReportMeta() });
      return;
    }
    res.json({ success: true, fileMeta: getReportMeta(), ...body });
  });

  app.post("/api/scout/scan", requireAuth, (req: Request, res: Response) => {
    if (scanLock) {
      res.status(409).json({ success: false, reason: "SCAN_IN_PROGRESS", message: "Scan sedang berjalan, tunggu selesai." });
      return;
    }
    const body = req.body || {};
    if (body?.mode === "mock") {
      res.status(400).json({ success: false, reason: "MOCK_DISABLED", message: "Mock mode dihapus — scan hanya real (live/discovery)." });
      return;
    }
    scanLock = true;
    const mode = body?.mode === "live" ? "live" : "discovery";
    const args =
      mode === "live"
        ? ["scripts/scan.js", "--wallets", "20", "--limit", "30"]
        : ["scripts/scan.js", "--discovery", "--limit", "50", "--max-mcap", "5000000", "--min-liq", "0"];
    const child = spawn(process.execPath, args, {
      cwd: getScoutDir(),
      env: { ...process.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let didRespond = false;
    const timer = setTimeout(() => {
      if (didRespond) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }, SCAN_TIMEOUT_MS);

    const finish = (payload: Record<string, unknown>, status = 200): void => {
      if (didRespond) return;
      didRespond = true;
      clearTimeout(timer);
      scanLock = false;
      res.status(status).json(payload);
    };

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", (err) => {
      finish({ success: false, reason: "SPAWN_FAILED", message: err.message }, 500);
    });

    child.on("close", (code) => {
      if (didRespond) {
        cleanupPartial();
        scanLock = false;
        return;
      }
      const { body, missing, error } = readReport();
      if (missing) {
        finish({ success: false, reason: "SCAN_NO_OUTPUT", message: stderr || stdout, meta: getReportMeta() }, 500);
        return;
      }
      if (error) {
        finish({ success: false, reason: "SCAN_CORRUPT", message: error, meta: getReportMeta() }, 500);
        return;
      }
      const scanned = body?.meta?.mode || mode;
      finish({ success: true, exitCode: code, scanned, ...body });
    });
  });
}