// Creates a strike ladder of protection markets for one Atlas asset.
// It reads the live Atlas price, picks strikes below it, sets each start price from the
// fair-price model, and runs the CreateMarket forge script once per strike.
//
// Usage (from the repo root; PRIVATE_KEY and the RPC come from the environment, never from a file in git):
//   RPC=http://127.0.0.1:8545 PRIVATE_KEY=0x... DEPLOYMENT_FILE=deployments/fork-56.json \
//     node scripts/create-ladder.mjs --symbol IWMB --feed-id 1166 --deadline 1796101200 \
//     --steps 0.99,0.98,0.96 --sigma 0.25 [--round 1] [--kind 1] [--bbase 1000] [--max-input 5000] \
//     [--max-delay 300] [--dry]
//
// --kind      0 close above, 1 close below (default). 2 and 3 (touch) need --allow-touch, and the
//             contract script refuses them unless ALLOW_TOUCH=1: a trader can buy and settle a touch
//             market in one tx right after a cross. This flag passes ALLOW_TOUCH=1.
// --round     strike step in dollars. Default: a clean number near 0.5% of spot (1, 2, 2.5, 5 x 10^n).
// --bbase     LMSR depth in collateral units (default 1000). Passed as BBASE (wei).
// --max-input largest single trade in collateral units (default 5000). Passed as MAX_INPUT (wei).
// --max-delay seconds after the deadline a close read may come (default 300, contract cap 3600).
import { spawnSync } from 'node:child_process';
import { createPublicClient, http, parseAbi, formatUnits, parseUnits } from 'viem';
import { fairProbability, KIND } from '../agent/src/model.mjs';

const ATLAS = '0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? 'true' : all[i + 1]]);
  return acc;
}, []));

/** A clean step near `x`: 1, 2, 2.5 or 5 times a power of ten, nearest on a log scale. */
export function cleanStep(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).sort((a, b) => Math.abs(Math.log(a / x)) - Math.abs(Math.log(b / x)))[0];
}

/** Strikes below spot, rounded down to `round`, without duplicates, highest first. */
export function ladderStrikes(spot, steps, round) {
  const dp = Math.max(0, -Math.floor(Math.log10(round)) + 1);
  const out = [], dropped = [];
  for (const step of steps) {
    const strike = Number((Math.floor((spot * step) / round + 1e-9) * round).toFixed(dp));
    if (!(strike > 0) || strike >= spot) dropped.push({ step, strike, why: 'not below spot' });
    else if (out.includes(strike)) dropped.push({ step, strike, why: 'duplicate after rounding' });
    else out.push(strike);
  }
  return { strikes: out.sort((a, b) => b - a), dropped };
}

const num = (k, d) => { const n = Number(args[k] ?? d); if (!Number.isFinite(n)) throw new Error(`--${k} must be a number`); return n; };

async function main() {
  const symbol = args.symbol ?? 'IWMB';
  const feedId = num('feed-id', 1166);
  const deadline = num('deadline', 1796101200);
  const steps = (args.steps ?? '0.99,0.98,0.96').split(',').map(Number);
  const sigma = num('sigma', 0.25);
  const kind = num('kind', KIND.CLOSE_BELOW);
  const allowTouch = args['allow-touch'] === 'true';
  const bbase = num('bbase', 1000);
  const maxInput = num('max-input', 5000);
  const maxDelay = num('max-delay', 300);
  const dry = args.dry === 'true';
  if (![0, 1, 2, 3].includes(kind)) throw new Error('--kind must be 0, 1, 2 or 3');
  if (kind >= 2 && !allowTouch) throw new Error('Touch markets (kind 2, 3) are off: a trader can buy and settle in one tx after a cross. Pass --allow-touch only if you accept that.');
  if (!(maxDelay > 0 && maxDelay <= 3600)) throw new Error('--max-delay must be 1 to 3600 seconds');
  if (!(bbase > 0) || !(maxInput > 0)) throw new Error('--bbase and --max-input must be positive');
  if (steps.some((s) => !(s > 0 && s < 1))) throw new Error('--steps must be fractions below 1, for example 0.99,0.98');
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
  const round = args.round != null ? num('round') : cleanStep(spot * 0.005);
  const now = Math.floor(Date.now() / 1000);
  if (deadline <= now) throw new Error('Deadline is in the past');
  const day = new Date(deadline * 1000).toISOString().replace(':00.000Z', ' UTC').replace('T', ' ');
  console.log(`${symbol} Atlas price $${spot.toFixed(2)} (published ${now - Number(ts)}s ago). Strike step $${round}.`);

  const { strikes, dropped } = ladderStrikes(spot, steps, round);
  for (const d of dropped) console.log(`- skip step ${d.step}: $${d.strike} is ${d.why}`);
  if (!strikes.length) throw new Error('No strikes left. Use lower steps or a smaller --round.');

  const words = ['above', 'below', 'touches above', 'touches below'][kind];
  for (const strike of strikes) {
    const p = fairProbability({ kind, spot, strike, sigma, now, deadline });
    const prob = Math.min(0.95, Math.max(0.02, p)); // the AMM needs a start price inside (0, 1)
    const question = kind >= 2 ? `${symbol} ${words} $${strike} before ${day} (Atlas Oracle)` : `${symbol} ${words} $${strike} at ${day} (Atlas Oracle)`;
    const env = {
      ...process.env,
      QUESTION: question,
      DEADLINE: String(deadline),
      SOURCE: '0',
      FEED: ATLAS,
      FEED_ID: String(feedId),
      KIND: String(kind),
      STRIKE: parseUnits(String(strike), 18).toString(),
      PROB: parseUnits(prob.toFixed(6), 18).toString(),
      BBASE: parseUnits(String(bbase), 18).toString(),
      MAX_INPUT: parseUnits(String(maxInput), 18).toString(),
      MAX_DELAY: String(maxDelay),
      ...(kind >= 2 ? { ALLOW_TOUCH: 'true' } : {}),
    };
    console.log(`- ${question}: start price ${(prob * 100).toFixed(1)}%, depth ${bbase}, max trade ${maxInput}`);
    if (dry) continue;
    const r = spawnSync('forge', ['script', 'script/DeployHedge.s.sol:CreateMarket', '--rpc-url', rpc, '--broadcast', '--slow'],
      { cwd: new URL('../contracts/', import.meta.url).pathname, env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
    if (r.status !== 0) { console.error(r.stdout.split(rpc).join('[rpc]')); throw new Error(`CreateMarket failed for strike ${strike}`); }
    console.log('  created (read the real address from MarketCreated events: npm run web:config)');
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    const rpc = process.env.RPC ?? process.env.BSC_RPC_URL;
    const msg = String(e.shortMessage ?? e.message);
    console.error(`Error: ${rpc ? msg.split(rpc).join('[rpc]') : msg}`);
    process.exit(1);
  });
}
