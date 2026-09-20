const REPORT_URL = new URLSearchParams(location.search).get('report') || '../output/report.json';

const state = {
  report: null,
  tier: null,
  query: '',
};

function $(id) { return document.getElementById(id); }

function fmtUsd(v) {
  if (v === null || v === undefined || v === NaN) return 'n/a';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Number(v).toFixed(0)}`;
}

function fmtAge(h) {
  if (h === null || h === undefined || Number.isNaN(h)) return 'n/a mnt';
  if (h < 1) return `${Math.round(h * 60)} mnt`;
  if (h < 24) return `${h.toFixed(1)} jam`;
  return `${(h / 24).toFixed(1)} hari`;
}

function shortMint(m) {
  return m ? `${m.slice(0, 4)}…${m.slice(-4)}` : '?';
}

function checkRow(kind, applied, label, detail) {
  const appliedRender = typeof applied === 'boolean' ? (applied ? 'ok' : 'no') : 'na';
  const mark = appliedRender === 'ok' ? 'OK' : appliedRender === 'no' ? 'NO' : 'n/a';
  return `<div class="check">
    <span class="mark ${appliedRender}">${mark}</span>
    <div>
      <div class="check-label">${label}</div>
      ${detail ? `<div class="detail">${detail}</div>` : ''}
    </div>
  </div>`;
}

function renderSummary() {
  const t = state.report;
  const modeLabel = String(t.meta.mode || 'unknown').toUpperCase();
  $('scanMode').textContent = modeLabel;
  $('scanMode').className = `badge ${modeLabel === 'LIVE' ? 'badge-live' : 'badge-discovery'}`;
  $('scanTime').textContent = `scan ${new Date(t.meta.generatedAt).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}`;
  const feed = String(t.meta.feeds?.rpc || 'n/a');
  $('scanFeed').textContent = `feed ${feed}`;
  $('scanFeed').className = `badge ${feed === 'helius' ? 'badge-live' : feed === 'zan' ? 'badge-zan' : 'badge-discovery'}`;
  $('stTotal').textContent = t.tokens.length;
  const c = t.summary.counts;
  $('stAlpha').textContent = c.ALPHA || 0;
  $('stBuy').textContent = c.BUY || 0;
  $('stWatch').textContent = c.WATCH || 0;
  $('stSkip').textContent = c.SKIP || 0;
}

function renderCrawlNote() {
  const note = state.report.crawlInfo;
  $('crawlNote').innerHTML = `<strong>Metode:</strong> ${note.detecting}<br><strong>Gap:</strong> ${note.gapNote}`;
}

function renderTierFilters() {
  const wrap = $('tierFilter');
  wrap.innerHTML = '';
  const allBtn = document.createElement('button');
  allBtn.textContent = 'Semua';
  allBtn.classList.add(state.tier === null ? 'active' : '');
  allBtn.onclick = () => { state.tier = null; renderTierFilters(); renderList(); };
  wrap.appendChild(allBtn);
  for (const t of ['ALPHA', 'BUY', 'WATCH', 'SKIP']) {
    const b = document.createElement('button');
    b.textContent = t;
    b.dataset.tier = t;
    b.classList.add(state.tier === t ? 'active' : '');
    b.onclick = () => { state.tier = t; renderTierFilters(); renderList(); };
    wrap.appendChild(b);
  }
}

function cardTemplate(t) {
  const v = t.verdict;
  const tierCls = v.color === 'skip' ? 'skip' : v.color;
  const tierLabel = t.verdict.tierLabel;

  const checks = v.checks.map((c) =>
    checkRow(c.kind, c.applied, c.label, c.detail)
  ).join('');

  const rugFund = t.fundamentals || {};
  const fundOk = rugFund.available !== false;
  const fundBlock = fundOk
    ? `<div class="body-col">
        <h3>Fundamental On-chain</h3>
        <div class="check-list">
          ${checkRow('g', !rugFund.rugRisk, 'RugCheck bersih', rugFund.rugRisk ? rugFund.rugRiskDetail.join('; ') : 'tidak ada sinyal rug')}
          ${checkRow('g', (rugFund.liquidityUsd ?? 0) >= 1000, 'Likuiditas ≥ $1K', `liq ${fmtUsd(rugFund.liquidityUsd)}`)}
          ${checkRow('g', (rugFund.topHolderPct ?? 0) <= 0.4, 'Top holder ≤ 40%', `top ${(rugFund.topHolderPct ?? 0).toFixed(1)}`)}
          ${checkRow('g', rugFund.mintAuthorityRevoked === true, 'Mint authority revoked', rugFund.mintAuthorityRevoked === false ? 'MASIH AKTIF' : 'n/a')}
          ${checkRow('c', (rugFund.holders ?? 0) >= 100, 'Holder ≥ 100', `${rugFund.holders ?? 0} holders`)}
        </div>
      </div>`
    : `<div class="body-col">
        <h3>Fundamental On-chain</h3>
        <div class="check-list">${checkRow('g', null, 'Data fundamental belum ditarik', 'jalankan ulang scan real (discovery/live)')}</div>
      </div>`;

  const addrList = (t.kol.holders || []).slice(0, 5).map((h) => `
    <div class="addr">
      <span><span class="handle">@${h.handle}${h.verified ? '<span class="verify">✔ VERIFIED</span>' : ''}</span></span>
      <span class="followers">${h.followers ? h.followers.toLocaleString() + ' flw' : ''} · ${h.amount.toFixed(0)} token</span>
    </div>`).join('') || '<div class="addr">· tidak ada data wallet</div>';

  return `<article class="card ${v.hardFailed ? 'avoid' : ''}">
    <div class="card-head" onclick="this.parentElement.classList.toggle('open')">
      <div class="tier-badge ${tierCls}">${v.tier}</div>
      <div>
        <div class="card-title">
          <span class="card-name">${t.name || '? (data belum lengkap)'}</span>
          <span class="card-symbol">${t.symbol || '?'}</span>
        </div>
        <div class="card-mint">${shortMint(t.mint)}</div>
        <div class="card-kpis">
          <span class="kpi"><b>${t.ageHours !== null && !Number.isNaN(t.ageHours) ? fmtAge(t.ageHours) : 'n/a'}</b> umur</span>
          <span class="kpi"><b>${t.kol.count}</b> KOL pegang</span>
          <span class="kpi"><b>${t.kol.verifiedCount}</b> KOL verified</span>
          <span class="kpi"><b>${t.kol.maxFollowers ? t.kol.maxFollowers.toLocaleString() : 'n/a'}</b> followers max</span>
        </div>
        <div class="score-row">
          <div class="score-bar-wrap"><div class="score-bar ${tierCls}" style="width:${(v.score / v.scale) * 100}%"></div></div>
          <span class="score-num" style="color:var(--${tierCls})">${v.score}/${v.scale}</span>
        </div>
        <div class="breakdown">${v.breakdown}</div>
      </div>
    </div>
    <div class="card-body">
      ${fundBlock}
      <div class="body-col">
        <h3>Wallet KOL yang pegang</h3>
        <div class="addr-list">${addrList}</div>
      </div>
    </div>
  </article>`;
}

function renderList() {
  const list = $('tokenList');
  const tokens = state.report.tokens
    .filter((t) => !state.tier || t.verdict.tier === state.tier)
    .filter((t) => {
      if (!state.query) return true;
      const q = state.query.toLowerCase();
      return [t.name, t.symbol, t.mint, t.verdict.tier].some((s) => s && s.toLowerCase().includes(q));
    })
    .sort((a, b) => b.verdict.score - a.verdict.score);
  list.innerHTML = tokens.length ? tokens.map(cardTemplate).join('') : '<p style="color:var(--text-faint);padding:16px">Tidak ada token yang cocok.</p>';
}

async function load() {
  try {
    const res = await fetch(REPORT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.report = await res.json();
  } catch (e) {
    $('tokenList').innerHTML = `<p style="color:var(--avoid)">Gagal memuat report (${REPORT_URL}): ${e.message}. Jalankan <code>npm run scan</code> (atau <code>--discovery</code>) di folder solana-scout dulu.</p>`;
    return;
  }
  $('filter').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  renderSummary();
  renderCrawlNote();
  renderTierFilters();
  renderList();
}

load();