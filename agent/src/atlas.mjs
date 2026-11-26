// Atlas Oracle Pull API: signed latest price and Consensus Score per feed.
// Docs: Atlas Pull API v2 (POST https://api.atlasoracle.io/report/v1/price/latest, header X-API-KEY).
// The key stays on the server. Reports keep only the public result, never the key.
import { keccak256, recoverAddress } from "viem";

export const ATLAS_API = "https://api.atlasoracle.io/report";
/** Published Atlas signer. Every signed response must recover to this address. */
export const ATLAS_SIGNER = "0x59ed4701224fd9e2a85ef2946c2ab828c1ddc600";
export const STATUSES = ["HEALTHY", "DEGRADED", "WARNING", "CRITICAL", "SPLIT_MARKET", "UNKNOWN"];

/** Recover the signer of keccak256(payload) and compare it with the Atlas signer. */
export async function verifySignature(payload, signature, signer = ATLAS_SIGNER) {
  if (!payload || !signature) return { valid: false, recovered: null };
  try {
    const recovered = await recoverAddress({ hash: keccak256(payload), signature });
    return { valid: recovered.toLowerCase() === signer.toLowerCase(), recovered };
  } catch {
    return { valid: false, recovered: null };
  }
}

/** Pure: turn one /v1/price/latest response body into { [feedId]: record }. */
export function parseLatest(body, { signatureValid = null, at = null } = {}) {
  const d = body?.data ?? {};
  const prices = new Map((d.priceDetails ?? []).map((p) => [String(p.feedId), p]));
  const out = {};
  for (const c of d.consensusScores ?? []) {
    const id = String(c.feedId);
    const p = prices.get(id);
    out[id] = {
      feedId: id,
      price: p ? Number(p.price) : null,
      ts: p ? Number(p.timestampSeconds) : null,
      consensusScore: c.consensusScore != null ? Number(c.consensusScore) : null,
      consensusStatus: STATUSES.includes(c.consensusStatus) ? c.consensusStatus : "UNKNOWN",
      twapPrice: c.twapPrice != null ? Number(c.twapPrice) : null,
      medianPrice: c.medianPrice != null ? Number(c.medianPrice) : null,
      priceChangePct: c.priceChangePct != null ? Number(c.priceChangePct) : null,
      priceVolatility: c.priceVolatility != null ? Number(c.priceVolatility) : null,
      signed: !!d.signature, signatureValid, signer: ATLAS_SIGNER, fetchedAt: at,
      endpoint: "/v1/price/latest",
    };
  }
  return out;
}

/**
 * Latest signed prices and Consensus Scores for up to 20 feed ids, in one call.
 * Returns { state, feeds: { [id]: record }, error? }. Never throws on API errors.
 */
export async function fetchConsensus(feedIds, { key = process.env.ATLAS_API_KEY, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const ids = [...new Set(feedIds.map(String))].slice(0, 20);
  if (!ids.length) return { state: "skipped", feeds: {} };
  if (!key) return { state: "no_key", feeds: {} };
  const at = new Date().toISOString();
  try {
    const r = await fetchImpl(`${ATLAS_API}/v1/price/latest`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ feedIds: ids, signed: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.json().catch(() => null);
    const code = body?.status?.error_code;
    if (r.status !== 200 || code !== "0") {
      return { state: "error", httpStatus: r.status, error: String(body?.status?.error_message ?? `HTTP ${r.status}`).replaceAll(key, "[key]"), feeds: {} };
    }
    const sig = await verifySignature(body.data?.payload, body.data?.signature);
    return { state: "complete", httpStatus: 200, at, signatureValid: sig.valid, feeds: parseLatest(body, { signatureValid: sig.valid, at }) };
  } catch (e) {
    return { state: "network_error", error: String(e?.message ?? e).replaceAll(key, "[key]"), feeds: {} };
  }
}

/**
 * Pure: how the Consensus Score changes a trade.
 * HEALTHY: trade as usual. DEGRADED: half size. WARNING, CRITICAL, SPLIT_MARKET, UNKNOWN: no trade.
 * A response with a bad signature: no trade. No Atlas data (Chainlink markets, no key): no change.
 */
/**
 * Pure: the gate for an Atlas market from the whole fetch result { state, feed }.
 * Fails closed: an API error, a missing feed or old data means no trade. Only "no_key"
 * (the server runs without the Atlas key) leaves the trade unchanged.
 */
export function atlasGate(atlas, nowSec = Math.floor(Date.now() / 1000), maxAgeSec = 900) {
  if (!atlas || atlas.state === "no_key" || atlas.state === "skipped") return consensusGate(null);
  if (!atlas.feed) return { applies: true, sizeMultiplier: 0, hold: true, reason: `Atlas Consensus Score unavailable (${atlas.state === "complete" ? "feed missing" : atlas.state}): no trade.` };
  if (atlas.feed.ts && nowSec - atlas.feed.ts > maxAgeSec) return { applies: true, sizeMultiplier: 0, hold: true, reason: `Atlas API data is ${Math.round((nowSec - atlas.feed.ts) / 60)} min old: no trade.` };
  return consensusGate(atlas.feed);
}

export function consensusGate(atlas) {
  if (!atlas) return { applies: false, sizeMultiplier: 1, hold: false, reason: null };
  if (atlas.signatureValid === false) return { applies: true, sizeMultiplier: 0, hold: true, reason: "Atlas signature did not verify." };
  const s = atlas.consensusStatus;
  const score = atlas.consensusScore != null ? atlas.consensusScore.toFixed(2) : "?";
  if (s === "HEALTHY") return { applies: true, sizeMultiplier: 1, hold: false, reason: `Atlas consensus HEALTHY (${score}).` };
  if (s === "DEGRADED") return { applies: true, sizeMultiplier: 0.5, hold: false, reason: `Atlas consensus DEGRADED (${score}): half size.` };
  return { applies: true, sizeMultiplier: 0, hold: true, reason: `Atlas consensus ${s} (${score}): no trade.` };
}
