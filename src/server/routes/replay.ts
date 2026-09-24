// ---------------------------------------------------------------------------
// replay.ts — Replay / Forward-Test routes (isolated book, real historical data)
// Routes: /api/paper/replay/* (start, status, step, run, pause, reset, speed,
//         strategy, order, close, cancel, export, runs, runs/:id)
// ---------------------------------------------------------------------------
import type { Express, Request, Response } from "express";
import path from "node:path";
import { requireAuth } from "@/auth";
import {
  fetchHistoricalCandles,
  getReplayStatus,
  startReplay,
  stepReplay,
  runReplay,
  pauseReplay,
  resetReplay,
  setReplaySpeed,
  placeReplayOrder,
  closeReplayPositionManual,
  cancelReplayOrder,
  getReplaySessionFull,
  buildReplayTrainingDataset,
  setReplayMode,
} from "@/src/replay/replayEngine";
import {
  getMql5DataDir,
  loadMql5CsvFile,
  Mql5ImportError,
} from "@/src/replay/mql5Import";
import {
  appendAudit,
  saveReplayRunDb,
  listReplayRunsDb,
  getReplayRunDb,
} from "@/db";

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "8h": 28_800_000, "12h": 43_200_000, "1D": 86_400_000, "1W": 604_800_000,
};

/** Resolve nama file MQL5 → abs path DI DALAM data dir. Null = traversal/tidak valid. */
function resolveMql5FileSafe(fileName: string, dir: string): string | null {
  const name = String(fileName || "").trim();
  if (!/^[A-Z0-9_.-]+\.csv$/i.test(name)) return null;
  const base = path.resolve(dir);
  const abs = path.resolve(base, name);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}


export function registerReplayRoutes(app: Express): void {
// REPLAY / FORWARD-TEST endpoints (isolated book, real historical data)
// ==========================================================================
// Start replay: source default "binance" (Binance Vision). source="mql5" =
// baca file CSV ekspor MT5 dari MQL5_DATA_DIR (guard traversal + TF check).
app.post("/api/paper/replay/start", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const source = String(body.source || "binance");
    const symbol = String(body.symbol || "BTC/USDT");
    const timeframe = String(body.timeframe || "15m");
    const initialCash = Number(body.initialCash) > 0 ? Number(body.initialCash) : 10000;

    if (source === "mql5") {
      const mql5File = String(body.mql5File || "");
      const utcOffsetMinutes = Number(body.utcOffsetMinutes) || 0;
      const dir = getMql5DataDir();
      const abs = resolveMql5FileSafe(mql5File, dir);
      if (!abs) {
        return res.status(400).json({
          success: false,
          reason: "MQL5_INVALID_FILE",
          message: "Nama file MQL5 tidak valid (hanya huruf/angka/_.- + ekstensi .csv, tanpa path).",
        });
      }
      try {
        const timeframeMs = TIMEFRAME_MS[timeframe];
        const { candles, meta, warnings } = loadMql5CsvFile(abs, { utcOffsetMinutes, timeframeMs });
        if (timeframeMs && meta.spacingMs && Math.abs(meta.spacingMs - timeframeMs) > timeframeMs * 0.1) {
          return res.status(400).json({
            success: false,
            reason: "MQL5_TIMEFRAME_MISMATCH",
            message:
              `Spacing file (${Math.round(meta.spacingMs / 60000)}m) tidak cocok dengan timeframe yang diminta (${timeframe}).`,
          });
        }
        if (candles.length === 0) {
          return res.status(400).json({ success: false, reason: "MQL5_PARSE_ERROR", message: "File MQL5 tidak berisi candle valid." });
        }
        const session = startReplay(symbol, timeframe, candles, initialCash, "mql5");
        return res.json({
          success: true,
          session,
          warnings: warnings.slice(0, 20),
          meta: {
            rowsParsed: meta.rowsParsed,
            droppedDuplicates: meta.droppedDuplicates,
            firstTs: meta.firstTs,
            lastTs: meta.lastTs,
            spacingMs: meta.spacingMs,
            spacingOk: meta.spacingOk,
            gaps: meta.gaps,
            offsetMinutes: meta.offsetMinutes,
          },
        });
      } catch (err: any) {
        if (err instanceof Mql5ImportError) {
          const status = err.code === "MQL5_FILE_NOT_FOUND" ? 404 : 400;
          return res.status(status).json({ success: false, reason: err.code, message: err.message });
        }
        return res.status(400).json({ success: false, reason: "MQL5_PARSE_ERROR", message: err?.message || "Gagal parse file MQL5." });
      }
    }

    const startMs = Number(body.startMs);
    const endMs = Number(body.endMs);
    if (!isFinite(startMs) || !isFinite(endMs) || startMs >= endMs) {
      return res.status(400).json({ success: false, reason: "INVALID_RANGE", message: "startMs dan endMs wajib diisi (startMs < endMs)." });
    }
    const { candles, error } = await fetchHistoricalCandles(symbol, timeframe, startMs, endMs);
    if (error || candles.length === 0) {
      return res.status(400).json({ success: false, reason: "FETCH_FAILED", message: error || "Tidak ada data." });
    }
    const session = startReplay(symbol, timeframe, candles, initialCash);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Gagal start replay." });
  }
});

