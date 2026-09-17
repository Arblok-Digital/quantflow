/**
 * Pre-trade risk gate — deterministik, murni, dipakai di CHOKE POINT eksekusi
 * (paperBook semua order + liveBroker) supaya aturan matematis TIDAK bisa
 * di-bypass lewat jalur manual.
 *
 * Kenapa modul ini ada (audit F1/P0):
 * `evaluateRiskGate()` (src/logic/riskGatekeeper.ts) hanya dipanggil di
 * /api/pipeline/cycle. Order dari panel/tombol masuk ke /api/broker/order yang
 * cuma menjalankan guardrails (kill-switch, daily-loss, max posisi, cooldown) —
 * tidak ada satu pun aturan matematis. Hasilnya (forensik trading.db):
 * RR 1.28 lolos (policy 1.8), SL 0.08% lolos (di dalam noise), dan RR 2.4 dengan
 * SL 0.88% duduk persis di titik impas random walk (0.88/(0.88+2.12) = 29.3%)
 * → EV negatif by construction begitu fee dihitung.
 *
 * Aturan (semua hard, fail-closed):
 *  1. bracket valid: BUY  stopLoss < price < takeProfit ; SELL kebalikannya
 *  2. jarak SL >= minStopDistancePercent (lantai anti-noise & anti-fee)
 *  3. reward/risk >= minRiskRewardRatio
 *  4. notional <= maxNotionalPercent × equity
 *  5. risiko riil (jarak SL × notional) <= maxRiskPerTradePercent × equity
 *
 * Catatan semantik: risiko di sini = jarak SL × NOTIONAL (bukan % equity yang
 * dikirim client). Fee bolak-balik dihitung terpisah di metrics.roundTripCostUsd
 * supaya terlihat berapa biaya yang harus ditutup harga.
 */

export interface OrderRiskPolicy {
  /** Risiko maksimum per trade (jarak SL × notional) sebagai % equity. */
  maxRiskPerTradePercent: number;
  /** Notional maksimum sebagai % equity. */
  maxNotionalPercent: number;
  /** Reward/risk minimum (rewardDistance / riskDistance). */
  minRiskRewardRatio: number;
  /** Jarak SL minimum sebagai % harga. */
  minStopDistancePercent: number;
  /** Fee taker per sisi (fraksi notional, mis. 0.0004 = 4 bps). */
  takerFeeRate: number;
  /**
   * true = equity wajib diketahui; bila tidak → order ditolak
   * (EQUITY_UNAVAILABLE). Dipakai di jalur LIVE (fail-closed).
   */
  requireEquity?: boolean;
}

export interface OrderRiskInput {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  /** Harga acuan evaluasi (harga eksekusi aktual bila sudah fill). */
  price: number;
  stopLoss: number;
  takeProfit: number;
  leverage?: number;
  /** Equity akun; undefined = tak diketahui. */
  equity?: number;
}

export interface OrderRiskMetrics {
  price: number;
  stopDistancePercent: number;
  rewardDistancePercent: number;
  riskRewardRatio: number;
  notionalUsd: number;
  marginUsd: number;
  notionalPercentOfEquity: number | null;
  riskUsd: number;
  riskPercentOfEquity: number | null;
  roundTripCostUsd: number;
}

export interface OrderRiskEvaluation {
  approved: boolean;
  reasons: string[];
  metrics: OrderRiskMetrics | null;
  /** true = aturan yang butuh equity (4 & 5) tidak diperiksa. */
  capsSkipped: boolean;
}

export const ORDER_RISK_REASONS = {
  INVALID_INPUT: "RISK_INVALID_INPUT",
  INVALID_BRACKET: "RISK_INVALID_BRACKET",
  STOP_TOO_TIGHT: "RISK_STOP_TOO_TIGHT",
  RR_BELOW_MIN: "RISK_RR_BELOW_MIN",
  NOTIONAL_TOO_LARGE: "RISK_NOTIONAL_TOO_LARGE",
  RISK_PER_TRADE_EXCEEDED: "RISK_PER_TRADE_EXCEEDED",
  EQUITY_UNAVAILABLE: "RISK_EQUITY_UNAVAILABLE",
} as const;

