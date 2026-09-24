/**
 * src/logic/aiProviders.ts
 * Client HTTP minimal untuk router AI chat-completions (OpenRouter / opencode
 * zen) — global fetch + JSON hand-rolled, TANPA dependency baru.
 *
 * Contract: setiap panggilan mengembalikan { ok:boolean, ... } dan TIDAK PERNAH
 * throw (pola yang sama dengan route Gemini di ai.ts — Express 4 mati kalau
 * error lolos dari async handler). Timeout via AbortController; 429/529
 * dilaporkan apa adanya supaya caller bisa retry/fallback.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ChatJsonRequest {
  /** Base URL provider, tanpa trailing "/chat/completions" (mis. "https://openrouter.ai/api/v1"). */
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** "json_object" (default) memaksa response_format + parse JSON; "text" hanya mengembalikan teks. */
  responseFormat?: "json_object" | "text";
  /** Injeksi fetch untuk test; default global fetch. */
  fetchImpl?: typeof fetch;
}

export interface ChatJsonResult {
  ok: boolean;
  /** Hasil parse JSON (bila responseFormat=json_object dan content valid JSON). */
  data?: unknown;
  /** Content mentah dari message (sebelum parse) — dipakai probe untuk verdict. */
  rawText?: string;
  error?: string;
  status?: number;
  latencyMs?: number;
}

export function normalizeProviderBaseUrl(baseUrl: string): string {
  const u = String(baseUrl || "").trim().replace(/\/+$/, "");
  return u;
}

