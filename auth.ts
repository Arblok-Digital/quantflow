import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface SessionRecord {
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, SessionRecord>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Persist session ke file (gitignored) biar restart server tidak logout user.
// File berisi hash token (bukan token asli) — aman kalau bocor.
const SESSION_FILE = path.join(process.cwd(), ".auth-sessions.json");
let sessionFileLoaded = false;

function loadSessionsFromDisk(): void {
  if (sessionFileLoaded) return;
  sessionFileLoaded = true;
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8")) as Record<string, SessionRecord>;
      const now = Date.now();
      for (const [hash, rec] of Object.entries(raw)) {
        if (rec && rec.expiresAt > now) sessions.set(hash, rec);
      }
    }
  } catch (err) {
    console.warn("[auth] Gagal load session file:", (err as Error).message);
  }
}

function persistSessions(): void {
  try {
    const now = Date.now();
    const out: Record<string, SessionRecord> = {};
    for (const [hash, rec] of sessions) {
      if (rec.expiresAt > now) out[hash] = rec;
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(out), { mode: 0o600 });
    try { fs.chmodSync(SESSION_FILE, 0o600); } catch {}
  } catch (err) {
    console.warn("[auth] Gagal persist session file:", (err as Error).message);
  }
}

export function getAuthPasscode(): string {
  return process.env.AUTH_PASSCODE || "paper-local";
}

export function warnIfDefaultPasscode(): void {
  if (!process.env.AUTH_PASSCODE) {
    console.warn("⚠️  AUTH_PASSCODE default in use — set env for anything that matters");
  }
}

export function createSession(): { token: string; expiresAt: number } {
  loadSessionsFromDisk();
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  sessions.set(tokenHash, { tokenHash, createdAt, expiresAt });
  persistSessions();
  return { token, expiresAt };
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function validateToken(token: string): SessionRecord | null {
  loadSessionsFromDisk();
  const h = hashToken(token);
  const rec = sessions.get(h);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    sessions.delete(h);
    persistSessions();
    return null;
  }
  return rec;
}

export function removeSessionByToken(token: string): boolean {
  loadSessionsFromDisk();
  const h = hashToken(token);
  const removed = sessions.delete(h);
  if (removed) persistSessions();
  return removed;
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
