// Sooth Hedge page. All numbers come from the chain (config.json lists the markets) or from
// the risk agent's reports (reports/<market>.json). If a value is missing, the page says so.
import {
  createPublicClient, createWalletClient, custom, http, parseAbi, parseAbiItem, formatUnits, parseUnits, defineChain, toHex,
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
  'function decimals() view returns (uint8)',
]);
// Chainlink proxy, for BNB price history (past rounds are on chain).
const CL = parseAbi([
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)',
  'function decimals() view returns (uint8)',
]);
// Atlas MultiFeed writes one event per update batch. Data is packed 20-byte records:
// feed id (uint32), published time (uint48), price (uint80, 18 decimals). Checked against readFeed.
const ATLAS_TOPIC = '0x58a4d6b45eb391cba1ac2b4abbd9035b04dbfd83397df64c60716ea15c39af0f';
// The real tokens people hold. Read only, for "Cover my N". BNB is the native coin.
const TOKENS_56 = { IWMB: '0x5e0ec7c48f2da6d8db1a2c95d71c535bf8a77c41', EWZB: '0xb17d6ec90fd85315cd1bbcd330c3ebb07dcc822d' };
const HIST_SEC = 6 * 3600, HIST_N = 24, ATLAS_WIN = 200n; // 24 small log windows over 6 h

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
// Log reads go to an RPC that allows eth_getLogs. Read only.
const LOG_RPC = cfg.logRpc ?? (cfg.chainId === 56 ? 'https://bsc-rpc.publicnode.com' : cfg.rpc);
const logPub = LOG_RPC === cfg.rpc ? pub : createPublicClient({ chain, transport: http(LOG_RPC) });
const TOKENS = { ...(cfg.chainId === 56 ? TOKENS_56 : {}), ...(cfg.tokens ?? {}) };

const S = {
  now: Math.floor(Date.now() / 1000), // chain time from the latest block
  block: null,
  markets: new Map(), // address -> market view
  asset: null,
  end: null, // selected deadline
  sel: null, // selected market address: the floor level
  mode: 'one', // 'one' level or 'stair'
  amount: 500, // payout in hUSD-DEMO
  cover: null, // token amount when "Cover my N" is on
  account: null, wallet: null, balance: null,
  hold: {}, // asset -> real token balance of the wallet
  hist: new Map(), // feed key -> { state, pts: [[ts, price]] }
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
  await loadHoldings();
  renderWallet();
}

// What the wallet really holds of each asset. Never a typed or guessed amount.
async function loadHoldings() {
  const hold = {};
  const tok = Object.entries(TOKENS);
  const res = await Promise.all([
    ...tok.map(([, t]) => Promise.all([
      pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [S.account] }),
      pub.readContract({ address: t, abi: ERC20, functionName: 'decimals' }),
    ]).catch(() => null)),
    pub.getBalance({ address: S.account }).catch(() => null),
  ]);
  tok.forEach(([a], i) => { if (res[i]) hold[a] = Number(formatUnits(res[i][0], Number(res[i][1]))); });
  const bnb = res.at(-1);
  if (bnb != null && cfg.chainId === 56) hold.BNB = Number(formatUnits(bnb, 18));
  S.hold = hold;
}

// ── Price history (real feed data only) ──────────────────────────────
const histKey = (ap) => `${ap.source}:${ap.feed.toLowerCase()}:${ap.feedId}`;

async function pool(items, n, fn) {
  let i = 0, ok = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const it = items[i++]; try { await fn(it); ok++; } catch { /* one window can fail */ } }
  }));
  return ok;
}

function decodeAtlas(data, id) {
  const d = String(data ?? '').slice(2), out = [];
  if (!/^[0-9a-fA-F]*$/.test(d) || d.length % 40) return out;
  for (let i = 0; i < d.length; i += 40) {
    if (parseInt(d.slice(i, i + 8), 16) !== id) continue;
    out.push([parseInt(d.slice(i + 8, i + 20), 16), wad(BigInt(`0x${d.slice(i + 20, i + 40)}`))]);
  }
  return out;
}

// Sample 24 short block windows over the last 6 h. Each window holds about one update per feed.
async function atlasHistory(ap) {
  const id = parseInt(ap.feedId, 16);
  const latest = await logPub.getBlockNumber();
  const back = 20000n;
  const [b1, b0] = await Promise.all([logPub.getBlock({ blockNumber: latest }), logPub.getBlock({ blockNumber: latest - back })]);
  const span = HIST_SEC / (Number(b1.timestamp - b0.timestamp) / Number(back));
  const wins = Array.from({ length: HIST_N }, (_, k) => { const to = latest - BigInt(Math.round((span * k) / (HIST_N - 1))); return [to - ATLAS_WIN, to]; });
  const pts = [];
  const ok = await pool(wins, 3, async ([from, to]) => {
    const logs = await logPub.request({ method: 'eth_getLogs', params: [{ address: ap.feed, topics: [ATLAS_TOPIC], fromBlock: toHex(from), toBlock: toHex(to) }] });
    for (const l of logs) pts.push(...decodeAtlas(l.data, id));
  });
  if (!ok) throw new Error('no log reads');
  return pts;
}

async function chainlinkHistory(ap) {
  const rd = (fn, args) => pub.readContract({ address: ap.feed, abi: CL, functionName: fn, args });
  const [lr, dec] = await Promise.all([rd('latestRoundData'), rd('decimals')]);
  const probe = await rd('getRoundData', [lr[0] - 20n]).catch(() => null);
  const perRound = probe ? Math.max(1, (Number(lr[3]) - Number(probe[3])) / 20) : 60;
  const step = BigInt(Math.max(1, Math.round(HIST_SEC / perRound / (HIST_N - 1))));
  const rs = await Promise.all(Array.from({ length: HIST_N }, (_, k) => (lr[0] - step * BigInt(k) > 0n ? rd('getRoundData', [lr[0] - step * BigInt(k)]).catch(() => null) : null)));
  return rs.filter((r) => r && r[1] > 0n && r[3] > 0n).map((r) => [Number(r[3]), Number(formatUnits(r[1], Number(dec)))]);
}

