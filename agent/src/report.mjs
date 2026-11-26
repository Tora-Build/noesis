// Pure pipeline: chain state + CMC snapshot + Cournot result -> report with decision.

import { fairProbability, riskScore, KIND, KIND_NAME } from "./model.mjs";
import { decide } from "./decide.mjs";
import { evidenceLines } from "./cournot.mjs";

/** Has a TOUCH market's feed already shown a cross inside the window? */
export function feedTouched(chain) {
  const t = chain.terms;
  if (!t || !chain.feed || (t.kind !== KIND.TOUCH_ABOVE && t.kind !== KIND.TOUCH_BELOW)) return false;
  const crossed = t.kind === KIND.TOUCH_ABOVE ? chain.feed.price >= t.strike : chain.feed.price <= t.strike;
  const inWindow = chain.feed.ts < chain.deadline && (chain.openedAt == null || chain.feed.ts >= chain.openedAt);
  return crossed && inWindow;
}

/** Plain-language title, also used as the Cournot message. */
export function marketTitle(asset, terms, deadline) {
  if (!terms) return `${asset} market`;
  const above = terms.kind === KIND.CLOSE_ABOVE || terms.kind === KIND.TOUCH_ABOVE;
  const touch = terms.kind >= KIND.TOUCH_ABOVE;
  const d = new Date(deadline * 1000).toISOString().slice(0, 16).replace("T", " ");
  const strike = terms.strike.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return touch
    ? `${asset} price ${above ? "above" : "below"} $${strike} before ${d} UTC`
    : `${asset} price ${above ? "at or above" : "at or below"} $${strike} at ${d} UTC`;
}

/**
 * @param {object} a
 * @param {object} a.chain     output of readMarket (or a fixture of the same shape)
 * @param {object} a.snapshot  output of cmc.buildSnapshot / fetchSnapshot
 * @param {object|null} a.cournot output of cournot.probability (or null)
 * @param {string} a.asset
 * @param {object} [a.opts]    decide() options
 */
export function analyze({ chain, snapshot, cournot = null, asset, opts = {} }) {
  const t = chain.terms;
  const spot = chain.feed?.price ?? snapshot.spot;
  const spotSource = chain.feed?.price != null ? "onchain_feed" : "cmc";
  const touched = feedTouched(chain);
  const pModel = t ? fairProbability({ kind: t.kind, spot, strike: t.strike, sigma: snapshot.sigma, now: chain.now, deadline: chain.deadline, touched }) : null;
  const risk = t ? riskScore({ sigma: snapshot.sigma, fearGreed: snapshot.fearGreed?.value, spot, strike: t.strike, now: chain.now, deadline: chain.deadline })
    : { score: 50, components: {} };
  const pCournot = cournot?.state === "complete" ? cournot.probability ?? null : null;
  const decision = decide({
    pSooth: chain.yesPrice, pCournot, pModel, risk: risk.score,
    feedAgeSec: chain.feed?.ageSec ?? null, tradingOpen: chain.tradingOpen,
  }, opts);
  if (cournot?.needsPayment) {
    decision.alerts.push({ code: "COURNOT_PAYMENT_REQUIRED", level: "info", message: "Cournot free calls are used up. No payment was made. The decision uses the CMC model only." });
  } else if (cournot && cournot.state !== "complete" && cournot.state !== "skipped") {
    decision.alerts.push({ code: "COURNOT_UNAVAILABLE", level: "info", message: `Cournot state: ${cournot.state}. The decision uses the CMC model only.` });
  }
  if (snapshot.spot && chain.feed?.price) {
    const diff = Math.abs(snapshot.spot - chain.feed.price) / chain.feed.price;
    if (diff > 0.02) decision.alerts.push({ code: "FEED_CMC_DIVERGENCE", level: "warn", message: `On-chain feed and CMC spot differ by ${(diff * 100).toFixed(1)}%.` });
  }
  return {
    title: marketTitle(asset, t, chain.deadline),
    asset,
    market: chain.market,
    chainId: chain.chainId ?? null,
    generatedAt: new Date(chain.now * 1000).toISOString(),
    // On-chain proof: the block every chain value was read at, so anyone can re-read it.
    proof: {
      chainId: chain.chainId ?? null, block: chain.block ?? null, blockHash: chain.blockHash ?? null, blockTimestamp: chain.now,
      amm: chain.amm ?? null, ammState: { qYes: chain.qYes ?? null, qNo: chain.qNo ?? null, priceWad: chain.priceWad ?? null },
      adjudicator: chain.adjudicator ?? null, feed: chain.feed ? { priceWad: chain.feed.priceWad ?? null, ts: chain.feed.ts } : null,
    },
    inputs: {
      sooth: { yesPrice: chain.yesPrice, qYes: chain.qYes, qNo: chain.qNo, priceWad: chain.priceWad ?? null, tradingOpen: chain.tradingOpen, amm: chain.amm, phase: chain.phase ?? null },
      terms: t ? { ...t, kindName: KIND_NAME[t.kind] } : null,
      deadline: chain.deadline,
      deadlineIso: new Date(chain.deadline * 1000).toISOString(),
      feed: chain.feed ?? null,
      spot, spotSource, touched,
      cmc: {
        mode: snapshot.cmcMode ?? null, calls: snapshot.cmcCalls ?? [],
        spot: snapshot.spot, sigma: snapshot.sigma, sigmaSource: snapshot.sigmaSource,
        pct24h: snapshot.quote?.pct24h ?? null, pct7d: snapshot.quote?.pct7d ?? null, pct30d: snapshot.quote?.pct30d ?? null,
        fearGreed: snapshot.fearGreed, global: snapshot.global, candles: snapshot.candles, errors: snapshot.errors ?? [],
      },
      model: { pModel, risk },
      cournot: cournot && {
        state: cournot.state, marketId: cournot.marketId ?? null, probability: pCournot, result: cournot.result ?? null,
        inverted: cournot.inverted ?? false, sourceProbability: cournot.sourceProbability ?? null,
        cached: cournot.cached ?? false, needsPayment: !!cournot.needsPayment, fetchedAt: cournot.fetchedAt ?? null,
        billing: cournot.billing ?? null, freeQuota: cournot.freeQuota ?? null,
      },
    },
    evidence: { cournotBasis: cournot?.basis ?? null, lines: evidenceLines(cournot?.basis) },
    decision,
  };
}
