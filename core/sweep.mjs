// Usage-managed sweeps: how many tasks may run in parallel on a provider right now without blowing its windows.
// Probe first (one cheap task per provider/model), measure what a task costs in % of each window (the scorecard
// records the delta), then size each batch from the headroom that remains under a buffer. Re-plan after every batch.
import { getLimits } from './limits.mjs';
import { providerWindows } from './scorecard.mjs';

/**
 * Parallelism for one provider (and, where windows are per model group, one model).
 * @param {object} o
 * @param {number} o.costPct       measured % of the tightest window one task consumes (0 = unknown)
 * @param {number} o.usedPct       % of that window used now
 * @param {number} [o.bufferPct]   % of the window to leave untouched (default 25)
 * @param {number} [o.maxParallel] hard cap per provider (default 4)
 * @param {number} [o.remaining]   tasks still to run
 * @param {boolean} [o.unlimited]  local provider: no window at all
 * @returns {{ n: number, reason: string }} n = 0 means wait for the window to reset
 */
export function planBatch({ costPct, usedPct, bufferPct = 25, maxParallel = 4, remaining = Infinity, unlimited = false }) {
  if (unlimited) return { n: Math.min(maxParallel, remaining), reason: 'no window (local)' };
  const headroom = 100 - bufferPct - (usedPct || 0);
  if (headroom <= 0) return { n: 0, reason: `window at ${usedPct}%: wait for reset` };
  if (!costPct || costPct <= 0) return { n: Math.min(1, remaining), reason: 'cost unknown: one at a time until measured' };
  const fits = Math.floor(headroom / costPct);
  if (fits < 1) return { n: 0, reason: `one task (~${costPct}%) would cross the ${100 - bufferPct}% line` };
  return { n: Math.max(0, Math.min(maxParallel, fits, remaining)), reason: `${headroom.toFixed(1)}% headroom / ${costPct}% per task` };
}

/** Per-task cost on a provider from recorded scorecard rows: the largest window delta any probe run consumed (conservative). */
export function measuredCost(rows, provider, { model = null } = {}) {
  let cost = 0;
  for (const r of rows) {
    if (r.provider !== provider || !r.pct) continue;
    if (model && r.model !== model) continue;
    for (const [id, d] of Object.entries(r.pct)) {
      const w = (getLimits().providers[provider]?.windows || []).find((x) => x.id === id);
      if (w?.models && r.model && !new RegExp(w.models, 'i').test(r.model)) continue;
      const per = d / ((r.concurrent || 0) + 1); // the window moved for every task running at the time, not just this one
      if (per > cost) cost = per;
    }
  }
  return cost;
}

/** Busiest window that applies to this provider/model right now (0 when it reports none). */
export function usedNow(provider, model = null) {
  return Math.max(0, ...providerWindows(provider, model).map((w) => Number(w.usedPercent) || 0));
}

/** Plan the next batch for a provider from live limits + recorded costs. */
export function nextBatch({ provider, model = null, rows, remaining, bufferPct, maxParallel, unlimited = false }) {
  return planBatch({ costPct: measuredCost(rows, provider, { model }), usedPct: usedNow(provider, model), bufferPct, maxParallel, remaining, unlimited });
}

/**
 * Cost multiplier of an effort level relative to the probe effort for a model, from what the scorecard already
 * measured: average tokens per task at each effort (any category, smoke or live), because provider windows are
 * billed by tokens and a probe at `low` tells us nothing about `ultra` on its own. Falls back to a conservative
 * ladder when the model has no rows at that effort. Deterministic; no model in the loop.
 */
const FALLBACK_LADDER = { low: 1, medium: 1.5, high: 2, xhigh: 3, max: 4, ultra: 6 };
export function effortMultiplier(summary, provider, model, effort, probeEffort = 'low') {
  const tok = (e) => { const rows = summary.filter((g) => g.steps === 1 && g.sel === `${provider}:${model}:${e || 'default'}` && g.avgTokens > 0); if (!rows.length) return null; return rows.reduce((s, g) => s + g.avgTokens * g.n, 0) / rows.reduce((s, g) => s + g.n, 0); };
  const a = tok(probeEffort), b = tok(effort);
  if (a && b) return Math.max(1, b / a);
  return Math.max(1, (FALLBACK_LADDER[effort] || 2) / (FALLBACK_LADDER[probeEffort] || 1));
}

