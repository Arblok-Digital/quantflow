# BUILD TASK — CC Phase 7: Tests Integration + CI (skill ECC, butuh presisi)

Project: ai-trading-agent-engine
Workdir: C:/Users/ARBLOK/Documents/ai-trading-agent-engine

## Scope CC (fokus — jangan sentuh unit test logic di bawah, itu milik OC)
- Jangan baca .env
- Jangan ubah src/logic/* (milik OC unit)

### 7.2 Integration test broker
Files to create: `tests/integration/broker.test.ts` (vitest)
- Mock ccxt via vi.mock, mock paperBook & guardrails
- Test cycles:
  - paper order lifecycle: POST /api/broker/order (paper) → GET /api/broker/order-status/:id → POST /api/broker/close
  - guardrail reject: kill-switch ON → 403, daily loss tercapai → 403 (via getTodayRealized mock)
  - auth gate: tanpa Authorization → 401
- Use supertest or fetch against express app (import `app` from server.ts — export app for testing; if not exported, add `export { app }` di server.ts tapi jangan ubah logic besar)
- Minimal 5 tests passing

### 7.3 CI (GitHub Actions)
File: `.github/workflows/ci.yml`
- on: push, pull_request
- jobs: lint (tsc --noEmit), test (npm run test), build (npm run build)
- node 20, npm ci, zod already installed
- badge-friendly, runs on ubuntu-latest
- Steps: checkout, setup-node, npm ci, npm run lint --if-present, npm run test -- --run, npm run build

### 7.4 Smoke test script
File: `scripts/smoke-test.mjs` + npm script `test:smoke`
- `npm run build && node scripts/smoke-test.mjs` → health check GET /api/health, POST /api/ai-decision mock, GET /api/broker/status (expect 401 without auth / 200 with dummy token setup)
- Print PASS/FAIL per endpoint, exit 0 only if all PASS
- Add `"test:smoke": "node scripts/smoke-test.mjs"` to package.json scripts

## Verify (manager)
- npx tsc --noEmit EXIT 0
- npm test -- --run (integration at least)
- ls .github/workflows/ci.yml
- node scripts/smoke-test.mjs --help or dry-run ok

## Notes
- Setelah selesai jangan commit — Hermes verify & commit
- Ringkas 3 file created/modified
