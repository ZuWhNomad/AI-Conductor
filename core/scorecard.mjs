// Scorecard: what each model actually cost (tokens -> shadow dollars at API list price, plus the % of
// its provider window) and how well it did (the conductor's verdict) per task category and
// difficulty. Append-only ndjson. `recommend` turns the data into a *plan*: one model, or a ladder
// (cheap model first, stronger model on fail), chosen by utility = value-of-quality - expected cost.
import { appendNdjson, readNdjson, statePath, nowIso } from './paths.mjs';
import { getLimits, blockedUntil } from './limits.mjs';
import { findModel, getModels } from './models.mjs';
import { loadConfig } from './config.mjs';
import { bus } from './bus.mjs';
import { priceFor, priorFor, usdFor, TIER_CEILING, KIND } from './priors.mjs';
import { PROVIDERS } from './providers/index.mjs';

const FILE = () => statePath('scorecard.ndjson');
export const CATEGORIES = ['read', 'search', 'summarize', 'edit', 'implement', 'test', 'refactor', 'debug', 'docs', 'review', 'design', 'modeling', 'other'];
export const VERDICTS = ['pass', 'fixable', 'fail'];
const SCORE = { pass: 1, fixable: 0.5, fail: 0 };
const LEVELS = [1, 2, 3, 4, 5];
export const selOf = (r) => `${r.provider}:${r.model || 'default'}:${r.effort || 'default'}`;

/** Snapshot of a provider's limit windows, taken before a run for the after-run delta. */
export function snapshotWindows(provider) {
  return (getLimits().providers[provider]?.windows || []).map((w) => ({ id: w.id, usedPercent: w.usedPercent ?? null, resetsAt: w.resetsAt ?? null }));
}

