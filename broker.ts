import * as ccxt from "ccxt";
import fs from "fs";
import path from "path";

// ================= BROKER PROVIDER (ccxt) =================
// Satu provider untuk 100+ exchange lewat ccxt.
// Default: TRADING_MODE=paper (dry-run, tidak pernah sentuh uang real).
// Live trading HANYA aktif kalau TRADING_MODE=live DAN credential terisi.

export type BrokerMode = "paper" | "live";
type CredentialSource = "none" | "env" | "vault";

interface BrokerOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  price?: number;
  leverage?: number;
}

interface BrokerSecrets {
  exchange?: string;
  apiKey?: string;
  apiSecret?: string;
  testnet?: boolean;
}

const SECRETS_FILE = path.join(process.cwd(), ".broker-secrets.json");

// ------------------------------------------------------------------
// Credential resolution: lingkungan(.env) > vault lokal (.broker-secrets.json)
// ------------------------------------------------------------------
function loadSecretsFile(): BrokerSecrets {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
      if (parsed && typeof parsed === "object") return parsed as BrokerSecrets;
    }
  } catch (err) {
    console.warn("Gagal membaca .broker-secrets.json:", err);
  }
  return {};
}

function effectiveBrokerConfig() {
  const sealed = loadSecretsFile();
  return {
    exchangeId: process.env.BROKER_EXCHANGE || sealed.exchange || "binance",
    apiKey: process.env.BROKER_API_KEY || sealed.apiKey || "",
    apiSecret: process.env.BROKER_API_SECRET || sealed.apiSecret || "",
    testnet: process.env.BROKER_TESTNET === "true" ? true : Boolean(sealed.testnet),
  };
}

export function getCredentialSource(): CredentialSource {
  const envKey = process.env.BROKER_API_KEY;
  const envSecret = process.env.BROKER_API_SECRET;
  if (envKey && envSecret) return "env";
  const sealed = loadSecretsFile();
  if (sealed.apiKey && sealed.apiSecret) return "vault";
  return "none";
}

export function hasBrokerCredentials(): boolean {
  return getCredentialSource() !== "none";
}

function resolveExchangeId(): string {
  return effectiveBrokerConfig().exchangeId;
}

function makeExchange(): ccxt.Exchange {
  const cfg = effectiveBrokerConfig();
  const exchangeClass = (ccxt as any)[cfg.exchangeId];
  if (!exchangeClass) {
    throw new Error(`Exchange "${cfg.exchangeId}" tidak dikenal oleh ccxt.`);
  }
  const exchange: ccxt.Exchange = new exchangeClass({
    apiKey: cfg.apiKey || undefined,
    secret: cfg.apiSecret || undefined,
    enableRateLimit: true,
    timeout: 8000,
  });
  if (cfg.testnet && typeof (exchange as any).setSandboxMode === "function") {
    (exchange as any).setSandboxMode(true);
  }
  return exchange;
}

export function getBrokerStatus() {
  const source = getCredentialSource();
  return {
    mode: process.env.TRADING_MODE === "live" ? ("live" as BrokerMode) : ("paper" as BrokerMode),
    exchangeId: resolveExchangeId(),
    testnet: effectiveBrokerConfig().testnet,
    credentialsConfigured: source !== "none",
    credentialSource: source,
    canPlaceLiveOrders: process.env.TRADING_MODE === "live" && source !== "none",
    secretsFile: SECRETS_FILE,
  };
}

// ------------------------------------------------------------------
// Credential management (vault lokal)
// ------------------------------------------------------------------
export async function saveBrokerCredentials(input: BrokerSecrets): Promise<void> {
  const sealed = { ...loadSecretsFile(), ...input };
  await fs.promises.mkdir(path.dirname(SECRETS_FILE), { recursive: true });
  await fs.promises.writeFile(SECRETS_FILE, JSON.stringify(sealed, null, 2), { mode: 0o600 });
}

export async function clearBrokerCredentials(): Promise<void> {
  if (fs.existsSync(SECRETS_FILE)) {
    await fs.promises.rm(SECRETS_FILE, { force: true });
  }
}

// ------------------------------------------------------------------
// Connection test (READ-ONLY: fetchBalance saja, tidak pernah order)
// ------------------------------------------------------------------
export async function testBrokerConnection() {
  const source = getCredentialSource();
  const cfg = effectiveBrokerConfig();
  if (source === "none" || !cfg.apiKey || !cfg.apiSecret) {
    throw new Error("Credential belum diisi. Simpan API key/secret dulu.");
  }
  const exchange = makeExchange();
  await exchange.loadMarkets?.();
  const balance = await exchange.fetchBalance();
  const totals = Object.entries(balance.total || {})
    .filter(([, v]) => Number(v) > 0)
    .map(([currency, v]) => ({ currency, total: Number(v) }))
    .sort((a, b) => b.total - a.total);
  return {
    ok: true,
    exchangeId: cfg.exchangeId,
    testnet: exchange.urls?.test || cfg.testnet,
    currencies: totals,
    latencyMs: exchange.lastResponseHeaders ? 0 : 0,
    timestamp: Date.now(),
  };
}

