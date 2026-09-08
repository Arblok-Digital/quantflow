#!/usr/bin/env node
// =====================================================================
// Phase 7.4 — Smoke test
// Mengecek endpoint inti server berjalan & merespon:
//   GET  /api/health         → 200 { status: "online" }
//   POST /api/ai-decision    → JSON (200 via Gemini, atau 503 fallback "unavailable")
//   GET  /api/broker/status  → 401 tanpa auth (auth gate) / 200 dengan token login
// Print PASS/FAIL per endpoint; exit 0 HANYA jika semua PASS.
//
// Usage:
//   node scripts/smoke-test.mjs            # default http://127.0.0.1:3000
//   node scripts/smoke-test.mjs --help     # bantuan
//   SMOKE_BASE_URL=http://localhost:8080 node scripts/smoke-test.mjs
// =====================================================================

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`smoke-test — verifikasi endpoint inti AI Trading Agent Engine

Usage:
  node scripts/smoke-test.mjs [--help]

Env:
  SMOKE_BASE_URL  base URL server (default: ${DEFAULT_BASE_URL})
  AUTH_PASSCODE   passcode untuk login (default: paper-local)

Perilaku:
  - Butuh server already running (npm run dev / npm start).
  - Print PASS/FAIL per endpoint, exit 0 hanya jika semua PASS.
`);
  process.exit(0);
}

const BASE_URL = (process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const AUTH_PASSCODE = process.env.AUTH_PASSCODE || "paper-local";

let failures = 0;
const results = [];

function record(name, ok, detail) {
  const label = ok ? "PASS" : "FAIL";
  console.log(`  [${label}] ${name}${detail ? ` — ${detail}` : ""}`);
  results.push({ name, ok });
  if (!ok) failures += 1;
}

async function http(method, path, { body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`Smoke test → ${BASE_URL}\n`);

  // 1) Health
  try {
    const { status, json } = await http("GET", "/api/health");
    const ok = status === 200 && json?.status === "online";
    record("GET /api/health", ok, ok ? `status=${json?.status}` : `HTTP ${status}`);
  } catch (err) {
    record("GET /api/health", false, err?.message);
  }

  // 2) Login → dapat token untuk route yang butuh auth (/api/ai-decision & /api/broker/*)
  let token = null;
  try {
    const login = await http("POST", "/api/auth/login", { body: { passcode: AUTH_PASSCODE } });
    token = login.json?.token || null;
    const ok = login.status === 200 && !!token;
    record("POST /api/auth/login", ok, ok ? "token OK" : `HTTP ${login.status}`);
  } catch (err) {
    record("POST /api/auth/login", false, err?.message);
  }

  // 3) AI decision (mock): 200 via Gemini, atau 503 fallback "unavailable" = route hidup.
  //    Route ini requireAuth (F-04), jadi wajib kirim token. Tanpa token → 401.
  try {
    const { status, json } = await http("POST", "/api/ai-decision", {
      token,
      body: {
        symbol: "BTC/USDT",
        currentPrice: 100000,
        technicals: { rsi: 55 },
        mtfLiquidity: {},
        onChainMetrics: {},
        macroCalendar: {},
      },
    });
    const unauthorized = status === 401;
    const ok =
      (status === 200 && json?.success === true) ||
      (status === 503 && json?.source === "unavailable");
    record("POST /api/ai-decision (dengan auth)", ok, ok ? `HTTP ${status} source=${json?.source ?? "ok"}` : (unauthorized ? "401 without token (auth gate ok)" : `HTTP ${status}`));
  } catch (err) {
    record("POST /api/ai-decision (dengan auth)", false, err?.message);
  }

  // 4) Auth gate: tanpa token → 401
  try {
    const { status, json } = await http("GET", "/api/broker/status");
    const ok = status === 401;
    record("GET /api/broker/status (tanpa auth) → 401", ok, ok ? "401 UNAUTHORIZED" : `HTTP ${status}`);
  } catch (err) {
    record("GET /api/broker/status (tanpa auth) → 401", false, err?.message);
  }

  // 5) Dengan login (token dari langkah 2) → 200 paper
  try {
    if (!token) {
      record("GET /api/broker/status (dengan auth) → 200", false, "login gagal di langkah 2");
    } else {
      const { status, json } = await http("GET", "/api/broker/status", { token });
      const ok = status === 200 && json?.success === true;
      record("GET /api/broker/status (dengan auth) → 200", ok, ok ? `mode=${json?.mode}` : `HTTP ${status}`);
    }
  } catch (err) {
    record("GET /api/broker/status (dengan auth) → 200", false, err?.message);
  }

  // Ringkasan
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} PASS`);
  if (failures > 0) {
    console.log(`Smoke test GAGAL: ${failures} endpoint tidak lolos.`);
    process.exit(1);
  }
  console.log("Smoke test OK — semua endpoint lolos.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke test error:", err?.message);
  process.exit(1);
});