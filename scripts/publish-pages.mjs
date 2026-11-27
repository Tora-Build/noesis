// Publish the page. Two targets:
//   gh-pages   (default for this CLI): branch gh-pages of this repo's origin.
//   cloudflare (default for the bot): Cloudflare Pages project via wrangler.
//
//   npm run pages                          # build into a temp dir and push it to gh-pages
//   npm run pages -- --target cloudflare   # build and deploy to Cloudflare Pages
//   npm run pages -- --no-push             # build only, print the dir to look at
//   npm run pages -- --rpc <url>           # read RPC for the build (can be private; never written)
//
// It builds web/ with a BSC mainnet config (contracts/deployments/56.json, chain 56, public page
// RPC) and only the agent reports for these markets.
// gh-pages: each publish is one new commit that replaces the branch (force push). main and develop
// are never touched. In the repo settings set Pages to "Deploy from a branch: gh-pages / (root)".
// cloudflare: needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. They are
// passed to wrangler and never printed. Project name: --project or CF_PAGES_PROJECT (default noesis).
import { cpSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWeb, DEFAULT_PAGE_RPC } from './build-web.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').at(-1)}`);
  return r.stdout.trim();
};

/** Build the static site into a new temp dir. Returns { dir, markets, reports, skipped }. */
export async function buildSite({ rpc, logRpc, pageRpc = DEFAULT_PAGE_RPC, deployment = join(ROOT, 'contracts/deployments/56.json'),
  reports, stateFile, maxTrade = '500', slippage = '200' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sooth-hedge-pages-'));
  // Static files: everything in web/ except the generated config.json and reports/.
  for (const f of readdirSync(join(ROOT, 'web'))) {
    if (f === 'config.json' || f === 'reports' || f.startsWith('.')) continue;
    cpSync(join(ROOT, 'web', f), join(dir, f), { recursive: true });
  }
  const r = await buildWeb({ deployment, rpc, logRpc, pageRpc, out: dir, mainnetOnly: true, reports, stateFile, maxTrade, slippage });
  writeFileSync(join(dir, '.nojekyll'), ''); // serve files as they are
  return { dir, markets: r.markets, reports: r.reports, skipped: r.skipped };
}

/** Force-push `dir` as the only commit of `branch` on `remote`. */
export function pushGhPages(dir, { remote = 'origin', branch = 'gh-pages' } = {}) {
  const remoteUrl = git(['remote', 'get-url', remote], ROOT); // not printed: it can hold a token
  const source = git(['rev-parse', '--short', 'HEAD'], ROOT);
  git(['init', '-q', '-b', branch], dir);
  git(['add', '-A'], dir);
  // Use the configured git identity. A server account without one gets a plain bot identity.
  const hasId = spawnSync('git', ['config', 'user.email'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const id = hasId ? [] : ['-c', 'user.name=Sooth Hedge bot', '-c', 'user.email=bot@localhost'];
  git([...id, 'commit', '-q', '-m', `Publish the page from ${source}`], dir);
  git(['push', '-q', '--force', remoteUrl, `HEAD:refs/heads/${branch}`], dir);
}

/**
 * Deploy `dir` to Cloudflare Pages with wrangler. The token and account id come from `env`
 * and are never printed. Wrangler output is not returned (it can echo account details).
 */
export function deployCloudflare(dir, { project = process.env.CF_PAGES_PROJECT || 'noesis', branch = 'main', env = process.env, timeoutMs = 300_000 } = {}) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID');
  if (!/^[a-z0-9-]{1,58}$/.test(project)) throw new Error('Bad Cloudflare Pages project name');
  const secrets = [env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID];
  const scrub = (s) => secrets.reduce((t, x) => t.split(x).join('[redacted]'), String(s));
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['--yes', 'wrangler@4', 'pages', 'deploy', dir, '--project-name', project, '--branch', branch, '--commit-dirty=true'], {
      cwd: dir,
      env: { ...env, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
    child.stderr.on('data', (d) => { out = (out + d).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(scrub(e.message))); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const url = /https:\/\/[a-z0-9.-]+\.pages\.dev\S*/.exec(out)?.[0] ?? null;
        resolve({ project, url });
      } else reject(new Error(`wrangler exited ${code}: ${scrub(out.trim().split('\n').slice(-3).join(' | '))}`));
    });
  });
}

/** Build and publish. target: 'cloudflare' or 'gh-pages'. */
export async function publishPages({ target = 'cloudflare', push = true, remote, branch, project, keep = false, ...build } = {}) {
  const site = await buildSite(build);
  if (!site.markets) { rmSync(site.dir, { recursive: true, force: true }); throw new Error('No markets found for this deployment. Nothing to publish.'); }
  let result = null;
  try {
    if (push) {
      if (target === 'gh-pages') { pushGhPages(site.dir, { remote, branch }); result = { target, branch: branch ?? 'gh-pages' }; }
      else if (target === 'cloudflare') result = { target, ...(await deployCloudflare(site.dir, { project })) };
      else throw new Error(`Unknown target ${target}`);
    }
  } finally {
    if (push && !keep) rmSync(site.dir, { recursive: true, force: true });
  }
  return { ...site, pushed: result };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: {
    rpc: { type: 'string', default: process.env.BSC_RPC_URL ?? DEFAULT_PAGE_RPC },
    'page-rpc': { type: 'string', default: DEFAULT_PAGE_RPC },
    deployment: { type: 'string', default: join(ROOT, 'contracts/deployments/56.json') },
    target: { type: 'string', default: 'gh-pages' },
    project: { type: 'string' },
    remote: { type: 'string', default: 'origin' },
    branch: { type: 'string', default: 'gh-pages' },
    'no-push': { type: 'boolean', default: false },
    'max-trade': { type: 'string', default: '500' },
    slippage: { type: 'string', default: '200' },
  } });
  try {
    const r = await publishPages({
      target: v.target, push: !v['no-push'], remote: v.remote, branch: v.branch, project: v.project,
      rpc: v.rpc, pageRpc: v['page-rpc'], deployment: v.deployment, maxTrade: v['max-trade'], slippage: v.slippage,
    });
    for (const s of r.skipped) console.log(`  skipped report ${s.file}: ${s.why}`);
    console.log(`${r.markets} market(s), ${r.reports} report(s) built in ${r.dir}`);
    if (!r.pushed) console.log(`Not pushed (--no-push). Look at it: npx http-server@14.1.1 ${r.dir} -p 8081`);
    else if (r.pushed.target === 'gh-pages') console.log(`Pushed to ${v.remote}/${v.branch}. GitHub Pages serves it in about a minute.`);
    else console.log(`Deployed to Cloudflare Pages project ${r.pushed.project}${r.pushed.url ? `: ${r.pushed.url}` : ''}.`);
  } catch (e) {
    let msg = String(e.shortMessage ?? e.message).split(v.rpc).join('[read RPC]');
    for (const s of [process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID]) if (s) msg = msg.split(s).join('[redacted]');
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
