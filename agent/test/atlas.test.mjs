import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLatest, verifySignature, consensusGate, fetchConsensus, ATLAS_SIGNER } from "../src/atlas.mjs";
import { decide } from "../src/decide.mjs";

// Example from the Atlas Pull API docs (feed 624).
const DOC = {
  data: {
    payload: "0x0000027000000de01dedfc23734f00006a27cdd301",
    signature: "0x447d98f5648f0fd1571fd38558dfeb5ab9ee07e7546aaef8f0b45851bbee4a160eeedec974cf0b72a114b176f710e2ca8035520bafd89fb31e231059fd9056171b",
    magicMarker: "0x7096",
    consensusScores: [{ feedId: "624", consensusScore: 0.9661300692, consensusStatus: "HEALTHY", twapPrice: "0.999905861426781800", medianPrice: "0.999836527073969063", priceChangePct: -0.01383420713427873, priceVolatility: 0.00009324613558817679 }],
    priceDetails: [{ feedId: "624", timestampSeconds: "1780993491", price: 0.999832025250886479 }],
  },
  status: { error_code: "0", error_message: "SUCCESS" },
};

test("verifySignature: the docs example recovers to the published Atlas signer", async () => {
  const v = await verifySignature(DOC.data.payload, DOC.data.signature);
  assert.equal(v.valid, true);
  assert.equal(v.recovered.toLowerCase(), ATLAS_SIGNER);
});

test("verifySignature: a changed payload does not verify", async () => {
  const v = await verifySignature(DOC.data.payload.replace(/1$/, "2"), DOC.data.signature);
  assert.equal(v.valid, false);
});

test("parseLatest: joins price and consensus per feed", () => {
  const f = parseLatest(DOC, { signatureValid: true })["624"];
  assert.equal(f.consensusStatus, "HEALTHY");
  assert.equal(f.consensusScore, 0.9661300692);
  assert.equal(f.price, 0.999832025250886479);
  assert.equal(f.ts, 1780993491);
  assert.equal(f.twapPrice, 0.9999058614267818);
  assert.equal(f.signatureValid, true);
});

test("parseLatest: an unknown status becomes UNKNOWN", () => {
  const body = structuredClone(DOC); body.data.consensusScores[0].consensusStatus = "WEIRD";
  assert.equal(parseLatest(body)["624"].consensusStatus, "UNKNOWN");
});

test("consensusGate: HEALTHY full, DEGRADED half, worse holds, bad signature holds, no data no change", () => {
  assert.deepEqual([consensusGate(null).applies, consensusGate(null).sizeMultiplier], [false, 1]);
  assert.equal(consensusGate({ consensusStatus: "HEALTHY", consensusScore: 0.97, signatureValid: true }).sizeMultiplier, 1);
  assert.equal(consensusGate({ consensusStatus: "DEGRADED", consensusScore: 0.87, signatureValid: true }).sizeMultiplier, 0.5);
  for (const s of ["WARNING", "CRITICAL", "SPLIT_MARKET", "UNKNOWN"]) assert.equal(consensusGate({ consensusStatus: s, consensusScore: 0.4, signatureValid: true }).hold, true);
  assert.equal(consensusGate({ consensusStatus: "HEALTHY", consensusScore: 0.99, signatureValid: false }).hold, true);
});

test("decide: consensus scales size and can block a trade", () => {
  const input = { pSooth: 0.25, pModel: 0.4, risk: 40, feedAgeSec: 10 };
  const full = decide({ ...input, consensus: consensusGate({ consensusStatus: "HEALTHY", consensusScore: 0.97, signatureValid: true }) });
  const half = decide({ ...input, consensus: consensusGate({ consensusStatus: "DEGRADED", consensusScore: 0.87, signatureValid: true }) });
  const none = decide({ ...input, consensus: consensusGate({ consensusStatus: "CRITICAL", consensusScore: 0.3, signatureValid: true }) });
  assert.equal(full.action, "BUY_YES");
  assert.ok(Math.abs(half.fraction - full.fraction / 2) < 1e-12);
  assert.match(half.reason, /DEGRADED/);
  assert.equal(none.action, "HOLD");
  assert.match(none.reason, /CRITICAL/);
  assert.equal(decide(input).action, "BUY_YES"); // no Atlas data: unchanged
});

test("fetchConsensus: no key means no call; API errors never throw and never echo the key", async () => {
  let called = 0;
  const fake = async () => { called++; return { status: 401, json: async () => ({ status: { error_code: "Unauthorized", error_message: "API Key is invalid k3y" } }) }; };
  assert.equal((await fetchConsensus(["1166"], { key: "", fetchImpl: fake })).state, "no_key");
  assert.equal(called, 0);
  const r = await fetchConsensus(["1166"], { key: "k3y", fetchImpl: fake });
  assert.equal(r.state, "error");
  assert.doesNotMatch(r.error, /k3y/);
});

test("fetchConsensus: a good response is parsed and its signature checked", async () => {
  const fake = async () => ({ status: 200, json: async () => DOC });
  const r = await fetchConsensus(["624"], { key: "k", fetchImpl: fake });
  assert.equal(r.state, "complete");
  assert.equal(r.signatureValid, true);
  assert.equal(r.feeds["624"].consensusStatus, "HEALTHY");
});