// Verify file MQL5 tanpa membuat sesi: parse + summary (untuk tombol Verify di FE).
app.get("/api/paper/replay/mql5/verify", requireAuth, (req, res) => {
  try {
    const mql5File = String((req.query as any).mql5File || "");
    const timeframe = String((req.query as any).timeframe || "15m");
    const utcOffsetMinutes = Number((req.query as any).utcOffsetMinutes) || 0;
    const dir = getMql5DataDir();
    const abs = resolveMql5FileSafe(mql5File, dir);
    if (!abs) {
      return res.status(400).json({ success: false, reason: "MQL5_INVALID_FILE", message: "Nama file MQL5 tidak valid." });
    }
    const timeframeMs = TIMEFRAME_MS[timeframe];
    const { candles, meta, warnings } = loadMql5CsvFile(abs, { utcOffsetMinutes, timeframeMs });
    const stemRaw = mql5File.replace(/\.csv$/i, "").toUpperCase();
    const stem = stemRaw.replace(/\d+$/, "").replace(/[^A-Z]/g, "");
    const symbol = String((req.query as any).symbol || (/^[A-Z]{2,10}$/.test(stem) ? `${stem}/USDT` : "MQL5"));
    return res.json({
      success: true,
      summary: {
        file: mql5File,
        symbol,
        timeframe,
        utcOffsetMinutes,
        candles: candles.length,
        firstTs: meta.firstTs,
        lastTs: meta.lastTs,
        spacingMs: meta.spacingMs,
        spacingOk: meta.spacingOk,
        gaps: meta.gaps,
        droppedDuplicates: meta.droppedDuplicates,
        rowsParsed: meta.rowsParsed,
        delimiter: meta.delimiter,
        hasHeader: meta.hasHeader,
        tfMismatch: !!(timeframeMs && meta.spacingMs && Math.abs(meta.spacingMs - timeframeMs) > timeframeMs * 0.1),
        warnings: warnings.slice(0, 20),
      },
    });
  } catch (err: any) {
    if (err instanceof Mql5ImportError) {
      const status = err.code === "MQL5_FILE_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ success: false, reason: err.code, message: err.message });
    }
    res.status(400).json({ success: false, reason: "MQL5_PARSE_ERROR", message: err?.message || "Gagal verify file MQL5." });
  }
});

app.get("/api/paper/replay/status", requireAuth, (_req, res) => {
  res.json({ success: true, ...getReplayStatus() });
});

app.post("/api/paper/replay/step", requireAuth, (req, res) => {
  try {
    const session = stepReplay();
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Step gagal." });
  }
});

app.post("/api/paper/replay/run", requireAuth, (_req, res) => {
  try {
    const session = runReplay();
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Run gagal." });
  }
});

app.post("/api/paper/replay/pause", requireAuth, (_req, res) => {
  const session = pauseReplay();
  res.json({ success: true, session });
});

app.post("/api/paper/replay/reset", requireAuth, (_req, res) => {
  const session = resetReplay();
  res.json({ success: true, session });
});

app.post("/api/paper/replay/speed", requireAuth, (req, res) => {
  try {
    const speedMs = Number((req.body || {}).speedMs) > 0 ? Number((req.body || {}).speedMs) : 100;
    const session = setReplaySpeed(speedMs);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Set speed gagal." });
  }
});

// Auto-execute mode: mode="auto" → strategi teknikal deterministik dieksekusi
// per candle; mode="manual" → kembali ke eksekusi manual. params optional.
app.post("/api/paper/replay/strategy", requireAuth, (req, res) => {
  try {
    const body = req.body || {};
    const mode = body.mode === "auto" ? "auto" : "manual";
    const params = body.params && typeof body.params === "object" ? body.params : undefined;
    const session = setReplayMode(mode, params);
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Set strategy gagal." });
  }
});

// Place order di replay book (terpisah dari paper book live)
app.post("/api/paper/replay/order", requireAuth, (req, res) => {
  try {
    const order = placeReplayOrder(req.body || {});
    res.json({ success: true, order });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Order replay gagal." });
  }
});

