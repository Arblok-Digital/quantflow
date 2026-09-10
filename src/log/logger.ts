/**
 * src/log/logger.ts — structured logging (Pino) + HTTP request logger.
 * Level dari env LOG_LEVEL (default "info"). Masking untuk secret fields.
 */
import pino from "pino";
import { pinoHttp } from "pino-http";

// Fields yang wajib di-mask di log apa pun (request body, params, response).
const SENSITIVE_KEYS = [
  "apiKey", "apiSecret", "secret", "token", "passcode",
  "BROKER_API_KEY", "BROKER_API_SECRET", "AUTH_PASSCODE",
  "BROKER_EVENT_SECRET", "AUDIT_HMAC_SECRET", "GEMINI_API_KEY",
  "authorization", "cookie",
];

function maskValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const k = String(key).toLowerCase();
  if (SENSITIVE_KEYS.some((s) => k.includes(s.toLowerCase()))) {
    return "[REDACTED]";
  }
  return value;
}

function redactDeep(input: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(input)) return input.map((v) => redactDeep(v, seen));
  if (input && typeof input === "object") {
    if (seen.has(input)) return "[CIRCULAR]";
    seen.add(input);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = maskValue(k, v) && maskValue(k, v) !== v ? maskValue(k, v) : redactDeep(v, seen);
    }
    return out;
  }
  return input;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: undefined, // jangan log pid/hostname default (hemat bytes)
  redact: {
    paths: [
      "apiKey", "apiSecret", "secret", "token", "passcode",
      "BROKER_API_KEY", "BROKER_API_SECRET", "AUTH_PASSCODE",
      "BROKER_EVENT_SECRET", "AUDIT_HMAC_SECRET", "GEMINI_API_KEY",
      "req.headers.authorization", "req.headers.cookie",
    ],
    censor: "[REDACTED]",
  },
  serializers: {
    req: (req: any) => ({
      method: req.method,
      url: req.url,
      ip: req.ip,
    }),
    res: (res: any) => ({
      statusCode: res.statusCode,
    }),
  },
  // Transport: pretty di dev, JSON di production
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
});

export const httpLogger = pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === "/api/health",
  },
  serializers: {
    req: (req: any) => ({
      method: req.method,
      url: req.url,
      ip: req.ip,
    }),
    res: (res: any) => ({
      statusCode: res.statusCode,
    }),
  },
  customProps: (req: any) => ({ route: req.route?.path || req.url }),
});

// Helper: buat child logger per-domain dengan redaction bawaan.
export function domainLogger(domain: string) {
  return logger.child({ domain });
}

export { redactDeep };
export default logger;