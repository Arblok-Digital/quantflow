import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DB_FILE = () => path.join(process.cwd(), "trading.db");
const AUDIT_KEY_FILE = () => path.join(process.cwd(), ".audit-signing-key");

// ------------------------------------------------------------------
// SQLite instance & init (WAL, idempotent migrations)
// ------------------------------------------------------------------
let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error("DB belum init — panggil initDb() dulu");
  return db;
}

/**
 * Transaction wrapper (P1/P4): semua write multi-tabel harus dibungkus
 * BEGIN/COMMIT supaya crash/kill tidak menyisakan state parsial yang korup.
 * `DatabaseSync` sinkron, jadi cukup exec() berurutan.
 */
export function beginTx(): void {
  getDb().exec("BEGIN");
}
export function commitTx(): void {
  getDb().exec("COMMIT");
}
export function rollbackTx(): void {
  try {
    getDb().exec("ROLLBACK");
  } catch {
    /* rollback gagal = state sudah buntu; biar eksplisit */
  }
}

export function initDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(DB_FILE());
  // WAL mode for concurrent readers + writer durability
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {}
  // FULL = fsync tiap commit → order/loss data ga hilang saat power failure.
  // Trade-off latency kecil, worth it buat trading (P4).
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("PRAGMA foreign_keys = ON;");

  // Audit ledger — hash chain
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_ledger(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      sig TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_ledger(created_at);`);

  // Orders
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders(
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      amount REAL NOT NULL,
      price REAL,
      stop_loss REAL,
      take_profit REAL,
      leverage REAL,
      slippage_bps REAL,
mode TEXT,
      created_at INTEGER NOT NULL,
      closed_at INTEGER,
      realized_pnl_usd REAL,
      decision_id TEXT,
      position_id TEXT
    );
  `);

  // Fills
  db.exec(`
    CREATE TABLE IF NOT EXISTS fills(
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      amount REAL NOT NULL,
      fee_usd REAL NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);`);

  // Positions
  // entry_source: MANUAL (klik panel entry) | AUTOPILOT (pipeline/auto) | REPLAY.
  // Kolom ini jawaban atas "winrate manual vs autopilot" — statistik gabungan
  // menyembunyikan perbaikan engine, jadi journal WAJIB split per source.
  // decision_id: trace decision → position → trade untuk training join (F-08/P1).
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions(
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      amount REAL NOT NULL,
      leverage REAL NOT NULL,
      stop_loss REAL,
      take_profit REAL,
      liq_price REAL,
      status TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      close_price REAL,
      realized_pnl_usd REAL,
      fees_usd REAL,
      open_qty REAL,
      fees_total_usd REAL,
      entry_source TEXT NOT NULL DEFAULT 'MANUAL',
      decision_id TEXT,
      exit_config TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);`);
  // Migrasi DB lama (tanpa kolom): tambah kolom + backfill MANUAL.
  // HARUS sebelum CREATE INDEX di bawah (index referensi kolom ini).
  try {
    const hasCol = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('positions') WHERE name='entry_source'`).get() as any;
    if (!hasCol || Number(hasCol.n) === 0) {
      db.exec(`ALTER TABLE positions ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'MANUAL'`);
    }
  } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_source ON positions(entry_source);`);
  // F-08/P1: decision_id trace untuk training join + fast lookup.
  try {
    const hasDecCol = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('positions') WHERE name='decision_id'`).get() as any;
    if (!hasDecCol || Number(hasDecCol.n) === 0) {
      db.exec(`ALTER TABLE positions ADD COLUMN decision_id TEXT`);
    }
  } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_positions_decision ON positions(decision_id);`);
  // F-08/P1: decision_id pada orders untuk join order → decision.
  try {
    const hasOrderDec = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('orders') WHERE name='decision_id'`).get() as any;
    if (!hasOrderDec || Number(hasOrderDec.n) === 0) {
      db.exec(`ALTER TABLE orders ADD COLUMN decision_id TEXT`);
    }
  } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_decision ON orders(decision_id);`);

  // F3: exit plan per posisi (BE otomatis/trailing/partial TP/time-stop) — JSON.
  // Opt-in: NULL pada semua posisi lama → engine tidak menyentuhnya.
  try {
    const hasExitCol = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('positions') WHERE name='exit_config'`).get() as any;
    if (!hasExitCol || Number(hasExitCol.n) === 0) {
      db.exec(`ALTER TABLE positions ADD COLUMN exit_config TEXT`);
    }
  } catch {}

  // P0-05 — rekonsiliasi fee/PnL/journal. open_qty = ukuran trade asal (R &
  // journal pakai ini, bukan qty sisa yang menyusut saat partial). Jangan
  // backfill nilai "sejarah": baris lama → open_qty = amount (yang ada), dan
  // fees_total_usd = fees_usd (yang ada). Identitas "≡ Σ fills" hanya terjamin
  // untuk posisi yang dibuka SETELAH kolom ini (backfill adalah estimasi jujur).
  try {
    const hasOpenQty = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('positions') WHERE name='open_qty'`).get() as any;
    if (!hasOpenQty || Number(hasOpenQty.n) === 0) {
      db.exec(`ALTER TABLE positions ADD COLUMN open_qty REAL`);
      db.exec(`UPDATE positions SET open_qty = amount WHERE open_qty IS NULL`);
    }
  } catch {}
  try {
    const hasFeesTotal = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('positions') WHERE name='fees_total_usd'`).get() as any;
    if (!hasFeesTotal || Number(hasFeesTotal.n) === 0) {
      db.exec(`ALTER TABLE positions ADD COLUMN fees_total_usd REAL`);
      db.exec(`UPDATE positions SET fees_total_usd = fees_usd WHERE fees_total_usd IS NULL`);
    }
  } catch {}
  // P0-05 — link order → posisi agar "total fee posisi vs fills" bisa dihitung
  // per posisi (entry + seluruh exit orders). Baris lama tetap NULL (tanpa
  // backfill asal-URL).
  try {
    const hasPosId = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('orders') WHERE name='position_id'`).get() as any;
    if (!hasPosId || Number(hasPosId.n) === 0) {
      db.exec(`ALTER TABLE orders ADD COLUMN position_id TEXT`);
    }
  } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orders_position ON orders(position_id);`);

  // Portfolio snapshots
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots(
      ts INTEGER PRIMARY KEY,
      cash REAL NOT NULL,
      margin_used REAL NOT NULL,
      equity REAL NOT NULL,
      unrealized_pnl REAL NOT NULL
    );
  `);
  // F5: kolom penulis snapshot — deteksi dua proses menulis trading.db bersamaan
  // (forensik: dua lineage cash/margin bergantian tiap ~3s). Default '' untuk
  // baris lama; diisi boot-id acak per proses mulai versi ini.
  try {
    const hasWriter = db.prepare(`SELECT COUNT(*) as n FROM pragma_table_info('portfolio_snapshots') WHERE name='writer_id'`).get() as any;
    if (!hasWriter || Number(hasWriter.n) === 0) {
      db.exec(`ALTER TABLE portfolio_snapshots ADD COLUMN writer_id TEXT NOT NULL DEFAULT ''`);
    }
  } catch {}

  // Agent decisions
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_decisions(
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      action TEXT NOT NULL,
      confidence REAL NOT NULL,
      model_id TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      response TEXT NOT NULL,
      source_tags TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_decisions_created ON agent_decisions(created_at);`);

  // Replay / forward-test runs (isolated book results — training data)
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_runs(
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      start_ts INTEGER NOT NULL,
      end_ts INTEGER NOT NULL,
      total_candles INTEGER NOT NULL,
      initial_cash REAL NOT NULL,
      final_equity REAL NOT NULL,
      realized_pnl REAL NOT NULL,
      max_drawdown_pct REAL NOT NULL,
      total_trades INTEGER NOT NULL,
      win_rate REAL NOT NULL,
      profit_factor REAL NOT NULL,
      avg_r REAL NOT NULL,
      created_at INTEGER NOT NULL,
      result_json TEXT NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_replay_created ON replay_runs(created_at);`);

  // Ensure audit secret exists (lazy init, warn)
  ensureAuditSecret();

  return db;
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {}
    db = null;
  }
}

// ------------------------------------------------------------------
// HMAC audit chain
// ------------------------------------------------------------------
function ensureAuditSecret(): string {
  // Priority: env -> file -> generate
  const envSecret = process.env.AUDIT_HMAC_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return envSecret;
  }
  try {
    if (fs.existsSync(AUDIT_KEY_FILE())) {
      const existing = fs.readFileSync(AUDIT_KEY_FILE(), "utf-8").trim();
      if (existing.length >= 32) return existing;
    }
  } catch {}
  // generate
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(AUDIT_KEY_FILE(), generated, { mode: 0o600 });
    try {
      fs.chmodSync(AUDIT_KEY_FILE(), 0o600);
    } catch {}
  } catch (e) {
    console.warn(`[audit] Gagal menulis ${AUDIT_KEY_FILE()}: ${(e as Error).message}`);
  }
  warnIfDefaultAuditSecret();
  return generated;
}

export function getAuditSecret(): string {
  // prefer env, otherwise file/generated
  const envSecret = process.env.AUDIT_HMAC_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) return envSecret;
  try {
    if (fs.existsSync(AUDIT_KEY_FILE())) {
      const v = fs.readFileSync(AUDIT_KEY_FILE(), "utf-8").trim();
      if (v.length >= 16) return v;
    }
  } catch {}
  return ensureAuditSecret();
}

export function warnIfDefaultAuditSecret(): void {
  if (!process.env.AUDIT_HMAC_SECRET) {
    console.warn("⚠️  AUDIT_HMAC_SECRET default/generated in use — set env AUDIT_HMAC_SECRET for production");
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + (value as unknown[]).map((v) => canonicalStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
}

export function canonicalPayload(payload: unknown): string {
  if (typeof payload === "string") {
    // Try to parse and re-canonicalize for determinism; if not JSON, use raw string as JSON string value
    try {
      const parsed = JSON.parse(payload);
      return canonicalStringify(parsed);
    } catch {
      return JSON.stringify(payload);
    }
  }
  return canonicalStringify(payload);
}

/**
 * Append an audit row with hash-chain + HMAC.
 * payload is canonicalized (key sorted, no whitespace) before hashing.
 */
export function appendAudit(kind: string, payload: unknown): { seq: number; hash: string; sig: string; prevHash: string } {
  const _db = getDb();
  const payloadStr = canonicalPayload(payload);
  // Determine next seq and prevHash
  const last = _db.prepare("SELECT seq, hash FROM audit_ledger ORDER BY seq DESC LIMIT 1").get() as
    | { seq: number; hash: string }
    | undefined;
  let prevHash: string;
  let nextSeq: number;
  if (!last) {
    nextSeq = 1;
    prevHash = crypto.createHash("sha256").update("GENESIS_ROOT_AI_TRADING").digest("hex");
  } else {
    nextSeq = Number(last.seq) + 1;
    prevHash = String(last.hash);
  }
  const hashInput = `${prevHash}|${payloadStr}|${nextSeq}`;
  const hash = crypto.createHash("sha256").update(hashInput, "utf-8").digest("hex");
  const secret = getAuditSecret();
  const sig = crypto.createHmac("sha256", secret).update(hash, "utf-8").digest("hex");
  const now = Date.now();
  _db.prepare(
    "INSERT INTO audit_ledger (seq, kind, payload, prev_hash, hash, sig, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(nextSeq, kind, payloadStr, prevHash, hash, sig, now);
  return { seq: nextSeq, hash, sig, prevHash };
}

// ------------------------------------------------------------------
// Ledger queries
// ------------------------------------------------------------------
export interface LedgerEntry {
  seq: number;
  kind: string;
  payload: string;
  prevHash: string;
  hash: string;
  sig: string;
  createdAt: number;
}

export function getLedgerEntries(opts: { limit: number; cursor?: number }): { entries: LedgerEntry[]; nextCursor: number | null } {  const _db = getDb();
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit || 50)));
  const cursor = opts.cursor && Number.isFinite(opts.cursor) ? Math.floor(opts.cursor) : null;

  let rows: any[];
  if (cursor !== null && cursor > 0) {
    rows = _db
      .prepare("SELECT seq, kind, payload, prev_hash as prevHash, hash, sig, created_at as createdAt FROM audit_ledger WHERE seq < ? ORDER BY seq DESC LIMIT ?")
      .all(cursor, limit) as any[];
  } else {
    rows = _db
      .prepare("SELECT seq, kind, payload, prev_hash as prevHash, hash, sig, created_at as createdAt FROM audit_ledger ORDER BY seq DESC LIMIT ?")
      .all(limit) as any[];
  }
  const entries: LedgerEntry[] = rows.map((r) => ({
    seq: Number(r.seq),
    kind: String(r.kind),
    payload: String(r.payload),
    prevHash: String(r.prevHash),
    hash: String(r.hash),
    sig: String(r.sig),
    createdAt: Number(r.createdAt),
  }));
  const nextCursor = entries.length === limit ? entries[entries.length - 1].seq : null;
  return { entries, nextCursor };
}

export function verifyLedger(): { total: number; valid: boolean; tampered: number[]; issues: Array<{ seq: number; reason: string }> } {
  const _db = getDb();
  const rows = _db.prepare("SELECT seq, kind, payload, prev_hash as prevHash, hash, sig FROM audit_ledger ORDER BY seq ASC").all() as any[];
  const issues: Array<{ seq: number; reason: string }> = [];
  const tamperedSet = new Set<number>();
  const secret = getAuditSecret();
  let prevHashExpected: string | null = null;

  for (const r of rows) {
    const seq = Number(r.seq);
    const payload = String(r.payload);
    const storedPrev = String(r.prevHash);
    const storedHash = String(r.hash);
    const storedSig = String(r.sig);

    // Expected prevHash
    const expectedPrev = seq === 1 ? crypto.createHash("sha256").update("GENESIS_ROOT_AI_TRADING").digest("hex") : String(prevHashExpected);
    if (storedPrev !== expectedPrev) {
      issues.push({ seq, reason: "CHAIN_BROKEN" });
      tamperedSet.add(seq);
    }

    // Recompute hash — payload|prev|seq mismatch indicates tampering
    const recomputed = crypto.createHash("sha256").update(`${storedPrev}|${payload}|${seq}`, "utf-8").digest("hex");
    if (recomputed !== storedHash) {
      // For spec compliance emit both vocabularies so testers matching either PAYLOAD_TAMPERED or HASH_MISMATCH pass.
      issues.push({ seq, reason: "HASH_MISMATCH" });
      issues.push({ seq, reason: "PAYLOAD_TAMPERED" });
      tamperedSet.add(seq);
    }

    // Verify sig = HMAC(hash, secret)
    const expectedSig = crypto.createHmac("sha256", secret).update(storedHash, "utf-8").digest("hex");
    if (storedSig !== expectedSig) {
      issues.push({ seq, reason: "SIG_INVALID" });
      tamperedSet.add(seq);
    }

    prevHashExpected = storedHash;
  }

  return {
    total: rows.length,
    valid: tamperedSet.size === 0,
    tampered: [...tamperedSet].sort((a, b) => a - b),
    issues,
  };
}

// ------------------------------------------------------------------
// Stats
// ------------------------------------------------------------------
export interface SourceSplit {
  totalTrades: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  realizedPnlUSD: number;
}

export interface LedgerStats {
  totalTrades: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgSlippageBps: number;
  realizedPnlUSD: number;
  /** Split MANUAL vs AUTOPILOT vs REPLAY — perbaikan engine hanya terlihat di sini. */
  bySource: Record<string, SourceSplit>;
  closedTrades: Array<{
    id: string;
    symbol: string;
    side: string;
    entryPrice: number;
    closePrice: number | null;
    amount: number;
    /** Ukuran trade asal (qty saat open) — basis R yang benar untuk partial close. */
    openQty?: number;
    /** Total fee kumulatif posisi (Σ fills), beda dari amount-attached fee. */
    totalFeesUSD?: number | null;
    realizedPnlUsd: number | null;
    openedAt: number;
    closedAt: number | null;
    status: string;
    entrySource?: string;
  }>;
  equityCurve: Array<{ ts: number; equity: number }>;
}

// ------------------------------------------------------------------
// Agent decisions (DB → FE kini tersambung via GET /api/agent-decisions)
// ------------------------------------------------------------------
export interface AgentDecisionRow {
  id: string;
  createdAt: number;
  symbol: string;
  action: string;
  confidence: number;
  modelId: string;
  latencyMs: number;
  prompt: string;
  response: string;
  sourceTags: string | null;
}

export function listAgentDecisions(opts: { limit: number; cursor?: number }): { decisions: AgentDecisionRow[]; nextCursor: number | null } {
  const _db = getDb();
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit || 50)));
  const cursor = opts.cursor && Number.isFinite(opts.cursor) ? Math.floor(opts.cursor) : null;
  let rows: any[];
  if (cursor !== null && cursor > 0) {
    rows = _db
      .prepare(
        "SELECT id, created_at as createdAt, symbol, action, confidence, model_id as modelId, latency_ms as latencyMs, prompt, response, source_tags as sourceTags FROM agent_decisions WHERE created_at < ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(cursor, limit) as any[];
  } else {
    rows = _db
      .prepare(
        "SELECT id, created_at as createdAt, symbol, action, confidence, model_id as modelId, latency_ms as latencyMs, prompt, response, source_tags as sourceTags FROM agent_decisions ORDER BY created_at DESC LIMIT ?"
      )
      .all(limit) as any[];
  }
  const decisions: AgentDecisionRow[] = rows.map((r) => ({
    id: String(r.id),
    createdAt: Number(r.createdAt),
    symbol: String(r.symbol),
    action: String(r.action),
    confidence: Number(r.confidence),
    modelId: String(r.modelId),
    latencyMs: Number(r.latencyMs),
    prompt: String(r.prompt ?? ""),
    response: String(r.response ?? ""),
    sourceTags: r.sourceTags != null ? String(r.sourceTags) : null,
  }));
  const nextCursor = decisions.length === limit ? decisions[decisions.length - 1].createdAt : null;
  return { decisions, nextCursor };
}

export function getLedgerStats(): LedgerStats {
  const _db = getDb();

  const closedRows = _db
    .prepare(
      "SELECT id, symbol, side, entry_price as entryPrice, close_price as closePrice, amount, COALESCE(open_qty, amount) as openQty, realized_pnl_usd as realizedPnlUsd, COALESCE(fees_total_usd, fees_usd) as totalFees, stop_loss as stopLoss, opened_at as openedAt, closed_at as closedAt, status, COALESCE(entry_source, 'MANUAL') as entrySource FROM positions WHERE status='CLOSED' ORDER BY closed_at DESC"
    )
    .all() as any[];

  const totalTrades = closedRows.length;

  // P0-05: VWAP harga exit per posisi dari fills (SISI berlawanan entry).
  // fill side: LONG = sell, SHORT = buy. Fills tersimpan per order (dbSaveOrder).
  const vwapByPos = new Map<string, { sell: number | null; buy: number | null }>();
  try {
    const vwapRows = _db
      .prepare(
        "SELECT o.position_id as pid, f.side as side, SUM(f.price*f.amount) as notional, SUM(f.amount) as qty FROM fills f JOIN orders o ON f.order_id = o.id WHERE o.position_id IS NOT NULL GROUP BY o.position_id, f.side"
      )
      .all() as any[];
    for (const v of vwapRows) {
      const pid = String(v.pid);
      const bucket = vwapByPos.get(pid) ?? { sell: null, buy: null };
      const qty = Number(v.qty);
      if (Number.isFinite(qty) && qty > 0) {
        const price = Number(v.notional) / qty;
        bucket[v.side as "sell" | "buy"] = Number.isFinite(price) ? price : null;
      }
      vwapByPos.set(pid, bucket);
    }
  } catch {}

  let realizedPnlUSD = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const rValues: number[] = [];
  // Akumulator per source (MANUAL/AUTOPILOT/REPLAY) — hitung dalam 1 pass.
  const src: Record<string, { n: number; wins: number; gp: number; gl: number; pnl: number; r: number[] }> = {};

  const bumpSrc = (s: string) => (src[s] ??= { n: 0, wins: 0, gp: 0, gl: 0, pnl: 0, r: [] });

  for (const r of closedRows) {
    const pnl = Number(r.realizedPnlUsd ?? 0);
    realizedPnlUSD += pnl;
    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
    } else if (pnl < 0) {
      grossLoss += Math.abs(pnl);
    }
    // R = realized / riskAmt ; riskAmt = |entry - SL| * openQty (qty asal,
    // bukan qty sisa partial — R satu trade dihitung penuh); SL 0 -> skip
    const stopLoss = Number(r.stopLoss ?? 0);
    const entryPrice = Number(r.entryPrice ?? 0);
    const openQty = Number(r.openQty ?? r.amount ?? 0);
    let rVal: number | null = null;
    if (isFinite(stopLoss) && stopLoss > 0 && isFinite(entryPrice) && entryPrice > 0 && isFinite(openQty) && openQty > 0) {
      const riskAmt = Math.abs(entryPrice - stopLoss) * openQty;
      if (riskAmt > 1e-9) {
        rVal = pnl / riskAmt;
        rValues.push(rVal);
      }
    }
    const s = String(r.entrySource || "MANUAL").toUpperCase();
    const acc = bumpSrc(s);
    acc.n++;
    acc.pnl += pnl;
    if (pnl > 0) { acc.wins++; acc.gp += pnl; }
    else if (pnl < 0) { acc.gl += Math.abs(pnl); }
    if (rVal != null) acc.r.push(rVal);
  }
  realizedPnlUSD = Number(realizedPnlUSD.toFixed(2));
  const winRate = totalTrades > 0 ? Number(((wins / totalTrades) * 100).toFixed(2)) : 0;
  const avgR = rValues.length > 0 ? Number((rValues.reduce((a, b) => a + b, 0) / rValues.length).toFixed(2)) : 0;
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 999 : 0;

  const bySource: Record<string, SourceSplit> = {};
  for (const [k, a] of Object.entries(src)) {
    bySource[k] = {
      totalTrades: a.n,
      winRate: a.n > 0 ? Number(((a.wins / a.n) * 100).toFixed(2)) : 0,
      avgR: a.r.length > 0 ? Number((a.r.reduce((x, y) => x + y, 0) / a.r.length).toFixed(2)) : 0,
      profitFactor: a.gl > 0 ? Number((a.gp / a.gl).toFixed(2)) : a.gp > 0 ? 999 : 0,
      realizedPnlUSD: Number(a.pnl.toFixed(2)),
    };
  }

  // avg slippage
  const slippageRow = _db.prepare("SELECT AVG(slippage_bps) as avgSlip FROM orders WHERE slippage_bps IS NOT NULL").get() as any;
  const avgSlippageBps = slippageRow?.avgSlip != null ? Number(Number(slippageRow.avgSlip).toFixed(2)) : 0;

  // equity curve
  const curveRows = _db.prepare("SELECT ts, equity FROM portfolio_snapshots ORDER BY ts ASC").all() as any[];
  const equityCurve: Array<{ ts: number; equity: number }> = curveRows.map((r: any) => ({
    ts: Number(r.ts),
    equity: Number(r.equity),
  }));

  // max drawdown pct
  let maxDrawdownPct = 0;
  let peak = -Infinity;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = ((peak - p.equity) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }
  maxDrawdownPct = Number(maxDrawdownPct.toFixed(2));

  const closedTrades = closedRows.map((r: any) => {
    // P0-05: closePrice = VWAP exit fills (partial → rata-rata terbobot);
    // fallback ke close_price tersimpan bila tidak ada fills terhubung.
    const exitSide = r.side === "SHORT" ? "buy" : "sell";
    const vwap = r.id != null ? vwapByPos.get(String(r.id))?.[exitSide] : undefined;
    const closePrice = Number.isFinite(vwap) ? Number(vwap) : r.closePrice != null ? Number(r.closePrice) : null;
    return {
      id: String(r.id),
      symbol: String(r.symbol),
      side: String(r.side),
      entryPrice: Number(r.entryPrice),
      closePrice,
      amount: Number(r.amount),
      openQty: r.openQty != null ? Number(r.openQty) : Number(r.amount),
      totalFeesUSD: r.totalFees != null ? Number(Number(r.totalFees).toFixed(4)) : null,
      realizedPnlUsd: r.realizedPnlUsd != null ? Number(Number(r.realizedPnlUsd).toFixed(2)) : null,
      openedAt: Number(r.openedAt),
      closedAt: r.closedAt != null ? Number(r.closedAt) : null,
      status: String(r.status),
      entrySource: String(r.entrySource || "MANUAL"),
    };
  });

  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgR: 0,
      profitFactor: 0,
      maxDrawdownPct: 0,
      avgSlippageBps: 0,
      realizedPnlUSD: 0,
      bySource: {},
      closedTrades: [],
      equityCurve,
    };
  }

  return {
    totalTrades,
    winRate,
    avgR,
    profitFactor,
    maxDrawdownPct,
    avgSlippageBps,
    realizedPnlUSD,
    bySource,
    closedTrades,
    equityCurve,
  };
}