function envNum(raw: string | undefined, def: number): number {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Policy default server (env-overridable) — satu sumber untuk paper & live.
 * Nilai default dipilih konservatif tapi tidak memblokir alur panel normal
 * (panel 15m default SL 0.8% / TP 1.2% → RR 1.5, notional 12% equity).
 */
export function defaultOrderRiskPolicy(): OrderRiskPolicy {
  return {
    maxRiskPerTradePercent: envNum(process.env.RISK_MAX_PER_TRADE_PCT, 1.0),
    maxNotionalPercent: envNum(process.env.RISK_MAX_NOTIONAL_PCT, 25),
    minRiskRewardRatio: envNum(process.env.RISK_MIN_RR, 1.5),
    minStopDistancePercent: envNum(process.env.RISK_MIN_STOP_PCT, 0.35),
    takerFeeRate: envNum(process.env.PAPER_FEE_TAKER_BPS, 4) / 10000,
  };
}

/**
 * Toggle gate (default ON). `RISK_GATE_ENABLED=false|0|off|no` mematikannya —
 * hanya untuk eksperimen terkontrol; produksi wajib ON.
 */
export function isOrderRiskGateEnabled(): boolean {
  const raw = String(process.env.RISK_GATE_ENABLED ?? "").trim().toLowerCase();
  if (raw === "") return true;
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

const r2 = (n: number) => Number(n.toFixed(2));
const r4 = (n: number) => Number(n.toFixed(4));

/**
 * Toleransi floating point untuk perbandingan ambang.
 * Contoh nyata: bracket 0.8% / 1.2% menghasilkan RR 1.4999999999999998 →
 * order yang SEHAT ditolak "RR < 1.5". Ambang harus dibandingkan dengan
 * toleransi, bukan dengan kesamaan bit.
 */
const THRESHOLD_EPSILON = 1e-9;

export function evaluateOrderRisk(
  input: OrderRiskInput,
  policy: OrderRiskPolicy = defaultOrderRiskPolicy(),
): OrderRiskEvaluation {
  const reasons: string[] = [];
  const price = Number(input.price);
  const qty = Number(input.qty);
  const leverage = Number(input.leverage) > 0 ? Number(input.leverage) : 1;
  const sl = Number(input.stopLoss);
  const tp = Number(input.takeProfit);
  const equityRaw = input.equity != null ? Number(input.equity) : NaN;
  const equity = Number.isFinite(equityRaw) && equityRaw > 0 ? equityRaw : undefined;
  const capsSkipped = equity === undefined;

  if (
    !Number.isFinite(price) || price <= 0 ||
    !Number.isFinite(qty) || qty <= 0 ||
    !Number.isFinite(sl) || sl <= 0 ||
    !Number.isFinite(tp) || tp <= 0
  ) {
    return { approved: false, reasons: [ORDER_RISK_REASONS.INVALID_INPUT], metrics: null, capsSkipped };
  }

  const isBuy = input.side === "buy";
  const bracketOk = isBuy ? sl < price && price < tp : tp < price && price < sl;
  const stopDistancePercent = (Math.abs(price - sl) / price) * 100;
  const rewardDistancePercent = (Math.abs(tp - price) / price) * 100;
  const riskRewardRatio = stopDistancePercent > 0 ? rewardDistancePercent / stopDistancePercent : 0;
  const notionalUsd = price * qty;
  const riskUsd = notionalUsd * (stopDistancePercent / 100);
  const roundTripCostUsd = notionalUsd * policy.takerFeeRate * 2;

  const metrics: OrderRiskMetrics = {
    price,
    stopDistancePercent: r4(stopDistancePercent),
    rewardDistancePercent: r4(rewardDistancePercent),
    riskRewardRatio: r2(riskRewardRatio),
    notionalUsd: r2(notionalUsd),
    marginUsd: r2(notionalUsd / leverage),
    notionalPercentOfEquity: equity !== undefined ? r4((notionalUsd / equity) * 100) : null,
    riskUsd: r2(riskUsd),
    riskPercentOfEquity: equity !== undefined ? r4((riskUsd / equity) * 100) : null,
    roundTripCostUsd: r2(roundTripCostUsd),
  };

  if (!bracketOk) {
    reasons.push(
      `${ORDER_RISK_REASONS.INVALID_BRACKET}:${isBuy ? "SL<harga<TP" : "TP<harga<SL"} (SL ${sl} / harga ${price} / TP ${tp})`,
    );
  }
  if (stopDistancePercent < policy.minStopDistancePercent - THRESHOLD_EPSILON) {
    reasons.push(
      `${ORDER_RISK_REASONS.STOP_TOO_TIGHT}:SL ${stopDistancePercent.toFixed(2)}% < lantai ${policy.minStopDistancePercent}%`,
    );
  }
  if (riskRewardRatio < policy.minRiskRewardRatio - THRESHOLD_EPSILON) {
    reasons.push(
      `${ORDER_RISK_REASONS.RR_BELOW_MIN}:R:R ${riskRewardRatio.toFixed(2)} < minimum ${policy.minRiskRewardRatio}`,
    );
  }

  if (equity !== undefined) {
    if (metrics.notionalPercentOfEquity !== null && metrics.notionalPercentOfEquity > policy.maxNotionalPercent + THRESHOLD_EPSILON) {
      reasons.push(
        `${ORDER_RISK_REASONS.NOTIONAL_TOO_LARGE}:notional ${metrics.notionalPercentOfEquity.toFixed(2)}% equity > cap ${policy.maxNotionalPercent}%`,
      );
    }
    if (metrics.riskPercentOfEquity !== null && metrics.riskPercentOfEquity > policy.maxRiskPerTradePercent + THRESHOLD_EPSILON) {
      reasons.push(
        `${ORDER_RISK_REASONS.RISK_PER_TRADE_EXCEEDED}:risiko ${metrics.riskPercentOfEquity.toFixed(2)}% equity > cap ${policy.maxRiskPerTradePercent}%`,
      );
    }
  } else if (policy.requireEquity) {
    reasons.push(`${ORDER_RISK_REASONS.EQUITY_UNAVAILABLE}:equity akun tidak diketahui — sizing risiko tidak bisa diverifikasi`);
  }

  return { approved: reasons.length === 0, reasons, metrics, capsSkipped };
}

/**
 * Pesan manusiawi untuk FE/toast/log — menyertakan angka aktual supaya operator
 * tahu APA yang dilanggar, bukan cuma kode.
 */
export function describeOrderRiskRejection(evaluation: OrderRiskEvaluation): string {
  const m = evaluation.metrics;
  const detail = m
    ? ` [SL ${m.stopDistancePercent}% · TP ${m.rewardDistancePercent}% · R:R ${m.riskRewardRatio} · notional $${m.notionalUsd} · risiko $${m.riskUsd}${m.riskPercentOfEquity != null ? ` (${m.riskPercentOfEquity}% equity)` : ""} · biaya bolak-balik $${m.roundTripCostUsd}]`
    : "";
  return `Order ditolak risk gate matematis: ${evaluation.reasons.join("; ")}.${detail}`;
}