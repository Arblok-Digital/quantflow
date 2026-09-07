# BUILD TASK — OC Phase 5+6: Market Data Real + Correctness (Paper 100%)

Project: ai-trading-agent-engine
Workdir: C:/Users/ARBLOK/Documents/ai-trading-agent-engine
Branch: work from current dirty state — DO NOT git reset. Sync with CC batch: JANGAN sentuh decisionEngine.ts / DecisionStream.tsx / MacroCalendarPanel / OnChainPanel (milik CC). Fokus file di bawah.

## Goal
Paper mode real data: harga & depth dari Binance real, bukan random-walk. Akuntansi leverage & latency jujur.

## Forbidden
- JANGAN baca .env
- JANGAN edit decisionEngine.ts, DecisionStream.tsx (milik CC)
- instal deps seperlunya (ws optional — utamakan native fetch/SSE)

## Tasks

### 5.1 WebSocket Binance -> SSE ke client (BE)
Files: server.ts, src/data/marketData.ts
- Server: tambah route `GET /api/market/stream` (SSE) yang proxy Binance wss `wss://stream.binance.com:9443/ws/<symbol>@trade/<symbol>@depth@100ms`
- SSE emit: `{ type: 'trade', price, qty, time }` dan `{ type: 'depth', bids, asks }`
- Jika WS putus => auto-reconnect dengan backoff 2s/5s/10s, dan emit event `status: disconnected`
- Fallback: jika WS gagal init (env WS_DISABLED) tetap REST polling yang ada
- Client: buat hook baru `src/hooks/useMarketStream.ts` yang consume SSE via EventSource, atau tambah logic di useMarketData.ts untuk subscribe SSE dan update currentPrice/orderBook real-time

### 5.2 Badge INTERPOLATED saat WS mati
File: src/hooks/useMarketData.ts atau useMarketStream.ts
- State `feedMode: 'WS_LIVE' | 'REST_POLL' | 'SIMULATED' | 'INTERPOLATED'`
- Saat WS disconnected >3s, fallback ke microTickStream interpolate tapi set feedMode=INTERPOLATED
- Expose ke UI via exchangeStatus atau feedMode prop

### 5.3 Realtime1sMLFeed source terlihat
File: src/components/Realtime1sMLFeed.tsx
- Tampilkan badge sumber: WS live / REST / SIMULATED / INTERPOLATED
- Counter message rate (msg/sec) dari SSE
- Indikator detak koneksi (dot hijau kedip saat WS live, kuning saat interpolated, merah saat disconnect)
- Jangan rombak layout besar — tambah header row

### 5.4 Fix priceDelta
File: src/hooks/useMarketData.ts line ~136, 257
- Hapus skala arbitrer `+ delta * 10` (jika ada). Pakai `ticker24h.priceChangePercent` real dari fetchLiveMarketData (sudah ada)
- Pastikan priceDelta di-pass ke UI jujur (1.84 hardcode awal boleh tapi setelah sync harus real)

### 5.5 Fix symbol parsing
File: server.ts route /api/market-feed dan /api/broker/* symbol handling
- Kasus `USDC/USDT`, quote non-USDT: parse symbol umum `BASE/QUOTE`, hilangkan slash untuk rawSymbol, handle `USDC/USDT` => `USDCUSDT` (jangan jadi `USDCUSDT` salah). Test dengan BTC/USDT, ETH/USDC, SOL/USDT

### 6.2 Leverage accounting jujur
File: paperBook.ts
- Cash yang dikurangi saat open = margin = notional / leverage (sudah sebagian), tapi pastikan equity = cash + lockedMargin + uPnL (cek getPaperAccount)
- Tambah simulasi margin call: jika mark price menyentuh liquidationPrice (paperBook.liquidationPrice), auto-close dengan reason `LIQUIDATED` dan pnl terhitung (bukan hardcode +-10%)
- Audit log saat liquidated

### 6.3 Single source harga
Files: server.ts (refreshPaperMarks), src/hooks/useMarketData.ts, usePaperTrading.ts
- Satu sumber kebenaran: server tick (dari WS/REST) yang dipakai pipeline, chart, DAN portfolio
- Hapus mark-to-market ganda di client: usePaperTrading harus sync via poll `/api/broker/positions` atau SSE, bukan hitung sendiri dari currentPrice lokal
- Jika tetap butuh local mark, ambil dari server response

### 6.4 ExecutionMetrics latency real
File: src/components/ExecutionMetrics.tsx
- Hapus hardcode `+2`, `+1`, `+8` di latency breakdown (grep `latestLatency` + angka)
- Tampilkan latency nyata per stage yang dilaporkan server (feederMs, decisionMs, executionMs dari pipeline response)
- Jika data belum ada, tampilkan `-` jangan angka karangan. WinRate hardcode "68.4" juga fallback saja, bukan default tetap.

## Acceptance
- npx tsc --noEmit EXIT 0
- WS/SSE route ada & client hook consume (minimal skeleton functional, boleh mock WS jika offline tapi badge harus benar)
- Realtime1sMLFeed menampilkan source badge + heartbeat
- priceDelta bukan `*10`
- symbol parsing handle USDC/USDT
- paperBook liquidation logic ada
- ExecutionMetrics no hardcoded latency

## Verify (manager)
npx tsc --noEmit; grep -n "INTERPOLATED" src/hooks/useMarketData.ts src/hooks/useMarketStream.ts; grep -n "liquidationPrice" paperBook.ts | head; grep -n "priceChangePercent" src/hooks/useMarketData.ts

## Notes
- Setelah selesai, jangan commit — Hermes manager verify & commit
- Ringkas perubahan di akhir
