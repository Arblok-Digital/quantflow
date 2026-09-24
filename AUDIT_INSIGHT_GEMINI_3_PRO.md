# 🕵️ Audit & Insight Report
**Auditor**: Gemini 3 Pro (via AI Agent)
**Tanggal**: 24 September 2026
**Fokus**: Arsitektur Tab Advisor, Keel Engine Arithmetic, Data Pipeline & Eksekusi

---

## 1. Arsitektur & Pipeline (Keel → JEV → LLM)
- **Grade: 9.2/10 (Production-Ready)**
- Sistem memiliki mekanisme *fail-closed* yang sangat disiplin di setiap layernya.
- Pembagian tugas sangat terstruktur layaknya *institutional quant desk*: JEV bertugas sebagai System One (deterministik eksekusi berbasis data mentah), sedangkan LLM (Gemini) diisolasi sebagai "Penasihat Naratif" (System Two) tanpa akses eksekusi langsung.
- **Tweak Area**: *Timeout Latency*. Fallback JEV yang berjalan di CLI lokal (Opencode) memiliki *timeout* 30 detik. Untuk keperluan *scalping*, direkomendasikan menambahkan batas *timeout* ketat (2-3 detik per *provider*) agar tidak menghambat *loop* eksekusi.

---

## 2. Aritmatika Keel Engine (Deep Dive)
Logika kalkulus yang diterapkan pada Keel melebihi standar bot ritel dan menyerupai model analitik firma quant.

- **Order Flow & Absorption (`smart-money-tracker.ts`, `absorption-engine.ts`)**: Tidak hanya mengandalkan *net buying*, tapi memfilter noise melalui **Dominance Threshold 62%** dan **Large Trade Share >= 30%**. Formula skor absorpsi (menggabungkan stagnasi harga, rasio dominansi, dan *log-scaled notional*) merupakan implementasi handal untuk deteksi *hidden liquidity* / *iceberg orders*.
- **MTF Confluence (`confluence-matrix.ts`)**: Penggunaan vektor linier berbobot konvergen (D1=40%, H4=30%, H1=20%, M15=10%) dengan deteksi `pullbackEntry` yang solid untuk entri *mean-reversion* searah trend makro.
- **Risk-Targeted Sizing (`entry-risk-engine.ts`)**: Penentuan *Stop Loss* (SL) dibuat dengan *floor* dinamis (8x *bid-ask spread*) yang 100% imun terhadap *micro-noise*. Ukuran posisi lot ditentukan via perhitungan murni: `Risk Target / SL Distance`, menjaga jumlah kerugian modal (USD) tetap statis, terlepas dari seberapa lebarnya jarak SL.
- **Tweak Area**: Rumus Order Book Imbalance (OBI) saat ini menggunakan rasio `Bid / Ask` yang rawan terhadap nilai limit (tak terhingga). Sebaiknya direfaktor menjadi formula konvensional `(Bid - Ask) / (Bid + Ask)` (rentang -1 hingga +1). Volatilitas disarankan menggunakan pendekatan rentang *Garman-Klass* ketimbang rasio `High-Low / Mid` murni untuk mencegah jebol akibat *single tick fat-finger*.

---

## 3. 🚨 TEMUAN KRITIKAL (P0) - Data Pipeline & Eksekusi
Walaupun logika Keel sempurna, ditemukan **CRITICAL SYSTEMIC BUGS** pada integrasi pipa data semenjak migrasi fitur F-07 (Server-side Pipeline). Bug ini menyebabkan AI tidak pernah mengeksekusi *trade* dan membahayakan keamanan transaksi.

### A. Silent AI Bypass (Relative Fetch Error di Node.js)
- **Lokasi**: `src/logic/decisionEngine.ts` (Line 138)
- **Masalah**: `evaluateTradingDecision` menggunakan `authFetch("/api/ai-decision", ...)` saat dipanggil dari server (`pipeline.ts`). *Native fetch* Node.js tidak mendukung *Relative URL* dan akan langsung *throw error* `TypeError: Invalid URL`.
- **Dampak Fatal**: Error masuk ke *catch* secara tersembunyi, dan sistem otomatis melakukan fallback 100% menggunakan Keel Engine lokal. Praktis, **AI (JEV & Gemini) lumpuh total (tidak pernah berjalan) pada server-side pipeline**.

### B. Provenance Gate Bypass (Risiko Eksekusi Harga Hantu)
- **Lokasi**: `src/server/routes/pipeline.ts` & `src/server/routes/ai.ts`
- **Masalah**: Logika penahan eksekusi untuk harga basi (*Provenance Gate*) diletakkan di dalam route HTTP `ai.ts`. Namun karena Bug A di atas, *fetch* gagal dan sistem bypass ke fungsi `runKeelQuantEngine()` lokal yang buta akan *provenance/freshness* data.
- **Dampak Fatal**: Jika perangkat client *sleep* atau *lag* dan mengirimkan data harga 1 jam yang lalu, Keel tetap mengeluarkan sinyal BUY/SELL, lolos dari *gatekeeper* utama, dan tereksekusi pada harga yang sudah tidak valid di market.

### C. Penggunaan Browser API di Node.js (authFetch)
- **Lokasi**: `src/hooks/useAuth.ts` (dipanggil oleh `decisionEngine.ts`)
- **Masalah**: `authFetch` secara internal mengandalkan `localStorage.getItem()` untuk menyisipkan Bearer token. `localStorage` tidak terdefinisi di Node.js.
- **Dampak**: Pun jika masalah URL absolut (Bug A) diperbaiki, *fetch request* dari server ke servernya sendiri tidak akan membawa *Auth Token*, memicu penolakan *401 Unauthorized* permanen.

---

## 4. Instruksi Perbaikan Untuk Agent (Next Action)
Agent yang ditugaskan berikutnya **WAJIB** mengeksekusi refaktor ini:

1. **Decouple HTTP dari Logic AI**: Ekstrak isi proses di dalam *endpoint* `app.post("/api/ai-decision")` menjadi fungsi terpisah (misalnya `executeAiDecisionCore`).
2. **Direct Server Invocation**: Modifikasi fungsi `evaluateTradingDecision`. Saat dieksekusi di ranah Node.js (via server `pipeline.ts`), **jangan** menggunakan HTTP `authFetch`. Panggil langsung fungsi `executeAiDecisionCore()` di memori server untuk melewati limitasi *fetch*, *relative URL*, dan *auth header*.
3. **Pindahkan Provenance Gate**: Pindahkan filter pengecekan `STALE / SIMULATED` dari level HTTP (di `ai.ts`) ke dalam jantung `evaluateTradingDecision` (di `decisionEngine.ts`). Ini memastikan baik aliran AI maupun fallback Keel secara absolut tidak akan menembakkan order dari data hantu. 
4. Hapus ketergantungan `useAuth` pada fungsi yang dapat diakses oleh Node.js (server backend).