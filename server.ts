import express from "express";
import path from "path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import { httpLogger, logger } from "./src/log/logger";
import { getBrokerStatus } from "./broker";
import { getBookFilePath, initPaperBook, startBracketMonitor } from "./paperBook";
import { initGuardrails } from "./guardrails";
import { warnIfDefaultAuditSecret } from "./src/db/core";
import { acquireWriterLease, heartbeatWriterLease } from "./db";
import { getBootId } from "./src/paperbook/bootId";
import { registerAuthRoutes } from "./src/server/routes/auth";
import { registerBrokerRoutes } from "./src/server/routes/broker";
import { registerMarketRoutes } from "./src/server/routes/market";
import { registerLedgerRoutes } from "./src/server/routes/ledger";
import { registerAiRoutes } from "./src/server/routes/ai";
import { registerPipelineRoutes } from "./src/server/routes/pipeline";
import { registerReplayRoutes } from "./src/server/routes/replay";
import { registerWsProxy } from "./src/server/routes/wsProxy";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

// ---------- Security middleware ----------
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);

// CORS only if CORS_ORIGIN is set
if (process.env.CORS_ORIGIN) {
  const allowedOrigin = String(process.env.CORS_ORIGIN).trim();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    // simple allowlist: if origin matches allowedOrigin, set header
    if (origin === allowedOrigin || allowedOrigin === "*") {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
}

app.use(express.json({ limit: "5mb" }));

// Structured HTTP logging (Pino) — segera setelah body parser, sebelum routes
app.use(httpLogger);

// Rate limiters — relaxed in development.
// Polling FE 5-detik × ~10 poller paralel (StrictMode DEV menggandakan efek
// → ~2x request) mudah menembus limiter global tunggal. Solusi: bedakan
// limit endpoint PUBLIK ringan vs endpoint BERAT (auth/broker/ledger).
// Catatan: /api/market/stream (SSE, koneksi 1x tapi hidup lama) dan
// /api/health di-exempt agar tidak ikut menghabiskan kuota; 429 tidak dihitung
// (skipFailedRequests) supaya window tidak diperpanjang saat sudah jenuh.
const isDev = process.env.NODE_ENV !== "production";

const rateHandler = (_req: any, res: any) => {
  res.status(429).json({ success: false, code: "RATE_LIMITED", message: "Terlalu banyak request. Coba lagi nanti." });
};

// Endpoint publik ringan (feed pasar, klines, health): frekuensi tinggi, murah.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 6000 : 1200,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  skip: (req) => req.path === "/api/health" || req.path === "/api/market/stream",
  handler: rateHandler,
});

// Endpoint privat/berat (auth, broker, ledger, AI, replay): dibatasi wajar.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 3000 : 600,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  skip: (req) => req.path === "/api/health" || req.path === "/api/market/stream",
  handler: rateHandler,
});

// Apply apiLimiter to all /api routes (auth route has its own stricter loginLimiter)
app.use("/api/market-feed", publicLimiter);
app.use("/api/klines", publicLimiter);
app.use("/api/market/stream", publicLimiter);
app.use("/api/health", publicLimiter);
app.use("/api/", apiLimiter);

warnIfDefaultAuditSecret();

const heartbeatState = {
  startTime: Date.now(),
  lastWsTick: 0,
  lastWsError: 0,
  lastPipelineCycle: 0,
  lastOrderTs: 0,
  lastDbWrite: 0,
};

registerAuthRoutes(app);
registerBrokerRoutes(app);
registerMarketRoutes(app, heartbeatState);
registerLedgerRoutes(app);
registerAiRoutes(app);
registerPipelineRoutes(app);
registerReplayRoutes(app);
registerWsProxy(app, heartbeatState);

// --- Server & Vite Startup ---
async function startServer() {
  const viteEnabled = process.env.VITE_ENABLED !== "false";
  if (viteEnabled && process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    logger.info({ host: HOST, port: PORT }, "AI Trading Agent server listening");
    if (getBrokerStatus().mode !== "live") {
      console.log(`[AI Trading Agent] Paper mode aktif; buku posisi: ${getBookFilePath()}`);
      startBracketMonitor(3000);
    }
  });
  return server;
}

export { app };
export { startServer };

const isMain =
  typeof process !== "undefined" &&
  typeof require !== "undefined" &&
  require.main === module;

const isMainESM =
  import.meta.url === pathToFileURL(process.argv[1] || "").href;

if (isMain || isMainESM) {
  initPaperBook();
  // F5: single-writer guard
  try {
    acquireWriterLease(getBootId());
    const hb = setInterval(() => heartbeatWriterLease(getBootId()), 10_000);
    if (typeof hb.unref === "function") hb.unref();
  } catch (err: any) {
    console.error("[paperBook] " + ((err as Error)?.message || err));
    process.exit(1);
  }
  initGuardrails();
  startServer();
}
