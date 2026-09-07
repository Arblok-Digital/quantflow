# BUILD TASK — OC Phase 7: Unit Tests Logic (mass coding, no skill CC)

Project: ai-trading-agent-engine
Workdir: C:/Users/ARBLOK/Documents/ai-trading-agent-engine

## Scope OC (fokus — jangan sentuh CI/broker integration, itu milik CC)
- Jangan baca .env
- Jangan edit server.ts, .github/, scripts/

### Setup
- Install: `npm i -D vitest supertest @types/supertest` (jika belum)
- vite.config.ts: tambah `test: { globals: true, environment: 'node', include: ['src/**/*.test.ts','tests/**/*.test.ts'] }`
- package.json: scripts `"test": "vitest --run"`, `"test:watch": "vitest"`, `"lint": "tsc --noEmit"` (lint sudah ada)
- JANGAN ubah proxy/server port

### 7.1 Vitest unit tests — buat 4 file (minimal 20 tests total):

#### 1) `src/logic/riskGatekeeper.test.ts`
- Test evaluateRiskGate setiap gate:
  - isEmergencyStopActive → reject
  - currentDrawdownPercent >= maxDrawdownLimit → reject
  - action HOLD → approved true
  - positionSizePercent > maxPositionPercent → reject
  - riskSizing (stopDistPct * size > maxRiskPerTradePercent) → reject (F6)
  - rr < minRiskRewardRatio → reject
  - confidence < minConfidenceThreshold → reject
  - all pass → approved true + notes
- helper buat mock decision/portfolio/config

#### 2) `src/logic/liquidityHunt.test.ts`
- Test analyzeMTFLiquidity:
  - candles < 5 → EQUILIBRIUM fallback
  - swing high/low detection, BSL/SSL zone midPrice distance
  - sweep detection (recentSweep, wickRejectionPercent)
  - confluenceScore range 0-100
  - huntingTarget correct targetType BSL/SSL
- Use synthetic candles (generate via helper, jangan import UI)

#### 3) `src/logic/decisionEngine.test.ts`
- Test fallback deterministic (tanpa server):
  - SWEPT_SSL + recentSweep → BUY, confidence = 78 + confluence/10 + whale bonus, SL = invalidation
  - SWEPT_BSL + recentSweep → SELL, confidence 78+...
  - HUNTING_BSL + rsi<65 + imbalance>1.05 → BUY
  - EQUILIBRIUM → HOLD
  - macro fail-closed: no macro → DATA_DEPENDENT
  - provenance passthrough tidak merusak output
- Mock fetch to fail so fallback triggered

#### 4) `src/logic/margin.test.ts` (atau paperBook margin logic)
- Test liquidationPrice(entry, leverage, side): LONG lev10 entry100 → 90.x, SHORT → 110.x, lev50 tighter
- Test margin = notional/leverage, equity = cash + lockedMargin + uPnL
- Edge: lev 0 → treat as 1, lev >50 → clamp

### Zod validation tests (tambah di decisionEngine.test.ts atau file terpisah)
- Valid: BUY dengan SL < price < TP → pass
- Invalid: BUY dengan SL > price → fail
- Invalid: finite check NaN/Infinity → fail
- Clamp positionSizePercent > max → expect clamp/reject

### Acceptance
- npx tsc --noEmit EXIT 0
- npm run test -- --run → all 20+ tests PASS
- No .env read, no server.ts edits beyond vite config

## Verify (manager)
- npx tsc --noEmit; npm test -- --run
- grep -c "it(" src/logic/*.test.ts harus >=20

## Notes
- Setelah selesai jangan commit — Hermes verify & commit
- Ringkas file + test count