async function loadHistory(asset) {
  const ap = assetPrice(asset);
  if (!ap) return;
  const key = histKey(ap);
  if (S.hist.has(key)) return;
  S.hist.set(key, { state: 'loading', pts: [] });
  let pts = null;
  try { pts = ap.source === 0 ? await atlasHistory(ap) : await chainlinkHistory(ap); } catch { pts = null; }
  if (pts) {
    const by = new Map(pts.filter(([t, p]) => t > 0 && p > 0).map((x) => [x[0], x[1]]));
    pts = [...by].sort((a, b) => a[0] - b[0]).filter(([t]) => t >= S.now - HIST_SEC - 900);
    // The series must end near the live price. If not, drop it: never draw a wrong line.
    const last = pts.at(-1);
    if (last && Math.abs(last[1] / ap.price - 1) > 0.2) pts = [];
  }
  S.hist.set(key, { state: pts == null ? 'err' : pts.length >= 2 ? 'ok' : 'none', pts: pts ?? [] });
  if (S.asset === asset && !drag) drawChart();
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
const protectable = (asset) => marketsOf(asset).filter((m) => m.kind === CLOSE_BELOW && live(m));
const endsOf = (asset) => [...new Set(protectable(asset).map((m) => m.deadline))].sort((a, b) => a - b);
// The snap points of the floor line: open close-below levels for this asset and end time.
const levels = () => protectable(S.asset).filter((m) => m.deadline === S.end).sort((a, b) => b.strike - a.strike);
const assetPrice = (asset) => {
  const ms = marketsOf(asset).filter((m) => m.price != null).sort((a, b) => b.priceTs - a.priceTs);
  return ms[0] ? { price: ms[0].price, ts: ms[0].priceTs, source: ms[0].source, feed: ms[0].feed, feedId: ms[0].feedId } : null;
};
const assetReport = (asset) => marketsOf(asset).map((m) => m.report).filter(Boolean).sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0] ?? null;
const money = (n) => usd(n, n != null && Math.abs(n - Math.round(n)) < 0.005 && Math.abs(n) >= 10 ? 0 : 2);
const SHORT_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const endLabel = (ts) => SHORT_FMT.format(new Date(ts * 1000)).replace(',', '');
const HM_FMT = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const hm = (ts) => HM_FMT.format(new Date(ts * 1000));

// Cournot (AI oracle) chance for a level, when the agent has one.
const cournotOf = (m) => num(m?.report?.decision?.pCournot) ?? num(m?.report?.inputs?.cournot?.probability);

// Plain words for a chance. The market price of a $1 payout is the market's chance.
function oneIn(p) {
  if (p == null || !Number.isFinite(p)) return null;
  if (p >= 0.95) return 'almost sure';
  if (p > 0.5) return `about ${Math.round(p * 10)} in 10`;
  if (p < 0.01) return 'less than 1 in 100';
  return `about 1 in ${Math.round(1 / p)}`;
}

function renderAll() {
  pickDefaults();
  renderSegs();
  drawChart();
  renderPlan();
  renderLadder();
  renderTrader();
  renderAgent();
  renderRule();
  renderSettled();
  renderMine();
}

function pickDefaults() {
  const assets = [...new Set([...S.markets.values()].filter((m) => m.kind === CLOSE_BELOW && live(m)).map((m) => m.asset))];
  const order = ['IWMB', 'EWZB', 'BNB'];
  assets.sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  S.assets = assets;
  if (!S.asset || !assets.includes(S.asset)) S.asset = assets[0] ?? null;
  const ends = S.asset ? endsOf(S.asset) : [];
  // Default end: the one with the most levels, then the latest.
  if (!ends.includes(S.end)) S.end = [...ends].sort((a, b) => protectable(S.asset).filter((m) => m.deadline === b).length - protectable(S.asset).filter((m) => m.deadline === a).length || b - a)[0] ?? null;
  const lv = levels();
  if (!lv.some((m) => m.addr === S.sel)) {
    const ap = assetPrice(S.asset);
    // Default floor: the closest level under today's price.
    S.sel = ((ap && lv.find((m) => m.strike < ap.price)) ?? lv[0])?.addr ?? null;
  }
  if (S.asset) loadHistory(S.asset);
}