/**
 * Greedy batch over heterogeneous costs: sort ascending, take tasks while their summed cost stays under the headroom.
 * Returns how many of the sorted tasks to run now and the order (indices into the input). Zero when even the
 * cheapest does not fit. A task with unknown cost (0) runs alone so it gets measured.
 */
export function planGreedy(costs, { usedPct, bufferPct = 25, maxParallel = Infinity, unlimited = false }) {
  const order = costs.map((c, i) => ({ c: c || 0, i })).sort((a, b) => a.c - b.c);
  const idx = order.map((o) => o.i);
  if (unlimited) return { n: Math.min(maxParallel, order.length), order: idx, reason: 'no window (local)' };
  const headroom = 100 - bufferPct - (usedPct || 0);
  if (headroom <= 0) return { n: 0, order: idx, reason: `window at ${usedPct}%: wait for reset` };
  let sum = 0, n = 0;
  for (const o of order) {
    if (o.c <= 0) { if (!n) n = 1; break; }            // unknown cost: run it alone, measure, re-plan
    if (sum + o.c > headroom) break;
    sum += o.c; n++;
    if (n >= maxParallel) break;
  }
  return { n, order: idx, reason: n ? `${headroom.toFixed(1)}% headroom, ${n} task(s) summing to ~${sum.toFixed(1)}%` : `cheapest task (~${order[0]?.c.toFixed(1)}%) would cross the ${100 - bufferPct}% line` };
}

/**
 * When a provider has no headroom, when does it get some back? The earliest reset among the windows that apply
 * to the model and are the ones holding it (used above the line). ms timestamp, or null when the provider reports
 * no reset times (then the caller must poll). Sleep until this instead of polling: the limits registry already knows.
 */
export function nextReset(provider, model = null, { bufferPct = 25, sessionOnly = false } = {}) {
  const ws = providerWindows(provider, model).filter((w) => !sessionOnly || /hour|session/i.test(w.label || '') || (w.windowMinutes && w.windowMinutes <= 600));
  const binding = ws.filter((w) => (Number(w.usedPercent) || 0) >= 100 - bufferPct && w.resetsAt);
  if (!binding.length) return null;
  return Math.min(...binding.map((w) => Number(w.resetsAt)));
}

// --- Per-window targets (2026-09-12): a session window (5-hour and the like) is used up to 95%, everything else
// (weekly, monthly, a budget) up to 100%. The gate applies to every subscription; a provider with only a weekly
// window (Codex) is simply planned against 100% of it.
const isSession = (w) => /hour|session/i.test(w.label || '') || (w.windowMinutes && w.windowMinutes <= 600);
export const targetFor = (w) => (isSession(w) ? 95 : 100);

/** Headroom under the per-window targets: the tightest window decides. */
export function headroomFor(windows) {
  let headroom = Infinity, binding = null;
  for (const w of windows || []) { const h = targetFor(w) - (Number(w.usedPercent) || 0); if (h < headroom) { headroom = h; binding = w; } }
  return { headroom: headroom === Infinity ? 100 : headroom, binding };
}

/** planGreedy against live windows instead of a flat buffer. */
export function planGreedyWindows(costs, windows, { maxParallel = Infinity, unlimited = false } = {}) {
  const { headroom, binding } = headroomFor(windows);
  const r = planGreedy(costs, { usedPct: 100 - headroom - 0, bufferPct: 0, maxParallel, unlimited });
  if (binding && !r.n) r.reason = `${binding.label || binding.id} at ${binding.usedPercent}% of a ${targetFor(binding)}% target`;
  return r;
}

/** Earliest reset among windows at or over their target. */
export function nextResetWindows(windows) {
  const full = (windows || []).filter((w) => (Number(w.usedPercent) || 0) >= targetFor(w) - 0.01 && w.resetsAt);
  return full.length ? Math.min(...full.map((w) => Number(w.resetsAt))) : null;
}
