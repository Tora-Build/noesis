#!/usr/bin/env node
// Keeper: proposes outcomes from the feed and settles markets.
//   node keeper.mjs --rpc <url> 0xMarket1 0xMarket2 … [--execute] [--loop 60]
// Default is dry-run: every call is simulated, nothing is sent.

import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { makePublicClient, walletFromEnv, marketAbi, adjudicatorAbi, wadToFloat, PHASE } from "./src/sooth.mjs";
import { KIND } from "./src/model.mjs";
import { loadEnvFiles } from "./src/env.mjs";

/**
 * Pure: what should the keeper do for one market?
 * @returns {{ action: "SETTLE_FROM_FEED"|"SETTLE"|"WAIT"|"DONE", reason: string }}
 */
export function keeperPlan({ now, deadline, terms, feed, openedAt = 0, phase, settled, canSettle, earlyResolution = false }) {
  if (settled) return { action: "DONE", reason: "Market is settled." };
  if (canSettle) return { action: "SETTLE", reason: "Veto window is over. Settle." };
  if (phase === "RESOLVED" || phase === "ATTESTED") return { action: "WAIT", reason: "Outcome proposed. Waiting for the veto window." };
  if (phase !== "ACTIVE" && phase !== "DISPUTED") return { action: "WAIT", reason: `Adjudicator phase is ${phase}.` };
  if (!terms || !feed) return { action: "WAIT", reason: "No feed terms." };
  const touch = terms.kind === KIND.TOUCH_ABOVE || terms.kind === KIND.TOUCH_BELOW;
  const above = terms.kind === KIND.CLOSE_ABOVE || terms.kind === KIND.TOUCH_ABOVE;
  const crossed = above ? feed.price >= terms.strike : feed.price <= terms.strike;
  if (touch && crossed && feed.ts < deadline && feed.ts >= openedAt) {
    // AdjudicatorBase.resolve needs earlyResolution or a passed deadline.
    if (now < deadline && !earlyResolution) return { action: "WAIT", reason: "Feed touched the strike, but early resolution is off. Wait for the deadline." };
    return { action: "SETTLE_FROM_FEED", reason: "Feed touched the strike inside the window: YES." };
  }
  if (now < deadline) return { action: "WAIT", reason: `Deadline in ${deadline - now} s.` };
  if (!touch && feed.ts < deadline) return { action: "WAIT", reason: "Deadline passed. Waiting for a feed read at or after the deadline." };
  return { action: "SETTLE_FROM_FEED", reason: touch ? "Deadline passed with no touch: NO." : "Deadline passed. Read the close." };
}

async function readState(client, market) {
  const call = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const [deadline, adjudicator, settled, block] = await Promise.all([
    call(market, marketAbi, "deadline"), call(market, marketAbi, "adjudicator"), call(market, marketAbi, "isSettled"), client.getBlock(),
  ]);
  const [terms, feed, openedAt, phase, canSettle, earlyResolution] = await Promise.all([
    call(adjudicator, adjudicatorAbi, "terms", [market]),
    call(adjudicator, adjudicatorAbi, "readFeed", [market]).catch(() => null),
    call(adjudicator, adjudicatorAbi, "openedAt", [market]),
    call(adjudicator, adjudicatorAbi, "getPhase", [market]),
    call(adjudicator, adjudicatorAbi, "canSettle", [market]),
    call(adjudicator, adjudicatorAbi, "earlyResolution").catch(() => false),
  ]);
  return {
    adjudicator,
    now: Number(block.timestamp), deadline: Number(deadline), settled, canSettle, earlyResolution,
    phase: PHASE[Number(phase)] ?? String(phase), openedAt: Number(openedAt),
    terms: { kind: Number(terms.kind), strike: wadToFloat(terms.strikeWad), feed: terms.feed, feedId: terms.feedId },
    feed: feed && { price: wadToFloat(feed[0]), ts: Number(feed[1]) },
  };
}

/** Parse and check --loop. Below 10 s would load public RPCs for no gain (the Atlas heartbeat is 60 s). */
export function parseLoop(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 10) throw new Error("--loop must be a number of seconds, 10 or more.");
  return n;
}

/**
 * One keeper step for one market. `pending` maps market -> tx hash sent and not yet mined.
 * While a hash is pending, the market is skipped, so a slow block never causes a second send.
 */
export async function tick(client, wallet, market, execute, pending = new Map(), { read = readState, receiptTimeoutMs = 60_000 } = {}) {
  const waiting = pending.get(market);
  if (waiting) {
    const rc = await client.getTransactionReceipt({ hash: waiting }).catch(() => null);
    if (!rc) {
      const line = { market, action: "PENDING", reason: "A sent tx is not mined yet. Skip.", tx: { hash: waiting } };
      console.log(JSON.stringify(line));
      return line;
    }
    pending.delete(market);
    console.log(JSON.stringify({ market, action: "MINED", tx: { hash: waiting, status: rc.status } }));
  }
  const s = await read(client, market);
  const plan = keeperPlan(s);
  const line = { market, phase: s.phase, feed: s.feed?.price, strike: s.terms?.strike, ...plan };
  if (plan.action === "SETTLE_FROM_FEED" || plan.action === "SETTLE") {
    const functionName = plan.action === "SETTLE" ? "settle" : "settleFromFeed";
    try {
      const account = wallet?.account ?? undefined;
      const { request, result } = await client.simulateContract({ account, address: s.adjudicator, abi: adjudicatorAbi, functionName, args: [market] });
      line.simulated = { ok: true, result: result === undefined ? null : Number(result) };
      if (execute) {
        const hash = await wallet.writeContract(request);
        pending.set(market, hash);
        line.tx = { hash, status: "pending" };
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: receiptTimeoutMs }).catch(() => null);
        if (receipt) { pending.delete(market); line.tx.status = receipt.status; }
      }
    } catch (e) {
      line.simulated = { ok: false, error: e.shortMessage ?? e.message };
    }
  }
  console.log(JSON.stringify(line));
  return line;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { rpc: { type: "string" }, execute: { type: "boolean", default: false }, loop: { type: "string" } },
  });
  const loop = parseLoop(values.loop);
  const rpc = values.rpc ?? process.env.RPC_URL ?? process.env.BSC_RPC_URL;
  if (!rpc || positionals.length === 0) throw new Error("Usage: node keeper.mjs --rpc <url> 0xMarket… [--execute] [--loop <sec>=10+]");
  const client = makePublicClient(rpc);
  const wallet = values.execute ? walletFromEnv(rpc) : process.env.PRIVATE_KEY ? walletFromEnv(rpc) : null;
  const markets = positionals.map((m) => getAddress(m));
  const pending = new Map();
  do {
    for (const m of markets) await tick(client, wallet, m, values.execute, pending).catch((e) => console.log(JSON.stringify({ market: m, error: e.shortMessage ?? e.message })));
    if (loop) await new Promise((r) => setTimeout(r, loop * 1000));
  } while (loop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = new URL(".", import.meta.url).pathname;
  loadEnvFiles([`${here}.env`, `${here}../.env`]);
  main().catch((e) => { console.error(`Error: ${e.shortMessage ?? e.message}`); process.exit(1); });
}
