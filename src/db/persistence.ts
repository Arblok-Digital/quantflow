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
}): void {
  const _db = getDb();
  _db.prepare(
    `INSERT OR REPLACE INTO positions
     (id, symbol, side, entry_price, amount, leverage, stop_loss, take_profit, liq_price, status, opened_at, closed_at, close_price, realized_pnl_usd, fees_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    row.fees_usd
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
}): void {
  const _db = getDb();
  _db.prepare(
    `INSERT OR REPLACE INTO orders
     (id, symbol, side, type, status, amount, price, stop_loss, take_profit, leverage, slippage_bps, mode, created_at, closed_at, realized_pnl_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    row.realized_pnl_usd
  );
}

export function saveFillDb(row: { id: string; order_id: string; symbol: string; side: string; price: number; amount: number; fee_usd: number; created_at: number }): void {
  const _db = getDb();
  _db.prepare(
    "INSERT OR REPLACE INTO fills (id, order_id, symbol, side, price, amount, fee_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(row.id, row.order_id, row.symbol, row.side, row.price, row.amount, row.fee_usd, row.created_at);
}

export function saveSnapshotDb(row: { ts: number; cash: number; margin_used: number; equity: number; unrealized_pnl: number }): void {
  const _db = getDb();
  // ts is PRIMARY KEY; if collision (same ms), bump by 1 until free
  let ts = Math.floor(row.ts);
  for (let i = 0; i < 5; i++) {
    try {
      _db.prepare("INSERT INTO portfolio_snapshots (ts, cash, margin_used, equity, unrealized_pnl) VALUES (?, ?, ?, ?, ?)").run(ts, row.cash, row.margin_used, row.equity, row.unrealized_pnl);
      return;
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY")) {
        ts += 1;
        continue;
      }
      throw e;
    }
  }
  // fallback: replace
  _db.prepare("INSERT OR REPLACE INTO portfolio_snapshots (ts, cash, margin_used, equity, unrealized_pnl) VALUES (?, ?, ?, ?, ?)").run(ts, row.cash, row.margin_used, row.equity, row.unrealized_pnl);
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

export function getDbFilePath(): string {
  // Re-export from core for callers that only need the path.
  return path_join(process.cwd(), "trading.db");
}

// local helper so we don't re-import path at top (keeps imports minimal)
import path from "node:path";
const path_join = path.join;