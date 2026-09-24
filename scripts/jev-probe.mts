#!/usr/bin/env node
/**
 * scripts/jev-probe.mts — probe Jev dengan kredensial REAL (dari env, tanpa
 * membaca/menyalin .env). Tujuan: memverifikasi wrapper chat-completions
 * mengembalikan JSON rasional { action, confidence, riskLevel }.
 *
 * Usage:
 *   npm run jev:probe
 *
 * Verdict:
 *   - "OK"        : wrapper chat JSON bekerja → chain jangan" jatuh ke adapter /v1/systemone.
 *   - "ADAPTER"   : wrapper non-JSON/tidak rasional → tambahkan adapter native
 *                   `/v1/systemone` (state+questions, primitives choice/score).
 *
 * Menulis SEKALI state mini (tanpa data rahasia). Tidak menyentuh DB/vault.
 */
import { jevZenConfig, openRouterConfig, opencodeGatewayConfig, probeJevProvider, type JevProviderId } from "../src/logic/jevChip.ts";
import { callChatJson, callOpencodeCli, resolveOpencodeBinary } from "../src/logic/aiProviders.ts";

async function main(): Promise<void> {
  const providers: Array<{ id: JevProviderId; cfg: ReturnType<typeof jevZenConfig> }> = [
    { id: "jev-opencode", cfg: opencodeGatewayConfig() as unknown as ReturnType<typeof jevZenConfig> },
    { id: "jev-zen", cfg: jevZenConfig() },
    { id: "jev-openrouter", cfg: openRouterConfig() },
  ];

  let anyPassed = false;
  for (const { id, cfg } of providers) {
    console.log(`\n=== ${id} ===`);
    console.log(`model    : ${cfg.model}`);
    if (id === "jev-opencode") {
      if (!cfg.model) {
        console.log("SKIP — model default tidak tersedia.");
        continue;
      }
      const bin = resolveOpencodeBinary();
      if (!bin) {
        console.log("SKIP — binary opencode CLI tidak ditemukan (install opencode atau set OPENCODE_BIN).");
        continue;
      }
      console.log(`binary   : ${bin}`);
    } else if (!cfg.baseUrl || !cfg.apiKey) {
      console.log("SKIP — tidak terkonfigurasi (env kosong).");
      continue;
    }
    console.log(`baseUrl  : ${(cfg as unknown as { baseUrl?: string }).baseUrl ?? "(CLI gateway)"}`);
    try {
      const v = await probeJevProvider(id, cfg as any, async (req) => {
        const started = Date.now();
        let res;
        if (id === "jev-opencode") {
          const oc = opencodeGatewayConfig();
          res = await callOpencodeCli({
            model: oc.model,
            prompt: req.prompt,
            bin: oc.bin || undefined,
            workDir: oc.workDir || undefined,
            timeoutMs: 30_000,
          });
        } else {
          res = await callChatJson({
            baseUrl: req.baseUrl,
            apiKey: req.apiKey,
            model: req.model,
            prompt: req.prompt,
            maxTokens: 100,
            temperature: 0,
            timeoutMs: req.timeoutMs,
          });
        }
        const call = { ...res, latencyMs: Date.now() - started };
        console.log(`latency  : ${call.latencyMs ?? "?"}ms status=${call.status ?? "?"} ok=${call.ok}`);
        console.log(`raw JSON : ${(call.rawText ?? "").slice(0, 400) || call.error}`);
        return call;
      });
      if (v.parsed) {
        console.log(`VERDICT  : OK — output chip rasional (${JSON.stringify(v.parsed)}).`);
        anyPassed = true;
      } else if (v.ok) {
        console.log(`VERDICT  : ADAPTER — wrapper tidak mengembalikan JSON chip (${v.error ?? "unknown"}).`);
      } else {
        console.log(`VERDICT  : FAIL — ${v.error ?? "unknown"} (bukan verdict model).`);
      }
    } catch (err: any) {
      console.log(`VERDICT  : FAIL — unexpected ${String(err?.message ?? err)}`);
    }
  }

  console.log("");
  if (anyPassed) {
    console.log("PROBE TOTAL: setidaknya satu provider Jev OK — chain berjalan dengan chat JSON wrapper.");
  } else {
    console.log("PROBE TOTAL: tidak ada provider OK — verifikasi env, atau tambahkan adapter native /v1/systemone.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`FATAL: ${err?.message ?? err}`);
  process.exitCode = 1;
});