/**
 * S11 — /api/health memaparkan flag Jev/OpenRouter (BOOLEAN saja, tidak pernah
 * nilai key). TIDAK menyentuh .env asli — env di-stub per test.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// resolveOpencodeBinary di-mock supaya flag opencodeGatewayConfigured
// deterministik lintas mesin (bukan tergantung binary opencode terinstall).
const resBin = vi.hoisted(() => ({ value: "" }));
vi.mock("../../src/logic/aiProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/logic/aiProviders")>();
  return { ...actual, resolveOpencodeBinary: () => resBin.value };
});

import { registerMarketRoutes } from "../../src/server/routes/market";

const app = express();
app.use(express.json());
registerMarketRoutes(app, { lastWsTick: Date.now(), startTime: Date.now() });

describe("health flags Jev (S11)", () => {
  afterAll(() => vi.unstubAllEnvs());

  it("binary tidak resolve → opencodeGatewayConfigured false, tanpa secret", async () => {
    vi.unstubAllEnvs();
    resBin.value = "";
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.jevConfigured).toBe(false);
    expect(res.body.openrouterConfigured).toBe(false);
    expect(res.body.opencodeGatewayConfigured).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/api[_-]?key|secret|BEARER|zk-/i);
  });

  it("binary resolve + model default → opencodeGatewayConfigured true (tanpa bocor path/slug)", async () => {
    resBin.value = "C:\\tools\\opencode.exe";
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.opencodeGatewayConfigured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("C:\\tools\\opencode.exe");
    expect(JSON.stringify(res.body)).not.toContain("jev-1.13-free");
  });

  it("JEV_ZEN lengkap → jevConfigured true (nilai key TIDAK bocor)", async () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "super-secret-zen-key-2026");
    const res = await request(app).get("/api/health");
    expect(res.body.jevConfigured).toBe(true);
    expect(res.body.openrouterConfigured).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("super-secret-zen-key-2026");
  });

  it("OPENROUTER lengkap → openrouterConfigured true", async () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-secret");
    vi.stubEnv("OPENROUTER_MODEL", "typesafe/jev-1.13");
    const res = await request(app).get("/api/health");
    expect(res.body.openrouterConfigured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk-or-secret");
  });
});