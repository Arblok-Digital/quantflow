import * as ccxt from "ccxt";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";

// ================= BROKER PROVIDER (ccxt) =================
// Satu provider untuk 100+ exchange lewat ccxt.
// Default: TRADING_MODE=paper (dry-run, tidak pernah sentuh uang real).
// Live trading HANYA aktif kalau TRADING_MODE=live DAN credential terisi DAN liveArmed=true.

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
  liveArmed?: boolean;
}

interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

interface VaultFileRaw {
  exchange?: string;
  testnet?: boolean;
  liveArmed?: boolean;
  apiKey?: string | EncryptedBlob;
  apiSecret?: string | EncryptedBlob;
}

const SECRETS_FILE = path.join(process.cwd(), ".broker-secrets.json");
const VAULT_KEY_FILE = path.join(process.cwd(), ".broker-vault-key");

// ------------------------------------------------------------------
// Vault encryption at rest — AES-256-GCM
// ------------------------------------------------------------------
function isEncryptedBlob(v: unknown): v is EncryptedBlob {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as any).iv === "string" &&
    typeof (v as any).tag === "string" &&
    typeof (v as any).data === "string"
  );
}

function getOrCreateVaultKey(): string {
  try {
    if (fs.existsSync(VAULT_KEY_FILE)) {
      const existing = fs.readFileSync(VAULT_KEY_FILE, "utf-8").trim();
      if (/^[0-9a-f]{64}$/i.test(existing)) return existing.toLowerCase();
      // regenerate if malformed
      console.warn("[vault] Vault key file malformed, regenerating.");
    }
  } catch (err) {
    console.warn("[vault] Gagal membaca .broker-vault-key:", err);
  }
  const keyHex = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(VAULT_KEY_FILE, keyHex, { mode: 0o600 });
    try {
      fs.chmodSync(VAULT_KEY_FILE, 0o600);
    } catch {}
    console.log("[vault] Generated new vault key at .broker-vault-key (chmod 600 best-effort).");
  } catch (err) {
    console.warn("[vault] Gagal menulis .broker-vault-key:", err);
  }
  return keyHex;
}

function getVaultKeyIfExists(): string | null {
  try {
    if (!fs.existsSync(VAULT_KEY_FILE)) return null;
    const hex = fs.readFileSync(VAULT_KEY_FILE, "utf-8").trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      console.warn("[vault] Vault key file present but not 64 hex chars; treating as missing.");
      return null;
    }
    return hex.toLowerCase();
  } catch (err) {
    console.warn("[vault] Gagal membaca .broker-vault-key:", err);
    return null;
  }
}

function encryptField(plaintext: string, keyHex: string): EncryptedBlob {
  const key = Buffer.from(keyHex, "hex");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: enc.toString("hex"),
  };
}

function decryptField(blob: EncryptedBlob, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(blob.iv, "hex");
  const tag = Buffer.from(blob.tag, "hex");
  const data = Buffer.from(blob.data, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString("utf8");
}

// ------------------------------------------------------------------
// Exchange instance cache: reuse one ccxt instance per (exchange, testnet)
// pair instead of creating a new instance on every call.
// ------------------------------------------------------------------
const exchangeCache = new Map<string, ccxt.Exchange>();
const marketsLoadedInstances = new WeakSet<object>();

function exchangeCacheKey(cfg: { exchangeId: string; testnet: boolean }): string {
  return `${cfg.exchangeId}:${cfg.testnet ? "testnet" : "mainnet"}`;
}

export function getExchange(): ccxt.Exchange {
  const cfg = effectiveBrokerConfig();
  const key = exchangeCacheKey(cfg);
  let exchange = exchangeCache.get(key);
  if (!exchange) {
    exchange = makeExchange();
    exchangeCache.set(key, exchange);
  }
  return exchange;
}

export async function ensureMarketsLoaded(exchange: ccxt.Exchange): Promise<void> {
  if (marketsLoadedInstances.has(exchange)) return;
  await exchange.loadMarkets?.();
  marketsLoadedInstances.add(exchange);
}

export function clearExchangeCache(): void {
  exchangeCache.clear();
}

// ------------------------------------------------------------------
// Vault file helpers (raw vs decrypted)
// ------------------------------------------------------------------
function loadSecretsFileRaw(): VaultFileRaw {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8"));
      if (parsed && typeof parsed === "object") return parsed as VaultFileRaw;
    }
  } catch (err) {
    console.warn("Gagal membaca .broker-secrets.json:", err);
  }
  return {};
}

