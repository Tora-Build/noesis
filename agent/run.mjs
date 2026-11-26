#!/usr/bin/env node
// Sooth Hedge risk agent.
//   node run.mjs --market 0x… --rpc <url> [--cournot-id N] [--asset BNB] [--amm 0x…] [--bankroll 100] [--execute]
//   node run.mjs --offline --fixture <file>

import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

import { fetchSnapshot, buildSnapshot, parseQuotes, parseCandles, parseFearGreed, parseGlobal, ASSETS } from "./src/cmc.mjs";
import * as cournot from "./src/cournot.mjs";
import { readMarket, makePublicClient, buildTrade, sendTrade, walletFromEnv, sharesForBudget, assetForTerms } from "./src/sooth.mjs";
import { analyze, marketTitle } from "./src/report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    market: { type: "string" },
    rpc: { type: "string" },
    amm: { type: "string" },
    asset: { type: "string" },
    "cournot-id": { type: "string" },
    "cournot-message": { type: "string" },
    "no-cournot": { type: "boolean", default: false },
    bankroll: { type: "string" },
    threshold: { type: "string" },
    slippage: { type: "string", default: "0.02" },
    execute: { type: "boolean", default: false },
    offline: { type: "boolean", default: false },
    fixture: { type: "string" },
    out: { type: "string", default: join(HERE, "out") },
    quiet: { type: "boolean", default: false },
  },
});

const jsonSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const log = (...m) => { if (!args.quiet) console.error(...m); };

function decideOpts() {
  const o = {};
  if (args.bankroll) o.bankroll = Number(args.bankroll);
  if (args.threshold) o.edgeThreshold = Number(args.threshold);
  return o;
}

function writeReport(report) {
  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, `${report.market.toLowerCase()}.json`);
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
    `Decision ${d.action}${d.sizeUsd ? ` size $${d.sizeUsd}` : ""}   ${d.reason}`,
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
  const rpc = args.rpc ?? process.env.RPC_URL;
  if (!args.market || !rpc) throw new Error("Need --market and --rpc (or RPC_URL).");
  const client = makePublicClient(rpc);
  log("Reading Sooth market…");
  const chain = await readMarket(client, args.market, { amm: args.amm ?? process.env.AMM_ADDRESS });
  const asset = args.asset ?? (chain.terms && assetForTerms(chain.terms));
  if (!asset || !ASSETS[asset]) throw new Error(`Cannot map the market feed to an asset. Pass --asset (${Object.keys(ASSETS).join(", ")}).`);

  log(`Fetching CoinMarketCap data for ${asset}…`);
  const snapshot = await fetchSnapshot(asset);

  let c = { state: "skipped" };
  const message = args["cournot-message"] ?? marketTitle(asset, chain.terms, chain.deadline);
  if (!args["no-cournot"]) {
    if (args["cournot-id"]) {
      log(`Cournot probability for market ${args["cournot-id"]} (cached per run window)…`);
      c = await cournot.probability(args["cournot-id"], message);
    } else {
      // resolve is free. Probability is only called with an explicit --cournot-id.
      const r = await cournot.resolve(message, { limit: 5 }).catch((e) => ({ state: "network_error", error: e.message, candidates: [] }));
      c = { state: "skipped", resolveCandidates: r.candidates, suggestedId: r.picked?.id ?? null };
      if (r.picked) log(`Cournot match: id ${r.picked.id} (${r.picked.title}). Rerun with --cournot-id ${r.picked.id} to fetch its probability.`);
    }
  }

  const report = analyze({ chain, snapshot, cournot: c, asset, opts: decideOpts() });
  report.mode = args.execute ? "execute" : "dry-run";
  report.cournotMessage = message;
  if (c.resolveCandidates) report.inputs.cournot.resolveCandidates = c.resolveCandidates;

  const d = report.decision;
  if (d.action === "BUY_YES" || d.action === "BUY_NO") {
    const pk = process.env.PRIVATE_KEY;
    const account = pk ? privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`).address : null;
    const shares = sharesForBudget(d.sizeUsd, d.entryPrice);
    const built = await buildTrade(client, {
      market: chain.market, amm: chain.amm, outcome: d.outcome, shares,
      slippage: Number(args.slippage), decimals: chain.decimals, tokenA: chain.tokenA, account,
    });
    report.tx = { from: account, ...built };
    if (args.execute) {
      if (!pk) throw new Error("--execute needs PRIVATE_KEY in the environment.");
      log("Sending trade…");
      report.tx.sent = await sendTrade(client, walletFromEnv(rpc), built);
    }
  }
  return report;
}

async function main() {
  const report = args.offline ? await runOffline(args.fixture ?? join(HERE, "test/fixtures/demo-bnb.json")) : await runOnline();
  const file = writeReport(report);
  console.log(summary(report));
  if (report.tx?.sent) console.log(`Tx       ${report.tx.sent.trade} (${report.tx.sent.status})`);
  else if (report.tx) console.log(`Tx       built, not sent (dry-run). Use --execute to send.`);
  console.log(`Report   ${file}`);
}

main().catch((e) => {
  console.error(`Error: ${e.shortMessage ?? e.message}`);
  process.exit(1);
});
