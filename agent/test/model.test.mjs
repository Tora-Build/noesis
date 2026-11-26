import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normCdf, probCloseAbove, probTouchAbove, probTouchBelow, fairProbability, riskScore, KIND } from "../src/model.mjs";

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);

test("normCdf matches tabulated values", () => {
  close(normCdf(0), 0.5);
  close(normCdf(1.96), 0.9750021);
  close(normCdf(-1), 0.1586553);
});

test("close above: lognormal, zero drift", () => {
  close(probCloseAbove(100, 100, 0.2, 1), 0.4601722); // N(-0.1)
  close(probCloseAbove(100, 110, 0.5, 0.25), 0.3063438); // N(-0.5062408)
  assert.equal(probCloseAbove(120, 110, 0.5, 0), 1);
  assert.equal(probCloseAbove(100, 110, 0.5, 0), 0);
});

test("touch above: reflection principle", () => {
  close(probTouchAbove(100, 110, 0.5, 0.25), 0.668963, 1e-5);
  assert.equal(probTouchAbove(111, 110, 0.5, 0.25), 1, "already crossed");
  const v = 0.1 * Math.sqrt(0.1);
  const approx = 2 * normCdf(Math.log(100 / 105) / v);
  close(probTouchAbove(100, 105, 0.1, 0.1), approx, 0.01); // ~2 P(S_T >= K)
  assert.ok(probTouchAbove(100, 110, 0.5, 0.25) > probCloseAbove(100, 110, 0.5, 0.25));
  assert.ok(probTouchAbove(100, 110, 5, 10) <= 1);
});

test("touch below mirrors touch above", () => {
  assert.equal(probTouchBelow(90, 100, 0.5, 1), 1);
  const p = probTouchBelow(100, 90, 0.5, 0.25);
  assert.ok(p > 1 - probCloseAbove(100, 90, 0.5, 0.25) && p < 1);
});

test("fairProbability dispatches on kind and handles deadline", () => {
  const now = 1_000_000, deadline = now + 0.25 * 365 * 86400;
  const base = { spot: 100, strike: 110, sigma: 0.5, now, deadline };
  close(fairProbability({ ...base, kind: KIND.CLOSE_ABOVE }), 0.3063438);
  close(fairProbability({ ...base, kind: KIND.CLOSE_BELOW }), 1 - 0.3063438);
  close(fairProbability({ ...base, kind: KIND.TOUCH_ABOVE }), 0.668963, 1e-5);
  assert.equal(fairProbability({ ...base, kind: KIND.TOUCH_ABOVE, touched: true }), 1);
  assert.equal(fairProbability({ ...base, kind: KIND.TOUCH_ABOVE, now: deadline + 1 }), 0);
  assert.throws(() => fairProbability({ ...base, kind: 9 }));
});

test("risk score is 0-100 and moves the right way", () => {
  const now = 0, deadline = 30 * 86400;
  const calm = riskScore({ sigma: 0.2, fearGreed: 50, spot: 100, strike: 200, now, deadline });
  const wild = riskScore({ sigma: 1.2, fearGreed: 5, spot: 100, strike: 100, now, deadline });
  assert.ok(calm.score >= 0 && calm.score <= 20, `calm ${calm.score}`);
  assert.equal(wild.score, 98); // 0.4*1 + 0.25*0.9 + 0.35*1
  assert.ok(riskScore({ sigma: 0.5, fearGreed: 20, spot: 100, strike: 100, now, deadline }).score >
    riskScore({ sigma: 0.5, fearGreed: 20, spot: 100, strike: 150, now, deadline }).score);
});
