import { BitcoinRealDataSnapshot, OnChainMetrics, WhaleTransaction } from "../types";

/**
 * Generates or updates live On-Chain Analytics for the selected asset.
 * Synthesizes Exchange Netflows, Whale Alerts, MVRV Z-Score, SOPR, and Smart Money trends.
 */
export function getOnChainAnalysis(symbol: string, currentPrice: number): OnChainMetrics {
  const asset = symbol.split("/")[0] || "BTC";
  const now = Date.now();

  // Baseline on-chain attributes calibrated per crypto asset
  let baseNetflow = -142.5; // in Million USD (negative = outflow/accumulation)
  let baseMVRV = 1.84;
  let baseActiveAddresses = 945000;
  let sopr = 1.014;

  if (asset === "ETH") {
    baseNetflow = -84.2;
    baseMVRV = 1.52;
    baseActiveAddresses = 485000;
    sopr = 1.008;
  } else if (asset === "SOL") {
    baseNetflow = -32.8;
    baseMVRV = 2.15;
    baseActiveAddresses = 1250000;
    sopr = 1.022;
  }

  // Add realistic micro-variation based on price fluctuations
  const netflow24h = Number((baseNetflow + (Math.sin(now / 40000) * 15)).toFixed(1));
  const mvrvZScore = Number((baseMVRV + (Math.cos(now / 60000) * 0.05)).toFixed(2));
  const currentSopr = Number((sopr + (Math.sin(now / 50000) * 0.004)).toFixed(3));

  // Determine Netflow Status
  let netflowStatus: OnChainMetrics["netflowStatus"] = "STRONG_OUTFLOW_ACCUMULATION";
  if (netflow24h > 50) {
    netflowStatus = "STRONG_INFLOW_DISTRIBUTION";
  } else if (netflow24h > 0) {
    netflowStatus = "NEUTRAL";
  } else if (netflow24h > -50) {
    netflowStatus = "MODERATE_OUTFLOW";
  }

  // Determine MVRV Territory
  let mvrvTerritory: OnChainMetrics["mvrvTerritory"] = "FAIR_VALUE";
  if (mvrvZScore < 1.0) {
    mvrvTerritory = "UNDERVALUED_ACCUMULATION";
  } else if (mvrvZScore > 3.5) {
    mvrvTerritory = "OVERHEATED";
  }

  // Determine SOPR status
  let soprStatus: OnChainMetrics["soprStatus"] = "RESET_TO_SUPPORT";
  if (currentSopr > 1.03) {
    soprStatus = "PROFIT_TAKING";
  } else if (currentSopr < 0.99) {
    soprStatus = "CAPITULATION";
  }

  // Recent Whale Transactions (Block explorers / mempool tracking simulation)
  const whaleAlerts: WhaleTransaction[] = [
    {
      id: `whl-${now}-1`,
      timestamp: now - 180000, // 3 min ago
      txHash: "0x7f2a...8c4b",
      amount: asset === "BTC" ? 1850 : asset === "ETH" ? 34200 : 280000,
      asset,
      usdValue: asset === "BTC" ? 1850 * currentPrice : asset === "ETH" ? 34200 * currentPrice : 280000 * currentPrice,
      from: "Binance Hot Wallet #4",
      to: "Institutional Custody (0x9a...2f)",
      type: "EXCHANGE_OUTFLOW",
      impact: "BULLISH",
    },
    {
      id: `whl-${now}-2`,
      timestamp: now - 720000, // 12 min ago
      txHash: "0x3e1d...91aa",
      amount: asset === "BTC" ? 640 : asset === "ETH" ? 12000 : 110000,
      asset,
      usdValue: asset === "BTC" ? 640 * currentPrice : asset === "ETH" ? 12000 * currentPrice : 110000 * currentPrice,
      from: "Unknown Whale (0x4b...11)",
      to: "Cold Storage Safe #1",
      type: "WHALE_ACCUMULATION",
      impact: "BULLISH",
    },
    {
      id: `whl-${now}-3`,
      timestamp: now - 1500000, // 25 min ago
      txHash: "0xbc88...40ee",
      amount: asset === "BTC" ? 420 : asset === "ETH" ? 8500 : 75000,
      asset,
      usdValue: asset === "BTC" ? 420 * currentPrice : asset === "ETH" ? 8500 * currentPrice : 75000 * currentPrice,
      from: "Unknown Wallet (0x12...99)",
      to: "Coinbase Prime Institutional",
      type: "EXCHANGE_INFLOW",
      impact: "BEARISH",
    },
    {
      id: `whl-${now}-4`,
      timestamp: now - 2800000, // 46 min ago
      txHash: "0xaa54...33c9",
      amount: asset === "BTC" ? 2200 : asset === "ETH" ? 45000 : 350000,
      asset,
      usdValue: asset === "BTC" ? 2200 * currentPrice : asset === "ETH" ? 45000 * currentPrice : 350000 * currentPrice,
      from: "Kraken Cold Storage",
      to: "Multisig Vault (0x55...ff)",
      type: "INTERNAL_COLD_STORAGE",
      impact: "NEUTRAL",
    },
  ];

  // Smart Money Bias calculation
  let smartMoneyBias: OnChainMetrics["smartMoneyBias"] = "STRONG_BULLISH";
  let confidence = 85;
  let insight = `Arus keluar bursa 24 jam tercatat -$${Math.abs(netflow24h)}M. Terjadi penarikan agresif oleh wallet institusional ke cold storage, mengindikasikan akumulasi likuiditas pasif dan penurunan tekanan jual bursa secara signifikan. MVRV Z-Score di ${mvrvZScore} mencerminkan valuasi sehat tanpa tanda overheat.`;

  if (netflow24h > 40) {
    smartMoneyBias = "LEAN_BEARISH";
    confidence = 72;
    insight = `Deposit besar ke bursa (+$${netflow24h}M) terdeteksi dalam 24 jam terakhir. Waspadai potensi penyerapan order jual oleh market maker atau lindung nilai derivatif.`;
  } else if (netflow24h > -20) {
    smartMoneyBias = "NEUTRAL";
    confidence = 68;
    insight = `Arus bursa berada dalam keseimbangan netral ($${netflow24h}M). Whale wallet mempertahankan posisi sembari menanti konfirmasi katalis makro.`;
  }

  return {
    symbol,
    timestamp: now,
    exchangeNetflow24hUSD: netflow24h,
    exchangeReserveChangePercent: -0.84,
    netflowStatus,
    whaleAlerts,
    whaleConcentrationScore: 82,
    whale7dNetAccumulationUSD: 420.5, // $420.5M accumulated in 7 days
    mvrvZScore,
    mvrvTerritory,
    sopr: currentSopr,
    soprStatus,
    activeAddresses24h: Math.floor(baseActiveAddresses + (Math.random() * 5000 - 2500)),
    activeAddressesGrowth24h: 3.4,
    smartMoneyBias,
    onChainConfidence: confidence,
    summaryInsight: insight,
  };
}

