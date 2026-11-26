// Ladder math for the creator. All pure.
// Strikes, the next-session deadline, the question text and the idempotency key.

import { parseUnits } from "viem";

/** A clean step near `x`: 1, 2, 2.5 or 5 times a power of ten, nearest on a log scale. */
export function cleanStep(x) {
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).sort((a, b) => Math.abs(Math.log(a / x)) - Math.abs(Math.log(b / x)))[0];
}

/** Strikes below spot, rounded down to `round`, without duplicates, highest first. */
export function ladderStrikes(spot, steps, round) {
  const dp = Math.max(0, -Math.floor(Math.log10(round)) + 1);
  const out = [], dropped = [];
  for (const step of steps) {
    const strike = Number((Math.floor((spot * step) / round + 1e-9) * round).toFixed(dp));
    if (!(strike > 0) || strike >= spot) dropped.push({ step, strike, why: "not below spot" });
    else if (out.includes(strike)) dropped.push({ step, strike, why: "duplicate after rounding" });
    else out.push(strike);
  }
  return { strikes: out.sort((a, b) => b - a), dropped };
}

/** "HH:MM" -> { h, m }. Throws on a bad value. */
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Bad time "${s}". Use HH:MM (UTC).`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
const ymd = (d) => d.toISOString().slice(0, 10);

/**
 * The next weekday at `at` (UTC) that is at least `minLeadSec` after `nowSec`.
 * Saturday, Sunday and any date in `skipDates` (YYYY-MM-DD) are skipped.
 * @returns {number} unix seconds
 */
export function nextWeekdayDeadline(nowSec, { at = "21:00", minLeadSec = 3600, skipDates = [] } = {}) {
  const { h, m } = parseHHMM(at);
  const d = new Date(nowSec * 1000);
  d.setUTCHours(h, m, 0, 0);
  for (let i = 0; i < 30; i++) {
    if (d.getTime() / 1000 >= nowSec + minLeadSec && !isWeekend(d) && !skipDates.includes(ymd(d))) return d.getTime() / 1000;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  throw new Error("No deadline found in 30 days. Check BOT_SKIP_DATES.");
}

/** A strike as a plain decimal string. The same string goes in the question and in strikeWad. */
export function strikeString(strike) {
  const s = String(strike);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Strike ${s} is not a plain decimal`);
  return s;
}

/** Question text and strikeWad from one strike string, so they always agree. */
export function marketText({ symbol, strike, deadline, kind = 1, source = "Atlas Oracle" }) {
  const s = strikeString(strike);
  const day = new Date(deadline * 1000).toISOString().slice(0, 16).replace("T", " ");
  const words = ["above", "below", "touches above", "touches below"][kind];
  const when = kind >= 2 ? "before" : "at";
  return { question: `${symbol} ${words} $${s} ${when} ${day} UTC (${source})`, strikeWad: parseUnits(s, 18) };
}

/** The strike that a question names (same rule as scripts/build-web.mjs). */
export function questionStrike(question) {
  const named = /\$([\d,]+(?:\.\d+)?)/.exec(question)?.[1];
  return named == null ? null : Number(named.replace(/,/g, ""));
}

/** Idempotency key: one market per asset, kind, strike and deadline. */
export const marketKey = ({ asset, kind, strikeWad, deadline }) => `${asset}|${kind}|${BigInt(strikeWad)}|${Number(deadline)}`;

/**
 * Which strikes to create for one asset and deadline.
 * `existing` are the markets already on chain (or in flight) for this asset, kind and deadline.
 * At most `want` markets per asset and deadline in total, and never a strike that exists.
 */
export function planLadder({ spot, steps = [0.99, 0.98, 0.96], round, existing = [], want = steps.length }) {
  round ??= cleanStep(spot * 0.005);
  const { strikes, dropped } = ladderStrikes(spot, steps, round);
  const have = new Set(existing.map((e) => BigInt(e.strikeWad)));
  const left = Math.max(0, want - existing.length);
  const fresh = strikes.filter((s) => !have.has(parseUnits(strikeString(s), 18)));
  return { round, create: fresh.slice(0, left), skipped: dropped, existing: existing.length };
}
