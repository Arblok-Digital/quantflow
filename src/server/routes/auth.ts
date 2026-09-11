import type { Express } from "express";
import rateLimit from "express-rate-limit";
import {
  getAuthPasscode,
  createSession,
  removeSessionByToken,
  requireAuth,
  warnIfDefaultPasscode,
} from "@/auth";

const isDev = process.env.NODE_ENV !== "production";

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 100 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, code: "RATE_LIMITED", message: "Terlalu banyak request. Coba lagi nanti." });
  },
});

export function registerAuthRoutes(app: Express): void {
  warnIfDefaultPasscode();

  // SECURITY: warn if weak/default secrets detected (P0-9.9)
  if (getAuthPasscode() === "paper-local") {
    console.warn(
      "⚠️  AUTH_PASSCODE is using default 'paper-local'. Set a strong passcode via AUTH_PASSCODE env before enabling live trading.",
    );
  }
  const brokerEventSecret = process.env.BROKER_EVENT_SECRET;
  if (!brokerEventSecret || brokerEventSecret === "shared-dev-secret" || brokerEventSecret === "paper-dev-secret") {
    console.warn(
      "⚠️  BROKER_EVENT_SECRET is missing or using a known dev default ('shared-dev-secret'/'paper-dev-secret'). Generate a strong secret: node -e \"console.log(require('crypto').randomUUID())\"",
    );
  }

  app.post("/api/auth/login", loginLimiter, (req, res) => {
    const passcode = String((req.body || {}).passcode || "");
    const expected = getAuthPasscode();
    if (passcode !== expected) {
      return res.status(401).json({ success: false, message: "passcode salah" });
    }
    const { token, expiresAt } = createSession();
    res.json({ success: true, token, expiresAt });
  });

  app.post("/api/auth/logout", requireAuth, (req: any, res) => {
    const auth = req.headers.authorization as string | undefined;
    if (auth) {
      const parts = auth.trim().split(/\s+/);
      const token = parts.length === 2 ? parts[1] : "";
      if (token) removeSessionByToken(token);
    }
    res.json({ success: true, message: "logged out" });
  });

  app.get("/api/auth/session", requireAuth, (req: any, res) => {
    const session = (req as any).authSession;
    res.json({ success: true, authenticated: true, expiresAt: session?.expiresAt || null });
  });
}