export async function callChatJson(req: ChatJsonRequest): Promise<ChatJsonResult> {
  const started = Date.now();
  const baseUrl = normalizeProviderBaseUrl(req.baseUrl);
  const apiKey = String(req.apiKey || "").trim();
  if (!baseUrl || !apiKey) {
    return { ok: false, error: "provider not configured (baseUrl/apiKey kosong)", latencyMs: 0 };
  }
  const model = String(req.model || "").trim();
  if (!model) {
    return { ok: false, error: "model kosong — cek JEV_ZEN_MODEL/OPENROUTER_MODEL", latencyMs: 0 };
  }

  const responseFormat = req.responseFormat ?? "json_object";
  const timeoutMs = req.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${baseUrl}/chat/completions`;
  const fetchImpl = req.fetchImpl ?? globalThis.fetch;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: req.prompt }],
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 800,
        ...(responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${detail ? ` — ${detail.slice(0, 160)}` : ""}`,
        latencyMs,
      };
    }
    const body: any = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.choices) || body.choices.length === 0) {
      return { ok: false, status: res.status, error: "respons chat-completions tanpa choices", latencyMs };
    }
    const rawText = String(body.choices[0]?.message?.content ?? "").trim();
    if (responseFormat === "text") {
      return { ok: true, rawText, data: rawText, latencyMs };
    }
    try {
      const parsed = JSON.parse(rawText);
      return { ok: true, data: parsed, rawText, latencyMs };
    } catch {
      return {
        ok: false,
        error: "non-json-output",
        rawText: rawText.slice(0, 2000),
        status: res.status,
        latencyMs,
      };
    }
  } catch (err: any) {
    const latencyMs = Date.now() - started;
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `timeout after ${timeoutMs}ms` : `fetch failed: ${String(err?.message || err)}`,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Provider KEYLESS — opencode gateway via CLI (TANPA API key).
// `opencode run -m opencode/jev-1.13-free --dir <workdir> --format json`
//   - model `opencode/*` diproksi gateway opencode (auth built-in CLI).
//   - prompt dikirim lewat STDIN (mengindari quoting issues antar-shell).
//   - kerja di workdir TEMP (dilarang menyentuh cwd proyek pengguna — opencode
//     agent punya akses tool ke cwd-nya).
// Shape hasil DISAMAKAN dengan callChatJson supaya chain satu dispatcher.
// ---------------------------------------------------------------------------

export interface OpencodeCliRequest {
  /** Model opencode, mis. "opencode/jev-1.13-free". Regex-dibatasi (tanpa shell). */
  model: string;
  prompt: string;
  timeoutMs?: number;
  /** Path binary: env OPENCODE_BIN, atau resolusi otomatis (where/which). */
  bin?: string;
  /** Dir kerja aman; default <os.tmpdir()>/quantflow-opencode-gw (di-buat). */
  workDir?: string;
}

const MODEL_RE = /^[A-Za-z0-9._/:-]+$/;
const BINARY_CACHE_TTL_MS = 60_000;

let binaryCache: { bin: string; at: number } | null = null;

/** Resolve binary opencode: env OPENCODE_BIN → eksplisit; lalu cari
 *  `bin/opencode.exe` di node_modules opencode-ai (npm global), lalu where/which.
 *  Mengembalikan path siap pakai untuk spawn shell:false, atau "" bila tidak ada. */
export function resolveOpencodeBinary(binInput?: string, now = Date.now()): string {
  const envBin = String(binInput ?? process.env.OPENCODE_BIN ?? "").trim();
  if (envBin !== "") return envBin;
  if (binaryCache && now - binaryCache.at < BINARY_CACHE_TTL_MS) return binaryCache.bin;

  let resolved = "";
  // 1) npm global layout: <prefix>/node_modules/opencode-ai/bin/opencode.exe
  const npmRoot = process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm")
    : String(process.env.npm_config_prefix || "");
  if (npmRoot) {
    const exe = path.join(npmRoot, "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (fs.existsSync(exe)) resolved = exe;
  }
  // 2) where/which (hanya untuk memproduksi path; hasil ditaruh di cache).
  if (!resolved) {
    try {
      const probe = spawnSync(isWin() ? "where" : "which", ["opencode"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
      if (probe.status === 0) {
        const line = String(probe.stdout || "").split(/\r?\n/).filter(Boolean)[0] || "";
        if (line.endsWith(".exe")) resolved = line;
        else if (line.endsWith(".cmd")) {
          // cmd shim npm: rekan exe di node_modules/opencode-ai/bin
          const exe = path.join(path.dirname(line), "node_modules", "opencode-ai", "bin", "opencode.exe");
          if (fs.existsSync(exe)) resolved = exe;
        } else if (line) resolved = line;
      }
    } catch {
      resolved = "";
    }
  }
  binaryCache = { bin: resolved, at: now };
  return resolved;
}

const isWin = (): boolean => process.platform === "win32";

/** Ambil teks akhir dari output JSON-lines `opencode run --format json`:
 *  event {type:"text", part:{type:"text", text}} milik pesan terakhir. */
export function parseOpencodeJsonLines(stdout: string): string {
  const texts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      const ev = JSON.parse(l);
      if (ev?.type === "text" && ev?.part?.type === "text" && typeof ev.part.text === "string") {
        texts.push(ev.part.text);
      }
      if (ev?.type === "error") {
        return ""; // error event → kosong (caller lihat via exit code / stderr)
      }
    } catch {
      /* baris non-JSON di dalam stream: abaikan */
    }
  }
  return texts.join("");
}

/**
 * Model free sering membungkus JSON dengan prosa ("Berikut keputusannya:
 * {...} semoga membantu"). Ambil blok {...} BERIMBANG pertama (hormati
 * string "..." + escape) supaya tetap bisa diparse — validasi schema tetap
 * di downstream (parseJevResponse), jadi longgar di sini tidak berisiko.
 */
export function extractJsonBlock(text: string): string | null {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // tak berimbang — bukan JSON utuh
}

export async function callOpencodeCli(req: OpencodeCliRequest): Promise<ChatJsonResult> {
  const started = Date.now();
  const model = String(req.model || "").trim();
  if (!MODEL_RE.test(model)) {
    return { ok: false, error: `model opencode tidak valid (karakter berbahaya): "${model}"`, latencyMs: Date.now() - started };
  }
  const bin = resolveOpencodeBinary(req.bin);
  if (!bin) {
    return { ok: false, error: "binary opencode CLI tidak ditemukan (install opencode atau set OPENCODE_BIN).", latencyMs: Date.now() - started };
  }
  const workDir = String(req.workDir || process.env.OPENCODE_WORK_DIR || "").trim() || path.join(os.tmpdir(), "quantflow-opencode-gw");
  try {
    fs.mkdirSync(workDir, { recursive: true });
  } catch {
    return { ok: false, error: `gagal membuat work dir opencode: ${workDir}`, latencyMs: Date.now() - started };
  }
  const timeoutMs = req.timeoutMs ?? 60_000;

  return await new Promise<ChatJsonResult>((resolve) => {
    const args = ["run", "-m", model, "--dir", workDir, "--format", "json", "--print-logs"];
    const isCmdShim = /\.(cmd|bat)$/i.test(bin);
    let child: ReturnType<typeof spawn>;
    try {
      if (isCmdShim) {
        // cmd.exe /d /s /c <string> — pakai shell:true supaya kutipan internal
        // tidak di-escape ulang oleh Node (model regex-limit; path internal).
        const safeBin = bin.replace(/"/g, "");
        const safeWork = workDir.replace(/"/g, "");
        const cmdStr = `"${safeBin}" run -m ${model} --dir "${safeWork}" --format json --print-logs`;
        child = spawn(cmdStr, { shell: true, windowsHide: true, cwd: workDir });
      } else {
        child = spawn(bin, args, { shell: false, windowsHide: true, cwd: workDir });
      }
    } catch (err: any) {
      resolve({ ok: false, error: `spawn opencode gagal: ${String(err?.message || err)}`, latencyMs: Date.now() - started });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* sudah mati */ }
      resolve({ ok: false, error: `opencode CLI timeout after ${timeoutMs}ms`, latencyMs: Date.now() - started });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `spawn opencode error: ${String(err?.message || err)}`, latencyMs: Date.now() - started });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      if (code !== 0) {
        const errLine = stdout.split(/\r?\n/).find((l) => l.includes('"type":"error"')) || "";
        const detail = errLine ? errLine.slice(0, 400) : stderr.trim().slice(0, 400);
        return resolve({
          ok: false,
          error: `opencode CLI exit ${code}${detail ? ` — ${detail}` : ""}`,
          rawText: stdout.slice(0, 2000),
          latencyMs,
        });
      }
      const rawText = parseOpencodeJsonLines(stdout).trim();
      if (!rawText) {
        return resolve({ ok: false, error: `opencode CLI sukses tapi tanpa teks jawaban${stderr.trim() ? ` (${stderr.trim().slice(0, 160)})` : ""}`, latencyMs });
      }
      try {
        const parsed = JSON.parse(rawText);
        return resolve({ ok: true, data: parsed, rawText: rawText.slice(0, 2000), latencyMs });
      } catch {
        // Model free sering membungkus JSON dgn prosa — coba ekstrak blok {...}.
        const block = extractJsonBlock(rawText);
        if (block) {
          try {
            const parsed = JSON.parse(block);
            return resolve({ ok: true, data: parsed, rawText: rawText.slice(0, 2000), latencyMs });
          } catch {
            /* jatuh ke non-json-output di bawah */
          }
        }
        return resolve({ ok: false, error: "non-json-output", rawText: rawText.slice(0, 2000), latencyMs });
      }
    });
    // Prompt lewat stdin (selalu plain text — aman lintas shell).
    try {
      child.stdin?.write(req.prompt);
      child.stdin?.end();
    } catch {
      /* stdin sudah ditutup/EPIPE — biarkan close handler yang melapor */
    }
  });
}