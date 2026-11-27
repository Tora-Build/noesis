// Build web/config.json from a deployment file and the MarketCreated events, and copy the
// agent's reports (agent/out/*.json) that belong to these markets to web/reports/.
//
//   node scripts/build-web.mjs [--deployment contracts/deployments/56.json] [--rpc URL]
//     [--page-rpc https://bsc-dataseed.bnbchain.org] [--out web] [--max-trade 500] [--slippage 200]
//
// --rpc is only used here, to read the chain. It can be a private keyed URL. It is never written.
// --page-rpc is written into config.json and is public. It must be on the allowlist below.
// Fork runs: DEPLOYMENT_FILE=deployments/fork-56.json (relative to contracts/) and
// --page-rpc http://127.0.0.1:8545.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_PAGE_RPC = 'https://bsc-dataseed.bnbchain.org';

// Public BSC RPCs that need no key. Only origins: no path, no query, so no key can hide in them.
const PUBLIC_RPC = [
  /^https:\/\/bsc-dataseed[1-4]?\.bnbchain\.org\/?$/,
  /^https:\/\/bsc-dataseed[1-4]?\.binance\.org\/?$/,
  /^https:\/\/bsc-rpc\.publicnode\.com\/?$/,
];
const LOCAL_RPC = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/;

/** Throws unless `url` is a public BSC RPC (or a local node when `allowLocal`). */
export function checkPageRpc(url, { allowLocal = true } = {}) {
  if (PUBLIC_RPC.some((r) => r.test(url))) return url;
  if (allowLocal && LOCAL_RPC.test(url)) return url;
  throw new Error(`Refusing page RPC: it is not on the public allowlist (${allowLocal ? 'bsc-dataseed*.bnbchain.org, bsc-dataseed*.binance.org, bsc-rpc.publicnode.com, 127.0.0.1, localhost' : 'bsc-dataseed*.bnbchain.org, bsc-dataseed*.binance.org, bsc-rpc.publicnode.com'}). The page RPC is public, so a keyed URL must never go there.`);
}

/**
 * Pure: which reports belong on the page? Same chain, same AMM, market listed in the config.
 * @returns {{ keep: {file, report}[], skipped: {file, why}[] }}
 */
export function filterReports(entries, cfg) {
  const markets = new Set(cfg.markets.map((m) => m.market.toLowerCase()));
  const keep = [], skipped = [];
  for (const { file, report: r } of entries) {
    const market = String(r?.market ?? '').toLowerCase();
    const amm = String(r?.inputs?.sooth?.amm ?? '').toLowerCase();
    const chainId = r?.chainId ?? r?.proof?.chainId ?? null;
    let why = null;
    if (!markets.has(market)) why = 'market not in config';
    else if (amm !== String(cfg.amm).toLowerCase()) why = 'other AMM';
    else if (chainId == null) why = 'no chainId (old report, rerun the agent)';
    else if (Number(chainId) !== Number(cfg.chainId)) why = `chain ${chainId}`;
    else if (r.mode === 'offline') why = 'offline fixture';
    if (why) skipped.push({ file, why }); else keep.push({ file, report: r });
  }
  return { keep, skipped };
}

function defaultDeployment() {
  const f = process.env.DEPLOYMENT_FILE;
  if (!f) return join(ROOT, 'contracts/deployments/56.json');
  return isAbsolute(f) ? f : join(ROOT, 'contracts', f);
}

