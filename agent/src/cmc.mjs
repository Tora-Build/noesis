// CoinMarketCap client. Fetch code is kept apart from pure parsers so tests run on fixtures.

export const KEYLESS_BASE = "https://pro-api.coinmarketcap.com/public-api";
export const KEYED_BASE = "https://pro-api.coinmarketcap.com";

// Asset registry. cmcId drives quotes. candleAddress (a BSC token) drives DEX k-line candles.
// Atlas RWA tokens trade on CEX only today, so they fall back to defaultSigma.
export const ASSETS = {
  BNB: { cmcId: 1839, platform: "bsc", candleAddress: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", defaultSigma: 0.6, class: "crypto" },
  BTC: { cmcId: 1, platform: "bsc", candleAddress: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", defaultSigma: 0.55, class: "crypto" },
  IWMB: { cmcId: 42865, atlasFeedId: 1166, defaultSigma: 0.25, class: "rwa" },
  EWZB: { cmcId: 42861, atlasFeedId: 1165, defaultSigma: 0.3, class: "rwa" },
  EWJB: { atlasFeedId: 1163, defaultSigma: 0.2, class: "rwa" },
  EWTB: { atlasFeedId: 1164, defaultSigma: 0.25, class: "rwa" },
  MELIB: { atlasFeedId: 1167, defaultSigma: 0.45, class: "rwa" },
  NUB: { atlasFeedId: 1168, defaultSigma: 0.5, class: "rwa" },
};

export function cmcConfig(env = process.env) {
  const key = env.CMC_API_KEY;
  return key
    ? { mode: "keyed", base: KEYED_BASE, headers: { "X-CMC_PRO_API_KEY": key } }
    : { mode: "keyless", base: KEYLESS_BASE, headers: {} };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a CMC path. Retries 429 and 5xx with exponential backoff (honors Retry-After).
 * If `calls` is an array, each HTTP attempt is logged as { path, at, status }. The log holds
 * the path only: no query string, no key. It lets a report be matched to the CMC API log.
 */
export async function cmcRequest(path, params = {}, { fetchImpl = fetch, env = process.env, maxRetries = 4, baseDelayMs = 500, sleep = defaultSleep, calls = null, now = () => new Date() } = {}) {
  const { base, headers } = cmcConfig(env);
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  const url = `${base}${path}${qs.size ? `?${qs}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    const at = now().toISOString();
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      calls?.push({ path, at, status: null });
      throw e;
    }
    calls?.push({ path, at, status: res.status });
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const retryAfter = Number(res.headers?.get?.("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!res.ok) {
      const err = new Error(`CMC ${path} HTTP ${res.status}: ${body?.status?.error_message ?? text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const code = body?.status?.error_code;
    if (code !== undefined && String(code) !== "0") throw new Error(`CMC ${path} error ${code}: ${body.status.error_message}`);
    return body;
  }
}

// ─── Pure parsers ───────────────────────────────────────────────

const usd = (quote) => (Array.isArray(quote) ? quote.find((q) => q.symbol === "USD") ?? quote[0] : quote?.USD) ?? {};

/** Parse /v3/cryptocurrency/quotes/latest into { [cmcId]: snapshot }. */
export function parseQuotes(json) {
  const list = Array.isArray(json?.data) ? json.data : Object.values(json?.data ?? {}).flat();
  const out = {};
  for (const d of list) {
    const q = usd(d.quote);
    out[d.id] = {
      id: d.id,
      symbol: d.symbol,
      name: d.name,
      price: q.price,
      volume24h: q.volume_24h,
      marketCap: q.market_cap,
      pct1h: q.percent_change_1h,
      pct24h: q.percent_change_24h,
      pct7d: q.percent_change_7d,
      pct30d: q.percent_change_30d,
      lastUpdated: q.last_updated ?? d.last_updated,
      tokenAddress: d.platform?.token_address ?? null,
    };
  }
  return out;
}

export function parseFearGreed(json) {
  const d = json?.data ?? {};
  return { value: Number(d.value), classification: d.value_classification, updated: d.update_time };
}

export function parseGlobal(json) {
  const d = json?.data ?? {};
  const q = d.quote?.USD ?? {};
  return {
    btcDominance: d.btc_dominance,
    ethDominance: d.eth_dominance,
    totalMarketCap: q.total_market_cap,
    totalVolume24h: q.total_volume_24h,
    marketCapChange24hPct: q.total_market_cap_yesterday_percentage_change,
    updated: d.last_updated,
  };
}

/** Parse k-line candles: rows [o,h,l,c,v,ts,traders]. ts may be seconds or ms. Sorted oldest first. */
export function parseCandles(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows
    .map((r) => {
      const ts = Number(r[5]);
      return { t: ts > 1e12 ? Math.floor(ts / 1000) : ts, o: Number(r[0]), h: Number(r[1]), l: Number(r[2]), c: Number(r[3]), v: Number(r[4]) };
    })
    .filter((c) => Number.isFinite(c.c) && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

/** Annualized realized volatility from close prices (sample stdev of log returns). */
export function realizedVol(closes, periodsPerYear = 365) {
  if (!Array.isArray(closes) || closes.length < 3) return null;
  const r = [];
  for (let i = 1; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/** Combine parsed pieces into one market snapshot. Pure. */
export function buildSnapshot({ symbol, asset = ASSETS[symbol] ?? {}, quotes, candles, fearGreed, global }) {
  const quote = asset.cmcId != null ? quotes?.[asset.cmcId] ?? null : null;
  const closes = (candles ?? []).map((c) => c.c);
  const rv = closes.length >= 5 ? realizedVol(closes) : null;
  return {
    symbol,
    spot: quote?.price ?? null,
    quote,
    candles: { count: closes.length, first: candles?.[0]?.t ?? null, last: candles?.at?.(-1)?.t ?? null },
    sigma: rv ?? asset.defaultSigma ?? 0.6,
    sigmaSource: rv != null ? "realized_1d_candles" : "default",
    fearGreed: fearGreed ?? null,
    global: global ?? null,
  };
}

// ─── Fetchers ───────────────────────────────────────────────────

export async function fetchQuotes(ids, opts) {
  return parseQuotes(await cmcRequest("/v3/cryptocurrency/quotes/latest", { id: [].concat(ids).join(",") }, opts));
}
export async function fetchFearGreed(opts) {
  return parseFearGreed(await cmcRequest("/v3/fear-and-greed/latest", {}, opts));
}
export async function fetchGlobal(opts) {
  return parseGlobal(await cmcRequest("/v1/global-metrics/quotes/latest", {}, opts));
}
export async function fetchCandles({ platform = "bsc", address, interval = "1d", limit = 30 }, opts) {
  return parseCandles(await cmcRequest("/v1/k-line/candles", { platform, address, interval, limit }, opts));
}

/** Fetch everything the model needs for one asset. Partial failures are recorded, not fatal. */
export async function fetchSnapshot(symbol, opts = {}) {
  const asset = ASSETS[symbol];
  if (!asset) throw new Error(`Unknown asset ${symbol}`);
  const calls = [];
  opts = { ...opts, calls };
  const errors = [];
  const safe = (p, label) => p.catch((e) => { errors.push(`${label}: ${e.message}`); return null; });
  const quotes = asset.cmcId != null ? await safe(fetchQuotes(asset.cmcId, opts), "quotes") : null;
  const address = asset.candleAddress ?? quotes?.[asset.cmcId]?.tokenAddress;
  const candles = address ? await safe(fetchCandles({ platform: asset.platform ?? "bsc", address }, opts), "candles") : null;
  const fearGreed = await safe(fetchFearGreed(opts), "fear_greed");
  const global = await safe(fetchGlobal(opts), "global");
  return { ...buildSnapshot({ symbol, asset, quotes, candles, fearGreed, global }), errors, cmcMode: cmcConfig(opts.env).mode, cmcCalls: calls };
}
