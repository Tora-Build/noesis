import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { decodeFunctionData, toFunctionSignature } from "viem";
import * as s from "../src/sooth.mjs";

import { getAddress } from "viem";
const MARKET = getAddress("0x5ee0000000000000000000000000000000000b4b");
const AMM = getAddress("0xa000000000000000000000000000000000000a11");
const ADJ = getAddress("0xad00000000000000000000000000000000000001");
const FACTORY = getAddress("0xfac0000000000000000000000000000000000001");
const TOKEN = getAddress("0x70ce000000000000000000000000000000000001");
const USER = getAddress("0x00000000000000000000000000000000000000aa");
const W = 10n ** 18n;

function fakeClient({ allowance = 0n } = {}) {
  const calls = [];
  return {
    calls,
    getBlock: async () => ({ timestamp: 1_795_680_000n }),
    readContract: async ({ address, functionName, args }) => {
      calls.push({ address, functionName, args });
      const t = {
        deadline: 1_796_101_200n, adjudicator: ADJ, marketFactory: FACTORY, isTradingOpen: true, isSettled: false, isResolving: false,
        ammEngine: AMM, getMarketState: [1200n * W, 800n * W, 41n * W / 100n], tokenAOf: TOKEN, tokenADecimalsOf: 6,
        terms: { source: 1, feed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE", feedId: "0x00000000", kind: 2, strikeWad: 600n * W, maxDelay: 0n },
        readFeed: [554n * W, 1_795_679_955n], openedAt: 1_795_420_800n, getPhase: 1,
        getPositionQuote: [10n * W, W / 10n, 10n * W + W / 10n, 45n * W / 100n],
        allowance,
      }[functionName];
      if (t === undefined) throw new Error(`unexpected ${functionName}`);
      return t;
    },
  };
}

test("readMarket resolves the AMM through the factory and reads price, terms, feed", async () => {
  const m = await s.readMarket(fakeClient(), MARKET);
  assert.equal(m.amm, AMM);
  assert.equal(m.yesPrice, 0.41);
  assert.equal(m.terms.kind, 2);
  assert.equal(m.terms.strike, 600);
  assert.equal(m.feed.price, 554);
  assert.equal(m.feed.ageSec, 45);
  assert.equal(m.phase, "ACTIVE");
  assert.equal(m.decimals, 6);
  assert.equal(s.assetForTerms(m.terms), "BNB");
});

test("buildTrade quotes, adds slippage, encodes tradePositions, and adds approval", async () => {
  const client = fakeClient({ allowance: 0n });
  const built = await s.buildTrade(client, { market: MARKET, amm: AMM, outcome: 1, shares: 10n * W, slippage: 0.02, decimals: 6, tokenA: TOKEN, account: USER });
  const maxIn = ((10n * W + W / 10n) * 10_200n) / 10_000n;
  assert.equal(built.args.maxIn, maxIn.toString());
  const dec = decodeFunctionData({ abi: s.ammAbi, data: built.trade.data });
  assert.equal(dec.functionName, "tradePositions");
  assert.deepEqual(dec.args, [MARKET, 1, 10n * W, maxIn]);
  assert.equal(built.trade.to, AMM);
  const ap = decodeFunctionData({ abi: s.erc20Abi, data: built.approval.data });
  assert.deepEqual(ap.args, [AMM, s.wadToNativeCeil(maxIn, 6)]);
  const enough = await s.buildTrade(fakeClient({ allowance: 10n ** 30n }), { market: MARKET, amm: AMM, outcome: 0, shares: W, decimals: 6, tokenA: TOKEN, account: USER });
  assert.equal(enough.approval, null);
});

test("unit helpers", () => {
  assert.equal(s.wadToNativeCeil(1n, 6), 1n);
  assert.equal(s.wadToNativeCeil(10n ** 12n, 6), 1n);
  assert.equal(s.wadToNativeCeil(10n ** 12n + 1n, 6), 2n);
  assert.equal(s.wadToNativeCeil(5n, 18), 5n);
  assert.equal(s.sharesForBudget(10, 0.5), 20n * W);
  assert.equal(s.sharesForBudget(0, 0.5), 0n);
  assert.equal(s.numberToFeedId(1166), "0x0000048e");
  assert.equal(s.feedIdToNumber("0x0000048e"), 1166);
  assert.equal(s.assetForTerms({ source: 0, feedId: "0x0000048e", feed: s.ATLAS_MULTIFEED_BSC }), "IWMB");
});

test("walletFromEnv needs PRIVATE_KEY", () => {
  assert.throws(() => s.walletFromEnv("http://127.0.0.1:1", undefined, {}), /PRIVATE_KEY is not set/);
});

// Cross-check our hand-written ABI against the sooth-factory v0.1.1 bundle when it is present.
const bundle = new URL("../../contracts/lib/sooth-factory/sdk/abi.json", import.meta.url);
test("AMM ABI matches sooth-factory sdk/abi.json", { skip: !existsSync(bundle) && "sooth-factory not cloned" }, () => {
  const j = JSON.parse(readFileSync(bundle, "utf8"));
  const amm = j.contracts.AMMEngine.abi ?? j.contracts.AMMEngine;
  const sigs = new Set(amm.filter((x) => x.type === "function").map((f) => toFunctionSignature(f)));
  for (const f of s.ammAbi.filter((x) => x.type === "function")) assert.ok(sigs.has(toFunctionSignature(f)), `missing ${toFunctionSignature(f)}`);
  const tm = j.contracts.TruthMarket.abi ?? j.contracts.TruthMarket;
  const tsigs = new Set(tm.filter((x) => x.type === "function").map((f) => toFunctionSignature(f)));
  for (const f of s.marketAbi) assert.ok(tsigs.has(toFunctionSignature(f)), `missing ${toFunctionSignature(f)}`);
  const mf = j.contracts.MarketFactory.abi ?? j.contracts.MarketFactory;
  assert.ok(mf.some((f) => f.name === "ammEngine"));
});
