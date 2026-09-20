import { loadKolDb, kolByWallet } from './lib/kolDb.js';
import { rpcCall, sleep } from './lib/rpc.js';

const IGNORE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

const DEFAULT_LIMIT = 30;

export async function kolScan({ limit = DEFAULT_LIMIT, maxWallets = 20, onProgress } = {}) {
  const db = loadKolDb();
  const kols = db.kols.filter((k) => k.wallet && k.wallet.length > 30);
  const wallets = kols.slice(0, maxWallets);
  const tokenToKols = new Map();
  const walletResults = [];

  for (let i = 0; i < wallets.length; i += 3) {
    const batch = wallets.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map(async (kol) => {
        try {
          const resp = await rpcCall('getTokenAccountsByOwner', [
            kol.wallet,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed' },
          ]);
          const accounts = resp?.value || [];
          const holdings = [];
          for (const acct of accounts) {
            const mint = acct.account?.data?.parsed?.info?.mint;
            const amount = parseFloat(acct.account?.data?.parsed?.info?.tokenAmount?.uiAmountString || '0');
            if (!mint || amount <= 0) continue;
            if (IGNORE_MINTS.has(mint)) continue;
            holdings.push({ mint, amount });
            if (!tokenToKols.has(mint)) tokenToKols.set(mint, new Map());
            tokenToKols.get(mint).set(kol.wallet, amount);
          }
          return {
            wallet: kol.wallet,
            handle: kol.handle || kol.name || '?',
            name: kol.name,
            verified: !!kol.verified,
            followers: kol.followers_estimate || 0,
            holdings,
            tokenCount: holdings.length,
            error: null,
          };
        } catch (e) {
          return {
            wallet: kol.wallet,
            handle: kol.handle || kol.name || '?',
            name: kol.name,
            verified: !!kol.verified,
            followers: kol.followers_estimate || 0,
            holdings: [],
            tokenCount: -1,
            error: e.message,
          };
        }
      })
    );
    walletResults.push(...batchResults);
    if (onProgress) {
      onProgress({
        scanned: walletResults.length,
        total: wallets.length,
        ok: walletResults.filter((r) => r.tokenCount >= 0).length,
      });
    }
    await sleep(900);
  }

  return { walletResults, tokenToKols, daftarKols: wallets };
}