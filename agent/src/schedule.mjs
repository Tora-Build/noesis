// Bot timing, daily spend cap and the state file. Timing and cap logic are pure.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseHHMM } from "./ladder.mjs";

/** UTC day "YYYY-MM-DD" for a time in ms. */
export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Which jobs are due now?
 * @param {number} nowMs
 * @param {{settleAt?:number, agentAt?:number, createDay?:string, createRetryAt?:number}} last  last run times (ms) and the last create day
 * @param {{settleSec:number, agentSec:number, createAt:string}} cfg
 * @returns {string[]} in run order: settle, create, agent
 */
export function dueJobs(nowMs, last, cfg) {
  const due = [];
  if (!last.settleAt || nowMs - last.settleAt >= cfg.settleSec * 1000) due.push("settle");
  const { h, m } = parseHHMM(cfg.createAt);
  const today = new Date(nowMs);
  today.setUTCHours(h, m, 0, 0);
  const createDue = nowMs >= today.getTime() && last.createDay !== dayKey(nowMs) && !(last.createRetryAt > nowMs);
  if (createDue) due.push("create");
  if (!last.agentAt || nowMs - last.agentAt >= cfg.agentSec * 1000) due.push("agent");
  return due;
}

/** Should the page be published now? At most once per `minSec` after trades; at once after new markets. */
export function publishDue(nowMs, { due, force = false, lastAt = 0 }, minSec = 3600) {
  if (force) return true;
  return !!due && nowMs - lastAt >= minSec * 1000;
}

/** Spend so far on a UTC day. */
export const spentOn = (state, day) => Number(state.spend?.[day] ?? 0);

/** What is left under the daily cap. Never negative. */
export const spendLeft = (state, day, cap) => Math.max(0, cap - spentOn(state, day));

/** Record spend and drop days older than a week. Mutates state. */
export function addSpend(state, day, amount) {
  state.spend ??= {};
  state.spend[day] = Math.round((spentOn(state, day) + Number(amount)) * 1e6) / 1e6;
  for (const d of Object.keys(state.spend)) if (d < dayKey(Date.parse(day) - 7 * 86400_000)) delete state.spend[d];
  return state.spend[day];
}

export function emptyState() {
  return { version: 1, scannedTo: null, markets: {}, done: {}, pending: {}, creating: {}, spend: {}, last: {}, publish: { lastAt: 0, due: false } };
}

/** Read the state file. A missing file gives an empty state. A bad file throws (never silently reset). */
export function loadState(file) {
  if (!existsSync(file)) return emptyState();
  const s = JSON.parse(readFileSync(file, "utf8"));
  return { ...emptyState(), ...s };
}

/** Write atomically: a temp file, then rename. */
export function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  renameSync(tmp, file);
}
