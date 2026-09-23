// Scorecard: what each model actually cost (tokens -> shadow dollars at API list price, plus the % of
// its provider window) and how well it did (the conductor's verdict) per task category and
// difficulty. Append-only ndjson. `recommend` turns the data into a *plan*: one model, or a ladder
// (cheap model first, stronger model on fail), chosen by utility = value-of-quality - expected cost.
import { statSync } from 'node:fs';
import { appendNdjson, readNdjson, statePath, nowIso } from './paths.mjs';
import { getLimits, modelBlockedUntil, providerWindows } from './limits.mjs';
export { providerWindows } from './limits.mjs';
import { findModel, getModels } from './models.mjs';
import { loadConfig, DEFAULTS } from './config.mjs';
import { bus } from './bus.mjs';
import { priceFor, priorFor, usdFor, TIER_CEILING, KIND } from './priors.mjs';
import { PROVIDERS } from './providers/index.mjs';

const FILE = () => statePath('scorecard.ndjson');
export const CATEGORIES = ['read', 'search', 'summarize', 'edit', 'implement', 'test', 'refactor', 'debug', 'ui', 'docs', 'review', 'design', 'drafting', 'modeling', 'other'];

// Minimal prompt→category classifier. Today it recognizes only UI/frontend work, so a UI task the user diverts by
// hand (the `/worker …` shortcut and direct-to-worker tasks set no category) is still recorded under `ui` and the
// scorecard accumulates real per-model UI outcomes. Everything else returns null (unchanged behaviour: untagged
// unless the caller passed a category). Broaden cautiously — a wrong tag pollutes the ledger.
const UI_RE = /\b(u[ix]|css|s[ca]ss|html|tailwind|front-?end|style ?sheets?|styles?\.css|index\.html|app\.js|layout|responsive|flex-?box|z-index|viewport|@media|media quer(?:y|ies)|modal|drop-?down|tooltip|side-?bar|nav-?bar|checkbox|dark ?mode|light ?mode|favicon|jsx|tsx|\breact\b|svelte|\bvue\b|\bdom\b|:hover|button style|css class(?:es)?)\b/i;
export function classifyCategory(text) {
  return UI_RE.test(String(text || '')) ? 'ui' : null;
}
export const VERDICTS = ['pass', 'fixable', 'fail', 'phantom'];
const SCORE = { pass: 1, fixable: 0.5, fail: 0, phantom: 0 };
const LEVELS = [1, 2, 3, 4, 5];
export const selOf = (r) => `${r.provider}:${r.model || 'default'}:${r.effort || 'default'}`;
export function claimedWrites(items) { return (items || []).filter((i) => i.type === 'file_change').flatMap((i) => (i.changes || []).map((c) => c.path).filter(Boolean)); }
export function isPhantomCompletion({ ok, claimed = [], canVerify, observedCount }) { return !!ok && !!canVerify && claimed.length > 0 && observedCount === 0; }

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
export function recordRun(t, { before = null, concurrent = 0, concurrentByWindow = null } = {}) {
  if (t.imageOptions) return null;
  const row = {
    op: 'run', ts: nowIso(), taskId: t.id, followUpOf: t.followUpOf || null, retryOf: t.retryOf || null, sessionId: t.sessionId || null, source: t.source || 'live',
    provider: t.provider, model: t.model || null, effort: t.effort || null, category: t.category || null, difficulty: t.difficulty || null,
    status: t.status, tokens: normalizeUsage(t.result?.usage), costUsd: t.result?.costUsd || 0, durationMs: t.result?.durationMs || 0, variant: t.variant || null,
    pct: windowDelta(before, snapshotWindows(t.provider)), concurrent, concurrentByWindow, title: t.title, failKind: t.failKind || null, rounds: t.rounds ?? null,
    tools: t.result?.tools || null, repoFiles: t.repoFiles ?? null, repoBytes: t.repoBytes ?? null, // capability use + project size (plan Part H4): scored later as a view
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

/**
 * Data hygiene for the Antigravity Method-C change. Old rows were keyed with a raw effort-in-id model *and* a spurious
 * effort tag (e.g. `antigravity:gemini-3.6-flash-low:high`) because effort-less models used to inherit the default
 * effort — a `sel` the model never had. Void those runs (append-only; the ledger is never rewritten) so they stop
 * being recommended. Idempotent: a row already voided is skipped, so repeated boots append nothing. Returns the count.
 */
export function migrateScorecard() {
  let all; try { all = readNdjson(FILE()); } catch { return 0; }
  const voided = new Set(); for (const r of all) if (r.op === 'void') voided.add(r.taskId);
  let n = 0;
  for (const r of all) {
    if (r.op !== 'run' || r.provider !== 'antigravity' || !r.effort) continue;
    if (!/-(low|medium|high)$/.test(r.model || '') || voided.has(r.taskId)) continue; // only raw effort-in-id ids carrying a separate effort
    voidTask(r.taskId, `method-c migration: effort "${r.effort}" tagged on effort-in-id model ${r.model}`);
    voided.add(r.taskId); n++;
  }
  if (n) bus.publish('score', { migrated: n });
  return n;
}

const maxPct = (pct) => (pct ? Math.max(...Object.values(pct)) : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const meanKnown = (xs) => mean(xs.filter((x) => x != null)); // unknown costs are skipped, not poison
const addTok = (a, b) => { if (b) for (const k of ['in', 'out', 'cached']) a[k] += b[k] || 0; };

/**
 * Fold the log into chains. An *attempt* is a task plus its fix rounds (followUpOf); a *chain* is the
 * attempts linked by retryOf (a new model after a fail). Each chain: { taskId, category, difficulty,
 * source, attempts[], path[], verdict (last attempt), tokens, usd, durationMs, rounds }.
 */
/** Non-voided run rows from the ledger (for the budget planner: measuredCost needs pct + concurrent per run). */
// runRows() is hit on every schedule() pass (and by the estimator); the scorecard ndjson grows unbounded, so cache
// the parse and reuse it until the file's size/mtime changes (any appendNdjson bumps both, invalidating the cache).
let _runRowsCache = null;
const activeRunRows = (all) => {
  const voided = new Set(all.filter((r) => r.op === 'void').map((r) => r.taskId));
  return all.filter((r) => r.op === 'run' && !voided.has(r.taskId));
};
export function runRows() {
  try {
    const st = statSync(FILE());
    if (_runRowsCache && _runRowsCache.mtimeMs === st.mtimeMs && _runRowsCache.size === st.size) return _runRowsCache.rows;
    const rows = activeRunRows(readNdjson(FILE()));
    _runRowsCache = { mtimeMs: st.mtimeMs, size: st.size, rows };
    return rows;
  } catch { return activeRunRows(readNdjson(FILE())); }
}

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
    if (tokensOf(r)) a._anyUsage = true;
    addTok(a.tokens, tokensOf(r));
    a.durationMs += r.durationMs || 0;
    if (r.pct) { a.pct = a.pct || {}; for (const [k, v] of Object.entries(r.pct)) a.pct[k] = (a.pct[k] || 0) + v; }
  }
  for (const a of attempts.values()) {
    const rated = rates.get(a.taskId) || a.members.map((id) => rates.get(id)).find(Boolean);
    a.verdict = rated?.verdict || (a.status === 'failed' ? 'fail' : null);
    a.notes = rated?.notes || null;
    // D7: no run reported usage → cost unknown, EXCEPT when all prices are zero (local model: $0 is real).
    const priceAllZero = a.price && a.price.in === 0 && a.price.out === 0 && (a.price.cached ?? 0) === 0;
    a.usd = a.unmeasured ? null : (!a._anyUsage && !priceAllZero ? null : usdFor(a.tokens, a.price)); // a verdict recorded for a run made outside Conductor counts for quality, never for cost
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
    // Only a voided original's rating can settle a replacement; ordinary predecessors rate their own attempts.
    const chainRate = last.verdict ? null : [...c.ids].filter((id) => voided.has(id)).map((id) => rates.get(id)).find(Boolean);
    if (chainRate) { last.verdict = chainRate.verdict; last.notes = chainRate.notes || null; }
    c.verdict = last.verdict; c.notes = last.notes;
    c.tokens = { in: 0, out: 0, cached: 0 }; c.durationMs = 0; c.rounds = 0; c.pct = null;
    let usd = 0, priced = 0;
    for (const a of c.attempts) { addTok(c.tokens, a.tokens); c.durationMs += a.durationMs; c.rounds += a.rounds; if (a.usd != null) { usd += a.usd; priced++; } if (a.pct) { c.pct = c.pct || {}; for (const [k, v] of Object.entries(a.pct)) c.pct[k] = (c.pct[k] || 0) + v; } }
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
    if (!g) { g = { sel, steps, category: cat, difficulty: diff, n: 0, rated: 0, pass: 0, fixable: 0, fail: 0, phantom: 0, _tok: [], _usd: [], _pct: [], _dur: [], _rounds: [] }; groups.set(key, g); }
    g.n++;
    if (x.ts && (!g.last || x.ts > g.last)) g.last = x.ts;
    if (x.verdict) { g.rated++; g[x.verdict]++; }
    g._tok.push(x.tokens.in + x.tokens.out + x.tokens.cached);
    if (x.usd != null) g._usd.push(x.usd);
    const p = maxPct(x.pct); if (p != null) g._pct.push(p);
    g._dur.push(x.durationMs); g._rounds.push(x.rounds);
    return g;
  };
  for (const c of rootRuns({ source })) {
    if (!c.category || !c.difficulty) continue;
    for (const a of c.attempts) { const g = add(a.sel, 1, c.category, c.difficulty, a); g.provider = a.provider; g.model = a.model; g.effort = a.effort; }
    if (c.attempts.length > 1) {
      const g = add(c.path.join('>'), c.attempts.length, c.category, c.difficulty, c);
      g._stepCosts ||= c.attempts.map(() => []);
      c.attempts.forEach((a, i) => g._stepCosts[i].push({ sel: a.sel, avgUsd: a.usd, avgDurationMs: a.durationMs }));
    }
  }
  return [...groups.values()].map(({ _tok, _usd, _pct, _dur, _rounds, _stepCosts, ...g }) => {
    const cost = g.steps === 1 ? findModel(g.provider, g.model)?.cost || null : null;
    const prior = g.steps === 1 ? priorFor(g.provider, g.model, g.category) : null;
    const quality = g.rated ? (g.pass * SCORE.pass + g.fixable * SCORE.fixable) / g.rated : null;
    return {
      ...g, cost, priorTier: prior?.tier || null, quality, accept: g.rated ? (g.pass + g.fixable) / g.rated : null,
      ...(_stepCosts ? { stepCosts: _stepCosts.map((costs) => ({ sel: costs[0].sel, avgUsd: meanKnown(costs.map((c) => c.avgUsd)), avgDurationMs: mean(costs.map((c) => c.avgDurationMs)) })) } : {}),
      avgTokens: mean(_tok), avgUsd: mean(_usd), avgPct: cost === 'free-local' ? 0 : mean(_pct), avgDurationMs: mean(_dur), avgRounds: mean(_rounds),
      errorRate: g.rated ? (g.fail + g.phantom) / g.rated : null, phantomRate: g.rated ? g.phantom / g.rated : null,
    };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.difficulty - b.difficulty || a.steps - b.steps || (b.quality ?? -1) - (a.quality ?? -1));
}

export function errorRates({ source = null } = {}) {
  const models = new Map(), providers = new Map();
  for (const c of rootRuns({ source })) for (const a of c.attempts) if (a.verdict) {
    for (const [map, key] of [[models, a.sel], [providers, a.provider]]) {
      let g = map.get(key); if (!g) { g = { key, rated: 0, fail: 0, phantom: 0 }; map.set(key, g); }
      g.rated++; if (a.verdict === 'fail') g.fail++; if (a.verdict === 'phantom') g.phantom++;
    }
  }
  const finish = (map) => [...map.values()].map((g) => ({ ...g, errorRate: (g.fail + g.phantom) / g.rated, phantomRate: g.phantom / g.rated })).sort((a, b) => b.errorRate - a.errorRate || b.rated - a.rated);
  return { byModel: finish(models), byProvider: finish(providers) };
}

/**
 * Best plan for a category at a difficulty: max utility = valueOfQuality × expected quality − expected
 * cost ($ at API list prices + optional $/hour of wall clock). Plans are single models that clear the
 * quality bar, observed ladders, and estimated ladders (cheap first step, qualified fallback; assumes
 * independent failures). Returns null when nothing measured qualifies (then the prior fallback, if enabled).
 */
export function recommend({ category, difficulty = 2, exclude = [], source = null, summary = null, escalate = false, overflowApi = false, providers = null, reg = getModels(), _noExtrap = false, _failedBelow = null } = {}) {
  const cfg = loadConfig().scorecard;
  // Per-call memos: availability and weight read the limits registry (a stat each); the summary has hundreds of rows per sel.
  const memo = (fn) => { const m = new Map(); return (...a) => { const k = a.join('|'); if (!m.has(k)) m.set(k, fn(...a)); return m.get(k); }; };
  const avail = memo((provider, model) => providerAvailable(provider, { overflowApi, cfg, model }));
  const weight = memo((provider, model) => providerWeight(provider, cfg, model));
  const lambda = cfg.qualityValueUsd, hourly = cfg.hourlyUsd;
  const excluded = (sel) => sel.split('>').some((s) => { const { provider, model } = parseSel(s); return exclude.includes(s) || exclude.includes(`${provider}:${model || 'default'}`); });
  const blockedSel = (sel) => sel.split('>').some((s) => {
    const { provider, model } = parseSel(s);
    // A transient registry error retains cached models; explicit unavailability or removal does not.
    return reg.providers[provider]?.status === 'unavailable' || modelInRegistry(reg, provider, model)?.kind !== 'agent' || !avail(provider, model);
  });
  const all = summary || summarize({ source });
  const allowed = (sel) => !providers || sel.split('>').every((s) => providers.includes(s.split(':')[0])); // access gate: only these providers may take the task
  const gate = passGate(category, reg);
  const rows = all.filter((g) => g.category === category && g.rated > 0 && !excluded(g.sel) && !blockedSel(g.sel) && allowed(g.sel) && gate(g.sel));
  // Measured ceiling per provider (any category): the highest level it has cleared with enough samples.
  const ceiling = new Map();
  for (const g of all) if (g.steps === 1 && g.rated >= cfg.minSamples && g.quality >= cfg.quality) ceiling.set(g.provider, Math.max(ceiling.get(g.provider) || 0, g.difficulty));
  const reserve = (provider) => { const w = weight(provider, null); const gap = Math.max(0, (ceiling.get(provider) || 0) - difficulty); return 1 + cfg.reservePct * w * gap; };
  const costOf = (g) => {
    const costs = g.stepCosts || [g];
    if (costs.some((c) => c.avgUsd == null)) return null;
    return costs.reduce((sum, c) => {
      const { provider, model } = parseSel(c.sel.split('>').at(-1));
      return sum + (c.avgUsd + hourly * (c.avgDurationMs || 0) / 3.6e6) * weight(provider, model) * reserve(provider) * wasteDiscount(provider, cfg, model);
    }, 0);
  };
  // Evidence per selection: the cell nearest the requested level (not below), pooling harder cells only until
  // the sample floor is met. A well-sampled failing cell at or below the level disqualifies it as a final step.
  // Keep the original request's disqualifications when extrapolating; priors cannot override them either.
  const failedBelow = _failedBelow || new Set(all.filter((g) => g.category === category && g.difficulty <= difficulty && g.rated >= cfg.minSamples && g.quality < cfg.quality).map((g) => g.sel));
  const bySel = new Map();
  for (const g of rows) {
    const m = bySel.get(g.sel) || { sel: g.sel, steps: g.steps, cells: [] };
    if (g.difficulty >= difficulty) m.cells.push(g);
    bySel.set(g.sel, m);
  }
  const evidence = [...bySel.values()].filter((m) => m.cells.length).map((m) => ({ ...m, ref: pool(m.cells.sort((a, b) => a.difficulty - b.difficulty), cfg.minSamples) })).filter((m) => m.ref.rated >= cfg.minSamples);
  const finals = evidence.filter((m) => m.ref.quality >= cfg.quality && !failedBelow.has(m.sel) && !failedBelow.has(m.sel.split('>').at(-1)));
  const plans = [];
  for (const m of finals) plans.push({ steps: m.ref.sel.split('>'), quality: m.ref.quality, usd: costOf(m.ref), estimated: false, ref: m.ref });
  for (const a of evidence.filter((m) => m.steps === 1 && costOf(m.ref) != null)) {
    for (const b of finals.filter((m) => m.steps === 1 && m.sel !== a.sel && costOf(m.ref) != null)) {
      if (bySel.has(`${a.sel}>${b.sel}`) && bySel.get(`${a.sel}>${b.sel}`).cells.length) continue; // observed ladder already a plan
      const pA = a.ref.accept;
      plans.push({ steps: [a.sel, b.sel], quality: a.ref.quality + (1 - pA) * b.ref.quality, usd: costOf(a.ref) + (1 - pA) * costOf(b.ref), estimated: true, ref: a.ref, fallbackRef: b.ref });
    }
  }
  // OB7: unknown-cost plans are eligible but rank after every priced eligible plan. costUnknown marks them.
  for (const p of plans) {
    if (p.usd == null) { p.utility = lambda * p.quality; p.costUnknown = true; }
    else { p.utility = lambda * p.quality - p.usd; }
  }
  // Effort dominance: a higher effort of the same model that costs within effortSlackUsd and is at least as good
  // makes the lower effort pointless (Luna's efforts differ by fractions of a cent; the higher one held up on real work).
  const slackOf = (usd) => Math.max(cfg.effortSlackUsd, usd * (cfg.effortSlackPct / 100)); // absolute floor for cheap models, relative for dear ones
  const dominated = new Set();
  for (const a of plans) for (const b of plans) {
    if (a === b || a.steps.length !== 1 || b.steps.length !== 1 || a.usd == null || b.usd == null) continue;
    // B1: use parseSel so model ids containing ':' (e.g. qwen3.8:latest) parse correctly.
    const { provider: pa, model: ma, effort: ea } = parseSel(a.steps[0]), { provider: pb, model: mb, effort: eb } = parseSel(b.steps[0]);
    if (pa !== pb || ma !== mb || EFFORTS.indexOf(eb) <= EFFORTS.indexOf(ea)) continue;
    if (b.usd <= a.usd + slackOf(a.usd) && b.quality >= a.quality) dominated.add(a);
  }
  for (const p of plans) if (dominated.has(p) || p.steps.some((st) => dominated.has(plans.find((x) => x.steps.length === 1 && x.steps[0] === st)))) p.utility = -Infinity;
  // OB7: sort — priced eligible plans before unknown-cost ones; within each group, value ordering applies.
  const eligible = (p) => p.utility > -Infinity;
  const sortCmp = escalate
    ? (x, y) => (y.quality - x.quality) || (x.costUnknown !== y.costUnknown ? (x.costUnknown ? 1 : -1) : 0) || (y.utility - x.utility)
    : (x, y) => {
        if (eligible(x) !== eligible(y)) return eligible(x) ? -1 : 1;
        if (eligible(x) && x.costUnknown !== y.costUnknown) return x.costUnknown ? 1 : -1; // priced first
        return y.utility - x.utility || (y.quality - x.quality) || ((x.ref.avgDurationMs ?? 0) - (y.ref.avgDurationMs ?? 0));
      };
  plans.sort(sortCmp);
  // Class walk: the first budget class (in configured order) that holds a viable plan wins; value already ordered the plans.
  const classOf = (p) => providerClass(p.steps[0].split(':')[0], cfg);
  let best = null, bestClass = null;
  if (escalate) {
    // Escalation is the last rung before the conductor does it itself: take the highest-quality SINGLE model that is
    // still AVAILABLE (limits + budget windows already filtered into `rows`), regardless of budget class — the
    // strongest model we can still reach, not the cheapest class and not a cheap-first ladder (which would re-dispatch
    // the rung that has been failing). This is the best-*available* pick, distinct from best-value. Fall back to a
    // ladder only if no single model clears the bar.
    best = plans.find((p) => p.utility > -Infinity && p.steps.length === 1) || plans.find((p) => p.utility > -Infinity) || null;
    bestClass = best ? classOf(best) : null;
  } else {
    for (const cls of cfg.classOrder || []) { best = plans.find((p) => p.utility > -Infinity && classOf(p) === cls); if (best) { bestClass = cls; break; } }
    if (!best) best = plans.find((p) => p.utility > -Infinity) || null;
  }
  if (!best) {
    // A provider proven at this level exists but is capped/blocked/excluded: hand the task back (the conductor does it or
    // waits for a reset) rather than extrapolating to a weaker class. Extrapolate only when nothing at all is proven here.
    // B5: also require allowed(g.sel) so a blocked but disallowed provider does not prevent extrapolation.
    const provenButCapped = all.some((g) => g.category === category && g.steps === 1 && g.difficulty >= difficulty && g.rated >= cfg.minSamples && g.quality >= cfg.quality && !excluded(g.sel) && allowed(g.sel) && gate(g.sel) && blockedSel(g.sel));
    if (provenButCapped) return null;
    // Nothing proven at this level or above: extrapolate from the nearest lower level (flagged) before the prior.
    for (let d = difficulty - 1; d >= 1 && !_noExtrap; d--) {
      const lower = recommend({ category, difficulty: d, exclude, source, summary, escalate, overflowApi, providers, reg, _noExtrap: true, _failedBelow: failedBelow });
      if (lower?.plan) return { ...lower, reason: `${lower.reason}; extrapolated from level ${d} — nothing measured at level ${difficulty}+ yet` };
    }
    return priorFallback({ category, difficulty, exclude, cfg, overflowApi, providers, reg, failedBelow });
  }
  const first = parseSel(best.steps[0]);
  const money = (v) => (v == null ? 'cost unknown' : `$${v.toFixed(v < 0.1 ? 3 : 2)}`);
  const describe = (p) => { const prov = p.steps[p.steps.length - 1].split(':')[0]; const rs = reserve(prov); return `${p.steps.join(' then on fail ')}: expected quality ${p.quality.toFixed(2)} at ${money(p.usd)}${p.estimated ? ' (est.)' : ''}${p.ref.cells > 1 ? ` [levels ${p.ref.difficulty}–${p.ref.difficultyMax} pooled]` : ''}${rs > 1 ? ` [reserve ×${rs.toFixed(2)}: ${prov} proven to level ${ceiling.get(prov)}]` : ''}`; };
  const single = plans.find((p) => p.steps.length === 1);
  const alt = plans.slice(1, 4).map(describe);
  return {
    provider: first.provider, model: first.model, effort: first.effort,
    fallback: best.fallbackRef ? { provider: best.fallbackRef.provider, model: best.fallbackRef.model, effort: best.fallbackRef.effort } : best.steps.length > 1 ? parseSel(best.steps[1]) : null,
    plan: { steps: best.steps, quality: best.quality, usd: best.usd, estimated: best.estimated, utility: best.utility },
    class: bestClass,
    reason: `${bestClass ? `class ${bestClass} · ` : ''}${escalate ? 'escalation: best available model by measured quality (any class)' : 'best value'} for ${category}@${difficulty} (λ=${lambda}/quality point): ${describe(best)}${best.steps.length > 1 && single && single !== best ? `; best single model ${describe(single)}` : ''}${best.estimated ? '; ladder estimate assumes independent failures' : ''}${best.costUnknown ? ' [cost unknown]' : ''}`,
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
  const ws = providerWindows(provider, model).filter((w) => (!w.resetsAt || w.resetsAt > Date.now()) && (!sessionOnly || /hour|session/i.test(w.label || '') || (w.windowMinutes && w.windowMinutes <= 600)));
  return Math.max(0, ...ws.map((w) => Number(w.usedPercent) || 0));
}

/** May the router hand new work to this provider right now? Blocked, or past its class cap, means no. */
export function providerAvailable(provider, { overflowApi = false, cfg = loadConfig().scorecard, model = null } = {}) {
  if (modelBlockedUntil(provider, model)) return false;
  const cls = providerClass(provider, cfg);
  if (cls === 'api' && !overflowApi) return false;
  // The conductor's plan is capped on its session window only (its weekly may run to 100%); other classes on their busiest window.
  return providerUsedPct(provider, { sessionOnly: cls === 'conductor', model }) < (cfg.classCap?.[cls] ?? 100);
}

/** What a list-price dollar really costs on this provider: 0 local, ~0.2 on an included subscription with room left, 1 once its window is past quotaPressurePct or for pay-per-token APIs. */
export function providerWeight(provider, cfg = loadConfig().scorecard, model = null) {
  // These exported helpers also accept partial configs, so their missing-key fallbacks remain reachable.
  const base = cfg.providerWeight?.[provider] ?? 1;
  const used = providerUsedPct(provider, { model });
  return used >= (cfg.quotaPressurePct ?? DEFAULTS.scorecard.quotaPressurePct) ? 1 : base;
}

/**
 * Use-it-or-lose-it cost discount in [~0, 1]. A subscription's weekly/monthly window that resets soon with quota
 * unused loses that quota at reset, so spending it now is ~free — discount its cost so the planner prefers it while
 * quality still leads. Only fixed-quota subscription classes (not API, which bills per token, nor the conductor's own
 * plan, which keeps a buffer). 5-hour windows churn constantly and are ignored — the waste that matters is the weekly.
 */
export function wasteDiscount(provider, cfg = loadConfig().scorecard, model = null, now = Date.now()) {
  const cls = providerClass(provider, cfg);
  if (cls !== 'subscription' && cls !== 'included') return 1;
  const horizon = Math.max(1, cfg.wasteHorizonHours ?? DEFAULTS.scorecard.wasteHorizonHours) * 3600e3;
  const strength = Math.min(1, Math.max(0, cfg.wasteStrength ?? DEFAULTS.scorecard.wasteStrength));
  const discount = (ms, headroom) => (ms > 0 && ms <= horizon ? 1 - (1 - ms / horizon) * headroom * strength : 1); // proximity × unused headroom × strength
  let factor = 1;
  for (const w of providerWindows(provider, model)) {
    if (!w.resetsAt) continue;
    if (/hour|session/i.test(w.label || '') || (w.windowMinutes && w.windowMinutes <= 600)) continue; // ignore the 5-hour churn
    factor = Math.min(factor, discount(w.resetsAt - now, Math.min(1, Math.max(0, 100 - (Number(w.usedPercent) || 0)) / 100)));
  }
  // Windowless provider (Grok, …): no real weekly window drove a discount, so fall back to a configured reset schedule.
  // "Use till it fails" means we assume the quota is worth spending (full headroom) as its reset nears.
  if (factor === 1) { const sched = nextScheduledReset(provider, cfg, now); if (sched) factor = discount(sched - now, 1); }
  return factor;
}

/**
 * Next reset for a provider whose CLI reports no window, from config `usageResets`. All times are the machine's
 * LOCAL (system) timezone — DST-aware — never a hard-coded zone. Two forms:
 *   { periodHours, resetHour[, resetMinute][, resetDay] } — a wall-clock schedule: daily at resetHour local
 *     (periodHours 24), or weekly at resetDay (0=Sun..6=Sat) + resetHour local (periodHours 168).
 *   { periodHours, anchorAt } — step the period from an explicit instant (anchorAt with no offset = local time).
 * Null when nothing is configured.
 */
export function nextScheduledReset(provider, cfg = loadConfig().scorecard, now = Date.now()) { return scheduledReset(provider, cfg, now, 1); }
/** The most recent reset at or before `now` (or null). Derived the same way as the next one, so the two can never
 *  disagree — the old "next − periodHours" could even land in the future when the day offset exceeded the period. */
export function prevScheduledReset(provider, cfg = loadConfig().scorecard, now = Date.now()) { return scheduledReset(provider, cfg, now, -1); }

function scheduledReset(provider, cfg, now, dir) {
  const s = cfg.usageResets?.[provider]; if (!s) return null;
  if (Number(s.periodHours) === 0) return null; // explicit "not set" (what Settings writes for "assume none")
  if (s.resetHour != null) {
    // Wall-clock schedule, recomputed from the settings on every call: change the day or the hour and the boundary
    // moves with it, no migration and no stored instant to go stale. Stepping by CALENDAR days rather than a fixed
    // millisecond period is what keeps 22:00 at 22:00 across a DST change.
    const step = s.resetDay != null ? 7 : 1;
    const d = new Date(now);
    d.setHours(Number(s.resetHour) || 0, Number(s.resetMinute) || 0, 0, 0);
    if (s.resetDay != null) { const delta = (((Number(s.resetDay) - d.getDay()) % 7) + 7) % 7; d.setDate(d.getDate() + delta); }
    if (dir > 0) { while (d.getTime() <= now) d.setDate(d.getDate() + step); }        // first reset strictly after now
    else { while (d.getTime() > now) d.setDate(d.getDate() - step); }                 // last reset at or before now
    return d.getTime();
  }
  const period = (Number(s.periodHours) || 0) * 3600e3; if (period <= 0) return null;
  const anchor = s.anchorAt ? Date.parse(s.anchorAt) : NaN; // explicit instant (no offset => local)
  if (!Number.isFinite(anchor)) return null;
  const next = anchor + Math.ceil((now - anchor) / period) * period;
  return dir > 0 ? (next <= now ? next + period : next) : (next <= now ? next : next - period);
}

const parseSel = (s) => {
  const [provider, ...parts] = s.split(':');
  const effort = parts.length > 1 && (parts.at(-1) === 'default' || EFFORTS.includes(parts.at(-1))) ? parts.pop() : null;
  const model = parts.join(':');
  return { provider, model: model === 'default' ? null : model, effort: effort === 'default' ? null : effort };
};
// Visual work (modeling, drafting): the auto-pick may route only a selection with a recorded cookie-cutter PASS, at
// the effort that passed AND is still supported (priors.mjs MODELING / DRAFTING; 'close' and 'fail' are not routable), on every path and
// every ladder step. An explicit provider/model pin is the caller's call and is not gated (benchmark runs need that).
const modelInRegistry = (reg, provider, model) => reg.models.find((m) => m.provider === provider && (m.id === model || m.resolved === model));
const passGate = (category, reg) => (KIND[category] !== 'visual' ? () => true : (sel) => sel.split('>').every((s) => {
  const { provider, model, effort } = parseSel(s);
  const p = priorFor(provider, model, category);
  return !!p?.tier && !!effort && p.effort === effort && !!modelInRegistry(reg, provider, model)?.efforts?.includes(effort);
}));

/** Merge cells (sorted easiest first) until `floor` rated runs; rated-weighted quality, n-weighted cost and time. */
function pool(cells, floor) {
  const used = []; let rated = 0;
  for (const c of cells) { used.push(c); rated += c.rated; if (rated >= floor) break; }
  const w = (k, by, cells = used) => { let num = 0, den = 0; for (const c of cells) { if (c[k] == null) continue; num += c[k] * c[by]; den += c[by]; } return den ? num / den : null; };
  const base = used[0];
  const stepCosts = base.stepCosts?.map((s, i) => {
    const costs = used.map((c) => ({ ...c.stepCosts[i], n: c.n }));
    return { sel: s.sel, avgUsd: w('avgUsd', 'n', costs), avgDurationMs: w('avgDurationMs', 'n', costs) };
  });
  return { ...base, ...(stepCosts ? { stepCosts } : {}), cells: used.length, difficulty: base.difficulty, difficultyMax: used[used.length - 1].difficulty, rated, n: used.reduce((s, c) => s + c.n, 0), quality: w('quality', 'rated'), accept: w('accept', 'rated'), avgUsd: w('avgUsd', 'n'), avgDurationMs: w('avgDurationMs', 'n') };
}

// Single source of truth for effort ordering (low -> ultra). Everything that ranks effort imports this;
// omitting `ultra` here (as an older copy did) made ultra rank -1, so a model's top effort could never cold-start.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// Desired cold-start effort per difficulty. Hard tasks deserve more thinking; the measured path takes over
// (and can down-shift on cost via effort dominance) once verdicts exist. Clamped to what the model offers.
const DIFFICULTY_EFFORT = { 1: 'low', 2: 'medium', 3: 'medium', 4: 'high', 5: 'xhigh' };
/** Cold-start effort: the highest effort the model offers that does not exceed the difficulty's target. */
export function priorEffort(efforts, difficulty) {
  const ranked = EFFORTS.filter((e) => (efforts || []).includes(e));
  if (!ranked.length) return null;
  const map = { ...DIFFICULTY_EFFORT, ...(loadConfig().scorecard?.difficultyEffort || {}) };
  const wantIdx = EFFORTS.indexOf(map[difficulty] || 'medium');
  let pick = ranked[0];
  for (const e of ranked) if (EFFORTS.indexOf(e) <= wantIdx) pick = e;
  return pick;
}

/** Effort for a task the conductor routed by hand without an effort: the higher of the configured default and the difficulty target, clamped to what the model offers. */
export function effortForTask({ provider, model, difficulty, defaultEffort = null, reg = getModels() } = {}) {
  const m = reg.models.find((x) => x.provider === provider && x.id === model);
  const efforts = m?.efforts || [];
  if (!efforts.length) return null; // a model with no effort dimension must never carry an effort (e.g. agy bakes it into the id)
  const want = difficulty ? priorEffort(efforts, difficulty) : null;
  const base = efforts.includes(defaultEffort) ? defaultEffort : null;
  const rank = (e) => EFFORTS.indexOf(e);
  if (want && base) return rank(want) > rank(base) ? want : base;
  return want || base || null;
}

/**
 * Opt-in: before any measured data, route by public prior tier (cheapest priced model whose tier covers the level).
 * Visual work always takes this path, restricted by the pass gate: its benchmark verdicts are our own evidence, not a public prior.
 */
function priorFallback({ category, difficulty, exclude, cfg, overflowApi = false, providers = null, reg, failedBelow }) {
  if (!cfg.usePriors && KIND[category] !== 'visual') return null;
  const gate = passGate(category, reg);
  const cands = [];
  for (const m of reg.models) {
    if (m.kind !== 'agent' || reg.providers[m.provider]?.status !== 'ok' || !providerAvailable(m.provider, { overflowApi, cfg, model: m.id })) continue;
    if (exclude.includes(`${m.provider}:${m.id}`) || (providers && !providers.includes(m.provider))) continue;
    const p = priorFor(m.provider, m.id, category);
    if (!p?.tier || (TIER_CEILING[p.tier] || 0) < difficulty) continue;
    const price = priceFor(m.provider, m.id, { scorecard: cfg });
    if (!price) continue;
    const effort = (p.effort && (m.efforts || []).includes(p.effort) ? p.effort : null) || priorEffort(m.efforts, difficulty);
    const sel = selOf({ provider: m.provider, model: m.id, effort });
    if (exclude.includes(sel) || failedBelow.has(sel) || !gate(sel)) continue;
    cands.push({ provider: m.provider, model: m.id, effort, tier: p.tier, proxy: price.in + price.out, cls: (cfg.classOrder || []).indexOf(providerClass(m.provider, cfg)) });
  }
  cands.sort((a, b) => a.cls - b.cls || a.proxy - b.proxy || a.tier.localeCompare(b.tier)); // class walk first, then price
  const best = cands[0];
  if (!best) return null;
  return { provider: best.provider, model: best.model, effort: best.effort, fallback: null, plan: null, reason: `prior only (no measured data for ${category}@${difficulty}): ${KIND[category] === 'visual' ? `cheapest model with a recorded ${category} PASS, at the effort that passed (${best.effort})` : `cheapest model whose public ${KIND[category] || 'reason'} tier ${best.tier} covers level ${difficulty}, at ${best.effort || 'default'} effort`}`, alternatives: cands.slice(1, 4).map((c) => `${c.provider}:${c.model} (tier ${c.tier})`) };
}

/**
 * Short view (what the conductor gets by default): one line per category and level, levels collapsed when the
 * picks are identical: the best pick and the runner-up (recommend() again with the best pick's model excluded),
 * each with expected quality, $/task and flags. Then the benched cells (enough samples, below the quality bar):
 * a computed view of the ledger, never a second record. Memoised on the ledger, limits, models and config, since
 * 140 recommend() calls take seconds on a large ledger.
 */
let shortMemo = null;
export function formatScoresShort({ source = null } = {}) {
  const cfg = loadConfig().scorecard;
  let key = source + '|' + JSON.stringify(cfg) + '|' + (getLimits().updatedAt || '') + '|' + (getModels().updatedAt || '');
  try { const st = statSync(FILE()); key += '|' + st.size + ':' + st.mtimeMs; } catch { key += '|none'; }
  if (shortMemo?.key === key) return shortMemo.text;
  const all = summarize({ source });
  if (!all.length) return 'Scorecard is empty. Tag delegations with category/difficulty and rate them with rate_task, or run smoke_test on a model.';
  const money = (v) => (v == null ? 'unpriced' : '$' + v.toFixed(v < 0.1 ? 3 : 2));
  const sel = (r) => r.provider + ':' + (r.model || 'default') + ':' + (r.effort || 'default');
  const cell = (r) => {
    if (!r) return '-';
    if (!r.plan) return sel(r) + ' (prior only)';
    const from = /extrapolated from level (\d)/.exec(r.reason || '');
    const flags = [r.plan.estimated ? 'est.' : null, from ? 'from L' + from[1] : null].filter(Boolean); // the ladder's fallback step is detail: it changes per level and the auto-pick applies it anyway
    return sel(r) + ' q' + r.plan.quality.toFixed(2) + ' ' + money(r.plan.usd) + (flags.length ? ' [' + flags.join(', ') + ']' : '');
  };
  const lines = ['Best pick + runner-up per category@level (q = expected quality 0-1 over >= ' + cfg.minSamples + ' rated; $ per task at API list price x provider weight; est. = estimated ladder). Full table and reasons: model_scores with detail: true or a category.'];
  for (const c of CATEGORIES) {
    const runs = [];
    for (const d of LEVELS) {
      const best = recommend({ category: c, difficulty: d, source, summary: all });
      if (!best) continue;
      const second = recommend({ category: c, difficulty: d, source, summary: all, exclude: [best.provider + ':' + (best.model || 'default')] });
      const text = cell(best) + ' | runner-up ' + cell(second);
      const last = runs[runs.length - 1];
      if (last && last.text === text && last.to === d - 1) last.to = d; else runs.push({ from: d, to: d, text });
    }
    for (const r of runs) lines.push('- ' + c + '@' + (r.from === r.to ? r.from : r.from + '-' + r.to) + ': ' + r.text);
  }
  if (lines.length === 1) lines.push('- no pick yet (not enough rated runs above the bar)');
  const benched = all.filter((g) => g.steps === 1 && g.rated >= cfg.minSamples && g.quality != null && g.quality < cfg.quality);
  if (benched.length) {
    lines.push('', 'Benched (quality < ' + cfg.quality + ' over >= ' + cfg.minSamples + ' rated; recommend() skips these cells; a better run lifts them):');
    for (const g of benched) lines.push('- ' + g.sel + ' ' + g.category + '@' + g.difficulty + ': q' + g.quality.toFixed(2) + ' over ' + g.rated + ' rated (' + g.pass + '/' + g.fixable + '/' + g.fail + '/' + g.phantom + ')' + (g.last ? ', last run ' + String(g.last).slice(0, 10) : ''));
  }
  const text = lines.join('\n');
  shortMemo = { key, text };
  return text;
}

/** `conductor scores --csv`: the summary table as CSV (opens in Excel). */
export function scoresCsv({ source = null } = {}) {
  const cols = ['sel', 'category', 'difficulty', 'steps', 'n', 'rated', 'quality', 'accept', 'pass', 'fixable', 'fail', 'phantom', 'avgUsd', 'avgPct', 'avgTokens', 'avgDurationMs', 'avgRounds', 'errorRate', 'phantomRate', 'priorTier', 'cost', 'last'];
  const q = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return [cols.join(','), ...summarize({ source }).map((g) => cols.map((k) => q(g[k])).join(','))].join('\n') + '\n';
}

/** Conductor/CLI view: the table plus the current plan per category and level. */
export function formatScores({ category = null, source = null } = {}) {
  const summary = summarize({ source });
  const rows = summary.filter((g) => !category || g.category === category);
  if (!rows.length) return 'Scorecard is empty. Tag delegations with category/difficulty and rate them with rate_task, or run smoke_test on a model.';
  const f = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
  const lines = ['selection | category@lvl | n | rated | quality | accept | pass/fix/fail/phantom | $/task | %window/task | avg s | rounds | prior'];
  for (const g of rows) lines.push(`${g.sel} | ${g.category}@${g.difficulty} | ${g.n} | ${g.rated} | ${f(g.quality, 2)} | ${f(g.accept, 2)} | ${g.pass}/${g.fixable}/${g.fail}/${g.phantom} | ${g.avgUsd == null ? '-' : f(g.avgUsd, 3)} | ${f(g.avgPct, 1)} | ${f(g.avgDurationMs / 1000)} | ${f(g.avgRounds, 1)} | ${g.priorTier || '-'}`);
  const cfg = loadConfig().scorecard;
  lines.push('', `Plans (quality ≥ ${cfg.quality} over ≥ ${cfg.minSamples} rated; utility = $${cfg.qualityValueUsd} × quality − $ cost${cfg.hourlyUsd ? ` − $${cfg.hourlyUsd}/h` : ''}; $ = tokens at API list price × provider weight (${Object.entries(cfg.providerWeight || {}).map(([k, v]) => `${k} ${v}`).join(', ')}; full price past ${cfg.quotaPressurePct}% of a window; reserve ${cfg.reservePct} × weight × (ceiling − level))${cfg.usePriors ? '; prior fallback on' : ''}):`);
  let any = false;
  for (const c of category ? [category] : CATEGORIES) for (const d of LEVELS) {
    const r = recommend({ category: c, difficulty: d, source, summary });
    if (r) { any = true; lines.push(`- ${c}@${d}: ${r.reason}`); }
  }
  if (!any) lines.push('- none yet (not enough rated runs above the bar)');
  lines.push('', 'Error rates (φ = phantom / unverified completions):');
  const ers = errorRates({ source }).byProvider;
  if (!ers.length) lines.push('- none rated yet');
  else for (const e of ers) lines.push(`- ${e.key}: ${(e.errorRate * 100).toFixed(0)}% error, ${(e.phantomRate * 100).toFixed(0)}% φ (n=${e.rated})`);
  return lines.join('\n');
}
