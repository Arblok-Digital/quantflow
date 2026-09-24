import { describe, it, expect } from "vitest";
import {
  verdictFromProvenance,
  applyEntryPolicyGate,
  healthRowFromVerdict,
  normalizeMarketType,
  PROVENANCE_DEFAULT_FRESH_MS,
  type ProvenanceVerdict,
} from "./provenance";

const NOW = 1_700_000_000_000;

const fakeVerdict = (kind: ProvenanceVerdict["kind"]): ProvenanceVerdict => ({
  key: "market.price",
  claimed: kind,
  claimedEcho: kind,
  kind,
  venue: "binance",
  marketType: "FUTURES",
  exchangeTs: NOW,
  receivedAt: NOW,
  ageMs: kind === "STALE" ? 1e9 : 5,
  usable: kind === "REAL",
  note: `note ${kind}`,
});

describe("verdictFromProvenance (P1-01)", () => {
  it("klaim REAL lengkap + segar → usable true, kind REAL", () => {
    const v = verdictFromProvenance(
      { source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: NOW - 1_000 },
      { now: NOW },
      "market.price"
    );
    expect(v.kind).toBe("REAL");
    expect(v.usable).toBe(true);
    expect(v.venue).toBe("binance");
    expect(v.marketType).toBe("FUTURES");
    expect(v.ageMs).toBe(1_000);
    expect(v.claimed).toBe("REAL");
  });

  it("klaim REAL tapi basi (age > freshness) → STALE, usable false", () => {
    const v = verdictFromProvenance(
      { source: "REAL", venue: "bybit", marketType: "SPOT", exchangeTs: NOW - (PROVENANCE_DEFAULT_FRESH_MS + 5_000) },
      { now: NOW }
    );
    expect(v.kind).toBe("STALE");
    expect(v.usable).toBe(false);
  });

  it("SIMULATED/SYNTHETIC/TEST → TIDAK pernah observasi", () => {
    for (const src of ["SIMULATED", "SYNTHETIC", "TEST", "MOCK", "FAKE"]) {
      const v = verdictFromProvenance({ source: src, venue: "binance", marketType: "FUTURES", exchangeTs: NOW - 100 }, { now: NOW });
      expect(v.kind).toBe("SIMULATED");
      expect(v.usable).toBe(false);
    }
  });

  it("venue kosong / marketType aneh → UNKNOWN (klaim real ditolak)", () => {
    const a = verdictFromProvenance({ source: "REAL", marketType: "FUTURES", exchangeTs: NOW - 100 }, { now: NOW });
    expect(a.kind).toBe("UNKNOWN");
    expect(a.usable).toBe(false);
    const b = verdictFromProvenance({ source: "REAL", venue: "binance", marketType: "DERIVATIVES_XYZ", exchangeTs: NOW - 100 }, { now: NOW });
    expect(b.kind).toBe("UNKNOWN");
    const c = verdictFromProvenance({ source: "REAL", venue: "binance", marketType: "", exchangeTs: NOW - 100 }, { now: NOW });
    expect(c.kind).toBe("UNKNOWN");
  });

  it("REAL tanpa exchangeTs → STALE (tidak bisa diverifikasi segar)", () => {
    const v = verdictFromProvenance({ source: "REAL", venue: "binance", marketType: "FUTURES" }, { now: NOW });
    expect(v.kind).toBe("STALE");
    expect(v.usable).toBe(false);
  });

  it("MISSING (tanpa provenance) → MISSING, bukan REAL, TIDAK block", () => {
    const v = verdictFromProvenance(null, { now: NOW });
    expect(v.kind).toBe("MISSING");
    expect(v.usable).toBe(false);
    // applyEntryPolicyGate tidak block untuk MISSING
    const g = applyEntryPolicyGate({ action: "BUY", positionSizePercent: 5, reasoning: "x" }, v);
    expect(g.gated).toBe(false);
  });

  it("sanitasi venue (injection stripping) + klaim aneh → UNKNOWN", () => {
    const v = verdictFromProvenance(
      { source: "REAL; DROP TABLE", venue: 'binance" && rm -rf /', marketType: "FUTURES", exchangeTs: NOW - 100 },
      { now: NOW }
    );
    expect(v.venue).toBeNull();
    expect(v.usable).toBe(false);
    expect(v.note).not.toContain("DROP");
  });

  it("normalizeMarketType: SPOT/FUTURES/perpetual/swap/unknown", () => {
    expect(normalizeMarketType("SPOT")).toBe("SPOT");
    expect(normalizeMarketType("PERPETUAL")).toBe("FUTURES");
    expect(normalizeMarketType("PERP")).toBe("FUTURES");
    expect(normalizeMarketType("SWAP")).toBe("FUTURES");
    expect(normalizeMarketType("perpetual-swaplong")).toBe("UNKNOWN");
    expect(normalizeMarketType("gibberish")).toBe("UNKNOWN");
    expect(normalizeMarketType(undefined)).toBeNull();
  });

  it("healthRowFromVerdict → dataHealth {source, ok, detail}", () => {
    const v = verdictFromProvenance({ source: "REAL", venue: "binance", marketType: "FUTURES", exchangeTs: NOW - 100 }, { now: NOW });
    const row = healthRowFromVerdict(v, "provenance:market.price");
    expect(row.source).toBe("provenance:market.price");
    expect(row.ok).toBe(true);
    expect(row.detail).toContain("REAL");
  });
});

describe("applyEntryPolicyGate (P1-01 entry policy)", () => {
  const input = { action: "BUY" as const, positionSizePercent: 5, reasoning: "bias" };

  it("STALE/SIMULATED/UNKNOWN → entry HOLD, size 0, reasoning jelas", () => {
    for (const kind of ["STALE", "SIMULATED", "SYNTHETIC", "UNKNOWN"] as const) {
      const g = applyEntryPolicyGate(input, fakeVerdict(kind));
      expect(g.gated).toBe(true);
      expect(g.action).toBe("HOLD");
      expect(g.positionSizePercent).toBe(0);
      expect(g.reasoning).toContain("[PROVENANCE GATE]");
      expect(g.reasoning).toContain(kind);
    }
  });

  it("HOLD tetap HOLD (tidak gated ulang); MISSING tidak block; REAL tidak block", () => {
    const missing = fakeVerdict("MISSING");
    expect(applyEntryPolicyGate({ ...input, action: "HOLD" }, missing).gated).toBe(false);
    expect(applyEntryPolicyGate(input, missing).gated).toBe(false);
    const real = fakeVerdict("REAL");
    expect(applyEntryPolicyGate(input, real).gated).toBe(false);
  });

  it("deterministik untuk input sama", () => {
    const v = fakeVerdict("STALE");
    const a = applyEntryPolicyGate(input, v);
    const b = applyEntryPolicyGate(input, v);
    expect(a).toEqual(b);
  });
});