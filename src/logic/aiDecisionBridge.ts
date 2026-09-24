/**
 * src/logic/aiDecisionBridge.ts
 * Jembatan in-memory antara route HTTP /api/ai-decision (executeAiDecisionCore)
 * dan evaluateTradingDecision yang berjalan di ranah Node (server pipeline).
 *
 * Audit Gemini 3 Pro (2026-09-24) P0-A/P0-C:
 *  - authFetch("/api/ai-decision") dengan relative URL THROW di native fetch
 *    Node (TypeError: Invalid URL) → error ditelan catch → pipeline selalu
 *    jatuh ke Keel lokal, AI (Jev & Gemini) TIDAK PERNAH jalan di server.
 *  - authFetch bergantung localStorage (browser-only) untuk Bearer token.
 *
 * Solusi: registerAiRoutes() mendaftarkan core ke bridge ini; jalur Node
 * memanggil core LANGSUNG in-memory (tanpa HTTP, tanpa auth). Browser tidak
 * pernah mendaftarkan core → tetap memakai authFetch seperti biasa.
 * Modul ini client-safe (murni, tanpa import React/Express/DB).
 */

export interface AiDecisionCoreResult {
  status: number;
  json: any;
}

export type AiDecisionCore = (body: any) => Promise<AiDecisionCoreResult>;

let core: AiDecisionCore | null = null;

/** Dipanggil server saat registrasi route (sekali per proses). */
export function setAiDecisionCore(fn: AiDecisionCore): void {
  core = fn;
}

/** Null di browser / sebelum server registrasi route. */
export function getAiDecisionCore(): AiDecisionCore | null {
  return core;
}

/** Hanya untuk test isolation. */
export function resetAiDecisionCore(): void {
  core = null;
}
