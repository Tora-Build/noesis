// Decision engine. Pure. Inputs are probabilities in [0,1].

export const DEFAULTS = {
  edgeThreshold: 0.05, // minimum |p* - p_s| to trade
  riskCap: 75, // no trade at or above this risk score
  cournotWeight: 0.6, // weight of Cournot in the blend when present
  kellyMultiplier: 0.5, // half Kelly
  maxFraction: 0.1, // hard cap on bankroll fraction per trade
  bankroll: 100, // collateral units (USD)
  gapAlert: 0.15, // |p_c - p_s| that raises an alert
  highRisk: 70,
  staleSec: 900, // feed older than this raises FEED_STALE
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Blend Cournot and model. Cournot-weighted when present. */
export function blend(pCournot, pModel, w = DEFAULTS.cournotWeight) {
  if (pCournot == null && pModel == null) return null;
  if (pCournot == null) return pModel;
  if (pModel == null) return pCournot;
  return w * pCournot + (1 - w) * pModel;
}

/** Kelly fraction for buying a binary claim priced `price` that pays 1 with probability `q`. */
export function kelly(q, price) {
  if (price <= 0 || price >= 1) return 0;
  return Math.max(0, (q - price) / (1 - price));
}

/**
 * @param {object} i
 * @param {number} i.pSooth   Sooth AMM YES price
 * @param {number|null} i.pCournot
 * @param {number|null} i.pModel
 * @param {number} i.risk     0-100
 * @param {number|null} [i.feedAgeSec]
 * @param {boolean} [i.tradingOpen]
 * @param {object} [opts]
 */
export function decide({ pSooth, pCournot = null, pModel = null, risk = 0, feedAgeSec = null, tradingOpen = true }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const alerts = [];
  const pStar = blend(pCournot, pModel, o.cournotWeight);

  if (pCournot != null && pSooth != null && Math.abs(pCournot - pSooth) > o.gapAlert) {
    alerts.push({ code: "COURNOT_SOOTH_GAP", level: "warn", message: `Cournot ${pct(pCournot)} vs Sooth ${pct(pSooth)}: gap ${pct(Math.abs(pCournot - pSooth))}.` });
  }
  if (risk >= o.highRisk) alerts.push({ code: "HIGH_RISK", level: "warn", message: `Risk score ${risk} is at or above ${o.highRisk}.` });
  if (feedAgeSec != null && feedAgeSec > o.staleSec) {
    alerts.push({ code: "FEED_STALE", level: "warn", message: `Price feed is ${Math.round(feedAgeSec)} s old (limit ${o.staleSec} s).` });
  }

  const base = { pSooth, pCournot, pModel, pStar, risk, alerts, params: o };
  if (pSooth == null || pStar == null) return { ...base, action: "HOLD", edge: null, fraction: 0, sizeUsd: 0, reason: "Missing price or probability." };
  const edge = pStar - pSooth;
  base.edge = edge;
  if (!tradingOpen) return { ...base, action: "HOLD", fraction: 0, sizeUsd: 0, reason: "Trading is closed." };
  if (alerts.some((a) => a.code === "FEED_STALE")) return { ...base, action: "HOLD", fraction: 0, sizeUsd: 0, reason: "Feed is stale." };
  if (risk >= o.riskCap) return { ...base, action: "HOLD", fraction: 0, sizeUsd: 0, reason: `Risk ${risk} is at or above the cap ${o.riskCap}.` };
  if (Math.abs(edge) <= o.edgeThreshold) return { ...base, action: "HOLD", fraction: 0, sizeUsd: 0, reason: `Edge ${pct(edge)} is inside the threshold ${pct(o.edgeThreshold)}.` };

  const buyYes = edge > 0;
  const price = buyYes ? pSooth : 1 - pSooth;
  const q = buyYes ? pStar : 1 - pStar;
  const f = kelly(q, price);
  const fraction = clamp(o.kellyMultiplier * f * (1 - risk / 100), 0, o.maxFraction);
  const sizeUsd = round2(o.bankroll * fraction);
  return {
    ...base,
    action: buyYes ? "BUY_YES" : "BUY_NO",
    outcome: buyYes ? 1 : 0,
    kelly: f,
    fraction,
    sizeUsd,
    entryPrice: price,
    reason: `Fair ${pct(pStar)} vs Sooth ${pct(pSooth)}: edge ${pct(edge)}, risk ${risk}.`,
  };
}

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
function round2(x) { return Math.round(x * 100) / 100; }
