// NOESIS Oracle intelligence page. Live feed prices from BNB Chain, the Atlas Consensus Score
// from the risk agent's reports (the agent reads the signed Atlas API every 30 min), and what
// the agent may do with each feed. If a value is missing, the page says so.
import { createPublicClient, createWalletClient, custom, http, parseAbi, formatUnits, defineChain } from './vendor/viem.js';

const ADJ = parseAbi([
  'function readFeed(address) view returns (uint256 priceWad, uint64 ts)',
  'function getMarketState(address) view returns ((uint8 phase, uint8 outcome, uint64 deadline, uint64 vetoEndsAt, address resolver, bytes32 dataHash))',
]);
const AMM = parseAbi(['function getMarketState(address) view returns (uint256 qYes, uint256 qNo, uint256 price)']);
const ATLAS_IDS = { 1163: 'EWJB', 1164: 'EWTB', 1165: 'EWZB', 1166: 'IWMB', 1167: 'MELIB', 1168: 'NUB' };
const NAMES = { IWMB: 'Russell 2000 ETF, tokenized', EWZB: 'Brazil ETF, tokenized', BNB: 'BNB / USD' };
const LOGO = { IWMB: 'logos/iwmb.png', EWZB: 'logos/ewzb.png', BNB: 'logos/bnb.svg' };
const ORDER = ['IWMB', 'EWZB', 'BNB'];
const SRC_LONG = ['Atlas Oracle', 'Chainlink'];
const CLOSE_BELOW = 1;
const KIND = ['above', 'below', 'touches above', 'touches below'];
const CONS_CLS = { HEALTHY: 'done', DEGRADED: 'wait' };
const REPORT_TTL = 300_000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const usd = (n, dp = 2) => (n == null || !Number.isFinite(n) ? '-' : `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const pct = (p, dp = 1) => (p == null || !Number.isFinite(p) ? '-' : `${(p * 100).toFixed(dp)}%`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const wad = (v) => Number(formatUnits(v, 18));
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const when = (ts) => `${DATE.format(new Date(ts * 1000)).replace(',', '')} UTC`;

let cfg;
try { cfg = await (await fetch('config.json', { cache: 'no-store' })).json(); } catch { $('#fWhen').textContent = 'The page cannot read config.json.'; throw new Error('no config'); }
const EXPLORER = cfg.explorer ?? 'https://bscscan.com';
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
const chain = defineChain({
  id: cfg.chainId, name: cfg.chainName ?? 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } }, contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});
const pub = createPublicClient({ chain, transport: http(cfg.rpc), batch: { multicall: true } });

const S = { tab: null, now: Math.floor(Date.now() / 1000), block: null, feeds: [], markets: [], reports: new Map(), hist: [], readAt: null };
const ago = (ts) => {
  const s = Math.max(0, S.now - Number(ts));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const assetOf = (m) => m.asset ?? (m.source === 0 ? ATLAS_IDS[parseInt(m.feedId, 16)] : null) ?? short(m.feed);
const feedKey = (m) => (m.source === 0 ? `0:${m.feed}:${m.feedId}` : `1:${m.feed}`).toLowerCase();

// Same rule as the agent's atlasGate(): it fails closed on an error, a missing score or old data.
function gateOf(a, source) {
  if (source !== 0) return { cls: 'none', rule: 'normal', label: 'Normal size', why: 'Chainlink feed. Atlas does not score it.' };
  if (!a) return { cls: 'none', rule: 'wait', label: 'Waiting', why: 'No agent report yet. The agent reads Atlas every 30 min.' };
  if (a.state === 'no_key') return { cls: 'none', rule: 'normal', label: 'Normal size', why: 'The Atlas API key is not set on the server.' };
  if (a.state !== 'complete' || !a.consensusStatus) return { cls: 'bad', rule: 'error', label: 'No trade', why: 'The Atlas API read failed or had no score.' };
  const readAt = a.fetchedAt ? Math.floor(Date.parse(a.fetchedAt) / 1000) : null;
  if (a.ts && readAt && readAt - a.ts > 900) return { cls: 'bad', rule: 'error', label: 'No trade', why: 'The Atlas data was older than 15 min.' };
  if (a.signatureValid === false) return { cls: 'bad', rule: 'sig', label: 'No trade', why: 'The Atlas signature did not verify.' };
  if (a.consensusStatus === 'HEALTHY') return { cls: 'done', rule: 'HEALTHY', label: 'Full size', why: 'The sources agree.' };
  if (a.consensusStatus === 'DEGRADED') return { cls: 'wait', rule: 'DEGRADED', label: 'Half size', why: 'The sources agree less. The agent halves its size.' };
  return { cls: 'bad', rule: 'worse', label: 'No trade', why: `Atlas says ${a.consensusStatus.replace('_', ' ')}.` };
}

// ── Data ────────────────────────────────────────────────────────────
function groupMarkets() {
  const groups = new Map();
  for (const m of cfg.markets ?? []) {
    const k = feedKey(m);
    if (!groups.has(k)) groups.set(k, { key: k, asset: assetOf(m), source: Number(m.source), feed: m.feed, feedId: m.feedId, markets: [] });
    groups.get(k).markets.push(m);
  }
  return [...groups.values()].sort((a, b) => ((ORDER.indexOf(a.asset) + 1 || 99) - (ORDER.indexOf(b.asset) + 1 || 99)) || a.asset.localeCompare(b.asset));
}

async function readChain() {
  const blk = await pub.getBlock();
  S.block = Number(blk.number); S.now = Number(blk.timestamp);
  const open = (cfg.markets ?? []).filter((m) => m.deadline > S.now);
  const feedReads = S.feeds.map((f) => pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'readFeed', args: [(f.markets.find((m) => m.deadline > S.now) ?? f.markets[0]).market] }).catch(() => null));
  const mkReads = open.map((m) => Promise.all([
    pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getMarketState', args: [m.market] }).catch(() => null),
    pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'getMarketState', args: [m.market] }).catch(() => null),
  ]));
  const [fr, mr] = await Promise.all([Promise.all(feedReads), Promise.all(mkReads)]);
  S.feeds.forEach((f, i) => { if (fr[i]) { f.price = wad(fr[i][0]); f.ts = Number(fr[i][1]); } });
  S.markets = open.map((m, i) => ({ ...m, chance: mr[i][0] ? wad(mr[i][0][2]) : null, phase: mr[i][1] ? Number(mr[i][1].phase) : null }))
    .filter((m) => m.phase == null || m.phase < 2);
  S.readAt = Date.now();
}

async function readReports(force = false) {
  const need = S.markets.filter((m) => force || !S.reports.has(m.market.toLowerCase()) || Date.now() - S.reports.get(m.market.toLowerCase()).at > REPORT_TTL);
  await Promise.all(need.map(async (m) => {
    const k = m.market.toLowerCase();
    try { const r = await fetch(`reports/${k}.json?t=${Math.floor(Date.now() / REPORT_TTL)}`, { cache: 'no-store' }); S.reports.set(k, { at: Date.now(), r: r.ok ? await r.json() : null }); }
    catch { S.reports.set(k, { at: Date.now(), r: null }); }
  }));
  try { const r = await fetch(`reports/atlas-history.json?t=${Math.floor(Date.now() / REPORT_TTL)}`, { cache: 'no-store' }); S.hist = r.ok ? (await r.json()).points ?? [] : []; } catch { S.hist = []; }
}
const reportOf = (m) => S.reports.get(m.market.toLowerCase())?.r ?? null;
// The newest Atlas read among the reports of a feed's markets.
function atlasOf(f) {
  return f.markets.map((m) => reportOf(m)?.inputs?.atlas).filter((a) => a?.state)
    .sort((a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt)))[0] ?? null;
}

// ── Render ──────────────────────────────────────────────────────────
const srcBadge = (source) => `<span class="src-b src-${source === 0 ? 'atlas' : 'cl'}">${esc(SRC_LONG[source] ?? 'Feed')}</span>`;

function spark(id) {
  const pts = S.hist.filter((p) => String(p.id) === String(id) && num(p.score) != null && p.t > S.now - 86400).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return `<p class="small muted ix-spark-empty">Score history starts with the agent's next reads (one every 30 min).</p>`;
  const W = 280, H = 56, t0 = pts[0].t, t1 = pts.at(-1).t || t0 + 1;
  const lo = Math.max(0, Math.min(...pts.map((p) => p.score)) - 0.05), hi = Math.min(1, Math.max(...pts.map((p) => p.score)) + 0.05);
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W, y = (s) => H - ((s - lo) / Math.max(0.01, hi - lo)) * H;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.score).toFixed(1)}`).join(' ');
  return `<svg class="ix-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Consensus Score over the last ${Math.round((t1 - t0) / 3600) || 1} h: from ${pts[0].score.toFixed(2)} to ${pts.at(-1).score.toFixed(2)}">
      <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg><p class="small muted ix-spark-cap"><span>${esc(lo.toFixed(2))}–${esc(hi.toFixed(2))}</span><span>${pts.length} reads, last ${esc(String(Math.round((t1 - t0) / 3600) || 1))} h</span></p>`;
}

function feedCard(f) {
  const a = f.source === 0 ? atlasOf(f) : null;
  const g = gateOf(a, f.source);
  const id = f.source === 0 ? parseInt(f.feedId, 16) : null;
  const score = num(a?.consensusScore);
  const prot = S.markets.filter((m) => feedKey(m) === f.key && Number(m.kind) === CLOSE_BELOW).sort((x, y) => x.deadline - y.deadline || Number(BigInt(y.strike) - BigInt(x.strike)));
  const openN = S.markets.filter((m) => feedKey(m) === f.key).length;
  const scoreBlock = f.source !== 0
    ? `<div class="ix-score ix-score-none"><p class="ix-label">Consensus Score</p><p class="small muted">Not scored. This is a Chainlink feed, so the agent trades at its normal size.</p></div>`
    : a?.consensusStatus
      ? `<div class="ix-score">
          <div class="ix-score-top"><p class="ix-label">Consensus Score</p><span class="status ${CONS_CLS[a.consensusStatus] ?? 'bad'}">${esc(a.consensusStatus.replace('_', ' '))}</span></div>
          <p class="ix-score-n mono">${score != null ? esc(score.toFixed(2)) : '-'}<span> / 1</span></p>
          <div class="ix-meter" aria-hidden="true"><i class="m-${CONS_CLS[a.consensusStatus] ?? 'bad'}" style="width:${score != null ? Math.round(score * 100) : 0}%"></i></div>
          ${spark(id)}
        </div>`
      : `<div class="ix-score"><p class="ix-label">Consensus Score</p><p class="small muted">${esc(g.why)}</p></div>`;
  const dl = [
    id != null ? ['Feed id', `<span class="mono">${esc(String(id))}</span> <span class="muted mono">(${esc(f.feedId)})</span>`] : null,
    ['Contract', link(`${EXPLORER}/address/${f.feed}`, short(f.feed))],
    ['Read', f.source === 0 ? '<code>fetch(bytes4)</code> on BNB Chain' : '<code>latestRoundData()</code> on BNB Chain'],
    a?.twapPrice != null ? ['Atlas TWAP', `<span class="mono">${esc(usd(a.twapPrice))}</span>`] : null,
    a?.medianPrice != null ? ['Atlas median', `<span class="mono">${esc(usd(a.medianPrice))}</span>`] : null,
    num(a?.priceChangePct) != null ? ['Atlas change', `<span class="mono">${esc(a.priceChangePct.toFixed(3))}%</span>`] : null,
    num(a?.onchainGapPct) != null ? ['API vs chain', `<span class="mono">${esc(a.onchainGapPct.toFixed(3))}%</span>`] : null,
    a?.state === 'complete' ? ['Signature', a.signatureValid ? `Valid, signer ${esc(short(a.signer ?? ''))}` : '<b>Did not verify</b>'] : null,
    a?.fetchedAt ? ['Atlas API read', esc(ago(Math.floor(Date.parse(a.fetchedAt) / 1000)))] : null,
  ].filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  const levels = prot.map(mkCard).join('');
  return `<article class="ix-card ix-wide" aria-labelledby="f-${esc(f.asset)}">
    <div class="ix-col">
      <div class="ix-card-top">${LOGO[f.asset] ? `<img src="${LOGO[f.asset]}" alt="" width="40" height="40">` : ''}<div><h3 id="f-${esc(f.asset)}">${esc(f.asset)}</h3><p class="small muted">${esc(NAMES[f.asset] ?? '')}</p></div>${srcBadge(f.source)}</div>
      <p class="ix-price mono">${f.price != null ? esc(usd(f.price)) : '-'}</p>
      <p class="small muted ix-upd"><i class="dot" aria-hidden="true"></i>${f.ts ? `Updated ${esc(ago(f.ts))}, on chain` : 'No price read yet'}</p>
      ${scoreBlock}
    </div>
    <div class="ix-col">
      <div class="ix-gate ix-gate-${g.cls}"><p class="ix-label">Agent rule now</p><p class="ix-gate-v">${esc(g.label)}</p><p class="small">${esc(g.why)}</p></div>
      <div class="ix-dl"><p class="ix-label">Feed details</p><dl class="kv small">${dl}</dl></div>
    </div>
    <div class="ix-col ix-mk">
      <p class="ix-label">${openN} open market${openN === 1 ? '' : 's'}</p>
      ${levels ? `<ul class="mk-cards">${levels}</ul>` : '<p class="small muted">No open protection level.</p>'}
      ${prot.length ? `<a class="btn btn-ink btn-sm" href="./?asset=${encodeURIComponent(f.asset)}#protect">Protect ${esc(f.asset)}</a>` : ''}
    </div>
  </article>`;
}

// One market as a small card: level, end, market chance bar, agent estimate, agent action.
function mkCard(m) {
  const r = reportOf(m), d = r?.decision, a = r?.inputs?.atlas;
  const ag = num(d?.pStar) ?? num(d?.pModel), ch = m.chance;
  const w = (p) => (p == null ? 0 : Math.max(0, Math.min(100, p * 100)));
  const cons = Number(m.source) !== 0 ? '<span class="status plain">Chainlink</span>'
    : a?.consensusStatus ? `<span class="status ${CONS_CLS[a.consensusStatus] ?? 'bad'}">${esc(a.consensusStatus.replace('_', ' '))} ${esc(num(a.consensusScore)?.toFixed(2) ?? '')}</span>` : '';
  const act = d ? `${esc(ACT[d.action] ?? d.action)}${d?.consensus?.applies && d.consensus.sizeMultiplier < 1 && d.consensus.sizeMultiplier > 0 ? ', half size' : ''}` : 'No report';
  return `<li class="mk-card"><a href="./?asset=${encodeURIComponent(assetOf(m))}#protect" aria-label="${esc(`${assetOf(m)} ${KIND[m.kind] ?? ''} ${usd(wad(BigInt(m.strike)))}, ends ${when(m.deadline)}, market chance ${pct(ch)}, agent estimate ${pct(ag)}`)}">
    <span class="mk-top"><b>${esc(KIND[m.kind] === 'below' ? 'Below' : KIND[m.kind] ?? '')} ${esc(usd(wad(BigInt(m.strike))))}</b><span class="muted small">${esc(when(m.deadline))}</span></span>
    <span class="mk-ch"><span class="mono">${esc(pct(ch))}</span><span class="muted small">market chance</span></span>
    <span class="s-track" aria-hidden="true"><i class="ch-bar" style="width:${w(ch).toFixed(1)}%"></i>${ag != null ? `<b class="ch-mk" style="left:${w(ag).toFixed(1)}%"></b>` : ''}</span>
    <span class="mk-foot"><span class="small">Agent ${esc(pct(ag))} · ${act}</span>${cons}</span>
  </a></li>`;
}

const RULES = [
  ['HEALTHY', 'done', 'HEALTHY', 'Full size'],
  ['DEGRADED', 'wait', 'DEGRADED', 'Half size'],
  ['worse', 'bad', 'WARNING, CRITICAL, SPLIT MARKET or UNKNOWN', 'No trade'],
  ['error', 'bad', 'API error, no score, or data older than 15 min', 'No trade'],
  ['sig', 'bad', 'The Atlas signature does not verify', 'No trade'],
];
function renderRules(gates) {
  $('#rules').innerHTML = RULES.map(([k, cls, when_, act]) => {
    const now = gates.filter((g) => g.g.rule === k).map((g) => g.asset);
    return `<li class="${now.length ? 'is-now' : ''}"><span class="status ${cls}">${esc(act)}</span><span>${esc(when_)}</span><span class="ix-now">${now.length ? `Now: <b>${esc(now.join(', '))}</b>` : ''}</span></li>`;
  }).join('');
}

const ACT = { BUY_YES: 'Bought cover', BUY_NO: 'Sold cover', HOLD: 'Hold' };
function feedTab(f) {
  const a = f.source === 0 ? atlasOf(f) : null, g = gateOf(a, f.source), on = f.asset === S.tab;
  const chip = f.source !== 0 ? '<span class="status plain">Not scored</span>' : a?.consensusStatus ? `<span class="status ${CONS_CLS[a.consensusStatus] ?? 'bad'}">${esc(a.consensusStatus.replace('_', ' '))} ${esc(num(a.consensusScore)?.toFixed(2) ?? '')}</span>` : '<span class="status">No score yet</span>';
  return `<button type="button" class="acard ix-tab" role="tab" id="t-${esc(f.asset)}" aria-selected="${on}" aria-controls="feedGrid" tabindex="${on ? 0 : -1}" data-a="${esc(f.asset)}"><span class="acard-in">
    <span class="a-top">${LOGO[f.asset] ? `<img src="${LOGO[f.asset]}" alt="" width="36" height="36">` : ''}<span class="a-id"><b>${esc(f.asset)}</b><span>${esc(NAMES[f.asset] ?? '')}</span></span>${srcBadge(f.source)}</span>
    <span class="a-px"><span class="mono a-price">${f.price != null ? esc(usd(f.price)) : '-'}</span></span>
    <span class="a-foot">${chip}<span class="a-rule">Agent: ${esc(g.label)}</span></span>
  </span></button>`;
}

function render() {
  $('#block').textContent = S.block != null ? `#${S.block.toLocaleString('en-US')}` : '';
  $('#net .dot').className = S.block != null ? 'dot live' : 'dot err';
  if (!S.feeds.some((f) => f.asset === S.tab)) S.tab = S.feeds[0]?.asset ?? null;
  const tabs = $('#feedTabs'), had = tabs.contains(document.activeElement);
  tabs.innerHTML = S.feeds.map(feedTab).join('');
  if (had) tabs.querySelector('[aria-selected="true"]')?.focus();
  const sel = S.feeds.find((f) => f.asset === S.tab);
  $('#feedGrid').setAttribute('aria-labelledby', `t-${S.tab}`);
  $('#feedGrid').innerHTML = sel ? feedCard(sel) : '';
  const gates = S.feeds.map((f) => ({ asset: f.asset, source: f.source, g: gateOf(f.source === 0 ? atlasOf(f) : null, f.source) }));
  renderRules(gates);
  $('#kFeeds').textContent = String(S.feeds.filter((f) => f.price != null).length);
  const atlasGates = gates.filter((x) => x.source === 0);
  const labels = [...new Set(atlasGates.map((x) => x.g.label))];
  $('#kMode').innerHTML = labels.length === 1 ? `${esc(labels[0])} <small>on Atlas feeds</small>` : labels.length ? atlasGates.map((x) => `${esc(x.asset)}: ${esc(x.g.label)}`).join('<br>') : '-';
  const reads = S.feeds.map(atlasOf).map((a) => a?.fetchedAt).filter(Boolean).sort();
  $('#kRead').textContent = reads.length ? ago(Math.floor(Date.parse(reads.at(-1)) / 1000)) : '-';
  $('#kMarkets').textContent = String(S.markets.filter((m) => Number(m.kind) === CLOSE_BELOW).length);
  $('#fWhen').textContent = `Prices at block #${S.block?.toLocaleString('en-US') ?? '-'}. They refresh every 30 s.`;
}

