# BUILD TASK — CC Phase 4: Decision Engine Integrity (Paper Trust)

Project: ai-trading-agent-engine
Workdir: C:/Users/ARBLOK/Documents/ai-trading-agent-engine
Branch: work from current dirty state (7 files modified) — DO NOT git reset. Verify with `npx tsc --noEmit` before and after each edit.

## Goal
Paper mode 100% trustworthy: no fabricated numbers pass as real. Fix Fase 4 roadmap sisa agar setiap angka di prompt LLM & UI punya sumber jelas.

## Forbidden
- JANGAN baca .env (akan auto-reject)
- JANGAN ubah proxy/.claude-code-proxy/.env
- JANGAN edit paperBook.ts / db.ts / server.ts bagian Paper Fill (itu milik OC batch — collision)
- Fokus file: server.ts (ai-decision handler only), src/logic/decisionEngine.ts, src/components/DecisionStream.tsx, src/components/MacroCalendarPanel.tsx, src/components/OnChainPanel.tsx, src/data/provider.ts, src/types.ts

## Tasks

### 4.1 Zod validation LLM output (server)
File: server.ts route POST /api/ai-decision (line ~525-660)
- Install zod: `npm i zod` (if not present) + add to dependencies
- Buat schema: action enum BUY/SELL/HOLD, confidence 1-100 finite int, targetPrice/stopLoss/takeProfit finite >0, positionSizePercent 1-100
- Validasi: BUY => stopLoss < currentPrice < takeProfit; SELL => takeProfit < currentPrice < stopLoss; HOLD bebas
- Clamp positionSizePercent ke riskConfig.maxRiskPerTradePercent ( dari body.riskParams )
- Jika fail validation => jangan fallback diam2 ke 75%; return status 502 + reason code + fallback eksplisit `source: fallback-validation-failed` (client tetap handle)
- Simpan latency nyata (Date.now()-startTime) di audit (sudah ada)

### 4.2 Model ID fix
File: server.ts getGeminiClient + /api/ai-decision handler
- Cek model string `gemini-3.8-flash` tidak ada di API Google (yang valid 2.0/1.5). Ganti ke `gemini-2.0-flash` sebagai primary, fallback `gemini-1.5-flash` jika error INVALID_MODEL
- Simpan source field sesuai model yang benar terpakai
- Jangan ubah file lain

### 4.3 Self-bypass gate (CRITICAL)
File: src/logic/decisionEngine.ts line 120, 131 dll
- Hapus `Math.max(riskConfig.minConfidenceThreshold, 86)` dan `Math.max(..., 92)` 
- Fallback engine harus lapor confidence APA ADANYA dari analisa (mis 58, 62) — biarkan riskGatekeeper yang reject
- Jika butuh, buat `rawConfidence` variabel lalu clamp hanya untuk display, tapi decision.confidence = raw

### 4.4 Data honesty layer
Files: src/logic/decisionEngine.ts, server.ts, src/types.ts
- Tambah type `DataProvenance = { source: 'REAL'|'SIMULATED'|'STALE'; fetchedAt: number; ageMinutes?: number }` di types.ts
- Di DecisionEngineInput, sertakan tag per pilar: market (dari fetchLiveMarketData), liquidity (orderBook depth), onChain (provider mode), macro (provider mode)
- Kirim tags ke server dalam body /api/ai-decision: `provenance: { market, liquidity, onChain, macro }`
- Server simpan `provenance` di audit ledger (field `provenance_json` via appendAudit — lihat db.ts saveAgentDecisionDb)
- Jika STALE (>5 menit) tandai

### 4.5 Decision Card v2
File: src/components/DecisionStream.tsx
- Tampilkan: prompt ringkas (3 baris pertama prompt server — ambil dari response field baru `promptSummary` atau fallback dari liquidityHuntAnalysis), response mentah expandable <details>, confidence + latency real
- Source badges per pilar: Market REAL/SIMULATED/STALE, Liquidity REAL/EST, OnChain SIMULATED, Macro REAL/SIMULATED (ambil dari decision.provenance atau props)
- Jangan ubah style besar — tambah badge row di bawah reasoning

### 4.9 Badge panels
Files: src/components/MacroCalendarPanel.tsx, src/components/OnChainPanel.tsx
- Badge REAL/SIMULATED per metrik + timestamp "terakhir fetch: HH:mm:ss" (dari provider atau props)
- Jika macro SIMULATED -> tampilkan "No real macro — fail-closed" sesuai yang sudah di fix

## Acceptance
- npx tsc --noEmit EXIT 0
- grep `Math.max.*minConfidence.*86` di decisionEngine.ts => 0 hasil
- POST /api/ai-decision dengan payload SL terbalik => 502 + reason
- UI DecisionStream menampilkan badge sumber + latency
- TIDAK ada angka FOMC fiktif muncul (sudah bersih)

## Verify command (manager will run)
npx tsc --noEmit; grep -n "gemini-3.8" server.ts; grep -n "Math.max" src/logic/decisionEngine.ts

## Notes
- Setelah selesai, jangan commit — manager (Hermes) yang verify & commit
- Tulis ringkasan perubahan di akhir response
