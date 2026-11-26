// Fair probability from CMC data, and a 0-100 risk score. All pure.
// Price model: geometric Brownian motion with zero price drift (S is a martingale).

export const KIND = { CLOSE_ABOVE: 0, CLOSE_BELOW: 1, TOUCH_ABOVE: 2, TOUCH_BELOW: 3 };
export const KIND_NAME = ["CLOSE_ABOVE", "CLOSE_BELOW", "TOUCH_ABOVE", "TOUCH_BELOW"];
const YEAR_SEC = 365 * 86400;

/** Complementary error function. Numerical Recipes erfcc, fractional error < 1.2e-7. */
export function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

/** Standard normal CDF. */
export const normCdf = (x) => 0.5 * erfc(-x / Math.SQRT2);

function ds(spot, strike, sigma, T) {
  const v = sigma * Math.sqrt(T);
  const lm = Math.log(spot / strike);
  return { d1: (lm + 0.5 * v * v) / v, d2: (lm - 0.5 * v * v) / v };
}

/** P(S_T >= K) under zero-drift lognormal. */
export function probCloseAbove(spot, strike, sigma, T) {
  if (T <= 0 || sigma <= 0) return spot >= strike ? 1 : 0;
  return normCdf(ds(spot, strike, sigma, T).d2);
}

/**
 * P(max_{t<=T} S_t >= K). Reflection principle for GBM with zero price drift:
 *   P = N(d2) + (S/K) N(d1). This is close to 2 N(d2) for small sigma*sqrt(T). Already crossed -> 1.
 */
export function probTouchAbove(spot, strike, sigma, T) {
  if (spot >= strike) return 1;
  if (T <= 0 || sigma <= 0) return 0;
  const { d1, d2 } = ds(spot, strike, sigma, T);
  return Math.min(1, normCdf(d2) + (spot / strike) * normCdf(d1));
}

/** P(min_{t<=T} S_t <= K) = N(-d2) + (S/K) N(-d1). Already crossed -> 1. */
export function probTouchBelow(spot, strike, sigma, T) {
  if (spot <= strike) return 1;
  if (T <= 0 || sigma <= 0) return 0;
  const { d1, d2 } = ds(spot, strike, sigma, T);
  return Math.min(1, normCdf(-d2) + (spot / strike) * normCdf(-d1));
}

/**
 * Fair YES probability for a PriceFeedAdjudicator market.
 * @param {{kind:number, spot:number, strike:number, sigma:number, now:number, deadline:number, touched?:boolean}} p
 */
export function fairProbability({ kind, spot, strike, sigma, now, deadline, touched = false }) {
  if (!(spot > 0) || !(strike > 0)) throw new Error("spot and strike must be positive");
  const T = Math.max(0, (deadline - now) / YEAR_SEC);
  switch (kind) {
    case KIND.CLOSE_ABOVE: return probCloseAbove(spot, strike, sigma, T);
    case KIND.CLOSE_BELOW: return 1 - probCloseAbove(spot, strike, sigma, T);
    case KIND.TOUCH_ABOVE: return touched ? 1 : probTouchAbove(spot, strike, sigma, T);
    case KIND.TOUCH_BELOW: return touched ? 1 : probTouchBelow(spot, strike, sigma, T);
    default: throw new Error(`unknown kind ${kind}`);
  }
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * Risk score 0-100. Higher means the outcome is less predictable and the agent should bet less.
 *  - vol (40%): annualized sigma, saturates at 100%.
 *  - sentiment (25%): distance of Fear & Greed from neutral 50. Fear counts fully, greed at 70%.
 *  - strike proximity (35%): exp(-z^2/2) with z = |ln(S/K)| / (sigma sqrt(T)). Near the strike, small moves flip the result.
 */
export function riskScore({ sigma, fearGreed, spot, strike, now, deadline }) {
  const vol = clamp01((sigma ?? 0) / 1.0);
  let sentiment = 0;
  if (Number.isFinite(fearGreed)) sentiment = fearGreed < 50 ? (50 - fearGreed) / 50 : 0.7 * (fearGreed - 50) / 50;
  const T = Math.max(0, (deadline - now) / YEAR_SEC);
  const spread = (sigma ?? 0) * Math.sqrt(T);
  let proximity = 0;
  if (spot > 0 && strike > 0) {
    const lm = Math.abs(Math.log(spot / strike));
    proximity = spread > 0 ? Math.exp(-((lm / spread) ** 2) / 2) : lm === 0 ? 1 : 0;
  }
  const components = { vol, sentiment: clamp01(sentiment), proximity };
  const score = Math.round(100 * (0.4 * components.vol + 0.25 * components.sentiment + 0.35 * components.proximity));
  return { score, components };
}
