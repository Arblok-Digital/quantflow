import { describe, it, expect, vi } from "vitest";
import {
  buildJevState,
  jevStateToPrompt,
  parseJevResponse,
  sanitizeJevError,
  jevDecisionSchema,
  probeJevProvider,
  jevZenConfig,
  openRouterConfig,
  opencodeGatewayConfig,
  isProviderConfigured,
  isOpencodeGatewayConfigured,
} from "./jevChip";

const baseInput = {
  symbol: "BTC/USDT",
  currentPrice: 64250,
  timeframe: "15m",
  keelSummary: {
    action: "BUY",
    confidence: 68,
    flow: "SMART_MONEY_BUY",
    futuresBias: "BULLISH",
    fundingBps: 0.011,
    openInterestUsd: 1.2e9,
    lsrTaker: 1.4,
    confluenceScore: 71,
    liquidityDepthUsd: 2_500_000,
    reasoning: "Sweep SSL + return",
    discardedReason: null,
    mtfState: {
      activeState: "HUNTING_BSL",
      nearestBSL: { midPrice: 64500, estimatedVolumeUSD: 12 },
      nearestSSL: { midPrice: 63800, estimatedVolumeUSD: 9 },
      recentSweep: { type: "SSL", wickRejectionPercent: 78, invalidationPrice: 63700 },
    },
  },
  dataHealth: [
    { source: "market", ok: true, detail: "LIVE candles15m=50" },
    { source: "orderflow", ok: false, detail: "GAGAL — flow NEUTRAL" },
  ],
  multiTf: {
    "15m": { rsi: 42.3, ema20: 64000, ema50: 63800, macdHistogram: 12.5, trend: "UP" },
    "1h": null,
    "4h": { rsi: 55, ema20: 63500, ema50: 63200, macdHistogram: -3, trend: "MIXED" },
  },
  futuresDetail: {
    fundingBps: 0.011,
    markPrice: 64250,
    openInterestUsd: 1.2e9,
    lsrTaker: 1.4,
    biasReason: "OI naik",
    source: "binance",
  },
  macroEcho: { vix: 14.2, riskIndex: 30, upcomingCount: 1, source: "ff-mirror" },
  onChainPolicy: "[ON-CHAIN DATA POLICY: MISSING]\nOn-chain directional weight must be ZERO",
  backtestCtx: "backtest 20 trade PF 1.3",
};

describe("buildJevState", () => {
  it("produces deterministic whitelisted state (no NaN/undefined/secrets)", () => {
    const a = buildJevState(baseInput as any);
    const b = buildJevState(baseInput as any);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.keel.action).toBe("BUY");
    expect(a.keel.confidence).toBe(68);
    expect(a.dataHealth).toHaveLength(2);
    expect(a.multiTf["15m"]!.trend).toBe("UP");
    expect(a.multiTf["1h"]).toBeNull();
    expect(a.futures!.lsrTaker).toBe(1.4);
    expect(a.macro!.vix).toBe(14.2);
    expect(JSON.stringify(a)).not.toContain("NaN");
    expect(JSON.stringify(a)).not.toContain("undefined");
  });

  it("never invents values for missing data (fail-closed null)", () => {
    const state = buildJevState({
      symbol: "BTC/USDT",
      currentPrice: NaN,
      keelSummary: null,
      dataHealth: [],
      multiTf: { "15m": null, "1h": null, "4h": null },
      onChainPolicy: "No data.",
    });
    expect(state.currentPrice).toBeNull();
    expect(state.keel.action).toBeNull();
    expect(state.keel.confidence).toBeNull();
    expect(state.multiTf["4h"]).toBeNull();
    expect(state.futures).toBeNull();
    expect(state.macro).toBeNull();
  });

  it("drops unknown keys (no raw body passthrough)", () => {
    const state = buildJevState({
      ...baseInput,
      keelSummary: { ...baseInput.keelSummary, secretKey: "danger", apiKey: "x" },
    } as any);
    expect(JSON.stringify(state.keel)).not.toContain("secretKey");
    expect(JSON.stringify(state.keel)).not.toContain("apiKey");
  });

  it("prompt is deterministic and mentions failed sources + zero on-chain weight", () => {
    const state = buildJevState(baseInput as any);
    const p = jevStateToPrompt(state);
    expect(p).toContain("orderflow: GAGAL");
    expect(p).toContain("On-chain directional weight must be ZERO");
    expect(p).toContain("riskLevel");
    expect(p).toContain("Sumber yang GAGAL dan wajib dipertimbangkan: orderflow");
    const p2 = jevStateToPrompt(buildJevState(baseInput as any));
    expect(p).toBe(p2);
  });
});

