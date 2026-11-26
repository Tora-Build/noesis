import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { keeperPlan } from "../keeper.mjs";

const base = { now: 1000, deadline: 2000, openedAt: 100, phase: "ACTIVE", settled: false, canSettle: false, earlyResolution: true };
const touchAbove = { kind: 2, strike: 600 };
const closeAbove = { kind: 0, strike: 600 };

test("touch crossed inside the window: settleFromFeed", () => {
  assert.equal(keeperPlan({ ...base, terms: touchAbove, feed: { price: 601, ts: 990 } }).action, "SETTLE_FROM_FEED");
  assert.equal(keeperPlan({ ...base, terms: { kind: 3, strike: 500 }, feed: { price: 499, ts: 990 } }).action, "SETTLE_FROM_FEED");
});

test("touch crossed but early resolution off: wait for deadline", () => {
  assert.equal(keeperPlan({ ...base, earlyResolution: false, terms: touchAbove, feed: { price: 601, ts: 990 } }).action, "WAIT");
});

test("touch not crossed before deadline: wait; after deadline: settleFromFeed (NO)", () => {
  assert.equal(keeperPlan({ ...base, terms: touchAbove, feed: { price: 550, ts: 990 } }).action, "WAIT");
  const p = keeperPlan({ ...base, now: 2001, terms: touchAbove, feed: { price: 550, ts: 2000 } });
  assert.equal(p.action, "SETTLE_FROM_FEED");
  assert.match(p.reason, /NO/);
});

test("touch read before openedAt does not count", () => {
  assert.equal(keeperPlan({ ...base, terms: touchAbove, feed: { price: 700, ts: 50 } }).action, "WAIT");
});

test("close market: wait until a read at or after the deadline", () => {
  assert.equal(keeperPlan({ ...base, terms: closeAbove, feed: { price: 700, ts: 990 } }).action, "WAIT");
  assert.equal(keeperPlan({ ...base, now: 2100, terms: closeAbove, feed: { price: 700, ts: 1999 } }).action, "WAIT");
  assert.equal(keeperPlan({ ...base, now: 2100, terms: closeAbove, feed: { price: 700, ts: 2050 } }).action, "SETTLE_FROM_FEED");
});

test("proposed, settleable, settled", () => {
  assert.equal(keeperPlan({ ...base, phase: "RESOLVED", terms: touchAbove, feed: { price: 1, ts: 1 } }).action, "WAIT");
  assert.equal(keeperPlan({ ...base, phase: "RESOLVED", canSettle: true }).action, "SETTLE");
  assert.equal(keeperPlan({ ...base, settled: true }).action, "DONE");
});

// ── Pending tx and --loop ─────────────────────────────────────────────
import { tick, parseLoop } from "../keeper.mjs";

const M = "0x5ee0000000000000000000000000000000000b4b";
const proposable = async () => ({ ...base, now: 2001, adjudicator: "0xad00000000000000000000000000000000000001", terms: touchAbove, feed: { price: 550, ts: 2000 } });
function fakeKeeperClient({ mined = false } = {}) {
  const c = { sent: 0, receipts: mined ? { "0xh1": { status: "success" } } : {} };
  c.simulateContract = async () => ({ request: {}, result: 0 });
  c.waitForTransactionReceipt = async ({ hash }) => { if (c.receipts[hash]) return c.receipts[hash]; throw new Error("timeout"); };
  c.getTransactionReceipt = async ({ hash }) => { if (c.receipts[hash]) return c.receipts[hash]; throw new Error("not found"); };
  c.wallet = { account: { address: "0x00000000000000000000000000000000000000aa" }, writeContract: async () => { c.sent++; return `0xh${c.sent}`; } };
  return c;
}
const quiet = (fn) => async () => { const l = console.log; console.log = () => {}; try { await fn(); } finally { console.log = l; } };

test("keeper keeps a pending hash per market and does not send again until it is mined", quiet(async () => {
  const c = fakeKeeperClient();
  const pending = new Map();
  const a = await tick(c, c.wallet, M, true, pending, { read: proposable, receiptTimeoutMs: 1 });
  assert.equal(a.tx.status, "pending");
  assert.equal(pending.get(M), "0xh1");
  const b = await tick(c, c.wallet, M, true, pending, { read: proposable });
  assert.equal(b.action, "PENDING");
  assert.equal(c.sent, 1, "no second send while pending");
  c.receipts["0xh1"] = { status: "success" };
  await tick(c, c.wallet, M, true, pending, { read: proposable, receiptTimeoutMs: 1 });
  assert.equal(c.sent, 2, "after it is mined, the keeper reads state again and may act");
}));

test("keeper clears the pending hash when the receipt comes in time", quiet(async () => {
  const c = fakeKeeperClient({ mined: true });
  const pending = new Map();
  const a = await tick(c, c.wallet, M, true, pending, { read: proposable });
  assert.equal(a.tx.status, "success");
  assert.equal(pending.size, 0);
}));

test("--loop must be 10 seconds or more", () => {
  assert.equal(parseLoop(undefined), null);
  assert.equal(parseLoop("10"), 10);
  assert.equal(parseLoop("60"), 60);
  for (const bad of ["0", "1", "9.9", "-5", "abc", ""]) assert.throws(() => parseLoop(bad), /10 or more/);
});
