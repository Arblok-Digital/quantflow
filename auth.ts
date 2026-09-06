import crypto from "node:crypto";

interface SessionRecord {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, SessionRecord>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function getAuthPasscode(): string {
  return process.env.AUTH_PASSCODE || "paper-local";
}

export function warnIfDefaultPasscode(): void {
  if (!process.env.AUTH_PASSCODE) {
    console.warn("⚠️  AUTH_PASSCODE default in use — set env for anything that matters");
  }
}

export function createSession(): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  sessions.set(tokenHash, { tokenHash, createdAt, expiresAt });
  return { token, expiresAt };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function validateToken(token: string): SessionRecord | null {
  const h = hashToken(token);
  const rec = sessions.get(h);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    sessions.delete(h);
    return null;
  }
  return rec;
}

export function removeSessionByToken(token: string): boolean {
  const h = hashToken(token);
  return sessions.delete(h);
}

export function removeSessionByHash(hash: string): boolean {
  return sessions.delete(hash);
}

export function clearAllSessions(): void {
  sessions.clear();
}

export function getSessionFromAuthHeader(authHeader?: string): SessionRecord | null {
  if (!authHeader || typeof authHeader !== "string") return null;
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0] !== "Bearer") return null;
  const token = parts[1];
  if (!token) return null;
  return validateToken(token);
}

// Express middleware
export function requireAuth(req: any, res: any, next: any): void {
  const auth = req.headers?.authorization as string | undefined;
  const session = getSessionFromAuthHeader(auth);
  if (!session) {
    res.status(401).json({ success: false, code: "UNAUTHORIZED", message: "Unauthorized" });
    return;
  }
  // attach session for downstream handlers if needed
  (req as any).authSession = session;
  next();
}