function assertLiveAllowed() {
  if (process.env.TRADING_MODE !== "live") {
    throw new Error(
      "Broker sedang dalam mode PAPER (dry-run). Set TRADING_MODE=live dan isi API key/secret untuk trading real."
    );
  }
  if (!hasBrokerCredentials()) {
    throw new Error("API Key / Secret belum dikonfigurasi.");
  }
}

// --- 1. Market Data (public, tanpa key) ---
export async function fetchCcxtTicker(symbol: string) {
  const exchange = makeExchange();
  const ticker = await exchange.fetchTicker(symbol);
  return {
    symbol: ticker.symbol,
    last: ticker.last,
    bid: ticker.bid,
    ask: ticker.ask,
    high: ticker.high,
    low: ticker.low,
    percentage: ticker.percentage,
    quoteVolume: ticker.quoteVolume,
    timestamp: ticker.timestamp,
    provider: exchange.id,
  };
}

export async function fetchCcxtOrderBook(symbol: string, limit = 12) {
  const exchange = makeExchange();
  const book = await exchange.fetchOrderBook(symbol, limit);
  return {
    symbol: book.symbol,
    bids: book.bids ? book.bids.slice(0, limit) : [],
    asks: book.asks ? book.asks.slice(0, limit) : [],
    timestamp: book.timestamp,
    provider: exchange.id,
  };
}

export async function fetchCcxtOHLCV(symbol: string, timeframe: string, limit = 50) {
  const exchange = makeExchange();
  const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  return raw.map((c) => ({
    timestamp: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
  }));
}

// --- 2. Balance ---
interface NormalizedBalance {
  currency: string;
  free: number;
  used: number;
  total: number;
}

export async function fetchBrokerBalance(): Promise<NormalizedBalance[]> {
  if (process.env.TRADING_MODE !== "live") {
    return [
      { currency: "USDT", free: 9973.5, used: 26.5, total: 10000 },
      { currency: "BTC", free: 0.0032, used: 0, total: 0.0032 },
    ];
  }
  assertLiveAllowed();
  const exchange = makeExchange();
  const balance = await exchange.fetchBalance();
  return Object.entries(balance.total || {})
    .filter(([, total]) => Number(total) > 0)
    .map(([currency, total]) => ({
      currency,
      free: Number(balance.free?.[currency] || 0),
      used: Number(balance.used?.[currency] || 0),
      total: Number(total || 0),
    }))
    .sort((a, b) => b.total - a.total);
}

// --- 3. Order Execution (paper simulation di atas harga CCXT real) ---
const DEFAULT_TAKER_FEE = 0.001; // 0.1% asumsi spot

export async function placeBrokerOrder(req: BrokerOrderRequest) {
  const symbol = String(req.symbol || "BTC/USDT").toUpperCase();
  const normalizedSymbol = symbol.includes("/") ? symbol.split("/").slice(0, 2).join("/") : `${symbol.replace("USDT", "")}/USDT`;
  const side = req.side === "sell" ? "sell" : "buy";
  const type = req.type === "limit" ? "limit" : "market";
  const amount = Number(req.amount);
  if (!isFinite(amount) || amount <= 0) {
    throw new Error("amount harus angka positif.");
  }

  if (process.env.TRADING_MODE !== "live") {
    const exchange = makeExchange();
    const ticker = await exchange.fetchTicker(normalizedSymbol);
    const markPrice = ticker.last || ticker.close || 0;
    if (!markPrice) throw new Error(`Tidak ada harga untuk ${normalizedSymbol}.`);

    let fillPrice: number;
    if (type === "limit" && Number(req.price) > 0) {
      fillPrice = Number(req.price);
    } else {
      const spreadBps = 0.05;
      if (side === "buy") {
        fillPrice = ticker.ask ? (ticker.ask as number) : markPrice * (1 + spreadBps / 10000);
      } else {
        fillPrice = ticker.bid ? (ticker.bid as number) : markPrice * (1 - spreadBps / 10000);
      }
    }

    const cost = fillPrice * amount;
    const fee = cost * DEFAULT_TAKER_FEE;
    const leverage = req.leverage && req.leverage > 0 ? Math.min(50, req.leverage) : 1;
    const margin = cost / leverage;

    return {
      id: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      simulated: true,
      mode: "paper",
      symbol: normalizedSymbol,
      side,
      type,
      amount,
      price: Number(fillPrice.toFixed(2)),
      cost: Number(cost.toFixed(2)),
      fee: Number(fee.toFixed(4)),
      leverage,
      marginRequired: Number(margin.toFixed(2)),
      feeAsset: "USDT",
      status: "filled",
      markPrice: Number(markPrice.toFixed(2)),
      timestamp: Date.now(),
      provider: `ccxt:${resolveExchangeId()}`,
    };
  }

  // LIVE PATH - hanya jika TRADING_MODE=live + credential valid
  assertLiveAllowed();
  const exchange = makeExchange();
  await exchange.loadMarkets();
  const order = await exchange.createOrder(normalizedSymbol, type, side, amount, type === "limit" ? Number(req.price) : undefined, {
    ...(req.leverage && req.leverage > 1 ? { leverage: req.leverage } : {}),
  });
  return {
    id: order.id,
    simulated: false,
    mode: "live",
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    amount: order.amount,
    price: order.average || order.price,
    cost: order.cost,
    fee: order.fee,
    status: order.status,
    timestamp: order.timestamp || Date.now(),
    provider: `ccxt:${resolveExchangeId()}`,
  };
}