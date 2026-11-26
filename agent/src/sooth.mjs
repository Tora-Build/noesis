// Sooth chain reads and trade building with viem.
// Price source: AMMEngine.getMarketState(market) -> (qYes, qNo, price). `price` is the LMSR YES
// probability in WAD (PositionPricing.probability). Trade: AMMEngine.tradePositions(market, outcome,
// int256 deltaShares, maxCostOrMinProceeds). Outcome NO=0, YES=1. Shares and costs are WAD.

import { parseAbi, encodeFunctionData, formatUnits, getAddress, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

export const ammAbi = parseAbi([
  "function getMarketState(address market) view returns (uint256 qYes, uint256 qNo, uint256 price)",
  "function getPositionQuote(address market, uint8 outcome, int256 deltaShares) view returns (uint256 cost, uint256 fee, uint256 netAmount, uint256 newPrice)",
  "function getPosition(address market, address user) view returns (uint256 yesShares, uint256 noShares)",
  "function getLiquidity(address market) view returns (uint256)",
  "function tokenAOf(address market) view returns (address)",
  "function tokenADecimalsOf(address market) view returns (uint8)",
  "function tradePositions(address market, uint8 outcome, int256 deltaShares, uint256 maxCostOrMinProceeds) returns (uint256 actualCost)",
]);

export const marketAbi = parseAbi([
  "function deadline() view returns (uint64)",
  "function startTime() view returns (uint64)",
  "function adjudicator() view returns (address)",
  "function marketFactory() view returns (address)",
  "function isTradingOpen() view returns (bool)",
  "function isResolving() view returns (bool)",
  "function isSettled() view returns (bool)",
  "function invalidationBuffer() view returns (uint64)",
]);

export const factoryAbi = parseAbi(["function ammEngine() view returns (address)"]);

export const adjudicatorAbi = parseAbi([
  "struct Terms { uint8 source; address feed; bytes4 feedId; uint8 kind; uint256 strikeWad; uint64 maxDelay; }",
  "function terms(address market) view returns (Terms)",
  "function readFeed(address market) view returns (uint256 priceWad, uint64 ts)",
  "function openedAt(address market) view returns (uint64)",
  "function settleFromFeed(address market) returns (uint8 outcome)",
  "function settle(address market)",
  "function canSettle(address market) view returns (bool)",
  "function getPhase(address market) view returns (uint8)",
  "function getOutcome(address market) view returns (uint8)",
  "function earlyResolution() view returns (bool)",
  "function adjudicatorType() view returns (string)",
]);

export const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
]);

export const WAD = 10n ** 18n;
export const PHASE = ["IDLE", "ACTIVE", "RESOLVED", "ATTESTED", "SETTLED", "DISPUTED"];

// Atlas MultiFeed ids and known Chainlink feeds on BSC mainnet -> asset symbol.
export const ATLAS_MULTIFEED_BSC = "0xeace519ebb14fb8404fa6ddd23c3b34abade44aa";
export const ATLAS_FEED_IDS = { 1163: "EWJB", 1164: "EWTB", 1165: "EWZB", 1166: "IWMB", 1167: "MELIB", 1168: "NUB" };
export const CHAINLINK_BSC = {
  "0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee": "BNB",
  "0x264990fbd0a4796a3e3d8e37c4d5f87a3aca5ebf": "BTC",
};

export const wadToFloat = (x) => Number(formatUnits(x, 18));
export const floatToWad = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

/** feedId bytes4 -> integer id (bytes4(uint32(n))). */
export const feedIdToNumber = (hex) => parseInt(hex, 16);
export const numberToFeedId = (n) => `0x${n.toString(16).padStart(8, "0")}`;

/** Which CMC asset does these terms track? */
export function assetForTerms(terms) {
  if (terms.source === 0) return ATLAS_FEED_IDS[feedIdToNumber(terms.feedId)] ?? null;
  return CHAINLINK_BSC[terms.feed.toLowerCase()] ?? null;
}

export function makePublicClient(rpc, chain = bsc) {
  return createPublicClient({ chain, transport: http(rpc) });
}