describe("parseJevResponse", () => {
  it("parses valid object / JSON string / whitespace-padded", () => {
    const valid = { action: "SELL", confidence: 55, riskLevel: "MEDIUM" };
    for (const raw of [valid, JSON.stringify(valid), "  " + JSON.stringify(valid) + "\n"]) {
      const r = parseJevResponse(raw);
      expect(r.ok).toBe(true);
      expect(r.parsed).toEqual(valid);
    }
  });

  it("rejects invalid shapes fail-closed (wrong action, NaN conf, unknown risk)", () => {
    const cases = [
      { action: "HODL", confidence: 50, riskLevel: "LOW" },
      { action: "BUY", confidence: NaN, riskLevel: "LOW" },
      { action: "BUY", confidence: 0, riskLevel: "LOW" },
      { action: "BUY", confidence: 101, riskLevel: "LOW" },
      { action: "BUY", confidence: 50, riskLevel: "EXTREME" },
      { action: "BUY", confidence: 50 },
      null,
      undefined,
      "not json {{",
      42,
    ];
    for (const c of cases) {
      expect(parseJevResponse(c).ok).toBe(false);
    }
  });

  it("schema is zod: rejects non-object arrays", () => {
    expect(jevDecisionSchema.safeParse([{ action: "BUY" }]).success).toBe(false);
  });
});

describe("probeJevProvider", () => {
  it("verdict ok when wrapper returns rational JSON", async () => {
    const call = vi.fn(async () => ({
      ok: true,
      data: { action: "HOLD", confidence: 1, riskLevel: "LOW" },
      rawText: JSON.stringify({ action: "HOLD", confidence: 1, riskLevel: "LOW" }),
    }));
    const v = await probeJevProvider("jev-zen", { baseUrl: "https://a", apiKey: "k", model: "m" }, call);
    expect(v.ok).toBe(true);
    expect(v.parsed).toEqual({ action: "HOLD", confidence: 1, riskLevel: "LOW" });
  });

  it("verdict not-ok on garbage text but retains rawText", async () => {
    const call = vi.fn(async () => ({ ok: true, rawText: "sure thing boss", error: "non-json-output" }));
    const v = await probeJevProvider("jev-openrouter", { baseUrl: "https://b", apiKey: "k", model: "m" }, call);
    expect(v.ok).toBe(false);
    expect(v.rawText).toBe("sure thing boss");
  });

  it("verdict not-ok when provider errors", async () => {
    const call = vi.fn(async () => ({ ok: false, error: "HTTP 429", status: 429 }));
    const v = await probeJevProvider("jev-zen", { baseUrl: "https://c", apiKey: "k", model: "m" }, call);
    expect(v.ok).toBe(false);
    expect(v.status).toBe(429);
  });
});

describe("sanitizeJevError (error surface aman)", () => {
  it("memotong panjang dan membersihkan non-printable", () => {
    const s = sanitizeJevError("\u0000HTTP 429 — \u001b[31moverloaded\u001b[0m provider zen", 20);
    expect(s).toHaveLength(20);
    expect(s).not.toContain("\u001b");
  });

  it("meredact token/secret di teks error", () => {
    const s = sanitizeJevError('Authorization: Bearer sk-or-v1-abcdefg123 returning "X" secret=abc');
    expect(s).not.toContain("sk-or-v1-abcdefg123");
    expect(s).toContain("[redacted]");
    expect(s).toContain("[sk-redacted]");
  });
});

describe("provider config", () => {
  it("reads env lazily with documented defaults", () => {
    vi.stubEnv("JEV_ZEN_BASE_URL", "https://zen.test/v1");
    vi.stubEnv("JEV_ZEN_API_KEY", "z-key");
    vi.stubEnv("OPENROUTER_MODEL", "typesafe/jev-1.13");
    const zen = jevZenConfig();
    expect(zen.baseUrl).toBe("https://zen.test/v1");
    expect(zen.apiKey).toBe("z-key");
    // default model kalau env kosong — slug terverifikasi via `opencode models`
    vi.unstubAllEnvs();
    vi.stubEnv("JEV_ZEN_MODEL", "");
    expect(jevZenConfig().model).toBe("opencode/jev-1.13-free");
    const or = openRouterConfig();
    expect(or.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(isProviderConfigured({ baseUrl: "", apiKey: "", model: "" })).toBe(false);
    vi.unstubAllEnvs();
  });

  it("opencode gateway keyless: default model verified + configured tanpa apiKey", () => {
    const oc = opencodeGatewayConfig();
    expect(oc.model).toBe("opencode/ling-3.0-flash-fin-free");
    expect(isOpencodeGatewayConfigured(oc)).toBe(true);
    expect(isProviderConfigured({ baseUrl: "x", apiKey: "", model: oc.model })).toBe(false);
    vi.stubEnv("OPENCODE_MODEL", "");
    expect(opencodeGatewayConfig().model).toBe("opencode/ling-3.0-flash-fin-free");
    vi.unstubAllEnvs();
  });
});