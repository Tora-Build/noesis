import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, blend, kelly } from "../src/decide.mjs";

test("blend weights Cournot when present", () => {
  assert.equal(blend(null, 0.3), 0.3);
  assert.equal(blend(0.5, null), 0.5);
  assert.ok(Math.abs(blend(0.5, 0.3) - 0.42) < 1e-12);
  assert.equal(blend(null, null), null);
});

test("kelly for a binary claim", () => {
  assert.ok(Math.abs(kelly(0.6, 0.5) - 0.2) < 1e-12);
  assert.equal(kelly(0.4, 0.5), 0);
  assert.equal(kelly(0.9, 1), 0);
});

test("BUY_YES when fair is above Sooth", () => {
  const d = decide({ pSooth: 0.3, pCournot: 0.5, pModel: 0.45, risk: 20 }, { bankroll: 1000 });
  assert.equal(d.action, "BUY_YES");
  assert.equal(d.outcome, 1);
  assert.ok(Math.abs(d.pStar - 0.48) < 1e-12);
  // kelly (0.48-0.3)/0.7 = 0.2571; half * 0.8 = 0.1029 -> capped at 0.1
  assert.equal(d.fraction, 0.1);
  assert.equal(d.sizeUsd, 100);
});

test("BUY_NO when fair is below Sooth, size falls with risk", () => {
  const lo = decide({ pSooth: 0.6, pCournot: null, pModel: 0.45, risk: 10 });
  const hi = decide({ pSooth: 0.6, pCournot: null, pModel: 0.45, risk: 60 });
  assert.equal(lo.action, "BUY_NO");
  assert.equal(lo.outcome, 0);
  assert.ok(Math.abs(lo.entryPrice - 0.4) < 1e-12);
  // kelly NO: (0.55-0.4)/0.6 = 0.25 -> 0.5*0.25*0.9 = 0.1125 -> cap 0.1; at risk 60: 0.05
  assert.equal(lo.fraction, 0.1);
  assert.ok(Math.abs(hi.fraction - 0.05) < 1e-12);
  assert.ok(hi.sizeUsd < lo.sizeUsd);
});

test("HOLD inside the threshold, above the risk cap, on stale feed, or when closed", () => {
  assert.equal(decide({ pSooth: 0.5, pModel: 0.53, risk: 10 }).action, "HOLD");
  const capped = decide({ pSooth: 0.2, pModel: 0.6, risk: 80 });
  assert.equal(capped.action, "HOLD");
  assert.match(capped.reason, /cap/);
  const stale = decide({ pSooth: 0.2, pModel: 0.6, risk: 10, feedAgeSec: 5000 });
  assert.equal(stale.action, "HOLD");
  assert.ok(stale.alerts.some((a) => a.code === "FEED_STALE"));
  assert.equal(decide({ pSooth: 0.2, pModel: 0.6, risk: 10, tradingOpen: false }).action, "HOLD");
  assert.equal(decide({ pSooth: null, pModel: 0.6 }).action, "HOLD");
});

test("alerts: Cournot gap and high risk", () => {
  const d = decide({ pSooth: 0.2, pCournot: 0.5, pModel: 0.4, risk: 72 });
  const codes = d.alerts.map((a) => a.code);
  assert.deepEqual(codes, ["COURNOT_SOOTH_GAP", "HIGH_RISK"]);
  assert.equal(d.action, "BUY_YES"); // 72 is under the cap 75
});
