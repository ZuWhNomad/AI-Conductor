// Scorecard ledger: the append-only ndjson of what every worker run cost and how it was judged, plus the identity
// helpers (selection strings, categories, verdicts, efforts, archived models) every other scorecard module shares.
// Rows: `run` (recordRun), `rate` (rateTask), `void`, `amend`, `eligibility`. The ledger is never rewritten.
import { statSync } from 'node:fs';
import { appendNdjson, readNdjson, statePath, nowIso } from '../paths.ts';
import { getLimits } from '../limits.mjs';
import { loadConfig } from '../config.mjs';
import { bus } from '../bus.ts';
import { logImprovement } from '../improve.mjs';
import { priceFor, usdFor } from '../priors.mjs';
import { cliVersionOf } from '../cli-update.mjs';

export const ledgerFile = () => statePath('scorecard.ndjson');
// Only Claude's SDK cost is a meaningful provider-reported list price today.
export const LIST_COST_PROVIDERS = new Set(['claude']);
export const CATEGORIES = ['read', 'search', 'summarize', 'research', 'writing', 'video-extraction', 'edit', 'implement', 'test', 'refactor', 'debug', 'ui', 'docs', 'review', 'design', 'drafting', 'modeling', 'other'];

// Minimal prompt→category classifier. Today it recognizes only UI/frontend work, so a UI task the user diverts by
// hand (the `/worker …` shortcut and direct-to-worker tasks set no category) is still recorded under `ui` and the
// scorecard accumulates real per-model UI outcomes. Everything else returns null (unchanged behaviour: untagged
// unless the caller passed a category). Broaden cautiously — a wrong tag pollutes the ledger.
const UI_RE = /\b(u[ix]|css|s[ca]ss|html|tailwind|front-?end|style ?sheets?|styles?\.css|index\.html|app\.js|layout|responsive|flex-?box|z-index|viewport|@media|media quer(?:y|ies)|modal|drop-?down|tooltip|side-?bar|nav-?bar|checkbox|dark ?mode|light ?mode|favicon|jsx|tsx|\breact\b|svelte|\bvue\b|\bdom\b|:hover|button style|css class(?:es)?)\b/i;
export function classifyCategory(text) {
  return UI_RE.test(String(text || '')) ? 'ui' : null;
}
export const VERDICTS = ['pass', 'fixable', 'close', 'fail', 'phantom'];
export const evidenceRated = (g) => g.weightedRated ?? g.rated ?? 0;
// Routing covers levels 1-7.
export const ROUTED_MAX_DIFFICULTY = 7;
export const LEVELS = [1, 2, 3, 4, 5, 6, 7];
export const scorecardModelId = (model) => typeof model === 'string' ? model.replace(/\[1m\]$/i, '') : model;
export const selOf = (r) => `${r.provider}:${r.model || 'default'}:${r.effort || 'default'}`;
const archiveKey = (value) => {
  const s = String(value).trim(), colon = s.indexOf(':');
  return (colon < 0 ? s : `${s.slice(0, colon)}:${scorecardModelId(s.slice(colon + 1))}`).toLowerCase();
};
export const archivedSet = (cfg) => new Set((cfg?.scorecard?.archived || cfg?.archived || []).map(archiveKey).filter(Boolean));
/** Archived as a whole model (`provider:model`) or, when `effort` is given, at that one effort (`provider:model:effort`). */
export function isArchived(provider, model, cfg = loadConfig().scorecard, effort = null) {
  const set = cfg instanceof Set ? cfg : archivedSet(cfg);
  const key = `${provider}:${scorecardModelId(model) || 'default'}`.toLowerCase();
  return set.has(key) || (!!effort && set.has(`${key}:${String(effort).toLowerCase()}`));
}
export const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export function claimedWrites(items) { return (items || []).filter((i) => i.type === 'file_change').flatMap((i) => (i.changes || []).map((c) => c.path).filter(Boolean)); }
export function isPhantomCompletion({ ok, claimed = [], canVerify, observedCount }) { return !!ok && !!canVerify && claimed.length > 0 && observedCount === 0; }

