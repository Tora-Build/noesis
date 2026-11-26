import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as c from "../src/cournot.mjs";

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const res = (status, body) => ({ status, text: async () => JSON.stringify(body) });
const tmpCache = (now) => c.createCache({ dir: mkdtempSync(join(tmpdir(), "cournot-test-")), now });

test("parseResolve and pickResolved on the real resolve capture", () => {
  const cands = c.parseResolve(fx("cournot-resolve.json"));
  assert.equal(cands[0].id, 113195);
  assert.equal(c.pickResolved(cands).id, 113195);
  assert.equal(c.pickResolved([{ id: 1, confidence: 0.9 }, { id: 2, confidence: 0.8 }]), null);
  assert.equal(c.pickResolved([{ id: 1, confidence: 0.95 }, { id: 2, confidence: 0.7 }]).id, 1);
});

test("responseState mirrors the official client", () => {
  assert.equal(c.responseState(200, { code: 0 }), "complete");
  assert.equal(c.responseState(402, {}), "payment_required");
  assert.equal(c.responseState(429, {}), "rate_limited");
  assert.equal(c.responseState(503, {}), "service_error");
  assert.equal(c.responseState(200, { code: 22002 }), "pack_exhausted");
  assert.equal(c.responseState(401, {}), "key_invalid");
  assert.equal(c.responseState(400, { code: 4100, msg: "bad" }), "api_error");
});

test("parseProbability: nested result/basis and sibling forms", () => {
  const p = c.parseProbability(fx("cournot-probability.json"));
  assert.equal(p.probability, 0.22);
  assert.equal(p.basis.price_distance.target_price, 600);
  assert.equal(p.freeQuota.remaining, 2);
  assert.equal(c.parseProbability({ data: { probability: 0.4, basis: [] } }).probability, 0.4);
  assert.equal(c.parseProbability({ data: { result: { point_estimate: 35 } } }).probability, 0.35);
  const lines = c.evidenceLines(p.basis);
  assert.deepEqual(lines.map((l) => l.section), ["primary_anchor", "price_distance", "cross_check", "cross_check", "limitation", "limitation"]);
});

test("resolve posts the documented body to /intelligence/v1/resolve", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return res(200, fx("cournot-resolve.json")); };
  const r = await c.resolve("BNB price above $600 before Dec 1 2026", { limit: 3, fetchImpl, env: {} });
  assert.equal(seen.url, "https://interface.cournot.ai/intelligence/v1/resolve");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(seen.init.body), { message: "BNB price above $600 before Dec 1 2026", limit: 3 });
  assert.equal(r.picked.id, 113195);
});

test("probability: request shape, key header, cache hit on the second call", async () => {
  let calls = 0, seen;
  const fetchImpl = async (url, init) => { calls++; seen = { url, init }; return res(200, fx("cournot-probability.json")); };
  const cache = tmpCache(() => 1000);
  const env = { COURNOT_API_KEY: "ck_live_abcDEF123" };
  const a = await c.probability(113195, "BNB above 600", { fetchImpl, cache, env });
  assert.equal(seen.url, "https://interface.cournot.ai/intelligence/v1/probability");
  assert.deepEqual(JSON.parse(seen.init.body), { message: "BNB above 600", market_ids: ["113195"] });
  assert.equal(seen.init.headers["COURNOT-API-KEY"], "ck_live_abcDEF123");
  assert.equal(seen.init.headers["PAYMENT-SIGNATURE"], undefined);
  assert.equal(a.state, "complete");
  assert.equal(a.probability, 0.22);
  assert.equal(a.cached, false);
  const b = await c.probability(113195, "BNB above 600", { fetchImpl, cache, env });
  assert.equal(b.cached, true);
  assert.equal(b.probability, 0.22);
  assert.equal(calls, 1, "second call served from cache");
});

test("probability: cache expires after the window", async () => {
  let now = 0, calls = 0;
  const cache = tmpCache(() => now);
  const fetchImpl = async () => { calls++; return res(200, fx("cournot-probability.json")); };
  await c.probability(1, "m", { fetchImpl, cache, env: {} });
  now = 7 * 3600 * 1000;
  await c.probability(1, "m", { fetchImpl, cache, env: {} });
  assert.equal(calls, 2);
});

test("probability: 402 returns needsPayment and never pays", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init); return res(402, fx("cournot-402.json")); };
  const cache = tmpCache(() => 0);
  const r = await c.probability(5, "m", { fetchImpl, cache, env: {} });
  assert.equal(r.needsPayment, true);
  assert.equal(r.state, "payment_required");
  assert.equal(r.probability, null);
  assert.equal(seen.length, 1, "no retry, no payment request");
  assert.ok(!("PAYMENT-SIGNATURE" in seen[0].headers));
  const again = await c.probability(5, "m", { fetchImpl, cache, env: {} });
  assert.equal(again.cached, true);
  assert.equal(seen.length, 1);
});

test("probability: rate limit and errors are not cached and not retried", async () => {
  let calls = 0;
  const cache = tmpCache(() => 0);
  const r429 = await c.probability(7, "m", { fetchImpl: async () => { calls++; return res(429, {}); }, cache, env: {} });
  assert.equal(r429.state, "rate_limited");
  const r500 = await c.probability(7, "m", { fetchImpl: async () => { calls++; return res(500, {}); }, cache, env: {} });
  assert.equal(r500.state, "service_error");
  const net = await c.probability(7, "m", { fetchImpl: async () => { calls++; throw new Error("down"); }, cache, env: {} });
  assert.equal(net.state, "network_error");
  assert.equal(calls, 3);
});

test("probability: COURNOT_OFFLINE=1 makes no call", async () => {
  const r = await c.probability(9, "m", { fetchImpl: async () => assert.fail("called"), cache: tmpCache(() => 0), env: { COURNOT_OFFLINE: "1" } });
  assert.equal(r.state, "offline");
});

test("secrets are redacted in the cache and bad keys rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cournot-red-"));
  const cache = c.createCache({ dir });
  cache.set(1, { note: "key ck_live_secret123", api_key: "x", free_quota: { ip: "1.2.3.4" } });
  const raw = readFileSync(join(dir, readdirSync(dir)[0]), "utf8");
  assert.ok(!raw.includes("ck_live_secret123") && !raw.includes("1.2.3.4"));
  assert.throws(() => c.apiKeyHeader({ COURNOT_API_KEY: "nope" }), /invalid format/);
  assert.throws(() => c.cournotBase({ COURNOT_API_BASE: "https://evil.example" }), /Unsupported/);
});
