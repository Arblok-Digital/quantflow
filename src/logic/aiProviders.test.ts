import { describe, it, expect, vi, beforeEach } from "vitest";
import { callChatJson, callOpencodeCli, extractJsonBlock, parseOpencodeJsonLines, resolveOpencodeBinary } from "./aiProviders";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeFetch(handler: (url: string, init: any) => Promise<any>) {
  return (async (url: string, init: any) => handler(url, init)) as unknown as typeof fetch;
}

const OK_JSON = {
  choices: [{ message: { content: JSON.stringify({ action: "BUY", confidence: 71 }) } }],
};

describe("callChatJson", () => {
  it("returns parsed JSON data on success", async () => {
    const res = await callChatJson({
      baseUrl: "https://zen.example/v1",
      apiKey: "zen-key",
      model: "oc/jev-1.13-free",
      prompt: "decide",
      fetchImpl: fakeFetch(async (url, init) => {
        expect(url).toBe("https://zen.example/v1/chat/completions");
        const body = JSON.parse(init.body);
        expect(body.model).toBe("oc/jev-1.13-free");
        expect(body.messages[0].content).toBe("decide");
        return { ok: true, status: 200, text: async () => "", json: async () => OK_JSON };
      }),
    });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ action: "BUY", confidence: 71 });
  });

  it("missing key → ok:false without fetch", async () => {
    const spy = vi.fn();
    const res = await callChatJson({
      baseUrl: "https://zen.example/v1",
      apiKey: " ",
      model: "oc/jev-1.13-free",
      prompt: "x",
      fetchImpl: fakeFetch(async () => {
        spy();
        throw new Error("should not be called");
      }),
    });
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("HTTP 429 → ok:false with status (caller retry/fallback)", async () => {
    const res = await callChatJson({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-xxx",
      model: "typesafe/jev-1.13",
      prompt: "x",
      fetchImpl: fakeFetch(async () => ({
        ok: false,
        status: 429,
        text: async () => "rate limited",
        json: async () => ({}),
      })),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(429);
    expect(res.error).toContain("429");
  });

  it("HTTP 5xx → ok:false with status", async () => {
    const res = await callChatJson({
      baseUrl: "https://zen.example/v1",
      apiKey: "k",
      model: "m",
      prompt: "x",
      fetchImpl: fakeFetch(async () => ({
        ok: false,
        status: 503,
        text: async () => "overloaded",
        json: async () => ({}),
      })),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  it("timeout aborts and reports ok:false", async () => {
    const res = await callChatJson({
      baseUrl: "https://zen.example/v1",
      apiKey: "k",
      model: "m",
      prompt: "x",
      timeoutMs: 50,
      fetchImpl: fakeFetch(async (_url, init) => {
        await new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("timeout");
  });

  it("non-JSON content → ok:false non-json-output, rawText retained", async () => {
    const res = await callChatJson({
      baseUrl: "https://zen.example/v1",
      apiKey: "k",
      model: "m",
      prompt: "x",
      fetchImpl: fakeFetch(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ choices: [{ message: { content: "sure thing!" } }] }),
      })),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("non-json-output");
    expect(res.rawText).toBe("sure thing!");
  });

  it("empty choices → ok:false", async () => {
    const res = await callChatJson({
      baseUrl: "https://zen.example/v1",
      apiKey: "k",
      model: "m",
      prompt: "x",
      fetchImpl: fakeFetch(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ choices: [] }),
      })),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("tanpa choices");
  });

  it("responseFormat text returns raw text", async () => {
    const res = await callChatJson({
      baseUrl: "https://zen.example/v1",
      apiKey: "k",
      model: "m",
      prompt: "x",
      responseFormat: "text",
      fetchImpl: fakeFetch(async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ choices: [{ message: { content: "plain" } }] }),
      })),
    });
    expect(res.ok).toBe(true);
    expect(res.rawText).toBe("plain");
  });
});

// ---------------------------------------------------------------------------
// opencode gateway KEYLESS (adv-01) — CLI adapter
// ---------------------------------------------------------------------------
const JEV_JSON = JSON.stringify({ action: "HOLD", confidence: 1, riskLevel: "LOW" });

function writeCmd(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf-8");
  return p;
}

describe("extractJsonBlock (model free membungkus JSON dgn prosa)", () => {
  it("prosa + JSON + prosa → blok berimbang", () => {
    const t = `Berikut keputusannya: ${JEV_JSON} semoga membantu.`;
    expect(extractJsonBlock(t)).toBe(JEV_JSON);
  });

  it("JSON bersih → utuh", () => {
    expect(extractJsonBlock(JEV_JSON)).toBe(JEV_JSON);
  });

  it("kurung di dalam string tidak mengacaukan balance", () => {
    const t = `jawab: {"note":"a } b { c","action":"HOLD"} selesai`;
    expect(extractJsonBlock(t)).toBe(`{"note":"a } b { c","action":"HOLD"}`);
  });

  it("tak ada kurung / tak berimbang → null", () => {
    expect(extractJsonBlock("tidak ada json di sini")).toBeNull();
    expect(extractJsonBlock('buka saja {"action":"HOLD"')).toBeNull();
  });
});

describe("parseOpencodeJsonLines", () => {
  const textEvent = (text: string) => JSON.stringify({ type: "text", part: { type: "text", id: "x", text } });

  it("mengambil teks akhir dari event stream", () => {
    const stdout = [
      '{"type":"step_start","part":{"type":"step-start","id":"a"}}',
      textEvent(JEV_JSON),
      textEvent(" ok"),
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
    ].join("\n");
    expect(parseOpencodeJsonLines(stdout)).toBe(`${JEV_JSON} ok`);
  });

  it("event error → teks kosong", () => {
    const stdout = '{"type":"error","error":{"name":"UnknownError","data":{"message":"boom"}}}\n{"type":"text","part":{"type":"text","id":"p","text":"x"}}';
    expect(parseOpencodeJsonLines(stdout)).toBe("");
  });

  it("baris non-{ / non-JSON diabaikan", () => {
    expect(parseOpencodeJsonLines("garbage\nnot json\n")).toBe("");
  });
});

describe("resolveOpencodeBinary", () => {
  beforeEach(() => {
    delete process.env.OPENCODE_BIN;
  });

  it("OPENCODE_BIN env → dipakai apa adanya (tanpa where)", () => {
    process.env.OPENCODE_BIN = "C:\\tools\\opencode.exe";
    expect(resolveOpencodeBinary()).toBe("C:\\tools\\opencode.exe");
  });

  it("parameter eksplisit menang atas env", () => {
    process.env.OPENCODE_BIN = "x.exe";
    expect(resolveOpencodeBinary("y.exe")).toBe("y.exe");
  });

  it("tanpa env → nonempty di mesin ini (npm global exe) atau '' (CI)", () => {
    const r = resolveOpencodeBinary();
    expect(typeof r).toBe("string");
  });
});

describe("callOpencodeCli (stub cmd keyless)", () => {
  it("sukses → parse JSON chip dari stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-ok-"));
    try {
      const line = JSON.stringify({ type: "text", part: { type: "text", id: "x", text: JEV_JSON } });
      // Note: karakter {} aman di batch selama tidak dalam blok parentesis.
      const bin = writeCmd(dir, "fake-opencode.cmd", `@echo off\r\necho ${line}\r\nexit /b 0\r\n`);
      const res = await callOpencodeCli({ model: "opencode/jev-1.13-free", prompt: "decide", bin, workDir: dir, timeoutMs: 15_000 });
      expect(res.ok).toBe(true);
      expect(res.data).toEqual({ action: "HOLD", confidence: 1, riskLevel: "LOW" });
      expect(res.rawText).toContain("HOLD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit non-zero → ok:false + detail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-fail-"));
    try {
      const bin = writeCmd(dir, "fake-opencode.cmd", `@echo off\r\necho {"type":"error","error":{"data":{"message":"gateway down"}}}\r\nexit /b 1\r\n`);
      const res = await callOpencodeCli({ model: "opencode/jev-1.13-free", prompt: "x", bin, workDir: dir, timeoutMs: 15_000 });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("exit 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("model tidak valid → ok:false tanpa spawn", async () => {
    const res = await callOpencodeCli({ model: "rm -rf /", prompt: "x", bin: "nope", workDir: "nope" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("tidak valid");
  });

  it("stdout tanpa teks → ok:false (tapi file setuju exit 0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-empty-"));
    try {
      const bin = writeCmd(dir, "fake-opencode.cmd", "@echo off\r\nexit /b 0\r\n");
      const res = await callOpencodeCli({ model: "opencode/jev-1.13-free", prompt: "x", bin, workDir: dir, timeoutMs: 15_000 });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("tanpa teks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});