function renderSegs() {
  const radio = (name, v, label, on, title = '') => `<label${title ? ` title="${esc(title)}"` : ''}><input type="radio" name="${name}" value="${esc(v)}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  const a = S.assets ?? [];
  const ah = a.length ? a.map((x) => radio('asset', x, x, x === S.asset)).join('') : '<span class="seg-empty"><span class="skel"></span></span>';
  if ($('#assetSeg').innerHTML !== ah) $('#assetSeg').innerHTML = ah;
  const ends = S.asset ? endsOf(S.asset) : [];
  const eh = ends.length ? ends.map((t) => radio('end', t, endLabel(t), t === S.end, `${when(t)}`)).join('') : '<span class="seg-empty"><span class="skel"></span></span>';
  if ($('#endSeg').innerHTML !== eh) $('#endSeg').innerHTML = eh;
  document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === S.mode; });
}

// ── Plan: which levels, how many shares ──────────────────────────────
// One level: shares = payout. Staircase: the payout is split over every level from the price
// now down to the floor, in proportion to the gap between levels, so it grows like a put.
function buildPlan() {
  const f = S.markets.get(S.sel), ap = assetPrice(S.asset);
  if (!S.markets.size) return { err: '' };
  if (!f || !ap) return { err: 'No open level here.' };
  const spot = ap.price;
  let legs = S.mode === 'stair' ? levels().filter((m) => m.strike >= f.strike && m.strike < spot) : [];
  if (!legs.length) legs = [f];
  const stair = legs.length > 1;
  let payout;
  if (S.cover != null) {
    if (f.strike >= spot) return { err: `${S.asset} is already at or below ${usd(f.strike)}. Drag the floor lower.`, f, spot };
    payout = S.cover * (spot - f.strike);
  } else payout = S.amount;
  if (!(payout > 0)) return { err: 'Enter an amount.', f, spot };
  const gap = spot - f.strike;
  let prev = spot;
  // Round each leg down to a cent; the last leg takes the rest, so the full payout is exact.
  const target = ceil2(payout);
  let used = 0;
  legs = legs.map((m, i) => {
    const w = stair ? (prev - m.strike) / gap : 1; prev = m.strike;
    const shares = i === legs.length - 1 ? Math.round((target - used) * 100) / 100 : ceil2(target * w);
    used += shares;
    return { m, shares };
  }).filter((l) => l.shares >= 0.01);
  if (!legs.length) return { err: 'The amount is too small.', f, spot };
  return { f, spot, legs, stair, payout: legs.reduce((s, l) => s + l.shares, 0) };
}
const payAt = (legs, price) => legs.reduce((s, l) => s + (price <= l.m.strike ? l.shares : 0), 0);

let quoteTimer = null, quoteSeq = 0;
function renderPlan() {
  const plan = buildPlan();
  S.plan = plan;
  renderReadout(plan, plan.err ? null : 'loading');
  drawPayout();
  renderAmount(plan);
  if (dialogOpen()) return; // the dialog shows a frozen quote
  clearTimeout(quoteTimer);
  quoteSeq++;
  if (plan.err != null) {
    S.quote = null;
    setMsg('#formMsg', plan.err);
    $('#protectBtn').disabled = true;
    $('#protectBtn').textContent = 'Protect';
    return;
  }
  setMsg('#formMsg', '');
  quoteTimer = setTimeout(() => quote(plan), 250);
}

const quoteLeg = (l) => pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPositionQuote', args: [l.m.addr, 1, parseUnits(l.shares.toFixed(2), 18)] });

async function quote(plan) {
  const seq = ++quoteSeq;
  try {
    const qs = await Promise.all(plan.legs.map(quoteLeg));
    if (seq !== quoteSeq) return;
    const legs = plan.legs.map((l, i) => ({ ...l, cost: qs[i][0], fee: qs[i][1], net: qs[i][2], newPrice: qs[i][3] }));
    S.quote = { ...plan, legs, net: legs.reduce((s, l) => s + l.net, 0n), fee: legs.reduce((s, l) => s + l.fee, 0n) };
    renderReadout(S.quote, 'ok');
    validateQuote();
  } catch (e) {
    if (seq !== quoteSeq) return;
    S.quote = null;
    renderReadout(plan, 'err');
    setMsg('#formMsg', /Domain|overflow/i.test(String(e?.message)) ? 'The market cannot fill that size. Set a smaller amount.' : `No quote: ${humanError(e)}`, 'err');
    $('#protectBtn').disabled = true;
  }
}

function validateQuote() {
  const q = S.quote;
  if (!q) return;
  const pay = wad(q.net);
  let msg = '', bad = false;
  if (pay > MAX_TRADE) { msg = `That costs more than the ${usd(MAX_TRADE, 0)} limit per order. Set a smaller amount.`; bad = true; }
  else if (S.account && S.balance != null && S.balance < pay * (1 + Number(SLIP_BPS) / 1e4)) { msg = `You have ${usd(S.balance)} hUSD-DEMO. Get hUSD-DEMO first.`; }
  setMsg('#formMsg', msg, bad ? 'err' : '');
  const b = $('#protectBtn');
  b.disabled = bad || !q.legs.every((l) => live(l.m));
  b.textContent = `Protect for ${usd(pay)}`;
}

// Count numbers up or down so a change is easy to see. Off for reduced motion.
const calm = matchMedia('(prefers-reduced-motion: reduce)');
function setNum(el, v, fmt) {
  if (v == null) { el.dataset.v = ''; el.textContent = '-'; return; }
  const from = Number(el.dataset.v);
  el.dataset.v = String(v);
  if (calm.matches || !Number.isFinite(from) || el.dataset.v === '' || from === v) { el.textContent = fmt(v); return; }
  const t0 = performance.now(), id = (el._tw = (el._tw ?? 0) + 1);
  const step = (t) => {
    if (el._tw !== id) return;
    const k = Math.min(1, (t - t0) / 220), e = 1 - (1 - k) ** 3;
    el.textContent = fmt(from + (v - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderReadout(p, state) {
  const f = p?.f, legs = p?.legs;
  const pay = $('#roPay'), cost = $('#roCost');
  $('#roPayK').textContent = p?.stair ? 'Pays up to' : 'Pays';
  if (legs) {
    setNum(pay, p.payout, money);
    const low = legs.at(-1).m.strike;
    $('#roPaySub').textContent = `if ${S.asset} ends at or below ${usd(low)} on ${when(f.deadline)}${p.stair ? '. Each level above it pays a part.' : ''}`;
  } else {
    setNum(pay, null);
    $('#roPaySub').textContent = p?.err ?? '';
  }
  cost.classList.toggle('loading', state === 'loading');
  if (state === 'ok') setNum(cost, wad(p.net), (n) => usd(n));
  else if (state === 'loading' && legs) { if (!cost.dataset.v) cost.innerHTML = '<span class="skel" aria-label="Getting a live quote"></span>'; }
  else setNum(cost, null);
  const top = legs?.[0]?.m;
  const ch = oneIn(top?.yes);
  const cc = oneIn(cournotOf(top));
  $('#roChance').textContent = ch ? `The market says ${ch} it pays.${cc ? ` Cournot says ${cc}.` : ''}` : '\u00a0';
  // Staircase legs.
  const ol = $('#legs');
  ol.hidden = !p?.stair;
  if (p?.stair) {
    let acc = 0;
    ol.innerHTML = legs.map((l) => { acc += l.shares; return `<li><span class="mono">${usd(l.m.strike)}</span><span>pays ${money(acc)}</span><span class="mono muted">${l.net != null ? usd(wad(l.net)) : '…'}</span></li>`; }).join('');
  } else ol.innerHTML = '';
  // Tag on the line.
  const tag = $('#tag');
  if (legs) {
    tag.innerHTML = `<b>${esc(p.stair ? 'Up to ' : '')}${esc(money(p.payout))}</b> <span>below ${esc(usd(f.strike, f.strike >= 100 ? 0 : 2))}</span>${state === 'ok' ? ` <span class="tag-c">costs ${esc(usd(wad(p.net)))}</span>` : ''}`;
    tag.hidden = false;
  } else tag.hidden = true;
  updateAria();
}

function renderAmount(p) {
  const n = S.hold[S.asset];
  const b = $('#coverBtn');
  b.hidden = !(S.account && n > 0);
  if (!b.hidden) {
    b.textContent = `Cover my ${fmtQty(n)} ${S.asset}`;
    b.setAttribute('aria-pressed', String(S.cover != null));
  }
  if (S.cover != null && !b.hidden) {
    const amt = $('#amt');
    if (p.payout && document.activeElement !== amt) amt.value = p.payout.toFixed(2);
    $('#amtNote').textContent = p.err ? '' : `Pays what ${fmtQty(S.cover)} ${S.asset} lose from ${usd(p.spot)} down to ${usd(p.f.strike)}.`;
  } else {
    $('#amtNote').textContent = S.account && S.hold[S.asset] === 0 ? `This wallet holds no ${S.asset}. You can still set an amount.` : '';
  }
  document.querySelectorAll('.chip[data-amt]').forEach((c) => c.setAttribute('aria-pressed', String(S.cover == null && Number(c.dataset.amt) === S.amount)));
}
const fmtQty = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 });

// ── Chart: price history, levels, the floor line, payout ─────────────
let CH = null; // scales of the last draw
let drag = false;
const SVGNS = 'http://www.w3.org/2000/svg';

function drawChart() {
  const svg = $('#svg'), plot = $('#plot'), msg = $('#plotMsg');
  const a = S.asset, ap = a && assetPrice(a), lv = levels();
  const W = Math.max(300, Math.round(plot.clientWidth || 600));
  const H = W < 560 ? 300 : W > 760 ? 400 : 360;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  $('#nowK').textContent = a ?? '';
  if (ap) {
    $('#nowP').textContent = usd(ap.price);
    $('#nowAge').textContent = `${SRC_LONG[ap.source]}, ${ago(ap.ts)}`;
  }
  if (!S.markets.size || !ap || !lv.length) {
    CH = null;
    svg.innerHTML = '<title id="svgTitle">Price chart with a floor line</title>';
    msg.hidden = false;
    msg.innerHTML = !S.markets.size ? '<span class="skel skel-w"></span>' : !ap ? 'No feed price for this asset.' : 'No open levels for this end time. Pick another one.';
    $('#chartCap').textContent = '';
    return;
  }
  msg.hidden = true;
  const h = S.hist.get(histKey(ap)) ?? { state: 'loading', pts: [] };
  let pts = h.pts.filter(([t]) => t < ap.ts);
  pts.push([ap.ts, ap.price]);
  const t1 = Math.max(S.now, ap.ts), t0 = t1 - HIST_SEC;
  pts = pts.filter(([t]) => t >= t0);
  const hasHist = h.state === 'ok' && pts.length >= 2;
  $('#chartCap').textContent = h.state === 'loading' ? 'Loading 6 h of feed prices.' : hasHist ? `Last 6 h, ${pts.length} feed prices, UTC.` : 'No feed history found. The chart shows the price now.';

  // Layout: price plot | level labels | payout profile.
  const narrow = W < 480;
  const labW = narrow ? 58 : 66, profW = Math.round(Math.min(150, Math.max(narrow ? 54 : 70, W * (narrow ? 0.17 : 0.2)))), gap = 8;
  const padT = 18, padB = 26;
  const xp1 = W - labW - profW - gap, xq0 = xp1 + labW + gap, xq1 = W - 2;
  const vals = [ap.price, ...lv.map((m) => m.strike), ...pts.map((p) => p[1])];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo || ap.price * 0.02) * 0.12; lo -= pad; hi += pad;
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const x = (t) => 4 + ((t - t0) / (t1 - t0)) * (xp1 - 12);
  const inv = (py) => lo + (1 - (py - padT) / (H - padT - padB)) * (hi - lo);
  CH = { W, H, y, inv, xp1, xq0, xq1, padT, padB, lv, ap };

  const o = [];
  o.push('<title id="svgTitle">Price chart with a floor line</title>');
  o.push(`<defs><clipPath id="clipAll"><rect x="0" y="${padT - 6}" width="${W}" height="${H - padT - padB + 6}"/></clipPath></defs>`);
  o.push(`<line class="frame" x1="${xq0 - gap / 2}" x2="${xq0 - gap / 2}" y1="${padT - 6}" y2="${H - padB}"/>`);
  o.push(`<text class="ax" x="${xq0 + 2}" y="${padT - 6}">Payout</text>`);
  o.push(`<g id="payG" clip-path="url(#clipAll)"></g>`);
  // Level lines and labels.
  for (const m of lv) {
    const yy = y(m.strike);
    o.push(`<line class="lvl-l" x1="0" x2="${xq1}" y1="${yy}" y2="${yy}"/>`);
    o.push(`<text class="lvl-t" data-m="${esc(m.addr)}" x="${xp1 + labW - 6}" y="${yy + 4}" text-anchor="end">${usd(m.strike)}</text>`);
  }
  // Price line.
  if (hasHist) {
    const d = pts.map(([t, p], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(p).toFixed(1)}`).join('');
    o.push(`<path class="px" d="${d}"/>`);
    const ticks = [t0 + HIST_SEC / 6, t0 + HIST_SEC / 2, t0 + (5 * HIST_SEC) / 6];
    for (const t of ticks) o.push(`<text class="ax" x="${x(t)}" y="${H - 8}" text-anchor="middle">${hm(t)}</text>`);
  } else if (h.state === 'loading') {
    o.push(`<rect class="ghost" x="4" y="${y(ap.price) - 1}" width="${xp1 - 16}" height="2" rx="1"/>`);
  } else {
    o.push(`<text class="ax" x="4" y="${H - 8}">${hm(ap.ts)} UTC</text>`);
  }
  // Price now: hairline to its label, and a dot.
  const yN = y(ap.price), xN = hasHist ? x(ap.ts) : xp1 - 12;
  o.push(`<line class="now-l" x1="${xN}" x2="${xp1 + labW - 4}" y1="${yN}" y2="${yN}"/>`);
  o.push(`<circle class="now-d" cx="${xN}" cy="${yN}" r="4.5"/>`);
  o.push(`<text class="now-t" x="${xp1 + labW - 6}" y="${yN - 6}" text-anchor="end">now</text>`);
  // The floor line: a slider.
  o.push(`<rect class="hit" x="0" y="0" width="${W}" height="${H}"/>`);
  o.push(`<g id="floorG" class="floor" role="slider" tabindex="0" aria-orientation="vertical" aria-label="Floor price">
    <line class="fl-halo" x1="0" x2="${xq1}" y1="0" y2="0"/>
    <line class="fl" x1="0" x2="${xq1}" y1="0" y2="0"/>
    <rect class="fl-ring" x="${xp1 - 2}" y="-17" width="${labW + 4}" height="34" rx="17"/>
    <rect class="fl-grab" x="${xp1 + 2}" y="-13" width="${labW - 4}" height="26" rx="13"/>
    <path class="fl-grip" d="M${xp1 + 10},-3h7M${xp1 + 10},3h7"/>
    <text class="fl-t" id="flT" x="${xp1 + labW - 8}" y="4.5" text-anchor="end"></text>
  </g>`);
  svg.innerHTML = o.join('');
  placeFloor(false);
  drawPayout();
  updateAria();
}

