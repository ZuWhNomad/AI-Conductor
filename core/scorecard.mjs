// Scorecard: what each model actually cost (tokens -> shadow dollars at API list price, plus the % of
// its provider window) and how well it did (the conductor's verdict) per task category and
// difficulty. Append-only ndjson. `recommend` turns the data into a *plan*: one model, or a ladder
// (cheap model first, stronger model on fail), chosen by utility = value-of-quality - expected cost.
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendNdjson, readNdjson, readJson, writeJson, statePath, nowIso, REPO_ROOT } from './paths.mjs';
import { getLimits, modelBlockedUntil, providerWindows, isSession, withLimitsSnapshot } from './limits.mjs';
export { providerWindows } from './limits.mjs';
import { getModels } from './models.mjs';
import { loadConfig, DEFAULTS } from './config.mjs';
import { bus } from './bus.mjs';
import { priceFor, priorFor, usdFor, TIER_CEILING, KIND } from './priors.mjs';
import { PROVIDERS } from './providers/index.mjs';
import { cliVersionOf } from './cli-update.mjs';

const FILE = () => statePath('scorecard.ndjson');
export const BATTERIES_FILE = join(REPO_ROOT, 'core', 'policy', 'batteries.json');
export const BATTERIES_SCHEMA_VERSION = 1;
// Only Claude's SDK cost is a meaningful provider-reported list price today.
const LIST_COST_PROVIDERS = new Set(['claude']);
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
// Routing covers levels 1-5. The smoke battery also records 6-7: those rows show in the tables, but recommend() ignores them.
export const ROUTED_MAX_DIFFICULTY = 5;
const LEVELS = [1, 2, 3, 4, 5];
export const scorecardModelId = (model) => typeof model === 'string' ? model.replace(/\[1m\]$/i, '') : model;
export const selOf = (r) => `${r.provider}:${r.model || 'default'}:${r.effort || 'default'}`;
const archiveKey = (value) => {
  const s = String(value).trim(), colon = s.indexOf(':');
  return (colon < 0 ? s : `${s.slice(0, colon)}:${scorecardModelId(s.slice(colon + 1))}`).toLowerCase();
};
const archivedSet = (cfg) => new Set((cfg?.scorecard?.archived || cfg?.archived || []).map(archiveKey).filter(Boolean));
export function isArchived(provider, model, cfg = loadConfig().scorecard) {
  const set = cfg instanceof Set ? cfg : archivedSet(cfg);
  return set.has(`${provider}:${scorecardModelId(model) || 'default'}`.toLowerCase());
}

const BATTERY_CELL_KEYS = ['provider', 'model', 'effort', 'category', 'difficulty', 'rated', 'pass', 'fixable', 'fail', 'phantom', 'avgUsd', 'avgDurationMs', 'avgTokens', 'lastRunDate'];
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const finiteOrNull = (v) => v === null || (Number.isFinite(v) && v >= 0);
const count = (v) => Number.isInteger(v) && v >= 0;

/** Strict aggregate-only schema: no task ids, titles, notes, or paths can be carried by this file. */
export function validBatteriesDocument(doc) {
  if (!plain(doc) || doc.schemaVersion !== BATTERIES_SCHEMA_VERSION || typeof doc.generatedAt !== 'string' || !Array.isArray(doc.cells)) return false;
  if (Object.keys(doc).sort().join('|') !== ['cells', 'generatedAt', 'schemaVersion'].join('|')) return false;
  return doc.cells.every((c) => plain(c)
    && Object.keys(c).sort().join('|') === [...BATTERY_CELL_KEYS].sort().join('|')
    && typeof c.provider === 'string' && c.provider.length > 0
    && (c.model === null || typeof c.model === 'string')
    && (c.effort === null || typeof c.effort === 'string')
    && typeof c.category === 'string' && c.category.length > 0
    && Number.isInteger(c.difficulty) && c.difficulty > 0
    && ['rated', 'pass', 'fixable', 'fail', 'phantom'].every((k) => count(c[k]))
    && c.pass + c.fixable + c.fail + c.phantom === c.rated
    && finiteOrNull(c.avgUsd) && finiteOrNull(c.avgDurationMs) && finiteOrNull(c.avgTokens)
    && /^\d{4}-\d{2}-\d{2}$/.test(c.lastRunDate));
}

let shippedCache = null;
function shippedFingerprint() {
  try { const st = statSync(BATTERIES_FILE); return `${st.size}:${st.mtimeMs}`; } catch { return 'none'; }
}
function shippedCells() {
  const key = shippedFingerprint();
  if (shippedCache?.key === key) return shippedCache.cells;
  const doc = readJson(BATTERIES_FILE);
  const cells = validBatteriesDocument(doc) ? doc.cells : [];
  shippedCache = { key, cells };
  return cells;
}
export function claimedWrites(items) { return (items || []).filter((i) => i.type === 'file_change').flatMap((i) => (i.changes || []).map((c) => c.path).filter(Boolean)); }
export function isPhantomCompletion({ ok, claimed = [], canVerify, observedCount }) { return !!ok && !!canVerify && claimed.length > 0 && observedCount === 0; }

const LEGACY_ENV_FAILURES = [
  'max iterations reached', 'UnauthorizedAccessException', 'access (?:was |is )?denied', 'permission denied', 'EACCES', 'EPERM',
  'waiting for network', 'Connection failed', 'ECONNRESET', 'ENOTFOUND', 'fetch failed', 'unexpected status 401',
  'Incorrect API key provided', 'refresh token was already used',
];
const PROVIDER_ENV_FAILURES = [
  '\\b(?:HTTP\\s*)?50[0234]\\b(?=.{0,48}\\b(?:status|error|unavailable|bad gateway|gateway timeout)\\b)',
  '\\b(?:status|error|unavailable|bad gateway|gateway timeout)\\b.{0,48}\\b50[0234]\\b',
  'status["\'\\s:=]+UNAVAILABLE\\b', // gRPC-style status; a bare "unavailable" in tool output is not a provider error
  'WinError 32', '\\bEBUSY\\b',
  'CUDA out of memory', 'CUDA error', 'llama-server', 'cudaMalloc',
  'quota rejected', 'rejected task at startup',
];
const CLI_ENV_FAILURES = ['\\b(?:unknown option|unexpected argument)\\b', '\\brequires --\\w+', "\\binvalid value for '--"];
export const ENV_FAIL = new RegExp([...LEGACY_ENV_FAILURES, ...PROVIDER_ENV_FAILURES, ...CLI_ENV_FAILURES].join('|'), 'i');
const RESULT_ENV_FAIL = new RegExp([...LEGACY_ENV_FAILURES, ...PROVIDER_ENV_FAILURES].join('|'), 'i');
const FINAL_MESSAGE_ENV_FAIL = new RegExp(LEGACY_ENV_FAILURES.join('|'), 'i');
/** A worker or provider failure that belongs to the environment, not the model. */
export function envFailure(t) {
  if (t.failKind === 'auth' || t.failKind === 'env') return `${t.failKind === 'auth' ? 'sign-in' : 'harness'}: ${String(t.error || '').slice(0, 160)}`;
  const error = String(t.error || '');
  const errorHit = error.match(ENV_FAIL)?.[0];
  if (errorHit) return errorHit;
  const providerTexts = (t.result?.items || []).map((i) => String(i.text || i.output || ''));
  const finalMessage = String(t.result?.finalMessage || '');
  const hit = providerTexts.find((text) => RESULT_ENV_FAIL.test(text));
  return hit?.match(RESULT_ENV_FAIL)?.[0] || finalMessage.match(FINAL_MESSAGE_ENV_FAIL)?.[0] || null;
}

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
  const t = { in: 0, out: 0, cached: 0, write: 0, v: 2 };
  for (const e of entries) {
    const cached = Number(e.cached_input_tokens ?? e.cache_read_input_tokens ?? e.cacheReadInputTokens) || 0;
    const write = Number(e.cache_creation_input_tokens ?? e.cacheCreationInputTokens) || 0;
    const input = Number(e.input_tokens ?? e.inputTokens) || 0;
    t.in += 'inputTokens' in e || e.exclusive ? input : Math.max(0, input - cached); // exclusive: input already excludes cache reads
    t.out += Number(e.output_tokens ?? e.outputTokens) || 0;
    t.cached += cached;
    t.write += write;
  }
  return t;
}
// Rows written before v2 stored inclusive input for non-Claude providers.
const tokensOf = (r) => (!r.tokens ? null : r.tokens.v ? r.tokens : { ...r.tokens, in: r.provider === 'claude' ? r.tokens.in : Math.max(0, (r.tokens.in || 0) - (r.tokens.cached || 0)) });

