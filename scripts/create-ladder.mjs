// Creates a strike ladder of "close below" protection markets for one Atlas asset.
// It reads the live Atlas price, picks strikes below it, sets each start price from the
// fair-price model, and runs the CreateMarket forge script once per strike.
//
// Usage (from the repo root; PRIVATE_KEY and the RPC come from the environment, never from a file in git):
//   RPC=http://127.0.0.1:8545 PRIVATE_KEY=0x... node scripts/create-ladder.mjs \
//     --symbol IWMB --feed-id 1166 --deadline 1796101200 --steps 0.99,0.98,0.96 --sigma 0.25 [--dry]
import { spawnSync } from 'node:child_process';
import { createPublicClient, http, parseAbi, formatUnits, parseUnits } from 'viem';
import { fairProbability, KIND } from '../agent/src/model.mjs';

const ATLAS = '0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]);
  return acc;
}, []));

const symbol = args.symbol ?? 'IWMB';
const feedId = Number(args['feed-id'] ?? 1166);
const deadline = Number(args.deadline ?? 1796101200);
const steps = (args.steps ?? '0.99,0.98,0.96').split(',').map(Number);
const sigma = Number(args.sigma ?? 0.25);
const round = Number(args.round ?? 1); // round strikes to this many dollars
const dry = args.dry === 'true';
const rpc = process.env.RPC ?? process.env.BSC_RPC_URL;
if (!rpc) throw new Error('Set RPC or BSC_RPC_URL');
if (!dry && !process.env.PRIVATE_KEY) throw new Error('Set PRIVATE_KEY (or pass --dry)');

const pub = createPublicClient({ transport: http(rpc) });
const [price, ts] = await pub.readContract({
  address: ATLAS,
  abi: parseAbi(['function fetch(bytes4) view returns (uint80 price, uint48 aggregatedTs, uint48 onchainTs)']),
  functionName: 'fetch',
  args: [`0x${feedId.toString(16).padStart(8, '0')}`],
});
const spot = Number(formatUnits(price, 18));
const now = Math.floor(Date.now() / 1000);
if (deadline <= now) throw new Error('Deadline is in the past');
const day = new Date(deadline * 1000).toISOString().replace(':00.000Z', ' UTC').replace('T', ' ');
console.log(`${symbol} Atlas price $${spot.toFixed(2)} (published ${now - Number(ts)}s ago)`);

for (const step of steps) {
  const strike = Math.round((spot * step) / round) * round;
  const p = fairProbability({ kind: KIND.CLOSE_BELOW, spot, strike, sigma, now, deadline });
  const prob = Math.min(0.95, Math.max(0.02, p)); // the AMM needs a start price inside (0, 1)
  const question = `${symbol} below $${strike} at ${day} (Atlas Oracle)`;
  const env = {
    ...process.env,
    QUESTION: question,
    DEADLINE: String(deadline),
    SOURCE: '0',
    FEED: ATLAS,
    FEED_ID: String(feedId),
    KIND: String(KIND.CLOSE_BELOW),
    STRIKE: parseUnits(String(strike), 18).toString(),
    PROB: parseUnits(prob.toFixed(6), 18).toString(),
  };
  console.log(`- ${question}: start price ${(prob * 100).toFixed(1)}%`);
  if (dry) continue;
  const r = spawnSync('forge', ['script', 'script/DeployHedge.s.sol:CreateMarket', '--rpc-url', rpc, '--broadcast', '--slow'],
    { cwd: new URL('../contracts/', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stdout); throw new Error(`CreateMarket failed for strike ${strike}`); }
  console.log('  created (read the real address from MarketCreated events: npm run web:config)');
}
