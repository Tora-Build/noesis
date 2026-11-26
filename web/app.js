// NOESIS page. All numbers come from the chain (config.json lists the markets) or from
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
// Short money for tight spots: $1,234 / $12.3k / $1.2M.
const compactUsd = (n) => (Math.abs(n) >= 1e6 ? `$${(Math.floor(n / 1e5) / 10).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `$${(Math.floor(n / 1e2) / 10).toFixed(1)}k` : usd(n, 0));
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

async function fetchReport(market, bust = false) {
  try {
    const r = await fetch(`reports/${market.toLowerCase()}.json${bust ? `?t=${Date.now()}` : ''}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
const REPORT_TTL = 300_000; // reports change every 30 min; look again every 5 min

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
    report: prev?.report, reportAt: prev?.reportAt, pos: prev?.pos, observed: prev?.observed,
  };
  if (m.report === undefined || Date.now() - (m.reportAt ?? 0) > REPORT_TTL) {
    const r = await fetchReport(a, m.report !== undefined);
    if (r || m.report === undefined) m.report = r;
    m.reportAt = Date.now();
  }
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
  renderIntel();
  renderOracle();
  renderRule();
  renderSettled();
  renderMine();
  renderChances();
  syncLevelInput();
  renderPortfolio();
  renderLive();
}

