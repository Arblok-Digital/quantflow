/**
 * Client-side cryptographic utilities for End-to-End Encryption (E2EE)
 * and Tamper-evident Audit Ledger Verification.
 */

// Compute SHA-256 hash using browser's native Web Crypto API
export async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Generate an HMAC-SHA256 signature using Web Crypto API
export async function hmacSha256(keyStr: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(keyStr);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  const sigArray = Array.from(new Uint8Array(sigBuffer));
  return sigArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// Encrypt sensitive API Keys with AES-GCM (256-bit)
export async function encryptApiKey(plainSecret: string, passphrase: string): Promise<{ ciphertext: string; iv: string; salt: string }> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // Derive key from passphrase using PBKDF2
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plainSecret)
  );

  return {
    ciphertext: Array.from(new Uint8Array(cipherBuffer)).map(b => b.toString(16).padStart(2, "0")).join(""),
    iv: Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join(""),
    salt: Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join(""),
  };
}

export function truncateHash(hash: string, lead = 8, trail = 6): string {
  if (!hash || hash.length <= lead + trail) return hash || "";
  return `${hash.slice(0, lead)}...${hash.slice(-trail)}`;
}
