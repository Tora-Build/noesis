// Sooth Hedge page. All numbers come from the chain (config.json lists the markets) or from
// the risk agent's reports (reports/<market>.json). If a value is missing, the page says so.
import {
  createPublicClient, createWalletClient, custom, http, parseAbi, parseAbiItem, formatUnits, parseUnits, defineChain,
} from 'https://esm.sh/viem@2.21.0';

const ADJ = parseAbi([
  'function terms(address) view returns ((uint8 source, address feed, bytes4 feedId, uint8 kind, uint256 strikeWad, uint64 maxDelay))',
  'function readFeed(address) view returns (uint256 priceWad, uint64 ts)',
  'function getPhase(address) view returns (uint8)',
  'function getOutcome(address) view returns (uint8)',
  'function canSettle(address) view returns (bool)',
  'function getMarketState(address) view returns ((uint8 phase, uint8 outcome, uint64 deadline, uint64 vetoEndsAt, address resolver, bytes32 dataHash))',
  'function openedAt(address) view returns (uint64)',
  'function vetoPeriod() view returns (uint48)',
  'function settleFromFeed(address) returns (uint8)',
  'function settle(address)',
]);
const FEED_OBSERVED = parseAbiItem('event FeedObserved(address indexed market, uint256 priceWad, uint64 publishedAt, uint8 outcome)');
const AMM = parseAbi([
  'function getMarketState(address) view returns (uint256 qYes, uint256 qNo, uint256 price)',
  'function getPositionQuote(address, uint8, int256) view returns (uint256 cost, uint256 fee, uint256 netAmount, uint256 newPrice)',
  'function getPosition(address, address) view returns (uint256 yesShares, uint256 noShares)',
  'function tradePositions(address, uint8, int256, uint256) returns (uint256)',
  'function settlePosition(address)',
]);
const MARKET = parseAbi(['function deadline() view returns (uint64)', 'function isSettled() view returns (bool)', 'function isTradingOpen() view returns (bool)']);
const ERC20 = parseAbi([
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function faucet()',
]);

// Market kinds of PriceFeedAdjudicator.
const CLOSE_ABOVE = 0, CLOSE_BELOW = 1, TOUCH_ABOVE = 2, TOUCH_BELOW = 3;
const isBelow = (k) => k === CLOSE_BELOW || k === TOUCH_BELOW;
const isTouch = (k) => k === TOUCH_ABOVE || k === TOUCH_BELOW;
const KIND_NAME = ['Close above', 'Close below', 'Touch above', 'Touch below'];
const PH = { IDLE: 0, ACTIVE: 1, RESOLVED: 2, ATTESTED: 3, SETTLED: 4, DISPUTED: 5 };
const OUTCOME = ['NO', 'YES', 'INVALID'];
const ATLAS_IDS = { 1163: 'EWJB', 1164: 'EWTB', 1165: 'EWZB', 1166: 'IWMB', 1167: 'MELIB', 1168: 'NUB' };
const AGGREGATORS = { '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee': 'BNB', '0x264990fbd0a4796a3e3d8e37c4d5f87a3aca5ebf': 'BTC' };
const SRC = ['Atlas', 'Chainlink'];
const SRC_LONG = ['Atlas Oracle', 'Chainlink'];

// ── Setup ────────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
let cfg;
try { cfg = await (await fetch('config.json', { cache: 'no-store' })).json(); }
catch { fatal('The page cannot read config.json. Run npm run web:config.'); throw new Error('no config'); }

const EXPLORER = cfg.explorer ?? 'https://bscscan.com';
const MAX_TRADE = Number(cfg.maxTrade ?? 500);
const SLIP_BPS = BigInt(cfg.slippageBps ?? 200);
const chain = defineChain({
  id: cfg.chainId, name: cfg.chainName ?? 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
  blockExplorers: { default: { name: 'BscScan', url: EXPLORER } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});
const pub = createPublicClient({ chain, transport: http(cfg.rpc), batch: { multicall: true } });

const S = {
  now: Math.floor(Date.now() / 1000), // chain time from the latest block
  block: null,
  markets: new Map(), // address -> market view
  asset: null,
  sel: null, // selected market address
  account: null, wallet: null, balance: null,
  quote: null, // last protect quote
  vetoPeriod: null,
};

// ── Formatting ───────────────────────────────────────────────────────
const wad = (v) => (v == null ? null : Number(formatUnits(v, 18)));
const usd = (n, dp = 2) => (n == null || !Number.isFinite(n) ? '-' : `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const cents = (p) => (p == null || !Number.isFinite(p) ? '-' : `${(p * 100).toFixed(1)}¢`);
const pct = (p, dp = 1) => (p == null || !Number.isFinite(p) ? '-' : `${(p * 100).toFixed(dp)}%`);
const signed = (x, dp = 2) => (x == null || !Number.isFinite(x) ? '-' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(dp)}%`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const when = (ts) => `${DATE_FMT.format(new Date(Number(ts) * 1000))} UTC`;
const ago = (ts) => {
  const s = Math.max(0, S.now - Number(ts));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const span = (s) => {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.ceil((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m} min`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const txUrl = (h) => `${EXPLORER}/tx/${h}`;
const addrUrl = (a) => `${EXPLORER}/address/${a}`;
// Only http(s) links. Anything else (javascript:, data:, relative) is shown as plain text.
const safeHref = (href) => { try { const u = new URL(String(href)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; } };
const link = (href, text) => { const h = safeHref(href); return h ? `<a href="${esc(h)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text); };
const isHash = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const ceil2 = (x) => Math.floor(x * 100) / 100;

function humanError(e) {
  const m = `${e?.shortMessage ?? ''} ${e?.message ?? ''} ${e?.cause?.data?.errorName ?? ''}`;
  if (/User (rejected|denied)|rejected the request|4001/i.test(m)) return 'You cancelled in your wallet.';
  if (/CostTooHigh/.test(m)) return 'The price moved past your slippage limit. Get a new quote and try again.';
  if (/MarketNotLive/.test(m)) return 'Trading is closed for this market.';
  if (/NotCrossed/.test(m)) return 'The feed has not reached the level yet, and the time is not over.';
  if (/TooEarly/.test(m)) return 'The market time is not over yet.';
  if (/StalePrice/.test(m)) return 'No feed price after the market time yet. Try again after the next update.';
  if (/NoPosition/.test(m)) return 'This wallet has no shares in this market.';
  if (/insufficient|exceeds balance/i.test(m)) return 'Not enough hUSD-DEMO. Get hUSD-DEMO first.';
  return (e?.shortMessage ?? e?.message ?? 'Something went wrong.').split('\n')[0];
}

// ── Market model ─────────────────────────────────────────────────────
function assetOf(t, c) {
  if (c?.asset) return c.asset;
  return t.source === 0 ? ATLAS_IDS[parseInt(t.feedId, 16)] ?? `Atlas #${parseInt(t.feedId, 16)}` : AGGREGATORS[t.feed.toLowerCase()] ?? short(t.feed);
}

async function fetchReport(market) {
  try {
    const r = await fetch(`reports/${market.toLowerCase()}.json`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function readMarket(c) {
  const a = c.market;
  const [t, feed, st, amm, deadline, settled, open, opened] = await Promise.all([
    pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'terms', args: [a] }),
    pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'readFeed', args: [a] }).catch(() => null),
    pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'getMarketState', args: [a] }),
    pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getMarketState', args: [a] }).catch(() => null),
    pub.readContract({ address: a, abi: MARKET, functionName: 'deadline' }),
    pub.readContract({ address: a, abi: MARKET, functionName: 'isSettled' }),
    pub.readContract({ address: a, abi: MARKET, functionName: 'isTradingOpen' }),
    pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'openedAt', args: [a] }),
  ]);
  const prev = S.markets.get(a);
  const m = {
    addr: a, cfg: c, question: c.question,
    source: Number(t.source), feed: t.feed, feedId: t.feedId, kind: Number(t.kind),
    strike: wad(t.strikeWad), strikeWad: t.strikeWad, maxDelay: Number(t.maxDelay),
    asset: assetOf(t, c),
    price: feed ? wad(feed[0]) : null, priceTs: feed ? Number(feed[1]) : null,
    phase: Number(st.phase), outcome: Number(st.outcome), vetoEndsAt: Number(st.vetoEndsAt),
    deadline: Number(deadline), settled, open, openedAt: Number(opened),
    yes: amm ? wad(amm[2]) : null, qYes: amm?.[0], qNo: amm?.[1],
    report: prev?.report, pos: prev?.pos, observed: prev?.observed,
  };
  if (m.report === undefined) m.report = await fetchReport(a);
  return m;
}

