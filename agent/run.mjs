#!/usr/bin/env node
// Sooth Hedge risk agent.
//   node run.mjs --market 0x… --rpc <url> [--cournot-id N] [--asset BNB] [--amm 0x…] [--bankroll 100] [--execute]
//   node run.mjs --offline --fixture <file>
// Reads agent/.env and ../.env (values never printed). `node --env-file=../.env run.mjs …` also works.

import { fetchConsensus } from "./src/atlas.mjs";
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

import { fetchSnapshot, buildSnapshot, parseQuotes, parseCandles, parseFearGreed, parseGlobal, ASSETS } from "./src/cmc.mjs";
import * as cournot from "./src/cournot.mjs";
import { readMarket, makePublicClient, buildTrade, sendTrade, walletFromEnv, assetForTerms, quoteBuy, planBuy, wadToFloat } from "./src/sooth.mjs";
import { analyze, marketTitle } from "./src/report.mjs";
import { loadEnvFiles } from "./src/env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function cliArgs() {
  return parseArgs({
    options: {
      market: { type: "string" },
      rpc: { type: "string" },
      amm: { type: "string" },
      asset: { type: "string" },
      "cournot-id": { type: "string" },
      "cournot-message": { type: "string" },
      "no-cournot": { type: "boolean", default: false },
      "refresh-cournot": { type: "boolean", default: false },
      // The Cournot market states the opposite claim (for example "above $465" for our "below $465").
      "cournot-invert": { type: "boolean", default: false },
      bankroll: { type: "string" },
      threshold: { type: "string" },
      slippage: { type: "string", default: "0.02" },
      execute: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      fixture: { type: "string" },
      out: { type: "string", default: join(HERE, "out") },
      quiet: { type: "boolean", default: false },
    },
  }).values;
}

let args = { quiet: true, out: join(HERE, "out") };

const jsonSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const log = (...m) => { if (!args.quiet) console.error(...m); };

function decideOpts() {
  const o = {};
  if (args.bankroll) o.bankroll = Number(args.bankroll);
  if (args.threshold) o.edgeThreshold = Number(args.threshold);
  return o;
}

export function writeReport(report, outDir = args.out) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${report.market.toLowerCase()}.json`);
  writeFileSync(file, JSON.stringify(report, jsonSafe, 2));
  return file;
}

function summary(r) {
  const d = r.decision;
  const p = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  return [
    `Market   ${r.title}`,
    `Sooth    ${p(d.pSooth)}   Cournot ${p(d.pCournot)}   Model ${p(d.pModel)}   Fair ${p(d.pStar)}`,
    `Risk     ${d.risk}/100   sigma ${(r.inputs.cmc.sigma * 100).toFixed(1)}% (${r.inputs.cmc.sigmaSource})   F&G ${r.inputs.cmc.fearGreed?.value ?? "n/a"}`,
    `CMC      ${r.inputs.cmc.mode ?? "offline"}, ${r.inputs.cmc.calls?.length ?? 0} call(s)   block ${r.proof?.block ?? "n/a"}`,
    `Decision ${d.action}${d.sizeUsd ? ` size $${d.sizeUsd}` : ""}${d.sizing ? ` (cost $${d.sizing.netAmount.toFixed(2)} for ${d.sizing.shares.toFixed(2)} shares)` : ""}   ${d.reason}`,
    ...d.alerts.map((a) => `Alert    ${a.code}: ${a.message}`),
  ].join("\n");
}

// ─── Offline: build a report from a fixture file ────────────────

async function runOffline(path) {
  const fixturePath = resolvePath(path);
  const dir = dirname(fixturePath);
  const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
  const load = (f) => (f ? JSON.parse(readFileSync(resolvePath(dir, f), "utf8")) : null);
  const raw = fx.cmcFiles ?? {};
  const snapshot = fx.snapshot ?? buildSnapshot({
    symbol: fx.asset,
    quotes: raw.quotes ? parseQuotes(load(raw.quotes)) : null,
    candles: raw.candles ? parseCandles(load(raw.candles)) : null,
    fearGreed: raw.fearGreed ? parseFearGreed(load(raw.fearGreed)) : null,
    global: raw.global ? parseGlobal(load(raw.global)) : null,
  });
  let c = null;
  if (fx.cournotFile) {
    const body = load(fx.cournotFile);
    const state = cournot.responseState(fx.cournotHttpStatus ?? 200, body);
    c = state === "complete"
      ? { state, marketId: fx.cournotId ?? null, ...cournot.parseProbability(body) }
      : { state, needsPayment: state === "payment_required", probability: null };
  }
  const report = analyze({ chain: fx.chain, snapshot, cournot: c, asset: fx.asset, opts: { ...fx.decideOpts, ...decideOpts() } });
  report.mode = "offline";
  report.fixture = path;
  return report;
}

// ─── Online ─────────────────────────────────────────────────────

async function runOnline() {
  const rpc = args.rpc ?? process.env.RPC_URL ?? process.env.BSC_RPC_URL;
  if (!args.market || !rpc) throw new Error("Need --market and --rpc (or RPC_URL).");
  let cournotMode = "resolve";
  if (args["no-cournot"]) cournotMode = "off";
  else if (args["cournot-id"]) cournotMode = { id: args["cournot-id"], force: args["refresh-cournot"], invert: args["cournot-invert"] };
  const pk = process.env.PRIVATE_KEY;
  if (args.execute && !pk) throw new Error("--execute needs PRIVATE_KEY in the environment.");
  return runMarket({
    client: makePublicClient(rpc), market: args.market, amm: args.amm ?? process.env.AMM_ADDRESS, asset: args.asset,
    cournotMode, cournotMessage: args["cournot-message"], decideOpts: decideOpts(), slippage: Number(args.slippage),
    account: pk ? privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`).address : null,
    wallet: args.execute ? walletFromEnv(rpc) : null, execute: args.execute, log,
  });
}

