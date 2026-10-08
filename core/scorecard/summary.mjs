// Scorecard summary: fold the ledger into attempts and chains (rootRuns), aggregate them into one row per
// selection × category × difficulty (summarize), merge the shipped benchmark cells, and derive error rates.
// Read-only over the ledger; recommend.mjs and report.mjs consume these rows.
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, writeJson, nowIso, REPO_ROOT } from '../paths.ts';
import { perTaskPct } from '../sweep.mjs';
import { getModels } from '../models.mjs';
import { loadConfig } from '../config.mjs';
import { priceFor, priorFor, usdFor } from '../priors.mjs';
import {
  LIST_COST_PROVIDERS, selOf, scorecardModelId, isArchived, archivedSet, plain, finiteCount, loadLedger,
  tokensOf, envFailure, aggregateReliability, modelInRegistry,
} from './ledger.mjs';

export const BATTERIES_FILE = join(REPO_ROOT, 'core', 'policy', 'batteries.json');
export const BATTERIES_SCHEMA_VERSION = 1;
const SCORE = { pass: 1, fixable: 0.5, close: 0, fail: 0, phantom: 0 };
const EVIDENCE_HALF_LIFE_MS = 45 * 24 * 60 * 60 * 1000;
const recencyWeight = (ts, now = Date.now()) => {
  const at = Date.parse(ts);
  if (!Number.isFinite(at)) return 1;
  // Evidence is surfaced by date (and shipped aggregates only retain a date), so age consistently in whole days.
  const age = Math.floor(Math.max(0, now - at) / (24 * 60 * 60 * 1000)) * 24 * 60 * 60 * 1000;
  return 0.5 ** (age / EVIDENCE_HALF_LIFE_MS);
};
const BATTERY_CELL_KEYS = ['provider', 'model', 'effort', 'category', 'difficulty', 'rated', 'pass', 'fixable', 'fail', 'phantom', 'avgUsd', 'avgDurationMs', 'avgTokens', 'lastRunDate'];
const finiteOrNull = (v) => v === null || (Number.isFinite(v) && v >= 0);
const count = (v) => Number.isInteger(v) && v >= 0;

/**
 * Strict aggregate-only schema: no task ids, titles, notes, or paths can be carried by this file. `rated` counts runs;
 * the verdict tallies count battery tasks (repeats of one task fold into one verdict), so they may sum to less.
 */
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
    && c.pass + c.fixable + c.fail + c.phantom <= c.rated
    && finiteOrNull(c.avgUsd) && finiteOrNull(c.avgDurationMs) && finiteOrNull(c.avgTokens)
    && /^\d{4}-\d{2}-\d{2}$/.test(c.lastRunDate));
}

let shippedCache = null;
export function shippedFingerprint() {
  try { const st = statSync(BATTERIES_FILE); return `${st.size}:${st.mtimeMs}`; } catch { return 'none'; }
}
export function shippedCells() {
  const key = shippedFingerprint();
  if (shippedCache?.key === key) return shippedCache.cells;
  const doc = readJson(BATTERIES_FILE);
  const cells = validBatteriesDocument(doc) ? doc.cells : [];
  shippedCache = { key, cells };
  return cells;
}

export const RELIABILITY_TOTALS = Symbol('reliabilityTotals');
export const SMOKE_TOTALS = Symbol('smokeTotals');

const maxPct = (pct) => { const xs = Object.values(pct || {}); return xs.length ? Math.max(...xs) : null; };
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const meanKnown = (xs) => mean(xs.filter((x) => x != null)); // unknown costs are skipped, not poison
const addTok = (a, b) => { if (b) for (const k of ['in', 'out', 'cached', 'write']) a[k] += b[k] || 0; };

