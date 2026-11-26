// Chain helpers for bot.mjs: JSON logger, retry, gas, market discovery and market creation.

import {
  parseAbi, parseAbiItem, parseEventLogs, encodeAbiParameters, keccak256, encodeFunctionData, formatUnits, getAddress,
  createPublicClient, http,
} from "viem";
import { bsc } from "viem/chains";
import { adjudicatorAbi, erc20Abi, assetForTerms, wadToFloat } from "./sooth.mjs";

// ─── Logging ────────────────────────────────────────────────────

/** One JSON line per call. Every secret string in `secrets` is replaced before the line is written. */
export function makeLogger({ secrets = [], write = (s) => process.stdout.write(s + "\n") } = {}) {
  const hidden = secrets.filter((s) => typeof s === "string" && s.length >= 8);
  const scrub = (text) => hidden.reduce((t, s) => t.split(s).join("[redacted]"), text);
  return (obj) => {
    let line;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), ...obj }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    } catch (e) {
      line = JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "log line failed", error: String(e.message) });
    }
    write(scrub(line));
  };
}

export const errText = (e) => String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry a read with exponential backoff. Do not wrap sends in this. */
export async function retry(fn, { tries = 4, baseMs = 1000, onRetry } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i + 1 >= tries) throw e;
      onRetry?.(e, i + 1);
      await sleep(baseMs * 2 ** i);
    }
  }
}

export function makeClient(rpc, chain = bsc) {
  return createPublicClient({ chain, transport: http(rpc, { retryCount: 4, retryDelay: 1000, timeout: 30_000 }) });
}

// ─── Gas ────────────────────────────────────────────────────────

export const BSC_TX_GAS_CAP = 16_777_216n;

/** Gas limit from an estimate: x1.2, capped at the BSC per-tx limit. Pure. */
export function gasFromEstimate(est, { mult = 1.2, cap = BSC_TX_GAS_CAP } = {}) {
  const g = (BigInt(est) * BigInt(Math.round(mult * 100))) / 100n;
  if (g > cap) throw new Error(`Gas ${g} is over the BSC per-tx cap ${cap}`);
  return g;
}

/** A `prepare` for sends: legacy gas price and an explicit gas limit from an estimate. */
export function makePrepare(client, { gasPrice }) {
  return async (req) => {
    const to = req.address ?? req.to;
    const data = req.data ?? encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args });
    const est = await client.estimateGas({ account: req.account, to, data, value: req.value ?? 0n });
    const out = { ...req, gas: gasFromEstimate(est), gasPrice, type: "legacy" };
    delete out.maxFeePerGas; delete out.maxPriorityFeePerGas;
    return out;
  };
}

// ─── Market discovery ───────────────────────────────────────────

export const marketCreatedEvent = parseAbiItem("event MarketCreated(address indexed market, address indexed creator, string question, uint64 startTime, uint64 deadline, address tokenA, uint8 tokenADecimals, uint256 bBase, address adjudicator, uint256 lpPositionId, uint256 nonce)");

/** Block ranges of at most `size` blocks. Pure. */
export function chunks(from, to, size = 5000n) {
  const out = [];
  for (let a = BigInt(from); a <= BigInt(to); a += BigInt(size)) {
    const b = a + BigInt(size) - 1n;
    out.push([a, b > BigInt(to) ? BigInt(to) : b]);
  }
  return out;
}

/** Market record kept in the state file. */
export function marketRecord(args, terms, block) {
  const t = { source: Number(terms.source), feed: terms.feed, feedId: terms.feedId, kind: Number(terms.kind), strikeWad: terms.strikeWad.toString(), maxDelay: Number(terms.maxDelay) };
  return {
    question: args.question, deadline: Number(args.deadline), creator: args.creator, block: Number(block),
    asset: assetForTerms(t), ...t,
  };
}

/**
 * Add new markets of our adjudicator to state.markets. getLogs go to `logClient` in chunks of
 * at most 5000 blocks. Terms reads go to `client`. Resumes from state.scannedTo.
 */
