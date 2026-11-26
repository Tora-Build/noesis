// Build web/config.json from a deployment file and the MarketCreated events, and copy
// the agent's reports (agent/out/*.json) to web/reports/.
//   node scripts/build-web.mjs [--deployment contracts/deployments/56.json] [--rpc URL]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createPublicClient, http, parseAbiItem } from 'viem';

const { values: o } = parseArgs({ options: {
  deployment: { type: 'string', default: 'contracts/deployments/56.json' },
  rpc: { type: 'string', default: process.env.BSC_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org' },
  'page-rpc': { type: 'string' },
} });
const d = JSON.parse(readFileSync(o.deployment, 'utf8'));
const client = createPublicClient({ transport: http(o.rpc) });
const created = parseAbiItem('event MarketCreated(address indexed market, address indexed creator, string question, uint64 startTime, uint64 deadline, address tokenA, uint8 tokenADecimals, uint256 bBase, address adjudicator, uint256 lpPositionId, uint256 nonce)');

const latest = await client.getBlockNumber();
const markets = [];
for (let from = BigInt(d.block); from <= latest; from += 5000n) {
  const to = from + 4999n > latest ? latest : from + 4999n;
  const logs = await client.getLogs({ address: d.marketFactory, event: created, fromBlock: from, toBlock: to });
  for (const l of logs) {
    if (l.args.adjudicator.toLowerCase() !== d.adjudicator.toLowerCase()) continue;
    markets.push({ market: l.args.market, question: l.args.question, deadline: Number(l.args.deadline) });
  }
}
const config = {
  chainId: d.chainId, chainName: 'BNB Smart Chain', rpc: o['page-rpc'] ?? o.rpc,
  explorer: 'https://bscscan.com', adjudicator: d.adjudicator, amm: d.amm,
  marketFactory: d.marketFactory, stable: d.stable, faucet: true, markets,
};
writeFileSync('web/config.json', JSON.stringify(config, null, 2) + '\n');
mkdirSync('web/reports', { recursive: true });
let copied = 0;
if (existsSync('agent/out')) for (const f of readdirSync('agent/out')) {
  if (f.endsWith('.json')) { copyFileSync(`agent/out/${f}`, `web/reports/${f.toLowerCase()}`); copied++; }
}
console.log(`${markets.length} market(s), ${copied} report(s) -> web/config.json`);
