export const SCALE = 200;

export const GATES = {
  RUG_SIGNAL: {
    label: 'RugCheck bermasalah',
    weight: -100,
    hardFail: true,
  },
  NO_LIQUIDITY: {
    label: 'Likuiditas terlalu tipis (< $1k)',
    weight: -60,
    hardFail: true,
  },
  TOP_HOLDER_TOO_BIG: {
    label: 'Top holder > 40% supply (dev bisa dump)',
    weight: -80,
    hardFail: true,
  },
  MINT_AUTHORITY_ACTIVE: {
    label: 'Mint authority belum di-revoke',
    weight: -40,
    hardFail: true,
  },
  MID_PUMP_EXIT: {
    label: 'Sudah pump masif (harga +150%/24j, volume habis) — exit liquidity',
    weight: -100,
    hardFail: true,
  },
};

export const CREDITS = {
  KOL_CONCURRENCY: { label: '≥2 KOL akumulasi (exclusive)', weight: 40 },
  KOL_CONCURRENCY_3PLUS: { label: '≥3 KOL akumulasi (exclusive)', weight: 70 },
  VERIFIED_KOL: { label: 'KOL terverifikasi ikut pegang (premium)', weight: 90 },
  CREDIBLE_KOL_THRESHOLD: { label: 'KOL follower > 500k', weight: 20 },
  NEWBORN_WINDOW: { label: 'Usia ≤ 6 jam (spike fresh)', weight: 25 },
  MATURED_NEWBORN: { label: 'Usia 6–24 jam', weight: 15 },
  OLD_NEWBORN: { label: 'Usia 24–72 jam', weight: 5 },
  HOLDERS_100_PLUS: { label: 'Holder ≥ 100', weight: 15 },
  LOW_TOP_HOLDER: { label: 'Top holder < 10% (desentralisasi)', weight: 15 },
  LIQ_HEALTHY: { label: 'Likuiditas sehat ≥ $10k', weight: 15 },
};

export function classify(score) {
  if (score >= 150) return { tier: 'ALPHA', tierLabel: 'Akumulasi kuat', color: 'alpha' };
  if (score >= 110) return { tier: 'BUY', tierLabel: 'Akumulasi', color: 'buy' };
  if (score >= 70) return { tier: 'WATCH', tierLabel: 'Pantau', color: 'watch' };
  return { tier: 'SKIP', tierLabel: 'Lewati', color: 'skip' };
}