function loadSecretsFile(): BrokerSecrets {
  const raw = loadSecretsFileRaw();
  if (!raw || typeof raw !== "object") return {};

  const hasEncryptedApiKey = isEncryptedBlob((raw as any).apiKey);
  const hasEncryptedApiSecret = isEncryptedBlob((raw as any).apiSecret);
  const hasPlainApiKey = typeof (raw as any).apiKey === "string" && (raw as any).apiKey.length > 0;
  const hasPlainApiSecret = typeof (raw as any).apiSecret === "string" && (raw as any).apiSecret.length > 0;
  const isEncrypted = hasEncryptedApiKey || hasEncryptedApiSecret;
  const isPlain = hasPlainApiKey || hasPlainApiSecret;

  // Plaintext back-compat warning
  if (isPlain && !isEncrypted) {
    console.warn("[vault] Plaintext vault detected — will re-encrypt on next save.");
    return {
      exchange: raw.exchange,
      testnet: raw.testnet,
      liveArmed: raw.liveArmed,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
      apiSecret: typeof raw.apiSecret === "string" ? raw.apiSecret : undefined,
    };
  }

  if (isEncrypted) {
    const keyHex = getVaultKeyIfExists();
    if (!keyHex) {
      console.error("vault key missing, cannot decrypt");
      console.warn("[vault] Vault is encrypted but .broker-vault-key is missing — treating credentials as unconfigured.");
      return {
        exchange: raw.exchange,
        testnet: raw.testnet,
        liveArmed: raw.liveArmed,
        // apiKey/apiSecret omitted intentionally (cannot decrypt)
      };
    }
    try {
      const out: BrokerSecrets = {
        exchange: raw.exchange,
        testnet: raw.testnet,
        liveArmed: raw.liveArmed,
      };
      if (isEncryptedBlob(raw.apiKey)) {
        out.apiKey = decryptField(raw.apiKey as EncryptedBlob, keyHex);
      } else if (typeof raw.apiKey === "string") {
        out.apiKey = raw.apiKey;
      }
      if (isEncryptedBlob(raw.apiSecret)) {
        out.apiSecret = decryptField(raw.apiSecret as EncryptedBlob, keyHex);
      } else if (typeof raw.apiSecret === "string") {
        out.apiSecret = raw.apiSecret;
      }
      return out;
    } catch (err) {
      console.error("vault key missing, cannot decrypt");
      console.warn(`[vault] Gagal decrypt .broker-secrets.json: ${(err as Error).message}`);
      return {
        exchange: raw.exchange,
        testnet: raw.testnet,
        liveArmed: raw.liveArmed,
      };
    }
  }

  // No credentials stored
  return {
    exchange: raw.exchange,
    testnet: raw.testnet,
    liveArmed: raw.liveArmed,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    apiSecret: typeof raw.apiSecret === "string" ? raw.apiSecret : undefined,
  };
}

export function isVaultEncrypted(): boolean {
  const raw = loadSecretsFileRaw();
  return isEncryptedBlob((raw as any).apiKey) || isEncryptedBlob((raw as any).apiSecret);
}

export function getLiveArmed(): boolean {
  const raw = loadSecretsFileRaw();
  return Boolean(raw.liveArmed);
}

export function getVaultKeyFilePath(): string {
  return VAULT_KEY_FILE;
}

export function getSecretsFilePath(): string {
  return SECRETS_FILE;
}

function effectiveBrokerConfig() {
  const sealed = loadSecretsFile();
  return {
    exchangeId: process.env.BROKER_EXCHANGE || sealed.exchange || "binance",
    apiKey: process.env.BROKER_API_KEY || sealed.apiKey || "",
    apiSecret: process.env.BROKER_API_SECRET || sealed.apiSecret || "",
    testnet: process.env.BROKER_TESTNET === "true" ? true : Boolean(sealed.testnet),
    liveArmed: Boolean(sealed.liveArmed),
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
    timeout: Number(process.env.CCXT_TIMEOUT_MS) || 60000,
  });
  if (cfg.testnet && typeof (exchange as any).setSandboxMode === "function") {
    (exchange as any).setSandboxMode(true);
  }
  return exchange;
}

