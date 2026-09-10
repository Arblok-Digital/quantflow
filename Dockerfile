# ai-trading-agent-engine — production image
# Multi-stage: build deps + app, then slim runtime.

# ---------- Build stage ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source + build
COPY . .
RUN npm run build

# ---------- Runtime stage ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runtime deps only (avoid devDeps, keep image small)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Built artifacts (dist + server bundle)
COPY --from=build /app/dist ./dist

# Source files the server needs at runtime (server.cjs is bundled by esbuild,
# but keep types/static if referenced). Server entry is dist/server.cjs.
COPY --from=build /app/server.ts ./server.ts 2>/dev/null || true

# SQLite data + vault live here (persist via volume)
ENV DB_PATH=/data/trading.db
VOLUME /data

# Default port (server uses PORT or 3000)
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || exit 1

CMD ["node", "dist/server.cjs"]