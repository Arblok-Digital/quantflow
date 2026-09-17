import fs from "node:fs";
import path from "node:path";
import { getPaperPositions, getPaperAccount } from "./paperBook";

const GUARD_FILE = path.join(process.cwd(), ".guardrails.json");

export type GuardReason =
  | "KILL_SWITCH_ACTIVE"
  | "MAX_DAILY_LOSS_EXCEEDED"
  | "MAX_OPEN_POSITIONS"
  | "COOLDOWN_ACTIVE";

export class GuardrailRejectedError extends Error {
  reason: GuardReason;
  code: string;
  constructor(reason: GuardReason, message: string) {
    super(message);
    this.name = "GuardrailRejectedError";
    this.reason = reason;
    this.code = reason;
  }
}

interface GuardStateFile {
  killSwitch: boolean;
  lastDailyReset: number;
  lastOrderTimestamp: number;
  cooldownViolations: number;
  dailyEquityBaselineUSD?: number;
  liveRealizedLedger: Record<string, { realizedPnlUSD: number; entries: Array<{ timestamp: number; realizedPnlUSD: number; symbol?: string }> }>;
  // Master toggle guardrails (paper training): false = SEMUA guard order
  // (daily-loss, max-posisi, cooldown) di-bypass — order selalu lolos kecuali
  // kill-switch. Default: OFF di paper (training bebas), ON di live (wajib).
  // Toggle via POST /api/broker/guards (di-LOCK di live: tidak bisa dimatikan).
  guardsEnabled?: boolean;
}

interface GuardConfig {
  killSwitchDefault: boolean;
  maxOpenPositions: number;
  maxDailyLossPercent: number;
  minOrderIntervalMs: number;
}

