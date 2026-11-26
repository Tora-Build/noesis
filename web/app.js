// Sooth Hedge demo page. Reads markets from config.json and the chain; the agent's
// reports (agent/out/*.json, copied by build-config.mjs) add Cournot, CMC and the decision.
import {
  createPublicClient, createWalletClient, custom, http, parseAbi, formatUnits, parseUnits, defineChain,
} from 'https://esm.sh/viem@2.21.0';

const ADJ = parseAbi([
  'function terms(address) view returns ((uint8 source, address feed, bytes4 feedId, uint8 kind, uint256 strikeWad, uint64 maxDelay))',
  'function readFeed(address) view returns (uint256 priceWad, uint64 ts)',
  'function getPhase(address) view returns (uint8)',
  'function getOutcome(address) view returns (uint8)',
  'function canSettle(address) view returns (bool)',
  'function settleFromFeed(address) returns (uint8)',
  'function settle(address)',
]);
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
const KIND = ['Close above', 'Close below', 'Touch above', 'Touch below'];
const PHASE = ['Idle', 'Open', 'Resolved', 'Attested', 'Settled', 'Vetoed'];
const OUTCOME = ['NO', 'YES', 'INVALID'];

const cfg = await (await fetch('config.json')).json();
const chain = defineChain({
  id: cfg.chainId, name: cfg.chainName ?? 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpc] } },
  blockExplorers: { default: { name: 'BscScan', url: cfg.explorer ?? 'https://bscscan.com' } },
});
const pub = createPublicClient({ chain, transport: http(cfg.rpc) });
let wallet = null, account = null;