/** Build config.json and reports/ into `out`. Returns a summary. */
export async function buildWeb(o) {
  const out = resolve(o.out ?? join(ROOT, 'web'));
  const pageRpc = checkPageRpc(o.pageRpc ?? DEFAULT_PAGE_RPC, { allowLocal: !o.mainnetOnly });
  const d = JSON.parse(readFileSync(o.deployment ?? defaultDeployment(), 'utf8'));
  const client = createPublicClient({ transport: http(o.rpc) });
  // Optional separate RPC for getLogs (the bot uses a public log RPC and a private read RPC).
  const logClient = o.logRpc ? createPublicClient({ transport: http(o.logRpc) }) : client;
  const rpcChain = await client.getChainId();
  if (o.mainnetOnly && (d.chainId !== 56 || rpcChain !== 56)) throw new Error(`Mainnet build needs chain 56 (deployment ${d.chainId}, RPC ${rpcChain}).`);
  if (rpcChain !== d.chainId) throw new Error(`The read RPC is on chain ${rpcChain}, the deployment file says ${d.chainId}.`);
  const created = parseAbiItem('event MarketCreated(address indexed market, address indexed creator, string question, uint64 startTime, uint64 deadline, address tokenA, uint8 tokenADecimals, uint256 bBase, address adjudicator, uint256 lpPositionId, uint256 nonce)');

  // Asset labels for the page. Atlas MultiFeed ids and the Chainlink feeds named at deploy.
  const ATLAS_IDS = { 1163: 'EWJB', 1164: 'EWTB', 1165: 'EWZB', 1166: 'IWMB', 1167: 'MELIB', 1168: 'NUB' };
  const AGGREGATORS = {
    '0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee': 'BNB',
    '0x264990fbd0a4796a3e3d8e37c4d5f87a3aca5ebf': 'BTC',
  };
  const termsAbi = parseAbi(['function terms(address) view returns ((uint8 source, address feed, bytes4 feedId, uint8 kind, uint256 strikeWad, uint64 maxDelay))']);
  const assetOf = (t) => t.source === 0 ? ATLAS_IDS[parseInt(t.feedId, 16)] : AGGREGATORS[t.feed.toLowerCase()];

  const latest = await client.getBlockNumber();
  const markets = [];
  for (let from = BigInt(d.block); from <= latest; from += 5000n) {
    const to = from + 4999n > latest ? latest : from + 4999n;
    const logs = await logClient.getLogs({ address: d.marketFactory, event: created, fromBlock: from, toBlock: to });
    for (const l of logs) {
      if (l.args.adjudicator.toLowerCase() !== d.adjudicator.toLowerCase()) continue;
      const t = await client.readContract({ address: d.adjudicator, abi: termsAbi, functionName: 'terms', args: [l.args.market] });
      // Skip a market whose question names a strike other than its on-chain strike
      // (a creation typo). The terms decide the payout, so the text must match them.
      const named = /\$([\d,]+(?:\.\d+)?)/.exec(l.args.question)?.[1];
      if (named && Math.abs(Number(named.replace(/,/g, '')) - Number(t.strikeWad) / 1e18) > 1e-6) {
        console.warn(`  skipped market ${l.args.market}: question says $${named}, terms say $${Number(t.strikeWad) / 1e18}`);
        continue;
      }
      markets.push({
        market: l.args.market, question: l.args.question, deadline: Number(l.args.deadline),
        asset: assetOf(t) ?? null, source: t.source, feed: t.feed, feedId: t.feedId, kind: t.kind,
        strike: t.strikeWad.toString(), maxDelay: Number(t.maxDelay), block: Number(l.blockNumber),
      });
    }
  }
  // Public log RPCs can return too few events. The bot keeps every market it found or made in
  // its state file, so add those too. A market must never drop off the page.
  const knownFile = o.stateFile && existsSync(o.stateFile) ? o.stateFile : null;
  if (knownFile) {
    const have = new Set(markets.map((m) => m.market.toLowerCase()));
    const known = JSON.parse(readFileSync(knownFile, 'utf8')).markets ?? {};
    for (const [market, m] of Object.entries(known)) {
      if (have.has(market.toLowerCase())) continue;
      markets.push({
        market, question: m.question, deadline: Number(m.deadline), asset: m.asset ?? null, source: Number(m.source),
        feed: m.feed, feedId: m.feedId, kind: Number(m.kind), strike: String(m.strikeWad), maxDelay: Number(m.maxDelay), block: Number(m.block),
      });
    }
    markets.sort((a, b) => a.block - b.block);
  }
  const config = {
    chainId: d.chainId, chainName: 'BNB Smart Chain', rpc: pageRpc,
    explorer: 'https://bscscan.com', adjudicator: d.adjudicator, amm: d.amm,
    marketFactory: d.marketFactory, stable: d.stable, faucet: o.faucet ?? true, deployBlock: Number(d.block),
    maxTrade: Number(o.maxTrade ?? 500), slippageBps: Number(o.slippage ?? 200), markets,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'config.json'), JSON.stringify(config, null, 2) + '\n');

  // Reports: start clean so a report from another deployment never stays behind.
  const reportsDir = join(out, 'reports');
  rmSync(reportsDir, { recursive: true, force: true });
  mkdirSync(reportsDir, { recursive: true });
  const src = o.reports ?? join(ROOT, 'agent/out');
  const entries = existsSync(src) ? readdirSync(src).filter((f) => /^0x[0-9a-fA-F]{40}\.json$/.test(f)).map((file) => {
    try { return { file, report: JSON.parse(readFileSync(join(src, file), 'utf8')) }; } catch { return { file, report: null }; }
  }) : [];
  const { keep, skipped } = filterReports(entries, config);
  for (const { report } of keep) writeFileSync(join(reportsDir, `${report.market.toLowerCase()}.json`), JSON.stringify(report, null, 2));
  // Atlas Consensus Score history from the bot, for the Oracle intelligence page.
  if (existsSync(join(src, 'atlas-history.json'))) {
    try { writeFileSync(join(reportsDir, 'atlas-history.json'), JSON.stringify(JSON.parse(readFileSync(join(src, 'atlas-history.json'), 'utf8')))); } catch {}
  }
  return { out, markets: markets.length, reports: keep.length, skipped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: {
    deployment: { type: 'string' },
    rpc: { type: 'string', default: process.env.BSC_RPC_URL ?? DEFAULT_PAGE_RPC },
    'page-rpc': { type: 'string', default: DEFAULT_PAGE_RPC },
    out: { type: 'string' },
    reports: { type: 'string' },
    'max-trade': { type: 'string', default: '500' }, // page limit per trade, in hUSD-DEMO
    slippage: { type: 'string', default: '200' }, // max slippage in basis points
  } });
  try {
    const r = await buildWeb({ deployment: v.deployment, rpc: v.rpc, pageRpc: v['page-rpc'], out: v.out, reports: v.reports, maxTrade: v['max-trade'], slippage: v.slippage });
    for (const s of r.skipped) console.log(`  skipped report ${s.file}: ${s.why}`);
    console.log(`${r.markets} market(s), ${r.reports} report(s) -> ${r.out}/config.json`);
  } catch (e) {
    // The read RPC can hold a key. Never print it.
    console.error(`Error: ${String(e.shortMessage ?? e.message).split(v.rpc).join('[read RPC]')}`);
    process.exit(1);
  }
}