export function evaluate({ kol, fundamentals, ageHours, market }) {
  const checks = [];
  let hardFailed = false;
  let hardFailReason = null;
  let autoAvoid = false;
  const failedGates = [];

  const gate = (key, ok, detail) => {
    const g = GATES[key];
    const applied = !ok;
    checks.push({ kind: 'gate', key, label: g.label, weight: g.weight, applied, detail });
    if (applied) {
      hardFailed = true;
      hardFailReason = hardFailReason || g.label;
      failedGates.push(g.label);
      if (key === 'MID_PUMP_EXIT') autoAvoid = true;
    }
  };

  const credit = (key, ok, detail) => {
    const c = CREDITS[key];
    const applied = ok;
    checks.push({ kind: 'credit', key, label: c.label, weight: c.weight, applied, detail });
  };

  const f = fundamentals || {};
  const k = kol || {};
  const m = market || {};
  // Fundamentals dianggap tersedia bila: flag available=true, atau rugRisk sudah
  // eksplisit boolean (input direct dari test/pipeline tanpa wrapper `available`).
  const hasFundamentals = f.available === true || f.rugRisk === false || f.rugRisk === true;

  // Data fundamental TIDAK tersedia: jangan klaim sehat, jangan pula klaim gagal.
  // Token tanpa rugcheck jelas = jangan dibeli (RUG_SIGNAL netral ke SKIP).
  if (!hasFundamentals) {
    hardFailed = true;
    hardFailReason = hardFailReason || 'Data RugCheck tidak tersedia — tidak boleh dibeli';
    failedGates.push('Data RugCheck tidak tersedia');
    checks.push({ kind: 'gate', key: 'RUG_SIGNAL', label: GATES.RUG_SIGNAL.label, weight: GATES.RUG_SIGNAL.weight, applied: true, detail: 'data tidak tersedia' });
  } else {
    gate('RUG_SIGNAL', f.rugRisk === false, f.rugRiskDetail ? f.rugRiskDetail.map(String).join('; ') : 'no signal');
    gate('NO_LIQUIDITY', (f.liquidityUsd ?? 0) >= 1000, `liq $${fmtUsd(f.liquidityUsd)}`);
    gate('TOP_HOLDER_TOO_BIG', (f.topHolderPct ?? 0) <= 0.4, `topHolder ${fmtPct(f.topHolderPct)}`);
    gate('MINT_AUTHORITY_ACTIVE', f.mintAuthorityRevoked === true, f.mintAuthorityRevoked === false ? 'masih aktif' : 'data tidak ada');
  }

  // Gate harga: hindari jadi exit liquidity. Aktif hanya saat data market ada
  // (DexScreener pair). Harga vs entry KOL = fasa lanjutan; pakai pair-level h24.
  const pc24 = Number(m.priceChangeH24);
  const vh1 = Number(m.volumeH1);
  const vh24 = Number(m.volumeH24);
  if (Number.isFinite(pc24) && Number.isFinite(vh24) && vh24 > 0 && Number.isFinite(vh1)) {
    gate('MID_PUMP_EXIT', pc24 < 150 || vh1 >= 0.1 * vh24, `h24 ${fmtPct(pc24 / 100)} volH1 ${fmtUsd(vh1)} / volH24 ${fmtUsd(vh24)}`);
  }

  const kolCount = k.count || 0;
  const verifiedCount = k.verifiedCount || 0;
  const maxKolFollowers = k.maxFollowers || 0;

  // Concurrency EXCLUSIVE: ≥2 = 40, ≥3 = 70 — jangan di-stack (bundel ≠ conviction).
  credit('KOL_CONCURRENCY', kolCount === 2, `${kolCount} KOL`);
  credit('KOL_CONCURRENCY_3PLUS', kolCount >= 3, `${kolCount} KOL`);
  credit('VERIFIED_KOL', verifiedCount >= 1, `${verifiedCount} verified`);
  credit('CREDIBLE_KOL_THRESHOLD', maxKolFollowers > 500000, `${fmtNum(maxKolFollowers)} followers`);

  // Usia = KURVA SPIKE (satu credit, bukan double-count): ≤6h 25, ≤24h 15, ≤72h 5.
  if (Number.isFinite(ageHours)) {
    const label = `${ageHours.toFixed(1)} jam`;
    credit('NEWBORN_WINDOW', ageHours <= 6, label);
    credit('MATURED_NEWBORN', ageHours > 6 && ageHours <= 24, label);
    credit('OLD_NEWBORN', ageHours > 24 && ageHours <= 72, label);
  } else {
    credit('NEWBORN_WINDOW', false, 'usia tidak diketahui');
    credit('MATURED_NEWBORN', false, 'usia tidak diketahui');
    credit('OLD_NEWBORN', false, 'usia tidak diketahui');
  }
  credit('HOLDERS_100_PLUS', (f.holders ?? 0) >= 100, `${f.holders ?? 0} holders`);
  credit('LOW_TOP_HOLDER', (f.topHolderPct ?? 1) < 0.1, `topHolder ${fmtPct(f.topHolderPct)}`);
  credit('LIQ_HEALTHY', (f.liquidityUsd ?? 0) >= 10000, `liq $${fmtUsd(f.liquidityUsd)}`);

  let score = checks.reduce((s, c) => s + (c.applied ? c.weight : 0), 0);
  score = Math.max(0, Math.min(SCALE, score));

  const base = hardFailed ? classify(0) : classify(score);
  const { tier, tierLabel, color } = autoAvoid
    ? { tier: 'AVOID', tierLabel: 'Hindari — sudah pump masif', color: 'avoid' }
    : base;
  if (hardFailed) score = 0;
  return {
    score,
    scale: SCALE,
    tier,
    tierLabel,
    color,
    hardFailed,
    hardFailReason,
    failedGates,
    checks,
    breakdown: hardFailed
      ? `Ditolak: ${failedGates.join(', ')} — token tidak boleh dibeli.`
      : `Skor ${score}/${SCALE} — ${tierLabel} (${checks.filter((c) => c.applied && c.kind === 'credit').length} poin positif, 0 gate gagal)`,
  };
}

export function fmtUsd(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function fmtPct(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return `${(v * 100).toFixed(0)}%`;
}

export function fmtNum(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}