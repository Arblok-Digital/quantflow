import { describe, expect, it } from "vitest";
import { formatWriterLeaseConflictBanner, installCrashGuards } from "../../server";

// SRV-WATCH-1: dev engine kept dying with no trace. These guards guarantee a
// LOUD, greppable death — or no death at all (unhandledRejection keeps alive).
describe("SRV-WATCH-1 crash guards", () => {
  it("lease-conflict banner names the holder (pid, boot_id, timestamps)", () => {
    const now = Date.now();
    const holder = { pid: 11404, bootId: "boot-abc-123", heartbeat: now - 5000, startedAt: now - 60000 };
    const err = Object.assign(new Error("DUPLICATE_WRITER: trading.db sudah ditulis proses pid=11404"), {
      code: "DUPLICATE_WRITER",
    });
    const banner = formatWriterLeaseConflictBanner(err, holder);
    expect(banner).toContain("ANOTHER ENGINE INSTANCE HOLDS THE WRITER LEASE");
    expect(banner).toContain("pid=11404");
    expect(banner).toContain("boot-abc-123");
    expect(banner).toContain("heartbeat");
    expect(banner).toContain("started_at");
  });

  it("banner without a readable holder is still loud and actionable", () => {
    const banner = formatWriterLeaseConflictBanner(new Error("DUPLICATE_WRITER: x"), null);
    expect(banner).toContain("ANOTHER ENGINE INSTANCE HOLDS THE WRITER LEASE");
    expect(banner).toContain("unreadable");
  });

  it("installCrashGuards is idempotent and both handlers are armed", () => {
    // Module import already armed them once; two more calls must add nothing.
    const r0 = process.listenerCount("unhandledRejection");
    const e0 = process.listenerCount("uncaughtException");
    installCrashGuards();
    installCrashGuards();
    expect(process.listenerCount("unhandledRejection")).toBe(r0);
    expect(process.listenerCount("uncaughtException")).toBe(e0);
    expect(r0).toBeGreaterThan(0);
    expect(e0).toBeGreaterThan(0);
  });
});