function placeFloor(animate = true) {
  const g = $('#floorG'), m = S.markets.get(S.sel);
  if (!g || !CH || !m) return;
  g.classList.toggle('anim', animate && !calm.matches);
  const yy = CH.y(m.strike);
  g.style.transform = `translate(0px, ${yy}px)`;
  $('#flT').textContent = usd(m.strike, m.strike >= 100 ? 0 : 2);
  document.querySelectorAll('#svg .lvl-t').forEach((t) => t.classList.toggle('on', t.dataset.m === S.sel));
  // The tag sits just above the line, or below it near the top.
  const tag = $('#tag');
  const above = yy > 54;
  tag.classList.toggle('anim', animate && !calm.matches);
  tag.style.transform = `translateY(${above ? yy - 36 : yy + 10}px)`;
}

function drawPayout() {
  const g = $('#payG');
  if (!g || !CH) return;
  const p = S.plan, legs = p?.legs;
  if (!legs) { g.innerHTML = ''; return; }
  const { y, xq0, xq1, H, padB, xp1 } = CH;
  const bottom = H - padB;
  const max = p.payout || 1;
  const px = (v) => xq0 + (v / max) * (xq1 - xq0 - 4);
  const o = [];
  // Wash under each step, darker as the payout grows.
  legs.forEach((l, i) => {
    const top = y(l.m.strike), next = legs[i + 1] ? y(legs[i + 1].m.strike) : bottom;
    const share = payAt(legs, l.m.strike) / max;
    o.push(`<rect class="zone" x="0" y="${top}" width="${xp1 - 4}" height="${Math.max(0, next - top)}" style="opacity:${(0.3 + 0.7 * share).toFixed(2)}"/>`);
    o.push(`<rect class="zone-p" x="${xq0}" y="${top}" width="${Math.max(0, px(payAt(legs, l.m.strike)) - xq0)}" height="${Math.max(0, next - top)}"/>`);
  });
  // Step line: payout against end price.
  let d = `M${xq0},${CH.padT - 6}`;
  let cur = xq0;
  legs.forEach((l) => { const yy = y(l.m.strike); d += `L${cur},${yy}`; cur = px(payAt(legs, l.m.strike)); d += `L${cur},${yy}`; });
  d += `L${cur},${bottom}`;
  o.push(`<path class="step" d="${d}"/>`);
  o.push(`<text class="pay-t" x="${xq1 - 2}" y="${bottom - 6}" text-anchor="end">${esc(money(p.payout))}</text>`);
  o.push(`<text class="ax" x="${xq0 + 2}" y="${Math.max(CH.padT + 10, y(legs[0].m.strike) - 6)}">$0</text>`);
  g.innerHTML = o.join('');
}

