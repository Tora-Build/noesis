import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAbiParameters, keccak256, encodeAbiParameters } from "viem";
import { nextWeekdayDeadline, marketText, questionStrike, planLadder, marketKey, ladderStrikes, cleanStep, parseHHMM } from "../src/ladder.mjs";
import { dueJobs, publishDue, dayKey, spendLeft, addSpend, loadState, saveState, emptyState } from "../src/schedule.mjs";
import { gasFromEstimate, chunks, buildMarketParams, termsTuple, makeLogger } from "../src/botchain.mjs";
import { runMarket } from "../run.mjs";

const utc = (s) => Date.parse(s) / 1000;
const iso = (sec) => new Date(sec * 1000).toISOString();

// ── Deadline ──

test("next weekday deadline: same day before 20:00, next day after", () => {
  assert.equal(iso(nextWeekdayDeadline(utc("2026-11-25T12:00:00Z"))), "2026-11-25T21:00:00.000Z"); // Wed
  assert.equal(iso(nextWeekdayDeadline(utc("2026-11-25T21:05:00Z"))), "2026-11-26T21:00:00.000Z"); // Wed after close -> Thu
  assert.equal(iso(nextWeekdayDeadline(utc("2026-11-25T20:30:00Z"))), "2026-11-26T21:00:00.000Z"); // less than 1 h lead
});

test("next weekday deadline never falls on a weekend", () => {
  assert.equal(iso(nextWeekdayDeadline(utc("2026-11-27T21:05:00Z"))), "2026-11-30T21:00:00.000Z"); // Fri -> Mon
  assert.equal(iso(nextWeekdayDeadline(utc("2026-11-28T10:00:00Z"))), "2026-11-30T21:00:00.000Z"); // Sat -> Mon
  assert.equal(iso(nextWeekdayDeadline(utc("2026-11-29T23:00:00Z"))), "2026-11-30T21:00:00.000Z"); // Sun -> Mon
  for (let t = utc("2026-01-01T00:00:00Z"); t < utc("2027-01-01T00:00:00Z"); t += 3 * 3600 + 17 * 60) {
    const dl = nextWeekdayDeadline(t);
    const day = new Date(dl * 1000).getUTCDay();
    assert.ok(day >= 1 && day <= 5, iso(dl));
    assert.ok(dl >= t + 3600);
  }
});

test("next weekday deadline skips listed dates and honors DEADLINE_AT_UTC", () => {
  assert.equal(iso(nextWeekdayDeadline(utc("2026-11-25T21:05:00Z"), { skipDates: ["2026-11-26"] })), "2026-11-27T21:00:00.000Z");
  assert.equal(iso(nextWeekdayDeadline(utc("2026-06-01T08:00:00Z"), { at: "20:00" })), "2026-06-01T20:00:00.000Z");
  assert.throws(() => parseHHMM("25:00"));
});

// ── Strike and question ──

test("question strike equals the encoded strikeWad for many spots", () => {
  const spots = [262.37, 31.84, 612.5, 899.99, 4.127, 12345.6, 0.987, 100, 27.03, 1.5];
  for (const spot of spots) {
    const round = cleanStep(spot * 0.005);
    const { strikes } = ladderStrikes(spot, [0.99, 0.98, 0.96], round);
    for (const strike of strikes) {
      const { question, strikeWad } = marketText({ symbol: "IWMB", strike, deadline: utc("2026-11-27T21:00:00Z") });
      const named = questionStrike(question);
      assert.ok(Math.abs(named - Number(strikeWad) / 1e18) <= 1e-6, `${question} vs ${strikeWad}`);
      assert.equal(BigInt(Math.round(named * 1e6)) * 10n ** 12n, strikeWad);
      assert.ok(strike < spot);
    }
  }
});

test("question text format", () => {
  const { question, strikeWad } = marketText({ symbol: "IWMB", strike: 262, deadline: utc("2026-11-27T21:00:00Z") });
  assert.equal(question, "IWMB below $262 at 2026-11-27 21:00 UTC (Atlas Oracle)");
  assert.equal(strikeWad, 262n * 10n ** 18n);
  const bnb = marketText({ symbol: "BNB", strike: 612.5, deadline: utc("2026-11-27T21:00:00Z"), source: "Chainlink" });
  assert.equal(bnb.question, "BNB below $612.5 at 2026-11-27 21:00 UTC (Chainlink)");
  assert.equal(bnb.strikeWad, 6125n * 10n ** 17n);
});

// ── Idempotency ──

