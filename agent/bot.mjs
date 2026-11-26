#!/usr/bin/env node
// Sooth Hedge bot: one always-on process with three jobs.
//   settler  every BOT_SETTLE_SEC (60): settleFromFeed / settle for every market of our adjudicator.
//   agent    every BOT_AGENT_SEC (900): analyze every open market and trade under a daily cap.
//   creator  once a day at CREATE_AT_UTC (21:05): 3 close-below markets per asset for the next weekday.
// After new markets (and at most once per hour after trades) it publishes the page when BOT_PUBLISH=1.
// One JSON log line per action. Secrets are never printed. See agent/bot.env.example.

import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { parseGwei, parseUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { loadEnvFiles } from "./src/env.mjs";
import { ASSETS, fetchSnapshot } from "./src/cmc.mjs";
import { walletFromEnv, readMarket, numberToFeedId, erc20Abi, wadToFloat, adjudicatorAbi } from "./src/sooth.mjs";
import { fairProbability, KIND } from "./src/model.mjs";
import { nextWeekdayDeadline, planLadder, marketText, marketKey, parseHHMM } from "./src/ladder.mjs";
import { dueJobs, publishDue, dayKey, spendLeft, addSpend, loadState, saveState } from "./src/schedule.mjs";
import {
  makeLogger, errText, retry, makeClient, makePrepare, syncMarkets, readFeedPrice, buildMarketParams, readNodeConfig,
  sendCreateMarket, marketFromReceipt, factoryAbi, marketRecord,
} from "./src/botchain.mjs";
import { tick } from "./keeper.mjs";
import { runMarket, writeReport } from "./run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "out");

// ─── Config ─────────────────────────────────────────────────────

export function readConfig(env = process.env) {
  const num = (k, d) => {
    const n = Number(env[k] === undefined || env[k] === "" ? d : env[k]);
    if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
    return n;
  };
  const dep = env.DEPLOYMENT_FILE || "../contracts/deployments/56.json";
  // Relative paths: from agent/ first, then from contracts/ (the forge scripts use that base).
  const depPath = isAbsolute(dep) ? dep : [resolve(HERE, dep), resolve(HERE, "..", "contracts", dep)].find(existsSync) ?? resolve(HERE, dep);
  const cfg = {
    rpc: env.BSC_RPC_URL,
    logRpc: env.LOG_RPC_URL || "https://bsc-rpc.publicnode.com",
    deploymentFile: depPath,
    stateFile: resolve(HERE, env.BOT_STATE || "./bot-state.json"),
    dailySpend: num("BOT_DAILY_SPEND", 200),
    bankroll: num("BOT_BANKROLL", 100),
    createAt: env.CREATE_AT_UTC || "21:05",
    deadlineAt: env.DEADLINE_AT_UTC || "21:00",
    skipDates: (env.BOT_SKIP_DATES || "").split(",").map((s) => s.trim()).filter(Boolean),
    publish: env.BOT_PUBLISH === "1",
    pagesProject: env.CF_PAGES_PROJECT || "noesis",
    publishMinSec: num("BOT_PUBLISH_MIN_SEC", 3600),
    dryRun: env.BOT_DRY_RUN !== "0", // dry by default: set BOT_DRY_RUN=0 to send
    settleSec: num("BOT_SETTLE_SEC", 60),
    agentSec: num("BOT_AGENT_SEC", 900),
    tickSec: num("BOT_TICK_SEC", 5),
    bBase: num("BOT_BBASE", 500),
    maxInput: num("BOT_MAX_INPUT", 2500),
    gasGwei: env.BOT_GAS_GWEI || "0.05",
    cmcTtlSec: num("BOT_CMC_TTL_SEC", 3600),
    cournotResolve: env.BOT_COURNOT_RESOLVE === "1",
    confirmations: num("BOT_LOG_CONFIRMATIONS", 2),
    slippage: num("BOT_SLIPPAGE", 0.02),
  };
  parseHHMM(cfg.createAt); parseHHMM(cfg.deadlineAt);
  if (!cfg.rpc) throw new Error("Set BSC_RPC_URL");
  if (cfg.settleSec < 10 || cfg.agentSec < 10) throw new Error("BOT_SETTLE_SEC and BOT_AGENT_SEC must be 10 or more");
  return cfg;
}

/** The three ladder assets. Feed addresses come from the deployment file. */
export function ladderAssets(d) {
  const atlas = d.atlasMultiFeed ?? "0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa";
  const bnb = d.chainlinkBnbUsd ?? "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE";
  return [
    { symbol: "IWMB", source: 0, feed: getAddress(atlas), feedId: numberToFeedId(1166), label: "Atlas Oracle" },
    { symbol: "EWZB", source: 0, feed: getAddress(atlas), feedId: numberToFeedId(1165), label: "Atlas Oracle" },
    { symbol: "BNB", source: 1, feed: getAddress(bnb), feedId: "0x00000000", label: "Chainlink" },
  ];
}

// ─── Bot ────────────────────────────────────────────────────────

export async function startBot(env = process.env) {
  const cfg = readConfig(env);
  const log = makeLogger({ secrets: [env.BOT_PRIVATE_KEY, env.BOT_PRIVATE_KEY?.replace(/^0x/, ""), cfg.rpc, cfg.logRpc, env.CMC_API_KEY, env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, env.COURNOT_API_KEY] });
  const d = JSON.parse(readFileSync(cfg.deploymentFile, "utf8"));
  const client = makeClient(cfg.rpc);
  const logClient = cfg.logRpc === cfg.rpc ? client : makeClient(cfg.logRpc);
  const gasPrice = parseGwei(cfg.gasGwei);
  const prepare = makePrepare(client, { gasPrice });
  const pk = env.BOT_PRIVATE_KEY;
  if (!pk && !cfg.dryRun) throw new Error("BOT_DRY_RUN=0 needs BOT_PRIVATE_KEY");
  const wallet = pk ? walletFromEnv(cfg.rpc, undefined, { PRIVATE_KEY: pk }) : null;
  const account = wallet?.account ?? null;
  const state = loadState(cfg.stateFile);
  const save = () => saveState(cfg.stateFile, state);
  const pending = new Map(Object.entries(state.pending ?? {}));

  const chainId = await retry(() => client.getChainId());
  if (chainId !== d.chainId) throw new Error(`RPC chain ${chainId} does not match the deployment chain ${d.chainId}`);
  let allowed = null;
  if (account) allowed = await retry(() => client.readContract({ address: d.marketFactory, abi: factoryAbi, functionName: "allowedCreators", args: [account.address] }));
  log({ job: "bot", action: "START", account: account?.address ?? null, dryRun: cfg.dryRun, publish: cfg.publish, chainId,
    deployment: cfg.deploymentFile, creatorAllowed: allowed, createAt: cfg.createAt, settleSec: cfg.settleSec, agentSec: cfg.agentSec, dailySpend: cfg.dailySpend });
  if (account && !allowed) log({ job: "bot", level: "warn", action: "NOT_CREATOR", msg: "The bot wallet is not an allowed creator. The creator job will fail until the node admin calls setCreatorAllowed." });

  // CMC snapshot per asset, kept for BOT_CMC_TTL_SEC to stay inside the free plan.
  const snaps = new Map();
  async function snapshot(symbol) {
    const hit = snaps.get(symbol);
    if (hit && Date.now() - hit.at < cfg.cmcTtlSec * 1000) return hit.snap;
    const snap = await fetchSnapshot(symbol);
    snaps.set(symbol, { at: Date.now(), snap });
    return snap;
  }
  const chainNow = async () => Number((await retry(() => client.getBlock())).timestamp);
  let lastSync = 0;
  // force: scan now, up to the latest block (the creator must see every market before it creates).
  async function sync(force = false) {
    if (!force && Date.now() - lastSync < 30_000) return;
    const n = await syncMarkets({ client, logClient, deployment: d, state, confirmations: force ? 0n : BigInt(cfg.confirmations), log });
    lastSync = Date.now();
    save();
    return n;
  }

  // ── Settler ──
  async function settleJob() {
    await sync();
    const now = await chainNow();
    for (const [market, m] of Object.entries(state.markets)) {
      if (state.done[market]) continue;
      // CLOSE markets cannot settle before the deadline: no reads until then.
      if ((m.kind === KIND.CLOSE_ABOVE || m.kind === KIND.CLOSE_BELOW) && now < m.deadline && !pending.has(market)) continue;
      try {
        const line = await tick(client, wallet, market, !cfg.dryRun, pending, {
          prepare, log: (l) => log({ job: "settle", ...l, dryRun: cfg.dryRun || undefined }),
        });
        if (line.action === "DONE") state.done[market] = true;
      } catch (e) {
        log({ job: "settle", market, level: "error", error: errText(e) });
      }
      state.pending = Object.fromEntries(pending);
      save();
    }
  }

  // ── Agent ──
  async function agentJob() {
    await sync();
    const now = await chainNow();
    let traded = 0;
    for (const [market, m] of Object.entries(state.markets)) {
      if (state.done[market] || m.deadline <= now + 60 || !m.asset || !ASSETS[m.asset]) continue;
      try {
        const chain = await retry(() => readMarket(client, market, { amm: d.amm }));
        if (!chain.tradingOpen || chain.settled) { log({ job: "agent", market, action: "SKIP", reason: "Trading is closed." }); continue; }
        chain.chainId = d.chainId;
        const day = dayKey(Date.now());
        const left = spendLeft(state, day, cfg.dailySpend);
        const snap = await snapshot(m.asset).catch((e) => { log({ job: "agent", market, level: "warn", msg: "CMC failed, model uses the prior", error: errText(e) }); return null; });
        const report = await runMarket({
          client, market, chain, asset: m.asset, snapshot: snap ?? fallbackSnapshot(m.asset),
          cournotMode: cfg.cournotResolve ? "resolve" : "off", // never the paid probability endpoint
          decideOpts: { bankroll: cfg.bankroll }, slippage: cfg.slippage, account: account?.address ?? null,
          wallet, execute: !cfg.dryRun && !!wallet, maxSpendUsd: left, prepare,
        });
        report.bot = { dailyCap: cfg.dailySpend, spentBefore: cfg.dailySpend - left };
        const dcs = report.decision;
        let spent = 0;
        if (report.tx?.sent?.status === "success") {
          spent = report.tx.quote.netAmount;
          addSpend(state, day, spent);
          traded++;
        }
        writeReport(report, OUT_DIR);
        log({ job: "agent", market, asset: m.asset, action: dcs.action, sizeUsd: dcs.sizeUsd, reason: dcs.reason, pSooth: dcs.pSooth, pStar: dcs.pStar,
          tx: report.tx?.sent ?? (report.tx ? "built" : undefined), spent: spent || undefined, spentToday: spent ? state.spend[day] : undefined });
      } catch (e) {
        log({ job: "agent", market, level: "error", error: errText(e) });
      }
      save();
    }
    if (traded) { state.publish.due = true; save(); }
  }

  // ── Creator ──
  async function createJob() {
    await sync(true);
    const now = await chainNow();
    const deadline = nextWeekdayDeadline(now, { at: cfg.deadlineAt, skipDates: cfg.skipDates });
    let created = 0, failed = 0;

    // Finish creations a restart cut short.
    for (const [key, c] of Object.entries(state.creating)) {
      if (!c.hash) {
        // No hash saved: the tx may or may not have left. The nonce tells.
        const mined = account ? await client.getTransactionCount({ address: account.address, blockTag: "latest" }) : 0;
        const pend = account ? await client.getTransactionCount({ address: account.address, blockTag: "pending" }) : 0;
        if (c.nonce != null && pend > c.nonce && mined <= c.nonce) { log({ job: "create", key, action: "WAIT", reason: "A create tx may be in the mempool." }); failed++; continue; }
        await sync(true);
        delete state.creating[key]; save();
        continue;
      }
      try {
        const r = await marketFromReceipt(client, c.hash);
        const terms = await client.readContract({ address: d.adjudicator, abi: adjudicatorAbi, functionName: "terms", args: [r.market] });
        state.markets[r.market] = marketRecord(r.args, terms, r.block);
        log({ job: "create", action: "CREATED", key, market: r.market, tx: c.hash, recovered: true });
        created++;
      } catch (e) {
        log({ job: "create", key, level: "warn", action: "DROP", reason: errText(e), tx: c.hash });
      }
      delete state.creating[key]; save();
    }

    const node = cfg.dryRun ? null : await readNodeConfig(client, d);
    for (const a of ladderAssets(d)) {
      try {
        const feed = await retry(() => readFeedPrice(client, a));
        const age = now - feed.ts;
        if (a.source === 0 && age > 7 * 86400) { log({ job: "create", asset: a.symbol, action: "SKIP", reason: `Feed is ${age} s old.` }); continue; }
        const existing = Object.values(state.markets).filter((m) => m.asset === a.symbol && m.deadline === deadline && m.kind === KIND.CLOSE_BELOW)
          .concat(Object.values(state.creating).filter((c) => c.asset === a.symbol && c.deadline === deadline));
        const plan = planLadder({ spot: feed.price, existing, want: 3 });
        if (!plan.create.length) { log({ job: "create", asset: a.symbol, action: "SKIP", deadline, reason: `${plan.existing} market(s) exist for this deadline.` }); continue; }
        const snap = await snapshot(a.symbol).catch(() => null);
        const sigma = snap?.sigma ?? ASSETS[a.symbol].defaultSigma;
        for (const strike of plan.create) {
          const { question, strikeWad } = marketText({ symbol: a.symbol, strike, deadline, kind: KIND.CLOSE_BELOW, source: a.label });
          const key = marketKey({ asset: a.symbol, kind: KIND.CLOSE_BELOW, strikeWad, deadline });
          const p = Math.min(0.95, Math.max(0.02, fairProbability({ kind: KIND.CLOSE_BELOW, spot: feed.price, strike, sigma, now, deadline })));
          const line = { job: "create", asset: a.symbol, question, key, spot: feed.price, sigma, prob: Number(p.toFixed(6)), deadline };
          if (cfg.dryRun || !wallet) { log({ ...line, action: "PLAN", dryRun: true }); continue; }
          const params = buildMarketParams({
            question, deadline, probWad: parseUnits(p.toFixed(6), 18),
            terms: { source: a.source, feed: a.feed, feedId: a.feedId, kind: KIND.CLOSE_BELOW, strikeWad, maxDelay: 300 },
            bBase: parseUnits(String(cfg.bBase), 18), maxInput: parseUnits(String(cfg.maxInput), 18),
            adjudicator: d.adjudicator, stable: d.stable, quoteDeadline: Math.min(now + 3600, deadline), cfg: node,
          });
          const bal = await client.readContract({ address: d.stable, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
          if (bal < params.maxInputNative) { log({ ...line, level: "error", action: "NO_FUNDS", balance: wadToFloat(bal), need: cfg.maxInput }); failed++; continue; }
          const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
          state.creating[key] = { asset: a.symbol, deadline, strikeWad: strikeWad.toString(), question, nonce, hash: null, at: Date.now() };
          save();
          try {
            const r = await sendCreateMarket({ client, wallet, prepare, deployment: d, params,
              onSent: (hash) => { state.creating[key].hash = hash; save(); } });
            state.markets[r.market] = {
              question, deadline, creator: account.address, block: r.block, asset: a.symbol,
              source: a.source, feed: a.feed, feedId: a.feedId, kind: KIND.CLOSE_BELOW, strikeWad: strikeWad.toString(), maxDelay: 300,
            };
            delete state.creating[key]; save();
            created++;
            log({ ...line, action: "CREATED", market: r.market, tx: r.hash });
          } catch (e) {
            if (!state.creating[key]?.hash) { delete state.creating[key]; save(); }
            failed++;
            log({ ...line, level: "error", action: "CREATE_FAILED", error: errText(e) });
          }
        }
      } catch (e) {
        failed++;
        log({ job: "create", asset: a.symbol, level: "error", error: errText(e) });
      }
    }
    if (failed) state.last.createRetryAt = Date.now() + 15 * 60_000; // idempotent, so a retry is safe
    else { state.last.createDay = dayKey(Date.now()); delete state.last.createRetryAt; }
    if (created) { state.publish.force = true; }
    save();
    log({ job: "create", action: "SUMMARY", deadline, created, failed });
  }

  // ── Publish ──
  async function publishJob() {
    const { publishPages } = await import("../scripts/publish-pages.mjs");
    const r = await publishPages({ target: "cloudflare", project: cfg.pagesProject, rpc: cfg.rpc, logRpc: cfg.logRpc, deployment: cfg.deploymentFile, reports: OUT_DIR });
    log({ job: "publish", action: "PUBLISHED", markets: r.markets, reports: r.reports, url: r.pushed?.url ?? null });
  }

  // ── Loop ──
  let stopping = false, wake = null;
  const stop = (sig) => { if (stopping) return; stopping = true; log({ job: "bot", action: "STOP", signal: sig }); wake?.(); };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const jobs = { settle: settleJob, create: createJob, agent: agentJob };
  while (!stopping) {
    for (const job of dueJobs(Date.now(), state.last, cfg)) {
      if (stopping) break;
      try { await jobs[job](); } catch (e) { log({ job, level: "error", error: errText(e) }); if (job === "create") state.last.createRetryAt = Date.now() + 15 * 60_000; }
      if (job === "settle") state.last.settleAt = Date.now();
      if (job === "agent") state.last.agentAt = Date.now();
      save();
    }
    if (!stopping && cfg.publish && publishDue(Date.now(), state.publish, cfg.publishMinSec)) {
      try { await publishJob(); state.publish = { lastAt: Date.now(), due: false, force: false }; }
      catch (e) { log({ job: "publish", level: "error", error: errText(e) }); state.publish.lastAt = Date.now(); }
      save();
    } else if (!cfg.publish && (state.publish.force || state.publish.due)) {
      state.publish = { ...state.publish, due: false, force: false }; save();
    }
    if (!stopping) await new Promise((r) => { wake = r; setTimeout(r, cfg.tickSec * 1000); });
  }
  state.pending = Object.fromEntries(pending);
  save();
  log({ job: "bot", action: "EXIT" });
}

/** Snapshot when CMC is down: the asset prior sigma, no CMC data. */
function fallbackSnapshot(symbol) {
  return { symbol, spot: null, quote: null, candles: { count: 0 }, sigma: ASSETS[symbol].defaultSigma, sigmaSource: "default", fearGreed: null, global: null, errors: ["cmc unavailable"], cmcMode: null, cmcCalls: [] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The systemd EnvironmentFile sets the env. agent/.env and ../.env fill gaps (values never printed).
  loadEnvFiles([join(HERE, ".env"), join(HERE, "..", ".env")]);
  const fatal = makeLogger({ secrets: [process.env.BOT_PRIVATE_KEY, process.env.BSC_RPC_URL, process.env.CMC_API_KEY, process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID] });
  process.on("unhandledRejection", (e) => fatal({ job: "bot", level: "error", action: "UNHANDLED_REJECTION", error: errText(e) }));
  process.on("uncaughtException", (e) => { fatal({ job: "bot", level: "fatal", action: "UNCAUGHT", error: errText(e) }); process.exit(1); });
  startBot().then(() => process.exit(0), (e) => { fatal({ job: "bot", level: "fatal", action: "START_FAILED", error: errText(e) }); process.exit(1); });
}