/** Record one terminal worker run. tasks.mjs calls this after refreshing the provider's limits. */
export function recordRun(t, { before = null, concurrent = 0, concurrentByWindow = null } = {}) {
  if (t.imageOptions) return null;
  const requestedModel = t.model || null;
  const servedModel = t.result?.servedModel || null;
  const model = servedModel || requestedModel;
  const row = {
    op: 'run', ts: nowIso(), taskId: t.id, followUpOf: t.followUpOf || null, retryOf: t.retryOf || null, reroutedFrom: t.reroutedFrom || null, sessionId: t.sessionId || null, source: t.source || 'live',
    provider: t.provider, model, requestedModel, effort: t.effort || null, category: t.category || null, difficulty: t.difficulty || null,
    status: t.status, tokens: normalizeUsage(t.result?.usage), costUsd: t.result?.costUsd || 0, costBasis: LIST_COST_PROVIDERS.has(t.provider) && t.result?.costUsd > 0 ? 'list' : 'tokens', durationMs: t.result?.durationMs || 0, variant: t.variant || null,
    pct: windowDelta(before, snapshotWindows(t.provider)), concurrent, concurrentByWindow, title: t.title, smokeId: t.smokeId || null, failKind: t.failKind || null, rounds: t.rounds ?? null,
    tools: t.result?.tools || null, repoFiles: t.repoFiles ?? null, repoBytes: t.repoBytes ?? null, // capability use + project size (plan Part H4): scored later as a view
    cliVersion: cliVersionOf(t.provider), servedModel, // cached --version (SDK for claude); the model the CLI says it ran
  };
  appendNdjson(FILE(), row);
  bus.publish('score', { taskId: t.id, provider: t.provider, model: row.model, pct: row.pct });
  return row;
}