function updateAria() {
  const g = $('#floorG'), m = S.markets.get(S.sel), lv = CH?.lv ?? [];
  if (!g || !m || !lv.length) return;
  const p = S.plan;
  g.setAttribute('aria-valuemin', String(lv.at(-1).strike));
  g.setAttribute('aria-valuemax', String(lv[0].strike));
  g.setAttribute('aria-valuenow', String(m.strike));
  const cost = S.quote && S.quote.f === p?.f && S.quote.legs?.length === p?.legs?.length ? `, costs ${usd(wad(S.quote.net))}` : '';
  g.setAttribute('aria-valuetext', p?.legs
    ? `Floor ${usd(m.strike)}. Pays ${p.stair ? 'up to ' : ''}${money(p.payout)} if ${S.asset} ends at or below it on ${when(m.deadline)}${cost}.`
    : `Floor ${usd(m.strike)}.`);
}

function setFloor(addr, animate = true) {
  if (!addr || addr === S.sel) return;
  S.sel = addr;
  placeFloor(animate);
  renderPlan();
  renderLadder();
  renderTrader();
  renderAgent();
  renderRule();
}

function stepFloor(dir) {
  const lv = levels(), i = lv.findIndex((m) => m.addr === S.sel);
  const j = Math.max(0, Math.min(lv.length - 1, i + dir));
  setFloor(lv[j]?.addr);
}

function pickAt(clientY) {
  if (!CH) return;
  const r = $('#svg').getBoundingClientRect();
  const py = ((clientY - r.top) / r.height) * CH.H;
  let best = null, bd = Infinity;
  for (const m of CH.lv) { const d = Math.abs(CH.y(m.strike) - py); if (d < bd) { bd = d; best = m; } }
  setFloor(best?.addr);
}

function renderRule() {
  const body = $('#ruleBody');
  const p = S.plan;
  const ms = p?.legs?.map((l) => l.m) ?? (S.markets.get(S.sel) ? [S.markets.get(S.sel)] : []);
  if (!ms.length) { body.innerHTML = '<p class="empty">Pick a level.</p>'; return; }
  body.innerHTML = ms.map((m) => `<div class="rule-i"><p><b class="mono">${usd(m.strike)}</b> ${esc(ruleText(m, true))}</p><p class="rule-a">${link(addrUrl(m.addr), 'Market contract')}${settleButtons(m)}</p></div>`).join('')
    + '<p class="small muted">Each $1 of cover is one share. A share pays 1 hUSD-DEMO if the price ends at or below its level. The feed decides. Nobody votes.</p>';
}

function settleButtons(m) {
  const s = settleState(m);
  if (s.kind === 'propose') return `<span>${s.why === 'touch' ? 'The feed touched the level.' : 'Time is over.'} Anyone can settle: <button class="btn-link" data-act="propose" data-m="${esc(m.addr)}">Settle from feed</button></span>`;
  if (s.kind === 'finalize') return `<span>The feed result is in. Anyone can finalize: <button class="btn-link" data-act="finalize" data-m="${esc(m.addr)}">Finalize</button></span>`;
  return '';
}

function actionPill(r) {
  const a = r?.decision?.action;
  if (!a) return '<span class="muted">-</span>';
  if (a === 'BUY_YES') return '<span class="pill buy">Buys</span>';
  if (a === 'BUY_NO') return '<span class="pill sell">Sells</span>';
  return '<span class="pill">Holds</span>';
}

