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
      if (d > cost) cost = d;
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