/** The conductor's verdict. Any task id in a fix-round chain rates that attempt. */
export function rateTask(taskId, verdict, notes = '') {
  if (verdict === 'void') return voidTask(taskId, notes || 'voided by the conductor'); // not the model's doing (harness, sign-in, bad fixture)
  if (!VERDICTS.includes(verdict)) throw Object.assign(new Error(`verdict must be one of ${[...VERDICTS, 'void'].join('|')}`), { status: 400 });
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

/** Correct a run's identity, or restore a voided run, without rewriting its ledger row. */
export function amendTask(taskId, patch = {}) {
  const row = { op: 'amend', ts: nowIso(), taskId: String(taskId) };
  if (Object.hasOwn(patch, 'model')) row.model = patch.model == null ? null : String(patch.model);
  if (Object.hasOwn(patch, 'effort')) row.effort = patch.effort == null ? null : String(patch.effort);
  if (patch.unvoid) row.unvoid = true;
  row.reason = String(patch.reason || '').slice(0, 400);
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
  let all; try { all = allRows(); } catch { return 0; }
  const voided = new Set(); for (const r of all) if (r.op === 'void') voided.add(r.taskId);
  let n = 0;
  for (const r of all) {
    if (r.op !== 'run' || r.provider !== 'antigravity' || !r.effort) continue;
    if (r.requestedModel && r.servedModel === r.model && r.model === `${r.requestedModel}-${r.effort}`) continue; // current Method-C dispatch: exact served id + logical requested family
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
const addTok = (a, b) => { if (b) for (const k of ['in', 'out', 'cached', 'write']) a[k] += b[k] || 0; };

/**
 * Fold the log into chains. An *attempt* is a task plus its fix rounds (followUpOf); a *chain* is the
 * attempts linked by retryOf (a new model after a fail). Each chain: { taskId, category, difficulty,
 * source, attempts[], path[], verdict (last attempt), tokens, usd, durationMs, rounds }.
 */
/** Non-voided run rows from the ledger (for the budget planner: measuredCost needs pct + concurrent per run). */
// runRows() is hit on every schedule() pass (and by the estimator); the scorecard ndjson grows unbounded, so cache
// the parse and reuse it until the file's size/mtime changes (any appendNdjson bumps both, invalidating the cache).
let _runRowsCache = null;
const foldRunRows = (all) => {
  const voided = new Set(), amendments = new Map();
  for (const r of all) {
    if (r.op === 'void') voided.add(r.taskId);
    else if (r.op === 'amend') {
      const amendment = amendments.get(r.taskId) || {};
      if (Object.hasOwn(r, 'model')) amendment.model = r.model;
      if (Object.hasOwn(r, 'effort')) amendment.effort = r.effort;
      amendments.set(r.taskId, amendment);
      if (r.unvoid) voided.delete(r.taskId);
    }
  }
  const allRunRows = all.filter((r) => r.op === 'run').map((r) => amendments.has(r.taskId) ? { ...r, ...amendments.get(r.taskId) } : r);
  return { rows: allRunRows.filter((r) => !voided.has(r.taskId)), allRunRows, voided };
};
function loadLedger() {
  try {
    const st = statSync(FILE());
    if (_runRowsCache && _runRowsCache.mtimeMs === st.mtimeMs && _runRowsCache.size === st.size) return _runRowsCache;
    const all = readNdjson(FILE());
    return _runRowsCache = { mtimeMs: st.mtimeMs, size: st.size, ...foldRunRows(all), all };
  } catch {
    const all = readNdjson(FILE());
    return { ...foldRunRows(all), all };
  }
}
export function runRows() { return loadLedger().rows; }
// P3: reuse the same cached parse (rate/void rows live in `all`, not in runRows). Callers do not mutate.
function allRows() { return loadLedger().all; }

const normalizedEligibilitySel = (value) => {
  const parsed = parseSel(String(value || '').trim());
  if (!parsed.provider || (!parsed.model && !String(value || '').includes(':default'))) return null;
  return selOf({ provider: parsed.provider, model: scorecardModelId(parsed.model), effort: parsed.effort });
};
const eligibilityKey = (sel, category) => `${String(sel).toLowerCase()}|${category}`;

/** Latest append-only manual routing decision per selection + category. */
export function eligibilityOverrides({ category = null } = {}) {
  const latest = new Map();
  for (const r of allRows()) {
    if (r.op !== 'eligibility' || !['block', 'allow'].includes(r.action) || !CATEGORIES.includes(r.category)) continue;
    const sel = normalizedEligibilitySel(r.sel); if (!sel) continue;
    latest.set(eligibilityKey(sel, r.category), { op: 'eligibility', sel, category: r.category, action: r.action, reason: String(r.reason || ''), ts: r.ts });
  }
  return [...latest.values()].filter((r) => !category || r.category === category).sort((a, b) => a.category.localeCompare(b.category) || a.sel.localeCompare(b.sel));
}

/** Append a manual routing decision. Explicit pins and probe work bypass this; only automatic recommendation reads it. */
export function setEligibility(sel, category, action, reason) {
  const normalized = normalizedEligibilitySel(sel);
  if (!normalized) throw Object.assign(new Error('sel must be provider:model[:effort]'), { status: 400 });
  if (!CATEGORIES.includes(category)) throw Object.assign(new Error(`category must be one of ${CATEGORIES.join('|')}`), { status: 400 });
  if (!['block', 'allow'].includes(action)) throw Object.assign(new Error('action must be block|allow'), { status: 400 });
  const why = String(reason || '').trim();
  if (!why) throw Object.assign(new Error('reason is required'), { status: 400 });
  const row = { op: 'eligibility', sel: normalized, category, action, reason: why.slice(0, 400), ts: nowIso() };
  appendNdjson(FILE(), row);
  bus.publish('score', { eligibility: row });
  return row;
}

let rootRunsMemo = null;
let summarizeMemo = null;

// Both derived views depend on the ledger, scorecard settings, and model registry. Keep the key construction in
// one place so a caller never receives a view computed from a stale version of any of those inputs.
function scorecardMemoKey(source) {
  const ledger = loadLedger();
  const cfg = loadConfig().scorecard;
  const reg = getModels();
  const shipped = (source == null || source === 'smoke') && cfg.shippedBatteries !== false && process.env.CONDUCTOR_NO_SHIPPED !== '1' ? shippedFingerprint() : 'off';
  return `${source || ''}|${ledger.size ?? 'none'}:${ledger.mtimeMs ?? 'none'}|${JSON.stringify(cfg)}|${reg.updatedAt || ''}|shipped:${shipped}`;
}

export function rootRuns({ source = null } = {}) {
  const key = scorecardMemoKey(source);
  if (rootRunsMemo?.key === key) return rootRunsMemo.rows;
  const out = rootRunsUncached({ source });
  rootRunsMemo = { key, rows: out };
  return out;
}

function rootRunsUncached({ source = null } = {}) {
  const ledger = loadLedger(), all = ledger.all;
  const runs = new Map(ledger.rows.map((r) => [r.taskId, r]));
  const rates = new Map(); const voided = ledger.voided;
  const allRuns = new Map(ledger.allRunRows.map((r) => [r.taskId, r])); // voided runs stay in the graph for retryOf links
  for (const [order, r] of all.entries()) if (r.op === 'rate') rates.set(r.taskId, { ...r, _order: order });
  const follow = (r, key) => { let cur = r; const seen = new Set(); while (cur[key] && runs.has(cur[key]) && !seen.has(cur.taskId)) { seen.add(cur.taskId); cur = runs.get(cur[key]); } return cur; };
  const cfg = loadConfig();
  const attempts = new Map();
  for (const r of runs.values()) {
    const root = follow(r, 'followUpOf');
    let a = attempts.get(root.taskId);
    if (!a) {
      // Antigravity reports its concrete family-effort id; the logical scorecard selection keeps effort separate.
      const dispatchedEffortId = root.provider === 'antigravity' && root.requestedModel && root.servedModel === root.model && root.model === `${root.requestedModel}-${root.effort}`;
      const model = scorecardModelId(dispatchedEffortId ? root.requestedModel : root.model);
      a = { ...root, model, sel: selOf({ ...root, model }), tokens: { in: 0, out: 0, cached: 0, write: 0 }, pct: null, usd: null, durationMs: 0, rounds: -1, members: [], verdict: null, notes: null };
      a.price = priceFor(root.provider, model, cfg);
      attempts.set(root.taskId, a);
    }
    a.rounds += 1; a.members.push(r.taskId); (a._rows ||= []).push(r);
    if (tokensOf(r)) a._anyUsage = true;
    addTok(a.tokens, tokensOf(r));
    a.durationMs += r.durationMs || 0;
    if (r.pct) { a.pct = a.pct || {}; for (const [k, v] of Object.entries(r.pct)) a.pct[k] = (a.pct[k] || 0) + v; }
  }
  for (const a of attempts.values()) {
    const rated = a.members.map((id) => rates.get(id)).filter(Boolean).reduce((latest, rate) =>
      !latest || rate.ts > latest.ts || (rate.ts === latest.ts && rate._order > latest._order) ? rate : latest, null);
    a.verdict = rated?.verdict || (a.status === 'failed' ? 'fail' : null);
    a.notes = rated?.notes || null;
    // D7: no run reported usage → cost unknown, EXCEPT when all prices are zero (local model: $0 is real).
    const priceAllZero = a.price && a.price.in === 0 && a.price.out === 0 && (a.price.cached ?? 0) === 0;
    const listCost = LIST_COST_PROVIDERS.has(a.provider) && a._rows.every((r) => r.provider === a.provider && r.costUsd > 0);
    a.usd = listCost ? a._rows.reduce((total, r) => total + r.costUsd, 0) : (a.unmeasured ? null : (!a._anyUsage && !priceAllZero ? null : usdFor(a.tokens, a.price))); // a verdict recorded for a run made outside Conductor counts for quality, never for cost
    a.costBasis = a.usd == null ? null : (listCost ? 'list' : 'tokens');
    delete a._rows;
  }
  const attemptMeans = new Map();
  for (const a of attempts.values()) {
    if (a.usd == null || !a.category || !a.difficulty) continue;
    const key = [a.sel, a.category, a.difficulty].join('|');
    const xs = attemptMeans.get(key) || []; xs.push(a.usd); attemptMeans.set(key, xs);
  }
  for (const [key, xs] of attemptMeans) attemptMeans.set(key, mean(xs));
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
    c.tokens = { in: 0, out: 0, cached: 0, write: 0 }; c.durationMs = 0; c.rounds = 0; c.pct = null;
    let usd = 0, priced = 0;
    for (const a of c.attempts) { addTok(c.tokens, a.tokens); c.durationMs += a.durationMs; c.rounds += a.rounds; if (a.usd != null) { usd += a.usd; priced++; } if (a.pct) { c.pct = c.pct || {}; for (const [k, v] of Object.entries(a.pct)) c.pct[k] = (c.pct[k] || 0) + v; } }
    c.partialCost = false;
    if (!priced) c.usd = null;
    else {
      for (const a of c.attempts) if (a.usd == null) {
        const estimate = attemptMeans.get([a.sel, a.category || c.category, a.difficulty || c.difficulty].join('|'));
        if (estimate == null) { c.partialCost = true; break; }
        usd += estimate;
      }
      c.usd = c.partialCost ? null : usd;
    }
    c.provider = last.provider; c.model = last.model; c.effort = last.effort; c.status = last.status;
    out.push(c);
  }
  return out;
}

/**
 * Aggregate. Single-step rows (one per model/effort × category/difficulty, counting every attempt)
 * and path rows (ladders actually observed, e.g. "codex:luna:low>codex:terra:medium").
 */
export function summarize({ source = null, archived = false, shipped = true } = {}) {
  const key = `${scorecardMemoKey(source)}|archived:${archived ? 1 : 0}|shipped:${shipped ? 1 : 0}`;
  if (summarizeMemo?.key === key) return summarizeMemo.rows;
  const out = summarizeUncached({ source, archived, shipped });
  summarizeMemo = { key, rows: out };
  return out;
}

const summarySort = (a, b) => a.category.localeCompare(b.category) || a.difficulty - b.difficulty || a.steps - b.steps || (b.quality ?? -1) - (a.quality ?? -1);

function shippedSummary(c) {
  const sel = selOf(c), quality = c.rated ? (c.pass * SCORE.pass + c.fixable * SCORE.fixable) / c.rated : null;
  return {
    sel, steps: 1, provider: c.provider, model: c.model, effort: c.effort, category: c.category, difficulty: c.difficulty,
    n: c.rated, rated: c.rated, pass: c.pass, fixable: c.fixable, fail: c.fail, phantom: c.phantom,
    cost: modelInRegistry(getModels(), c.provider, c.model)?.cost || null, priorTier: priorFor(c.provider, c.model, c.category)?.tier || null,
    quality, accept: c.rated ? (c.pass + c.fixable) / c.rated : null, avgTokens: c.avgTokens, avgUsd: c.avgUsd,
    pricedShare: null, avgPct: null, avgDurationMs: c.avgDurationMs, avgRounds: null,
    errorRate: c.rated ? (c.fail + c.phantom) / c.rated : null, phantomRate: c.rated ? c.phantom / c.rated : null,
    last: c.lastRunDate, shipped: true,
  };
}

function mergeShipped(local, archive) {
  const occupied = new Set(local.filter((g) => g.steps === 1).map((g) => [g.sel, g.category, g.difficulty].join('|')));
  const fallback = shippedCells().filter((c) => !isArchived(c.provider, c.model, archive)).map(shippedSummary)
    .filter((g) => !occupied.has([g.sel, g.category, g.difficulty].join('|')));
  return [...local, ...fallback].sort(summarySort);
}

function summarizeUncached({ source = null, archived = false, shipped = true } = {}) {
  const archive = archivedSet(loadConfig().scorecard);
  const groups = new Map();
  const add = (sel, steps, cat, diff, x) => {
    const key = [sel, cat, diff].join('|');
    let g = groups.get(key);
    if (!g) { g = { sel, steps, category: cat, difficulty: diff, n: 0, rated: 0, liveN: 0, liveRated: 0, smokeN: 0, smokeRated: 0, pass: 0, fixable: 0, fail: 0, phantom: 0, _tok: [], _usd: [], _pct: [], _dur: [], _rounds: [], _priced: 0, _attempts: 0 }; groups.set(key, g); }
    g.n++;
    const source = x.source === 'smoke' ? 'smoke' : 'live';
    g[source + 'N']++;
    if (x.ts && (!g.last || x.ts > g.last)) g.last = x.ts;
    if (x.verdict) { g.rated++; g[source + 'Rated']++; g[x.verdict]++; }
    g._tok.push(x.tokens.in + x.tokens.out + x.tokens.cached);
    if (x.usd != null) g._usd.push(x.usd);
    const xs = x.attempts || [x]; g._attempts += xs.length; g._priced += xs.filter((a) => a.usd != null).length;
    const p = maxPct(x.pct); if (p != null) g._pct.push(p);
    g._dur.push(x.durationMs); g._rounds.push(x.rounds);
    return g;
  };
  for (const c of rootRuns({ source })) {
    const chainArchived = c.attempts.some((a) => isArchived(a.provider, a.model, archive));
    for (const a of c.attempts) {
      if (isArchived(a.provider, a.model, archive) !== archived) continue;
      // B3: score each attempt under its own category/difficulty; skip attempts without tags (an untagged
      // head must not silence a tagged replacement). Fall back to chain tags only when the attempt lacks them.
      const cat = a.category || c.category;
      const diff = a.difficulty || c.difficulty;
      if (!cat || !diff) continue;
      const g = add(a.sel, 1, cat, diff, a); g.provider = a.provider; g.model = a.model; g.effort = a.effort;
    }
    // The multi-step observed ladder row is chain-level: it must have chain-level tags.
    if (c.attempts.length > 1 && c.category && c.difficulty && chainArchived === archived) {
      const g = add(c.path.join('>'), c.attempts.length, c.category, c.difficulty, c);
      g._stepCosts ||= c.attempts.map(() => []);
      c.attempts.forEach((a, i) => g._stepCosts[i].push({ sel: a.sel, avgUsd: a.usd, avgDurationMs: a.durationMs }));
    }
  }
  const local = [...groups.values()].map(({ _tok, _usd, _pct, _dur, _rounds, _stepCosts, _priced, _attempts, ...g }) => {
    const cost = g.steps === 1 ? modelInRegistry(getModels(), g.provider, g.model)?.cost || null : null;
    const prior = g.steps === 1 ? priorFor(g.provider, g.model, g.category) : null;
    const quality = g.rated ? (g.pass * SCORE.pass + g.fixable * SCORE.fixable) / g.rated : null;
    return {
      ...g, cost, priorTier: prior?.tier || null, quality, accept: g.rated ? (g.pass + g.fixable) / g.rated : null,
      ...(_stepCosts ? { stepCosts: _stepCosts.map((costs) => ({ sel: costs[0].sel, avgUsd: meanKnown(costs.map((c) => c.avgUsd)), avgDurationMs: mean(costs.map((c) => c.avgDurationMs)) })) } : {}),
      avgTokens: mean(_tok), avgUsd: mean(_usd), pricedShare: _attempts ? _priced / _attempts : null, avgPct: cost === 'free-local' ? 0 : mean(_pct), avgDurationMs: mean(_dur), avgRounds: mean(_rounds),
      errorRate: g.rated ? (g.fail + g.phantom) / g.rated : null, phantomRate: g.rated ? g.phantom / g.rated : null,
    };
  }).sort(summarySort);
  const cfg = loadConfig().scorecard;
  const useShipped = shipped && !archived && (source == null || source === 'smoke') && cfg.shippedBatteries !== false && process.env.CONDUCTOR_NO_SHIPPED !== '1';
  return useShipped ? mergeShipped(local, archive) : local;
}

/** Distill local smoke evidence into the aggregate-only shipped battery schema. */
export function distillBatteries({ out = null } = {}) {
  const file = out ? resolve(out) : BATTERIES_FILE;
  const cells = summarize({ source: 'smoke', shipped: false })
    .filter((g) => g.steps === 1 && g.rated > 0 && g.last)
    .map((g) => ({
      provider: g.provider, model: g.model, effort: g.effort, category: g.category, difficulty: g.difficulty,
      rated: g.rated, pass: g.pass, fixable: g.fixable, fail: g.fail, phantom: g.phantom,
      avgUsd: g.avgUsd, avgDurationMs: g.avgDurationMs, avgTokens: g.avgTokens, lastRunDate: String(g.last).slice(0, 10),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || String(a.model).localeCompare(String(b.model)) || String(a.effort).localeCompare(String(b.effort)) || a.category.localeCompare(b.category) || a.difficulty - b.difficulty);
  const previous = readJson(file);
  const unchanged = validBatteriesDocument(previous) && JSON.stringify(previous.cells) === JSON.stringify(cells);
  const doc = { schemaVersion: BATTERIES_SCHEMA_VERSION, generatedAt: unchanged ? previous.generatedAt : nowIso(), cells };
  if (!validBatteriesDocument(doc)) throw new Error('refusing to write invalid shipped battery aggregates');
  if (!unchanged) writeJson(file, doc);
  return { file, cells: cells.length, bytes: statSync(file).size, document: doc };
}

export function errorRates({ source = null, archived = false } = {}) {
  const archive = archivedSet(loadConfig().scorecard);
  const models = new Map(), providers = new Map();
  for (const c of rootRuns({ source })) for (const a of c.attempts) if (a.verdict && isArchived(a.provider, a.model, archive) === archived) {
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
export function recommend(opts = {}) {
  const explanation = opts.explain ? {} : null;
  const eligibility = new Map(eligibilityOverrides({ category: opts.category }).map((r) => [eligibilityKey(r.sel, r.category), r]));
  const pick = withLimitsSnapshot(() => recommendPlan({ ...opts, _explain: explanation, _eligibility: eligibility }));
  if (!opts.explain) return pick;
  const manualEligibility = [...eligibility.values()];
  if (pick) return { pick, explain: { status: 'picked', reason: pick.reason, capped: [], manualEligibility } };
  if (explanation.status) return { pick: null, explain: { ...explanation, manualEligibility } };
  const blocked = manualEligibility.filter((r) => r.action === 'block');
  if (blocked.length) return { pick: null, explain: { status: 'eligibility', reason: blocked.map((r) => `${r.sel} manually blocked: ${r.reason}`).join('; '), capped: [], manualEligibility } };
  return { pick: null, explain: { status: 'no-match', reason: `no qualified selection for ${opts.category}@${opts.difficulty ?? 2}`, capped: [], manualEligibility } };
}

function recommendPlan({ category, difficulty = 2, exclude = [], source = null, summary = null, escalate = false, overflowApi = false, providers = null, reg = getModels(), _noExtrap = false, _failedBelow = null, _taskDifficulty = null, _explain = null, _eligibility = new Map() } = {}) {
  const cfg = loadConfig().scorecard;
  const archive = archivedSet(cfg);
  const taskDifficulty = _taskDifficulty ?? difficulty;
  // Per-call memos: availability and weight read the limits registry (a stat each); the summary has hundreds of rows per sel.
  const memo = (fn) => { const m = new Map(); return (...a) => { const k = a.join('|'); if (!m.has(k)) m.set(k, fn(...a)); return m.get(k); }; };
  const avail = memo((provider, model) => providerAvailable(provider, { overflowApi, cfg, model }));
  const weight = memo((provider, model) => providerWeight(provider, cfg, model));
  const waste = memo((provider, model) => wasteDiscount(provider, cfg, model));
  const lambda = cfg.qualityValueUsd, hourly = cfg.hourlyUsd;
  const excluded = (sel) => sel.split('>').some((s) => { const { provider, model } = parseSel(s); return exclude.includes(s) || exclude.includes(`${provider}:${model || 'default'}`); });
  const blockedSel = (sel) => sel.split('>').some((s) => {
    const { provider, model } = parseSel(s);
    // A transient registry error retains cached models; explicit unavailability or removal does not.
    return reg.providers[provider]?.status === 'unavailable' || modelInRegistry(reg, provider, model)?.kind !== 'agent' || !avail(provider, model);
  });
  const unavailable = (g) => {
    const { provider, model } = g;
    if (reg.providers[provider]?.status === 'unavailable') return { sel: g.sel, reason: 'provider unavailable', resetAt: null };
    if (modelInRegistry(reg, provider, model)?.kind !== 'agent') return { sel: g.sel, reason: 'model unavailable', resetAt: null };
    const blockedUntil = modelBlockedUntil(provider, model);
    if (blockedUntil) return { sel: g.sel, reason: 'provider limit', resetAt: blockedUntil };
    const cls = providerClass(provider, cfg);
    if (cls === 'api' && !overflowApi) return { sel: g.sel, reason: 'API overflow off', resetAt: null };
    const cap = cfg.classCap?.[cls] ?? 100;
    const windows = providerWindows(provider, model).filter((w) => (!w.resetsAt || w.resetsAt > Date.now()) && (cls !== 'conductor' || isSession(w)));
    const capped = windows.filter((w) => (Number(w.usedPercent) || 0) >= cap);
    const resets = capped.map((w) => Number(w.resetsAt)).filter((t) => Number.isFinite(t) && t > Date.now());
    return { sel: g.sel, reason: capped.length ? `${cls} class cap` : 'unavailable', resetAt: resets.length ? Math.min(...resets) : null };
  };
  const all = (summary || summarize({ source })).filter((g) => g.difficulty <= ROUTED_MAX_DIFFICULTY && !g.sel.split('>').some((s) => { const p = parseSel(s); return isArchived(p.provider, p.model, archive); }));
  const cellLiveN = (g) => g.liveN ?? (g.smokeN != null ? 0 : g.n ?? 0); // old and hand-built summaries without source counts are live
  const cellLiveRated = (g) => g.liveRated ?? (g.smokeRated != null ? 0 : g.rated ?? cellLiveN(g));
  const cellSmokeRated = (g) => g.smokeRated ?? 0;
  const allowed = (sel) => !providers || sel.split('>').every((s) => providers.includes(s.split(':')[0])); // access gate: only these providers may take the task
  const decision = (sel) => _eligibility.get(eligibilityKey(sel, category));
  const manuallyBlocked = (sel) => sel.split('>').some((s) => decision(s)?.action === 'block');
  const gate = passGate(category, reg);
  const rows = all.filter((g) => g.category === category && g.rated > 0 && !excluded(g.sel) && !manuallyBlocked(g.sel) && !blockedSel(g.sel) && allowed(g.sel) && gate(g.sel));
  // Measured ceiling per provider (any category): the highest level it has cleared with enough samples.
  const ceiling = new Map();
  for (const g of all) if (g.steps === 1 && g.rated >= cfg.minSamples && g.quality >= cfg.quality) ceiling.set(g.provider, Math.max(ceiling.get(g.provider) || 0, g.difficulty));
  const reserve = (provider, model = null) => { const w = weight(provider, model); const gap = Math.max(0, (ceiling.get(provider) || 0) - taskDifficulty); return 1 + cfg.reservePct * w * gap; };
  const costOf = (g) => {
    const costs = g.stepCosts || [g];
    if (costs.some((c) => c.avgUsd == null)) return null;
    return costs.reduce((sum, c) => {
      const { provider, model } = parseSel(c.sel.split('>').at(-1));
      const scale = weight(provider, model) * reserve(provider, model) * waste(provider, model);
      return sum + c.avgUsd * scale + hourly * (c.avgDurationMs || 0) / 3.6e6;
    }, 0);
  };
  // Evidence per selection: the cell nearest the requested level (not below), pooling harder cells only until
  // the sample floor is met. A well-sampled failing cell at or below the level disqualifies it as a final step.
  // Keep the original request's disqualifications when extrapolating; priors cannot override them either.
  const failedBelow = _failedBelow || new Set(all.filter((g) => g.category === category && g.difficulty <= difficulty && g.rated >= cfg.benchMinSamples && g.quality < cfg.quality && decision(g.sel)?.action !== 'allow').map((g) => g.sel));
  const bySel = new Map();
  for (const g of rows) {
    const m = bySel.get(g.sel) || { sel: g.sel, steps: g.steps, cells: [] };
    if (g.difficulty >= difficulty) m.cells.push(g);
    bySel.set(g.sel, m);
  }
  const evidence = [...bySel.values()].filter((m) => m.cells.length).map((m) => ({ ...m, ref: pool(m.cells.sort((a, b) => a.difficulty - b.difficulty), cfg.minSamples) })).filter((m) => m.ref.rated >= cfg.minSamples);
  const finals = evidence.filter((m) => m.ref.quality >= cfg.quality && !failedBelow.has(m.sel) && !failedBelow.has(m.sel.split('>').at(-1)));
  // M4: extrapolation may build a plan from a lower-level pool. Once this selection has enough evidence at the
  // task's actual level, that cell owns the estimated ladder's probability of accepting the first step.
  const taskLevelAccept = (m) => m.cells.find((c) => c.difficulty === taskDifficulty && c.rated >= cfg.minSamples)?.accept ?? m.ref.accept;
  const plans = [];
  for (const m of finals) {
    if (m.steps === 1) {
      plans.push({ steps: m.ref.sel.split('>'), quality: m.ref.quality, usd: costOf(m.ref), estimated: false, ref: m.ref });
      continue;
    }
    // Observed A>B is B given A failed (and costs both steps). Combine with A's single-step stats.
    const aSel = m.sel.split('>')[0];
    const aEv = evidence.find((x) => x.steps === 1 && x.sel === aSel);
    if (!aEv) {
      plans.push({ steps: m.ref.sel.split('>'), quality: m.ref.quality, usd: costOf(m.ref), estimated: false, ref: m.ref });
      continue;
    }
    const pA = aEv.ref.accept ?? 0;
    const quality = aEv.ref.quality + (1 - pA) * m.ref.quality;
    const cA = costOf(aEv.ref);
    const cB = m.ref.stepCosts?.length > 1 ? costOf({ ...m.ref, stepCosts: m.ref.stepCosts.slice(1) }) : (cA != null && costOf(m.ref) != null ? costOf(m.ref) - cA : null);
    const usd = cA == null || cB == null ? null : cA + (1 - pA) * cB;
    plans.push({ steps: m.ref.sel.split('>'), quality, usd, estimated: false, ref: m.ref });
  }
  for (const a of evidence.filter((m) => m.steps === 1 && costOf(m.ref) != null)) {
    for (const b of finals.filter((m) => m.steps === 1 && m.sel !== a.sel && costOf(m.ref) != null)) {
      if (evidence.some((m) => m.sel === `${a.sel}>${b.sel}`)) continue; // observed ladder has minSamples — keep the estimate only while it does not
      const pA = taskLevelAccept(a);
      const combinedQuality = a.ref.quality + (1 - pA) * b.ref.quality;
      // H2/B1: only push the estimated pair when its combined quality clears the bar.
      // A below-bar first step whose combination still clears the bar is allowed.
      if (combinedQuality < cfg.quality) continue;
      plans.push({ steps: [a.sel, b.sel], quality: combinedQuality, usd: costOf(a.ref) + (1 - pA) * costOf(b.ref), estimated: true, ref: a.ref, fallbackRef: b.ref });
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
  const evidenceRank = (p) => {
    const live = cellLiveRated(p.ref);
    return live > 0 ? { live: 1, count: live } : { live: 0, count: cellSmokeRated(p.ref) };
  };
  const tier = (p) => TIER_CEILING[p.ref.priorTier] || 0;
  const sortCmp = escalate
    ? (x, y) => (evidenceRank(y).live - evidenceRank(x).live) || (evidenceRank(y).count - evidenceRank(x).count) || (tier(y) - tier(x)) || (y.utility - x.utility)
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
    // Escalation is the last rung before the conductor does it itself: cells with live rated evidence rank first by
    // that count; otherwise smoke-only cells rank by smoke evidence. Prior tier and utility break the remaining ties,
    // regardless of budget class. Prefer a single model so a cheap-first ladder does not re-dispatch a failed rung.
    best = plans.find((p) => p.utility > -Infinity && p.steps.length === 1) || plans.find((p) => p.utility > -Infinity) || null;
    bestClass = best ? classOf(best) : null;
  } else {
    // B7: a class must be listed in classOrder to be eligible — no fallback for unlisted classes.
    for (const cls of cfg.classOrder || []) { best = plans.find((p) => p.utility > -Infinity && classOf(p) === cls); if (best) { bestClass = cls; break; } }
  }
  if (!best) {
    // A provider proven at this level exists but is capped/blocked/excluded: hand the task back (the conductor does it or
    // waits for a reset) rather than extrapolating to a weaker class. Extrapolate only when nothing at all is proven here.
    // B5: also require allowed(g.sel) so a blocked but disallowed provider does not prevent extrapolation.
    // B2: ignore cells whose model is not a registered agent — an old removed model must not prevent extrapolation.
    const capped = all.filter((g) => g.category === category && g.steps === 1 && g.difficulty >= difficulty && g.rated >= cfg.minSamples && g.quality >= cfg.quality && !excluded(g.sel) && !manuallyBlocked(g.sel) && allowed(g.sel) && gate(g.sel) && modelInRegistry(reg, g.provider, g.model)?.kind === 'agent' && blockedSel(g.sel));
    if (capped.length) {
      if (_explain) {
        const bySel = new Map(capped.map((g) => [g.sel, unavailable(g)]));
        _explain.status = 'capped';
        _explain.reason = `qualified selections for ${category}@${difficulty} are unavailable`;
        _explain.capped = [...bySel.values()].sort((a, b) => (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity) || a.sel.localeCompare(b.sel));
      }
      return _noExtrap ? { capped: true } : null;
    }
    // Nothing proven at this level or above: extrapolate from the nearest lower level (flagged) before the prior.
    for (let d = difficulty - 1; d >= 1 && !_noExtrap; d--) {
      const lower = recommendPlan({ category, difficulty: d, exclude, source, summary: all, escalate, overflowApi, providers, reg, _noExtrap: true, _failedBelow: failedBelow, _taskDifficulty: taskDifficulty, _explain, _eligibility });
      if (lower?.capped) return null;
      if (lower?.plan) return { ...lower, reason: `${lower.reason}; extrapolated from level ${d} — nothing measured at level ${difficulty}+ yet` };
    }
    return priorFallback({ category, difficulty, exclude, cfg, overflowApi, providers, reg, failedBelow, escalate, eligibility: _eligibility });
  }
  const first = parseSel(best.steps[0]);
  const money = (v) => (v == null ? 'cost unknown' : `$${v.toFixed(v < 0.1 ? 3 : 2)}`);
  const describe = (p) => { const lastSel = p.steps[p.steps.length - 1]; const { provider: prov, model: provModel } = parseSel(lastSel); const rs = reserve(prov, provModel); return `${p.steps.join(' then on fail ')}: expected quality ${p.quality.toFixed(2)} at ${money(p.usd)}${p.estimated ? ' (est.)' : ''}${p.ref.cells > 1 ? ` [levels ${p.ref.difficulty}–${p.ref.difficultyMax} pooled]` : ''}${rs > 1 ? ` [reserve ×${rs.toFixed(2)}: ${prov} proven to level ${ceiling.get(prov)}]` : ''}`; };
  const single = plans.find((p) => p.steps.length === 1);
  const alt = plans.slice(1, 4).map(describe);
  return {
    provider: first.provider, model: first.model, effort: first.effort,
    fallback: best.fallbackRef ? { provider: best.fallbackRef.provider, model: best.fallbackRef.model, effort: best.fallbackRef.effort } : best.steps.length > 1 ? parseSel(best.steps[1]) : null,
    plan: { steps: best.steps, quality: best.quality, usd: best.usd, estimated: best.estimated, utility: best.utility },
    class: bestClass,
    reason: `${bestClass ? `class ${bestClass} · ` : ''}${escalate ? 'escalation: strongest evidence (live first, count, prior tier, utility; any class)' : 'best value'} for ${category}@${difficulty} (λ=${lambda}/quality point): ${describe(best)}${best.steps.length > 1 && single && single !== best ? `; best single model ${describe(single)}` : ''}${best.estimated ? '; ladder estimate assumes independent failures' : ''}${best.costUnknown ? ' [cost unknown]' : ''}${decision(best.steps[0])?.action === 'allow' ? ` [manual allow: ${decision(best.steps[0]).reason}]` : ''}`,
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
  const ws = providerWindows(provider, model).filter((w) => (!w.resetsAt || w.resetsAt > Date.now()) && (!sessionOnly || isSession(w)));
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
 * Use-it-or-lose-it cost discount in [0, 1]. A subscription's weekly/monthly window that resets soon loses unused
 * quota at reset, so discount its cost by absolute time steps and let the planner prefer it while
 * quality still leads. Only fixed-quota subscription classes (not API, which bills per token, nor the conductor's own
 * plan, which keeps a buffer). 5-hour windows churn constantly and are ignored — the waste that matters is the weekly.
 */
export function wasteDiscount(provider, cfg = loadConfig().scorecard, model = null, now = Date.now()) {
  const cls = providerClass(provider, cfg);
  if (cls !== 'subscription' && cls !== 'included') return 1;
  const strength = Math.min(1, Math.max(0, cfg.wasteStrength ?? DEFAULTS.scorecard.wasteStrength));
  let steps = (Array.isArray(cfg.wasteSteps) ? cfg.wasteSteps : DEFAULTS.scorecard.wasteSteps).map((s) => [...s]);
  if (!Array.isArray(cfg.wasteSteps) && Number.isFinite(cfg.wasteHorizonHours)) {
    const horizon = Math.max(1, cfg.wasteHorizonHours);
    steps[0][0] = horizon;
    steps = steps.filter(([hours]) => hours <= horizon).sort((a, b) => b[0] - a[0]);
  }
  const discount = (ms) => {
    const step = Math.max(0, ...steps.filter((s) => ms > 0 && ms <= s[0] * 3600e3).map((s) => s[1]));
    return 1 - step * strength;
  };
  let factor = 1;
  // B4: track whether any real (non-session) window with a resetsAt exists for this provider.
  let hasRealWindow = false;
  for (const w of providerWindows(provider, model)) {
    if (!w.resetsAt) continue;
    if (isSession(w)) continue; // ignore the 5-hour churn
    hasRealWindow = true;
    factor = Math.min(factor, discount(w.resetsAt - now));
  }
  // Windowless provider (Grok, …): no real weekly window drove a discount, so fall back to a configured reset schedule.
  // B4: apply the schedule fallback only when the provider has no real non-session window.
  if (!hasRealWindow) { const sched = nextScheduledReset(provider, cfg, now); if (sched) factor = discount(sched - now); }
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
    const resetHour = Number(s.resetHour) || 0, resetMinute = Number(s.resetMinute) || 0;
    const d = new Date(now);
    d.setHours(resetHour, resetMinute, 0, 0);
    if (s.resetDay != null) {
      const delta = (((Number(s.resetDay) - d.getDay()) % 7) + 7) % 7;
      d.setDate(d.getDate() + delta);
      // B10: re-apply setHours after setDate — DST spring-forward can shift the hour into the gap.
      d.setHours(resetHour, resetMinute, 0, 0);
    }
    if (dir > 0) { while (d.getTime() <= now) { d.setDate(d.getDate() + step); d.setHours(resetHour, resetMinute, 0, 0); } }        // first reset strictly after now
    else { while (d.getTime() > now) { d.setDate(d.getDate() - step); d.setHours(resetHour, resetMinute, 0, 0); } }                 // last reset at or before now
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
const modelInRegistry = (reg, provider, model) => {
  const id = scorecardModelId(model);
  return reg.models.find((m) => m.provider === provider && (scorecardModelId(m.id) === id || scorecardModelId(m.resolved) === id));
};
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
  const total = (key, fallback = () => 0) => used.reduce((sum, c) => sum + (c[key] ?? fallback(c)), 0);
  return {
    ...base, ...(stepCosts ? { stepCosts } : {}), cells: used.length, difficulty: base.difficulty, difficultyMax: used[used.length - 1].difficulty,
    rated, n: total('n'), liveN: total('liveN', (c) => c.smokeN != null ? 0 : c.n), liveRated: total('liveRated', (c) => c.smokeRated != null ? 0 : c.rated),
    smokeN: total('smokeN'), smokeRated: total('smokeRated'), quality: w('quality', 'rated'), accept: w('accept', 'rated'), avgUsd: w('avgUsd', 'n'), avgDurationMs: w('avgDurationMs', 'n'),
  };
}

// Single source of truth for effort ordering (low -> ultra). Everything that ranks effort imports this;
// omitting `ultra` here (as an older copy did) made ultra rank -1, so a model's top effort could never cold-start.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
// Desired cold-start effort per difficulty. Hard tasks deserve more thinking; the measured path takes over
// (and can down-shift on cost via effort dominance) once verdicts exist. Clamped to what the model offers.
/** Cold-start effort: the highest effort the model offers that does not exceed the difficulty's target. */
export function priorEffort(efforts, difficulty) {
  const ranked = EFFORTS.filter((e) => (efforts || []).includes(e));
  if (!ranked.length) return null;
  const map = loadConfig().scorecard?.difficultyEffort || DEFAULTS.scorecard.difficultyEffort;
  const wantIdx = EFFORTS.indexOf(map[difficulty] || 'medium');
  let pick = ranked[0];
  for (const e of ranked) if (EFFORTS.indexOf(e) <= wantIdx) pick = e;
  return pick;
}

/** Effort for a task the conductor routed by hand without an effort: the higher of the configured default and the difficulty target, clamped to what the model offers. */
export function effortForTask({ provider, model, difficulty, defaultEffort = null, reg = getModels() } = {}) {
  const m = modelInRegistry(reg, provider, model);
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
function priorFallback({ category, difficulty, exclude, cfg, overflowApi = false, providers = null, reg, failedBelow, escalate = false, eligibility = new Map() }) {
  if (cfg.coldStart !== 'priors' && KIND[category] !== 'visual') return null;
  const gate = passGate(category, reg);
  const cands = [], seen = new Set(), archive = archivedSet(cfg);
  for (const m of reg.models) {
    const model = scorecardModelId(m.id), key = `${m.provider}:${model}`;
    if (seen.has(key) || isArchived(m.provider, model, archive)) continue;
    seen.add(key);
    if (m.kind !== 'agent' || reg.providers[m.provider]?.status !== 'ok' || !providerAvailable(m.provider, { overflowApi, cfg, model })) continue;
    if (exclude.includes(key) || (providers && !providers.includes(m.provider))) continue;
    const p = priorFor(m.provider, model, category);
    if (!p?.tier || (TIER_CEILING[p.tier] || 0) < difficulty) continue;
    const price = priceFor(m.provider, model, { scorecard: cfg });
    if (!price) continue;
    const effort = (p.effort && (m.efforts || []).includes(p.effort) ? p.effort : null) || priorEffort(m.efforts, difficulty);
    const sel = selOf({ provider: m.provider, model, effort });
    const manual = eligibility.get(eligibilityKey(sel, category));
    if (manual?.action === 'block' || exclude.includes(sel) || failedBelow.has(sel) || !gate(sel)) continue;
    const cls = (cfg.classOrder || []).indexOf(providerClass(m.provider, cfg));
    // B8: skip candidates whose class is not in classOrder (consistent with B7: unlisted = not eligible).
    if (cls < 0) continue;
    cands.push({ provider: m.provider, model, effort, tier: p.tier, proxy: price.in + price.out, cls });
  }
  cands.sort(escalate
    ? (a, b) => a.tier.localeCompare(b.tier) || a.cls - b.cls || a.proxy - b.proxy
    : (a, b) => a.cls - b.cls || a.proxy - b.proxy || a.tier.localeCompare(b.tier)); // escalate: best tier first; else class walk, then price
  const best = cands[0];
  if (!best) return null;
  const manual = eligibility.get(eligibilityKey(selOf(best), category));
  return { provider: best.provider, model: best.model, effort: best.effort, fallback: null, plan: null, reason: `hand-picked prior only (no measured data for ${category}@${difficulty}): ${KIND[category] === 'visual' ? `cheapest model with a recorded ${category} PASS, at the effort that passed (${best.effort})` : `cheapest model whose ${KIND[category] || 'reason'} tier ${best.tier} covers level ${difficulty}, at ${best.effort || 'default'} effort`}${manual?.action === 'allow' ? ` [manual allow: ${manual.reason}]` : ''}`, alternatives: cands.slice(1, 4).map((c) => `${c.provider}:${c.model} (tier ${c.tier})`) };
}

/**
 * Short view (what the conductor gets by default): one line per category and level, levels collapsed when the
 * picks are identical: the best pick and the runner-up (recommend() again with the best pick's model excluded),
 * each with expected quality, $/task and flags. Then the benched cells (enough samples, below the quality bar):
 * a computed view of the ledger, never a second record. Memoised on the ledger, limits, models and config, since
 * 140 recommend() calls take seconds on a large ledger.
 */
let shortMemo = null;
const nextBlockEnd = (limits, now) => {
  const ends = [];
  for (const p of Object.values(limits.providers || {})) {
    if (Number.isFinite(p?.blockedUntil) && p.blockedUntil > now) ends.push(p.blockedUntil);
    if (Number.isFinite(p?.confirmedLimit?.blockedUntil) && p.confirmedLimit.blockedUntil > now) ends.push(p.confirmedLimit.blockedUntil);
    for (const w of p?.windows || []) if (Number.isFinite(w.resetsAt) && w.resetsAt > now) ends.push(w.resetsAt);
  }
  return ends.length ? Math.min(...ends) : null;
};

export function shortMemoKey({ source = null, limits = getLimits(), now = Date.now() } = {}) {
  const cfg = loadConfig().scorecard;
  const reset = nextBlockEnd(limits, now);
  let key = source + '|' + JSON.stringify(cfg) + '|' + (limits.updatedAt || '') + '|' + (getModels().updatedAt || '') + '|' + Math.floor(now / 3600e3) + '|' + (reset ?? 'none');
  try { const st = statSync(FILE()); key += '|' + st.size + ':' + st.mtimeMs; } catch { key += '|none'; }
  return key;
}

export function formatScoresShort({ source = null } = {}) {
  const cfg = loadConfig().scorecard;
  const key = shortMemoKey({ source });
  if (shortMemo?.key === key) return shortMemo.text;
  const all = summarize({ source });
  const manual = eligibilityOverrides();
  if (!all.length && cfg.coldStart !== 'priors' && !manual.length) return 'Scorecard is empty. Tag delegations with category/difficulty and rate them with rate_task, or run smoke_test on a model.';
  const money = (v) => (v == null ? 'unpriced' : '$' + v.toFixed(v < 0.1 ? 3 : 2));
  const sel = (r) => r.provider + ':' + (r.model || 'default') + ':' + (r.effort || 'default');
  const cell = (r) => {
    if (!r) return '-';
    if (!r.plan) return sel(r) + ' (hand-picked prior only)';
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
  const manualByCell = new Map(manual.map((r) => [eligibilityKey(r.sel, r.category), r]));
  const benched = all.filter((g) => g.steps === 1 && g.rated >= cfg.benchMinSamples && g.quality != null && g.quality < cfg.quality && manualByCell.get(eligibilityKey(g.sel, g.category))?.action !== 'allow');
  if (benched.length) {
    lines.push('', 'Benched (quality < ' + cfg.quality + ' over >= ' + cfg.benchMinSamples + ' rated; recommend() skips these cells; a better run lifts them):');
    for (const g of benched) lines.push('- ' + g.sel + ' ' + g.category + '@' + g.difficulty + ': q' + g.quality.toFixed(2) + ' over ' + g.rated + ' rated (' + g.pass + '/' + g.fixable + '/' + g.fail + '/' + g.phantom + ')' + (g.last ? ', last run ' + String(g.last).slice(0, 10) : ''));
  }
  if (manual.length) {
    lines.push('', 'Manual eligibility (latest per selection + category):');
    for (const r of manual) lines.push(`- ${r.action.toUpperCase()} ${r.sel} for ${r.category}: ${r.reason}`);
  }
  const text = lines.join('\n');
  shortMemo = { key, text };
  return text;
}

/** `conductor scores --csv`: the summary table as CSV (opens in Excel). */
export function scoresCsv({ source = null, archived = false } = {}) {
  const cols = ['sel', 'category', 'difficulty', 'steps', 'n', 'rated', 'quality', 'accept', 'pass', 'fixable', 'fail', 'phantom', 'avgUsd', 'avgPct', 'avgTokens', 'avgDurationMs', 'avgRounds', 'errorRate', 'phantomRate', 'priorTier', 'cost', 'last'];
  const q = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  return [cols.join(','), ...summarize({ source, archived }).map((g) => cols.map((k) => q(g[k])).join(','))].join('\n') + '\n';
}

/** Conductor/CLI view: the table plus the current plan per category and level. */
export function formatScores({ category = null, source = null, archived = false, summary = null } = {}) {
  summary ||= summarize({ source, archived });
  const rows = summary.filter((g) => !category || g.category === category);
  const manual = archived ? [] : eligibilityOverrides({ category });
  const cfg = loadConfig().scorecard;
  if (!rows.length && (archived || (cfg.coldStart !== 'priors' && !manual.length))) return 'Scorecard is empty. Tag delegations with category/difficulty and rate them with rate_task, or run smoke_test on a model.';
  const f = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
  const lines = rows.length ? ['selection | category@lvl | n | rated | quality | accept | pass/fix/fail/phantom | $/task | %window/task | avg s | rounds | hand-picked prior'] : ['No measured score rows.'];
  for (const g of rows) { const marker = g.pricedShare != null && g.pricedShare < 1 ? (g.steps === 1 ? ` (${Math.round(g.pricedShare * g.n)}/${g.n} priced)` : ` (${(g.pricedShare * 100).toFixed(0)}% priced)`) : ''; const usd = (g.avgUsd == null ? '-' : f(g.avgUsd, 3)) + marker; lines.push(`${g.sel}${g.shipped ? ' [shipped]' : ''} | ${g.category}@${g.difficulty} | ${g.n} | ${g.rated} | ${f(g.quality, 2)} | ${f(g.accept, 2)} | ${g.pass}/${g.fixable}/${g.fail}/${g.phantom} | ${usd} | ${f(g.avgPct, 1)} | ${f(g.avgDurationMs / 1000)} | ${f(g.avgRounds, 1)} | ${g.priorTier || '-'}`); }
  if (!archived) {
    lines.push('', `Plans (quality ≥ ${cfg.quality} over ≥ ${cfg.minSamples} rated; utility = $${cfg.qualityValueUsd} × quality − $ cost${cfg.hourlyUsd ? ` − $${cfg.hourlyUsd}/h` : ''}; $ = tokens at API list price × provider weight (${Object.entries(cfg.providerWeight || {}).map(([k, v]) => `${k} ${v}`).join(', ')}; full price past ${cfg.quotaPressurePct}% of a window; reserve ${cfg.reservePct} × weight × (ceiling − level); subscription reset discount ${(cfg.wasteSteps || []).map(([h, d]) => `−${Math.round(d * 100)}% ≤${h}h`).join(', ')})${cfg.coldStart === 'priors' ? '; cold start: hand-picked priors' : ''}):`);
    let any = false;
    for (const c of category ? [category] : CATEGORIES) for (const d of LEVELS) {
      const r = recommend({ category: c, difficulty: d, source, summary });
      if (r) { any = true; lines.push(`- ${c}@${d}: ${r.reason}`); }
    }
    if (!any) lines.push('- none yet (not enough rated runs above the bar)');
  }
  if (manual.length) {
    lines.push('', 'Manual eligibility (latest per selection + category):');
    for (const r of manual) lines.push(`- ${r.action.toUpperCase()} ${r.sel} for ${r.category}: ${r.reason}`);
  }
  lines.push('', 'Error rates (φ = phantom / unverified completions):');
  const ers = errorRates({ source, archived }).byProvider;
  if (!ers.length) lines.push('- none rated yet');
  else for (const e of ers) lines.push(`- ${e.key}: ${(e.errorRate * 100).toFixed(0)}% error, ${(e.phantomRate * 100).toFixed(0)}% φ (n=${e.rated})`);
  return lines.join('\n');
}
