// The framework budget gate: may one more task start on a provider right now without blowing its windows?
// A task's cost is measured per window (the scorecard records each run's % delta) and charged against that window's
// own target. Used by `core/tasks.mjs schedule()` for ALL tasks.
import { getLimits } from './limits.mjs';
import { loadConfig } from './config.mjs';

/**
 * Per-task cost measured SEPARATELY for each window id: `{ windowId: %-per-task }`. A build that moves a 5-hour
 * window 13% but the weekly only 3% must be charged 13% against the 5-hour and 3% against the weekly — not 13%
 * against both (that wrongly parks a task the weekly has ample room for). The scheduler compares each window's own
 * cost to its own headroom.
 */
export function measuredCostByWindow(rows, provider, { model = null } = {}) {
  const cost = {};
  const windows = getLimits().providers[provider]?.windows || []; // once: getLimits() stats the file on every call
  for (const r of rows) {
    if (r.provider !== provider || !r.pct) continue;
    if (model && r.model !== model) continue;
    for (const [id, d] of Object.entries(r.pct)) {
      const w = windows.find((x) => x.id === id);
      if (w?.models && r.model) {
        try { if (!new RegExp(w.models, 'i').test(r.model)) continue; }
        catch { if (!String(r.model).toLowerCase().includes(String(w.models).toLowerCase())) continue; }
      }
      const per = d / ((r.concurrentByWindow?.[id] ?? r.concurrent ?? 0) + 1); // legacy rows have only the scalar
      // OB2: always record the window (even zero delta) so isUnmeasured knows it has been observed.
      cost[id] = Math.max(cost[id] ?? 0, per);
    }
  }
  return cost;
}

// --- Per-window targets (2026-09-12): a session window (5-hour and the like) is used up to 95%, everything else
// (weekly, monthly, a budget) up to 100%. The gate applies to every subscription; a provider with only a weekly
// window (Codex) is simply planned against 100% of it.
export const isSession = (w) => /hour|session/i.test(w.label || '') || (w.windowMinutes && w.windowMinutes <= 600);
export const targetFor = (w) => { const t = loadConfig().scorecard.windowTargets; return isSession(w) ? t.session : t.other; };

/** Earliest reset among windows at or over their target. */
export function nextResetWindows(windows) {
  const full = (windows || []).filter((w) => (Number(w.usedPercent) || 0) >= targetFor(w) - 0.01 && w.resetsAt);
  return full.length ? Math.min(...full.map((w) => Number(w.resetsAt))) : null;
}

/**
 * Scheduler admission: how many of `pending` (each `{ costs: { windowId: % } }`) may start on a provider right now,
 * given `runningByWindow` (summed measured cost of its in-flight tasks, per window id) and the per-window targets.
 * Greedy-fills cheapest first; a task must fit in EVERY window it touches, each charged its own cost against its own
 * headroom. Also returns `until` (reset ms) when nothing fits. Deterministic.
 */
export function admit(windows, pending, { runningByWindow = null, maxParallel = Infinity } = {}) {
  const wins = windows || [];
  const head = new Map(wins.map((w) => [w.id, targetFor(w) - (Number(w.usedPercent) || 0) - (runningByWindow?.[w.id] || 0)]));
  if (wins.length && [...head.values()].some((h) => h <= 0)) {
    const b = [...wins].sort((a, c) => (targetFor(a) - (a.usedPercent || 0)) - (targetFor(c) - (c.usedPercent || 0)))[0];
    return { n: 0, order: pending.map((_, i) => i), until: nextResetWindows(wins), reason: `no headroom (${b?.label || b?.id} at ${b?.usedPercent}% of ${targetFor(b)}%)` };
  }
  const maxOf = (p) => Math.max(0, ...Object.values(p.costs || {}));
  const order = pending.map((p, i) => ({ p, i })).sort((a, c) => maxOf(a.p) - maxOf(c.p));
  const sum = new Map(wins.map((w) => [w.id, 0]));
  let n = 0;
  for (const { p } of order) {
    const costs = p.costs || {};
    if (!Object.keys(costs).length || Object.values(costs).every((c) => c <= 0)) { if (!n) n = 1; break; } // unknown cost: one probe alone, then measure
    if (wins.some((w) => sum.get(w.id) + (costs[w.id] || 0) > head.get(w.id))) break;
    for (const w of wins) sum.set(w.id, sum.get(w.id) + (costs[w.id] || 0));
    n++;
    if (n >= maxParallel) break;
  }
  return { n, order: order.map((o) => o.i), until: n ? null : nextResetWindows(wins), reason: n ? `fits in all ${wins.length} window(s)` : 'does not fit a window under its target' };
}