// The market is finished for trading when its time passed, it settled, or a touch can settle it.
const crossed = (m) => m.price != null && (isBelow(m.kind) ? m.price <= m.strike : m.price >= m.strike);
const touchHit = (m) => isTouch(m.kind) && crossed(m) && m.priceTs >= m.openedAt && m.priceTs < m.deadline;
const finished = (m) => m.settled || m.phase >= PH.RESOLVED || S.now >= m.deadline || touchHit(m);
const live = (m) => m.open && !finished(m);

// What anyone can do now to move the market to its result.
function settleState(m) {
  if (m.settled) return { kind: 'settled' };
  if (m.phase === PH.RESOLVED || m.phase === PH.ATTESTED) {
    if (S.now < m.vetoEndsAt) return { kind: 'veto', left: m.vetoEndsAt - S.now };
    return { kind: 'finalize' };
  }
  if (m.phase === PH.DISPUTED) return { kind: 'disputed' };
  if (touchHit(m)) return { kind: 'propose', why: 'touch' };
  if (S.now >= m.deadline) {
    if (!isTouch(m.kind) && (m.priceTs ?? 0) < m.deadline) return { kind: 'waitfeed' };
    return { kind: 'propose', why: 'time' };
  }
  return { kind: 'open' };
}

function ruleText(m, protect = false) {
  const src = `${SRC[m.source]} ${m.asset}`;
  const cmp = isBelow(m.kind) ? 'at or below' : 'at or above';
  const yes = protect ? 'Pays out' : 'YES';
  if (isTouch(m.kind)) {
    return `${yes} if any ${src} price published after the market opened and before ${when(m.deadline)} is ${cmp} ${usd(m.strike)}. It settles early on a touch. ${protect ? 'No touch by then: no payout.' : 'No touch by then: NO.'}`;
  }
  const late = Math.round(m.maxDelay / 60);
  return `${yes} if the first ${src} price at or after ${when(m.deadline)} is ${cmp} ${usd(m.strike)}. If no price comes within ${late} min after that, the market is void and each share pays $0.50.`;
}

const ifText = (m) => isTouch(m.kind)
  ? `if ${m.asset} touches ${usd(m.strike)} before ${when(m.deadline)}`
  : `if ${m.asset} is at or ${isBelow(m.kind) ? 'below' : 'above'} ${usd(m.strike)} on ${when(m.deadline)}`;

// ── Loading ──────────────────────────────────────────────────────────
async function refreshChain() {
  const blk = await pub.getBlock();
  S.block = blk.number; S.now = Number(blk.timestamp);
  $('#block').textContent = `#${blk.number.toLocaleString('en-US')}`;
  $('#net .dot').className = 'dot live';
}

async function loadMarkets() {
  const list = cfg.markets ?? [];
  const res = await Promise.allSettled(list.map(readMarket));
  res.forEach((r, i) => { if (r.status === 'fulfilled') S.markets.set(list[i].market, r.value); });
  if (S.account) await loadPositions();
}

async function loadPositions() {
  const ms = [...S.markets.values()];
  const [bal, ...pos] = await Promise.all([
    pub.readContract({ address: cfg.stable, abi: ERC20, functionName: 'balanceOf', args: [S.account] }),
    ...ms.map((m) => pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPosition', args: [m.addr, S.account] }).catch(() => null)),
  ]);
  S.balance = wad(bal);
  ms.forEach((m, i) => { m.pos = pos[i] ? { yes: wad(pos[i][0]), no: wad(pos[i][1]) } : null; });
  renderWallet();
}

// FeedObserved holds the feed price used for the result and the tx. Try one wide query,
// then fall back to recent 5,000-block windows (public RPCs limit log ranges).
async function loadObserved(m) {
  if (m.observed || m.phase < PH.RESOLVED) return;
  const from = BigInt(m.cfg.block ?? cfg.deployBlock ?? 0);
  const q = (fromBlock, toBlock) => pub.getLogs({ address: cfg.adjudicator, event: FEED_OBSERVED, args: { market: m.addr }, fromBlock, toBlock });
  let logs = null;
  try { logs = await q(from, 'latest'); } catch {
    const latest = S.block ?? await pub.getBlockNumber();
    for (let i = 0n, to = latest; i < 20n && to >= from; i++, to -= 5000n) {
      const lo = to - 4999n > from ? to - 4999n : from;
      try { const l = await q(lo, to); if (l.length) { logs = l; break; } } catch { break; }
    }
  }
  const l = logs?.at(-1);
  if (l) m.observed = { price: wad(l.args.priceWad), ts: Number(l.args.publishedAt), outcome: Number(l.args.outcome), tx: l.transactionHash };
}

// ── Rendering ────────────────────────────────────────────────────────
const marketsOf = (asset) => [...S.markets.values()].filter((m) => m.asset === asset);
const protectable = (asset) => marketsOf(asset).filter((m) => isBelow(m.kind) && live(m)).sort((a, b) => b.strike - a.strike);
const assetPrice = (asset) => {
  const ms = marketsOf(asset).filter((m) => m.price != null).sort((a, b) => b.priceTs - a.priceTs);
  return ms[0] ? { price: ms[0].price, ts: ms[0].priceTs, source: ms[0].source, feed: ms[0].feed, feedId: ms[0].feedId } : null;
};
const assetReport = (asset) => marketsOf(asset).map((m) => m.report).filter(Boolean).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0] ?? null;