const LEGACY_ENV_FAILURES = [
  'max iterations reached', 'UnauthorizedAccessException', 'access (?:was |is )?denied', 'permission denied', 'EACCES', 'EPERM',
  'waiting for network', 'Connection failed', 'ECONNRESET', 'ENOTFOUND', 'fetch failed', 'unexpected status 401',
  '\\bUnauthorized\\b', 'Incorrect API key provided', 'refresh token was already used', 'access token could not be refreshed',
  'usage limit', 'rate limit', 'quota', 'too many requests', 'resource exhausted', 'limit reached', 'balance exhausted',
];
const PROVIDER_ENV_FAILURES = [
  '\\bHTTP\\s*[45]\\d\\d\\b',
  '\\b(?:HTTP\\s*)?[45]\\d\\d\\b(?=.{0,48}\\b(?:status|error|response|provider)\\b)',
  '\\b(?:status|error|response|provider)\\b.{0,48}\\b[45]\\d\\d\\b',
  '\\b(?:HTTP\\s*)?50[0234]\\b(?=.{0,48}\\b(?:status|error|unavailable|bad gateway|gateway timeout)\\b)',
  '\\b(?:status|error|unavailable|bad gateway|gateway timeout)\\b.{0,48}\\b50[0234]\\b',
  'status["\'\\s:=]+UNAVAILABLE\\b', // gRPC-style status; a bare "unavailable" in tool output is not a provider error
  'WinError 32', '\\bEBUSY\\b',
  'CUDA out of memory', 'CUDA error', 'llama-server', 'cudaMalloc',
  'quota rejected', 'rejected task at startup',
  '(?:selected\\s+)?model is at capacity',
];
const CLI_ENV_FAILURES = ['\\b(?:unknown option|unexpected argument)\\b', '\\brequires --\\w+', "\\binvalid value for '--"];
export const ENV_FAIL = new RegExp([...LEGACY_ENV_FAILURES, ...PROVIDER_ENV_FAILURES, ...CLI_ENV_FAILURES].join('|'), 'i');
const RESULT_ENV_FAIL = new RegExp([...LEGACY_ENV_FAILURES, ...PROVIDER_ENV_FAILURES].join('|'), 'i');
const FINAL_MESSAGE_ENV_FAIL = new RegExp(LEGACY_ENV_FAILURES.join('|'), 'i');