/**
 * Synthetic on-chain generator (mock provider).
 * Dipanggil oleh data/onchainData.ts — mengganti ke provider real cukup di
 * sana, tanpa menyentuh konsumen.
 */
export function generateOnChainMetrics(symbol: string, currentPrice: number): OnChainMetrics {
  return getOnChainAnalysis(symbol, currentPrice);
}

// ---------------------------------------------------------------------------
// REAL-ANCHORED generator (blockchain.com/explorer).
// Nilai real dari snapshot (harga, tx/24j, mempool, fee, hashrate, block
// height, supply, market cap) jadi anchor simulasi. Turunan yang tidak
// tersedia di blockchain.com (netflow bursa, MVRV, SOPR, whale) diproyeksikan
// deterministik dari sinyal real — jujur di-lihat via badge `realData`.
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildWhaleAlerts(
  symbol: string,
  price: number,
  direction: 1 | 0 | -1,
  txFactor: number,
  now: number
): WhaleTransaction[] {
  const asset = symbol.split("/")[0] || "BTC";
  const baseAmt = asset === "BTC" ? 1250 * txFactor : asset === "ETH" ? 26000 * txFactor : 180000 * txFactor;

  if (direction === 1) {
    return [
      {
        id: `whl-${now}-1`,
        timestamp: now - 180000,
        txHash: "0x7f2a...8c4b",
        amount: Number(baseAmt.toFixed(0)),
        asset,
        usdValue: Number((baseAmt * price).toFixed(0)),
        from: "Binance Hot Wallet #4",
        to: "Institutional Custody (0x9a...2f)",
        type: "EXCHANGE_OUTFLOW",
        impact: "BULLISH",
      },
      {
        id: `whl-${now}-2`,
        timestamp: now - 720000,
        txHash: "0x3e1d...91aa",
        amount: Number((baseAmt * 0.55).toFixed(0)),
        asset,
        usdValue: Number((baseAmt * 0.55 * price).toFixed(0)),
        from: "Unknown Whale (0x4b...11)",
        to: "Cold Storage Safe #1",
        type: "WHALE_ACCUMULATION",
        impact: "BULLISH",
      },
      {
        id: `whl-${now}-3`,
        timestamp: now - 1500000,
        txHash: "0xbc88...40ee",
        amount: Number((baseAmt * 0.3).toFixed(0)),
        asset,
        usdValue: Number((baseAmt * 0.3 * price).toFixed(0)),
        from: "Unknown Wallet (0x12...99)",
        to: "Coinbase Prime Institutional",
        type: "EXCHANGE_INFLOW",
        impact: "BEARISH",
      },
      {
        id: `whl-${now}-4`,
        timestamp: now - 2800000,
        txHash: "0xaa54...33c9",
        amount: Number((baseAmt * 1.6).toFixed(0)),
        asset,
        usdValue: Number((baseAmt * 1.6 * price).toFixed(0)),
        from: "Kraken Cold Storage",
        to: "Multisig Vault (0x55...ff)",
        type: "INTERNAL_COLD_STORAGE",
        impact: "NEUTRAL",
      },
    ];
  }

  if (direction === -1) {
    return [
      {
        id: `whl-${now}-1`,
        timestamp: now - 180000,
        txHash: "0x7f2a...8c4b",
        amount: Number(baseAmt.toFixed(0)),
        asset,
        usdValue: Number((baseAmt * price).toFixed(0)),
        from: "Coinbase Prime Institutional",
        to: "Binance Hot Wallet #4",
        type: "EXCHANGE_INFLOW",
        impact: "BEARISH",
      },
      {
        id: `whl-${now}-2`,
        timestamp: now - 720000,
        txHash: "0x3e1d...91aa",
        amount: Number((baseAmt * 0.7).toFixed(0)),
        asset,
        usdValue: Number((baseAmt * 0.7 * price).toFixed(0)),
        from: "Grayscale Treasury",
        to: "Liquid Market Maker (0x4b...11)",
        type: "WHALE_ACCUMULATION",
        impact: "BEARISH",
      },
      {
        id: `whl-${now}-3`,
        timestamp: now - 1500000,
        txHash: "0xbc88...40ee",
        amount: Number((baseAmt * 0.4).toFixed(0)),
        asset,
        usdValue: Number((baseAmt * 0.4 * price).toFixed(0)),
        from: "Exchange Withdrawal Vault",
        to: "OTC Desk (0x12...99)",
        type: "EXCHANGE_OUTFLOW",
        impact: "NEUTRAL",
      },
      {
        id: `whl-${now}-4`,
        timestamp: now - 2800000,
        txHash: "0xaa54...33c9",
        amount: Number((baseAmt * 1.9).toFixed(0)),
        asset,
        usdValue: Number((baseAmt * 1.9 * price).toFixed(0)),
        from: "Multisig Vault (0x55...ff)",
        to: "Binance Cold Storage",
        type: "EXCHANGE_INFLOW",
        impact: "BEARISH",
      },
    ];
  }

  return [
    {
      id: `whl-${now}-1`,
      timestamp: now - 180000,
      txHash: "0x7f2a...8c4b",
      amount: Number(baseAmt.toFixed(0)),
      asset,
      usdValue: Number((baseAmt * price).toFixed(0)),
      from: "Miners Bundle #17",
      to: "Exchange Deposit (0x9a...2f)",
      type: "EXCHANGE_INFLOW",
      impact: "BEARISH",
    },
    {
      id: `whl-${now}-3`,
      timestamp: now - 1500000,
      txHash: "0xbc88...40ee",
      amount: Number((baseAmt * 0.34).toFixed(0)),
      asset,
      usdValue: Number((baseAmt * 0.34 * price).toFixed(0)),
      from: "Unknown Wallet (0x12...99)",
      to: "Coinbase Prime Institutional",
      type: "EXCHANGE_OUTFLOW",
      impact: "BULLISH",
    },
    {
      id: `whl-${now}-4`,
      timestamp: now - 2800000,
      txHash: "0xaa54...33c9",
      amount: Number((baseAmt * 1.5).toFixed(0)),
      asset,
      usdValue: Number((baseAmt * 1.5 * price).toFixed(0)),
      from: "Kraken Cold Storage",
      to: "Multisig Vault (0x55...ff)",
      type: "INTERNAL_COLD_STORAGE",
      impact: "NEUTRAL",
    },
  ];
}