export async function syncMarkets({ client, logClient, deployment, state, confirmations = 2n, log = () => {} }) {
  const latest = (await retry(() => client.getBlockNumber())) - BigInt(confirmations);
  const from = state.scannedTo == null ? BigInt(deployment.block) : BigInt(state.scannedTo) + 1n;
  let added = 0;
  for (const [a, b] of chunks(from, latest)) {
    const logs = await retry(() => logClient.getLogs({ address: deployment.marketFactory, event: marketCreatedEvent, fromBlock: a, toBlock: b }));
    for (const l of logs) {
      if (l.args.adjudicator.toLowerCase() !== deployment.adjudicator.toLowerCase()) continue;
      const market = getAddress(l.args.market);
      if (state.markets[market]) continue;
      const terms = await retry(() => client.readContract({ address: deployment.adjudicator, abi: adjudicatorAbi, functionName: "terms", args: [market] }));
      state.markets[market] = marketRecord(l.args, terms, l.blockNumber);
      added++;
      log({ job: "sync", action: "MARKET_FOUND", market, question: l.args.question });
    }
    state.scannedTo = Number(b);
  }
  return added;
}

// ─── Feeds ──────────────────────────────────────────────────────

const atlasAbi = parseAbi([
  "function fetch(bytes4) view returns ((uint80 price, uint48 aggregatedTs, uint48 onchainTs))",
  "function decimals() view returns (uint8)",
]);
const aggAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

/** Live feed price and publish time, read the same way as PriceFeedAdjudicator._read. */
export async function readFeedPrice(client, { source, feed, feedId }) {
  if (source === 0) {
    const [s, dec] = await Promise.all([
      client.readContract({ address: feed, abi: atlasAbi, functionName: "fetch", args: [feedId] }),
      client.readContract({ address: feed, abi: atlasAbi, functionName: "decimals" }),
    ]);
    return { price: Number(formatUnits(s.price, Number(dec))), ts: Number(s.aggregatedTs) };
  }
  const [r, dec] = await Promise.all([
    client.readContract({ address: feed, abi: aggAbi, functionName: "latestRoundData" }),
    client.readContract({ address: feed, abi: aggAbi, functionName: "decimals" }),
  ]);
  return { price: Number(formatUnits(r[1], Number(dec))), ts: Number(r[3]) };
}

// ─── Market creation (port of HedgeSetup._createMarket) ─────────

export const termsTuple = {
  type: "tuple",
  components: [
    { name: "source", type: "uint8" }, { name: "feed", type: "address" }, { name: "feedId", type: "bytes4" },
    { name: "kind", type: "uint8" }, { name: "strikeWad", type: "uint256" }, { name: "maxDelay", type: "uint64" },
  ],
};

export const factoryAbi = parseAbi([
  "struct MarketParams { string question; uint64 startTime; uint64 deadline; address adjudicator; address tokenA; uint256 bBase; uint256 initialProbabilityWad; bytes adjudicatorConfig; uint256 maxInputNative; uint64 quoteDeadline; uint32 expectedAmmVersion; uint32 expectedBookVersion; bytes32 expectedAmmHash; bytes32 expectedBookHash; bytes32 resolutionTermsHash; bytes32 expectedProfileHash; uint64 expectedInvalidationBuffer; }",
  "function createMarket(MarketParams params) returns (address market, uint256 lpPositionId)",
  "function allowedCreators(address) view returns (bool)",
  "function invalidationBuffer() view returns (uint64)",
  "function creationPaused() view returns (bool)",
  "event MarketCreated(address indexed market, address indexed creator, string question, uint64 startTime, uint64 deadline, address tokenA, uint8 tokenADecimals, uint256 bBase, address adjudicator, uint256 lpPositionId, uint256 nonce)",
]);
const vaultAbi = parseAbi(["function activeConfigVersion() view returns (uint32)", "function configHash(uint32) view returns (bytes32)"]);
const profileAbi = parseAbi(["function profileHash() view returns (bytes32)"]);

/**
 * Pure: MarketParams for createMarket, exactly as HedgeSetup._createMarket builds them.
 * terms: { source, feed, feedId (bytes4 hex), kind, strikeWad (bigint), maxDelay }
 */
