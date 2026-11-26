// Cournot Intelligence Oracle client. Same HTTP contract as the official cournot-client.mjs:
//   POST {base}/intelligence/v1/resolve      body {message, limit}          (free)
//   POST {base}/intelligence/v1/probability  body {message, market_ids[]}   (3 free calls per IP, ever)
//   headers: content-type: application/json; optional COURNOT-API-KEY: ck_live_...
// This module NEVER pays. A 402 returns { needsPayment: true }. It never sends PAYMENT-SIGNATURE.

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_BASE = "https://interface.cournot.ai";
export const DEV_BASE = "https://dev-interface.cournot.ai";
export const DEFAULT_CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "cache");
const DEFAULT_TTL_MS = 6 * 3600 * 1000;

export function cournotBase(env = process.env) {
  const base = (env.COURNOT_API_BASE || PRODUCTION_BASE).replace(/\/$/, "");
  if (![PRODUCTION_BASE, DEV_BASE].includes(base) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
    throw new Error("Unsupported Cournot API base");
  }
  return base;
}

export function apiKeyHeader(env = process.env) {
  const key = env.COURNOT_API_KEY;
  if (!key) return {};
  if (!/^ck_live_[A-Za-z0-9_-]{1,256}$/.test(key)) throw new Error("COURNOT_API_KEY has an invalid format");
  return { "COURNOT-API-KEY": key };
}

/** Remove secrets from anything we log or write. */
export function redact(value) {
  if (typeof value === "string") return value.replace(/ck_live_[A-Za-z0-9_-]+/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    /^(api_?key|signature|authorization|privateKey|ip)$/i.test(k) ? "[REDACTED]" : redact(v)]));
}

/** Map an HTTP exchange to a state. Mirrors responseState() in the official client. */
export function responseState(status, body) {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service_error";
  if (body?.code === 22002) return "pack_exhausted";
  if (status === 401 || (body?.code === 4100 && body?.msg === "api key is invalid")) return "key_invalid";
  if (status === 402) return "payment_required";
  if (status >= 200 && status < 300 && body?.code === 0) return "complete";
  return "api_error";
}

async function post(path, body, { fetchImpl = fetch, env = process.env, headers = {} } = {}) {
  if (!["resolve", "probability"].includes(path)) throw new Error("Invalid Cournot path");
  const res = await fetchImpl(`${cournotBase(env)}/intelligence/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(path === "probability" ? 120_000 : 30_000),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text.trim() ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
  return { status: res.status, body: parsed };
}

// ─── Pure parsers ───────────────────────────────────────────────

/** Parse a resolve response into candidate markets, best first. */
export function parseResolve(body) {
  const markets = body?.data?.markets ?? [];
  return markets
    .map((m) => ({ id: m.market_info?.id, title: m.market_info?.title, endTime: m.market_info?.end_time,
      marketPrice: m.market_info?.market_outcome_price, confidence: m.matching_confidence }))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
}

/** Pick a market the way query-flow.md does: one item, or a leader with >=0.85 and a 0.15 lead. */
export function pickResolved(candidates) {
  if (candidates.length === 1) return candidates[0];
  const [a, b] = candidates;
  if (a && b && a.confidence >= 0.85 && a.confidence - b.confidence >= 0.15) return a;
  return null;
}

function toProb(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return n > 1 && n <= 100 ? n / 100 : Math.min(1, Math.max(0, n));
}

/** Parse a complete probability response. Handles nested {probability:{result,basis}} and sibling fields. */
export function parseProbability(body) {
  const data = body?.data ?? {};
  const nested = data.probability && typeof data.probability === "object" ? data.probability : null;
  const result = nested?.result ?? data.result ?? null;
  const basis = nested?.basis ?? data.basis ?? null;
  const p = toProb(result?.point_estimate ?? (nested ? nested.probability : data.probability));
  return {
    probability: p,
    result,
    basis,
    markets: data.markets ?? null,
    billing: data.billing ?? null,
    freeQuota: data.free_quota ? { remaining: data.free_quota.remaining ?? null } : null,
    apiKeyQuota: data.api_key_quota ? { remaining: data.api_key_quota.remaining ?? null } : null,
    charged: data.charged ?? null,
  };
}

/** Flatten basis into a short list of evidence lines for reports. */
export function evidenceLines(basis) {
  if (!basis) return [];
  if (Array.isArray(basis)) return basis.map((b) => ({ source: b.source, summary: b.summary, url: b.url ?? null, time: b.time ?? null }));
  const out = [];
  if (basis.primary_anchor) out.push({ section: "primary_anchor", ...basis.primary_anchor });
  if (basis.price_distance) out.push({ section: "price_distance", ...basis.price_distance });
  for (const c of basis.cross_checks ?? []) out.push({ section: "cross_check", ...c });
  for (const l of basis.limitations ?? []) out.push({ section: "limitation", text: l });
  return out;
}

// ─── Cache ──────────────────────────────────────────────────────

export function createCache({ dir = DEFAULT_CACHE_DIR, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const file = (id) => join(dir, `cournot-${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  return {
    get(id) {
      try {
        const entry = JSON.parse(readFileSync(file(id), "utf8"));
        return now() - entry.fetchedAt <= ttlMs ? entry : null;
      } catch { return null; }
    },
    set(id, value) {
      mkdirSync(dir, { recursive: true });
      const entry = { fetchedAt: now(), ...value };
      const tmp = `${file(id)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(redact(entry), null, 2));
      renameSync(tmp, file(id));
      return entry;
    },
  };
}

// ─── Calls ──────────────────────────────────────────────────────

export async function resolve(message, { limit = 5, ...opts } = {}) {
  if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
  const { status, body } = await post("resolve", { message, limit: Math.min(10, Math.max(1, limit)) }, opts);
  const state = responseState(status, body);
  if (state !== "complete") return { state, httpStatus: status, candidates: [], response: redact(body) };
  const candidates = parseResolve(body);
  return { state, candidates, picked: pickResolved(candidates) };
}

/**
 * Probability for one Cournot market id, at most once per cache window.
 * Returns { state, probability, basis, ... } or { state:"payment_required", needsPayment:true }.
 * Never retries, never pays.
 */
export async function probability(marketId, message, { cache = createCache(), force = false, env = process.env, ...opts } = {}) {
  if (marketId == null) throw new Error("marketId is required");
  if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
  if (!force) {
    const hit = cache.get(marketId);
    if (hit) return { ...hit, cached: true };
  }
  if (env.COURNOT_OFFLINE === "1") return { state: "offline", probability: null, cached: false };
  let status, body;
  try {
    ({ status, body } = await post("probability", { message, market_ids: [String(marketId)] }, { ...opts, env, headers: apiKeyHeader(env) }));
  } catch (e) {
    return { state: "network_error", error: e.message, probability: null, cached: false };
  }
  const state = responseState(status, body);
  if (state === "complete") {
    const entry = cache.set(marketId, { state, marketId: String(marketId), message, ...parseProbability(body) });
    return { ...entry, cached: false };
  }
  if (state === "payment_required" || state === "pack_exhausted") {
    // Remember the 402 for the window so we do not hit the endpoint again. No payment is attempted.
    const entry = cache.set(marketId, { state, needsPayment: true, probability: null, marketId: String(marketId) });
    return { ...entry, cached: false };
  }
  return { state, httpStatus: status, probability: null, error: redact(body?.msg ?? null), cached: false };
}
