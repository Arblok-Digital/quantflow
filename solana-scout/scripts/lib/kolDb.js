import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KOL_DB_PATH = path.join(__dirname, '..', '..', 'reference', 'kol-wallets.json');

let cache = null;

export function loadKolDb() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(KOL_DB_PATH, 'utf8'));
  cache = {
    kols: raw.kols || [],
    totalCount: raw.total_count || 0,
    verifiedCount: raw.verified_count || 0,
    updatedAt: raw.updated_at || null,
  };
  return cache;
}

export function kolByWallet() {
  const db = loadKolDb();
  const map = new Map();
  for (const kol of db.kols) {
    if (kol.wallet && kol.wallet.length > 30) map.set(kol.wallet, kol);
  }
  return map;
}

export function fixturePath(name) {
  return path.join(__dirname, '..', '..', 'fixtures', name);
}