import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseQuotes, parseCandles, parseFearGreed, parseGlobal, realizedVol, buildSnapshot, cmcRequest, cmcConfig, KEYLESS_BASE, KEYED_BASE } from "../src/cmc.mjs";

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));

test("parseQuotes reads the v3 array shape", () => {
  const q = parseQuotes(fx("cmc-quotes.json"));
  assert.equal(q[1839].symbol, "BNB");
  assert.ok(q[1839].price > 100);
  assert.equal(q[1].symbol, "BTC");
  assert.equal(q[42865].symbol, "IWMB");
  assert.equal(q[42865].tokenAddress, "0x5e0ec7c48f2da6d8db1a2c95d71c535bf8a77c41");
});

test("parseCandles converts ms timestamps and sorts", () => {
  const c = parseCandles(fx("cmc-candles.json"));
  assert.equal(c.length, 30);
  assert.ok(c[0].t < 2e10, "seconds, not ms");
  assert.ok(c.every((x, i) => i === 0 || x.t > c[i - 1].t));
  const s = parseCandles({ data: [[1, 1, 1, 2, 0, 200, 0], [1, 1, 1, 1, 0, 100, 0]] });
  assert.deepEqual(s.map((x) => x.t), [100, 200]);
});

test("fear and greed, global metrics", () => {
  assert.deepEqual(parseFearGreed(fx("cmc-fng.json")).value, 10);
  const g = parseGlobal(fx("cmc-global.json"));
  assert.ok(g.btcDominance > 50 && g.totalMarketCap > 1e12);
});

test("realizedVol: known series", () => {
  // Alternating +x/-x log returns: sample stdev = x * sqrt(n/(n-1)).
  const x = 0.01, closes = [100];
  for (let i = 0; i < 10; i++) closes.push(closes.at(-1) * Math.exp(i % 2 ? -x : x));
  const expected = x * Math.sqrt(10 / 9) * Math.sqrt(365);
  assert.ok(Math.abs(realizedVol(closes) - expected) < 1e-12);
  assert.equal(realizedVol([1, 2]), null);
  assert.equal(realizedVol([5, 5, 5, 5]), 0);
});

test("buildSnapshot uses candles, falls back to default sigma", () => {
  const quotes = parseQuotes(fx("cmc-quotes.json"));
  const bnb = buildSnapshot({ symbol: "BNB", quotes, candles: parseCandles(fx("cmc-candles.json")) });
  assert.equal(bnb.sigmaSource, "realized_1d_candles");
  assert.ok(bnb.sigma > 0.1 && bnb.sigma < 2);
  const iwm = buildSnapshot({ symbol: "IWMB", quotes, candles: [] });
  assert.equal(iwm.sigmaSource, "default");
  assert.equal(iwm.sigma, 0.25);
  assert.ok(iwm.spot > 0);
});

test("cmcConfig: keyless by default, header when CMC_API_KEY set", () => {
  assert.deepEqual(cmcConfig({}), { base: KEYLESS_BASE, headers: {} });
  assert.deepEqual(cmcConfig({ CMC_API_KEY: "k" }), { base: KEYED_BASE, headers: { "X-CMC_PRO_API_KEY": "k" } });
});

const res = (status, body, headers = {}) => ({ status, ok: status < 300, headers: new Headers(headers), text: async () => JSON.stringify(body) });

test("cmcRequest backs off on 429 then succeeds", async () => {
  const calls = [], sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return calls.length < 3 ? res(429, {}) : res(200, { data: { value: 42 }, status: { error_code: "0" } });
  };
  const body = await cmcRequest("/v3/fear-and-greed/latest", {}, { fetchImpl, env: {}, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(body.data.value, 42);
  assert.deepEqual(sleeps, [500, 1000]);
  assert.equal(calls[0].url, `${KEYLESS_BASE}/v3/fear-and-greed/latest`);
  assert.equal(calls[0].init.headers["X-CMC_PRO_API_KEY"], undefined);
});

test("cmcRequest honors Retry-After, sends key header, gives up after maxRetries", async () => {
  const sleeps = [];
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return res(429, { status: { error_message: "slow down" } }, { "retry-after": "2" }); };
  await assert.rejects(
    cmcRequest("/v1/k-line/candles", { platform: "bsc", address: "0xabc", limit: 3 }, { fetchImpl, env: { CMC_API_KEY: "secret" }, maxRetries: 2, sleep: async (ms) => sleeps.push(ms) }),
    /HTTP 429/);
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(seen.url, `${KEYED_BASE}/v1/k-line/candles?platform=bsc&address=0xabc&limit=3`);
  assert.equal(seen.init.headers["X-CMC_PRO_API_KEY"], "secret");
});