/** Read everything the agent needs about one market. */
export async function readMarket(client, market, { amm } = {}) {
  market = getAddress(market);
  const call = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const [deadline, adjudicator, factory, tradingOpen, settled, resolving] = await Promise.all([
    call(market, marketAbi, "deadline"),
    call(market, marketAbi, "adjudicator"),
    call(market, marketAbi, "marketFactory"),
    call(market, marketAbi, "isTradingOpen"),
    call(market, marketAbi, "isSettled"),
    call(market, marketAbi, "isResolving").catch(() => null),
  ]);
  amm = amm ? getAddress(amm) : await call(factory, factoryAbi, "ammEngine");
  const [[qYes, qNo, priceWad], tokenA, decimals, terms, feed, openedAt, phase, block] = await Promise.all([
    call(amm, ammAbi, "getMarketState", [market]),
    call(amm, ammAbi, "tokenAOf", [market]),
    call(amm, ammAbi, "tokenADecimalsOf", [market]),
    call(adjudicator, adjudicatorAbi, "terms", [market]).catch(() => null),
    call(adjudicator, adjudicatorAbi, "readFeed", [market]).catch(() => null),
    call(adjudicator, adjudicatorAbi, "openedAt", [market]).catch(() => null),
    call(adjudicator, adjudicatorAbi, "getPhase", [market]).catch(() => null),
    client.getBlock(),
  ]);
  const now = Number(block.timestamp);
  return {
    market, amm, adjudicator, factory,
    deadline: Number(deadline), now, tradingOpen, settled, resolving,
    tokenA, decimals: Number(decimals),
    qYes: qYes.toString(), qNo: qNo.toString(),
    yesPrice: wadToFloat(priceWad),
    terms: terms && {
      source: Number(terms.source), feed: terms.feed, feedId: terms.feedId, kind: Number(terms.kind),
      strike: wadToFloat(terms.strikeWad), strikeWad: terms.strikeWad.toString(), maxDelay: Number(terms.maxDelay),
    },
    feed: feed && { price: wadToFloat(feed[0]), priceWad: feed[0].toString(), ts: Number(feed[1]), ageSec: now - Number(feed[1]) },
    openedAt: openedAt == null ? null : Number(openedAt),
    phase: phase == null ? null : PHASE[Number(phase)] ?? Number(phase),
  };
}

/** Native token units needed for a WAD amount, rounded up (matches AMMEngine._wadToTokenCeil). */
export function wadToNativeCeil(wad, decimals) {
  if (decimals >= 18) return wad * 10n ** BigInt(decimals - 18);
  const unit = 10n ** BigInt(18 - decimals);
  return (wad + unit - 1n) / unit;
}

/** Pure: shares (WAD) to buy for a USD budget at a price. */
export function sharesForBudget(sizeUsd, price) {
  if (!(sizeUsd > 0) || !(price > 0)) return 0n;
  return floatToWad(sizeUsd / price);
}

/**
 * Build (not send) a buy. Quotes on chain, adds slippage to maxIn, checks allowance.
 * @returns {{ quote, approval: object|null, trade: {to, data, value}, args }}
 */
export async function buildTrade(client, { market, amm, outcome, shares, slippage = 0.02, decimals, tokenA, account }) {
  if (shares <= 0n) throw new Error("shares must be positive");
  const [cost, fee, netAmount, newPrice] = await client.readContract({ address: amm, abi: ammAbi, functionName: "getPositionQuote", args: [market, outcome, shares] });
  const maxIn = (netAmount * BigInt(Math.round((1 + slippage) * 10_000))) / 10_000n;
  const args = [market, outcome, shares, maxIn];
  const trade = { to: amm, data: encodeFunctionData({ abi: ammAbi, functionName: "tradePositions", args }), value: 0n };
  let approval = null;
  const needNative = wadToNativeCeil(maxIn, decimals);
  if (account) {
    const allowance = await client.readContract({ address: tokenA, abi: erc20Abi, functionName: "allowance", args: [account, amm] });
    if (allowance < needNative) {
      approval = { to: tokenA, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [amm, needNative] }), value: 0n, amount: needNative.toString() };
    }
  }
  return {
    quote: { cost: wadToFloat(cost), fee: wadToFloat(fee), netAmount: wadToFloat(netAmount), newPrice: wadToFloat(newPrice), maxIn: wadToFloat(maxIn), needNative: needNative.toString() },
    args: { market, outcome, deltaShares: shares.toString(), maxIn: maxIn.toString() },
    approval,
    trade,
  };
}

/** Wallet from env PRIVATE_KEY. The key is never logged or returned. */
export function walletFromEnv(rpc, chain = bsc, env = process.env) {
  const pk = env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY is not set");
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  return createWalletClient({ account, chain, transport: http(rpc) });
}

/** Send a built trade (approval first if needed). Simulates the trade before sending. */
export async function sendTrade(publicClient, wallet, built) {
  const hashes = {};
  if (built.approval) {
    hashes.approval = await wallet.sendTransaction({ to: built.approval.to, data: built.approval.data });
    await publicClient.waitForTransactionReceipt({ hash: hashes.approval });
  }
  const { market, outcome, deltaShares, maxIn } = built.args;
  const { request } = await publicClient.simulateContract({
    account: wallet.account, address: built.trade.to, abi: ammAbi, functionName: "tradePositions",
    args: [market, outcome, BigInt(deltaShares), BigInt(maxIn)],
  });
  hashes.trade = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: hashes.trade });
  return { ...hashes, status: receipt.status };
}

