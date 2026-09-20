import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";

vi.mock("@/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));

import { registerScoutRoutes } from "../../src/server/routes/scout";

const app = express();
app.use(express.json());
registerScoutRoutes(app);

// Sandbox terpisah — route membaca SOLANA_SCOUT_DIR per-request (bukan modul-scope).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "scout-route-"));
const outputDir = path.join(sandbox, "output");
fs.mkdirSync(outputDir, { recursive: true });
const REPORT_FILE = path.join(outputDir, "report.json");

const sampleReport = {
  meta: { mode: "mock", generatedAt: new Date().toISOString(), engine: "kol-first v0.1", note: "test" },
  crawlInfo: { detecting: "kolabo wallet default", gapNote: "sentimen belum ditarik" },
  summary: { counts: { ALPHA: 1, BUY: 0, WATCH: 0, SKIP: 1 }, total: 2 },
  tokens: [
    {
      mint: "MiLKS8xUkQKdNRbRvpY9vaL43BdWvvJH1s6sL1qpump",
      symbol: "MILK",
      name: "Milky Way Cat",
      ageHours: 5,
      kol: { count: 3, verifiedCount: 1, maxFollowers: 812000, holders: [] },
      fundamentals: { available: true, rugRisk: false, rugRiskDetail: [], topHolderPct: 0.055, holders: 2140, liquidityUsd: 214000, mintAuthorityRevoked: true },
      verdict: {
        score: 200, scale: 200, tier: "ALPHA", tierLabel: "Akumulasi kuat", color: "alpha",
        hardFailed: false, hardFailReason: null, breakdown: "Skor 200/200",
        checks: [{ kind: "credit", key: "KOL_CONCURRENCY", label: "≥2 KOL pegang token yang sama", weight: 55, applied: true, detail: "3 KOL" }],
      },
    },
    {
      mint: "RUGGYz8xQ1pBbCcDdEeFfGgHhIiJjKkLlMmNnOoPp",
      symbol: "RUGGY",
      name: "Ruggy Bear",
      ageHours: 8,
      kol: { count: 2, verifiedCount: 0, maxFollowers: 112000, holders: [] },
      fundamentals: { available: true, rugRisk: true, rugRiskDetail: ["Honeypot"], topHolderPct: 0.54, holders: 55, liquidityUsd: 310, mintAuthorityRevoked: false },
      verdict: {
        score: 0, scale: 200, tier: "SKIP", tierLabel: "Lewati", color: "skip",
        hardFailed: true, hardFailReason: "RugCheck bermasalah", breakdown: "Ditolak",
        checks: [{ kind: "gate", key: "RUG_SIGNAL", label: "RugCheck bermasalah", weight: -100, applied: true, detail: "Honeypot" }],
      },
    },
  ],
};

beforeAll(() => {
  vi.stubEnv("SOLANA_SCOUT_DIR", sandbox);
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("route /api/scout/report", () => {
  it("404 NO_REPORT ketika output/report.json belum ada", async () => {
    const res = await request(app).get("/api/scout/report");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, reason: "NO_REPORT" });
    expect(res.body.meta.dir).toBe(sandbox);
  });

  it("200 + token lengkap bila report ada", async () => {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(sampleReport));
    const res = await request(app).get("/api/scout/report");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tokens).toHaveLength(2);
    expect(res.body.tokens[0].verdict.tier).toBe("ALPHA");
    expect(res.body.fileMeta.reportMtime).toBeTruthy();
  });

  it("500 CORRUPT_REPORT saat JSON rusak", async () => {
    fs.writeFileSync(REPORT_FILE, "{ not valid json");
    const res = await request(app).get("/api/scout/report");
    expect(res.status).toBe(500);
    expect(res.body.reason).toBe("CORRUPT_REPORT");
  });

  it("report read-only: tidak menulis apa pun ke folder engine", async () => {
    fs.writeFileSync(REPORT_FILE, JSON.stringify(sampleReport));
    const before = fs.readdirSync(sandbox);
    await request(app).get("/api/scout/report");
    const after = fs.readdirSync(sandbox);
    expect(after).toEqual(before);
  });
});