S.feeds = groupMarkets();
S.tab = new URLSearchParams(location.search).get('feed') ?? null;
$('#feedTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) { S.tab = b.dataset.a; render(); b.isConnected || $(`#t-${S.tab}`)?.focus(); } });
$('#feedTabs').addEventListener('keydown', (e) => {
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  const list = S.feeds.map((f) => f.asset), i = list.indexOf(S.tab);
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
  S.tab = list[j]; render(); $(`#t-${S.tab}`)?.focus();
});
async function tick(first = false) {
  try {
    await readChain();
    await readReports(first);
    render();
  } catch (e) {
    $('#fWhen').textContent = 'The BNB Chain RPC did not answer. The page tries again in 30 s.';
    if (first) $('#feedGrid').innerHTML = '<p class="empty">No live data yet. The page tries again in 30 s.</p>';
  }
}
tick(true); // the wallet below does not wait for the first read
setInterval(() => { if (!document.hidden) tick(); }, 30_000);


// ── Header wallet: the same as on the main page (connect, hUSD-DEMO balance, faucet). ──
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function faucet()', 'function lastFaucet(address) view returns (uint256)']);
const W = { wallet: null, account: null, balance: null };
const compactUsd = (n) => (Math.abs(n) >= 1e6 ? `$${(Math.floor(n / 1e5) / 10).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `$${(Math.floor(n / 1e2) / 10).toFixed(1)}k` : usd(n, 0));
let toastTimer;
function toast(html, ms = 6000) {
  const t = $('#toast');
  t.innerHTML = html; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function walletError(e) {
  const m = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
  if (/User (rejected|denied)|rejected the request|4001/i.test(m)) return 'You cancelled in your wallet.';
  if (/ONCE_A_DAY/.test(m)) return 'This wallet already got hUSD-DEMO in the last 24 hours. The faucet gives 1,000 once a day per wallet.';
  return (e?.shortMessage ?? e?.message ?? 'Something went wrong.').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ');
}
function renderWallet() {
  const b = $('#connect');
  document.body.classList.toggle('wallet-on', !!W.account);
  if (!W.account) { b.textContent = 'Connect wallet'; b.title = ''; b.removeAttribute('aria-label'); return; }
  const bal = W.balance != null ? compactUsd(W.balance) : null;
  b.innerHTML = `${bal ? `<span class="w-bal mono">${esc(bal)}</span>` : ''}<span class="w-addr mono">${esc(short(W.account))}</span>`;
  b.title = `${W.account}${W.balance != null ? `\n${usd(W.balance)} hUSD-DEMO` : ''}`;
  b.setAttribute('aria-label', `Wallet ${short(W.account)}${W.balance != null ? `, ${usd(W.balance)} hUSD-DEMO` : ''}`);
}
async function readBalance() {
  if (!W.account || !cfg.stable) return;
  try { W.balance = wad(await pub.readContract({ address: cfg.stable, abi: ERC20, functionName: 'balanceOf', args: [W.account] })); } catch { /* keep the last value */ }
  renderWallet();
}
// Never send on the wrong chain: ask to switch, add the chain if needed, then check again.
async function ensureChain() {
  if ((await W.wallet.getChainId()) === chain.id) return;
  try { await W.wallet.switchChain({ id: chain.id }); }
  catch (e) {
    if (/rejected|denied|4001/i.test(`${e?.message} ${e?.code}`)) throw new Error(`Switch your wallet to ${chain.name} to continue.`);
    await W.wallet.addChain({ chain });
  }
  if ((await W.wallet.getChainId()) !== chain.id) throw new Error(`Your wallet is not on ${chain.name}. Switch it and try again.`);
}
async function connectWallet() {
  if (!window.ethereum) throw new Error('No wallet found. Install a browser wallet to trade. You can still read every market.');
  try {
    W.wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
    [W.account] = await W.wallet.requestAddresses();
    if (!W.account) throw new Error('The wallet gave no account.');
    await ensureChain();
  } catch (e) { W.wallet = null; W.account = null; W.balance = null; renderWallet(); throw e; }
  renderWallet();
  await readBalance();
}
$('#connect').onclick = () => connectWallet().catch((e) => toast(esc(walletError(e))));
$('#faucet').hidden = !cfg.faucet;
$('#faucet').onclick = async (ev) => {
  const b = ev.currentTarget; b.disabled = true;
  try {
    if (!W.account) await connectWallet();
    else await ensureChain();
    // Once a day per wallet: check first, so no transaction fails.
    const last = Number(await pub.readContract({ address: cfg.stable, abi: ERC20, functionName: 'lastFaucet', args: [W.account] }));
    if (last && Date.now() / 1000 < last + 86400) { toast(`This wallet already got hUSD-DEMO today. Next faucet: ${esc(when(last + 86400))}.`); return; }
    const { request } = await pub.simulateContract({ address: cfg.stable, abi: ERC20, functionName: 'faucet', args: [], account: W.account });
    const hash = await W.wallet.writeContract(request);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== 'success') throw new Error('The transaction failed.');
    toast(`1,000 hUSD-DEMO sent. ${link(`${EXPLORER}/tx/${hash}`, 'View tx')}`);
    await readBalance();
  } catch (e) { toast(esc(walletError(e))); }
  finally { b.disabled = false; }
};
window.ethereum?.on?.('accountsChanged', (a) => { W.account = a?.[0] ?? null; W.balance = null; if (W.account) W.wallet ??= createWalletClient({ chain, transport: custom(window.ethereum) }); renderWallet(); readBalance(); });
window.ethereum?.on?.('chainChanged', () => location.reload());
// Keep the wallet across pages: if the wallet already allowed this site, show it again with no prompt.
window.ethereum?.request({ method: 'eth_accounts' }).then((a) => {
  if (!a?.[0] || W.account) return;
  W.wallet = createWalletClient({ chain, transport: custom(window.ethereum) }); W.account = a[0];
  renderWallet(); readBalance();
}).catch(() => {});
