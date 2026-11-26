// Build web/config.json from a deployment file and the MarketCreated events, and copy
// the agent's reports (agent/out/*.json) to web/reports/.
//   node scripts/build-web.mjs [--deployment contracts/deployments/56.json] [--rpc URL]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';

const { values: o } = parseArgs({ options: {
  deployment: { type: 'string', default: 'contracts/deployments/56.json' },
  rpc: { type: 'string', default: process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org' },
  'page-rpc': { type: 'string' },
  'max-trade': { type: 'string', default: '500' }, // page limit per trade, in hUSD
  slippage: { type: 'string', default: '200' }, // max slippage in basis points
} });
const d = JSON.parse(readFileSync(o.deployment, 'utf8'));
const client = createPublicClient({ transport: http(o.rpc) });
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
  const logs = await client.getLogs({ address: d.marketFactory, event: created, fromBlock: from, toBlock: to });
  for (const l of logs) {
    if (l.args.adjudicator.toLowerCase() !== d.adjudicator.toLowerCase()) continue;
    const t = await client.readContract({ address: d.adjudicator, abi: termsAbi, functionName: 'terms', args: [l.args.market] });
    markets.push({
      market: l.args.market, question: l.args.question, deadline: Number(l.args.deadline),
      asset: assetOf(t) ?? null, source: t.source, feed: t.feed, feedId: t.feedId, kind: t.kind,
      strike: t.strikeWad.toString(), maxDelay: Number(t.maxDelay), block: Number(l.blockNumber),
    });
  }
}
const config = {
  chainId: d.chainId, chainName: 'BNB Smart Chain', rpc: o['page-rpc'] ?? o.rpc,
  explorer: 'https://bscscan.com', adjudicator: d.adjudicator, amm: d.amm,
  marketFactory: d.marketFactory, stable: d.stable, faucet: true, deployBlock: Number(d.block),
  maxTrade: Number(o['max-trade']), slippageBps: Number(o.slippage), markets,
};
writeFileSync('web/config.json', JSON.stringify(config, null, 2) + '\n');
mkdirSync('web/reports', { recursive: true });
let copied = 0;
if (existsSync('agent/out')) for (const f of readdirSync('agent/out')) {
  if (f.endsWith('.json')) { copyFileSync(`agent/out/${f}`, `web/reports/${f.toLowerCase()}`); copied++; }
}
console.log(`${markets.length} market(s), ${copied} report(s) -> web/config.json`);
