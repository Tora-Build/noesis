// Publish the page to GitHub Pages (branch gh-pages of this repo's origin).
//
//   npm run pages                  # build into a temp dir and push it to gh-pages
//   npm run pages -- --no-push     # build only, print the dir to look at
//   npm run pages -- --rpc <url>   # read RPC for the build (can be private; never written)
//
// It builds web/ with a BSC mainnet config (contracts/deployments/56.json, chain 56, public page
// RPC) and only the agent reports for these markets. The gh-pages branch holds the build only.
// Each publish is one new commit that replaces the branch (force push). main and develop are
// never touched. In the repo settings set Pages to "Deploy from a branch: gh-pages / (root)".
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWeb, DEFAULT_PAGE_RPC } from './build-web.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { values: v } = parseArgs({ options: {
  rpc: { type: 'string', default: process.env.BSC_RPC_URL ?? DEFAULT_PAGE_RPC },
  'page-rpc': { type: 'string', default: DEFAULT_PAGE_RPC },
  deployment: { type: 'string', default: join(ROOT, 'contracts/deployments/56.json') },
  remote: { type: 'string', default: 'origin' },
  branch: { type: 'string', default: 'gh-pages' },
  'no-push': { type: 'boolean', default: false },
  'max-trade': { type: 'string', default: '500' },
  slippage: { type: 'string', default: '200' },
} });

const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`);
  return r.stdout.trim();
};

try {
  const dir = mkdtempSync(join(tmpdir(), 'sooth-hedge-pages-'));
  // Static files: everything in web/ except the generated config.json and reports/.
  for (const f of readdirSync(join(ROOT, 'web'))) {
    if (f === 'config.json' || f === 'reports' || f.startsWith('.')) continue;
    cpSync(join(ROOT, 'web', f), join(dir, f), { recursive: true });
  }
  const r = await buildWeb({
    deployment: v.deployment, rpc: v.rpc, pageRpc: v['page-rpc'], out: dir, mainnetOnly: true,
    maxTrade: v['max-trade'], slippage: v.slippage,
  });
  for (const s of r.skipped) console.log(`  skipped report ${s.file}: ${s.why}`);
  if (!r.markets) throw new Error('No markets found for this deployment. Nothing to publish.');
  writeFileSync(join(dir, '.nojekyll'), ''); // serve files as they are
  console.log(`${r.markets} market(s), ${r.reports} report(s) built in ${dir}`);
  if (v['no-push']) {
    console.log(`Not pushed (--no-push). Look at it: npx http-server@14.1.1 ${dir} -p 8081`);
    process.exit(0);
  }

  const remoteUrl = git(['remote', 'get-url', v.remote], ROOT); // not printed: it can hold a token
  const source = git(['rev-parse', '--short', 'HEAD'], ROOT);
  git(['init', '-q', '-b', v.branch], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', `Publish the page from ${source}`], dir);
  git(['push', '-q', '--force', remoteUrl, `HEAD:refs/heads/${v.branch}`], dir);
  console.log(`Pushed to ${v.remote}/${v.branch}. GitHub Pages serves it in about a minute.`);
} catch (e) {
  console.error(`Error: ${String(e.shortMessage ?? e.message).split(v.rpc).join('[read RPC]')}`);
  process.exit(1);
}