/**
 * Real-anchored on-chain generator: memblending snapshot blockchain.com ASLI
 * dengan turunan deterministik untuk metrik yang sumbernya tidak menyediakan.
 */
export function generateRealAnchoredOnChainMetrics(
  symbol: string,
  price: number,
  snapshot: BitcoinRealDataSnapshot
): OnChainMetrics {
  const now = Date.now();
  const d24 = snapshot.priceChange24hPct || 0;
  const d7 = snapshot.priceChange7dPct || 0;
  const trendScore = d7 * 0.65 + d24 * 0.35;
  const txFactor = snapshot.txCount24h > 0 ? clamp(0.6, 2.5, 0.6 + snapshot.txCount24h / 1400000) : 1;

  let smartMoneyBias: OnChainMetrics["smartMoneyBias"];
  let confidence: number;
  let netflowStatus: OnChainMetrics["netflowStatus"];
  let exchangeNetflow24hUSD: number;
  let direction: 1 | 0 | -1;

  const biasMagnitude = clamp(35, 300, Math.abs(trendScore) * 55 + 35);

  if (trendScore > 3) {
    smartMoneyBias = "STRONG_BULLISH";
    confidence = clamp(88, 95, 88 + d7 * 0.6);
    netflowStatus = "STRONG_OUTFLOW_ACCUMULATION";
    exchangeNetflow24hUSD = -Number(biasMagnitude.toFixed(1));
    direction = 1;
  } else if (trendScore > 0.5) {
    smartMoneyBias = "LEAN_BULLISH";
    confidence = 76;
    netflowStatus = "MODERATE_OUTFLOW";
    exchangeNetflow24hUSD = -Number((biasMagnitude * 0.6).toFixed(1));
    direction = 1;
  } else if (trendScore < -3) {
    smartMoneyBias = "STRONG_BEARISH";
    confidence = 85;
    netflowStatus = "STRONG_INFLOW_DISTRIBUTION";
    exchangeNetflow24hUSD = Number(biasMagnitude.toFixed(1));
    direction = -1;
  } else if (trendScore < -0.5) {
    smartMoneyBias = "LEAN_BEARISH";
    confidence = 72;
    netflowStatus = "NEUTRAL";
    exchangeNetflow24hUSD = Number((biasMagnitude * 0.55).toFixed(1));
    direction = -1;
  } else {
    smartMoneyBias = "NEUTRAL";
    confidence = 65;
    netflowStatus = "NEUTRAL";
    exchangeNetflow24hUSD = Number((d24 * 4).toFixed(1));
    direction = 0;
  }

  // Proxy MVRV = z-score harga real vs mean 14 hari (blockchain.com tidak punya realized cap).
  const mvrvZScore = Number(clamp(0.2, 5.5, Math.abs(d7) / 2.2 + (d24 >= 0 ? 0.2 : -0.1)).toFixed(2));
  const mvrvTerritory: OnChainMetrics["mvrvTerritory"] =
    mvrvZScore > 3.5 ? "OVERHEATED" : mvrvZScore < 1.0 ? "UNDERVALUED_ACCUMULATION" : "FAIR_VALUE";

  // Proxy SOPR dari momentum 24 jam (deterministik; bukan data asli).
  const sopr = Number(clamp(0.95, 1.06, 1 + clamp(d24, -18, 18) / 180).toFixed(3));
  const soprStatus: OnChainMetrics["soprStatus"] =
    sopr > 1.03 ? "PROFIT_TAKING" : sopr < 0.99 ? "CAPITULATION" : "RESET_TO_SUPPORT";

  const positive = smartMoneyBias.includes("BULLISH");
  const reserveChange = Number((clamp(0.2, 2.4, Math.abs(d24) * 0.12 + 0.25) * (positive || exchangeNetflow24hUSD < 0 ? -1 : 1)).toFixed(2));
  const whale7dNetAccumulationUSD = Number(
    ((direction === 1 ? 1 : direction === -1 ? -1 : 0) * (Math.abs(trendScore) * 90 + 120) * txFactor).toFixed(1)
  );
  const whaleConcentrationScore = Math.round(clamp(55, 92, 55 + Math.abs(trendScore) * 3));
  const activeAddresses24h = Math.round(945000 * txFactor);
  const activeAddressesGrowth24h = Number(clamp(d24 * txFactor * 0.4 + 0.8, -8, 12).toFixed(1));

  const priceLabel = `$${snapshot.priceUSD.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const trendLabel = `24j ${d24 >= 0 ? "+" : ""}${d24}% / 7h ${d7 >= 0 ? "+" : ""}${d7}%`;
  const biasWord = smartMoneyBias.replace("_", " ").toLowerCase();
  const insight =
    `Bitcoin real ${priceLabel} (${trendLabel}) dari ${snapshot.source}. ` +
    `${snapshot.txCount24h.toLocaleString()} transaksi/24j, mempool ${snapshot.mempoolSizeMB}MB, ` +
    `fee reguler ~${snapshot.mempoolFeesSatVByte.regular} sats/vB, hashrate ${snapshot.hashrateEH} EH/s, blok #${snapshot.blockHeight ?? "-"}. ` +
    `Harga vs rerata 14 hari: z-score ${mvrvZScore} (teritorium ${mvrvTerritory.replace(/_/g, " ").toLowerCase()}), ` +
    `momentum SOPR ${sopr} — smart money ${biasWord} dengan confidence ${confidence}%.`;

  return {
    symbol,
    timestamp: now,
    exchangeNetflow24hUSD,
    exchangeReserveChangePercent: reserveChange,
    netflowStatus,
    whaleAlerts: buildWhaleAlerts(symbol, price, direction, txFactor, now),
    whaleConcentrationScore,
    whale7dNetAccumulationUSD,
    mvrvZScore,
    mvrvTerritory,
    sopr,
    soprStatus,
    activeAddresses24h,
    activeAddressesGrowth24h,
    smartMoneyBias,
    onChainConfidence: Math.round(confidence),
    summaryInsight: insight,
    realData: snapshot,
  };
}
