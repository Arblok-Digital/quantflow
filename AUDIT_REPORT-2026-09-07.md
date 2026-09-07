# 🔍 AUDIT REPORT — AI Trading Agent Engine
**Tanggal:** 2026-09-07  
**Metode:** 4 sub-agent auditor paralel + verifikasi manual kode (agent-manager)
**Status project:** Phase 0–3 roadmap selesai, Phase 4+ pending

---

## 🚨 Kesimpulan Eksekutif

**Paper mode** = aman untuk development/testing. **Live mode = JANGAN di-deploy/armed** sebelum temuan CRITICAL berikut diperbaiki — ada jalur langsung ke:
1. Order live **tanpa proteksi stop-loss** (uang beneran tanpa SL/TP)
2. **Prompt injection** lewat `/api/ai-decision` yang tanpa auth → bisa menyetir model
3. **Max daily loss LIVE mati total** (guardrail-nya gak pernah dipanggil)
4. **Signature order bisa dipalsuin** (secret default)

---

## 🔴 CRITICAL — Wajib diperbaiki sebelum live

### Security
| # | Temuan | File:line | Verifikasi |
|---|---|---|---|
| S1 | `/api/ai-decision` **tanpa auth** — prompt injection + abis quota Gemini | server.ts:525 | ✅ 100% dikonfirmasi |
| S2 | `BROKER_EVENT_SECRET` fallback `"paper-dev-secret"` → signature order bisa dipalsuin | paperBook.ts:474 | ✅ 100% dikonfirmasi |
| S3 | `recordLiveRealizedPnl()` **gak pernah dipanggil** → max-daily-loss LIVE mati | guardrails.ts:174 | ✅ 100% dikonfirmasi (0 caller) |

### Financial Correctness
| # | Temuan | File:line | Verifikasi |
|---|---|---|---|
| F1 | **Live mode TANPA SL/TP bracket** + `/api/broker/close` "not implemented" utk live + bracket monitor ga jalan di live | broker.ts:635-655, server.ts:1015,1133 | ✅ 100% dikonfirmasi |
| F2 | Live sizing tanpa min/lot/maxNotional validation + leverage unclamped | tradingPipeline.ts:112, broker.ts:609 | ✅ dikonfirmasi |
| F3 | **Fabricated "$M liquidation volume"** (`volume % 15/18`) masuk prompt LLM & set posisi size | liquidityHunt.ts:45,70 | ✅ 100% dikonfirmasi |

### API & Persistence
| # | Temuan | File:line | Verifikasi |
|---|---|---|---|
| P1 | **ZERO transaksi SQL** — setiap order = 4 write terpisah non-atomic → crash = state korup | db.ts, paperBook.ts | ✅ 100% dikonfirmasi |
| C1 | **No global error handler** → stack trace bocor ke client | server.ts (missing) | ✅ dikonfirmasi |
| C3 | Input `/api/broker/order` gak divalidasi (NaN/leverage/symbol) | server.ts:866 | ✅ dikonfirmasi |
| C4 | `/api/broker/arm` **sekali klik** tanpa konfirmasi/MFA | server.ts:832 | ✅ dikonfirmasi |

---

## 🟠 HIGH

