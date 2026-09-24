# Data MQL5 (backtest broker CFD)

Folder ini untuk file CSV ekspor MT5 (History Center / backtest data broker)
yang dipakai Replay sebagai sumber candle **MQL5** (tab Paper → Replay),
terpisah dari candle real Binance Vision.

## Format yang didukung

- Delimiter `;` atau `,` (auto-detect).
- Kolom standar MT5, 8 atau 10 kolom:
  `TICKER, DTYYYYMMDD, TIME, OPEN, HIGH, LOW, CLOSE, VOL[, TICKVOL, VOL, SPREAD]`
- Tanggal `YYYY.MM.DD` + waktu `HH:MM[:SS]` (kolom terpisah, atau satu kolom
  datetime `YYYY.MM.DD HH:MM:SS`).
- Header baris pertama boleh ada (auto-detect).

Contoh 8 kolom:

```csv
TICKER,DTYYYYMMDD,TIME,OPEN,HIGH,LOW,CLOSE,VOL
BTCUSD,2024.01.15,10:00,43500,43600,43400,43550,1234
BTCUSD,2024.01.15,10:15,43550,43650,43500,43600,987
```

## Cara pakai

1. Letakkan file `.csv` di folder ini (atau set `MQL5_DATA_DIR`).
2. Verifikasi tanpa membuat sesi:

   ```bash
   npm run mql5:verify -- --file BTCUSD15.csv --timeframe 15m --offset 0
   ```

3. Di FE (tab Replay): pilih sumber **MQL5**, isi nama file + UTC offset,
   klik **Verify**, lalu **Start**.

Catatan:
- File `.csv` di folder ini di-ignore oleh git (`data/mql5/*.csv`).
- UTC offset = perbedaan zona waktu server broker relatif UTC, dalam menit
  (mis. WIB = +420). File yang sudah dalam waktu UTC → `0`.
- Jangan mencampur run Binance dan MQL5 dalam satu bucket training:
  `data_source` tercatat per run (`binance` vs `mql5`) di dataset & audit.