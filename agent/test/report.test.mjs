import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyze, feedTouched, marketTitle } from "../src/report.mjs";
import { buildSnapshot } from "../src/cmc.mjs";

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const demo = fx("demo-bnb.json");
const snap = buildSnapshot({ symbol: "BNB", quotes: null, candles: [], fearGreed: { value: 50 } });

test("marketTitle", () => {
  assert.equal(marketTitle("BNB", demo.chain.terms, demo.chain.deadline), "BNB price above $600 before 2026-12-01 05:00 UTC");
});

test("feedTouched respects the window", () => {
  assert.equal(feedTouched(demo.chain), false);
  assert.equal(feedTouched({ ...demo.chain, feed: { ...demo.chain.feed, price: 601 } }), true);
  assert.equal(feedTouched({ ...demo.chain, feed: { ...demo.chain.feed, price: 601, ts: demo.chain.openedAt - 1 } }), false);
});

test("analyze without Cournot uses the model only", () => {
  const r = analyze({ chain: demo.chain, snapshot: snap, cournot: { state: "skipped" }, asset: "BNB" });
  assert.equal(r.decision.pCournot, null);
  assert.equal(r.decision.pStar, r.decision.pModel);
  assert.equal(r.inputs.spotSource, "onchain_feed");
});

test("analyze flags a Cournot 402 and still decides", () => {
  const r = analyze({ chain: demo.chain, snapshot: snap, cournot: { state: "payment_required", needsPayment: true, probability: null }, asset: "BNB" });
  assert.ok(r.decision.alerts.some((a) => a.code === "COURNOT_PAYMENT_REQUIRED"));
  assert.ok(["BUY_NO", "BUY_YES", "HOLD"].includes(r.decision.action));
});

test("run.mjs --offline writes a full report from the demo fixture", () => {
  const out = mkdtempSync(join(tmpdir(), "hedge-out-"));
  const run = fileURLToPath(new URL("../run.mjs", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/demo-bnb.json", import.meta.url));
  const stdout = execFileSync(process.execPath, [run, "--offline", "--fixture", fixture, "--out", out, "--quiet"], { encoding: "utf8" });
  assert.match(stdout, /Decision BUY_NO/);
  const r = JSON.parse(readFileSync(join(out, `${demo.chain.market}.json`), "utf8"));
  assert.equal(r.mode, "offline");
  assert.equal(r.decision.action, "BUY_NO");
  assert.equal(r.inputs.cournot.probability, 0.22);
  assert.equal(r.inputs.cmc.sigmaSource, "realized_1d_candles");
  assert.ok(r.evidence.lines.length >= 4);
  assert.ok(r.decision.alerts.some((a) => a.code === "COURNOT_SOOTH_GAP"));
  assert.ok(!JSON.stringify(r).includes("203.0.113.7"), "Cournot IP field is not copied into the report");
});