export function buildMarketParams({ question, deadline, terms, probWad, bBase, maxInput, adjudicator, stable, quoteDeadline, cfg }) {
  const t = { ...terms, strikeWad: BigInt(terms.strikeWad), maxDelay: BigInt(terms.maxDelay) };
  return {
    question,
    startTime: 0n, // the factory uses the block time
    deadline: BigInt(deadline),
    adjudicator,
    tokenA: stable,
    bBase: BigInt(bBase),
    initialProbabilityWad: BigInt(probWad),
    adjudicatorConfig: encodeAbiParameters(
      [{ type: "address" }, { type: "uint64" }, { type: "bytes" }],
      [adjudicator, BigInt(deadline), encodeAbiParameters([termsTuple], [t])],
    ),
    maxInputNative: BigInt(maxInput),
    quoteDeadline: BigInt(quoteDeadline),
    expectedAmmVersion: cfg.ammVersion,
    expectedBookVersion: cfg.bookVersion,
    expectedAmmHash: cfg.ammHash,
    expectedBookHash: cfg.bookHash,
    resolutionTermsHash: keccak256(encodeAbiParameters([{ type: "string" }, termsTuple], [question, t])),
    expectedProfileHash: cfg.profileHash,
    expectedInvalidationBuffer: cfg.invalidationBuffer,
  };
}

/** Node config the params must match. Read fresh before each creation. */
export async function readNodeConfig(client, d) {
  const r = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const [ammVersion, bookVersion, profileHash, invalidationBuffer] = await Promise.all([
    r(d.ammVault, vaultAbi, "activeConfigVersion"), r(d.bookVault, vaultAbi, "activeConfigVersion"),
    r(d.adjudicator, profileAbi, "profileHash"), r(d.marketFactory, factoryAbi, "invalidationBuffer"),
  ]);
  const [ammHash, bookHash] = await Promise.all([r(d.ammVault, vaultAbi, "configHash", [ammVersion]), r(d.bookVault, vaultAbi, "configHash", [bookVersion])]);
  return { ammVersion, bookVersion, ammHash, bookHash, profileHash, invalidationBuffer };
}

/**
 * Approve the stable to the market factory (when needed), then send createMarket.
 * `onSent(hash)` runs as soon as the create tx has a hash, so the caller can persist it.
 * @returns {{ market: string, hash: string, block: number }}
 */
export async function sendCreateMarket({ client, wallet, prepare, deployment: d, params, onSent = () => {} }) {
  const account = wallet.account;
  const allowance = await client.readContract({ address: d.stable, abi: erc20Abi, functionName: "allowance", args: [account.address, d.marketFactory] });
  if (allowance < params.maxInputNative) {
    const { request } = await client.simulateContract({ account, address: d.stable, abi: erc20Abi, functionName: "approve", args: [d.marketFactory, params.maxInputNative] });
    const ah = await wallet.writeContract(await prepare(request));
    const ar = await client.waitForTransactionReceipt({ hash: ah, timeout: 120_000 });
    if (ar.status !== "success") throw new Error(`approve failed (${ah})`);
  }
  const { request } = await client.simulateContract({ account, address: d.marketFactory, abi: factoryAbi, functionName: "createMarket", args: [params] });
  const hash = await wallet.writeContract(await prepare(request));
  await onSent(hash);
  return marketFromReceipt(client, hash);
}

/** Wait for a create tx and read the real market address from its MarketCreated event. */
export async function marketFromReceipt(client, hash, { timeout = 120_000 } = {}) {
  const rc = await client.waitForTransactionReceipt({ hash, timeout });
  if (rc.status !== "success") throw Object.assign(new Error(`createMarket reverted (${hash})`), { reverted: true });
  const ev = parseEventLogs({ abi: factoryAbi, eventName: "MarketCreated", logs: rc.logs })[0];
  if (!ev) throw new Error(`No MarketCreated event in ${hash}`);
  return { market: getAddress(ev.args.market), hash, block: Number(rc.blockNumber), args: ev.args };
}

export { wadToFloat };
