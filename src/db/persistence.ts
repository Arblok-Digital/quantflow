import { getDb } from "./core";

export function savePositionDb(row: {
  id: string;
  symbol: string;
  side: string;
  entry_price: number;
  amount: number;
  leverage: number;
  stop_loss: number | null;
  take_profit: number | null;
  liq_price: number | null;
  status: string;
  opened_at: number;
  closed_at: number | null;
  close_price: number | null;
  realized_pnl_usd: number | null;
  fees_usd: number | null;
  /** P0-05: qty asal saat open (ukuran trade, tidak menyusut saat partial). */
  open_qty?: number | null;
  /** P0-05: fee kumulatif hidup posisi — rekonsiliasi vs Σ fills.fee_usd. */
  fees_total_usd?: number | null;
  entry_source?: string;
  decision_id?: string | null;
  /** F3: JSON { config, state } exit plan — NULL = statis murni (opt-in). */
  exit_config?: string | null;
}): void {
  const _db = getDb();
  _db.prepare(
    `INSERT OR REPLACE INTO positions
     (id, symbol, side, entry_price, amount, leverage, stop_loss, take_profit, liq_price, status, opened_at, closed_at, close_price, realized_pnl_usd, fees_usd, open_qty, fees_total_usd, entry_source, decision_id, exit_config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.symbol,
    row.side,
    row.entry_price,
    row.amount,
    row.leverage,
    row.stop_loss,
    row.take_profit,
    row.liq_price,
    row.status,
    row.opened_at,
    row.closed_at,
    row.close_price,
    row.realized_pnl_usd,
    row.fees_usd,
    row.open_qty ?? null,
    row.fees_total_usd ?? null,
    row.entry_source || "MANUAL",
    row.decision_id ?? null,
    row.exit_config ?? null
  );
}

export function saveOrderDb(row: {
  id: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  amount: number;
  price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  leverage: number | null;
  slippage_bps: number | null;
  mode: string | null;
  created_at: number;
  closed_at: number | null;
  realized_pnl_usd: number | null;
  decision_id?: string | null;
  /** P0-05: link order → posisi (entry & exit orders) untuk rekonsiliasi fee per posisi. */
  position_id?: string | null;
}): void {
  const _db = getDb();
  _db.prepare(
    `INSERT OR REPLACE INTO orders
     (id, symbol, side, type, status, amount, price, stop_loss, take_profit, leverage, slippage_bps, mode, created_at, closed_at, realized_pnl_usd, decision_id, position_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.symbol,
    row.side,
    row.type,
    row.status,
    row.amount,
    row.price,
    row.stop_loss,
    row.take_profit,
    row.leverage,
    row.slippage_bps,
    row.mode,
    row.created_at,
    row.closed_at,
    row.realized_pnl_usd,
    row.decision_id ?? null,
    row.position_id ?? null
  );
}

export function saveFillDb(row: { id: string; order_id: string; symbol: string; side: string; price: number; amount: number; fee_usd: number; created_at: number }): void {
  const _db = getDb();
  _db.prepare(
    "INSERT OR REPLACE INTO fills (id, order_id, symbol, side, price, amount, fee_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.order_id, row.symbol, row.side, row.price, row.amount, row.fee_usd, row.created_at);
}

export function saveSnapshotDb(row: { ts: number; cash: number; margin_used: number; equity: number; unrealized_pnl: number; writer_id?: string }): void {
  const _db = getDb();
  const writer = typeof row.writer_id === "string" ? row.writer_id : "";
  // ts is PRIMARY KEY; if collision (same ms), bump by 1 until free
  let ts = Math.floor(row.ts);
  for (let i = 0; i < 5; i++) {
    try {
      _db.prepare("INSERT INTO portfolio_snapshots (ts, cash, margin_used, equity, unrealized_pnl, writer_id) VALUES (?, ?, ?, ?, ?, ?)").run(ts, row.cash, row.margin_used, row.equity, row.unrealized_pnl, writer);
      return;
    } catch (e: any) {
      const msg = String(e?.message || "");
      // DB lama tanpa kolom writer_id (pre-F5): fallback tanpa kolom.
      if (/no such column:\s*writer_id/i.test(msg)) {
        _db.prepare("INSERT INTO portfolio_snapshots (ts, cash, margin_used, equity, unrealized_pnl) VALUES (?, ?, ?, ?, ?)").run(ts, row.cash, row.margin_used, row.equity, row.unrealized_pnl);
        return;
      }
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY")) {
        ts += 1;
        continue;
      }
      throw e;
    }
  }
  // fallback: replace
  try {
    _db.prepare("INSERT OR REPLACE INTO portfolio_snapshots (ts, cash, margin_used, equity, unrealized_pnl, writer_id) VALUES (?, ?, ?, ?, ?, ?)").run(ts, row.cash, row.margin_used, row.equity, row.unrealized_pnl, writer);
  } catch (e: any) {
    if (/no such column:\s*writer_id/i.test(String(e?.message || ""))) {
      _db.prepare("INSERT OR REPLACE INTO portfolio_snapshots (ts, cash, margin_used, equity, unrealized_pnl) VALUES (?, ?, ?, ?, ?)").run(ts, row.cash, row.margin_used, row.equity, row.unrealized_pnl);
      return;
    }
    throw e;
  }
}

export function saveAgentDecisionDb(row: {
  id: string;
  created_at: number;
  symbol: string;
  action: string;
  confidence: number;
  model_id: string;
  latency_ms: number;
  prompt: string;
  response: string;
  source_tags: string | null;
}): void {
  const _db = getDb();
  _db.prepare(
    "INSERT OR REPLACE INTO agent_decisions (id, created_at, symbol, action, confidence, model_id, latency_ms, prompt, response, source_tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.created_at, row.symbol, row.action, row.confidence, row.model_id, row.latency_ms, row.prompt, row.response, row.source_tags);
}

// Load helpers for paperBook rehydration
export function loadOpenPositionsDb(): Array<{
  id: string;
  symbol: string;
  side: string;
  entry_price: number;
  amount: number;
  leverage: number;
  stop_loss: number | null;
  take_profit: number | null;
  liq_price: number | null;
  status: string;
  opened_at: number;
  closed_at: number | null;
  close_price: number | null;
  realized_pnl_usd: number | null;
  fees_usd: number | null;
}> {
  const _db = getDb();
  return _db.prepare("SELECT * FROM positions WHERE status='OPEN' ORDER BY opened_at ASC").all() as any[];
}

export function loadAllOrdersDb(): Array<{
  id: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  amount: number;
  price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  leverage: number | null;
  slippage_bps: number | null;
  mode: string | null;
  created_at: number;
}> {
  const _db = getDb();
  return _db.prepare("SELECT * FROM orders ORDER BY created_at ASC").all() as any[];
}

export function getLatestSnapshotDb(): { ts: number; cash: number; margin_used: number; equity: number; unrealized_pnl: number } | null {
  const _db = getDb();
  const row = _db.prepare("SELECT ts, cash, margin_used, equity, unrealized_pnl FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1").get() as any;
  return row ? { ts: Number(row.ts), cash: Number(row.cash), margin_used: Number(row.margin_used), equity: Number(row.equity), unrealized_pnl: Number(row.unrealized_pnl) } : null;
}

// ---------------------------------------------------------------------------
// Replay / forward-test runs (training data persistence)
// ---------------------------------------------------------------------------
export interface ReplayRunSummary {
  id: string;
  symbol: string;
  timeframe: string;
  startTs: number;
  endTs: number;
  totalCandles: number;
  initialCash: number;
  finalEquity: number;
  realizedPnl: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  createdAt: number;
}

export function saveReplayRunDb(run: ReplayRunSummary & { resultJson: string }): void {
  const _db = getDb();
  _db.prepare(
    `INSERT OR REPLACE INTO replay_runs
     (id, symbol, timeframe, start_ts, end_ts, total_candles, initial_cash, final_equity, realized_pnl, max_drawdown_pct, total_trades, win_rate, profit_factor, avg_r, created_at, result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    run.id,
    run.symbol,
    run.timeframe,
    run.startTs,
    run.endTs,
    run.totalCandles,
    run.initialCash,
    run.finalEquity,
    run.realizedPnl,
    run.maxDrawdownPct,
    run.totalTrades,
    run.winRate,
    run.profitFactor,
    run.avgR,
    run.createdAt,
    run.resultJson
  );
}

export function listReplayRunsDb(limit = 50): ReplayRunSummary[] {
  const _db = getDb();
  const rows = _db
    .prepare(
      `SELECT id, symbol, timeframe, start_ts, end_ts, total_candles, initial_cash, final_equity, realized_pnl, max_drawdown_pct, total_trades, win_rate, profit_factor, avg_r, created_at
       FROM replay_runs ORDER BY created_at DESC LIMIT ?`
    )
    .all(Math.min(200, Math.max(1, Math.floor(limit)))) as any[];
  return rows.map((r) => ({
    id: String(r.id),
    symbol: String(r.symbol),
    timeframe: String(r.timeframe),
    startTs: Number(r.start_ts),
    endTs: Number(r.end_ts),
    totalCandles: Number(r.total_candles),
    initialCash: Number(r.initial_cash),
    finalEquity: Number(r.final_equity),
    realizedPnl: Number(r.realized_pnl),
    maxDrawdownPct: Number(r.max_drawdown_pct),
    totalTrades: Number(r.total_trades),
    winRate: Number(r.win_rate),
    profitFactor: Number(r.profit_factor),
    avgR: Number(r.avg_r),
    createdAt: Number(r.created_at),
  }));
}

export function getReplayRunDb(id: string): { run: ReplayRunSummary; resultJson: string } | null {
  const _db = getDb();
  const row = _db.prepare("SELECT * FROM replay_runs WHERE id = ?").get(String(id)) as any;
  if (!row) return null;
  return {
    run: {
      id: String(row.id),
      symbol: String(row.symbol),
      timeframe: String(row.timeframe),
      startTs: Number(row.start_ts),
      endTs: Number(row.end_ts),
      totalCandles: Number(row.total_candles),
      initialCash: Number(row.initial_cash),
      finalEquity: Number(row.final_equity),
      realizedPnl: Number(row.realized_pnl),
      maxDrawdownPct: Number(row.max_drawdown_pct),
      totalTrades: Number(row.total_trades),
      winRate: Number(row.win_rate),
      profitFactor: Number(row.profit_factor),
      avgR: Number(row.avg_r),
      createdAt: Number(row.created_at),
    },
    resultJson: String(row.result_json),
  };
}

export function getDbFilePath(): string {
  // Re-export from core for callers that only need the path.
  return path_join(process.cwd(), "trading.db");
}

// local helper so we don't re-import path at top (keeps imports minimal)
import path from "node:path";
const path_join = path.join;