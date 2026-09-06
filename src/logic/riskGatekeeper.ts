import {
  LLMDecision,
  RiskConfig,
  RiskEvaluationResult,
  Portfolio,
} from "../types";

/**
 * Deterministic Risk Gatekeeper
 * Evaluates trade proposals against hard mathematically enforced risk constraints.
 */
export function evaluateRiskGate(
  decision: LLMDecision,
  config: RiskConfig,
  portfolio: Portfolio,
  currentPrice: number
): RiskEvaluationResult {
  // 1. Emergency stop active
  if (config.isEmergencyStopActive) {
    return {
      approved: false,
      maxDrawdownPassed: false,
      positionSizePassed: false,
      riskRewardRatio: 0,
      notes: "Emergency Kill-Switch diaktifkan oleh operator. Seluruh eksekusi order diblokir.",
    };
  }

  // 2. Max Drawdown limit breached
  const isDrawdownBreached = portfolio.currentDrawdownPercent >= config.maxDrawdownLimit;
  if (isDrawdownBreached) {
    return {
      approved: false,
      maxDrawdownPassed: false,
      positionSizePassed: true,
      riskRewardRatio: 0,
      notes: `Batas Max Drawdown (${config.maxDrawdownLimit}%) terlampaui (saat ini: ${portfolio.currentDrawdownPercent.toFixed(1)}%). Trading dihentikan otomatis.`,
    };
  }

  // 3. If action is HOLD, no risk check needed
  if (decision.action === "HOLD") {
    return {
      approved: true,
      maxDrawdownPassed: true,
      positionSizePassed: true,
      riskRewardRatio: 1,
      notes: "Action HOLD: Tidak ada alokasi modal baru.",
    };
  }

  // 4. Position Size validation
  const positionSizePassed = decision.positionSizePercent <= config.maxPositionPercent;

  // 5. Risk-Reward Ratio check
  const riskAmount = Math.abs(currentPrice - decision.stopLoss);
  const rewardAmount = Math.abs(decision.takeProfit - currentPrice);
  const calculatedRR = riskAmount > 0 ? Number((rewardAmount / riskAmount).toFixed(2)) : 0;
  const rrPassed = calculatedRR >= (config.minRiskRewardRatio || 1.5);

  // 6. Confidence threshold check
  const confidencePassed = decision.confidence >= config.minConfidenceThreshold;

  const approved = positionSizePassed && rrPassed && confidencePassed;

  let notes = "Lolos seluruh aturan pre-trade risk filter.";
  if (!positionSizePassed) {
    notes = `Ukuran posisi (${decision.positionSizePercent}%) melampaui batas toleransi (${config.maxPositionPercent}%).`;
  } else if (!confidencePassed) {
    notes = `Confidence score model (${decision.confidence}%) di bawah batas minimal (${config.minConfidenceThreshold}%).`;
  } else if (!rrPassed) {
    notes = `Rasio Risk:Reward (${calculatedRR}:1) di bawah standar minimum (${config.minRiskRewardRatio || 1.5}:1).`;
  }

  return {
    approved,
    maxDrawdownPassed: true,
    positionSizePassed,
    riskRewardRatio: calculatedRR,
    notes,
  };
}