export function getBrokerStatus() {
  const source = getCredentialSource();
  const cfg = effectiveBrokerConfig();
  return {
    mode: process.env.TRADING_MODE === "live" ? ("live" as BrokerMode) : ("paper" as BrokerMode),
    exchangeId: resolveExchangeId(),
    testnet: cfg.testnet,
    credentialsConfigured: source !== "none",
    credentialSource: source,
    canPlaceLiveOrders: process.env.TRADING_MODE === "live" && source !== "none" && cfg.liveArmed === true,
    liveArmed: cfg.liveArmed,
    armedForLive: cfg.liveArmed,
    secretsFile: SECRETS_FILE,
    vaultKeyFile: VAULT_KEY_FILE,
    encrypted: isVaultEncrypted(),
  };
}

// ------------------------------------------------------------------
// Credential management (vault lokal) — encrypted at rest
// ------------------------------------------------------------------
export async function saveBrokerCredentials(input: BrokerSecrets): Promise<void> {
  const raw = loadSecretsFileRaw();
  // Merge non-secret fields
  const nextRaw: VaultFileRaw = { ...raw };
  if (input.exchange !== undefined) nextRaw.exchange = input.exchange;
  if (input.testnet !== undefined) nextRaw.testnet = input.testnet;
  if (input.liveArmed !== undefined) nextRaw.liveArmed = input.liveArmed;

  // Ensure key exists if we are storing secrets
  const willStoreKey = input.apiKey !== undefined || input.apiSecret !== undefined;
  let keyHex: string | null = null;
  if (willStoreKey) {
    keyHex = getOrCreateVaultKey();
  } else if (isVaultEncrypted()) {
    keyHex = getVaultKeyIfExists();
    if (!keyHex) {
      console.error("vault key missing, cannot decrypt");
      throw new Error("Vault key missing, cannot re-encrypt vault. Restore .broker-vault-key or clear vault.");
    }
  }

  // Encrypt apiKey / apiSecret if provided; otherwise keep existing encrypted blob as-is
  if (input.apiKey !== undefined) {
    if (!keyHex) keyHex = getOrCreateVaultKey();
    nextRaw.apiKey = encryptField(String(input.apiKey), keyHex);
  } else if (isEncryptedBlob((raw as any).apiKey)) {
    // preserve existing encrypted
    nextRaw.apiKey = (raw as any).apiKey;
  } else if (typeof (raw as any).apiKey === "string" && (raw as any).apiKey) {
    // plaintext legacy -> encrypt on save if we have a key
    if (keyHex) {
      nextRaw.apiKey = encryptField(String((raw as any).apiKey), keyHex);
    }
  }

  if (input.apiSecret !== undefined) {
    if (!keyHex) keyHex = getOrCreateVaultKey();
    nextRaw.apiSecret = encryptField(String(input.apiSecret), keyHex);
  } else if (isEncryptedBlob((raw as any).apiSecret)) {
    nextRaw.apiSecret = (raw as any).apiSecret;
  } else if (typeof (raw as any).apiSecret === "string" && (raw as any).apiSecret) {
    if (keyHex) {
      nextRaw.apiSecret = encryptField(String((raw as any).apiSecret), keyHex);
    }
  }

  // If raw was plaintext and we now have keyHex but input didn't include new keys, ensure we migrate
  // Already handled above: plaintext existing will be re-encrypted above.

  await fs.promises.mkdir(path.dirname(SECRETS_FILE), { recursive: true });
  await fs.promises.writeFile(SECRETS_FILE, JSON.stringify(nextRaw, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch {}
  clearExchangeCache();
}

export async function clearBrokerCredentials(): Promise<void> {
  if (fs.existsSync(SECRETS_FILE)) {
    await fs.promises.rm(SECRETS_FILE, { force: true });
  }
  clearExchangeCache();
}

export async function setLiveArmed(armed: boolean): Promise<void> {
  if (process.env.TRADING_MODE !== "live") {
    throw Object.assign(new Error("ARM_REQUIRES_LIVE_AND_CREDENTIALS: TRADING_MODE must be 'live' and credentials configured to arm."), { code: "ARM_REQUIRES_LIVE_AND_CREDENTIALS" });
  }
  if (!hasBrokerCredentials()) {
    throw Object.assign(new Error("ARM_REQUIRES_LIVE_AND_CREDENTIALS: credentials not configured."), { code: "ARM_REQUIRES_LIVE_AND_CREDENTIALS" });
  }
  const raw = loadSecretsFileRaw();
  // If no vault file exists yet but credentials are from env, we still need to persist liveArmed
  // Ensure the vault file exists (create with current exchange/testnet + armed flag)
  // If we have encrypted creds, preserve them; if env creds, vault may be empty aside from armed flag.
  const nextRaw: VaultFileRaw = { ...raw, liveArmed: Boolean(armed) };
  // If vault was empty and we are arming, we may want to ensure key/encryption handling isn't needed
  // But if we have encrypted blobs, keep them; if plaintext, migration will happen on next saveCredentials.
  await fs.promises.mkdir(path.dirname(SECRETS_FILE), { recursive: true });
  await fs.promises.writeFile(SECRETS_FILE, JSON.stringify(nextRaw, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch {}
  if (armed) {
    console.log("\n" + "=".repeat(60));
    console.log("🔴 LIVE TRADING ARMED — orders will go to the exchange");
    console.log("=".repeat(60) + "\n");
  } else {
    console.log("[vault] Live trading disarmed.");
  }
  clearExchangeCache();
}

export function maskApiKey(apiKey: string | undefined): string {
  if (!apiKey || apiKey.trim().length === 0) return "***";
  const k = apiKey.trim();
  if (k.length <= 4) return "***";
  return `${k.slice(0, 2)}***${k.slice(-2)}`;
}

export function getVaultCredentialsStatus() {
  const source = getCredentialSource();
  const sealed = loadSecretsFile();
  const raw = loadSecretsFileRaw();
  const encrypted = isVaultEncrypted();
  // For masked key, prefer decrypted value if available, else try to infer from raw if plaintext
  let apiKeyForMask: string | undefined = sealed.apiKey;
  if (!apiKeyForMask && typeof (raw as any).apiKey === "string") apiKeyForMask = (raw as any).apiKey;
  const exchange = process.env.BROKER_EXCHANGE || raw.exchange || "binance";
  const testnet = process.env.BROKER_TESTNET === "true" ? true : Boolean(raw.testnet);
  const liveArmed = Boolean(raw.liveArmed);
  return {
    success: true,
    configured: source !== "none",
    source,
    exchange,
    maskedApiKey: maskApiKey(apiKeyForMask),
    testnet,
    liveArmed,
    armedForLive: liveArmed,
    encrypted,
  };
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
  const exchange = getExchange();
  await ensureMarketsLoaded(exchange);
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
  if (!getLiveArmed()) {
    const err: any = new Error("Live trading not armed. Call POST /api/broker/arm to arm live trading.");
    err.code = "LIVE_NOT_ARMED";
    throw err;
  }
}

// --- 1. Market Data (public, tanpa key) ---
export async function fetchCcxtTicker(symbol: string) {
  const exchange = getExchange();
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
  const exchange = getExchange();
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
  const exchange = getExchange();
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
    // Honest paper accounting — derive from paperBook SQLite state, not hardcoded
    const { getPaperAccount } = await import("./paperBook.js");
    const acct = getPaperAccount();
    return [
      {
        currency: "USDT",
        free: acct.cash,
        used: acct.marginLocked,
        total: Number((acct.cash + acct.marginLocked).toFixed(2)),
      },
    ];
  }
  assertLiveAllowed();
  const exchange = getExchange();
  await ensureMarketsLoaded(exchange);
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
    const exchange = getExchange();
    await ensureMarketsLoaded(exchange);
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

  // LIVE PATH - hanya jika TRADING_MODE=live + credential valid + liveArmed
  assertLiveAllowed();
  const exchange = getExchange();
  await ensureMarketsLoaded(exchange);
  const order = await exchange.createOrder(normalizedSymbol, type, side, amount, type === "limit" ? Number(req.price) : undefined, {
    ...(req.leverage && req.leverage > 1 ? { leverage: req.leverage } : {}),
  });
  // Record live realized? Not yet, would need fills.
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