function renderAll() {
  renderAssetSelect();
  renderForm();
  renderAsset();
  renderLadder();
  renderTrader();
  renderAgent();
  renderSettled();
  renderMine();
}

function renderAssetSelect() {
  const sel = $('#asset');
  const assets = [...new Set([...S.markets.values()].filter(live).map((m) => m.asset))]
    .sort((a, b) => protectable(b).length - protectable(a).length || a.localeCompare(b));
  if (!S.asset || !assets.includes(S.asset)) S.asset = assets.find((a) => protectable(a).length) ?? assets[0] ?? null;
  const html = assets.map((a) => `<option value="${esc(a)}"${a === S.asset ? ' selected' : ''}>${esc(a)}</option>`).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.disabled = !assets.length;
  // Keep the selected market inside the asset.
  const sm = S.markets.get(S.sel);
  if (!sm || sm.asset !== S.asset || !live(sm)) S.sel = defaultMarket(S.asset)?.addr ?? null;
}

function defaultMarket(asset) {
  const ps = protectable(asset);
  const ap = assetPrice(asset);
  // The highest level below today's price: the closest useful protection.
  return (ap && ps.find((m) => m.strike < ap.price)) ?? ps[0] ?? marketsOf(asset).find(live) ?? null;
}

function renderForm() {
  const m = S.markets.get(S.sel);
  const ps = protectable(S.asset);
  const strikeSel = $('#strike');
  const html = ps.map((x) => `<option value="${esc(x.addr)}"${x.addr === S.sel ? ' selected' : ''}>${usd(x.strike)}${isTouch(x.kind) ? ' (touch)' : ''}</option>`).join('');
  if (strikeSel.innerHTML !== html) strikeSel.innerHTML = html;
  strikeSel.disabled = !ps.length;
  const ap = assetPrice(S.asset);
  const qty = Number($('#qty').value);
  $('#worth').textContent = ap && qty > 0 ? `worth ${usd(qty * ap.price)}` : '';
  $('#until').textContent = m ? when(m.deadline) : '-';
  $('#paidBy').textContent = m ? `Paid out automatically from the ${SRC_LONG[m.source]} price.` : 'Paid out automatically from the oracle price.';
  if (!S.markets.size) return formEmpty('Loading markets.');
  if (!ps.length) return formEmpty(S.asset ? `No open protection for ${S.asset} right now.` : 'No open markets right now.');
  if (!m || !isBelow(m.kind)) return formEmpty('This level is for traders. Pick a level from the list.');
  scheduleQuote();
}

function formEmpty(msg) {
  setQuoteView(null);
  setMsg('#formMsg', msg);
  $('#protectBtn').disabled = true;
}

function protectPlan() {
  const m = S.markets.get(S.sel);
  const ap = assetPrice(S.asset);
  const qty = Number($('#qty').value);
  if (!m || !ap || !isBelow(m.kind)) return { err: 'No level selected.' };
  if (!(qty > 0)) return { err: 'Enter how many you hold.', m };
  const gap = ap.price - m.strike;
  if (gap <= 0) return { err: `${m.asset} is already at or below ${usd(m.strike)}. Pick a lower level.`, m };
  const shares = ceil2(qty * gap);
  if (shares < 0.01) return { err: 'The amount is too small. Hold more or pick a lower level.', m };
  return { m, qty, spot: ap.price, gap, shares };
}

let quoteTimer = null, quoteSeq = 0;
function scheduleQuote() {
  if (dialogOpen()) return; // the dialog shows a frozen quote
  clearTimeout(quoteTimer);
  const plan = protectPlan();
  if (plan.err) { setQuoteView(null, plan); setMsg('#formMsg', plan.err); $('#protectBtn').disabled = true; return; }
  setQuoteView('loading', plan);
  quoteTimer = setTimeout(() => quote(plan), 220);
}

async function quote(plan) {
  const seq = ++quoteSeq;
  try {
    const q = await pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPositionQuote', args: [plan.m.addr, 1, parseUnits(plan.shares.toFixed(2), 18)] });
    if (seq !== quoteSeq) return;
    S.quote = { ...plan, cost: q[0], fee: q[1], net: q[2], newPrice: q[3] };
    setQuoteView('ok', S.quote);
    validateQuote();
  } catch (e) {
    if (seq !== quoteSeq) return;
    S.quote = null;
    setQuoteView(null, plan);
    setMsg('#formMsg', /Domain|overflow/i.test(String(e?.message)) ? 'This market is not deep enough for that size. Hold less or pick a lower level.' : `No quote: ${humanError(e)}`, 'err');
    $('#protectBtn').disabled = true;
  }
}

function validateQuote() {
  const q = S.quote;
  if (!q) return;
  const pay = wad(q.net);
  let msg = '', bad = false;
  if (pay > MAX_TRADE) { msg = `That is above the ${usd(MAX_TRADE, 0)} limit per trade. Lower the amount or pick a lower level.`; bad = true; }
  else if (S.account && S.balance != null && S.balance < pay * (1 + Number(SLIP_BPS) / 1e4)) { msg = `You have ${usd(S.balance)} hUSD-DEMO. Get hUSD-DEMO first.`; }
  setMsg('#formMsg', msg, bad ? 'err' : '');
  $('#protectBtn').disabled = bad || !live(q.m);
}

function setQuoteView(state, p) {
  const pay = $('#pay'), get = $('#get');
  pay.classList.toggle('loading', state === 'loading');
  if (p?.shares) {
    get.textContent = usd(p.shares);
    $('#getSub').textContent = ifText(p.m);
    $('#calc').innerHTML = `This covers what your holding loses if the price falls to your level: <span class="mono">${esc(fmtQty(p.qty))} ${esc(p.m.asset)} × (${usd(p.spot)} − ${usd(p.m.strike)})</span>.`;
  } else {
    get.textContent = '-'; $('#getSub').innerHTML = '&nbsp;'; $('#calc').textContent = '';
  }
  if (state === 'ok') {
    const net = wad(p.net);
    pay.textContent = usd(net);
    $('#paySub').textContent = `${cents(net / p.shares)} per $1 of cover, fee included`;
  } else if (state === 'loading') {
    pay.innerHTML = '<span class="skel" aria-label="Getting a quote"></span>';
    $('#paySub').textContent = 'Getting a live quote';
  } else {
    pay.textContent = '-'; $('#paySub').innerHTML = '&nbsp;';
  }
}
const fmtQty = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });

function renderAsset() {
  const a = S.asset, ap = a && assetPrice(a), m = S.markets.get(S.sel);
  $('#aName').textContent = a ?? '-';
  $('#lAsset').textContent = a ?? '-';
  if (!ap) {
    $('#aSrc').textContent = ''; $('#aPrice').textContent = '-'; $('#aAge').textContent = a ? 'No feed price.' : '';
  } else {
    $('#aSrc').innerHTML = `· ${ap.source === 0 ? `${link(addrUrl(ap.feed), 'Atlas Oracle')} feed ${parseInt(ap.feedId, 16)}` : link(addrUrl(ap.feed), 'Chainlink feed')}`;
    $('#aPrice').textContent = usd(ap.price);
    $('#aAge').textContent = `${SRC_LONG[ap.source]} price, published ${ago(ap.ts)}`;
  }
  const r = a && assetReport(a);
  const c = r?.inputs?.cmc;
  $('#aChg').innerHTML = c && (c.pct24h != null || c.pct7d != null)
    ? `<span class="cap">CoinMarketCap</span>${[['24h', c.pct24h], ['7d', c.pct7d], ['30d', c.pct30d]].map(([k, v]) => `<dt>${k}</dt><dd class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${signed(v)}</dd>`).join('')}`
    : '';
  drawRuler();
  // Rule box.
  if (!m) { $('#beat').textContent = '-'; $('#rule').textContent = ''; $('#beatActions').innerHTML = ''; return; }
  $('#beat').textContent = usd(m.strike);
  $('#rule').textContent = ruleText(m, true);
  $('#beatActions').innerHTML = `${link(addrUrl(m.addr), 'Market contract')}${settleButtons(m)}`;
}

function settleButtons(m) {
  const s = settleState(m);
  if (s.kind === 'propose') return `<span>${s.why === 'touch' ? 'The feed touched the level.' : 'Time is over.'} Anyone can settle: <button class="btn-link" data-act="propose" data-m="${esc(m.addr)}">Settle from feed</button></span>`;
  if (s.kind === 'finalize') return `<span>The feed result is in. Anyone can finalize: <button class="btn-link" data-act="finalize" data-m="${esc(m.addr)}">Finalize</button></span>`;
  return '';
}

function drawRuler() {
  const svg = $('#rulerSvg'), cap = $('#rulerCap');
  const a = S.asset, ap = a && assetPrice(a);
  const ms = a ? marketsOf(a).filter(live) : [];
  const m = S.markets.get(S.sel);
  if (!ap || !ms.length) { svg.innerHTML = ''; cap.textContent = ''; $('#ruler').hidden = true; return; }
  $('#ruler').hidden = false;
  const W = Math.max(280, svg.clientWidth || 480), H = 96, axisY = 54, padX = 8;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  // 1σ band to the market time, from the agent's volatility. Only when a report has it.
  const r = m?.report ?? assetReport(a);
  const sigma = num(r?.inputs?.cmc?.sigma);
  const T = m ? Math.max(0, m.deadline - S.now) / (365 * 86400) : 0;
  const band = sigma && T > 0 ? [ap.price * Math.exp(-sigma * Math.sqrt(T)), ap.price * Math.exp(sigma * Math.sqrt(T))] : null;
  const vals = [ap.price, ...ms.map((x) => x.strike), ...(band ?? [])];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || ap.price * 0.02) * 0.08; lo -= pad; hi += pad;
  const x = (v) => padX + ((v - lo) / (hi - lo)) * (W - 2 * padX);
  const parts = [];
  if (band) parts.push(`<rect class="band" x="${x(band[0])}" y="${axisY + 11}" width="${x(band[1]) - x(band[0])}" height="5" rx="2.5"/>`);
  if (m && isBelow(m.kind)) parts.push(`<rect class="zone" x="${padX}" y="${axisY - 9}" width="${Math.max(0, x(m.strike) - padX)}" height="18"/>`);
  if (m && !isBelow(m.kind)) parts.push(`<rect class="zone" x="${x(m.strike)}" y="${axisY - 9}" width="${Math.max(0, W - padX - x(m.strike))}" height="18"/>`);
  parts.push(`<line class="axis" x1="${padX}" x2="${W - padX}" y1="${axisY}" y2="${axisY}"/>`);
  const placed = [];
  const sorted = [...ms].sort((p, q) => (p.addr === S.sel) - (q.addr === S.sel)).reverse();
  for (const s of sorted) {
    const sx = x(s.strike), isSel = s.addr === S.sel;
    if (isSel) {
      parts.push(`<line class="sel" x1="${sx}" x2="${sx}" y1="${axisY - 16}" y2="${axisY + 16}"/>`);
      parts.push(`<text class="sel-lbl" x="${sx}" y="${axisY + 34}" text-anchor="${anchor(sx, W)}">Your level ${usd(s.strike)}</text>`);
      placed.push([sx - 70, sx + 70]);
    } else {
      parts.push(`<line class="tick" x1="${sx}" x2="${sx}" y1="${axisY - 6}" y2="${axisY + 6}"/>`);
      if (!placed.some(([l, h]) => sx > l - 24 && sx < h + 24)) {
        parts.push(`<text class="lbl" x="${sx}" y="${axisY + 34}" text-anchor="${anchor(sx, W)}">${usd(s.strike, 0)}</text>`);
        placed.push([sx - 24, sx + 24]);
      }
    }
  }
  const px = x(ap.price);
  parts.push(`<circle class="spot" cx="${px}" cy="${axisY}" r="5"/>`);
  parts.push(`<text class="lbl-strong" x="${px}" y="${axisY - 22}" text-anchor="${anchor(px, W)}">${usd(ap.price)} now</text>`);
  svg.innerHTML = `<title id="rulerTitle">Current price ${usd(ap.price)} and protection levels</title>${parts.join('')}`;
  const bits = [];
  if (m) {
    const move = (m.strike / ap.price - 1) * 100;
    bits.push(isBelow(m.kind)
      ? (move < 0 ? `Pays out after a ${Math.abs(move).toFixed(1)}% fall.` : 'The price is already at or below this level.')
      : (move > 0 ? `Pays YES after a ${move.toFixed(1)}% rise.` : 'The price is already at or above this level.'));
    bits.push('Shaded red: the payout zone.');
  }
  if (band) bits.push(`Yellow bar: 1σ range to ${when(m.deadline).replace(/, \d\d:\d\d UTC/, '')} from ${(sigma * 100).toFixed(0)}% volatility (${sigmaText(r.inputs.cmc)}).`);
  cap.textContent = bits.join(' ');
}
const anchor = (x, W) => (x < 60 ? 'start' : x > W - 60 ? 'end' : 'middle');

function actionPill(r) {
  const a = r?.decision?.action;
  if (!a) return '<span class="muted">-</span>';
  if (a === 'BUY_YES') return '<span class="pill buy">Buy YES</span>';
  if (a === 'BUY_NO') return '<span class="pill sell">Buy NO</span>';
  return '<span class="pill">Hold</span>';
}