// Everything that follows the selected level: one place, so the panels never drift apart.
function renderSel() {
  renderPlan();
  renderLadder();
  renderTrader();
  renderAgent();
  renderIntel();
  renderOracle();
  renderRule();
  renderChances();
  syncLevelInput();
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
  const srcOf = (x) => assetPrice(x)?.source;
  const ah = a.length ? a.map((x) => `<label title="${esc(`${x}, settled by ${SRC_LONG[srcOf(x)] ?? 'its feed'}`)}"><input type="radio" name="asset" value="${esc(x)}"${x === S.asset ? ' checked' : ''}><span>${esc(x)}${srcOf(x) != null ? ` <i class="src-m src-${srcOf(x) === 0 ? 'atlas' : 'cl'}">${esc(SRC[srcOf(x)])}</i>` : ''}</span></label>`).join('') : '<span class="seg-empty"><span class="skel"></span></span>';
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
    if (f.strike >= spot) return { err: `${S.asset} is already at or below ${usd(f.strike)}. Pick a lower level.`, f, spot };
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
    $('#roPaySub').textContent = `if ${S.asset} is at or below ${usd(low)} at the deadline, ${when(f.deadline)}${p.stair ? '. Each level above it pays a part.' : ''}`;
  } else {
    setNum(pay, null);
    $('#roPaySub').textContent = p?.err ?? '';
  }
  cost.classList.toggle('loading', state === 'loading');
  if (state === 'ok') setNum(cost, wad(p.net), (n) => usd(n));
  else if (state === 'loading' && legs) { if (!cost.dataset.v) cost.innerHTML = '<span class="skel" aria-label="Getting a live quote"></span>'; }
  else setNum(cost, null);
  const sm = f ?? S.markets.get(S.sel);
  const ch = oneIn(sm?.yes);
  $('#roChance').textContent = ch ? `At ${usd(sm.strike)}, the market says ${ch} it pays.` : '\u00a0';
  $('#roMkt').textContent = sm?.yes != null ? `${cents(sm.yes)} per $1` : '-';
  const fe = fairOf(sm);
  $('#roAg').textContent = fe != null ? `${pct(fe)} chance` : 'No report';
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
    svg.innerHTML = '<title id="svgTitle">Price chart with a protection level line</title>';
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
  o.push('<title id="svgTitle">Price chart with a protection level line</title>');
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
  o.push(`<g id="floorG" class="floor" role="slider" tabindex="0" aria-orientation="vertical" aria-label="Protection level">
    <line class="fl-halo" x1="0" x2="${xq1}" y1="0" y2="0"/>
    <line class="fl-edge" x1="0" x2="${xq1}" y1="0" y2="0"/>
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
    ? `Level ${usd(m.strike)}. Pays ${p.stair ? 'up to ' : ''}${money(p.payout)} if ${S.asset} ends at or below it on ${when(m.deadline)}${cost}.`
    : `Level ${usd(m.strike)}.`);
}

function setFloor(addr, animate = true) {
  if (!addr || addr === S.sel) return;
  S.sel = addr;
  placeFloor(animate);
  renderSel();
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
  $('#lSrc').innerHTML = ap ? srcBadge(ap.source) : '';
  $('#lWhen').textContent = dls.length === 1 ? `Ends ${when(dls[0])}` : dls.length ? `${dls.length} end times` : '';
  if (!ms.length) { tb.innerHTML = `<tr><td colspan="7" class="empty">${S.markets.size ? 'No open levels for this asset.' : '<span class="skel skel-w"></span>'}</td></tr>`; return; }
  tb.innerHTML = ms.map((m) => {
    const d = m.report?.decision;
    const dist = ap ? (m.strike / ap.price - 1) * 100 : null;
    const you = m.pos && (m.pos.yes > 0 || m.pos.no > 0) ? `${m.pos.yes > 0 ? usd(m.pos.yes) : ''}${m.pos.no > 0 ? `<span class="gap-note">${m.pos.no.toFixed(2)} NO</span>` : ''}` : '<span class="muted">-</span>';
    const fair = fairOf(m), cour = cournotOf(m);
    const inLeg = S.plan?.legs?.some((l) => l.m.addr === m.addr);
    return `<tr tabindex="0" data-m="${esc(m.addr)}" aria-selected="${m.addr === S.sel}"${inLeg && m.addr !== S.sel ? ' class="leg"' : ''}>
      <td><span class="lvl">${usd(m.strike)}</span>${dls.length > 1 ? `<span class="kind">${esc(endLabel(m.deadline))}</span>` : ''}</td>
      <td class="r c-dist mono">${dist == null ? '-' : signed(dist, 1)}</td>
      <td class="r">${cents(m.yes)}</td>
      <td class="r">${cents(fair)}</td>
      <td class="r c-cour">${cour == null ? '<span class="muted">-</span>' : pct(cour)}</td>
      <td class="c-ag">${actionPill(m.report)}</td>
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

// ── Shared bits for the report panels ───────────────────────────────
const IMPL_CMC = 'https://github.com/Tora-Build/noesis/blob/main/agent/src/cmc.mjs';
const IMPL_ADJ = 'https://github.com/Tora-Build/noesis/blob/main/contracts/src/PriceFeedAdjudicator.sol';
// Small chances stay honest: 1e-9 shows as "under 0.1%", not 0.0%.
const pctS = (p) => (p != null && p > 0 && p < 0.0005 ? 'under 0.1%' : pct(p));
const reportTs = (r) => { const t = Date.parse(r?.generatedAt ?? ''); return Number.isFinite(t) ? t / 1000 : null; };
const reportWhen = (r) => { const t = reportTs(r); return t ? `${when(t)}, ${ago(t)}` : 'time unknown'; };
const big = (n) => (n == null ? '-' : n >= 1e12 ? `$${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : usd(n, 0));
const TIME_FMT = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const hms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? `${TIME_FMT.format(new Date(t))} UTC` : '-'; };
const srcBadge = (source) => `<span class="src-b src-${source === 0 ? 'atlas' : 'cl'}">${esc(SRC_LONG[source] ?? 'Feed')}</span>`;
const metric = (k, v, extra = '', meter = null) => `<div class="metric"><dt>${esc(k)}</dt><dd>${esc(v)}${extra ? `<small>${esc(extra)}</small>` : ''}</dd>${num(meter) != null ? `<div class="meter" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, meter))}%"></i></div>` : ''}</div>`;

// Volatility: what the agent used and how. Never claims candles: the CMC free plan has none.
function volText(c) {
  const sd = c.sigmaDetail, sig = num(c.sigma);
  if (sd && num(sd.cmc) != null && num(sd.prior) != null) {
    return {
      parts: `CMC estimate ${pct(sd.cmc, 0)}, prior ${pct(sd.prior, 0)}, blended ${pct(sig, 0)}. Blend = √((CMC² + prior²) / 2).`,
      how: 'From CMC price changes (1h to 90d windows); the free plan has no candles.',
    };
  }
  if (c.sigmaSource === 'default') return { parts: `Prior only: ${pct(sig, 0)}.`, how: 'CMC gave too few price changes, so the agent used the prior.' };
  if (c.sigmaSource === 'cmc_price_changes') return { parts: `Blended value ${pct(sig, 0)}.`, how: 'From CMC price changes blended with a prior. This report does not list the two parts.' };
  return { parts: sig != null ? '' : 'No value in this report.', how: 'This report is from an older agent version. It does not list how the value was made.' };
}

// The chain from inputs to price, with the real weights from the report.
function chainText(r) {
  const d = r.decision ?? {}, c = r.inputs?.cmc ?? {}, p = d.params ?? {};
  const sig = num(c.sigma), pm = num(d.pModel) ?? num(r.inputs?.model?.pModel), pc = num(d.pCournot), ps = num(d.pStar);
  const w = num(p.cournotWeight);
  const parts = [`volatility ${sig != null ? pct(sig, 0) : '-'}`, `model chance ${pctS(pm)}`];
  if (pc != null) parts.push(`Cournot ${pctS(pc)}`);
  parts.push(`fair price ${pctS(ps ?? pm)}`);
  const how = pc != null && w != null
    ? `Fair = ${w} × Cournot + ${+(1 - w).toFixed(2)} × model = ${w} × ${pctS(pc)} + ${+(1 - w).toFixed(2)} × ${pctS(pm)}.`
    : `No Cournot chance${r.inputs?.cournot?.state ? ` (${r.inputs.cournot.state})` : ''}, so fair = model chance.${w != null ? ` Cournot weight when present: ${w}.` : ''}`;
  return { line: parts.join(' → '), how };
}

// ── Market intelligence (CoinMarketCap), from the selected level's report ──
function renderIntel() {
  const m = S.markets.get(S.sel), r = m?.report, c = r?.inputs?.cmc;
  const body = $('#inBody');
  if (!r || !c) {
    $('#inWhen').textContent = '';
    body.innerHTML = `<p class="empty">${m ? 'No CoinMarketCap data for this level yet.' : 'Pick a level.'}</p><p class="small">${link(IMPL_CMC, 'Implementation')}</p>`;
    return;
  }
  const q = c.quote ?? {};
  $('#inWhen').textContent = `CoinMarketCap · ${q.symbol ?? r.asset ?? m.asset}`;
  const price = num(q.price) ?? num(c.spot), feed = num(r.inputs?.spot);
  const div = price != null && feed ? (price / feed - 1) * 100 : null;
  const fg = c.fearGreed ?? {}, fgv = num(fg.value), g = c.global ?? {};
  const cells = [
    metric('CMC price', price != null ? usd(price) : '-', div != null ? `${signed(div)} vs feed` : ''),
    num(q.volume24h) != null ? metric('24h volume', big(q.volume24h)) : '',
    num(q.marketCap) != null ? metric('Market cap', big(q.marketCap)) : '',
    metric('Fear and Greed', fgv ?? '-', typeof fg.classification === 'string' ? fg.classification : '', fgv),
    metric('Crypto market cap', big(num(g.totalMarketCap)), num(g.marketCapChange24hPct) != null ? `${signed(g.marketCapChange24hPct)} 24h` : ''),
    metric('BTC dominance', num(g.btcDominance) != null ? `${g.btcDominance.toFixed(1)}%` : '-'),
  ].filter(Boolean).join('');
  const ch = [['1h', c.pct1h], ['24h', c.pct24h], ['7d', c.pct7d], ['30d', c.pct30d], ['60d', c.pct60d], ['90d', c.pct90d]].filter(([, v]) => num(v) != null);
  const v = volText(c), chain = chainText(r);
  const calls = Array.isArray(c.calls) ? c.calls : [];
  const errs = Array.isArray(c.errors) ? c.errors.filter(Boolean) : [];
  body.innerHTML = `
    <dl class="metrics">${cells}</dl>
    ${ch.length ? `<div class="chg"><p class="sub-h">Price change (CMC)</p><dl class="chg-l">${ch.map(([k, x]) => `<div><dt>${k}</dt><dd class="mono ${x < 0 ? 'neg' : ''}">${signed(x)}</dd></div>`).join('')}</dl></div>` : ''}
    <div class="vol">
      <p class="sub-h">Volatility used</p>
      <p class="vol-v"><b class="mono">${num(c.sigma) != null ? `${pct(c.sigma, 0)} a year` : '-'}</b> ${esc(v.parts)}</p>
      <p class="small muted">${esc(v.how)}</p>
    </div>
    <p class="sub-h">From inputs to price</p>
    <p class="blend">${esc(chain.line)}</p>
    <p class="small muted">${esc(chain.how)}</p>
    <div class="api">
      <p class="sub-h">API log</p>
      ${calls.length ? `<ol class="api-l">${calls.map((x) => `<li><span class="mono api-t">${esc(hms(x?.at))}</span><code>${esc(x?.path ?? '-')}</code><span class="api-s${Number(x?.status) === 200 ? ' ok' : ''}">${esc(x?.status ?? '-')}</span></li>`).join('')}</ol>` : '<p class="small muted">No calls listed in this report.</p>'}
      ${errs.length ? `<p class="small">Errors: ${esc(errs.map((e) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e))).join('; '))}</p>` : ''}
      <p class="small muted">Report made ${esc(reportWhen(r))}. The CMC key stays on the server. This page reads only the saved report.</p>
      <p class="small">${link(IMPL_CMC, 'Implementation')}</p>
    </div>`;
}

// ── Oracle: the feed that settles the selected level ────────────────
function oracleStatus(m) {
  const s = settleState(m);
  if (s.kind === 'open') return ['', 'Open'];
  if (s.kind === 'settled') return ['done', m.outcome === 2 ? 'Settled void' : `Settled ${OUTCOME[m.outcome] ?? ''}`];
  return ['wait', 'Waiting for settlement'];
}
function renderOracle() {
  const m = S.markets.get(S.sel), body = $('#orBody');
  if (!m) { body.innerHTML = `<p class="empty">${S.markets.size ? 'Pick a level.' : '<span class="skel skel-w"></span>'}</p>`; return; }
  const id = parseInt(m.feedId, 16);
  const [cls, label] = oracleStatus(m);
  const o = m.observed;
  const age = m.priceTs ? S.now - m.priceTs : null;
  body.innerHTML = `
    <div class="or-top">${srcBadge(m.source)}<span class="status ${cls}">${esc(label)}</span></div>
    <dl class="kv or-kv small">
      <dt>Feed contract</dt><dd>${link(addrUrl(m.feed), short(m.feed))}</dd>
      ${m.source === 0 ? `<dt>Feed id</dt><dd class="mono">${esc(String(id))} (${esc(m.feedId)})</dd><dt>Read</dt><dd><code>fetch(bytes4 feedId)</code>, 18 decimals</dd>` : '<dt>Read</dt><dd><code>latestRoundData()</code></dd>'}
      <dt>Live price</dt><dd class="mono">${m.price != null ? esc(usd(m.price)) : '-'}</dd>
      <dt>Updated</dt><dd>${m.priceTs ? `${esc(when(m.priceTs))}, ${esc(ago(m.priceTs))}` : '-'}${age != null && age > 900 ? ' <span class="muted">(stock feeds pause when the market is closed)</span>' : ''}</dd>
      <dt>Read at</dt><dd>${S.block != null ? `block #${esc(S.block.toLocaleString('en-US'))}` : '-'}</dd>
      <dt>Network</dt><dd>BNB Smart Chain mainnet</dd>
      <dt>Level</dt><dd>${esc(usd(m.strike))}, at the deadline ${esc(when(m.deadline))}</dd>
      ${o ? `<dt>Price used</dt><dd class="mono">${esc(usd(o.price))} <span class="muted">at ${esc(when(o.ts))}</span></dd><dt>Settlement tx</dt><dd>${link(txUrl(o.tx), short(o.tx))}</dd>` : ''}
    </dl>
    <p class="or-rule">At the deadline, anyone can call settle; the contract reads this feed; the price must be at most ${esc(String(m.maxDelay))} s old; no person can change the result.</p>
    <p class="small">${link(IMPL_ADJ, 'Implementation')} · ${link(addrUrl(cfg.adjudicator), 'Adjudicator contract')}</p>`;
}

// ── Risk agent ───────────────────────────────────────────────────────
const ACTION = { BUY_YES: ['buy', 'Buy cover'], BUY_NO: ['sell', 'Sell cover'], HOLD: ['', 'Hold'] };
function agentReasons(r) {
  const d = r.decision ?? {}, p = d.params ?? {}, inp = r.inputs ?? {};
  const out = [];
  const e = num(d.edge), th = num(p.edgeThreshold);
  if (e != null) out.push(`Edge ${signed(e * 100, 1)}: agent estimate ${pct(num(d.pStar))} minus market price ${pct(num(d.pSooth))}. ${th != null ? `The threshold is ${pct(th)}, so the edge is ${Math.abs(e) > th ? 'outside it: a trade is allowed' : 'inside it: no trade'}.` : ''}`);
  const risk = num(d.risk) ?? num(inp.model?.risk?.score), cap = num(p.riskCap);
  if (risk != null) out.push(`Risk score ${Math.round(risk)} of 100. ${cap != null ? `The cap is ${cap}, so the risk is ${risk >= cap ? 'at or above the cap: no trade' : 'under the cap'}.` : ''}`);
  const pc = num(d.pCournot);
  out.push(pc != null ? `Cournot used: ${pct(pc)}, weight ${num(p.cournotWeight) ?? '-'}.` : `Cournot not used${inp.cournot?.state ? ` (${inp.cournot.state})` : ''}.`);
  if ((d.alerts ?? []).some((a) => (a?.code ?? a) === 'FEED_STALE')) out.push('The feed is old, so the agent holds. Atlas stock feeds pause when the stock market is closed.');
  if (num(d.sizeUsd)) out.push(`Size ${usd(d.sizeUsd)}${num(p.bankroll) ? ` of a ${usd(p.bankroll, 0)} bankroll` : ''}.`);
  return out;
}
function renderAgent() {
  const m = S.markets.get(S.sel);
  const r = m?.report;
  const body = $('#agBody');
  $('#agRefresh').disabled = !m;
  if (!r) {
    $('#agWhen').textContent = '';
    body.innerHTML = `<p class="empty">${m ? 'No agent report for this level yet.' : 'Pick a level to see the agent.'}</p>`;
    return;
  }
  const d = r.decision ?? {};
  const block = num(r.proof?.block);
  $('#agWhen').textContent = `${usd(m.strike)} level${r.mode === 'dry-run' ? ' · dry run' : ''}`;
  const [cls, label] = ACTION[d.action] ?? ['', 'No decision'];
  const sent = [r.tx?.sent?.trade, r.tx?.hash].find(isHash);
  const ev = Array.isArray(r.evidence?.lines) ? r.evidence.lines : [];
  body.innerHTML = `
    <p class="say"><span class="pill big ${cls}">${esc(label)}</span></p>
    <ul class="why">${agentReasons(r).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <div class="ag-nums">
      <div><span class="ag-k">Market price</span><span class="ag-v mono">${cents(num(d.pSooth) ?? m.yes)}</span></div>
      <div><span class="ag-k">Agent estimate</span><span class="ag-v mono">${pct(num(d.pStar) ?? num(d.pModel))}</span></div>
      <div><span class="ag-k">Edge</span><span class="ag-v mono">${num(d.edge) != null ? signed(d.edge * 100, 1) : '-'}</span></div>
    </div>
    <p class="small muted ag-time">Report made ${esc(reportWhen(r))}${block != null ? `, block #${esc(block.toLocaleString('en-US'))}` : ''}.</p>
    <p class="small">${sent ? `Last trade: ${link(txUrl(sent), short(sent))}` : r.tx ? 'Trade built, not sent.' : 'No trade in this report.'}</p>
    ${(d.alerts ?? []).length || ev.length || d.reason ? `<details class="more">
      <summary>Details: agent notes</summary>
      ${d.reason ? `<p class="small muted">Agent note: ${esc(d.reason)}</p>` : ''}
      ${(d.alerts ?? []).length ? `<ul class="alerts">${d.alerts.map((a) => `<li><b>${esc(a?.code ?? '')}</b>${esc(a?.message ?? a)}</li>`).join('')}</ul>` : ''}
      ${ev.length ? `<p class="small sub-h">Cournot evidence</p><ul class="ev">${ev.map((e) => typeof e === 'string' ? `<li>${esc(e)}</li>` : `<li>${e?.url ? link(e.url, e.source ?? e.title ?? e.url) : esc(e?.source ?? e?.text ?? '')}${e?.summary ? `: ${esc(e.summary)}` : ''}</li>`).join('')}</ul>` : ''}
    </details>` : ''}`;
}

async function refreshReport() {
  const m = S.markets.get(S.sel), b = $('#agRefresh');
  if (!m) return;
  b.disabled = true; $('#agRefMsg').textContent = 'Loading the report.';
  const r = await fetchReport(m.addr, true);
  if (r) { m.report = r; m.reportAt = Date.now(); }
  $('#agRefMsg').textContent = r ? `Report loaded. Made ${reportWhen(r)}.` : 'Could not load the report.';
  b.disabled = false;
  renderSel();
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
      const res = out === 1 ? `the price ended at or below ${usd(m.strike)}. Each $1 of cover pays $1.` : out === 0 ? `the price stayed ${isBelow(m.kind) ? 'above' : 'below'} ${usd(m.strike)}. Cover did not pay.` : 'no price in time. Each share pays $0.50.';
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

// Status of a position, from data the page already has: phase, outcome, settled flag, shares.
function coverStatus(m) {
  if (live(m)) return ['', 'Open'];
  if (!m.settled) {
    // The feed result is in but not final yet.
    if ((m.phase === PH.RESOLVED || m.phase === PH.ATTESTED) && m.outcome < 2) return m.outcome === 1 ? ['won', 'Won'] : ['lost', 'Lost'];
    return ['wait', 'Waiting'];
  }
  if (m.outcome === 1 || m.outcome === 2) return ['claim', 'Claim'];
  return ['lost', 'Lost'];
}
function renderMine() {
  const rows = [...S.markets.values()].filter((m) => m.pos?.yes > 0 && isBelow(m.kind));
  $('#mine').hidden = !rows.length;
  rows.sort((a, b) => a.deadline - b.deadline || b.strike - a.strike);
  // Compact rows: payout | asset and level | end | status. More than 3 go behind a toggle.
  const li = (m) => {
    const [cls, label] = coverStatus(m);
    const pay = m.outcome === 2 ? m.pos.yes / 2 : m.pos.yes;
    const act = cls === 'claim' ? `<button class="btn btn-ink btn-sm" data-act="claim" data-m="${esc(m.addr)}">Claim ${esc(usd(pay))}</button>` : `<span class="status ${cls === 'won' ? 'done' : cls === 'lost' ? '' : cls}">${esc(label)}</span>`;
    return `<li title="${esc(ifText(m))}"><span class="mono mine-amt">${usd(m.pos.yes)}</span><span class="mine-what">${esc(m.asset)} ≤ ${usd(m.strike)}</span><span class="mine-when muted">${esc(endLabel(m.deadline))}</span><span class="mine-st">${act}</span></li>`;
  };
  const total = rows.reduce((t, m) => t + m.pos.yes, 0);
  $('#mineList').innerHTML = rows.slice(0, 3).map(li).join('')
    + (rows.length > 3 ? `<li class="mine-more"><details><summary>Show all ${rows.length} (pays up to ${usd(total)} in total)</summary><ul class="mine-list">${rows.slice(3).map(li).join('')}</ul></details></li>` : '');
}

// ── Chance by level: market price and agent estimate per level ──────
// Only real numbers: the AMM price (the market's chance) and the agent's fair chance.
// No paths and no curves: we do not forecast the price.
function fairOf(m) { return num(m?.report?.decision?.pStar) ?? num(m?.report?.decision?.pModel); }

function renderChances() {
  const list = $('#chList');
  const ap = S.asset && assetPrice(S.asset), lv = levels();
  $('#chWhen').textContent = S.asset && S.end ? `${S.asset}, at the deadline ${endLabel(S.end)} UTC` : '';
  if (!S.markets.size) { list.innerHTML = '<li class="empty"><span class="skel skel-w"></span></li>'; return; }
  if (!lv.length) { list.innerHTML = `<li class="empty">${ap ? 'No open levels for this end time.' : 'No feed price for this asset.'}</li>`; return; }
  const legs = new Set(S.plan?.legs?.map((l) => l.m.addr) ?? []);
  const w = (p) => (p == null ? 0 : Math.max(0, Math.min(100, p * 100)));
  list.innerHTML = lv.map((m) => {
    const mk = m.yes, ag = fairOf(m), sel = m.addr === S.sel, leg = legs.has(m.addr);
    const label = `${usd(m.strike)}: market price ${mk != null ? pct(mk) : 'none'}, agent estimate ${ag != null ? pct(ag) : 'none'}`;
    return `<li><button type="button" class="ch-row${sel ? ' on' : leg ? ' leg' : ''}" data-m="${esc(m.addr)}" aria-pressed="${sel}" aria-label="${esc(label)}">
      <span class="ch-l mono">${esc(usd(m.strike, m.strike >= 100 ? 0 : 2))}</span>
      <span class="ch-track" aria-hidden="true"><i class="ch-bar" style="width:${w(mk).toFixed(1)}%"></i>${ag != null ? `<b class="ch-mk" style="left:${w(ag).toFixed(1)}%"></b>` : ''}</span>
      <span class="ch-n mono" aria-hidden="true"><span>${mk != null ? pct(mk) : '-'}</span><span class="ch-ag">${ag != null ? pct(ag) : '-'}</span></span>
    </button></li>`;
  }).join('');
}

// The typed level: snaps to a level that has a market, both ways with the drag line.
function syncLevelInput() {
  const inp = $('#lvlInput'), m = S.markets.get(S.sel), lv = levels();
  $('#lvlList').innerHTML = lv.map((x) => `<option value="${esc(String(x.strike))}"></option>`).join('');
  inp.disabled = !lv.length;
  if (lv.length) { inp.min = String(lv.at(-1).strike); inp.max = String(lv[0].strike); }
  if (m && document.activeElement !== inp) inp.value = String(m.strike);
}
function snapLevel(v) {
  const lv = levels();
  if (!lv.length || !Number.isFinite(v)) return null;
  return lv.reduce((b, m) => (Math.abs(m.strike - v) < Math.abs(b.strike - v) ? m : b), lv[0]);
}

// ── Portfolio: what the wallet really holds, valued at the live feed price ──
const FOLIO = ['IWMB', 'EWZB', 'BNB'];
function renderPortfolio() {
  const box = $('#folio');
  box.hidden = !S.account;
  if (!S.account) return;
  const held = FOLIO.filter((a) => S.hold[a] > 0);
  const known = FOLIO.filter((a) => S.hold[a] != null);
  let total = 0, priced = 0;
  if (!known.length) {
    $('#folioNote').textContent = '';
    $('#folioBody').innerHTML = '<p class="folio-none">Reading your balances.</p>';
    return;
  }
  if (!held.length) {
    $('#folioNote').textContent = '';
    $('#folioBody').innerHTML = `<p class="folio-none">This wallet holds no ${esc(known.join(', ').replace(/, ([^,]*)$/, ' or $1'))}. You can still buy protection with any amount.</p>`;
    return;
  }
  $('#folioBody').innerHTML = `<ul class="folio-list">${held.map((a) => {
    const n = S.hold[a], ap = assetPrice(a), v = ap ? n * ap.price : null;
    if (v != null) { total += v; priced++; }
    const can = (S.assets ?? []).includes(a);
    return `<li><span class="f-asset">${esc(a)} <span class="f-qty">${esc(fmtQty(n))}</span></span>
      <span class="f-val">${v != null ? esc(usd(v)) : '<span class="muted small">No feed price</span>'}</span>
      <span class="f-act">${can ? `<button type="button" class="btn btn-sm${a === S.asset ? ' btn-ink' : ''}" data-folio="${esc(a)}" aria-label="Protect your ${esc(a)}">${a === S.asset ? 'Selected' : 'Protect'}</button>` : '<span class="small muted">No open levels</span>'}</span></li>`;
  }).join('')}</ul>`;
  $('#folioNote').textContent = priced ? `${usd(total)} at live feed prices` : '';
}

// Live line in the hero: real counts from the chain.
function renderLive() {
  const ms = [...S.markets.values()];
  if (!ms.length) return;
  const open = ms.filter(live).length;
  const assets = S.assets ?? [];
  const list = assets.length > 1 ? `${assets.slice(0, -1).join(', ')} and ${assets.at(-1)}` : assets[0] ?? '';
  $('#heroLive').innerHTML = `<i class="dot live" aria-hidden="true"></i><span>Live on BNB Chain. <b>${open}</b> open market${open === 1 ? '' : 's'}${list ? ` on ${esc(list)}` : ''}.</span>`;
}

function renderWallet() {
  const b = $('#connect');
  document.body.classList.toggle('wallet-on', !!S.account);
  if (!S.account) { b.textContent = 'Connect wallet'; b.title = ''; b.removeAttribute('aria-label'); return; }
  const bal = S.balance != null ? compactUsd(S.balance) : null;
  b.innerHTML = `${bal ? `<span class="w-bal mono">${esc(bal)}</span>` : ''}<span class="w-addr mono">${esc(short(S.account))}</span>`;
  b.title = `${S.account}${S.balance != null ? `\n${usd(S.balance)} hUSD-DEMO` : ''}`;
  b.setAttribute('aria-label', `Wallet ${short(S.account)}${S.balance != null ? `, ${usd(S.balance)} hUSD-DEMO` : ''}`);
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
  renderPortfolio();
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
  const low = legs.at(-1).strike, top = legs[0].strike;
  const prem = wad(maxCost), quoteNow = wad(net);
  $('#cfWhat').textContent = q.stair
    ? `You get up to ${money(q.payout)} if ${q.asset} ends at or below ${usd(low)} at the deadline, ${when(q.deadline)}. Above ${usd(top)} you get $0. The ${SRC_LONG[q.source]} price settles it.`
    : `You get ${money(q.payout)} if ${q.asset} is at or below ${usd(low)} at the deadline, ${when(q.deadline)}. Above it you get $0. The ${SRC_LONG[q.source]} price settles it.`;
  // Price impact: the AMM price now against the average price this order pays.
  const shares = legs.reduce((s, l) => s + l.sharesNum, 0);
  const pNow = legs.every((l) => l.m.yes != null) ? legs.reduce((s, l) => s + l.sharesNum * l.m.yes, 0) / shares : null;
  const pAvg = quoteNow / shares;
  const impact = pNow != null ? `${cents(pNow)} now → ${cents(pAvg)} average per $1 (${pAvg >= pNow ? '+' : '−'}${(Math.abs(pAvg - pNow) * 100).toFixed(1)}¢)${legs.length === 1 ? `, ${cents(wad(legs[0].newPrice))} after your buy` : ''}` : `${cents(pAvg)} average per $1`;
  $('#cfSum').innerHTML = `
    <dt>Premium (most you pay)</dt><dd class="total">${usd(prem)} <span class="muted">(quote ${usd(quoteNow)}, ${Number(SLIP_BPS) / 100}% slippage)</span></dd>
    <dt>Payout</dt><dd>${q.stair ? 'up to ' : ''}${money(q.payout)}</dd>
    <dt>${legs.length > 1 ? 'Levels' : 'Level'}</dt><dd>${legs.length > 1 ? `${usd(top)} to ${usd(low)}, ${legs.length} levels` : usd(low)}</dd>
    <dt>Expiry</dt><dd>${when(q.deadline)}, at the deadline</dd>
    <dt>Price impact</dt><dd>${impact}</dd>
    <dt>Network fee</dt><dd id="cfGas">Estimating.</dd>`;
  $('#cfLegs').innerHTML = `<thead><tr><th scope="col">Level</th><th scope="col" class="r">Shares</th><th scope="col" class="r">Cost</th><th scope="col" class="r">Pays if at or below</th></tr></thead><tbody>${legs.map((l) => `<tr><td class="mono">${usd(l.strike)}</td><td class="r">${l.sharesNum.toFixed(2)}</td><td class="r">${usd(wad(l.net))}</td><td class="r">${money(l.sharesNum)}</td></tr>`).join('')}</tbody>${legs.length > 1 ? `<tfoot><tr><th scope="row">Total</th><td class="r">${shares.toFixed(2)}</td><td class="r">${usd(quoteNow)}</td><td class="r">${money(q.payout)}</td></tr></tfoot>` : ''}`;
  // Scenarios by price zone at the deadline. Payout adds up as each level is crossed.
  const zones = [[`Above ${usd(top)}`, 0]];
  let cum = 0;
  legs.forEach((l, i) => { cum += l.sharesNum; zones.push([legs[i + 1] ? `${usd(legs[i + 1].strike)} < price ≤ ${usd(l.strike)}` : `At or below ${usd(l.strike)}`, cum]); });
  $('#cfScen').innerHTML = `<thead><tr><th scope="col">Price at the deadline</th><th scope="col" class="r">You get</th><th scope="col" class="r">Net</th></tr></thead><tbody>${zones.map(([k, got]) => `<tr><td>${k}</td><td class="r">${money(got)}</td><td class="r ${got - prem < 0 ? 'neg' : 'pos'}">${usd(got - prem)}</td></tr>`).join('')}</tbody>`;
  $('#cfScenNote').textContent = `Net = what you get minus the premium (${usd(prem)}, the most you pay). If the order fills at the quote, net is up to ${usd(prem - quoteNow)} better.`;
  $('#cfRows').innerHTML = `
    <dt>Fee, included</dt><dd>${usd(wad(fee))}</dd>
    <dt>Limit per order</dt><dd>${usd(MAX_TRADE, 0)} <span class="muted">(this page)</span></dd>
    <dt>Paid in</dt><dd>hUSD-DEMO, demo money</dd>`;
  estimateGas(CF);
  $('#cfSteps').innerHTML = `${needApprove ? `<li data-s="approve">Allow the Sooth AMM to take up to ${usd(wad(maxCost))} hUSD-DEMO</li>` : ''}${legs.map((l, i) => `<li data-s="buy${i}">Buy the ${usd(l.strike)} level, ${usd(l.sharesNum)}</li>`).join('')}`;
  setMsg('#cfMsg', legs.length > 1 ? `Your wallet asks ${legs.length + (needApprove ? 1 : 0)} times, once per step.` : '');
  $('#cfGo').disabled = false;
  $('#cfGo').textContent = 'Confirm in wallet';
  $('#confirm').showModal();
}

// Network fee: eth_estimateGas × gas price for each buy. Read only: nothing is sent.
// Before an approval the estimate fails (no allowance yet); then the wallet shows the fee.
async function estimateGas(q) {
  const out = (t) => { if (CF === q && $('#cfGas')) $('#cfGas').textContent = t; };
  try {
    const [gp, ...gs] = await Promise.all([pub.getGasPrice(), ...q.legs.map((l) => pub.estimateContractGas({ address: cfg.amm, abi: AMM, functionName: 'tradePositions', args: [l.market, 1, l.shares, l.maxCost], account: S.account }))]);
    const wei = gs.reduce((s, g) => s + g, 0n) * gp;
    out(`about ${Number(formatUnits(wei, 18)).toPrecision(2)} BNB (${gs.reduce((s, g) => s + g, 0n).toLocaleString('en-US')} gas at ${Number(formatUnits(gp, 9)).toPrecision(2)} gwei)`);
  } catch { out('Shown in your wallet.'); }
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
    toast(`Protected: ${q.stair ? 'up to ' : ''}${esc(money(q.payout))} if ${esc(q.asset)} ends at or below ${usd(q.stair ? q.legs[0].strike : q.legs.at(-1).strike)} at the deadline. ${link(txUrl(lastHash), 'View tx')}`);
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
$('#modeSeg').addEventListener('change', (e) => { S.mode = e.target.value; renderSel(); });
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

// "Protect" in the portfolio strip: pick that asset in the main flow and go to the chart.
$('#folioBody').addEventListener('click', (e) => {
  const b = e.target.closest('[data-folio]');
  if (!b) return;
  S.asset = b.dataset.folio; S.end = null; S.sel = null; S.cover = null;
  renderAll();
  $('#protect').scrollIntoView({ behavior: calm.matches ? 'auto' : 'smooth', block: 'start' });
  document.querySelector(`#assetSeg input[value="${CSS.escape(S.asset)}"]`)?.focus({ preventScroll: true });
});

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
// Type a level: snaps to the nearest level that has a market. Arrow keys step through levels.
const lvlInput = $('#lvlInput');
const takeLevel = (m) => { if (!m) { syncLevelInput(); return; } setFloor(m.addr); lvlInput.value = String(m.strike); };
lvlInput.addEventListener('keydown', (e) => {
  const lv = levels(), i = lv.findIndex((m) => m.addr === S.sel);
  const k = { ArrowUp: -1, ArrowDown: 1, PageUp: -1, PageDown: 1 }[e.key];
  if (k) { e.preventDefault(); takeLevel(lv[Math.max(0, Math.min(lv.length - 1, i + k))]); }
  else if (e.key === 'Enter') { e.preventDefault(); takeLevel(snapLevel(Number(lvlInput.value))); }
});
lvlInput.addEventListener('change', () => takeLevel(snapLevel(Number(lvlInput.value))));
lvlInput.addEventListener('blur', () => syncLevelInput());
$('#chList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-m]');
  if (!b) return;
  setFloor(b.dataset.m);
  $(`#chList [data-m="${CSS.escape(b.dataset.m)}"]`)?.focus();
});
$('#agRefresh').onclick = refreshReport;
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
    if (!S.markets.size) $('#heroLive').textContent = 'Cannot reach BNB Chain right now. The page tries again in 30 s.';
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