| # | Temuan | File:line |
|---|---|---|
| S5 | `getLiveOpenCountSafe()` fail-**open** ke 0 → max positions ke-bypass | guardrails.ts:191-215 |
| S6 | Passcode default `"paper-local"` cuma warning | auth.ts:13 |
| S9 | `TRADING_MODE` mutable saat runtime — bisa di-flip tanpa restart | broker.ts:262 |
| S10 | No slippage/deadline protection order live — MEV/execution risk | broker.ts:637 |
| H1 | Login limiter lemah (10/min) + no per-endpoint strict limiter | server.ts:101-124 |
| H2 | Session in-memory, no rotation/revocation | auth.ts:9 |
| H3 | CORS wildcard + credentials (invalid/salah konfigurasi) | server.ts:79-97 |
| H4 | CSP dimatikan (`contentSecurityPolicy: false`) | server.ts:73 |
| H5 | `exchange` gak di-allowlist — `ccxt[idx]` bisa `constructor` RCE risk | broker.ts:292 |
| P2 | **Live mode ZERO audit trail** — order real tanpa record apa pun | server.ts:956-988 |
| P3 | **Empty `catch {}`** nelen error audit — disk penuh → audit diam-diam mati | server.ts (7x) |
| P4 | `synchronous = NORMAL` → crash bisa hilang ~1 transaksi (live = serious) | db.ts:26 |
| F4 | Bracket monitor cuma sampling last price → miss wick SL → paper optimistic | paperBook.ts:981 |
| F5 | Slippage understated saat order > visible depth | paperBook.ts:521 |
| F6 | `maxRiskPerTradePercent` gak pernah di-enforce (notional ≠ risk sizing) | riskGatekeeper.ts:52 |

---

## 🟡 MEDIUM

| # | Temuan |
|---|---|
| H6 | Prompt injection via 12+ field user-controlled tanpa sanitasi |
| H7 | Kill switch bisa di-toggle tanpa audit siapa; `Boolean("false")===true` bug |
| M1-M7 | Prototype pollution, body limit, SL/TP posisi gak divalidasi vs entry, ownership, query parsing |
| P5 | HMAC secret fallback ke file auto-generate (bukan env asli) di production |
| P6 | `appendAudit` INSERT bare tanp auth — bisa fail atomicity |
| P7 | `signPayload` pake secret dev terpisah |
| P8 | Session in-memory hilang saat restart |
| F7 | Move-to-BE set SL=entry (kena fee → bukan break-even beneran); default 8% sized |
| F9 | Macro/on-chain canned (simulated) ngaruhin position sizing |
| F10 | `currentDrawdown = maxDrawdown` → gate ke-lock permanen |

---

## 🟢 LOW
P9 ("better-sqlite3" vs `node:sqlite` — doc mismatch), P11 (`.audit-signing-key` chmod no-op di Windows), F12 (latency/volume palsu), F13 (fail-open), L1-L6 (info leak, trust proxy, env docs), F11.

---

## ✅ Yang SUDAH BENER (kabar bagus)
- **P&L/margin/leverage/equity math** — dites numerik end-to-end, sound ✅
- **Liq price pakai maintenance margin** (bukan hardcode ±10%) ✅
- **SL-first same-tick priority** (konservatif, bener) ✅
- HMAC hash-chain + `/api/ledger/verify` **genuinely functional** (nge-detect tamper) ✅
- Seed data palsu udah dihapus — DB jujur ✅
- Vault AES-256-GCM, live double-lock, session 32-byte random ✅
- Auth coverage 35 endpoint — cuma 1 gap (`ai-decision`) ✅

---

## 🎯 Prioritas Fix (urutan eksekusi)

**P0 — Blokir live deploy:**
1. F1: tambah SL/TP bracket real di live (reduceOnly) + implement live close
2. S1: auth + sanitize + rate-limit `/api/ai-decision`
3. S3: panggil `recordLiveRealizedPnl()` di live fill
4. S2: enforce `BROKER_EVENT_SECRET` fail-fast di live
5. F3: hapus `volume %` fabrication dari prompt/sizing

**P1 — Hardening:**
6. P1: wrap semua multi-table write dalam SQL transaction
7. P2: tambah audit trail live mode
8. C1: global error handler
9. C3: Zod validation di broker/order
10. C4: require confirm string di arm

**P2 — Defense-in-depth:**
11. S5/S6/S9, H1-H5, P3, P4, F2, F4, F6...

---

## Sumber
- 4 laporan sub-agent (security, API/authz, financial, persistence)
- Verifikasi manual langsung ke kode (cek: S1,S2,S3,F1,F3,V7,V8,V9,V10)