function renderLadder() {
  const tb = $('#ladder tbody');
  const ms = S.asset ? marketsOf(S.asset).filter(live).sort((a, b) => b.strike - a.strike || a.kind - b.kind) : [];
  const ap = S.asset && assetPrice(S.asset);
  const dls = [...new Set(ms.map((m) => m.deadline))];
  $('#lWhen').textContent = dls.length === 1 ? `Until ${when(dls[0])}` : dls.length ? `${dls.length} end times` : '';
  if (!ms.length) { tb.innerHTML = `<tr><td colspan="7" class="empty">${S.markets.size ? 'No open levels for this asset.' : 'Loading levels.'}</td></tr>`; return; }
  tb.innerHTML = ms.map((m) => {
    const d = m.report?.decision;
    const dist = ap ? (m.strike / ap.price - 1) * 100 : null;
    const you = m.pos && (m.pos.yes > 0 || m.pos.no > 0) ? `${m.pos.yes > 0 ? usd(m.pos.yes) : ''}${m.pos.no > 0 ? `<span class="gap-note">${m.pos.no.toFixed(2)} NO</span>` : ''}` : '<span class="muted">-</span>';
    const fair = d?.pModel, cour = d?.pCournot;
    const gap = fair != null && m.yes != null ? fair - m.yes : null;
    return `<tr tabindex="0" data-m="${esc(m.addr)}" aria-selected="${m.addr === S.sel}">
      <td><span class="lvl">${usd(m.strike)}</span><span class="kind">${KIND_NAME[m.kind]}${dls.length > 1 ? `, ${when(m.deadline)}` : ''}</span></td>
      <td class="c-dist mono">${dist == null ? '-' : signed(dist, 1)}</td>
      <td class="r">${cents(m.yes)}</td>
      <td class="r">${cents(fair)}${gap != null && Math.abs(gap) >= 0.005 ? `<span class="gap-note">${gap > 0 ? '+' : '−'}${Math.abs(gap * 100).toFixed(1)}¢</span>` : ''}</td>
      <td class="r">${cour == null ? '<span class="muted">-</span>' : pct(cour)}</td>
      <td>${actionPill(m.report)}</td>
      <td class="r c-you">${S.account ? you : '<span class="muted">-</span>'}</td>
    </tr>`;
  }).join('');
}

function renderTrader() {
  const m = S.markets.get(S.sel);
  $('#tMarket').textContent = m ? `${m.question} · ${short(m.addr)}` : 'No market selected.';
  $('#tBuy').disabled = !m || !live(m);
  $('#tState').innerHTML = m ? `
    <dt>Rule</dt><dd style="font-family:var(--sans)">${esc(ruleText(m))}</dd>
    <dt>YES price</dt><dd>${cents(m.yes)}</dd>
    <dt>Shares out</dt><dd>${m.qYes != null ? `${wad(m.qYes).toFixed(2)} YES / ${wad(m.qNo).toFixed(2)} NO` : '-'}</dd>
    ${m.pos ? `<dt>You hold</dt><dd>${m.pos.yes.toFixed(2)} YES / ${m.pos.no.toFixed(2)} NO</dd>` : ''}` : '';
  traderQuote();
}

let tSeq = 0;
async function traderQuote() {
  const m = S.markets.get(S.sel);
  const n = Number($('#tShares').value), side = Number($('input[name=side]:checked').value);
  const seq = ++tSeq;
  if (!m || !(n > 0)) { $('#tQuote').textContent = ''; return; }
  try {
    const q = await pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPositionQuote', args: [m.addr, side, parseUnits(String(n), 18)] });
    if (seq === tSeq) $('#tQuote').textContent = `cost ${usd(wad(q[2]))}, YES price after ${cents(wad(q[3]))}`;
  } catch (e) { if (seq === tSeq) $('#tQuote').textContent = `no quote: ${humanError(e)}`; }
}

// Plain words for where the volatility came from. Honest: a default is a guess, not data.
function sigmaText(c) {
  if (c.sigmaSource === 'realized_1d_candles') return `realized, ${num(c.candles?.count) ?? 30} daily CMC DEX candles`;
  if (c.sigmaSource === 'default') return 'fixed default for this asset, no CMC candles';
  return c.sigmaSource ? String(c.sigmaSource) : '';
}

function renderAgent() {
  const m = S.markets.get(S.sel);
  const r = m?.report;
  const body = $('#agBody');
  if (!r) {
    $('#agWhen').textContent = '';
    body.innerHTML = `<p class="empty">${m ? 'No agent report for this level yet. The agent writes one each run.' : 'Pick a level to see the agent.'}</p>`;
    return;
  }
  const d = r.decision ?? {}, inp = r.inputs ?? {}, c = inp.cmc ?? {}, p = d.params ?? {};
  const calls = Array.isArray(c.calls) ? c.calls.length : 0;
  const cmcMode = c.mode === 'keyed' ? `CMC keyed, ${calls} call${calls === 1 ? '' : 's'}` : c.mode === 'keyless' ? `CMC keyless, ${calls} call${calls === 1 ? '' : 's'}` : '';
  const block = num(r.proof?.block);
  $('#agWhen').textContent = [
    r.generatedAt ? `Report ${when(Date.parse(r.generatedAt) / 1000)}` : 'Report',
    r.mode ? (r.mode === 'dry-run' ? 'dry run' : String(r.mode)) : '',
    block != null ? `block #${block.toLocaleString('en-US')}` : '',
    cmcMode,
  ].filter(Boolean).join(' · ');
  const stale = (d.alerts ?? []).some((a) => (a?.code ?? a) === 'FEED_STALE');
  let say, why;
  if (d.action === 'BUY_YES') { say = 'Protection is cheap. The agent buys it.'; why = `Market ${cents(num(d.pSooth))}, fair ${cents(num(d.pStar))} per $1.`; }
  else if (d.action === 'BUY_NO') { say = 'Protection is expensive. The agent sells it.'; why = `Market ${cents(num(d.pSooth))}, fair ${cents(num(d.pStar))} per $1.`; }
  else if (stale) { say = 'The feed is old. The agent holds.'; why = `${d.reason ?? ''} Atlas stock feeds pause when the stock market is closed, at night and on weekends.`; }
  else if (d.action === 'HOLD' && d.preImpact) { say = 'The trade would use up the edge. The agent holds.'; why = d.reason ?? ''; }
  else if (d.action === 'HOLD') { say = 'The price is fair. The agent holds.'; why = `Market ${cents(num(d.pSooth))}, fair ${cents(num(d.pStar))}. The gap is under ${pct(num(p.edgeThreshold), 0)}.`; }
  else { say = 'No decision in this report.'; why = ''; }
  const fg = c.fearGreed ?? {};
  const fgv = num(fg.value);
  const risk = num(d.risk) ?? num(inp.model?.risk?.score);
  const cspot = num(c.spot), fspot = num(inp.spot);
  const div = cspot && fspot ? (cspot / fspot - 1) * 100 : null;
  const g = c.global ?? {};
  const dom = num(g.btcDominance), capChg = num(g.marketCapChange24hPct);
  // Every value goes through esc(). Numbers are formatted first, so a bad report shows "-".
  const metric = (k, v, extra = '', meter = null) => `<div class="metric"><dt>${esc(k)}</dt><dd>${esc(v)}${extra ? `<small>${esc(extra)}</small>` : ''}</dd>${num(meter) != null ? `<div class="meter" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, meter))}%"></i></div>` : ''}</div>`;
  const w = num(p.cournotWeight) ?? 0.6;
  const blend = num(d.pCournot) != null
    ? `fair = ${w} × Cournot ${pct(num(d.pCournot))} + ${(1 - w).toFixed(1)} × model ${pct(num(d.pModel))} = ${pct(num(d.pStar))}`
    : `fair = model ${pct(num(d.pModel))}  (Cournot: ${inp.cournot?.state ?? 'none'})`;
  const sent = [r.tx?.sent?.trade, r.tx?.hash].find(isHash);
  const ev = Array.isArray(r.evidence?.lines) ? r.evidence.lines : [];
  body.innerHTML = `
    <p class="say">${esc(say)}<small>${esc(why)}</small></p>
    <dl class="metrics">
      ${metric('Fear & Greed (CMC)', fgv ?? '-', typeof fg.classification === 'string' ? fg.classification : '', fgv)}
      ${metric('Volatility, yearly', num(c.sigma) != null ? pct(c.sigma, 0) : '-', sigmaText(c))}
      ${metric('Risk score', risk != null ? `${Math.round(risk)}/100` : '-', risk != null && risk >= (num(p.highRisk) ?? 70) ? 'high' : '', risk)}
      ${metric('CMC vs feed', cspot != null ? usd(cspot) : '-', div != null ? `${signed(div)} from feed` : '')}
      ${metric('BTC dominance (CMC)', dom != null ? `${dom.toFixed(1)}%` : '-', 'share of all crypto')}
      ${metric('Crypto market cap, 24h', capChg != null ? signed(capChg) : '-', 'CMC global data')}
      ${metric('Edge', num(d.edge) != null ? signed(d.edge * 100, 1) : '-', num(p.edgeThreshold) != null ? `acts above ${pct(p.edgeThreshold, 0)}` : '')}
      ${metric('Size', num(d.sizeUsd) ? usd(d.sizeUsd) : '$0', num(p.bankroll) ? `of ${usd(p.bankroll, 0)} bankroll` : '')}
    </dl>
    <p class="blend">${esc(blend)}</p>
    ${(d.alerts ?? []).length ? `<ul class="alerts">${d.alerts.map((a) => `<li><b>${esc(a?.code ?? '')}</b>${esc(a?.message ?? a)}</li>`).join('')}</ul>` : ''}
    ${sent ? `<p class="small">Agent trade: ${link(txUrl(sent), short(sent))}</p>` : ''}
    ${ev.length ? `<details class="evidence"><summary>Cournot evidence (${ev.length})</summary><ul>${ev.map((e) => typeof e === 'string' ? `<li>${esc(e)}</li>` : `<li>${e?.url ? link(e.url, e.source ?? e.title ?? e.url) : esc(e?.source ?? e?.text ?? '')}${e?.summary ? `: ${esc(e.summary)}` : ''}</li>`).join('')}</ul></details>` : ''}`;
}