test("planLadder: 3 strikes below spot, none when 3 exist, only the missing ones", () => {
  const p = planLadder({ spot: 265.4 });
  assert.equal(p.create.length, 3);
  assert.ok(p.create.every((s) => s < 265.4));
  const wad = (s) => marketText({ symbol: "X", strike: s, deadline: 1 }).strikeWad;
  const all = p.create.map((s) => ({ strikeWad: wad(s) }));
  assert.deepEqual(planLadder({ spot: 265.4, existing: all }).create, []);
  const two = planLadder({ spot: 265.4, existing: all.slice(0, 2) });
  assert.deepEqual(two.create, [p.create[2]]);
  // Price moved: still never more than 3 per asset and deadline, never a duplicate strike.
  const moved = planLadder({ spot: 270.1, existing: all.slice(0, 2) });
  assert.equal(moved.create.length, 1);
  assert.ok(!all.slice(0, 2).some((e) => e.strikeWad === wad(moved.create[0])));
});

test("marketKey is stable across number and bigint input", () => {
  assert.equal(marketKey({ asset: "BNB", kind: 1, strikeWad: 600n * 10n ** 18n, deadline: 100 }), marketKey({ asset: "BNB", kind: 1, strikeWad: (600n * 10n ** 18n).toString(), deadline: "100" }));
});

test("state file survives a restart (atomic save, then load)", () => {
  const f = join(mkdtempSync(join(tmpdir(), "bot-state-")), "s.json");
  assert.deepEqual(loadState(f), emptyState());
  const s = emptyState();
  s.markets["0xabc"] = { asset: "IWMB", strikeWad: 5n };
  s.last.createDay = "2026-11-26";
  saveState(f, s);
  const back = loadState(f);
  assert.equal(back.markets["0xabc"].strikeWad, "5");
  assert.equal(back.last.createDay, "2026-11-26");
  writeFileSync(f, "{bad");
  assert.throws(() => loadState(f)); // never silently reset
});

// ── Daily spend cap ──

test("daily spend cap: left, add, new day resets, old days pruned", () => {
  const s = emptyState();
  assert.equal(spendLeft(s, "2026-11-26", 200), 200);
  addSpend(s, "2026-11-26", 150.5);
  assert.equal(spendLeft(s, "2026-11-26", 200), 49.5);
  addSpend(s, "2026-11-26", 60);
  assert.equal(spendLeft(s, "2026-11-26", 200), 0);
  assert.equal(spendLeft(s, "2026-11-27", 200), 200);
  addSpend(s, "2026-12-10", 1);
  assert.equal(s.spend["2026-11-26"], undefined);
});

