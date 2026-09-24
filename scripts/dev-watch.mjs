#!/usr/bin/env node
/**
 * dev-watch.mjs — watchdog for the dev engine (`tsx server.ts`).
 * (SRV-WATCH-1: dev server kept dying silently — PID churn, no crash stack.)
 *
 * What it does:
 *  - spawns `npx tsx server.ts` as a child (inherits PORT/HOST/NODE_ENV),
 *  - health-checks GET /api/health every 10s (after a 180s boot grace —
 *    a cold tsx+Vite boot measured ~125s on 2026-09-21, so a short grace
 *    would SIGKILL a healthy-but-still-booting server),
 *  - restarts on child exit OR on 3 consecutive failed health checks,
 *    with backoff 5s → 10s → 20s → 30s → 60s (cap), reset after 120s healthy,
 *  - appends every (re)start, death and health event with ISO timestamps to
 *    `server-watch.log` in the repo root (`*.log` is gitignored).
 *
 * Usage:  npm run dev:watch
 * Env:    PORT (default 3000), HOST (default 127.0.0.1) — passed through.
 * Deps:   node builtins only (child_process, fs, path). Windows-safe:
 *         npx is spawned via shell so `npx.cmd` resolves on PowerShell/cmd.
 *
 * Stop:   Ctrl+C — the watchdog forwards SIGINT/SIGTERM and kills the child.
 */

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LOG_FILE = path.join(ROOT, "server-watch.log");
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const HEALTH_URL = `http://${HOST}:${PORT}/api/health`;

const BOOT_GRACE_MS = 180_000;
const HEALTH_INTERVAL_MS = 10_000;
const MAX_CONSEC_FAILS = 3;
const HEALTHY_RESET_MS = 120_000;
const BACKOFFS = [5_000, 10_000, 20_000, 30_000, 60_000];

function wlog(msg) {
  const line = `[${new Date().toISOString()}] [dev-watch] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    /* log file best-effort; console still shows it */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function healthOk() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8_000);
    const res = await fetch(HEALTH_URL, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

let child = null;
let stopping = false;
let crashCount = 0;

function killChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  wlog(`received ${signal} — stopping child and exiting`);
  killChild();
  setTimeout(() => process.exit(0), 1500).unref?.();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function superviseOnce() {
  const backoff = BACKOFFS[Math.min(Math.max(crashCount - 1, 0), BACKOFFS.length - 1)];
  if (crashCount > 0) {
    wlog(`restart #${crashCount} in ${backoff / 1000}s (backoff)`);
    await sleep(backoff);
    if (stopping) return false;
  }
  wlog(`starting: npx tsx server.ts (PORT=${PORT} HOST=${HOST}) → log: ${LOG_FILE}`);
  child = spawn("npx", ["tsx", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST },
    stdio: "inherit",
    shell: true,
  });

  const bornAt = Date.now();
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (err) => resolve({ code: null, signal: null, spawnError: err?.message }));
  });

  // Health monitor loop — races against child exit.
  let consecFails = 0;
  let healthyOnce = false;
  let dead = false;
  const onExit = exited.then((info) => {
    dead = true;
    return info;
  });

  while (!dead && !stopping) {
    await sleep(HEALTH_INTERVAL_MS);
    if (dead || stopping) break;
    if (await healthOk()) {
      consecFails = 0;
      if (!healthyOnce) {
        healthyOnce = true;
        wlog(`healthy: ${HEALTH_URL} OK`);
      }
      if (Date.now() - bornAt > HEALTHY_RESET_MS && crashCount > 0) {
        crashCount = 0;
        wlog("stable for 120s — backoff counter reset");
      }
      continue;
    }
    // Unhealthy but still inside the boot grace → the server is likely still
    // transpiling/booting (cold boot measured ~125s). Do NOT count it.
    if (Date.now() - bornAt < BOOT_GRACE_MS) continue;
    consecFails += 1;
    wlog(`health check failed (${consecFails}/${MAX_CONSEC_FAILS}): ${HEALTH_URL}`);
    if (consecFails >= MAX_CONSEC_FAILS) {
      wlog("health unhealthy 3x in a row — killing child and restarting");
      killChild();
      break;
    }
  }

  const info = await onExit;
  child = null;
  if (stopping) return false;
  if (info.spawnError) {
    wlog(`SPAWN FAILED: ${info.spawnError} — is tsx installed? (npm install)`);
  } else {
    wlog(`child died: exit code=${info.code} signal=${info.signal}`);
  }
  crashCount += 1;
  return true;
}

wlog(`watchdog started (health: ${HEALTH_URL}, log: ${LOG_FILE})`);
for (;;) {
  const again = await superviseOnce();
  if (!again) break;
}
wlog("watchdog stopped");
process.exit(0);