function renderSettled() {
  const list = $('#setList');
  const ms = [...S.markets.values()].filter(finished).sort((a, b) => b.deadline - a.deadline);
  if (!S.markets.size) { list.innerHTML = '<li class="empty">Loading.</li>'; return; }
  if (!ms.length) {
    const next = [...S.markets.values()].map((m) => m.deadline).sort((a, b) => a - b)[0];
    list.innerHTML = `<li class="empty">Nothing settled yet.${next ? ` The first market ends ${when(next)}.` : ''}</li>`;
    return;
  }
  list.innerHTML = ms.map((m) => {
    const s = settleState(m), o = m.observed;
    const status = { settled: ['done', `Settled ${OUTCOME[m.outcome] ?? ''}`], veto: ['wait', `Veto window ${span(s.left)}`], finalize: ['wait', 'Ready to finalize'], propose: ['wait', 'Ready to settle'], waitfeed: ['', 'Waiting for price'], disputed: ['', 'Vetoed'], open: ['', 'Open'] }[s.kind];
    const out = m.settled || m.phase >= PH.RESOLVED ? m.outcome : null;
    let line = '';
    if (o) {
      const res = out === 1 ? 'the level was hit. Each protection share pays $1, paid out automatically on claim.' : out === 0 ? `the price stayed ${isBelow(m.kind) ? 'above' : 'below'} ${usd(m.strike)}. Protection did not pay.` : 'no price in time. Each share pays $0.50.';
      line = `${SRC[m.source]} price <span class="mono">${usd(o.price)}</span> at ${when(o.ts)}. Result <b>${OUTCOME[o.outcome]}</b>: ${res}`;
    } else if (out != null) line = `Result <b>${OUTCOME[out]}</b>.`;
    else if (s.kind === 'propose') line = touchHit(m) ? `${SRC[m.source]} price <span class="mono">${usd(m.price)}</span> touched the level.` : `Time is over. Last ${SRC[m.source]} price <span class="mono">${usd(m.price)}</span>.`;
    else if (s.kind === 'waitfeed') line = `Waiting for the first ${SRC[m.source]} price after ${when(m.deadline)}.`;
    if (s.kind === 'veto') line += ` A guardian can veto until ${when(m.vetoEndsAt)}.`;
    // Claim: payout per contract rules (YES, NO, or half each when void).
    let claim = '';
    if (m.settled && m.pos && (m.pos.yes > 0 || m.pos.no > 0)) {
      const pay = out === 1 ? m.pos.yes : out === 0 ? m.pos.no : (m.pos.yes + m.pos.no) / 2;
      claim = pay > 0 ? `<button class="btn btn-ink btn-sm" data-act="claim" data-m="${esc(m.addr)}">Claim ${usd(pay)}</button>` : '<span class="muted">Your shares did not win.</span>';
    }
    const act = s.kind === 'propose' ? `<button class="btn btn-sm" data-act="propose" data-m="${esc(m.addr)}">Settle from feed</button>`
      : s.kind === 'finalize' ? `<button class="btn btn-sm" data-act="finalize" data-m="${esc(m.addr)}">Finalize</button>` : '';
    return `<li class="set-item">
      <div class="set-top">
        <div><p class="set-q">${esc(m.asset)} ${isBelow(m.kind) ? 'at or below' : 'at or above'} ${usd(m.strike)}</p>
        <span class="set-when">${KIND_NAME[m.kind]} · ${isTouch(m.kind) ? 'before' : 'at'} ${when(m.deadline)}</span></div>
        <span class="status ${status[0]}">${status[1]}</span>
      </div>
      ${line ? `<p class="set-line">${line}</p>` : ''}
      <div class="set-actions">${link(addrUrl(m.feed), 'View feed')}${o ? link(txUrl(o.tx), 'View tx') : ''}${link(addrUrl(m.addr), 'Market')}${claim || act}</div>
    </li>`;
  }).join('');
}

