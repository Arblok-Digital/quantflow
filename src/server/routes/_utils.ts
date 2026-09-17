// Shared utilities for route modules

export const KNOWN_QUOTES_SORTED = ["FDUSD", "BUSD", "USDC", "USDT", "BTC", "ETH", "EUR", "USD"];

export interface ParsedSymbol {
  base: string;
  quote: string;
  raw: string; // tanpa slash, untuk Binance REST/WS
  ccxt: string; // dengan slash, untuk ccxt API broker
}

export function parseMarketSymbol(input: string): ParsedSymbol {
  const s = String(input || "BTC/USDT").trim().toUpperCase();
  let base = "";
  let quote = "USDT";
  if (s.includes("/")) {
    const parts = s.split("/").filter(Boolean);
    base = parts[0] || "BTC";
    quote = parts[1] || "USDT";
  } else {
    // Cari suffix quote terpanjang yang dikenal (USDCUSDT -> base USDC, bukan U).
    let matched = "";
    for (const q of KNOWN_QUOTES_SORTED) {
      if (s.endsWith(q) && s.length > q.length && q.length > matched.length) {
        matched = q;
      }
    }
    if (matched) {
      quote = matched;
      base = s.slice(0, -matched.length);
    } else {
      base = s;
    }
  }
  base = base || "BTC";
  quote = quote || "USDT";
  return { base, quote, raw: `${base}${quote}`, ccxt: `${base}/${quote}` };
}

// Server-side SHA-256 hex (Node) — untuk blockHash pipeline (F-07/P0).
// Client memakai WebCrypto async; server butuh versi sync deterministik.
export function sha256HexNode(data: string): string {
  // Lazy-require node:crypto agar bundel client (vite) tidak ikut menarik
  // modul node — fungsi ini hanya dipanggil dari route server.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  return nodeCrypto.createHash("sha256").update(data, "utf-8").digest("hex");
}

// Helper with timeout
export async function fetchWithTimeout(url: string, timeoutMs = 3000): Promise<any> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "AITradingAgentEngine/1.0" },
    });
    clearTimeout(id);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}
