# solana-scout — meme coin early detection (KOL-first)

Folder **terpisah** dari engine futures (`quantflow-engine` / repo root). Satu repo, dua mesin, dua akuntansi. **Tidak boleh** dicampur ke `paperbook`/HMAC ledger engine.

> Peringatan: skenario token baru bersifat **venture/lottery**, bukan konsistensi ala hedge fund.
> Mayoritas token baru rug. Alokasi maksimal kecil (1–3 SOL per bet), dan hanya setelah fase validasi (RugCheck + likuiditas) LULUS.

## Filosofi

Deteksi dini didasarkan pada **wallet KOL akumulasi on-chain**, bukan tweet (KOL 4–48 jam lebih dulu dari sosial media).

Alur 5 fase:
1. **KOL scan** — scan wallet KOL (138 wallet di `reference/kol-wallets.json`) untuk token yang mereka pegang.
2. **Anomaly** — concurrency: token yang dipegang ≥1 KOL, diurutkan jumlah KOL & verified.
3. **Fundamental / rug gate** — RugCheck + likuiditas + top holder + mint authority. Hard-fail = SKIP, apapun skornya.
4. **Sentimen / narasi gap** — belum di-scrape (honest: `available:false`). Jangan menganggap absennya tweet sebagai sinyal.
5. **Signal** — skor deterministik 0–200 (detail di `scripts/lib/scoring.js`).

Tier: **ALPHA ≥150 · BUY 110–149 · WATCH 70–109 · SKIP <70**. Hard-fail selalu SKIP.

## Cara pakai

```powershell
cd solana-scout

# 1) Scan real (butuh network; Helius/ZAN opsional)
$env:HELIUS_API_KEY = "..."        # optional #1; DAS getAsset + staked reads
$env:ZAN_API_KEY = "..."           # optional #2; credit murah utk reads RPC (getTokenAccountsByOwner/getAccountInfo)
npm run scan -- --wallets 20 --limit 30          # live KOL-first (default)
npm run scan -- --discovery --limit 50 --max-mcap 5000000   # discovery bottom-up DexScreener

# 2) Dashboard UI
npm run serve            # buka http://localhost:4589
```

`meta.feeds.rpc` pada report mencatat feed yang **benar-benar sukses** pada scan terakhir (`helius` / `zan` / `public-rpc`) — bukan sekadar env key. Kalau key Helius/ZAN invalid atau credit habis, label otomatis `public-rpc`.

UI membaca `output/report.json`; tidak ada npm instal (zero-dependency, Node ≥24).

## Struktur

```
solana-scout/
├── package.json
├── reference/kol-wallets.json   # database KOL (138)
├── scripts/
│   ├── kolScan.js      # fase 1 + 2
│   ├── fundamentals.js # fase 3 (RugCheck API)
│   ├── sentiment.js    # fase 4 (stub jujur)
│   ├── signal.js       # fase 5 (skor → verdict)
│   ├── mock.js         # generator data deterministic utk unit test scoring saja
│   ├── scan.js         # orkestrator → output/report.json
│   └── lib/ (rpc, kolDb, scoring)
├── tests/scoring.test.js   # unit fixture (pakai mock.js sebagai data skor)
├── ui/                     # dashboard baca report.json
└── output/report.json      # hasil scan (ditulis ulang tiap scan)
```

## Batas (jujur)

- Fase newborn real-time (PumpPortal WS) & usia token (`ageHours`) dari blocktime **belum diimplementasi** — fase lanjutan.
- Sentimen/narasi gap belum ditarik (stub `available:false`).
- Scan real kena rate-limit RPC publik; Helius direkomendasikan untuk `--wallets` besar.
- Deterministik bukan berarti bisa dipakai langsung: rug gate hanya rugcheck.xyz satu-dua sumber; dev wallet ownership dan pumped volume belum divexplore penuh.

## Test

```powershell
npm test    # node --test tests/*.test.js (8/8 deterministik)
```