function renderMine() {
  const rows = [...S.markets.values()].filter((m) => m.pos?.yes > 0 && !m.settled && isBelow(m.kind));
  $('#mine').hidden = !rows.length;
  $('#mineList').innerHTML = rows.map((m) => `<li><span>${usd(m.pos.yes)} ${esc(ifText(m))}</span></li>`).join('');
}

function renderWallet() {
  const b = $('#connect');
  b.textContent = S.account ? `${S.balance != null ? `${usd(S.balance)} hUSD-DEMO · ` : ''}${short(S.account)}` : 'Connect wallet';
  b.title = S.account ? S.account : '';
}

function renderFooter() {
  const rows = [['Adjudicator', cfg.adjudicator], ['Sooth AMM', cfg.amm], ['Market factory', cfg.marketFactory], ['hUSD-DEMO (no value)', cfg.stable]];
  $('#contracts').innerHTML = rows.map(([k, a]) => `<dt>${k}</dt><dd>${link(addrUrl(a), short(a))}</dd>`).join('');
}

// setMsg escapes its text. setMsgHtml takes markup built here (links via link()).
function setMsgHtml(sel, html, kind = '') {
  const el = $(sel);
  el.className = `form-msg${kind ? ` ${kind}` : ''}`;
  el.innerHTML = html;
}
function setMsg(sel, text, kind = '') { setMsgHtml(sel, esc(text), kind); }

let toastTimer;
function toast(html, ms = 6000) {
  const t = $('#toast');
  t.innerHTML = html; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function fatal(msg) {
  document.querySelector('main').insertAdjacentHTML('afterbegin', `<p class="form-msg err" role="alert" style="margin-top:24px">${esc(msg)}</p>`);
}

// ── Wallet and transactions ──────────────────────────────────────────
const walletClient = () => createWalletClient({ chain, transport: custom(window.ethereum) });

function resetWallet() {
  S.wallet = null; S.account = null; S.balance = null;
  renderWallet();
}

// Make sure the wallet is on our chain. Ask to switch, add the chain if the wallet does not know
// it, then check again. If the wallet is still elsewhere, stop: never send on the wrong chain.
async function ensureChain() {
  if ((await S.wallet.getChainId()) === chain.id) return;
  try { await S.wallet.switchChain({ id: chain.id }); }
  catch (e) {
    if (/rejected|denied|4001/i.test(`${e?.message} ${e?.code}`)) throw new Error(`Switch your wallet to ${chain.name} to continue.`);
    await S.wallet.addChain({ chain });
  }
  if ((await S.wallet.getChainId()) !== chain.id) throw new Error(`Your wallet is not on ${chain.name}. Switch it and try again.`);
}

async function connect() {
  if (!window.ethereum) throw new Error('No wallet found. Install a browser wallet to trade. You can still read every market.');
  try {
    S.wallet = walletClient();
    [S.account] = await S.wallet.requestAddresses();
    if (!S.account) throw new Error('The wallet gave no account.');
    await ensureChain();
  } catch (e) {
    resetWallet();
    throw e;
  }
  renderWallet();
  await loadPositions();
  renderAll();
}

// Every write goes through here: a wallet client, an account and the right chain, each time.
async function send(address, abi, functionName, args) {
  if (!S.wallet || !S.account) await connect();
  else await ensureChain();
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account: S.account });
  const hash = await S.wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw Object.assign(new Error('The transaction failed.'), { hash });
  return hash;
}

async function ensureAllowance(amount, onStep) {
  const allowance = await pub.readContract({ address: cfg.stable, abi: ERC20, functionName: 'allowance', args: [S.account, cfg.amm] });
  if (allowance >= amount) return null;
  onStep?.('approve');
  return send(cfg.stable, ERC20, 'approve', [cfg.amm, amount]);
}

const withSlip = (net) => (net * (10000n + SLIP_BPS)) / 10000n;

// The order shown in the confirm dialog. Frozen when the dialog opens: the 30 s refresh, a new
// quote or a click on another level cannot change what the buy sends.
let CF = null;
const dialogOpen = () => $('#confirm').open;

async function openConfirm() {
  try { if (!S.wallet || !S.account) await connect(); } catch (e) { setMsg('#formMsg', humanError(e), 'err'); return; }
  const plan = protectPlan();
  if (plan.err) return setMsg('#formMsg', plan.err, 'err');
  clearTimeout(quoteTimer); quoteSeq++; // stop any quote in flight from writing over this one
  const shares = parseUnits(plan.shares.toFixed(2), 18);
  let q;
  try {
    const r = await pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPositionQuote', args: [plan.m.addr, 1, shares] });
    q = { m: plan.m, market: plan.m.addr, sharesNum: plan.shares, shares, cost: r[0], fee: r[1], net: r[2], newPrice: r[3] };
  } catch (e) { return setMsg('#formMsg', `No quote: ${humanError(e)}`, 'err'); }
  if (wad(q.net) > MAX_TRADE) return setMsg('#formMsg', `That is above the ${usd(MAX_TRADE, 0)} limit per trade. Lower the amount or pick a lower level.`, 'err');
  if (!live(q.m)) return setMsg('#formMsg', 'Trading is closed for this level.', 'err');
  q.maxCost = withSlip(q.net);
  const allowance = await pub.readContract({ address: cfg.stable, abi: ERC20, functionName: 'allowance', args: [S.account, cfg.amm] });
  const needApprove = allowance < q.maxCost;
  CF = Object.freeze(q);
  $('#cfWhat').textContent = `You get ${usd(q.sharesNum)} ${ifText(q.m)}. The ${SRC_LONG[q.m.source]} price settles it.`;
  $('#cfRows').innerHTML = `
    <dt>You pay now</dt><dd class="total">${usd(wad(q.net))}</dd>
    <dt>Most you pay</dt><dd>${usd(wad(q.maxCost))} <span class="muted">(${Number(SLIP_BPS) / 100}% slippage)</span></dd>
    <dt>You get</dt><dd>${usd(q.sharesNum)}</dd>
    <dt>Fee, included</dt><dd>${usd(wad(q.fee))}</dd>
    <dt>Market price after</dt><dd>${cents(wad(q.newPrice))}</dd>
    <dt>Limit per trade</dt><dd>${usd(MAX_TRADE, 0)} <span class="muted">(this page)</span></dd>
    <dt>Paid in</dt><dd>hUSD-DEMO, demo money with no value</dd>`;
  $('#cfSteps').innerHTML = `${needApprove ? `<li data-s="approve">Allow the Sooth AMM to take up to ${usd(wad(q.maxCost))} hUSD-DEMO</li>` : ''}<li data-s="buy">Buy ${usd(q.sharesNum)} of protection</li>`;
  setMsg('#cfMsg', '');
  $('#cfGo').disabled = false;
  $('#cfGo').textContent = 'Confirm in wallet';
  $('#confirm').showModal();
}

