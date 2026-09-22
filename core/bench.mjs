// Benchmark hygiene: which selections have no battery yet (new models, new subscriptions) or a stale one,
// and a runner that probes each (one cheap task, short timeout) before spending a full battery on it.
import { getModels } from './models.mjs';
import { rootRuns } from './scorecard.mjs';
import { loadConfig } from './config.mjs';
import { runSmoke } from './smoke/index.mjs';
import { logImprovement } from './improve.mjs';

const selId = (s) => `${s.provider}:${s.model}:${s.effort || 'default'}`;

/** Selections due for a battery: every agent model of an available provider at its cheapest effort, unless a rated battery newer than `days` exists. */
export function dueForBench({ days = loadConfig().scorecard.rebenchDays, reg = getModels() } = {}) {
  const newest = new Map();
  for (const c of rootRuns({ source: 'smoke' })) for (const a of c.attempts) { if (!a.verdict) continue; const k = selId(a); if (!newest.has(k) || newest.get(k) < a.ts) newest.set(k, a.ts); }
  const cutoff = Date.now() - days * 86_400_000;
  const due = [];
  for (const m of reg.models) {
    if (m.kind !== 'agent' || reg.providers[m.provider]?.status !== 'ok' || /embed/i.test(m.id)) continue;
    const sel = { provider: m.provider, model: m.id, effort: m.efforts?.includes('low') ? 'low' : null };
    const seen = newest.get(selId(sel));
    if (!seen) due.push({ ...sel, why: 'never benchmarked' });
    else if (Date.parse(seen) < cutoff) due.push({ ...sel, why: `last battery ${seen.slice(0, 10)}` });
  }
  return due;
}

/** Probe each due selection with one cheap task; run the full battery only where the probe passes. */
export async function runBench({ days, onResult = null } = {}) {
  const due = dueForBench({ days });
  const results = [];
  for (const sel of due) {
    const probe = await runSmoke({ models: [sel], tasks: ['read-1'], timeoutMinutes: 3, onResult });
    const ok = probe.length && probe[0].verdict === 'pass';
    results.push({ ...sel, probe: probe[0]?.verdict || 'none', notes: probe[0]?.notes || '' });
    if (!ok) continue;
    const battery = await runSmoke({ models: [sel], onResult });
    results[results.length - 1].battery = `${battery.filter((r) => r.verdict === 'pass').length}/${battery.length}`;
  }
  return results;
}

/** Called after a registry refresh: note newly listed models so the periodic review (or the user) benches them. */
export function noteNewModels(before, after) {
  const had = new Set((before?.models || []).map((m) => `${m.provider}:${m.id}`));
  const fresh = (after?.models || []).filter((m) => m.kind === 'agent' && !had.has(`${m.provider}:${m.id}`));
  if (fresh.length && had.size) logImprovement('idea', 'models', `new models listed: ${fresh.map((m) => `${m.provider}:${m.id}`).join(', ')} — run \`conductor bench --run\` (or smoke_test) before the scorecard can route to them`);
  return fresh;
}

export function formatBench(due) {
  if (!due.length) return 'Every listed model has a recent battery.';
  return [`${due.length} selection(s) due for a battery:`, ...due.map((d) => `- ${selId(d)} — ${d.why}`)].join('\n');
}