const TOOL_CALL_TYPES = new Set(['tool_use', 'tool_call', 'command_execution', 'mcp_tool_call']);
const TOOL_RESULT_TYPES = new Set(['tool_result', 'command_result', 'mcp_tool_result']);
export const finiteCount = (v) => Number.isInteger(v) && v >= 0 ? v : null;
const numberOrNull = (v) => v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
const ownFiniteCount = (o, key) => Object.hasOwn(o || {}, key) ? finiteCount(o[key]) : null;
const itemIsCall = (i) => !!i && TOOL_CALL_TYPES.has(i.type);
const callName = (i) => i.type === 'command_execution' ? String(i.command || '').trim() : i.type === 'mcp_tool_call' ? `mcp:${i.server || '?'}:${i.tool || '?'}` : String(i.name || i.tool || i.function?.name || '?');
const callArgs = (i) => i.type === 'command_execution' ? String(i.command || '') : i.arguments ?? i.args ?? i.input ?? i.function?.arguments ?? null;
const callKey = (i) => {
  let args; try { args = JSON.stringify(callArgs(i)); } catch { args = String(callArgs(i)); }
  return `${callName(i)}\\0${args}`;
};
const resultId = (i) => i?.tool_use_id ?? i?.toolCallId ?? i?.tool_call_id ?? i?.call_id ?? i?.id ?? null;
const resultError = (i) => {
  if (!i) return null;
  if (i.isError === true || i.is_error === true) return true;
  if (i.error != null) return !!i.error;
  const exit = numberOrNull(i.exitCode ?? i.exit_code);
  if (exit != null) return exit !== 0;
  const numericStatus = numberOrNull(i.status);
  if (numericStatus != null) return numericStatus >= 400;
  const status = String(i.status || '').toLowerCase();
  if (status) {
    if (['error', 'failed', 'failure', 'cancelled', 'canceled', 'aborted'].includes(status)) return true;
    if (['ok', 'success', 'completed', 'complete', 'done'].includes(status)) return false;
  }
  const output = i.output ?? i.result ?? i.content;
  if (output != null) {
    if (typeof output === 'object') {
      const nested = resultError(output);
      if (nested != null) return nested;
    } else if (typeof output === 'string' && /^\s*[\[{]/.test(output)) {
      try {
        const nested = resultError(JSON.parse(output));
        if (nested != null) return nested;
      } catch {}
    }
    return /^error\s*:/i.test(typeof output === 'string' ? output : JSON.stringify(output));
  }
  return null;
};

/** Calculate reliability only from transcript facts; absent worker fields remain unknown (null). */
export function reliabilityMetrics(t = {}) {
  const result = t.result || {};
  const rel = plain(result.reliability) ? result.reliability : {};
  const items = Array.isArray(result.items) ? result.items : null;
  const calls = items?.filter(itemIsCall) || [];
  const results = new Map((items || []).filter((i) => TOOL_RESULT_TYPES.has(i?.type) && resultId(i) != null).map((i) => [String(resultId(i)), i]));
  const explicitCalls = ownFiniteCount(result, 'toolCalls') ?? ownFiniteCount(rel, 'toolCalls') ?? ownFiniteCount(result.tools, 'calls');
  const explicitErrors = ownFiniteCount(result, 'toolErrors') ?? ownFiniteCount(rel, 'toolErrors') ?? ownFiniteCount(result.tools, 'errors');
  const toolCalls = explicitCalls ?? (items ? calls.length : null);
  let toolErrors = explicitErrors, thrash = ownFiniteCount(result, 'thrash') ?? ownFiniteCount(rel, 'thrash');
  if (items && explicitErrors == null) {
    // A journaled result may retain only the tail of a longer transcript; do not call omitted outcomes successes.
    if (explicitCalls != null && calls.length < explicitCalls) { toolErrors = null; if (thrash == null) thrash = null; }
    else {
      const outcomes = calls.map((i) => {
        let outcome = resultError(i);
        if (outcome == null && i.id != null) outcome = resultError(results.get(String(i.id)));
        return { key: callKey(i), error: outcome };
      });
      toolErrors = outcomes.every((o) => o.error != null) ? outcomes.filter((o) => o.error).length : null;
      if (thrash == null) {
        if (outcomes.some((o) => o.error == null)) thrash = null;
        else {
          thrash = 0;
          for (let i = 1; i < outcomes.length; i++) if (outcomes[i].key === outcomes[i - 1].key && outcomes[i].error && outcomes[i - 1].error) thrash++;
        }
      }
    }
  }
  if (explicitCalls === 0) { toolErrors ??= 0; thrash ??= 0; }
  const turns = finiteCount(result.turns) ?? finiteCount(rel.turns) ?? finiteCount(result.num_turns) ?? (items ? (() => {
    const n = items.filter((i) => i?.type === 'turn' || i?.type === 'assistant_turn' || i?.type === 'turn.completed').length;
    return n || null;
  })() : null);
  const timedOut = typeof t.timedOut === 'boolean' ? t.timedOut : typeof result.timedOut === 'boolean' ? result.timedOut : t.failKind === 'timeout' || /^timeout(?:\b| after)/i.test(String(t.error || result.error || '')) ? true : t.status === 'done' || result.ok === true ? false : null;
  return { turns, toolCalls, toolErrors, thrash, timedOut };
}

const taskHttpStatus = (t) => numberOrNull(t.httpStatus ?? t.result?.httpStatus ?? t.result?.http_status ?? t.result?.statusCode ?? t.result?.status_code ?? t.result?.status);
const taskExitCode = (t) => numberOrNull(t.exitCode ?? t.result?.exitCode ?? t.result?.exit_code);
/** A worker or provider failure that belongs to the environment, not the model. Structured signals win over text fallback. */
export function envFailure(t = {}) {
  if (t.timedOut === true || t.result?.timedOut === true || t.failKind === 'timeout') return null;
  if (t.limitHit === true || t.result?.limitHit === true || t.failKind === 'limit') return 'provider usage limit';
  if (t.authFailed === true || t.result?.authFailed === true || t.failKind === 'auth') return `sign-in: ${String(t.error || '').slice(0, 160)}`;
  if (t.envFailed === true || t.result?.envFailed === true || t.failKind === 'env') return `harness: ${String(t.error || '').slice(0, 160)}`;
  const httpStatus = taskHttpStatus(t);
  if (httpStatus >= 400 && httpStatus <= 599) return `provider HTTP ${httpStatus}`;
  const exitCode = taskExitCode(t), metrics = reliabilityMetrics(t), items = Array.isArray(t.result?.items) ? t.result.items : [];
  const acted = items.some((i) => /^(agent_message|reasoning|tool_use|tool_call|command_execution|mcp_tool_call|file_change)$/.test(i?.type || '')) || (metrics.turns || 0) > 0;
  if (exitCode != null && exitCode !== 0 && !acted) return `CLI exited before model acted (${exitCode})`;
  const fallback = (hit, where) => {
    if (!hit) return null;
    try { logImprovement('friction', 'scorecard', `environment failure inferred from ${where}: ${hit}`, { taskId: t.id, provider: t.provider }); } catch {}
    return hit;
  };
  const error = String(t.error || '');
  const errorHit = error.match(ENV_FAIL)?.[0];
  if (errorHit) return fallback(errorHit, 'worker error text');
  const providerTexts = (Array.isArray(t.result?.items) ? t.result.items : []).map((i) => String(i.text || i.output || i.message || i.error || ''));
  const finalMessage = String(t.result?.finalMessage || '');
  const hit = providerTexts.find((text) => RESULT_ENV_FAIL.test(text));
  return fallback(hit?.match(RESULT_ENV_FAIL)?.[0], 'worker item text') || fallback(finalMessage.match(FINAL_MESSAGE_ENV_FAIL)?.[0], 'worker final text');
}

/** Sum per-run reliability across fix rounds or retry steps; missing legacy fields stay unknown. */
export function aggregateReliability(rows = []) {
  const sumKnown = (key) => rows.length && rows.every((r) => finiteCount(r?.[key]) != null) ? rows.reduce((sum, r) => sum + r[key], 0) : null;
  const boolKnown = rows.length && rows.every((r) => typeof r?.timedOut === 'boolean') ? rows.some((r) => r.timedOut) : null;
  return { turns: sumKnown('turns'), toolCalls: sumKnown('toolCalls'), toolErrors: sumKnown('toolErrors'), thrash: sumKnown('thrash'), timedOut: boolKnown };
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
export const tokensOf = (r) => (!r.tokens ? null : r.tokens.v ? r.tokens : { ...r.tokens, in: r.provider === 'claude' ? r.tokens.in : Math.max(0, (r.tokens.in || 0) - (r.tokens.cached || 0)) });

/** Shadow $ for one run row: Claude list cost when present, else tokens × API list price. */
export function runCostUsd(r) {
  if (LIST_COST_PROVIDERS.has(r.provider) && r.costUsd > 0) return r.costUsd;
  return usdFor(tokensOf(r), priceFor(r.provider, scorecardModelId(r.model)));
}

const EXPERIMENT_TAG = /^([A-Za-z0-9_-]{1,40}):([A-Za-z0-9_-]{1,40})$/;
let experimentWarned = false;
/** `CONDUCTOR_EXPERIMENT=<id>:<arm>`. Invalid values are ignored after one warning. Unset → null. */
export function experimentFromEnv(raw = process.env.CONDUCTOR_EXPERIMENT) {
  if (raw == null || raw === '') return null;
  const m = EXPERIMENT_TAG.exec(String(raw));
  if (m) return { id: m[1], arm: m[2] };
  if (!experimentWarned) {
    experimentWarned = true;
    console.warn(`CONDUCTOR_EXPERIMENT ignored: expected <id>:<arm> ([A-Za-z0-9_-]{1,40} each), got ${JSON.stringify(String(raw))}`);
  }
  return null;
}

/** Parse one scorecard file with the same void/amend fold as `runRows()`. */
export function ledgerOf(file) {
  const all = readNdjson(file);
  return { all, ...foldRunRows(all) };
}

/** Record one terminal worker run. tasks.mjs calls this after refreshing the provider's limits. */
export function recordRun(t, { before = null, concurrent = 0, concurrentByWindow = null } = {}) {
  const requestedModel = t.model || null;
  const servedModel = t.result?.servedModel || null;
  const model = servedModel || requestedModel;
  const reliability = reliabilityMetrics(t);
  const row = {
    op: 'run', ts: nowIso(), taskId: t.id, followUpOf: t.followUpOf || null, retryOf: t.retryOf || null, reroutedFrom: t.reroutedFrom || null, sessionId: t.sessionId || null, source: t.source || 'live',
    provider: t.provider, model, requestedModel, effort: t.effort || null, category: t.category || null, difficulty: t.difficulty || null,
    status: t.status, tokens: normalizeUsage(t.result?.usage), costUsd: t.result?.costUsd || 0, costBasis: LIST_COST_PROVIDERS.has(t.provider) && t.result?.costUsd > 0 ? 'list' : 'tokens', durationMs: t.result?.durationMs || 0, variant: t.variant || null,
    pct: windowDelta(before, snapshotWindows(t.provider)), concurrent, concurrentByWindow, title: t.title, smokeId: t.smokeId || null, failKind: t.failKind || null, rounds: t.rounds ?? null,
    turns: reliability.turns, toolCalls: reliability.toolCalls, toolErrors: reliability.toolErrors, thrash: reliability.thrash, timedOut: reliability.timedOut,
    httpStatus: taskHttpStatus(t), exitCode: taskExitCode(t), limitHit: !!(t.limitHit || t.result?.limitHit), authFailed: !!(t.authFailed || t.result?.authFailed), envFailed: !!(t.envFailed || t.result?.envFailed),
    tools: t.result?.tools || null, repoFiles: t.repoFiles ?? null, repoBytes: t.repoBytes ?? null, // capability use + project size (plan Part H4): scored later as a view
    cliVersion: cliVersionOf(t.provider), servedModel, // cached --version (SDK for claude); the model the CLI says it ran
  };
  const experiment = experimentFromEnv();
  if (experiment) row.experiment = experiment;
  appendNdjson(ledgerFile(), row);
  bus.publish('score', { taskId: t.id, provider: t.provider, model: row.model, pct: row.pct });
  return row;
}

/** The conductor's verdict. Any task id in a fix-round chain rates that attempt. */
export function rateTask(taskId, verdict, notes = '') {
  if (verdict === 'void') return voidTask(taskId, notes || 'voided by the conductor'); // not the model's doing (harness, sign-in, bad fixture)
  if (!VERDICTS.includes(verdict)) throw Object.assign(new Error(`verdict must be one of ${[...VERDICTS, 'void'].join('|')}`), { status: 400 });
  const row = { op: 'rate', ts: nowIso(), taskId: String(taskId), verdict, notes: String(notes || '').slice(0, 1000) };
  appendNdjson(ledgerFile(), row);
  bus.publish('score', { taskId: row.taskId, verdict });
  return row;
}

/** Exclude a run from every aggregate (harness failure, bad fixture) without rewriting the ledger. */
export function voidTask(taskId, reason = '') {
  const row = { op: 'void', ts: nowIso(), taskId: String(taskId), reason: String(reason || '').slice(0, 400) };
  appendNdjson(ledgerFile(), row);
  bus.publish('score', { taskId: row.taskId, verdict: 'void' }); // same event rateTask publishes, so the UI updates
  return row;
}

/** Correct a run's identity, or restore a voided run, without rewriting its ledger row. */
export function amendTask(taskId, patch = {}) {
  const row = { op: 'amend', ts: nowIso(), taskId: String(taskId) };
  if (Object.hasOwn(patch, 'model')) row.model = patch.model == null ? null : String(patch.model);
  if (Object.hasOwn(patch, 'effort')) row.effort = patch.effort == null ? null : String(patch.effort);
  if (patch.unvoid) row.unvoid = true;
  row.reason = String(patch.reason || '').slice(0, 400);
  appendNdjson(ledgerFile(), row);
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
  const latestRates = new Map();
  for (const [order, r] of all.entries()) if (r.op === 'rate') {
    const prior = latestRates.get(r.taskId);
    if (!prior || r.ts > prior.ts || (r.ts === prior.ts && order > prior.order)) latestRates.set(r.taskId, { ...r, order });
  }
  // A graded note ("8/9 tests passed: …") is a model result even when its text mentions limits or quotas.
  const harnessNote = (notes) => /^\s*\d+\/\d+ tests passed/.test(String(notes || '')) ? null : String(notes || '').match(/(?:model is at capacity|"?status"?\s*[:=]\s*"?[45]\d\d|\bHTTP\s*(?:status\s*)?[45]\d\d\b|\bUnauthorized\b|access token could not be refreshed|Incorrect API key|usage limit|rate limit|quota|too many requests|resource exhausted|limit reached|balance exhausted)/i)?.[0] || null;
  for (const r of all) {
    if (r.op !== 'run' || r.source !== 'smoke' || voided.has(r.taskId)) continue;
    const rate = latestRates.get(r.taskId);
    const note = rate?.verdict === 'fail' ? harnessNote(rate.notes) : null;
    if (!note) continue;
    voidTask(r.taskId, `harness migration: ${note}`);
    voided.add(r.taskId); n++;
  }
  if (n) bus.publish('score', { migrated: n });
  return n;
}

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
export function loadLedger() {
  try {
    const st = statSync(ledgerFile());
    if (_runRowsCache && _runRowsCache.mtimeMs === st.mtimeMs && _runRowsCache.size === st.size) return _runRowsCache;
    const all = readNdjson(ledgerFile());
    return _runRowsCache = { mtimeMs: st.mtimeMs, size: st.size, ...foldRunRows(all), all };
  } catch {
    const all = readNdjson(ledgerFile());
    return { ...foldRunRows(all), all };
  }
}
export function runRows() { return loadLedger().rows; }
/** Worker-only run rows used by routing budgets and token-based usage estimates. */
export function activeRunRows() { return runRows().filter((r) => r.category !== 'conductor'); }
// P3: reuse the same cached parse (rate/void rows live in `all`, not in runRows). Callers do not mutate.
function allRows() { return loadLedger().all; }

const normalizedEligibilitySel = (value) => {
  const parsed = parseSel(String(value || '').trim());
  if (!parsed.provider || (!parsed.model && !String(value || '').includes(':default'))) return null;
  return selOf({ provider: parsed.provider, model: scorecardModelId(parsed.model), effort: parsed.effort });
};
export const eligibilityKey = (sel, category) => `${String(sel).toLowerCase()}|${category}`;

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
  appendNdjson(ledgerFile(), row);
  bus.publish('score', { eligibility: row });
  return row;
}

// Single source of truth for effort ordering (low -> ultra). Everything that ranks effort imports this;
// omitting `ultra` here (as an older copy did) made ultra rank -1, so a model's top effort could never cold-start.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const parseSel = (s) => {
  const [provider, ...parts] = s.split(':');
  const effort = parts.length > 1 && (parts.at(-1) === 'default' || EFFORTS.includes(parts.at(-1))) ? parts.pop() : null;
  const model = parts.join(':');
  return { provider, model: model === 'default' ? null : model, effort: effort === 'default' ? null : effort };
};
export const modelInRegistry = (reg, provider, model) => {
  const id = scorecardModelId(model);
  return reg.models.find((m) => m.provider === provider && (scorecardModelId(m.id) === id || scorecardModelId(m.resolved) === id));
};