async function runProtect() {
  const q = CF;
  if (!q) return;
  const go = $('#cfGo');
  go.disabled = true;
  const step = (s) => document.querySelectorAll('#cfSteps li').forEach((li) => {
    li.className = li.dataset.s === s ? 'now' : (s === 'buy' && li.dataset.s === 'approve') || s === 'done' ? 'done' : '';
  });
  try {
    // Quote again now. If the price moved so the most you pay is above what this dialog showed, stop.
    const fresh = await pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPositionQuote', args: [q.market, 1, q.shares] });
    const freshMax = withSlip(fresh[2]);
    if (freshMax > q.maxCost) {
      setMsg('#cfMsg', `The price moved. The most you pay is now ${usd(wad(freshMax))}, above the ${usd(wad(q.maxCost))} shown. Nothing was sent. Close this and get a new quote.`, 'err');
      go.textContent = 'Price moved';
      return;
    }
    await ensureAllowance(q.maxCost, (s) => { step(s); setMsg('#cfMsg', 'Approve in your wallet.'); });
    step('buy'); setMsg('#cfMsg', 'Confirm the purchase in your wallet.');
    // The limit sent is the one shown, never a newer quote.
    const hash = await send(cfg.amm, AMM, 'tradePositions', [q.market, 1, q.shares, q.maxCost]);
    step('done');
    setMsgHtml('#cfMsg', `Protected. ${link(txUrl(hash), 'View tx')}`, 'ok');
    go.textContent = 'Done';
    setTimeout(() => $('#confirm').close(), 1400);
    toast(`Protected: ${usd(q.sharesNum)} ${esc(ifText(q.m))}. ${link(txUrl(hash), 'View tx')}`);
  } catch (e) {
    setMsg('#cfMsg', humanError(e), 'err');
    go.disabled = false; go.textContent = 'Try again';
  }
}

async function traderBuy() {
  const m = S.markets.get(S.sel);
  const n = Number($('#tShares').value), side = Number($('input[name=side]:checked').value);
  if (!m || !(n > 0)) return setMsg('#tMsg', 'Enter a number of shares.', 'err');
  try {
    if (!S.wallet || !S.account) await connect();
    const delta = parseUnits(String(n), 18);
    const q = await pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPositionQuote', args: [m.addr, side, delta] });
    if (wad(q[2]) > MAX_TRADE) return setMsg('#tMsg', `Above the ${usd(MAX_TRADE, 0)} limit per trade.`, 'err');
    const maxCost = withSlip(q[2]);
    await ensureAllowance(maxCost, () => setMsg('#tMsg', 'Approve in your wallet.'));
    setMsg('#tMsg', `Confirm in your wallet. Most you pay: ${usd(wad(maxCost))}.`);
    const hash = await send(cfg.amm, AMM, 'tradePositions', [m.addr, side, delta, maxCost]);
    setMsgHtml('#tMsg', `Bought ${n} ${side ? 'YES' : 'NO'}. ${link(txUrl(hash), 'View tx')}`, 'ok');
    await refresh();
  } catch (e) { setMsg('#tMsg', humanError(e), 'err'); }
}

async function marketAction(act, addr, btn) {
  const m = S.markets.get(addr);
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Confirm in wallet';
  try {
    const hash = act === 'propose' ? await send(cfg.adjudicator, ADJ, 'settleFromFeed', [addr])
      : act === 'finalize' ? await send(cfg.adjudicator, ADJ, 'settle', [addr])
        : await send(cfg.amm, AMM, 'settlePosition', [addr]);
    toast(`${act === 'claim' ? 'Claimed' : act === 'finalize' ? 'Finalized' : 'Settled from the feed'}: ${esc(m.asset)} ${usd(m.strike)}. ${link(txUrl(hash), 'View tx')}`);
    m.observed = null;
    await refresh();
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    toast(esc(humanError(e)));
  }
}

// ── Events ───────────────────────────────────────────────────────────
$('#connect').onclick = () => connect().catch((e) => toast(esc(humanError(e))));
$('#faucet').hidden = !cfg.faucet;
const faucet = async (ev) => {
  const b = ev.currentTarget; b.disabled = true;
  try {
    const hash = await send(cfg.stable, ERC20, 'faucet', []);
    toast(`1,000 hUSD-DEMO sent. ${link(txUrl(hash), 'View tx')}`);
    await loadPositions(); validateQuote();
  } catch (e) { toast(esc(humanError(e))); }
  b.disabled = false;
};
$('#faucet').onclick = faucet;
document.querySelectorAll('[data-faucet]').forEach((b) => { b.hidden = !cfg.faucet; b.onclick = faucet; });
$('#asset').onchange = (e) => { S.asset = e.target.value; S.sel = defaultMarket(S.asset)?.addr ?? null; renderAll(); };
$('#strike').onchange = (e) => { S.sel = e.target.value; renderAll(); };
$('#qty').oninput = () => { renderForm(); };
$('#form').onsubmit = (e) => { e.preventDefault(); openConfirm(); };
$('#cfGo').onclick = runProtect;
$('#confirm').addEventListener('close', () => { CF = null; refresh(); });
$('#tShares').oninput = traderQuote;
document.querySelectorAll('input[name=side]').forEach((r) => { r.onchange = traderQuote; });
$('#tBuy').onclick = traderBuy;
$('#ladder tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-m]');
  if (tr) { S.sel = tr.dataset.m; renderAll(); }
});
$('#ladder tbody').addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-m]');
  if (!tr) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); S.sel = tr.dataset.m; renderAll(); $(`#ladder tr[data-m="${tr.dataset.m}"]`)?.focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) marketAction(b.dataset.act, b.dataset.m, b);
});
// The wallet client is made here too, so a later send() never meets an account without a wallet.
window.ethereum?.on?.('accountsChanged', (a) => {
  if (!a?.[0]) { resetWallet(); renderAll(); return; }
  S.account = a[0];
  S.wallet ??= walletClient();
  loadPositions().then(renderAll).catch(() => {});
});
window.ethereum?.on?.('chainChanged', () => location.reload());
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawRuler, 120); });

// ── Start ────────────────────────────────────────────────────────────
async function refresh() {
  if (dialogOpen()) return; // paused while the confirm dialog is open; runs again on close
  try {
    await refreshChain();
    await loadMarkets();
    await Promise.all([...S.markets.values()].filter((m) => m.phase >= PH.RESOLVED).map((m) => loadObserved(m).catch(() => {})));
    renderAll();
  } catch (e) {
    $('#net .dot').className = 'dot err';
    $('#block').textContent = 'RPC error';
    if (!S.markets.size) {
      $('#setList').innerHTML = `<li class="empty">Cannot reach the chain: ${esc(humanError(e))}</li>`;
      formEmpty('Cannot reach the chain. The page will try again.');
    }
  }
}

renderFooter();
pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'vetoPeriod' })
  .then((v) => { S.vetoPeriod = Number(v); $('#vetoMin').textContent = span(Number(v)); $('#vetoNote').hidden = !(S.vetoPeriod > 0); }).catch(() => {});
if (!cfg.markets?.length) formEmpty('No markets yet.');
await refresh();
setInterval(refresh, 30_000);
