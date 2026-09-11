const envPositiveInt = (v: string | undefined, def: number): number => {
  const n = parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const envPositiveNum = (v: string | undefined, def: number): number => {
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
};

export const TAKER_FEE_RATE = envPositiveNum(process.env.PAPER_FEE_TAKER_BPS, 4) / 10000;
export const MAKER_FEE_RATE = envPositiveNum(process.env.PAPER_FEE_MAKER_BPS, 2) / 10000;

export const INITIAL_PAPER_CASH = envPositiveInt(process.env.PAPER_INITIAL_CASH, 10000);
export const MAINTENANCE_MARGIN_RATE = 0.004;
export const MAX_LEVERAGE = envPositiveInt(process.env.PAPER_LEVERAGE_MAX, 50);
export const ORDERBOOK_LEVELS = 20;
export const EVENT_RING_SIZE = 200;
export const MARK_TTL_MS = 3000;
export const ERROR_LOG_THROTTLE_MS = 30000;

// Simulated exchange latency range (ms)
export const EXCHANGE_LATENCY_MS_MIN = 5;
export const EXCHANGE_LATENCY_MS_MAX = 50;