app.post("/api/paper/replay/close", requireAuth, (req, res) => {
  try {
    const position = closeReplayPositionManual(String((req.body || {}).positionId || ""));
    res.json({ success: true, position });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Close replay gagal." });
  }
});

app.post("/api/paper/replay/cancel", requireAuth, (req, res) => {
  try {
    const order = cancelReplayOrder(String((req.body || {}).orderId || ""));
    res.json({ success: true, order });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Cancel replay gagal." });
  }
});

// Save hasil sesi replay aktif ke SQLite (training data). Hanya sesi done/paused.
app.post("/api/paper/replay/export", requireAuth, (req, res) => {
  try {
    const full = getReplaySessionFull();
    if (!full) {
      return res.status(400).json({ success: false, message: "Tidak ada sesi replay aktif." });
    }
    if (full.currentIndex < 0) {
      return res.status(400).json({ success: false, message: "Sesi belum dijalankan — tidak ada hasil untuk disimpan." });
    }
    const ds = buildReplayTrainingDataset();
    saveReplayRunDb({
      id: ds.runId,
      symbol: ds.symbol,
      timeframe: ds.timeframe,
      startTs: ds.startTs,
      endTs: ds.endTs,
      totalCandles: ds.totalCandles,
      initialCash: ds.initialCash,
      finalEquity: ds.finalEquity,
      realizedPnl: ds.realizedPnl,
      maxDrawdownPct: ds.maxDrawdownPct,
      totalTrades: ds.stats.totalTrades,
      winRate: ds.stats.winRate,
      profitFactor: ds.stats.profitFactor,
      avgR: ds.stats.avgR,
      createdAt: Date.now(),
      resultJson: JSON.stringify(ds),
    });
    try {
      appendAudit("replay_export", {
        runId: ds.runId,
        symbol: ds.symbol,
        timeframe: ds.timeframe,
        totalTrades: ds.stats.totalTrades,
        realizedPnl: ds.realizedPnl,
        source: "REAL",
        feed: String(ds.dataSource || "binance"),
      });
    } catch (err) {
      console.error("[audit] GAGAL tulis audit replay_export: ", (err as Error)?.message);
    }
    res.json({ success: true, runId: ds.runId, stats: ds.stats, savedAt: ds.savedAt });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Export replay gagal." });
  }
});

// Daftar run replay yang tersimpan (training data history)
app.get("/api/paper/replay/runs", requireAuth, (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    res.json({ success: true, runs: listReplayRunsDb(limit) });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Gagal load replay runs." });
  }
});

// Detail satu run replay tersimpan — format=json (default) atau format=csv
app.get("/api/paper/replay/runs/:id", requireAuth, (req, res) => {
  try {
    const row = getReplayRunDb(String(req.params.id));
    if (!row) {
      return res.status(404).json({ success: false, message: "Replay run tidak ditemukan." });
    }
    const format = String((req.query as any).format || "json").toLowerCase();
    if (format === "csv") {
      const parsed = JSON.parse(row.resultJson);
      // Rebuild CSV deterministik dari trades tersimpan (sama dengan builder live).
      const header = [
        "trade_id", "symbol", "side", "qty", "leverage",
        "entry_price", "entry_candle_index", "entry_candle_ts",
        "exit_price", "exit_candle_index", "exit_candle_ts",
        "exit_reason", "pnl_usd", "pnl_percent", "risk_r", "fees_usd",
        "hold_candles", "decision_id", "entry_source", "strategy", "ambiguous_exit", "data_source",
      ].join(",");
      const esc = (v: unknown): string => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const dataSource = String(parsed.dataSource || "binance");
      const lines = [header];
      for (const t of parsed.trades || []) {
        lines.push([
          esc(t.id), esc(t.symbol), esc(t.side), esc(t.qty), esc(t.leverage),
          esc(t.entryPrice), esc(t.openedCandleIndex), esc(t.openedCandleTs ?? ""),
          esc(t.exitPrice), esc(t.closedCandleIndex), esc(t.closedCandleTs ?? ""),
          esc(t.exitReason), esc(t.pnlUSD), esc(t.pnlPercent), esc(t.riskR ?? ""),
          esc(t.feesPaidUSD), esc(t.holdCandles), esc(t.decisionId ?? ""),
          esc(t.entrySource ?? ""), esc(t.strategy ?? ""),
          esc(t.ambiguousExit ? "1" : "0"),
          esc(dataSource),
        ].join(","));
      }
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="replay-${row.run.id}.csv"`);
      return res.send(lines.join("\n"));
    }
    res.json({ success: true, run: row.run, dataset: JSON.parse(row.resultJson) });
  } catch (err: any) {
    res.status(400).json({ success: false, message: err?.message || "Gagal load replay run." });
  }
});


}