const $ = (s, el = document) => el.querySelector(s);
const pct = (wad) => wad == null ? '–' : `${(Number(formatUnits(wad, 18)) * 100).toFixed(1)}%`;
const usd = (wad) => `$${Number(formatUnits(wad, 18)).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const ago = (ts) => { const s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts)); return s < 120 ? `${s}s ago` : s < 7200 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };
const until = (ts) => { const s = Number(ts) - Math.floor(Date.now() / 1000); if (s <= 0) return 'Deadline passed'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600); return d ? `Ends in ${d}d ${h}h` : `Ends in ${h}h ${Math.floor((s % 3600) / 60)}m`; };
const txLink = (h) => `<a href="${chain.blockExplorers.default.url}/tx/${h}" target="_blank" rel="noopener">${h.slice(0, 10)}…</a>`;
const fromProb = (p) => p == null ? null : BigInt(Math.round(Number(p) * 1e6)) * 10n ** 12n;

$('#net').textContent = `${cfg.chainName ?? 'BNB Smart Chain'} · node ${cfg.marketFactory.slice(0, 8)}…`;

async function report(market) {
  try { const r = await fetch(`reports/${market.toLowerCase()}.json`); return r.ok ? await r.json() : null; } catch { return null; }
}

async function render() {
  const root = $('#markets');
  root.innerHTML = '';
  if (!cfg.markets?.length) { root.innerHTML = '<p class="muted">No markets yet.</p>'; return; }
  for (const m of cfg.markets) {
    const el = $('#card').content.firstElementChild.cloneNode(true);
    el.dataset.market = m.market;
    root.append(el);
    fill(el, m).catch((e) => { $('.status', el).textContent = `Read failed: ${e.shortMessage ?? e.message}`; });
  }
}

async function fill(el, m) {
  const market = m.market;
  const [t, feed, phase, state, deadline, settled, open] = await Promise.all([
    pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'terms', args: [market] }),
    pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'readFeed', args: [market] }),
    pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'getPhase', args: [market] }),
    pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getMarketState', args: [market] }),
    pub.readContract({ address: market, abi: MARKET, functionName: 'deadline' }),
    pub.readContract({ address: market, abi: MARKET, functionName: 'isSettled' }),
    pub.readContract({ address: market, abi: MARKET, functionName: 'isTradingOpen' }),
  ]);
  $('.q', el).textContent = m.question;
  $('.src', el).textContent = t.source === 0 ? 'Atlas Oracle' : 'Chainlink';
  $('.kind', el).textContent = KIND[t.kind];
  $('.due', el).textContent = settled ? 'Settled' : until(deadline);
  $('.feed', el).textContent = usd(feed[0]);
  $('.feedAge', el).textContent = `published ${ago(feed[1])}`;
  $('.strike', el).textContent = usd(t.strikeWad);
  $('.sooth', el).textContent = pct(state[2]);

  const r = await report(market);
  if (r) {
    const d = r.decision ?? {};
    const inp = r.inputs ?? {};
    $('.cournot', el).textContent = pct(fromProb(d.pCournot ?? inp.cournot?.probability));
    $('.model', el).textContent = pct(fromProb(d.pModel ?? inp.model?.pModel));
    $('.risk', el).textContent = d.risk != null ? `${Math.round(d.risk)}/100` : '–';
    const dec = $('.decision', el);
    dec.className = `decision ${d.action ?? ''}`;
    dec.textContent = d.action
      ? `Agent: ${d.action.replace('_', ' ')}${d.sizeUsd ? ` $${d.sizeUsd}` : ''}. ${d.reason ?? ''}`
      : 'Agent: no decision yet';
    const sent = r.tx?.sent?.trade;
    if (sent) dec.innerHTML += ` ${txLink(sent)}`;
    $('.alerts', el).innerHTML = (d.alerts ?? []).map((a) => `<li>${escapeHtml(a.message ?? a)}</li>`).join('');
    const ev = r.evidence?.lines ?? [];
    $('.evidence ul', el).innerHTML = ev.map((e) => typeof e === 'string'
      ? `<li>${escapeHtml(e)}</li>`
      : `<li>${e.url ? `<a href="${encodeURI(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.source ?? e.title ?? e.url)}</a>` : escapeHtml(e.source ?? '')}${e.summary ? `: ${escapeHtml(e.summary)}` : ''}</li>`).join('');
    $('.evidence', el).hidden = !ev.length;
    $('.agent', el).hidden = false;
  }

  const status = $('.status', el);
  if (phase >= 2) {
    const outcome = await pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'getOutcome', args: [market] });
    status.textContent = `${PHASE[phase]}: ${OUTCOME[outcome]}`;
  } else status.textContent = PHASE[phase];

  for (const b of ['.buyYes', '.buyNo', '.amt']) $(b, el).disabled = !open;
  $('.settleFeed', el).hidden = settled || phase === 2 || phase === 3;
  const can = phase === 2 || phase === 3 ? await pub.readContract({ address: cfg.adjudicator, abi: ADJ, functionName: 'canSettle', args: [market] }) : false;
  $('.finalize', el).hidden = !can;
  $('.claim', el).hidden = !settled;

  $('.buyYes', el).onclick = () => act(el, () => buy(market, 1, $('.amt', el).value));
  $('.buyNo', el).onclick = () => act(el, () => buy(market, 0, $('.amt', el).value));
  $('.settleFeed', el).onclick = () => act(el, () => send(cfg.adjudicator, ADJ, 'settleFromFeed', [market]));
  $('.finalize', el).onclick = () => act(el, () => send(cfg.adjudicator, ADJ, 'settle', [market]));
  $('.claim', el).onclick = () => act(el, () => send(cfg.amm, AMM, 'settlePosition', [market]));
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

async function act(el, fn) {
  const status = $('.status', el);
  try {
    if (!account) await connect();
    status.textContent = 'Confirm in your wallet…';
    const hash = await fn();
    status.innerHTML = `Sent ${txLink(hash)}. Waiting…`;
    const rc = await pub.waitForTransactionReceipt({ hash });
    status.innerHTML = `${rc.status === 'success' ? 'Done' : 'Failed'} ${txLink(hash)}`;
    setTimeout(() => fill(el, cfg.markets.find((m) => m.market === el.dataset.market)), 1500);
  } catch (e) {
    status.textContent = e.shortMessage ?? e.message;
  }
}

async function send(address, abi, functionName, args) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account });
  return wallet.writeContract(request);
}

async function buy(market, outcome, shares) {
  const delta = parseUnits(String(shares || 0), 18);
  if (delta <= 0n) throw new Error('Enter a number of shares');
  const q = await pub.readContract({ address: cfg.amm, abi: AMM, functionName: 'getPositionQuote', args: [market, outcome, delta] });
  const maxCost = (q[2] * 102n) / 100n; // 2% slippage room
  const allowance = await pub.readContract({ address: cfg.stable, abi: ERC20, functionName: 'allowance', args: [account, cfg.amm] });
  if (allowance < maxCost) {
    const h = await send(cfg.stable, ERC20, 'approve', [cfg.amm, maxCost * 10n]);
    await pub.waitForTransactionReceipt({ hash: h });
  }
  return send(cfg.amm, AMM, 'tradePositions', [market, outcome, delta, maxCost]);
}

async function connect() {
  if (!window.ethereum) throw new Error('No wallet found');
  wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
  [account] = await wallet.requestAddresses();
  try { await wallet.switchChain({ id: chain.id }); } catch { await wallet.addChain({ chain }); }
  $('#connect').textContent = `${account.slice(0, 6)}…${account.slice(-4)}`;
  if (cfg.faucet) $('#faucet').hidden = false;
}

$('#connect').onclick = () => connect().catch((e) => alert(e.shortMessage ?? e.message));
$('#faucet').onclick = async () => {
  try {
    if (!account) await connect();
    const h = await send(cfg.stable, ERC20, 'faucet', []);
    await pub.waitForTransactionReceipt({ hash: h });
    alert('1,000 hUSD sent to your wallet.');
  } catch (e) { alert(e.shortMessage ?? e.message); }
};

render();
setInterval(() => document.querySelectorAll('.card').forEach((el) => {
  const m = cfg.markets.find((x) => x.market === el.dataset.market);
  if (m) fill(el, m).catch(() => {});
}), 30_000);