function renderLadder() {
  const tb = $('#ladder tbody');
  const ms = S.asset ? protectable(S.asset).sort((a, b) => a.deadline - b.deadline || b.strike - a.strike) : [];
  const ap = S.asset && assetPrice(S.asset);
  const dls = [...new Set(ms.map((m) => m.deadline))];
  $('#lAsset').textContent = S.asset ?? '-';
  $('#lWhen').textContent = dls.length === 1 ? `Ends ${when(dls[0])}` : dls.length ? `${dls.length} end times` : '';
  if (!ms.length) { tb.innerHTML = `<tr><td colspan="7" class="empty">${S.markets.size ? 'No open levels for this asset.' : '<span class="skel skel-w"></span>'}</td></tr>`; return; }
  tb.innerHTML = ms.map((m) => {
    const d = m.report?.decision;
    const dist = ap ? (m.strike / ap.price - 1) * 100 : null;
    const you = m.pos && (m.pos.yes > 0 || m.pos.no > 0) ? `${m.pos.yes > 0 ? usd(m.pos.yes) : ''}${m.pos.no > 0 ? `<span class="gap-note">${m.pos.no.toFixed(2)} NO</span>` : ''}` : '<span class="muted">-</span>';
    const fair = d?.pModel, cour = cournotOf(m);
    const inLeg = S.plan?.legs?.some((l) => l.m.addr === m.addr);
    return `<tr tabindex="0" data-m="${esc(m.addr)}" aria-selected="${m.addr === S.sel}"${inLeg && m.addr !== S.sel ? ' class="leg"' : ''}>
      <td><span class="lvl">${usd(m.strike)}</span>${dls.length > 1 ? `<span class="kind">${esc(endLabel(m.deadline))}</span>` : ''}</td>
      <td class="r c-dist mono">${dist == null ? '-' : signed(dist, 1)}</td>
      <td class="r">${cents(m.yes)}</td>
      <td class="r">${cents(fair)}</td>
      <td class="r c-cour">${cour == null ? '<span class="muted">-</span>' : pct(cour)}</td>
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
  if ($('#trader').open) traderQuote();
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
  if (c.sigmaSource === 'cmc_price_changes') return 'from CMC 24h to 90d changes, blended with a prior';
  if (c.sigmaSource === 'default') return 'fixed default, no CMC candles';
  return c.sigmaSource ? String(c.sigmaSource) : '';
}

function renderAgent() {
  const m = S.markets.get(S.sel);
  const r = m?.report;
  const body = $('#agBody');
  if (!r) {
    $('#agWhen').textContent = '';
    body.innerHTML = `<p class="empty">${m ? 'No agent report for this level yet.' : 'Pick a level to see the agent.'}</p>`;
    return;
  }
  const d = r.decision ?? {}, inp = r.inputs ?? {}, c = inp.cmc ?? {}, p = d.params ?? {};
  const calls = Array.isArray(c.calls) ? c.calls : [];
  const block = num(r.proof?.block);
  $('#agWhen').textContent = [
    `${usd(m.strike)} level`,
    r.generatedAt ? when(Date.parse(r.generatedAt) / 1000) : '',
    r.mode === 'dry-run' ? 'dry run' : '',
  ].filter(Boolean).join(' · ');
  const stale = (d.alerts ?? []).some((a) => (a?.code ?? a) === 'FEED_STALE');
  let say;
  if (d.action === 'BUY_YES') say = 'Cover is cheap. The agent buys.';
  else if (d.action === 'BUY_NO') say = 'Cover is dear. The agent sells.';
  else if (stale) say = 'The feed is old. The agent holds.';
  else if (d.action === 'HOLD' && d.preImpact) say = 'The trade would use up the edge. The agent holds.';
  else if (d.action === 'HOLD') say = 'The price is fair. The agent holds.';
  else say = 'No decision in this report.';
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
    <p class="say">${esc(say)}</p>
    <div class="ag-nums">
      <div><span class="ag-k">Market</span><span class="ag-v mono">${cents(num(d.pSooth) ?? m.yes)}</span></div>
      <div><span class="ag-k">Fair</span><span class="ag-v mono">${cents(num(d.pStar) ?? num(d.pModel))}</span></div>
      ${cournotOf(m) != null ? `<div><span class="ag-k">Cournot</span><span class="ag-v mono">${pct(cournotOf(m))}</span></div>` : ''}
      <div><span class="ag-k">Edge</span><span class="ag-v mono">${num(d.edge) != null ? signed(d.edge * 100, 1) : '-'}</span></div>
    </div>
    <details class="more">
      <summary>Details: agent inputs</summary>
      <dl class="metrics">
        ${metric('Fear & Greed (CMC)', fgv ?? '-', typeof fg.classification === 'string' ? fg.classification : '', fgv)}
        ${metric('Volatility, yearly', num(c.sigma) != null ? pct(c.sigma, 0) : '-', sigmaText(c))}
        ${metric('Risk score', risk != null ? `${Math.round(risk)}/100` : '-', risk != null && risk >= (num(p.highRisk) ?? 70) ? 'high' : '', risk)}
        ${metric('CMC vs feed', cspot != null ? usd(cspot) : '-', div != null ? `${signed(div)} from feed` : '')}
        ${metric('BTC dominance (CMC)', dom != null ? `${dom.toFixed(1)}%` : '-', '')}
        ${metric('Crypto cap, 24h', capChg != null ? signed(capChg) : '-', 'CMC')}
        ${metric('Size', num(d.sizeUsd) ? usd(d.sizeUsd) : '$0', num(p.bankroll) ? `of ${usd(p.bankroll, 0)}` : '')}
        ${metric('Report block', block != null ? `#${block.toLocaleString('en-US')}` : '-', '')}
      </dl>
      <p class="blend">${esc(blend)}</p>
      ${d.reason ? `<p class="small muted">${esc(d.reason)}${stale ? ' Atlas stock feeds pause when the stock market is closed.' : ''}</p>` : ''}
      ${(d.alerts ?? []).length ? `<ul class="alerts">${d.alerts.map((a) => `<li><b>${esc(a?.code ?? '')}</b>${esc(a?.message ?? a)}</li>`).join('')}</ul>` : ''}
      ${sent ? `<p class="small">Agent trade: ${link(txUrl(sent), short(sent))}</p>` : ''}
      ${calls.length ? `<p class="small muted">CMC calls (${esc(c.mode ?? '')}): ${calls.map((x) => `<span class="mono">${esc(x?.path ?? '')} ${esc(x?.status ?? '')}</span>`).join(', ')}</p>` : ''}
      ${ev.length ? `<p class="small sub-h">Cournot evidence</p><ul class="ev">${ev.map((e) => typeof e === 'string' ? `<li>${esc(e)}</li>` : `<li>${e?.url ? link(e.url, e.source ?? e.title ?? e.url) : esc(e?.source ?? e?.text ?? '')}${e?.summary ? `: ${esc(e.summary)}` : ''}</li>`).join('')}</ul>` : ''}
    </details>`;
}

function renderSettled() {
  const list = $('#setList');
  const ms = [...S.markets.values()].filter(finished).sort((a, b) => b.deadline - a.deadline);
  if (!S.markets.size) { list.innerHTML = '<li class="empty"><span class="skel skel-w"></span></li>'; return; }
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
      const res = out === 1 ? 'the level was hit. Each $1 of cover pays $1.' : out === 0 ? `the price stayed ${isBelow(m.kind) ? 'above' : 'below'} ${usd(m.strike)}. Cover did not pay.` : 'no price in time. Each share pays $0.50.';
      line = `${SRC[m.source]} price <span class="mono">${usd(o.price)}</span> at ${when(o.ts)}: ${res}`;
    } else if (out != null) line = `Result <b>${OUTCOME[out]}</b>.`;
    else if (s.kind === 'propose') line = touchHit(m) ? `${SRC[m.source]} price <span class="mono">${usd(m.price)}</span> touched the level.` : `Time is over. Last ${SRC[m.source]} price <span class="mono">${usd(m.price)}</span>.`;
    else if (s.kind === 'waitfeed') line = `Waiting for the first ${SRC[m.source]} price after ${when(m.deadline)}.`;
    if (s.kind === 'veto') line += ` A guardian can veto until ${when(m.vetoEndsAt)}.`;
    let claim = '';
    if (m.settled && m.pos && (m.pos.yes > 0 || m.pos.no > 0)) {
      const pay = out === 1 ? m.pos.yes : out === 0 ? m.pos.no : (m.pos.yes + m.pos.no) / 2;
      claim = pay > 0 ? `<button class="btn btn-ink btn-sm" data-act="claim" data-m="${esc(m.addr)}">Claim ${usd(pay)}</button>` : '<span class="muted">Your shares did not win.</span>';
    }
    const act = s.kind === 'propose' ? `<button class="btn btn-sm" data-act="propose" data-m="${esc(m.addr)}">Settle from feed</button>`
      : s.kind === 'finalize' ? `<button class="btn btn-sm" data-act="finalize" data-m="${esc(m.addr)}">Finalize</button>` : '';
    return `<li class="set-item">
      <div class="set-top">
        <div><p class="set-q">${esc(m.asset)} at or ${isBelow(m.kind) ? 'below' : 'above'} ${usd(m.strike)}</p>
        <span class="set-when">${isTouch(m.kind) ? 'before' : 'at'} ${when(m.deadline)}</span></div>
        <span class="status ${status[0]}">${status[1]}</span>
      </div>
      ${line ? `<p class="set-line">${line}</p>` : ''}
      <div class="set-actions">${link(addrUrl(m.feed), 'Feed')}${o ? link(txUrl(o.tx), 'Tx') : ''}${link(addrUrl(m.addr), 'Market')}${claim || act}</div>
    </li>`;
  }).join('');
}

function renderMine() {
  const rows = [...S.markets.values()].filter((m) => m.pos?.yes > 0 && !m.settled && isBelow(m.kind));
  $('#mine').hidden = !rows.length;
  $('#mineList').innerHTML = rows.map((m) => `<li><span class="mono">${usd(m.pos.yes)}</span><span>${esc(ifText(m))}</span></li>`).join('');
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
  S.wallet = null; S.account = null; S.balance = null; S.hold = {}; S.cover = null;
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
// quote or a drag of the line cannot change what the buy sends. Each leg has its own maxCost.
let CF = null;
let cfDone = new Set(); // legs already bought in this dialog
const dialogOpen = () => $('#confirm').open;

async function openConfirm() {
  try { if (!S.wallet || !S.account) await connect(); } catch (e) { setMsg('#formMsg', humanError(e), 'err'); return; }
  const plan = buildPlan();
  if (plan.err != null) return setMsg('#formMsg', plan.err || 'No level selected.', 'err');
  clearTimeout(quoteTimer); quoteSeq++; // stop any quote in flight from writing over this one
  let legs;
  try {
    const qs = await Promise.all(plan.legs.map(quoteLeg));
    legs = plan.legs.map((l, i) => {
      const net = qs[i][2];
      return Object.freeze({ m: l.m, market: l.m.addr, strike: l.m.strike, sharesNum: l.shares, shares: parseUnits(l.shares.toFixed(2), 18), fee: qs[i][1], net, newPrice: qs[i][3], maxCost: withSlip(net) });
    });
  } catch (e) { return setMsg('#formMsg', `No quote: ${humanError(e)}`, 'err'); }
  const net = legs.reduce((s, l) => s + l.net, 0n), maxCost = legs.reduce((s, l) => s + l.maxCost, 0n), fee = legs.reduce((s, l) => s + l.fee, 0n);
  if (wad(net) > MAX_TRADE) return setMsg('#formMsg', `That costs more than the ${usd(MAX_TRADE, 0)} limit per order. Set a smaller amount.`, 'err');
  if (!legs.every((l) => live(l.m))) return setMsg('#formMsg', 'Trading is closed for this level.', 'err');
  const allowance = await pub.readContract({ address: cfg.stable, abi: ERC20, functionName: 'allowance', args: [S.account, cfg.amm] });
  const needApprove = allowance < maxCost;
  const q = { asset: S.asset, deadline: plan.f.deadline, source: plan.f.source, stair: plan.stair, payout: plan.payout, legs: Object.freeze(legs), net, maxCost, fee };
  CF = Object.freeze(q);
  cfDone = new Set();
  const low = legs.at(-1).strike;
  $('#cfWhat').textContent = q.stair
    ? `You get up to ${money(q.payout)} as ${q.asset} falls to ${usd(low)} by ${when(q.deadline)}. The ${SRC_LONG[q.source]} price settles it.`
    : `You get ${money(q.payout)} if ${q.asset} ends at or below ${usd(low)} on ${when(q.deadline)}. The ${SRC_LONG[q.source]} price settles it.`;
  let acc = 0;
  $('#cfLegs').innerHTML = `<thead><tr><th scope="col">Level</th><th scope="col" class="r">Pays at or below</th><th scope="col" class="r">You pay</th></tr></thead><tbody>${legs.map((l) => { acc += l.sharesNum; return `<tr><td class="mono">${usd(l.strike)}</td><td class="r">${money(acc)}</td><td class="r">${usd(wad(l.net))}</td></tr>`; }).join('')}</tbody>`;
  $('#cfRows').innerHTML = `
    <dt>You pay now</dt><dd class="total">${usd(wad(net))}</dd>
    <dt>Most you pay</dt><dd>${usd(wad(maxCost))} <span class="muted">(${Number(SLIP_BPS) / 100}% slippage${legs.length > 1 ? ', per level' : ''})</span></dd>
    <dt>Fee, included</dt><dd>${usd(wad(fee))}</dd>
    <dt>Limit per order</dt><dd>${usd(MAX_TRADE, 0)} <span class="muted">(this page)</span></dd>
    <dt>Paid in</dt><dd>hUSD-DEMO, demo money</dd>`;
  $('#cfSteps').innerHTML = `${needApprove ? `<li data-s="approve">Allow the Sooth AMM to take up to ${usd(wad(maxCost))} hUSD-DEMO</li>` : ''}${legs.map((l, i) => `<li data-s="buy${i}">Buy the ${usd(l.strike)} level, ${usd(l.sharesNum)}</li>`).join('')}`;
  setMsg('#cfMsg', legs.length > 1 ? `Your wallet asks ${legs.length + (needApprove ? 1 : 0)} times, once per step.` : '');
  $('#cfGo').disabled = false;
  $('#cfGo').textContent = 'Confirm in wallet';
  $('#confirm').showModal();
}

async function runProtect() {
  const q = CF;
  if (!q) return;
  const go = $('#cfGo');
  go.disabled = true;
  const mark = (s) => document.querySelectorAll('#cfSteps li').forEach((li) => {
    const k = li.dataset.s;
    const done = (k === 'approve' && s !== 'approve') || (k.startsWith('buy') && cfDone.has(Number(k.slice(3))));
    li.className = done ? 'done' : k === s ? 'now' : '';
  });
  try {
    lastHash = null;
    const left = q.legs.map((l, i) => [l, i]).filter(([, i]) => !cfDone.has(i));
    const need = left.reduce((s, [l]) => s + l.maxCost, 0n);
    await ensureAllowance(need, (s) => { mark(s); setMsg('#cfMsg', 'Approve in your wallet.'); });
    for (const [l, i] of left) {
      mark(`buy${i}`);
      // Quote again now. If the most you pay is above what this dialog showed, stop.
      const fresh = await pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPositionQuote', args: [l.market, 1, l.shares] });
      const freshMax = withSlip(fresh[2]);
      if (freshMax > l.maxCost) {
        const n = cfDone.size;
        setMsg('#cfMsg', `The price moved on the ${usd(l.strike)} level. The most you pay is now ${usd(wad(freshMax))}, above the ${usd(wad(l.maxCost))} shown. ${n ? `${n} level${n > 1 ? 's are' : ' is'} bought. ` : ''}Nothing more was sent. Close this and get a new quote.`, 'err');
        go.textContent = 'Price moved';
        return;
      }
      setMsg('#cfMsg', `Confirm the ${usd(l.strike)} level in your wallet.`);
      // The limit sent is the one shown, never a newer quote.
      const hash = await send(cfg.amm, AMM, 'tradePositions', [l.market, 1, l.shares, l.maxCost]);
      cfDone.add(i);
      mark(`buy${i}`);
      lastHash = hash;
      setMsgHtml('#cfMsg', `Bought the ${usd(l.strike)} level. ${link(txUrl(hash), 'View tx')}`, 'ok');
    }
    mark('done');
    if (!lastHash) throw new Error('Nothing was bought.');
    setMsgHtml('#cfMsg', `Protected. ${link(txUrl(lastHash), 'View tx')}`, 'ok');
    go.textContent = 'Done';
    setTimeout(() => $('#confirm').close(), 1400);
    toast(`Protected: ${q.stair ? 'up to ' : ''}${esc(money(q.payout))} if ${esc(q.asset)} falls to ${usd(q.legs.at(-1).strike)}. ${link(txUrl(lastHash), 'View tx')}`);
  } catch (e) {
    setMsg('#cfMsg', `${humanError(e)}${cfDone.size ? ` ${cfDone.size} of ${q.legs.length} levels are bought.` : ''}`, 'err');
    go.disabled = false; go.textContent = cfDone.size ? 'Buy the rest' : 'Try again';
  }
}
let lastHash = null;

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
$('#assetSeg').addEventListener('change', (e) => { S.asset = e.target.value; S.end = null; S.sel = null; S.cover = null; renderAll(); });
$('#endSeg').addEventListener('change', (e) => { S.end = Number(e.target.value); S.sel = null; renderAll(); });
$('#modeSeg').addEventListener('change', (e) => { S.mode = e.target.value; renderPlan(); renderLadder(); renderRule(); });
$('#amt').addEventListener('input', (e) => { S.cover = null; S.amount = Number(e.target.value); renderPlan(); });
document.querySelectorAll('.chip[data-amt]').forEach((c) => { c.onclick = () => { S.cover = null; S.amount = Number(c.dataset.amt); $('#amt').value = c.dataset.amt; renderPlan(); }; });
$('#coverBtn').onclick = () => {
  if (S.cover != null) { S.cover = null; $('#amt').value = String(S.amount); }
  else S.cover = S.hold[S.asset] ?? null;
  renderPlan();
};
$('#form').onsubmit = (e) => { e.preventDefault(); openConfirm(); };
$('#cfGo').onclick = runProtect;
$('#confirm').addEventListener('close', () => { CF = null; cfDone = new Set(); refresh(); });
$('#tShares').oninput = traderQuote;
$('#trader').addEventListener('toggle', () => { if ($('#trader').open) traderQuote(); });
document.querySelectorAll('input[name=side]').forEach((r) => { r.onchange = traderQuote; });
$('#tBuy').onclick = traderBuy;

// Drag the floor: pointer (mouse, pen, touch) anywhere on the chart, or the keyboard on the line.
const svgEl = $('#svg');
svgEl.addEventListener('pointerdown', (e) => {
  if (!CH || e.button > 0) return;
  drag = true;
  svgEl.setPointerCapture(e.pointerId);
  svgEl.classList.add('dragging');
  pickAt(e.clientY);
  $('#floorG')?.focus({ preventScroll: true });
  e.preventDefault();
});
svgEl.addEventListener('pointermove', (e) => { if (drag) pickAt(e.clientY); });
const endDrag = () => { if (!drag) return; drag = false; svgEl.classList.remove('dragging'); };
svgEl.addEventListener('pointerup', endDrag);
svgEl.addEventListener('pointercancel', endDrag);
svgEl.addEventListener('keydown', (e) => {
  if (!e.target.closest('#floorG')) return;
  const lv = levels();
  const k = { ArrowUp: -1, ArrowRight: -1, ArrowDown: 1, ArrowLeft: 1, PageUp: -1, PageDown: 1 }[e.key];
  if (k) { e.preventDefault(); stepFloor(k); }
  else if (e.key === 'Home') { e.preventDefault(); setFloor(lv[0]?.addr); }
  else if (e.key === 'End') { e.preventDefault(); setFloor(lv.at(-1)?.addr); }
});

const pickRow = (tr) => {
  const m = S.markets.get(tr.dataset.m);
  if (!m) return;
  if (m.deadline !== S.end) { S.end = m.deadline; S.sel = m.addr; renderAll(); } else setFloor(m.addr);
};
$('#ladder tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-m]'); if (tr) pickRow(tr); });
$('#ladder tbody').addEventListener('keydown', (e) => {
  const tr = e.target.closest('tr[data-m]');
  if (!tr) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickRow(tr); $(`#ladder tr[data-m="${tr.dataset.m}"]`)?.focus(); }
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
  S.cover = null;
  loadPositions().then(renderAll).catch(() => {});
});
window.ethereum?.on?.('chainChanged', () => location.reload());
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (!drag) drawChart(); }, 120); });

