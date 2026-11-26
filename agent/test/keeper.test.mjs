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