/**
 * Analyze one market and, with `execute`, send the trade. Used by the CLI and by bot.mjs.
 * @param {object} o
 * @param {object} o.client           viem public client
 * @param {string} o.market
 * @param {string} [o.amm]
 * @param {string} [o.asset]          default: from the feed terms
 * @param {object} [o.snapshot]       CMC snapshot to reuse; fetched when missing
 * @param {"off"|"resolve"|{id:string,force?:boolean,invert?:boolean}} [o.cournotMode]
 * @param {number|null} [o.maxSpendUsd] spend left for this trade (daily cap); null means no cap
 * @param {(req: object) => Promise<object>} [o.prepare] adds gas fields to each tx before it is sent
 */
export async function runMarket({ client, market, amm, asset, snapshot, cournotMode = "resolve", cournotMessage, decideOpts: dOpts = {},
  slippage = 0.02, account = null, wallet = null, execute = false, maxSpendUsd = null, prepare, log: say = () => {}, chain: chainIn, atlas: atlasIn } = {}) {
  say("Reading Sooth market…");
  const chain = chainIn ?? await readMarket(client, market, { amm });
  chain.chainId ??= await client.getChainId();
  asset ??= chain.terms && assetForTerms(chain.terms);
  if (!asset || !ASSETS[asset]) throw new Error(`Cannot map the market feed to an asset. Pass --asset (${Object.keys(ASSETS).join(", ")}).`);

  if (!snapshot) {
    say(`Fetching CoinMarketCap data for ${asset}…`);
    snapshot = await fetchSnapshot(asset);
  }

  let c = { state: "skipped" };
  const message = cournotMessage ?? marketTitle(asset, chain.terms, chain.deadline);
  if (cournotMode && cournotMode !== "off") {
    if (typeof cournotMode === "object" && cournotMode.id) {
      const force = !!cournotMode.force;
      say(`Cournot probability for market ${cournotMode.id} (${force ? "refresh: this spends a call" : "cached forever per id; --refresh-cournot to call again"})…`);
      c = await cournot.probability(cournotMode.id, message, { force });
      if (cournotMode.invert && c.state === "complete" && Number.isFinite(c.probability)) {
        c = { ...c, sourceProbability: c.probability, probability: 1 - c.probability, inverted: true };
        say(`Cournot states the opposite claim: using 1 - ${c.sourceProbability.toFixed(3)}.`);
      }
    } else {
      // resolve is free. Probability is only called with an explicit --cournot-id.
      const r = await cournot.resolve(message, { limit: 5 }).catch((e) => ({ state: "network_error", error: e.message, candidates: [] }));
      c = { state: "skipped", resolveCandidates: r.candidates, suggestedId: r.picked?.id ?? null };
      if (r.picked) say(`Cournot match: id ${r.picked.id} (${r.picked.title}). Rerun with --cournot-id ${r.picked.id} to fetch its probability.`);
    }
  }

  // Atlas Consensus Score for Atlas feeds (source 0). The bot passes one batched result in; the CLI fetches its own.
  let atlas = null;
  const atlasId = chain.terms?.source === 0 ? String(parseInt(chain.terms.feedId, 16)) : null;
  if (atlasId) {
    const res = atlasIn ?? await fetchConsensus([atlasId]);
    atlas = { state: res.state, error: res.error ?? null, feed: res.feeds?.[atlasId] ?? null };
    if (res.state === "complete") say(`Atlas consensus ${atlas.feed?.consensusStatus} (${atlas.feed?.consensusScore?.toFixed(2)}), signature ${atlas.feed?.signatureValid ? "valid" : "INVALID"}.`);
  }
  const report = analyze({ chain, snapshot, cournot: c, atlas, asset, opts: dOpts });
  report.mode = execute ? "execute" : "dry-run";
  report.cournotMessage = message;
  if (c.resolveCandidates) report.inputs.cournot.resolveCandidates = c.resolveCandidates;

  const d = report.decision;
  const hold = (reason) => {
    d.preImpact ??= { action: d.action, sizeUsd: d.sizeUsd };
    Object.assign(d, { action: "HOLD", fraction: 0, sizeUsd: 0, reason });
    delete d.outcome;
    return report;
  };
  if ((d.action === "BUY_YES" || d.action === "BUY_NO") && maxSpendUsd != null) {
    // Daily cap: the cost with slippage must fit in what is left today.
    const left = Math.floor((maxSpendUsd / (1 + slippage)) * 100) / 100;
    if (left < 1) return hold(`Daily spend cap reached ($${maxSpendUsd.toFixed(2)} left).`);
    if (d.sizeUsd > left) { d.capped = { from: d.sizeUsd, to: left }; d.sizeUsd = left; }
  }
  let plan = null;
  if (d.action === "BUY_YES" || d.action === "BUY_NO") {
    // Fit the size so the cost with fee stays inside sizeUsd, then check the edge after impact.
    plan = await planBuy((shares) => quoteBuy(client, { market: chain.market, amm: chain.amm, outcome: d.outcome, shares }), d);
    d.sizing = plan.quote && { shares: wadToFloat(plan.quote.shares), netAmount: wadToFloat(plan.quote.netAmount), newPrice: plan.quote.newPrice };
    if (!plan.ok) return hold(plan.reason);
  }
  if (d.action === "BUY_YES" || d.action === "BUY_NO") {
    const from = account ?? wallet?.account?.address ?? null;
    const built = await buildTrade(client, {
      market: chain.market, amm: chain.amm, outcome: d.outcome, shares: plan.shares,
      slippage, decimals: chain.decimals, tokenA: chain.tokenA, account: from,
    });
    report.tx = { from, ...built };
    if (execute) {
      if (!wallet) throw new Error("execute needs a wallet.");
      say("Sending trade…");
      report.tx.sent = await sendTrade(client, wallet, built, { prepare });
    }
  }
  return report;
}

async function main() {
  args = cliArgs();
  const report = args.offline ? await runOffline(args.fixture ?? join(HERE, "test/fixtures/demo-bnb.json")) : await runOnline();
  const file = writeReport(report);
  console.log(summary(report));
  if (report.tx?.sent) console.log(`Tx       ${report.tx.sent.trade} (${report.tx.sent.status})`);
  else if (report.tx) console.log(`Tx       built, not sent (dry-run). Use --execute to send.`);
  console.log(`Report   ${file}`);
}

if (process.argv[1] && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // agent/.env first, then the repo root .env. Values already in the environment win. Nothing is printed.
  loadEnvFiles([join(HERE, ".env"), join(HERE, "..", ".env")]);
  main().catch((e) => {
    console.error(`Error: ${e.shortMessage ?? e.message}`);
    process.exit(1);
  });
}