/** Per-window % consumed between two snapshots; null when unknown or when a window rolled over. */
export function windowDelta(before, after) {
  if (!before?.length || !after?.length) return null;
  const out = {};
  for (const a of after) {
    const b = before.find((x) => x.id === a.id);
    if (!b || a.usedPercent == null || b.usedPercent == null) continue;
    if (a.resetsAt && b.resetsAt && a.resetsAt !== b.resetsAt) continue;
    out[a.id] = Math.max(0, a.usedPercent - b.usedPercent);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Normalize every worker runtime's usage shape to {in, out, cached, v: 2} where `in` is UNCACHED input.
 * Codex / chat-completions report input_tokens inclusive of cached tokens; the Claude SDK's modelUsage
 * reports inputTokens exclusive of cache reads.
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const own = ['input_tokens', 'inputTokens', 'output_tokens', 'outputTokens'].some((k) => k in u);
  const entries = own ? [u] : Object.values(u).filter((v) => v && typeof v === 'object');
  if (!entries.length) return null;
  const t = { in: 0, out: 0, cached: 0, v: 2 };
  for (const e of entries) {
    const cached = Number(e.cached_input_tokens ?? e.cache_read_input_tokens ?? e.cacheReadInputTokens) || 0;
    const input = Number(e.input_tokens ?? e.inputTokens) || 0;
    t.in += 'inputTokens' in e || e.exclusive ? input : Math.max(0, input - cached); // exclusive: input already excludes cache reads
    t.out += Number(e.output_tokens ?? e.outputTokens) || 0;
    t.cached += cached;
  }
  return t;
}
// Rows written before v2 stored inclusive input for non-Claude providers.
const tokensOf = (r) => (!r.tokens ? null : r.tokens.v ? r.tokens : { ...r.tokens, in: r.provider === 'claude' ? r.tokens.in : Math.max(0, (r.tokens.in || 0) - (r.tokens.cached || 0)) });

/** Record one terminal worker run. tasks.mjs calls this after refreshing the provider's limits. */
export function recordRun(t, { before = null, concurrent = 0 } = {}) {
  if (t.imageOptions) return null;
  const row = {
    op: 'run', ts: nowIso(), taskId: t.id, followUpOf: t.followUpOf || null, retryOf: t.retryOf || null, sessionId: t.sessionId || null, source: t.source || 'live',
    provider: t.provider, model: t.model || null, effort: t.effort || null, category: t.category || null, difficulty: t.difficulty || null,
    status: t.status, tokens: normalizeUsage(t.result?.usage), costUsd: t.result?.costUsd || 0, durationMs: t.result?.durationMs || 0, variant: t.variant || null,
    pct: windowDelta(before, snapshotWindows(t.provider)), concurrent, title: t.title,
  };
  appendNdjson(FILE(), row);
  bus.publish('score', { taskId: t.id, provider: t.provider, model: t.model, pct: row.pct });
  return row;
}

/** The conductor's verdict. Any task id in a fix-round chain rates that attempt. */
export function rateTask(taskId, verdict, notes = '') {
  if (!VERDICTS.includes(verdict)) throw Object.assign(new Error(`verdict must be one of ${VERDICTS.join('|')}`), { status: 400 });
  const row = { op: 'rate', ts: nowIso(), taskId: String(taskId), verdict, notes: String(notes || '').slice(0, 1000) };
  appendNdjson(FILE(), row);
  bus.publish('score', { taskId: row.taskId, verdict });
  return row;
}

/** Exclude a run from every aggregate (harness failure, bad fixture) without rewriting the ledger. */
export function voidTask(taskId, reason = '') {
  const row = { op: 'void', ts: nowIso(), taskId: String(taskId), reason: String(reason || '').slice(0, 400) };
  appendNdjson(FILE(), row);
  return row;
}

const maxPct = (pct) => (pct ? Math.max(...Object.values(pct)) : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const addTok = (a, b) => { if (b) for (const k of ['in', 'out', 'cached']) a[k] += b[k] || 0; };

/**
 * Fold the log into chains. An *attempt* is a task plus its fix rounds (followUpOf); a *chain* is the
 * attempts linked by retryOf (a new model after a fail). Each chain: { taskId, category, difficulty,
 * source, attempts[], path[], verdict (last attempt), tokens, usd, durationMs, rounds }.
 */
export function rootRuns({ source = null } = {}) {
  const runs = new Map(); const rates = new Map(); const voided = new Set();
  const all = readNdjson(FILE());
  for (const r of all) if (r.op === 'void') voided.add(r.taskId);
  const allRuns = new Map(); // voided runs stay in the graph for linking (retryOf through them) but not in the aggregates
  for (const r of all) {
    if (r.op === 'run') { allRuns.set(r.taskId, r); if (!voided.has(r.taskId)) runs.set(r.taskId, r); }
    else if (r.op === 'rate') rates.set(r.taskId, r);
  }
  const follow = (r, key) => { let cur = r; const seen = new Set(); while (cur[key] && runs.has(cur[key]) && !seen.has(cur.taskId)) { seen.add(cur.taskId); cur = runs.get(cur[key]); } return cur; };
  const cfg = loadConfig();
  const attempts = new Map();
  for (const r of runs.values()) {
    const root = follow(r, 'followUpOf');
    let a = attempts.get(root.taskId);
    if (!a) {
      a = { ...root, sel: selOf(root), tokens: { in: 0, out: 0, cached: 0 }, pct: null, usd: null, durationMs: 0, rounds: -1, members: [], verdict: null, notes: null };
      a.price = priceFor(root.provider, root.model, cfg);
      attempts.set(root.taskId, a);
    }
    a.rounds += 1; a.members.push(r.taskId);
    addTok(a.tokens, tokensOf(r));
    a.durationMs += r.durationMs || 0;
    if (r.pct) { a.pct = a.pct || {}; for (const [k, v] of Object.entries(r.pct)) a.pct[k] = (a.pct[k] || 0) + v; }
  }
  for (const a of attempts.values()) {
    const rated = rates.get(a.taskId) || a.members.map((id) => rates.get(id)).find(Boolean);
    a.verdict = rated?.verdict || (a.status === 'failed' ? 'fail' : null);
    a.notes = rated?.notes || null;
    a.usd = usdFor(a.tokens, a.price);
  }
  const chains = new Map();
  const rootIn = (map, id) => { let cur = map.get(id); const seen = new Set(); while (cur && cur.followUpOf && map.has(cur.followUpOf) && !seen.has(cur.taskId)) { seen.add(cur.taskId); cur = map.get(cur.followUpOf); } return cur ? cur.taskId : null; };
  for (const a of attempts.values()) {
    // Walk retryOf to the chain head, passing through voided attempts (they link but do not count); remember every id on the way.
    let head = a; let headId = a.taskId; const seen = new Set(); const ids = [a.taskId];
    while (allRuns.get(headId)?.retryOf && !seen.has(headId)) {
      seen.add(headId); const prevId = rootIn(allRuns, allRuns.get(headId).retryOf); if (!prevId) break;
      ids.push(prevId); headId = prevId; if (attempts.has(prevId)) head = attempts.get(prevId);
    }
    let c = chains.get(headId);
    if (!c) { c = { taskId: headId, ts: head.ts, category: head.category, difficulty: head.difficulty, source: head.source, sessionId: head.sessionId, attempts: [], ids: new Set() }; chains.set(headId, c); }
    for (const id of ids) c.ids.add(id);
    c.attempts.push(a);
  }
  const out = [];
  for (const c of chains.values()) {
    if (source && c.source !== source) continue;
    c.attempts.sort((x, y) => (x.ts < y.ts ? -1 : 1));
    c.attempts.forEach((a, i) => { if (i < c.attempts.length - 1 && !a.verdict) a.verdict = 'fail'; }); // retried => it did not do
    const last = c.attempts[c.attempts.length - 1];
    c.path = c.attempts.map((a) => a.sel);
    // A rating on any id in the chain (including a voided original the conductor was told to rate) settles the last attempt.
    const chainRate = last.verdict ? null : [...c.ids].map((id) => rates.get(id)).find(Boolean);
    if (chainRate) { last.verdict = chainRate.verdict; last.notes = chainRate.notes || null; }
    c.verdict = last.verdict; c.notes = last.notes;
    c.tokens = { in: 0, out: 0, cached: 0 }; c.durationMs = 0; c.rounds = 0; c.pct = null;
    let usd = 0, priced = true;
    for (const a of c.attempts) { addTok(c.tokens, a.tokens); c.durationMs += a.durationMs; c.rounds += a.rounds; if (a.usd == null) priced = false; else usd += a.usd; if (a.pct) { c.pct = c.pct || {}; for (const [k, v] of Object.entries(a.pct)) c.pct[k] = (c.pct[k] || 0) + v; } }
    c.usd = priced ? usd : null;
    c.provider = last.provider; c.model = last.model; c.effort = last.effort; c.status = last.status;
    out.push(c);
  }
  return out;
}

/**
 * Aggregate. Single-step rows (one per model/effort × category/difficulty, counting every attempt)
 * and path rows (ladders actually observed, e.g. "codex:luna:low>codex:terra:medium").
 */
export function summarize({ source = null } = {}) {
  const groups = new Map();
  const add = (sel, steps, cat, diff, x) => {
    const key = [sel, cat, diff].join('|');
    let g = groups.get(key);
    if (!g) { g = { sel, steps, category: cat, difficulty: diff, n: 0, rated: 0, pass: 0, fixable: 0, fail: 0, _tok: [], _usd: [], _pct: [], _dur: [], _rounds: [] }; groups.set(key, g); }
    g.n++;
    if (x.verdict) { g.rated++; g[x.verdict]++; }
    g._tok.push(x.tokens.in + x.tokens.out + x.tokens.cached);
    if (x.usd != null) g._usd.push(x.usd); else g._unpriced = true;
    const p = maxPct(x.pct); if (p != null) g._pct.push(p);
    g._dur.push(x.durationMs); g._rounds.push(x.rounds);
    return g;
  };
  for (const c of rootRuns({ source })) {
    if (!c.category || !c.difficulty) continue;
    for (const a of c.attempts) { const g = add(a.sel, 1, c.category, c.difficulty, a); g.provider = a.provider; g.model = a.model; g.effort = a.effort; }
    if (c.attempts.length > 1) add(c.path.join('>'), c.attempts.length, c.category, c.difficulty, c);
  }
  return [...groups.values()].map(({ _tok, _usd, _pct, _dur, _rounds, _unpriced, ...g }) => {
    const cost = g.steps === 1 ? findModel(g.provider, g.model)?.cost || null : null;
    const prior = g.steps === 1 ? priorFor(g.provider, g.model, g.category) : null;
    const quality = g.rated ? (g.pass * SCORE.pass + g.fixable * SCORE.fixable) / g.rated : null;
    return {
      ...g, cost, priorTier: prior?.tier || null, quality, accept: g.rated ? (g.pass + g.fixable) / g.rated : null,
      avgTokens: mean(_tok), avgUsd: _unpriced ? null : mean(_usd), avgPct: cost === 'free-local' ? 0 : mean(_pct), avgDurationMs: mean(_dur), avgRounds: mean(_rounds),
    };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.difficulty - b.difficulty || a.steps - b.steps || (b.quality ?? -1) - (a.quality ?? -1));
}

/**
 * Best plan for a category at a difficulty: max utility = valueOfQuality × expected quality − expected
 * cost ($ at API list prices + optional $/hour of wall clock). Plans are single models that clear the
 * quality bar, observed ladders, and estimated ladders (cheap first step, qualified fallback; assumes
 * independent failures). Returns null when nothing measured qualifies (then the prior fallback, if enabled).
 */
export function recommend({ category, difficulty = 2, exclude = [], source = null, summary = null, escalate = false, overflowApi = false, _noExtrap = false } = {}) {
  const cfg = loadConfig().scorecard;
  const avail = (provider, model) => providerAvailable(provider, { overflowApi, cfg, model });
  const lambda = cfg.qualityValueUsd, hourly = cfg.hourlyUsd || 0;
  const excluded = (sel) => sel.split('>').some((s) => exclude.includes(s) || exclude.includes(s.split(':').slice(0, 2).join(':')));
  const blockedSel = (sel) => sel.split('>').some((s) => { const [p, m] = s.split(':'); return !avail(p, m === 'default' ? null : m); });
  const all = summary || summarize({ source });
  const rows = all.filter((g) => g.category === category && g.rated > 0 && !excluded(g.sel) && !blockedSel(g.sel));
  // Measured ceiling per provider (any category): the highest level it has cleared with enough samples.
  const ceiling = new Map();
  for (const g of all) if (g.steps === 1 && g.rated >= cfg.minSamples && g.quality >= cfg.quality) ceiling.set(g.provider, Math.max(ceiling.get(g.provider) || 0, g.difficulty));
  const reserve = (provider) => { const w = providerWeight(provider, cfg); const gap = Math.max(0, (ceiling.get(provider) || 0) - difficulty); return 1 + (cfg.reservePct ?? 0) * w * gap; };
  const costOf = (g) => { if (g.avgUsd == null) return null; const [p, m] = g.sel.split('>').pop().split(':'); return (g.avgUsd + hourly * (g.avgDurationMs || 0) / 3.6e6) * providerWeight(p, cfg, m === 'default' ? null : m) * reserve(p); };
  // Evidence per selection: the cell nearest the requested level (not below), pooling harder cells only until
  // the sample floor is met. A well-sampled failing cell at or below the level disqualifies it as a final step.
  const bySel = new Map();
  for (const g of rows) {
    const m = bySel.get(g.sel) || { sel: g.sel, steps: g.steps, cells: [], failedBelow: false };
    if (g.difficulty <= difficulty && g.rated >= cfg.minSamples && g.quality < cfg.quality) m.failedBelow = true;
    if (g.difficulty >= difficulty) m.cells.push(g);
    bySel.set(g.sel, m);
  }
  const evidence = [...bySel.values()].filter((m) => m.cells.length).map((m) => ({ ...m, ref: pool(m.cells.sort((a, b) => a.difficulty - b.difficulty), cfg.minSamples) })).filter((m) => m.ref.rated >= cfg.minSamples);
  const finals = evidence.filter((m) => m.ref.quality >= cfg.quality && !m.failedBelow);
  const plans = [];
  for (const m of finals) plans.push({ steps: m.ref.sel.split('>'), quality: m.ref.quality, usd: costOf(m.ref), estimated: false, ref: m.ref });
  for (const a of evidence.filter((m) => m.steps === 1 && costOf(m.ref) != null)) {
    for (const b of finals.filter((m) => m.steps === 1 && m.sel !== a.sel && costOf(m.ref) != null)) {
      if (bySel.has(`${a.sel}>${b.sel}`) && bySel.get(`${a.sel}>${b.sel}`).cells.length) continue; // observed ladder already a plan
      const pA = a.ref.accept;
      plans.push({ steps: [a.sel, b.sel], quality: a.ref.quality + (1 - pA) * b.ref.quality, usd: costOf(a.ref) + (1 - pA) * costOf(b.ref), estimated: true, ref: a.ref, fallbackRef: b.ref });
    }
  }
  for (const p of plans) p.utility = p.usd == null ? -Infinity : lambda * p.quality - p.usd;
  // Effort dominance: a higher effort of the same model that costs within effortSlackUsd and is at least as good
  // makes the lower effort pointless (Luna's efforts differ by fractions of a cent; the higher one held up on real work).
  const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const slackOf = (usd) => Math.max(cfg.effortSlackUsd ?? 0.01, usd * ((cfg.effortSlackPct ?? 10) / 100)); // absolute floor for cheap models, relative for dear ones
  const dominated = new Set();
  for (const a of plans) for (const b of plans) {
    if (a === b || a.steps.length !== 1 || b.steps.length !== 1 || a.usd == null || b.usd == null) continue;
    const [pa, ma, ea] = a.steps[0].split(':'), [pb, mb, eb] = b.steps[0].split(':');
    if (pa !== pb || ma !== mb || EFFORT.indexOf(eb) <= EFFORT.indexOf(ea)) continue;
    if (b.usd <= a.usd + slackOf(a.usd) && b.quality >= a.quality) dominated.add(a);
  }
  for (const p of plans) if (dominated.has(p) || p.steps.some((st) => dominated.has(plans.find((x) => x.steps.length === 1 && x.steps[0] === st)))) p.utility = -Infinity;
  // escalate (two fails already in this chain): quality first, cost only as a tie-break — no more cheap rungs
  plans.sort(escalate ? (x, y) => (y.quality - x.quality) || (y.utility - x.utility) : (x, y) => y.utility - x.utility || (y.quality - x.quality) || ((x.ref.avgDurationMs ?? 0) - (y.ref.avgDurationMs ?? 0)));
  // Class walk: the first budget class (in configured order) that holds a viable plan wins; value already ordered the plans.
  const classOf = (p) => providerClass(p.steps[0].split(':')[0], cfg);
  let best = null, bestClass = null;
  for (const cls of cfg.classOrder || []) { best = plans.find((p) => p.utility > -Infinity && classOf(p) === cls); if (best) { bestClass = cls; break; } }
  if (!best) best = plans.find((p) => p.utility > -Infinity) || null;
  if (!best) {
    // A provider proven at this level exists but is capped/blocked/excluded: hand the task back (the conductor does it or
    // waits for a reset) rather than extrapolating to a weaker class. Extrapolate only when nothing at all is proven here.
    const provenButCapped = all.some((g) => g.category === category && g.steps === 1 && g.difficulty >= difficulty && g.rated >= cfg.minSamples && g.quality >= cfg.quality && !excluded(g.sel) && blockedSel(g.sel));
    if (provenButCapped) return null;
    // Nothing proven at this level or above: extrapolate from the nearest lower level (flagged) before the prior.
    for (let d = difficulty - 1; d >= 1 && !_noExtrap; d--) {
      const lower = recommend({ category, difficulty: d, exclude, source, summary, escalate, overflowApi, _noExtrap: true });
      if (lower?.plan) return { ...lower, reason: `${lower.reason}; extrapolated from level ${d} — nothing measured at level ${difficulty}+ yet` };
    }
    return priorFallback({ category, difficulty, exclude, cfg, overflowApi });
  }
  const first = best.ref;
  const money = (v) => (v == null ? 'unpriced' : `$${v.toFixed(v < 0.1 ? 3 : 2)}`);
  const describe = (p) => { const prov = p.steps[p.steps.length - 1].split(':')[0]; const rs = reserve(prov); return `${p.steps.join(' then on fail ')}: expected quality ${p.quality.toFixed(2)} at ${money(p.usd)}${p.estimated ? ' (est.)' : ''}${p.ref.cells > 1 ? ` [levels ${p.ref.difficulty}–${p.ref.difficultyMax} pooled]` : ''}${rs > 1 ? ` [reserve ×${rs.toFixed(2)}: ${prov} proven to level ${ceiling.get(prov)}]` : ''}`; };
  const single = plans.find((p) => p.steps.length === 1);
  const alt = plans.slice(1, 4).map(describe);
  return {
    provider: first.provider, model: first.model, effort: first.effort,
    fallback: best.fallbackRef ? { provider: best.fallbackRef.provider, model: best.fallbackRef.model, effort: best.fallbackRef.effort } : best.steps.length > 1 ? parseSel(best.steps[1]) : null,
    plan: { steps: best.steps, quality: best.quality, usd: best.usd, estimated: best.estimated, utility: best.utility },
    class: bestClass,
    reason: `${bestClass ? `class ${bestClass} · ` : ''}${escalate ? 'escalation (two failed attempts): highest measured quality' : 'best value'} for ${category}@${difficulty} (λ=${lambda}/quality point): ${describe(best)}${best.steps.length > 1 && single && single !== best ? `; best single model ${describe(single)}` : ''}${best.estimated ? '; ladder estimate assumes independent failures' : ''}`,
    alternatives: alt,
  };
}

/** Budget class of a provider: config override, else derived from how it authenticates. */
export function providerClass(provider, cfg = loadConfig().scorecard) {
  if (cfg.classes?.[provider]) return cfg.classes[provider];
  const p = PROVIDERS[provider];
  if (!p) return 'api';
  if (provider === 'ollama' || p.kind === 'ollama') return 'free';
  if (provider === 'claude' || p.kind === 'claude') return 'conductor';
  if (p.auth?.type === 'apiKey') return (getLimits().providers[provider]?.balance?.granted || 0) > 0 ? 'free' : 'api'; // granted credit is spent first, so it is free until gone
  return 'included';
}

/** Busiest window % of a provider (0 when unknown). `sessionOnly` looks at short (session/5-hour) windows only. */
export function providerUsedPct(provider, { sessionOnly = false, model = null } = {}) {
  const ws = providerWindows(provider, model).filter((w) => !sessionOnly || /hour|session/i.test(w.label || '') || (w.windowMinutes && w.windowMinutes <= 600));
  return Math.max(0, ...ws.map((w) => Number(w.usedPercent) || 0));
}

/** A provider's windows that apply to a model: windows carry an optional `models` regex (Antigravity meters Gemini and Claude/GPT separately). */
export function providerWindows(provider, model = null) {
  return (getLimits().providers[provider]?.windows || []).filter((w) => !w.models || !model || new RegExp(w.models, 'i').test(model));
}

/** May the router hand new work to this provider right now? Blocked, or past its class cap, means no. */
export function providerAvailable(provider, { overflowApi = false, cfg = loadConfig().scorecard, model = null } = {}) {
  if (blockedUntil(provider)) return false;
  const cls = providerClass(provider, cfg);
  if (cls === 'api' && !overflowApi) return false;
  // The conductor's plan is capped on its session window only (its weekly may run to 100%); other classes on their busiest window.
  return providerUsedPct(provider, { sessionOnly: cls === 'conductor', model }) < (cfg.classCap?.[cls] ?? 100);
}

/** What a list-price dollar really costs on this provider: 0 local, ~0.2 on an included subscription with room left, 1 once its window is past quotaPressurePct or for pay-per-token APIs. */
export function providerWeight(provider, cfg = loadConfig().scorecard, model = null) {
  const base = cfg.providerWeight?.[provider] ?? 1;
  const used = providerUsedPct(provider, { model });
  return used >= (cfg.quotaPressurePct ?? 80) ? 1 : base;
}

const parseSel = (s) => { const [provider, model, effort] = s.split(':'); return { provider, model: model === 'default' ? null : model, effort: effort === 'default' ? null : effort }; };

/** Merge cells (sorted easiest first) until `floor` rated runs; rated-weighted quality, n-weighted cost and time. */
function pool(cells, floor) {
  const used = []; let rated = 0;
  for (const c of cells) { used.push(c); rated += c.rated; if (rated >= floor) break; }
  const w = (k, by) => { let num = 0, den = 0; for (const c of used) { if (c[k] == null) continue; num += c[k] * c[by]; den += c[by]; } return den ? num / den : null; };
  const base = used[0];
  return { ...base, cells: used.length, difficulty: base.difficulty, difficultyMax: used[used.length - 1].difficulty, rated, n: used.reduce((s, c) => s + c.n, 0), quality: w('quality', 'rated'), accept: w('accept', 'rated'), avgUsd: used.some((c) => c.avgUsd == null) ? null : w('avgUsd', 'n'), avgDurationMs: w('avgDurationMs', 'n') };
}

const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
// Desired cold-start effort per difficulty. Hard tasks deserve more thinking; the measured path takes over
// (and can down-shift on cost via effort dominance) once verdicts exist. Clamped to what the model offers.
const DIFFICULTY_EFFORT = { 1: 'low', 2: 'medium', 3: 'medium', 4: 'high', 5: 'xhigh' };
/** Cold-start effort: the highest effort the model offers that does not exceed the difficulty's target. */
export function priorEffort(efforts, difficulty) {
  const ranked = EFFORT_LADDER.filter((e) => (efforts || []).includes(e));
  if (!ranked.length) return null;
  const wantIdx = EFFORT_LADDER.indexOf(DIFFICULTY_EFFORT[difficulty] || 'medium');
  let pick = ranked[0];
  for (const e of ranked) if (EFFORT_LADDER.indexOf(e) <= wantIdx) pick = e;
  return pick;
}

/** Effort for a task the conductor routed by hand without an effort: the higher of the configured default and the difficulty target, clamped to what the model offers. */
export function effortForTask({ provider, model, difficulty, defaultEffort = null, reg = getModels() } = {}) {
  const m = reg.models.find((x) => x.provider === provider && x.id === model);
  const efforts = m?.efforts || [];
  if (!efforts.length) return defaultEffort || null;
  const want = difficulty ? priorEffort(efforts, difficulty) : null;
  const base = efforts.includes(defaultEffort) ? defaultEffort : null;
  const rank = (e) => EFFORT_LADDER.indexOf(e);
  if (want && base) return rank(want) > rank(base) ? want : base;
  return want || base || null;
}

/** Opt-in: before any measured data, route by public prior tier (cheapest priced model whose tier covers the level). */
function priorFallback({ category, difficulty, exclude, cfg, overflowApi = false }) {
  if (!cfg.usePriors) return null;
  const reg = getModels();
  const cands = [];
  for (const m of reg.models) {
    if (m.kind !== 'agent' || reg.providers[m.provider]?.status !== 'ok' || !providerAvailable(m.provider, { overflowApi, cfg, model: m.id })) continue;
    if (exclude.includes(`${m.provider}:${m.id}`)) continue;
    const p = priorFor(m.provider, m.id, category);
    if (!p?.tier || (TIER_CEILING[p.tier] || 0) < difficulty) continue;
    const price = priceFor(m.provider, m.id, { scorecard: cfg });
    if (!price) continue;
    cands.push({ provider: m.provider, model: m.id, effort: priorEffort(m.efforts, difficulty), tier: p.tier, proxy: price.in + price.out, cls: (cfg.classOrder || []).indexOf(providerClass(m.provider, cfg)) });
  }
  cands.sort((a, b) => a.cls - b.cls || a.proxy - b.proxy || a.tier.localeCompare(b.tier)); // class walk first, then price
  const best = cands[0];
  if (!best) return null;
  return { provider: best.provider, model: best.model, effort: best.effort, fallback: null, plan: null, reason: `prior only (no measured data for ${category}@${difficulty}): cheapest model whose public ${KIND[category] || 'reason'} tier ${best.tier} covers level ${difficulty}, at ${best.effort || 'default'} effort`, alternatives: cands.slice(1, 4).map((c) => `${c.provider}:${c.model} (tier ${c.tier})`) };
}

/** Conductor/CLI view: the table plus the current plan per category and level. */
export function formatScores({ category = null, source = null } = {}) {
  const summary = summarize({ source });
  const rows = summary.filter((g) => !category || g.category === category);
  if (!rows.length) return 'Scorecard is empty. Tag delegations with category/difficulty and rate them with rate_task, or run smoke_test on a model.';
  const f = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
  const lines = ['selection | category@lvl | n | rated | quality | accept | pass/fix/fail | $/task | %window/task | avg s | rounds | prior'];
  for (const g of rows) lines.push(`${g.sel} | ${g.category}@${g.difficulty} | ${g.n} | ${g.rated} | ${f(g.quality, 2)} | ${f(g.accept, 2)} | ${g.pass}/${g.fixable}/${g.fail} | ${g.avgUsd == null ? '-' : f(g.avgUsd, 3)} | ${f(g.avgPct, 1)} | ${f(g.avgDurationMs / 1000)} | ${f(g.avgRounds, 1)} | ${g.priorTier || '-'}`);
  const cfg = loadConfig().scorecard;
  lines.push('', `Plans (quality ≥ ${cfg.quality} over ≥ ${cfg.minSamples} rated; utility = $${cfg.qualityValueUsd} × quality − $ cost${cfg.hourlyUsd ? ` − $${cfg.hourlyUsd}/h` : ''}; $ = tokens at API list price × provider weight (${Object.entries(cfg.providerWeight || {}).map(([k, v]) => `${k} ${v}`).join(', ')}; full price past ${cfg.quotaPressurePct}% of a window; reserve ${cfg.reservePct} × weight × (ceiling − level))${cfg.usePriors ? '; prior fallback on' : ''}):`);
  let any = false;
  for (const c of category ? [category] : CATEGORIES) for (const d of LEVELS) {
    const r = recommend({ category: c, difficulty: d, source, summary });
    if (r) { any = true; lines.push(`- ${c}@${d}: ${r.reason}`); }
  }
  if (!any) lines.push('- none yet (not enough rated runs above the bar)');
  return lines.join('\n');
}