function fakeMarket() {
  return {
    market: "0x0000000000000000000000000000000000000001", amm: "0x0000000000000000000000000000000000000002",
    chainId: 56, now: 1_000, deadline: 1_000 + 86400, tradingOpen: true, decimals: 18,
    tokenA: "0x0000000000000000000000000000000000000003",
    yesPrice: 0.2, qYes: "0", qNo: "0", priceWad: "200000000000000000",
    terms: { source: 1, feed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE", feedId: "0x00000000", kind: 1, strike: 600, strikeWad: "600", maxDelay: 300 },
    feed: { price: 590, priceWad: "0", ts: 990, ageSec: 10 },
  };
}
const snap = { symbol: "BNB", spot: 590, sigma: 0.6, sigmaSource: "default", fearGreed: { value: 50 }, candles: { count: 0 }, cmcCalls: [] };
// Quotes cost 0.3 per share plus 1% fee; price impact is small.
const fakeClient = { readContract: async ({ functionName, args }) => {
  if (functionName === "getPositionQuote") { const sh = args[2]; const cost = (sh * 3n) / 10n; return [cost, cost / 100n, cost + cost / 100n, 250000000000000000n]; }
  if (functionName === "allowance") return 0n;
  throw new Error(functionName);
} };

test("daily cap: no budget left means HOLD", async () => {
  const r = await runMarket({ client: fakeClient, chain: fakeMarket(), asset: "BNB", snapshot: snap, cournotMode: "off", maxSpendUsd: 0.5 });
  assert.equal(r.decision.action, "HOLD");
  assert.match(r.decision.reason, /Daily spend cap/);
});

test("daily cap: size is cut to what is left", async () => {
  const free = await runMarket({ client: fakeClient, chain: fakeMarket(), asset: "BNB", snapshot: snap, cournotMode: "off" });
  assert.equal(free.decision.action, "BUY_YES");
  const capped = await runMarket({ client: fakeClient, chain: fakeMarket(), asset: "BNB", snapshot: snap, cournotMode: "off", maxSpendUsd: 3 });
  assert.equal(capped.decision.action, "BUY_YES");
  assert.ok(capped.decision.sizeUsd <= 3 / 1.02 + 1e-9);
  assert.ok(capped.tx.quote.maxIn <= 3 + 1e-9);
});

// ── Scheduler ──

test("dueJobs: intervals and the daily create time", () => {
  const cfg = { settleSec: 60, agentSec: 900, createAt: "21:05" };
  const t = Date.parse("2026-11-26T21:04:00Z");
  assert.deepEqual(dueJobs(t, {}, cfg), ["settle", "agent"]);
  assert.deepEqual(dueJobs(t, { settleAt: t - 30_000, agentAt: t - 60_000 }, cfg), []);
  assert.deepEqual(dueJobs(t, { settleAt: t - 60_000, agentAt: t - 900_000 }, cfg), ["settle", "agent"]);
  const at = Date.parse("2026-11-26T21:05:00Z");
  assert.deepEqual(dueJobs(at, { settleAt: at, agentAt: at }, cfg), ["create"]);
  assert.deepEqual(dueJobs(at, { settleAt: at, agentAt: at, createDay: "2026-11-26" }, cfg), []);
  // Late start the same day still creates; the next day before the time does not.
  assert.deepEqual(dueJobs(Date.parse("2026-11-26T23:59:00Z"), { settleAt: Infinity, agentAt: Infinity }, cfg), ["create"]);
  assert.deepEqual(dueJobs(Date.parse("2026-11-27T10:00:00Z"), { settleAt: Infinity, agentAt: Infinity, createDay: "2026-11-26" }, cfg), []);
  // A failed run waits for its retry time.
  assert.deepEqual(dueJobs(at, { settleAt: at, agentAt: at, createRetryAt: at + 1 }, cfg), []);
  assert.deepEqual(dueJobs(at + 2, { settleAt: at, agentAt: at, createRetryAt: at + 1 }, cfg), ["create"]);
  assert.equal(dayKey(at), "2026-11-26");
});

test("publishDue: at once when forced, at most hourly after trades", () => {
  const now = 10_000_000;
  assert.equal(publishDue(now, { force: true, lastAt: now }), true);
  assert.equal(publishDue(now, { due: true, lastAt: now - 1000 }), false);
  assert.equal(publishDue(now, { due: true, lastAt: now - 3_600_000 }), true);
  assert.equal(publishDue(now, { due: false, lastAt: 0 }), false);
});

// ── Chain helpers ──

test("gas limit is estimate x1.2 and respects the BSC cap", () => {
  assert.equal(gasFromEstimate(100_000n), 120_000n);
  assert.throws(() => gasFromEstimate(15_000_000n));
});

test("getLogs chunks are at most 5000 blocks", () => {
  const c = chunks(100n, 12_100n);
  assert.equal(c.length, 3);
  assert.deepEqual(c[0], [100n, 5099n]);
  assert.deepEqual(c.at(-1), [10_100n, 12_100n]);
  assert.ok(c.every(([a, b]) => b - a + 1n <= 5000n));
  assert.deepEqual(chunks(10n, 9n), []);
});

test("market params match HedgeSetup._createMarket", () => {
  const adj = "0xa17feCd30c8E1c2C9BcfE19469f20EFF4e7e2be9";
  const terms = { source: 0, feed: "0xEAcE519ebB14fB8404fA6DdD23C3b34abaDE44aa", feedId: "0x0000048e", kind: 1, strikeWad: 262n * 10n ** 18n, maxDelay: 300 };
  const cfg = { ammVersion: 1, bookVersion: 1, ammHash: `0x${"11".repeat(32)}`, bookHash: `0x${"22".repeat(32)}`, profileHash: `0x${"33".repeat(32)}`, invalidationBuffer: 604800n };
  const q = "IWMB below $262 at 2026-11-27 21:00 UTC (Atlas Oracle)";
  const p = buildMarketParams({ question: q, deadline: 1796, terms, probWad: 10n ** 17n, bBase: 500n * 10n ** 18n, maxInput: 2500n * 10n ** 18n, adjudicator: adj, stable: adj, quoteDeadline: 1000, cfg });
  assert.equal(p.startTime, 0n);
  const [resolver, dl, inner] = decodeAbiParameters([{ type: "address" }, { type: "uint64" }, { type: "bytes" }], p.adjudicatorConfig);
  assert.equal(resolver, adj);
  assert.equal(dl, 1796n);
  const [t] = decodeAbiParameters([termsTuple], inner);
  assert.equal(t.strikeWad, 262n * 10n ** 18n);
  assert.equal(t.feedId, "0x0000048e");
  assert.equal(p.resolutionTermsHash, keccak256(encodeAbiParameters([{ type: "string" }, termsTuple], [q, { ...terms, maxDelay: 300n }])));
});

test("logger hides secrets", () => {
  const lines = [];
  const log = makeLogger({ secrets: ["0xdeadbeefdeadbeef", "https://rpc.example/key123456"], write: (s) => lines.push(s) });
  log({ error: "failed at https://rpc.example/key123456 with 0xdeadbeefdeadbeef", n: 5n });
  assert.ok(!lines[0].includes("key123456") && !lines[0].includes("deadbeef"));
  assert.match(lines[0], /"n":"5"/);
});
