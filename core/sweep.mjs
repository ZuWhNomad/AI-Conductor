// The framework budget gate: may one more task start on a provider right now without blowing its windows?
// A task's cost is measured per window (the scorecard records each run's % delta) and charged against that window's
// own target. Used by `core/tasks.mjs schedule()` for ALL tasks.
import { getLimits, isSession, windowModels } from './limits.mjs';
export { isSession };
import { loadConfig } from './config.mjs';

/**
 * Per-task cost measured SEPARATELY for each window id: `{ windowId: %-per-task }`. Each value is the plain
 * average of the last 30 matching ledger rows (ledger order; a window seen with a zero delta still counts).
 * A build that moves a 5-hour window 13% but the weekly only 3% must be charged 13% against the 5-hour and 3%
 * against the weekly — not 13% against both (that wrongly parks a task the weekly has ample room for). The
 * scheduler compares each window's own cost to its own headroom.
 */
export function measuredCostByWindow(rows, provider, { model = null } = {}) {
  const samples = {};
  const windows = getLimits().providers[provider]?.windows || []; // once: getLimits() stats the file on every call
  const matches = new Map();
  for (const w of windows) {
    const models = windowModels(w); // `models` regex, or the Fable label when the regex was never stored
    if (!models) continue;
    try { const re = new RegExp(models, 'i'); matches.set(w.id, (model) => re.test(model)); }
    catch { matches.set(w.id, (model) => String(model).toLowerCase().includes(String(models).toLowerCase())); }
  }
  for (const r of rows) {
    if (r.provider !== provider || !r.pct) continue;
    if (model && r.model !== model) continue;
    for (const [id, d] of Object.entries(r.pct)) {
      if (r.model && matches.has(id) && !matches.get(id)(r.model)) continue;
      const per = d / ((r.concurrentByWindow?.[id] ?? r.concurrent ?? 0) + 1); // legacy rows have only the scalar
      // OB2: always record the window (even zero delta) so isUnmeasured knows it has been observed.
      (samples[id] ??= []).push(per);
    }
  }
  const cost = {};
  for (const [id, vals] of Object.entries(samples)) {
    const last = vals.slice(-30); // most recent 30 matching per-task values
    let sum = 0;
    for (const v of last) sum += v;
    cost[id] = sum / last.length;
  }
  return cost;
}

// --- Per-window targets (2026-09-12): a session window (5-hour and the like) is used up to 95%, everything else
// (weekly, monthly, a budget) up to 100%. The gate applies to every subscription; a provider with only a weekly
// window (Codex) is simply planned against 100% of it.
export const targetFor = (w, targets = loadConfig().scorecard.windowTargets) => isSession(w) ? targets.session : targets.other;
export const isBudgetWindow = (w) => w.rate !== true && w.usedPercent != null;

/**
 * Scheduler admission: how many of `pending` (each `{ costs: { windowId: % } }`) may start on a provider right now,
 * given `runningByWindow` (summed measured cost of its in-flight tasks, per window id) and the per-window targets.
 * Greedy-fills cheapest first; a task must fit in EVERY window it touches, each charged its own cost against its own
 * headroom. Returns `{ n }`. Deterministic.
 */
export function admit(windows, pending, { runningByWindow = null, maxParallel = Infinity, windowTargets = loadConfig().scorecard.windowTargets } = {}) {
  const wins = (windows || []).filter(isBudgetWindow);
  if (!wins.length) return { n: Math.min(pending.length, maxParallel) };
  const target = (w) => targetFor(w, windowTargets);
  const head = new Map(wins.map((w) => [w.id, target(w) - (Number(w.usedPercent) || 0) - (runningByWindow?.[w.id] || 0)]));
  if ([...head.values()].some((h) => h <= 0)) return { n: 0 };
  const maxOf = (p) => Math.max(0, ...wins.map((w) => p.costs?.[w.id] || 0));
  const ranked = [...pending].sort((a, c) => maxOf(a) - maxOf(c)); // cheapest first; equal costs keep call order
  const sum = new Map(wins.map((w) => [w.id, 0]));
  let n = 0;
  for (const p of ranked) {
    const costs = p.costs || {};
    if (wins.every((w) => !(costs[w.id] > 0))) { if (!n) n = 1; break; } // unknown cost: one probe alone, then measure
    if (wins.some((w) => sum.get(w.id) + (costs[w.id] || 0) > head.get(w.id))) break;
    for (const w of wins) sum.set(w.id, sum.get(w.id) + (costs[w.id] || 0));
    n++;
    if (n >= maxParallel) break;
  }
  return { n };
}
