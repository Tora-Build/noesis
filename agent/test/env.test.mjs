import "./_no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles } from "../src/env.mjs";
import { cmcRequest, fetchSnapshot } from "../src/cmc.mjs";
import { analyze } from "../src/report.mjs";
import { buildSnapshot } from "../src/cmc.mjs";
import { readFileSync } from "node:fs";

test("loadEnvFiles: real env wins, then agent/.env, then root .env; missing files are fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-test-"));
  writeFileSync(join(dir, "agent.env"), "A=agent\nB=agent\n");
  writeFileSync(join(dir, "root.env"), "A=root\nB=root\nC=root\n");
  const env = { A: "shell" };
  const loaded = loadEnvFiles([join(dir, "agent.env"), join(dir, "missing.env"), join(dir, "root.env")], env);
  assert.deepEqual(env, { A: "shell", B: "agent", C: "root" });
  assert.deepEqual(loaded.map((l) => l.keys), [1, 1]);
  assert.ok(!JSON.stringify(loaded).includes("agent\""), "returns names and counts, not values");
});

const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } });

test("CMC call log has path, time and status only: no key, no query", async () => {
  const calls = [];
  const env = { CMC_API_KEY: "secret-cmc-key-123" };
  await cmcRequest("/v3/fear-and-greed/latest", { id: 1839, convert: "USD" }, { fetchImpl: async () => ok({ status: { error_code: 0 }, data: {} }), env, calls, now: () => new Date(0) });
  assert.deepEqual(calls, [{ path: "/v3/fear-and-greed/latest", at: "1970-01-01T00:00:00.000Z", status: 200 }]);
  assert.ok(!JSON.stringify(calls).includes("secret"));
});

test("fetchSnapshot reports the CMC mode and every call; the report carries them", async () => {
  const fetchImpl = async () => ok({ status: { error_code: 0 }, data: {} });
  const keyed = await fetchSnapshot("EWJB", { fetchImpl, env: { CMC_API_KEY: "k" } });
  assert.equal(keyed.cmcMode, "keyed");
  assert.deepEqual(keyed.cmcCalls.map((c) => c.path), ["/v3/fear-and-greed/latest", "/v1/global-metrics/quotes/latest"]);
  const keyless = await fetchSnapshot("EWJB", { fetchImpl, env: {} });
  assert.equal(keyless.cmcMode, "keyless");

  const demo = JSON.parse(readFileSync(new URL("./fixtures/demo-bnb.json", import.meta.url)));
  const chain = { ...demo.chain, chainId: 56, block: 999, blockHash: "0xbb", priceWad: "410000000000000000",
    feed: { ...demo.chain.feed, priceWad: "554000000000000000000" } };
  const snap = { ...buildSnapshot({ symbol: "BNB", candles: [], fearGreed: { value: 50 } }), cmcMode: "keyed", cmcCalls: keyed.cmcCalls };
  const r = analyze({ chain, snapshot: snap, cournot: null, asset: "BNB" });
  assert.equal(r.inputs.cmc.mode, "keyed");
  assert.equal(r.inputs.cmc.calls.length, 2);
  assert.equal(r.chainId, 56);
  assert.equal(r.proof.block, 999);
  assert.equal(r.proof.ammState.priceWad, "410000000000000000");
  assert.equal(r.proof.feed.ts, demo.chain.feed.ts);
  assert.equal(r.proof.feed.priceWad, "554000000000000000000");
});