// ── Start ────────────────────────────────────────────────────────────
async function refresh() {
  if (dialogOpen() || drag) return; // paused while the confirm dialog is open or the line moves
  try {
    await refreshChain();
    await loadMarkets();
    await Promise.all([...S.markets.values()].filter((m) => m.phase >= PH.RESOLVED).map((m) => loadObserved(m).catch(() => {})));
    if (!drag && !dialogOpen()) renderAll();
  } catch (e) {
    $('#net .dot').className = 'dot err';
    $('#block').textContent = 'RPC error';
    if (!S.markets.size) {
      $('#setList').innerHTML = `<li class="empty">Cannot reach the chain: ${esc(humanError(e))}</li>`;
      const msg = $('#plotMsg'); msg.hidden = false; msg.textContent = 'Cannot reach the chain. The page tries again in 30 s.';
      $('#protectBtn').disabled = true;
    }
  }
}

renderFooter();
pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'vetoPeriod' })
  .then((v) => { S.vetoPeriod = Number(v); $('#vetoMin').textContent = span(Number(v)); $('#vetoNote').hidden = !(S.vetoPeriod > 0); }).catch(() => {});
if (!cfg.markets?.length) { const msg = $('#plotMsg'); msg.hidden = false; msg.textContent = 'No markets yet.'; }
drawChart();
await refresh();
setInterval(refresh, 30_000);