function envNonNegativeNum(v: string | undefined, def: number): number {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function envPositiveInt(v: string | undefined, def: number): number {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function getGuardConfig(): GuardConfig {
  return {
    killSwitchDefault: process.env.GUARD_KILL_SWITCH === "true",
    maxOpenPositions: envPositiveInt(process.env.GUARD_MAX_OPEN_POSITIONS, 5),
    // Default 10%. envNonNegativeNum menerima 0 eksplisit sebagai "matikan guard"
    // (0 = blokir semua order karena loss% >= 0 selalu true) — itu jebakan, jadi
    // 0 eksplisit di sini diartikan NONAKTIF via maxDailyLossPercent=Infinity
    // yang di-skip di evaluateGuardrails. Lihat cek `dailyGuardOn` di bawah.
    maxDailyLossPercent: (() => {
      const raw = String(process.env.GUARD_MAX_DAILY_LOSS_PERCENT ?? "").trim();
      if (raw === "") return 10;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return 10;
      return n;
    })(),
    minOrderIntervalMs: envNonNegativeNum(process.env.GUARD_MIN_ORDER_INTERVAL_MS, 30000),
  };
}

function isLiveMode(): boolean {
  return process.env.TRADING_MODE === "live";
}

/**
 * Default master toggle: SELALU ON.
 *
 * F1/P0 (audit): sebelumnya default paper = OFF ("training bebas") sehingga
 * daily-loss, max posisi, dan cooldown semuanya nol limit di akun paper yang
 * dipakai untuk mengukur strategi — dan burst 5 order dalam 33 ms lolos.
 * Operator tetap bisa mematikannya eksplisit lewat POST /api/broker/guards
 * untuk eksperimen terkontrol; live tetap terkunci (tidak bisa dimatikan).
 */
function defaultGuardsEnabled(): boolean {
  return true;
}

function freshGuardState(): GuardStateFile {
  return {
    killSwitch: getGuardConfig().killSwitchDefault,
    lastDailyReset: todayStartMs(),
    lastOrderTimestamp: 0,
    cooldownViolations: 0,
    liveRealizedLedger: {},
    guardsEnabled: defaultGuardsEnabled(),
  };
}

let guardState: GuardStateFile | null = null;

function loadGuardState(): GuardStateFile {
  if (guardState) return guardState;
  if (fs.existsSync(GUARD_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(GUARD_FILE, "utf-8")) as Partial<GuardStateFile>;
      guardState = {
        killSwitch: Boolean(parsed.killSwitch ?? getGuardConfig().killSwitchDefault),
        lastDailyReset: Number(parsed.lastDailyReset) || todayStartMs(),
        lastOrderTimestamp: Number(parsed.lastOrderTimestamp) || 0,
        cooldownViolations: Number(parsed.cooldownViolations) || 0,
        dailyEquityBaselineUSD: Number(parsed.dailyEquityBaselineUSD) > 0 ? Number(parsed.dailyEquityBaselineUSD) : undefined,
        liveRealizedLedger: (parsed.liveRealizedLedger as any) || {},
        // State lama (tanpa field) → default per mode saat load.
        guardsEnabled: typeof parsed.guardsEnabled === "boolean" ? parsed.guardsEnabled : defaultGuardsEnabled(),
      };
      // override killSwitch from env default only on first load if file explicitly had false? We keep file truth.
      // But if env says GUARD_KILL_SWITCH and file hasn't been set yet, file initial would be env default.
      return guardState;
    } catch (err) {
      console.warn(`[guardrails] Gagal membaca ${GUARD_FILE}: ${(err as Error).message}`);
    }
  }
  guardState = freshGuardState();
  persistGuardState();
  return guardState;
}

function persistGuardState(): void {
  if (!guardState) return;
  try {
    fs.writeFileSync(GUARD_FILE, JSON.stringify(guardState, null, 2), "utf-8");
  } catch (err) {
    console.warn(`[guardrails] Gagal persist ${GUARD_FILE}: ${(err as Error).message}`);
  }
}

export function initGuardrails(): void {
  loadGuardState();
  console.log(`[guardrails] Loaded state from ${GUARD_FILE} killSwitch=${guardState?.killSwitch}`);
}

export function getGuardFilePath(): string {
  return GUARD_FILE;
}

export function getGuardConfigSnapshot(): GuardConfig {
  return getGuardConfig();
}

export function getGuardStateSnapshot() {
  const s = loadGuardState();
  return { ...s, liveRealizedLedger: { ...s.liveRealizedLedger } };
}

export function setKillSwitch(active: boolean): GuardStateFile {
  const s = loadGuardState();
  s.killSwitch = Boolean(active);
  persistGuardState();
  console.log(`[guardrails] killSwitch set to ${s.killSwitch}`);
  return { ...s };
}

/**
 * Master toggle guardrails (paper training ON/OFF).
 * LIVE-LOCK: di live mode refused (return ok:false) — guard wajib aktif saat
 * uang beneran. Paper bebas toggle on/off untuk training tanpa blokir.
 */
export function setGuardsEnabled(active: boolean): { ok: boolean; guardsEnabled: boolean; reason?: string } {
  if (isLiveMode() && !active) {
    return { ok: false, guardsEnabled: true, reason: "LIVE_LOCKED" };
  }
  const s = loadGuardState();
  s.guardsEnabled = Boolean(active);
  persistGuardState();
  console.log(`[guardrails] guardsEnabled set to ${s.guardsEnabled}`);
  return { ok: true, guardsEnabled: s.guardsEnabled };
}

export function areGuardsEnabled(): boolean {
  return loadGuardState().guardsEnabled ?? defaultGuardsEnabled();
}

export function recordOrderPlaced(): void {
  const s = loadGuardState();
  s.lastOrderTimestamp = Date.now();
  persistGuardState();
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  // YYYY-MM-DD local
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// F-11: baseline equity real (paper account equity), bukan hardcode 10000.
// Env override GUARD_EQUITY_BASELINE tetap menang kalau disetel.
function baselineEquityUSD(mode: "paper" | "live"): number {
  const envOverride = Number(process.env.GUARD_EQUITY_BASELINE || 0);
  if (isFinite(envOverride) && envOverride > 0) return envOverride;
  const s = loadGuardState();
  const start = todayStartMs();
  if (s.lastDailyReset < start || !s.dailyEquityBaselineUSD || s.dailyEquityBaselineUSD <= 0) {
    s.lastDailyReset = start;
    s.cooldownViolations = 0;
    if (mode === "paper") {
      try {
        const account = getPaperAccount();
        s.dailyEquityBaselineUSD = isFinite(account.equity) && account.equity > 0 ? account.equity : 10000;
      } catch {
        s.dailyEquityBaselineUSD = 10000;
      }
    } else {
      s.dailyEquityBaselineUSD = 10000;
    }
    persistGuardState();
  }
  return s.dailyEquityBaselineUSD;
}

function computePaperDailyRealizedPnl(): { realizedPnlUSD: number; lossPercent: number } {
  const start = todayStartMs();
  // F5: query DB for closed positions today - in-memory loses closed positions after restart.
  let sum = 0;
  try {
    const { getDb: _getDb } = require("./src/db/core");
    const _db = _getDb();
    const row = _db.prepare("SELECT COALESCE(SUM(realized_pnl_usd), 0) s FROM positions WHERE status = ? AND closed_at >= ?").get("CLOSED", start);
    sum = Number((row as any)?.s ?? 0);
  } catch {
    const positions = getPaperPositions();
    for (const p of positions) {
      if (p.status === "CLOSED" && typeof p.closedAt === "number" && p.closedAt >= start) {
        sum += Number(p.realizedPnlUSD || 0);
      }
    }
  }
  const initial = baselineEquityUSD("paper");
  const loss = sum < 0 ? Math.abs(sum) : 0;
  const lossPercent = initial > 0 ? (loss / initial) * 100 : 0;
  return { realizedPnlUSD: Number(sum.toFixed(2)), lossPercent: Number(lossPercent.toFixed(4)) };
}

function computeLiveDailyRealizedPnl(): { realizedPnlUSD: number; lossPercent: number } {
  const s = loadGuardState();
  const key = dateKey(Date.now());
  const entry = s.liveRealizedLedger[key];
  const sum = entry ? Number(entry.realizedPnlUSD) : 0;
  const initial = baselineEquityUSD("live"); // env override, atau 10000 sampai equity tracking live ada
  const loss = sum < 0 ? Math.abs(sum) : 0;
  const lossPercent = initial > 0 ? (loss / initial) * 100 : 0;
  return { realizedPnlUSD: Number(sum.toFixed(2)), lossPercent: Number(lossPercent.toFixed(4)) };
}

export function getTodayRealized(): { realizedPnlUSD: number; lossPercent: number } {
  if (process.env.TRADING_MODE === "live") {
    return computeLiveDailyRealizedPnl();
  }
  return computePaperDailyRealizedPnl();
}

export function recordLiveRealizedPnl(entry: { symbol?: string; realizedPnlUSD: number; timestamp?: number }): void {
  const s = loadGuardState();
  const ts = entry.timestamp || Date.now();
  const key = dateKey(ts);
  if (!s.liveRealizedLedger[key]) {
    s.liveRealizedLedger[key] = { realizedPnlUSD: 0, entries: [] };
  }
  s.liveRealizedLedger[key].realizedPnlUSD += Number(entry.realizedPnlUSD);
  s.liveRealizedLedger[key].realizedPnlUSD = Number(s.liveRealizedLedger[key].realizedPnlUSD.toFixed(2));
  s.liveRealizedLedger[key].entries.push({ timestamp: ts, realizedPnlUSD: entry.realizedPnlUSD, symbol: entry.symbol });
  // Keep only last 100 entries per day
  if (s.liveRealizedLedger[key].entries.length > 100) {
    s.liveRealizedLedger[key].entries = s.liveRealizedLedger[key].entries.slice(-100);
  }
  persistGuardState();
}

export async function getLiveOpenCountSafe(): Promise<number> {
  try {
    const broker = await import("./broker.js");
    // broker.getExchange may be available
    const exchange = (broker as any).getExchange?.();
    if (!exchange) return 0;
    await (broker as any).ensureMarketsLoaded?.(exchange);
    if (typeof exchange.fetchPositions === "function") {
      const positions = await exchange.fetchPositions();
      if (Array.isArray(positions)) {
        // Count positions with non-zero contracts or notional
        const open = positions.filter((p: any) => {
          const contracts = Number(p.contracts ?? p.amount ?? 0);
          const notional = Number(p.notional ?? 0);
          return contracts !== 0 || notional !== 0;
        });
        return open.length;
      }
    }
    return 0;
  } catch (err: any) {
    console.warn(`[guardrails] Live open count fallback 0: ${err?.message}`);
    return 0;
  }
}

export interface EvaluateResult {
  allowed: boolean;
  reasons: GuardReason[];
  details: {
    killSwitch: boolean;
    dailyLossPercent: number;
    maxDailyLossPercent: number;
    realizedPnlUSD: number;
    openCount: number;
    maxOpenPositions: number;
    cooldownRemainingMs: number;
    guardsEnabled: boolean;
  };
}

export async function evaluateGuardrails(opts?: { symbol?: string }): Promise<EvaluateResult> {
  const config = getGuardConfig();
  const state = loadGuardState();
  const reasons: GuardReason[] = [];

  // MASTER TOGGLE (paper training): OFF = bypass SEMUA guard order —
  // daily-loss, max-posisi, cooldown tidak diperiksa. Kill-switch tetap jalan
  // (darurat manual selalu tersedia). Default paper OFF, live ON + live-lock.
  const guardsOn = state.guardsEnabled ?? defaultGuardsEnabled();
  const today = getTodayRealized();

  // KILL SWITCH (selalu aktif — tidak ikut toggle)
  if (state.killSwitch) {
    reasons.push("KILL_SWITCH_ACTIVE");
  }

  let openCount = 0;
  if (process.env.TRADING_MODE === "live") {
    openCount = await getLiveOpenCountSafe();
  } else {
    try {
      const openPositions = getPaperPositions().filter((p) => p.status === "OPEN");
      openCount = openPositions.length;
    } catch {
      openCount = 0;
    }
  }

  if (guardsOn) {
    // DAILY LOSS (0 eksplisit = guard dimatikan via env; tak ada batas = tak ada blokir)
    const dailyGuardOn = config.maxDailyLossPercent > 0 && isFinite(config.maxDailyLossPercent);
    if (dailyGuardOn && today.lossPercent >= config.maxDailyLossPercent) {
      reasons.push("MAX_DAILY_LOSS_EXCEEDED");
    }

    // MAX OPEN POSITIONS
    if (openCount >= config.maxOpenPositions) {
      reasons.push("MAX_OPEN_POSITIONS");
    }

    // COOLDOWN
    const elapsed = Date.now() - (state.lastOrderTimestamp || 0);
    if (config.minOrderIntervalMs > 0 && state.lastOrderTimestamp !== 0 && elapsed < config.minOrderIntervalMs) {
      reasons.push("COOLDOWN_ACTIVE");
      state.cooldownViolations += 1;
      persistGuardState();
    }
  }

  const elapsed = Date.now() - (state.lastOrderTimestamp || 0);
  const cooldownRemainingMs = state.lastOrderTimestamp ? Math.max(0, config.minOrderIntervalMs - elapsed) : 0;

  return {
    allowed: reasons.length === 0,
    reasons,
    details: {
      killSwitch: state.killSwitch,
      dailyLossPercent: today.lossPercent,
      maxDailyLossPercent: config.maxDailyLossPercent,
      realizedPnlUSD: today.realizedPnlUSD,
      openCount,
      maxOpenPositions: config.maxOpenPositions,
      cooldownRemainingMs,
      guardsEnabled: guardsOn,
    } as EvaluateResult["details"],
  };
}

export function getGuardrailsSnapshotSync(): {
  config: GuardConfig;
  state: { killSwitch: boolean; dailyLossPercent: number; openCount: number; lastOrderAt: number | null; cooldownRemainingMs: number; armedForLive: boolean; guardsEnabled: boolean };
  today: { realizedPnlUSD: number; lossPercent: number };
} {
  const config = getGuardConfig();
  const s = loadGuardState();
  const today = getTodayRealized();
  // openCount sync version (best effort without live fetch)
  let openCount = 0;
  try {
    if (process.env.TRADING_MODE === "live") {
      // sync fallback 0, actual count will be async in endpoint
      openCount = 0;
    } else {
      openCount = getPaperPositions().filter((p) => p.status === "OPEN").length;
    }
  } catch {
    openCount = 0;
  }
  const elapsed = Date.now() - (s.lastOrderTimestamp || 0);
  const cooldownRemainingMs = s.lastOrderTimestamp ? Math.max(0, config.minOrderIntervalMs - elapsed) : 0;

  // armedForLive from vault
  let armedForLive = false;
  try {
    // dynamic import to avoid circular, but sync can't await; use fs read directly
    const VAULT_FILE = path.join(process.cwd(), ".broker-secrets.json");
    const KEY_FILE = path.join(process.cwd(), ".broker-vault-key");
    if (fs.existsSync(VAULT_FILE)) {
      const raw = fs.readFileSync(VAULT_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.liveArmed === "boolean") {
        armedForLive = parsed.liveArmed;
      } else if (parsed.apiKey && typeof parsed.apiKey === "object" && parsed.apiKey.iv) {
        // encrypted, need to check decrypted? For sync we can't decrypt without key, fallback to false
        // try to read key and decrypt quickly if possible synchronously? We'll attempt sync decrypt
        if (fs.existsSync(KEY_FILE)) {
          try {
            const keyHex = fs.readFileSync(KEY_FILE, "utf-8").trim();
            const key = Buffer.from(keyHex, "hex");
            // If encrypted, liveArmed may still be plaintext field alongside encrypted blobs
            armedForLive = Boolean(parsed.liveArmed);
          } catch {}
        }
      }
    }
  } catch {}

  return {
    config,
    state: {
      killSwitch: s.killSwitch,
      dailyLossPercent: today.lossPercent,
      openCount,
      lastOrderAt: s.lastOrderTimestamp || null,
      cooldownRemainingMs,
      armedForLive,
      guardsEnabled: s.guardsEnabled ?? defaultGuardsEnabled(),
    },
    today,
  };
}

export async function getGuardrailsSnapshotAsync(): Promise<{
  config: GuardConfig;
  state: { killSwitch: boolean; dailyLossPercent: number; openCount: number; lastOrderAt: number | null; cooldownRemainingMs: number; armedForLive: boolean; guardsEnabled: boolean };
  today: { realizedPnlUSD: number; lossPercent: number };
}> {
  const sync = getGuardrailsSnapshotSync();
  // If live, fetch accurate openCount
  if (process.env.TRADING_MODE === "live") {
    const liveCount = await getLiveOpenCountSafe();
    sync.state.openCount = liveCount;
  }
  // Also try to get accurate armedForLive via broker module async
  try {
    const broker: any = await import("./broker.js");
    if (typeof broker.getBrokerStatus === "function") {
      const bs = broker.getBrokerStatus();
      if (typeof bs.armedForLive === "boolean") sync.state.armedForLive = bs.armedForLive;
      if (typeof bs.liveArmed === "boolean") sync.state.armedForLive = bs.liveArmed;
    }
  } catch {}
  return sync;
}
