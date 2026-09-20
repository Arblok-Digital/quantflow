import https from 'node:https';

export const RUGCHECK_BASE = process.env.RUGCHECK_API_URL || 'https://api.rugcheck.xyz/v1';

function getJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 120)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

export async function rugCheckFetcher({ prelude = true } = {}) {
  if (!prelude) return;
  const probe = await getJson(`${RUGCHECK_BASE}/stats/top`);
  return probe;
}

function mapFlags(item) {
  const flags = [];
  if (item.mintAuthority) flags.push('mint_authority');
  if (item.freezeAuthority) flags.push('freeze_authority');
  if (item.topHolder) flags.push('top_holder_high');
  if (item.balance) flags.push('balance_high');
  if (item.hasFakeVolume) flags.push('fake_volume');
  return flags;
}

export async function fetchRugCheck(mint) {
  try {
    const data = await getJson(`${RUGCHECK_BASE}/tokens/${mint}/report`);
    if (!data || data.error) return { available: false, rugRisk: null, detail: 'no-report', raw: null };
    const riskDescription = data.risks?.map((r) => r.name) || [];
    const holders = data.topHolders?.sort((a, b) => b.pct - a.pct) || [];
    const topHolderPct = holders.length ? holders[0].pct / 100 : null;
    const liquidity = data.token?.pool?.liquidity || null;
    return {
      available: true,
      rugRisk: riskDescription.length > 0,
      rugRiskDetail: riskDescription,
      topHolderPct,
      holders: data.token?.holders || holders.length || null,
      liquidityUsd: liquidity?.usd ?? null,
      mintAuthorityRevoked: !data.token?.mintAuthority,
      raw: { score: data.token?.score, flags: mapFlags(data.token || {}) },
    };
  } catch (e) {
    return { available: false, rugRisk: null, detail: `error: ${e.message}`, raw: null };
  }
}