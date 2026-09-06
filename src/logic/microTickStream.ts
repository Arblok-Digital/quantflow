import { 
  MicroTick1s, 
  MLFeatureVector, 
  TechnicalIndicators, 
  MTFLiquidityAnalysis, 
  OnChainMetrics, 
  MacroSummary 
} from "../types";

/**
 * 1-Second High-Resolution Telemetry & Machine Learning Feeder
 * Provides tick-by-tick sub-second observations for feature store pipelines
 * while isolating agent execution to the 15m tactical horizon.
 */

// Format timestamp as HH:mm:ss
export function formatTickTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().split(" ")[0];
}

/**
 * Generate a real-time 1-second micro tick record.
 * `anchorPrice` = harga real terakhir dari exchange; setiap tick di-revert
 * sebagian (mean-reversion) ke anchor agar simulasi TIDAK drift menjauh dari
 * data real yang dijadikan basis.
 */
export function generateNextMicroTick(
  prevPrice: number,
  symbol: string,
  technicals?: TechnicalIndicators,
  mtfLiquidity?: MTFLiquidityAnalysis,
  onChain?: OnChainMetrics,
  macro?: MacroSummary,
  history: MicroTick1s[] = [],
  anchorPrice?: number
): MicroTick1s {
  const now = Date.now();
  
  // Micro volatility noise: ~0.01% to 0.04% per second
  const driftBias = mtfLiquidity?.activeState === "HUNTING_BSL" ? 0.00015
    : mtfLiquidity?.activeState === "HUNTING_SSL" ? -0.00015
    : 0;

  const randFactor = (Math.random() - 0.495) * 0.0006 + driftBias;
  let rawNewPrice = prevPrice + prevPrice * randFactor;

  // Mean-reversion: tarik harga simulasi kembali ke anchor real (12%/detik),
  // agar ceilang harga tetap dekat dengan harga exchange asli.
  if (anchorPrice != null && anchorPrice > 0) {
    const deviation = prevPrice - anchorPrice;
    rawNewPrice = rawNewPrice - deviation * 0.12;
  }

  const close = Number(rawNewPrice.toFixed(2));
  
  const tickHigh = Number((Math.max(prevPrice, close) + Math.random() * (prevPrice * 0.0001)).toFixed(2));
  const tickLow = Number((Math.min(prevPrice, close) - Math.random() * (prevPrice * 0.0001)).toFixed(2));
  const open = prevPrice;

  const isUp = close >= open;
  const tickDirection = isUp ? "BUY_AGGRESSOR" : "SELL_AGGRESSOR";
  
  // Micro volume in base coin (e.g. 0.08 to 2.8 BTC per second)
  const baseVol = symbol.includes("BTC") ? 0.45 : symbol.includes("ETH") ? 3.2 : 45.0;
  const volume = Number((baseVol * (0.4 + Math.random() * 1.6)).toFixed(4));
  
  // Micro order flow imbalance between -1.0 and +1.0
  const orderFlowImbalance = Number(
    (isUp ? (0.2 + Math.random() * 0.6) : (-0.2 - Math.random() * 0.6)).toFixed(3)
  );

  // Micro spread in USD (e.g. $0.50 on BTC)
  const microSpreadUSD = Number((prevPrice * 0.00008 + Math.random() * 0.15).toFixed(2));

  // Compute 10-second rolling micro-volatility
  const recentCloses = [...history.slice(-9).map((t) => t.close), close];
  const mean = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
  const variance = recentCloses.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / recentCloses.length;
  const rollingVol10s = Number(Math.sqrt(variance).toFixed(4));

  // Extract ML Feature Vector (normalized floats ready for ML training & inference)
  const normPriceDelta = Number(((close - open) / open * 1000).toFixed(4)); // bps normalized
  const mtf15mRsi = technicals ? Number(technicals.rsi.toFixed(2)) : 50.0;
  const sweepFlag = mtfLiquidity?.recentSweep ? 1.0 : 0.0;
  
  // Smart Money bias encoding: +1 Bullish accumulation, -1 Bearish distribution, 0 Neutral
  const whaleNetflowZ = onChain?.smartMoneyBias === "STRONG_BULLISH" ? 1.0
    : onChain?.smartMoneyBias === "LEAN_BULLISH" ? 0.5
    : onChain?.smartMoneyBias === "STRONG_BEARISH" ? -1.0
    : onChain?.smartMoneyBias === "LEAN_BEARISH" ? -0.5
    : 0.0;

  const macroRiskIndex = macro ? macro.macroRiskIndex : 35;

  const mlVector: MLFeatureVector = {
    normPriceDelta,
    rollingVol10s,
    imbalanceRatio: orderFlowImbalance,
    mtf15mRsi,
    sweepFlag,
    whaleNetflowZ,
    macroRiskIndex,
  };

  return {
    id: `tick_${now}_${Math.floor(Math.random() * 1000)}`,
    timestamp: now,
    timeString: formatTickTime(now),
    price: close,
    open,
    high: tickHigh,
    low: tickLow,
    close,
    volume,
    tickDirection,
    microSpreadUSD,
    orderFlowImbalance,
    mlVector,
  };
}

/**
 * Export captured 1s tick buffer as CSV file for Machine Learning
 */
export function exportMLDataCSV(ticks: MicroTick1s[], symbol: string): void {
  if (ticks.length === 0) return;

  const headers = [
    "timestamp",
    "timeString",
    "symbol",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "tickDirection",
    "microSpreadUSD",
    "orderFlowImbalance",
    "ml_normPriceDelta",
    "ml_rollingVol10s",
    "ml_imbalanceRatio",
    "ml_mtf15mRsi",
    "ml_sweepFlag",
    "ml_whaleNetflowZ",
    "ml_macroRiskIndex",
  ];

  const rows = ticks.map((t) => [
    t.timestamp,
    t.timeString,
    symbol,
    t.open,
    t.high,
    t.low,
    t.close,
    t.volume,
    t.tickDirection,
    t.microSpreadUSD,
    t.orderFlowImbalance,
    t.mlVector.normPriceDelta,
    t.mlVector.rollingVol10s,
    t.mlVector.imbalanceRatio,
    t.mlVector.mtf15mRsi,
    t.mlVector.sweepFlag,
    t.mlVector.whaleNetflowZ,
    t.mlVector.macroRiskIndex,
  ]);

  const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `ML_Feed_1s_${symbol.replace("/", "_")}_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Export captured 1s tick buffer as JSON tensors
 */
export function exportMLDataJSON(ticks: MicroTick1s[], symbol: string): void {
  if (ticks.length === 0) return;

  const payload = {
    symbol,
    sampleCount: ticks.length,
    resolution: "1s",
    agentExecutionTimeframe: "15m",
    exportedAt: new Date().toISOString(),
    featureNames: [
      "normPriceDelta",
      "rollingVol10s",
      "imbalanceRatio",
      "mtf15mRsi",
      "sweepFlag",
      "whaleNetflowZ",
      "macroRiskIndex",
    ],
    // Tensor matrix ready for numpy / torch.tensor(X)
    tensorMatrix: ticks.map((t) => [
      t.mlVector.normPriceDelta,
      t.mlVector.rollingVol10s,
      t.mlVector.imbalanceRatio,
      t.mlVector.mtf15mRsi,
      t.mlVector.sweepFlag,
      t.mlVector.whaleNetflowZ,
      t.mlVector.macroRiskIndex,
    ]),
    ticks,
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `ML_Tensors_1s_${symbol.replace("/", "_")}_${Date.now()}.json`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