/**
 * Fold the log into chains. An *attempt* is a task plus its fix rounds (followUpOf); a *chain* is the
 * attempts linked by retryOf (a new model after a fail). Each chain: { taskId, category, difficulty,
 * source, attempts[], path[], verdict (last attempt), tokens, usd, durationMs, rounds }.
 */
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
      a = { ...root, model, sel: selOf({ ...root, model }), tokens: { in: 0, out: 0, cached: 0, write: 0 }, pct: null, usd: null, durationMs: 0, rounds: root.category === 'conductor' ? (root.rounds ?? 0) - 1 : -1, members: [], verdict: null, notes: null };
      a.price = priceFor(root.provider, model, cfg);
      attempts.set(root.taskId, a);
    }
    a.rounds += 1; a.members.push(r.taskId); (a._rows ||= []).push(r);
    if (tokensOf(r)) a._anyUsage = true;
    addTok(a.tokens, tokensOf(r));
    a.durationMs += r.durationMs || 0;
    if (r.pct) { a.pct = a.pct || {}; for (const [k, v] of Object.entries(perTaskPct(r))) a.pct[k] = (a.pct[k] || 0) + v; }
  }
  for (const a of attempts.values()) {
    const rated = a.members.map((id) => rates.get(id)).filter(Boolean).reduce((latest, rate) =>
      !latest || rate.ts > latest.ts || (rate.ts === latest.ts && rate._order > latest._order) ? rate : latest, null);
    Object.assign(a, aggregateReliability(a._rows));
    a.verdict = rated?.verdict || (a.status === 'failed' && !envFailure(a) ? 'fail' : null);
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
    c.attempts.forEach((a, i) => { if (i < c.attempts.length - 1 && !a.verdict && !envFailure(a)) a.verdict = 'fail'; }); // retried => it did not do, unless the harness stopped it
    const last = c.attempts[c.attempts.length - 1];
    c.path = c.attempts.map((a) => a.sel);
    // Only a voided original's rating can settle a replacement; ordinary predecessors rate their own attempts.
    const chainRate = last.verdict ? null : [...c.ids].filter((id) => voided.has(id)).map((id) => rates.get(id)).find(Boolean);
    if (chainRate) { last.verdict = chainRate.verdict; last.notes = chainRate.notes || null; }
    c.verdict = last.verdict; c.notes = last.notes;
    c.tokens = { in: 0, out: 0, cached: 0, write: 0 }; c.durationMs = 0; c.rounds = 0; c.pct = null;
    let usd = 0, priced = 0;
    for (const a of c.attempts) { addTok(c.tokens, a.tokens); c.durationMs += a.durationMs; c.rounds += a.rounds; if (a.usd != null) { usd += a.usd; priced++; } if (a.pct) { c.pct = c.pct || {}; for (const [k, v] of Object.entries(a.pct)) c.pct[k] = (c.pct[k] || 0) + v; } }
    Object.assign(c, aggregateReliability(c.attempts));
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
  // Recency-weighted evidence must age out without a ledger/config write. A minute bucket bounds memo staleness.
  const key = `${scorecardMemoKey(source)}|minute:${Math.floor(Date.now() / 60_000)}|archived:${archived ? 1 : 0}|shipped:${shipped ? 1 : 0}`;
  if (summarizeMemo?.key === key) return summarizeMemo.rows;
  const out = summarizeUncached({ source, archived, shipped });
  summarizeMemo = { key, rows: out };
  return out;
}

const summarySort = (a, b) => a.category.localeCompare(b.category) || a.difficulty - b.difficulty || a.steps - b.steps || (b.quality ?? -1) - (a.quality ?? -1);

function shippedSummary(c, now) {
  const sel = selOf(c), scored = c.pass + c.fixable + c.fail + c.phantom; // verdicts; c.rated is runs
  const quality = scored ? (c.pass * SCORE.pass + c.fixable * SCORE.fixable) / scored : null;
  const weightedRated = c.rated * recencyWeight(c.lastRunDate, now);
  return {
    sel, steps: 1, provider: c.provider, model: c.model, effort: c.effort, category: c.category, difficulty: c.difficulty,
    n: c.rated, rated: c.rated, liveN: 0, liveRated: 0, liveWeightedRated: 0, smokeN: c.rated, smokeRated: c.rated, smokeWeightedRated: weightedRated,
    weightedRated, pass: c.pass, fixable: c.fixable, close: c.close || 0, fail: c.fail, phantom: c.phantom,
    cost: modelInRegistry(getModels(), c.provider, c.model)?.cost || null, priorTier: priorFor(c.provider, c.model, c.category)?.tier || null,
    quality, liveQuality: null, smokeQuality: quality, accept: scored ? (c.pass + c.fixable) / scored : null, avgTokens: c.avgTokens, avgUsd: c.avgUsd,
    pricedShare: null, avgPct: null, avgDurationMs: c.avgDurationMs, avgRounds: null,
    consistency: scored ? c.pass / scored : null, repeats: null,
    errorRate: scored ? (c.fail + c.fixable) / scored : null, phantomRate: scored ? c.phantom / scored : null,
    toolErrorRate: null, avgTurns: null, thrash: null, timeouts: null, costPerSuccess: c.pass ? (c.avgUsd == null ? null : c.avgUsd * c.rated / c.pass) : null,
    last: c.lastRunDate, shipped: true,
  };
}

function mergeShipped(local, archive, now) {
  const occupied = new Set(local.filter((g) => g.steps === 1).map((g) => [g.sel, g.category, g.difficulty].join('|')));
  const fallback = shippedCells().filter((c) => !isArchived(c.provider, c.model, archive, c.effort)).map((c) => shippedSummary(c, now))
    .filter((g) => !occupied.has([g.sel, g.category, g.difficulty].join('|')));
  return [...local, ...fallback].sort(summarySort);
}

function summarizeUncached({ source = null, archived = false, shipped = true } = {}) {
  const archive = archivedSet(loadConfig().scorecard);
  const evidenceNow = Date.now();
  const groups = new Map();
  const add = (sel, steps, cat, diff, x, { evidenceRuns = null } = {}) => {
    const key = [sel, cat, diff].join('|');
    let g = groups.get(key);
    if (!g) { g = { sel, steps, category: cat, difficulty: diff, n: 0, rated: 0, weightedRated: 0, liveN: 0, liveRated: 0, liveWeightedRated: 0, smokeN: 0, smokeRated: 0, smokeWeightedRated: 0, pass: 0, fixable: 0, close: 0, fail: 0, phantom: 0, _quality: { live: 0, smoke: 0 }, _accept: { live: 0, smoke: 0 }, _smokeQualityWeightedRated: 0, _tok: [], _usd: [], _pct: [], _dur: [], _rounds: [], _priced: 0, _attempts: 0, _toolCalls: 0, _toolErrors: 0, _toolUnknown: false, _turns: [], _thrash: 0, _thrashUnknown: false, _timeouts: 0, _timeoutUnknown: false, _costTotal: 0, _costUnknown: false, _smokePasses: 0, _smokeRuns: 0, _smokeRepeats: [] }; groups.set(key, g); }
    const evidence = evidenceRuns || [x];
    const source = x.source === 'smoke' ? 'smoke' : 'live';
    g.n += evidence.length;
    g[source + 'N'] += evidence.length;
    for (const run of evidence) {
      if (run.ts && (!g.last || run.ts > g.last)) g.last = run.ts;
      if (!run.verdict) continue;
      const weight = recencyWeight(run.ts, evidenceNow);
      g.rated++; g[source + 'Rated']++; g.weightedRated += weight; g[source + 'WeightedRated'] += weight;
    }
    // Evidence remains per non-void run; only smoke quality and its pass/fail tallies are pass^k per battery task.
    if (x.verdict) {
      const weight = recencyWeight(x.ts, evidenceNow);
      g[x.verdict]++;
      g._quality[source] += SCORE[x.verdict] * weight;
      g._accept[source] += (x.verdict === 'pass' || x.verdict === 'fixable' ? 1 : 0) * weight;
      if (source === 'smoke') g._smokeQualityWeightedRated += weight;
    }
    g._tok.push(x.tokens.in + x.tokens.out + x.tokens.cached);
    if (x.usd != null) g._usd.push(x.usd);
    const xs = x.attempts || [x]; g._attempts += xs.length; g._priced += xs.filter((a) => a.usd != null).length;
    const p = maxPct(x.pct); if (p != null) g._pct.push(p);
    g._dur.push(x.durationMs); g._rounds.push(x.rounds);
    if (finiteCount(x.toolCalls) != null && finiteCount(x.toolErrors) != null) { g._toolCalls += x.toolCalls; g._toolErrors += x.toolErrors; } else g._toolUnknown = true;
    if (finiteCount(x.turns) != null) g._turns.push(x.turns);
    if (finiteCount(x.thrash) != null) g._thrash += x.thrash; else g._thrashUnknown = true;
    if (typeof x.timedOut === 'boolean') { if (x.timedOut) g._timeouts++; } else g._timeoutUnknown = true;
    if (x.usd != null) g._costTotal += x.usd; else g._costUnknown = true;
    if (source === 'smoke' && x.smokeEvidence) {
      g._smokePasses += x.smokeEvidence.passes;
      g._smokeRuns += x.smokeEvidence.runs;
      if (x.smokeEvidence.runs) g._smokeRepeats.push(x.smokeEvidence.runs);
    }
    return g;
  };
  const smokeGroups = new Map();
  const addSmoke = (a) => {
    const cat = a.category, diff = a.difficulty;
    if (!cat || !diff) return;
    const taskKey = a.smokeId || a.taskId;
    const key = [a.sel, cat, diff, taskKey].join('|');
    const group = smokeGroups.get(key) || { sel: a.sel, category: cat, difficulty: diff, runs: [] };
    group.runs.push(a); smokeGroups.set(key, group);
  };
  const aggregateSmoke = (group) => {
    const runs = group.runs, rated = runs.filter((a) => a.verdict);
    const latest = [...runs].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).at(-1) || runs[0];
    const tokens = { in: 0, out: 0, cached: 0, write: 0 };
    for (const run of runs) addTok(tokens, run.tokens);
    const reliability = aggregateReliability(runs);
    const usd = runs.every((run) => run.usd != null) ? runs.reduce((sum, run) => sum + run.usd, 0) : null;
    const verdict = rated.length && rated.every((run) => run.verdict === 'pass') ? 'pass' : rated.length ? 'fail' : null;
    return {
      ...latest, verdict, tokens, usd, durationMs: runs.reduce((sum, run) => sum + (run.durationMs || 0), 0),
      rounds: runs.reduce((sum, run) => sum + (run.rounds || 0), 0), attempts: runs,
      turns: reliability.turns, toolCalls: reliability.toolCalls, toolErrors: reliability.toolErrors, thrash: reliability.thrash, timedOut: reliability.timedOut,
      smokeEvidence: { passes: rated.filter((run) => run.verdict === 'pass').length, runs: rated.length },
    };
  };
  for (const c of rootRuns({ source })) {
    const chainArchived = c.attempts.some((a) => isArchived(a.provider, a.model, archive, a.effort));
    for (const a of c.attempts) {
      if (isArchived(a.provider, a.model, archive, a.effort) !== archived) continue;
      // B3: score each attempt under its own category/difficulty; skip attempts without tags (an untagged
      // head must not silence a tagged replacement). Fall back to chain tags only when the attempt lacks them.
      const cat = a.category || c.category;
      const diff = a.difficulty || c.difficulty;
      if (!cat || !diff) continue;
      if (a.source === 'smoke' && c.attempts.length === 1) addSmoke(a);
      else { const g = add(a.sel, 1, cat, diff, a); g.provider = a.provider; g.model = a.model; g.effort = a.effort; }
    }
    // The multi-step observed ladder row is chain-level: it must have chain-level tags.
    if (c.attempts.length > 1 && c.category && c.difficulty && chainArchived === archived) {
      const g = add(c.path.join('>'), c.attempts.length, c.category, c.difficulty, c);
      g._stepCosts ||= c.attempts.map(() => []);
      c.attempts.forEach((a, i) => g._stepCosts[i].push({ sel: a.sel, avgUsd: a.usd, avgDurationMs: a.durationMs }));
    }
  }
  for (const group of smokeGroups.values()) {
    const x = aggregateSmoke(group), g = add(group.sel, 1, group.category, group.difficulty, x, { evidenceRuns: group.runs });
    g.provider = x.provider; g.model = x.model; g.effort = x.effort;
  }
  const local = [...groups.values()].map(({ _quality, _accept, _smokeQualityWeightedRated, _tok, _usd, _pct, _dur, _rounds, _stepCosts, _priced, _attempts, _toolCalls, _toolErrors, _toolUnknown, _turns, _thrash, _thrashUnknown, _timeouts, _timeoutUnknown, _costTotal, _costUnknown, _smokePasses, _smokeRuns, _smokeRepeats, ...g }) => {
    const cost = g.steps === 1 ? modelInRegistry(getModels(), g.provider, g.model)?.cost || null : null;
    const prior = g.steps === 1 ? priorFor(g.provider, g.model, g.category) : null;
    const liveQuality = g.liveRated && g.liveWeightedRated ? _quality.live / g.liveWeightedRated : null;
    const smokeQuality = _smokeQualityWeightedRated ? _quality.smoke / _smokeQualityWeightedRated : null;
    // Q3: once this exact cell has live rated work, its quality owns the cell; benchmark evidence remains a count.
    const quality = liveQuality ?? smokeQuality;
    const qualitySource = g.liveRated ? 'live' : 'smoke';
    const row = {
      ...g, cost, priorTier: prior?.tier || null, quality, liveQuality, smokeQuality,
      accept: (qualitySource === 'smoke' ? _smokeQualityWeightedRated : g.liveWeightedRated) ? _accept[qualitySource] / (qualitySource === 'smoke' ? _smokeQualityWeightedRated : g.liveWeightedRated) : null,
      ...(_stepCosts ? { stepCosts: _stepCosts.map((costs) => ({ sel: costs[0].sel, avgUsd: meanKnown(costs.map((c) => c.avgUsd)), avgDurationMs: mean(costs.map((c) => c.avgDurationMs)) })) } : {}),
      avgTokens: mean(_tok), avgUsd: mean(_usd), pricedShare: _attempts ? _priced / _attempts : null, avgPct: cost === 'free-local' ? 0 : mean(_pct), avgDurationMs: mean(_dur), avgRounds: mean(_rounds),
      errorRate: g.rated ? (g.fail + g.fixable) / g.rated : null, phantomRate: g.rated ? g.phantom / g.rated : null,
      toolErrorRate: !_toolUnknown && _toolCalls > 0 ? _toolErrors / _toolCalls : null,
      avgTurns: meanKnown(_turns), thrash: _thrashUnknown ? null : _thrash, timeouts: _timeoutUnknown ? null : _timeouts,
      costPerSuccess: g.pass > 0 && !_costUnknown ? _costTotal / g.pass : null,
      consistency: _smokeRuns ? _smokePasses / _smokeRuns : null,
      repeats: _smokeRepeats.length ? { min: Math.min(..._smokeRepeats), max: Math.max(..._smokeRepeats) } : null,
    };
    Object.defineProperty(row, RELIABILITY_TOTALS, { value: {
      toolCalls: _toolUnknown ? null : _toolCalls, toolErrors: _toolUnknown ? null : _toolErrors,
      turns: { sum: _turns.reduce((sum, n) => sum + n, 0), count: _turns.length },
      thrash: _thrashUnknown ? null : _thrash, timeouts: _timeoutUnknown ? null : _timeouts,
      costTotal: _costUnknown ? null : _costTotal,
    } });
    Object.defineProperty(row, SMOKE_TOTALS, { value: { passes: _smokePasses, runs: _smokeRuns, repeats: _smokeRepeats, qualityWeightedRated: _smokeQualityWeightedRated } });
    return row;
  }).sort(summarySort);
  const cfg = loadConfig().scorecard;
  const useShipped = shipped && !archived && (source == null || source === 'smoke') && cfg.shippedBatteries !== false && process.env.CONDUCTOR_NO_SHIPPED !== '1';
  return useShipped ? mergeShipped(local, archive, evidenceNow) : local;
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
  for (const c of rootRuns({ source })) for (const a of c.attempts) if (a.verdict && isArchived(a.provider, a.model, archive, a.effort) === archived) {
    for (const [map, key] of [[models, a.sel], [providers, a.provider]]) {
      let g = map.get(key); if (!g) { g = { key, rated: 0, fail: 0, fixable: 0, phantom: 0 }; map.set(key, g); }
      g.rated++; if (a.verdict === 'fail') g.fail++; if (a.verdict === 'fixable') g.fixable++; if (a.verdict === 'phantom') g.phantom++;
    }
  }
  const finish = (map) => [...map.values()].map((g) => ({ ...g, errorRate: (g.fail + g.fixable) / g.rated, phantomRate: g.phantom / g.rated })).sort((a, b) => b.errorRate - a.errorRate || b.rated - a.rated);
  return { byModel: finish(models), byProvider: finish(providers) };
}
