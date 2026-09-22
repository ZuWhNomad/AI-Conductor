// Worker tasks: journal on disk, FIFO scheduler with a concurrency cap, and park/resume when a
// provider hits a usage limit. A task = one worker run (or one follow-up on an existing thread).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, isAbsolute, relative } from 'node:path';
import { statePath, readJson, writeJson, nowIso, shortId, REPO_ROOT } from './paths.mjs';
import { loadConfig, DEFAULTS, codexSandboxFor } from './config.mjs';
import { bus } from './bus.mjs';
import { runWorker } from './workers/index.mjs';
import { contextBlock } from './context.mjs';
import { blockedUntil, refreshLimits } from './limits.mjs';
import { logImprovement } from './improve.mjs';
import { findCli } from './proc.mjs';
import { recordRun, rateTask, claimedWrites, isPhantomCompletion, snapshotWindows, windowDelta, CATEGORIES, classifyCategory, recommend, providerWindows, runRows } from './scorecard.mjs';
import { findModel } from './models.mjs';
import { PROVIDERS } from './providers/index.mjs';
import { admit, measuredCostByWindow } from './sweep.mjs';
import { recipeFor } from './recipes.mjs';
import { capabilityLines } from './capabilities.mjs';
import { mcpServersFor } from './mcp.mjs';

const DIR = () => statePath('tasks');
const WORKER_PREAMBLE = readFileSync(join(REPO_ROOT, 'core', 'policy', 'prompts', 'worker.md'), 'utf8');
// MSW kernel (necessity test for every claim): measured 2026-09-09 on the battery as 5-15% faster and 3-10% fewer output tokens at equal pass rate.
const MSW = readFileSync(join(REPO_ROOT, 'core', 'policy', 'prompts', 'msw.md'), 'utf8');
const RESUME_NOTE = 'You were interrupted earlier (usage limit or restart). Continue from the current state of the files; do not redo finished work.\n\n';
const TERMINAL = new Set(['done', 'failed', 'canceled']);

const tasks = new Map();
const running = new Map();   // id -> AbortController
const waiters = new Map();   // id -> resolve[]

// Load the journal so history survives restarts and interrupted work resumes. Work interrupted long ago is NOT
// replayed: a start after a crash used to requeue day-old tasks all at once (the 09-16 hang), and the manual recovery
// was to edit every journal file by hand.
export function recoverTasks() {
  // Never replace objects owned by this process's in-flight workers.
  if (running.size) return;
  try {
    const hours = loadConfig().worker.resumeMaxAgeHours ?? 6; let stale = 0;
    for (const f of readdirSync(DIR())) {
      if (!f.endsWith('.json')) continue;
      const t = readJson(join(DIR(), f));
      if (!t?.id) continue;
      if (t.status === 'running' || t.status === 'parked') {
        const last = Date.parse(t.updatedAt || t.startedAt || t.createdAt || '') || 0;
        if (Date.now() - last > hours * 3_600_000) { t.status = 'canceled'; t.resume = false; t.error = `not resumed: interrupted more than ${hours} h before this start; re-run it if still wanted`; stale++; writeJson(join(DIR(), f), t); }
        else { t.status = 'queued'; t.resume = true; }
      }
      tasks.set(t.id, t);
    }
    if (stale) logImprovement('friction', 'tasks', `${stale} interrupted task(s) older than ${hours} h were not resumed at start`, { count: stale });
  } catch {}
}
recoverTasks();

function persist(t) {
  t.updatedAt = nowIso();
  writeJson(join(DIR(), `${t.id}.json`), t);
  bus.publish('task', { task: publicTask(t) });
}

export function publicTask(t) {
  if (!t) return null;
  const { spec, ...rest } = t;
  return { ...rest, specPreview: String(spec ?? '').slice(0, 400) };
}

export function getTask(id) { return tasks.get(id) || null; }

export function listTasks({ sessionId = null, limit = 200 } = {}) {
  return [...tasks.values()].filter((t) => !sessionId || t.sessionId === sessionId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit).map(publicTask);
}

/**
 * @param {object} i { sessionId, cwd, title, spec, provider, model, effort, paths, followUpOf, imageOptions }
 */
export function createTask(i) {
  if (!i.followUpOf) {
    let valid = false;
    try { valid = typeof i.cwd === 'string' && !!i.cwd.trim() && statSync(i.cwd).isDirectory(); } catch {}
    if (!valid) throw Object.assign(new Error('cwd must be an existing directory'), { status: 400 });
  }
  for (const k of ['provider', 'model', 'effort']) if (i[k] != null && typeof i[k] !== 'string') throw Object.assign(new Error(`${k} must be a string`), { status: 400 });
  if (i.sandbox != null && !['read-only', 'workspace-write', 'danger-full-access'].includes(i.sandbox)) throw Object.assign(new Error('invalid sandbox'), { status: 400 });
  const cfg = loadConfig();
  const t = {
    id: shortId(), sessionId: typeof i.sessionId === 'string' ? i.sessionId : null, cwd: i.cwd, title: String(i.title || 'task').slice(0, 200), spec: String(i.spec ?? ''),
    provider: i.provider || cfg.worker.provider, model: i.model || null, effort: i.effort || cfg.worker.effort,
    paths: Array.isArray(i.paths) ? i.paths.filter((p) => typeof p === 'string') : [], followUpOf: i.followUpOf || null, imageOptions: i.imageOptions || null, sandbox: i.sandbox || null,
    threadId: null, rounds: 0, status: 'queued', createdAt: nowIso(), updatedAt: nowIso(), attempts: 0,
    result: null, error: null, resumeAt: null, changedFiles: [], diffStat: '',
    // Scorecard tags: what kind of work this is and how hard; `source` separates smoke runs from real ones.
    // Explicit category wins; an unknown non-empty one collapses to 'other'; when none is given, classify the spec
    // (today: UI tasks → 'ui') so hand-diverted /worker UI tasks still land under the right category.
    category: CATEGORIES.includes(i.category) ? i.category : i.category ? 'other' : classifyCategory(`${i.title || ''}\n${i.spec || ''}`),
    difficulty: Number.isInteger(i.difficulty) && i.difficulty >= 1 && i.difficulty <= 5 ? i.difficulty : null,
    source: i.source === 'smoke' ? 'smoke' : 'live',
    retryOf: typeof i.retryOf === 'string' && i.retryOf ? i.retryOf : null, // a new attempt after a failed task (any model): costs fold into one chain
    variant: typeof i.variant === 'string' && i.variant ? i.variant.slice(0, 40) : null, // A/B label (e.g. a policy file under test); rows keep it
    overflowApi: !!i.overflowApi, // the chat's API-overflow toggle at delegation time; failover honours it
    parallelOverride: !!i.parallelOverride, // the chat's parallel toggle at delegation time: skip the budget gate
    noFailover: !!i.noFailover,   // benchmark/bench runs: a limit parks the task, it is never handed to another model
  };
  if (!t.model && t.provider === cfg.worker.provider) t.model = cfg.worker.model;
  // Resolve a Codex task's sandbox now, not at dispatch, so the task record shows what it will actually run under.
  if (!t.sandbox && !i.followUpOf && t.provider === 'codex') t.sandbox = codexSandboxFor(t.model, cfg);
  if (t.followUpOf) {
    const parent = tasks.get(t.followUpOf);
    if (!parent) throw Object.assign(new Error(`unknown task ${t.followUpOf}`), { status: 404 });
    if (!parent.threadId) throw Object.assign(new Error(`task ${parent.id} has no resumable thread (provider ${parent.provider})`), { status: 400 });
    if (!TERMINAL.has(parent.status)) throw Object.assign(new Error(`task ${parent.id} is still ${parent.status}; wait for it before following up`), { status: 400 });
    Object.assign(t, { cwd: parent.cwd, provider: parent.provider, model: parent.model, effort: i.effort || parent.effort, sandbox: i.sandbox || parent.sandbox || null, parallelOverride: !!(i.parallelOverride || parent.parallelOverride), threadId: parent.threadId, rounds: parent.rounds + 1, paths: parent.paths, title: t.title === 'task' ? `${parent.title} (round ${parent.rounds + 2})` : t.title, category: parent.category, difficulty: parent.difficulty, source: parent.source || 'live' });
    if (t.rounds > (cfg.worker.maxRounds || 3)) t.warning = `fix round ${t.rounds} exceeds maxRounds=${cfg.worker.maxRounds}: consider escalating — delegate with retry_of ${t.id} to auto-pick the best AVAILABLE model (up to worker.escalationRounds=${cfg.worker.escalationRounds ?? 2} attempt(s)); finish it yourself only if that also fails. If this worker is ALREADY the best available model for ${t.category || 'this'}@${t.difficulty ?? 2}, the cap does not apply: keep following up, because a retry_of would route downward (delegate will say so and refuse).`;
  }
  // Guard (Method C / D): never record or dispatch an effort a model can't honor. A model with NO effort dimension
  // (agy passthrough, kimi / qwen-code / codex-spark) must carry none. An effort-in-id family (agy: it has an
  // effortIds map) given a level it doesn't offer (a hand-routed xhigh/max/ultra on a flash family) is clamped to
  // its top real level, so neither a nonsensical sel like `…-flash-low:high` nor a bare-family dispatch can land.
  if (t.effort && t.model) {
    const m = findModel(t.provider, t.model);
    if (m && Array.isArray(m.efforts)) {
      if (!m.efforts.length) { t.warning = [t.warning, `dropped effort "${t.effort}": ${t.provider}:${t.model} has no effort levels`].filter(Boolean).join(' '); t.effort = null; }
      else if (m.effortIds && !m.efforts.includes(t.effort)) { const c = m.efforts[m.efforts.length - 1]; t.warning = [t.warning, `clamped effort "${t.effort}" to "${c}": ${t.provider}:${t.model} offers only ${m.efforts.join('/')}`].filter(Boolean).join(' '); t.effort = c; }
    }
  }
  tasks.set(t.id, t);
  persist(t);
  schedule();
  return t;
}

export function cancelTask(id) {
  const t = tasks.get(id); if (!t) return null;
  if (TERMINAL.has(t.status)) return t;
  t.status = 'canceled'; t.error = 'canceled';
  running.get(id)?.abort();
  persist(t); wake(t);
  return t;
}

let shuttingDown = false;
/** Abort every active worker. With `requeue`, in-flight tasks are journaled as queued+resume (graceful shutdown) instead of failed. */
export function abortRunning({ requeue = false } = {}) { shuttingDown = requeue; for (const ac of running.values()) ac.abort(); }

/** Resolve when the task reaches a terminal state, or with `timedOut: true` after timeoutMs. */
export function awaitTask(id, timeoutMs = 45 * 60_000) {
  const t = tasks.get(id);
  if (!t) return Promise.resolve(null);
  if (TERMINAL.has(t.status)) return Promise.resolve(publicTask(t));
  return new Promise((resolve) => {
    const timer = setTimeout(() => { const l = waiters.get(id) || []; waiters.set(id, l.filter((x) => x !== done)); resolve({ ...publicTask(tasks.get(id)), timedOut: true }); }, timeoutMs);
    const done = (task) => { clearTimeout(timer); resolve(publicTask(task)); };
    waiters.set(id, [...(waiters.get(id) || []), done]);
  });
}

function wake(t) {
  for (const r of waiters.get(t.id) || []) r(t);
  waiters.delete(t.id);
}

export function buildPrompt(t) {
  const pre = t.resume ? RESUME_NOTE : '';
  if (t.followUpOf) return `${pre}Follow-up from the conductor on your previous work in this same thread. Address every point, re-run the verification, and report in the same format.\n\n${t.spec}`;
  const ctx = contextBlock(t.cwd, t.paths);
  const mcp = t.provider === 'codex' || t.provider === 'claude' ? Object.keys(mcpServersFor(t.category)) : [];
  const mcpNote = mcp.length ? `\n\nMCP servers available to you: ${mcp.join(', ')}. Use them for data instead of guessing.` : '';
  const msw = loadConfig().worker.msw === false ? '' : `

${MSW}

Remember to follow the MSW deletion rule for all claims - no exceptions.`;
  const recipe = recipeFor(t.category, t.variant);
  // Recipe and capability lines get SEPARATE budgets. They used to share one (`specAppendChars`), which meant a
  // recipe longer than the cap silently drove capabilityLines to maxChars:0 — the worker lost every tool line while
  // the recipe was appended unclipped. A long recipe must never be able to starve the tool index.
  const wcfg = loadConfig().worker;
  const recipeCap = wcfg.recipeChars ?? 6000;
  const toolsCap = wcfg.toolLineChars ?? 1500;
  if (recipe && recipe.length > recipeCap) logImprovement('friction', 'recipes', `recipe for '${t.category}'${t.variant ? ` (variant ${t.variant})` : ''} is ${recipe.length} chars, over the ${recipeCap} budget`, { taskId: t.id, title: t.title });
  const tools = capabilityLines(t.category, { maxChars: toolsCap });
  return `${pre}${WORKER_PREAMBLE}${mcpNote}${msw}\n\n${ctx ? `# Project context notes\n${ctx}\n\n` : ''}# Task: ${t.title}\n\n${t.spec}${recipe ? `\n\n---\n\n${recipe}` : ''}${tools ? `\n\n${tools}` : ''}`;
}

export function schedule() {
  if (process.env.CONDUCTOR_NO_SCHEDULE) return; // tests
  const cfg = loadConfig();
  const max = cfg.conductor.maxWorkerConcurrency || DEFAULTS.conductor.maxWorkerConcurrency;
  const budget = cfg.conductor.budgetGate !== false; // framework budget gate: on unless explicitly disabled
  const queued = [...tasks.values()].filter((t) => t.status === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (!queued.length || running.size >= max) return;
  const rows = budget ? runRows() : null;
  const costByWindow = (t) => measuredCostByWindow(rows, t.provider, { model: t.model }); // {windowId: %-per-task} for this provider/model
  // Cost already committed by in-flight tasks, per provider AND per window id — so a batch does not collectively
  // overrun any one window (a Claude task's % is charged only to Claude's windows, not to a grouped provider's others).
  const addCost = (acc, prov, costs) => { acc[prov] = acc[prov] || {}; for (const [id, c] of Object.entries(costs)) acc[prov][id] = (acc[prov][id] || 0) + c; };
  // A task's cost is UNMEASURED (probe-gated) if the provider reports windows but the task lacks a measured cost
  // for ANY of them — a newly-appeared window with no history counts as unknown, not free.
  const isUnmeasured = (t) => { const ws = providerWindows(t.provider, t.model); return ws.length > 0 && ws.some((w) => !(w.id in costByWindow(t))); };
  const runningByWindow = {};
  const probing = {}; // provider -> a probe (unmeasured task) is in flight / dispatched this pass; hold everything else on it
  if (budget) for (const id of running.keys()) { const rt = tasks.get(id); if (rt) { addCost(runningByWindow, rt.provider, costByWindow(rt)); if (isUnmeasured(rt)) probing[rt.provider] = true; } }
  const dispatchedByWindow = {}; // provider -> { windowId: % committed this pass }
  const providerBusy = (prov) => Object.keys(dispatchedByWindow[prov] || {}).length > 0 || [...running.keys()].some((id) => tasks.get(id)?.provider === prov);
  for (const t of queued) {
    if (t.status !== 'queued') continue; // a synchronous setup failure can schedule the next task immediately
    if (running.size >= max) break;
    const until = blockedUntil(t.provider);
    if (until) { park(t, until, `provider ${t.provider} is at its usage limit`); continue; }
    if (budget && !t.parallelOverride) { // a task from a chat with the parallel override skips the gate entirely
      if (probing[t.provider]) continue; // a probe of unknown cost is measuring this provider; hold ALL its tasks until it returns
      const windows = providerWindows(t.provider, t.model);
      const costs = costByWindow(t);
      const unmeasured = isUnmeasured(t); // windowed provider missing a cost for some window -> one probe at a time (windowless API/local providers have no window to protect)
      const committed = { ...(runningByWindow[t.provider] || {}) };
      for (const [id, c] of Object.entries(dispatchedByWindow[t.provider] || {})) committed[id] = (committed[id] || 0) + c;
      const a = admit(windows, [{ costs }], { runningByWindow: committed, maxParallel: 1 });
      if (!a.n || unmeasured) {
        // Over the per-window target (or cost still unknown) we DON'T pause. Policy: degrade to SEQUENTIAL per
        // provider and keep issuing — a task that runs into the real provider limit then hands off via failover
        // (below), so another agent takes over instead of the queue stalling. Hold this task only while its
        // provider already has one in flight; it resumes the moment that finishes. Never a queued-forever park.
        if (providerBusy(t.provider)) continue;
      }
      if (unmeasured) probing[t.provider] = true; // this dispatch IS the probe; nothing else on this provider runs alongside it
      addCost(dispatchedByWindow, t.provider, unmeasured ? { __probe: 100 } : costs);
    }
    void run(t);
  }
}

function park(t, until, reason) {
  t.status = 'parked'; t.resumeAt = until; t.error = reason; t.resume = t.attempts > 0; // only a run that started can be resumed
  persist(t);
  setTimeout(() => { if (t.status === 'parked') { t.status = 'queued'; t.resumeAt = null; persist(t); schedule(); } }, Math.min(2 ** 31 - 1, Math.max(1000, until - Date.now()))).unref();
}

async function run(t) {
  try {
    const ac = new AbortController();
    running.set(t.id, ac);
    t.status = 'running'; t.startedAt = nowIso(); t.attempts += 1; t.error = null;
    persist(t);
    const limitsBefore = snapshotWindows(t.provider);
    // Concurrency for the cost divisor: co-running tasks that actually share one of THIS task's windows. For a
    // model-group provider (Antigravity: Gemini vs Claude+GPT) a run in the other group doesn't move this window,
    // so it must not divide this window's delta — counting all same-provider tasks understated grouped costs.
    const myWins = new Set(providerWindows(t.provider, t.model).map((w) => w.id));
    const concurrent = [...running.keys()].filter((id) => {
      if (id === t.id) return false; const rt = tasks.get(id); if (rt?.provider !== t.provider) return false;
      const rw = providerWindows(rt.provider, rt.model).map((w) => w.id);
      return rw.length === 0 || rw.some((wid) => myWins.has(wid));
    }).length;
    const before = await gitStatus(t.cwd); // async: N tasks starting together must not serialize the event loop on git
    Object.assign(t, await repoSize(t.cwd)); // repoFiles / repoBytes on the run row: the project-size signal for later tool scoring
    const wcfg = loadConfig().worker;
    const r = await runWorker({ ...t, prompt: buildPrompt(t), timeoutMs: (wcfg.timeoutByCategory?.[t.category] || wcfg.timeoutMinutes || 45) * 60_000 }, { signal: ac.signal });
    if ((r.durationMs || 0) > (wcfg.longRunMinutes || 60) * 60_000) logImprovement('friction', `worker:${t.provider}`, `long run: ${Math.round(r.durationMs / 60_000)} min (${t.category || 'untagged'}, ${t.model || 'default'}:${t.effort || 'default'})`, { taskId: t.id, title: t.title });
    t.threadId = r.threadId || t.threadId;
    t.result = { finalMessage: r.finalMessage || '', usage: r.usage || null, costUsd: r.costUsd || 0, durationMs: r.durationMs || 0, items: (r.items || []).slice(-40), files: r.files, tools: countTools(r.items) };
    const rel = (p) => { try { return isAbsolute(p) ? relative(t.cwd, p) || p : p; } catch { return p; } };
    const after = await gitStatus(t.cwd); // one status read serves the changed-file list, the phantom check and the diff stat
    const observed = diffStatus(before, after);
    t.changedFiles = [...new Set([...observed, ...(r.items || []).filter((i) => i.type === 'file_change').flatMap((i) => (i.changes || []).map((c) => c.path).filter(Boolean))].map(rel))];
    t.diffStat = await gitDiffStat(t.cwd, after);
    const claimed = claimedWrites(r.items);
    const phantom = isPhantomCompletion({ ok: r.ok, claimed, canVerify: before !== null, observedCount: observed.length });
    t.resume = false;
    if (r.limitHit && t.status !== 'canceled' && !(shuttingDown && ac.signal.aborted)) {
      t.limitHit = true; // never scored against the model
      await refreshLimits({ only: [t.provider] }).catch(() => {}); // quota view drives the next pick; cancellation/shutdown must be checked AFTER this await
    }
    if (t.status === 'canceled') { /* keep */ }
    else if (shuttingDown && ac.signal.aborted) { t.status = 'queued'; t.resume = true; t.error = 'interrupted by shutdown; resumes on next start'; }
    else if (r.limitHit) {
      const next = failover(t);
      if (next) { t.status = 'failed'; t.failedOverTo = next.id; t.error = `provider ${t.provider} at its limit; failed over to task ${next.id} (${next.provider}:${next.model || 'default'}:${next.effort || 'default'}) — await that id`; }
      else {
        const until = blockedUntil(t.provider) || Date.now() + (r.retryAfterMs || (loadConfig().scorecard?.blockedMinutes ?? 30) * 60_000);
        park(t, until, r.error || 'usage limit');
        logImprovement('friction', `worker:${t.provider}`, 'usage limit hit; task parked until the provider window resets', { taskId: t.id, model: t.model, resumeAt: new Date(until).toISOString() });
      }
    } else if (!r.ok) {
      t.status = 'failed'; t.error = r.error || 'worker failed';
      logImprovement('error', `worker:${t.provider}`, t.error, { taskId: t.id, model: t.model, title: t.title });
    } else if (phantom) {
      t.status = 'failed'; t.failKind = 'phantom';
      t.error = `phantom completion: worker reported file write(s) (${claimed.slice(0, 3).join(', ')}${claimed.length > 3 ? ', …' : ''}) but none landed on disk (git shows no change). Recorded as a phantom-failure verdict.`;
      logImprovement('error', `worker:${t.provider}`, `phantom completion: claimed ${claimed.length} write(s), 0 landed`, { taskId: t.id, model: t.model, title: t.title });
    } else { t.status = 'done'; }
    t.finishedAt = nowIso();
    persist(t);
    if (TERMINAL.has(t.status) && !t.limitHit && t.status !== 'canceled') score(t, limitsBefore, concurrent); // a canceled/aborted run's ~0 tokens must not drag the model's cost means down (like limitHit, it isn't representative)
    if (t.failKind === 'phantom') { try { rateTask(t.id, 'phantom', 'auto: reported file writes that never landed on disk'); } catch {} }
  } catch (e) {
    t.status = 'failed'; t.error = String(e?.message || e); t.finishedAt = nowIso();
    try { persist(t); } catch {} // A broken journal must not hold a worker slot or reject run().
  } finally {
    running.delete(t.id);
    try { if (TERMINAL.has(t.status)) wake(t); } catch {} // parked/requeued tasks keep their waiters until they really finish
    try { if (!shuttingDown) schedule(); } catch {}
  }
}

/**
 * A provider hit its limit mid-task: re-issue the same spec on the next recommended provider as a retry chain
 * (the section that fell silent hands the part to the next one). null when nothing else qualifies.
 */
function failover(t) {
  if (!t.category || !t.difficulty || t.followUpOf || t.source === 'smoke' || t.noFailover) return null; // a battery/benchmark measures one selection; never hand its tasks to another
  try {
    const providers = Object.keys(PROVIDERS).filter((id) => id !== t.provider);
    const alt = recommend({ category: t.category, difficulty: t.difficulty, providers, overflowApi: !!t.overflowApi });
    if (!alt || alt.provider === t.provider) return null;
    const n = createTask({ sessionId: t.sessionId, cwd: t.cwd, title: `FAILOVER: ${t.title}`.slice(0, 200), spec: t.spec, provider: alt.provider, model: alt.model, effort: alt.effort, paths: t.paths, category: t.category, difficulty: t.difficulty, retryOf: t.id, source: t.source, variant: t.variant, overflowApi: t.overflowApi, parallelOverride: t.parallelOverride, sandbox: t.sandbox });
    logImprovement('friction', `worker:${t.provider}`, `usage limit hit; failed over to ${n.provider}:${n.model || 'default'}`, { taskId: t.id, next: n.id });
    return n;
  } catch { return null; }
}

// Scorecard row after the provider's limits are re-polled (so the window delta is fresh). Waiters are
// not held up; `flushRecords` lets the CLI/smoke runner wait for the rows before reading them.
const pendingRecords = new Set();
function score(t, limitsBefore, concurrent) {
  const p = refreshLimits({ only: [t.provider] }).catch(() => {}).then(() => { try {
    // Per-task % of the provider window this run burned (max across its windows) — surfaced on the Fleet card.
    const d = windowDelta(limitsBefore, snapshotWindows(t.provider));
    if (d) { const max = Math.max(...Object.values(d)); t.pctWindow = Math.round(max * 10) / 10; persist(t); }
    recordRun(t, { before: limitsBefore, concurrent });
  } catch {} });
  pendingRecords.add(p);
  p.finally(() => pendingRecords.delete(p));
}
export const flushRecords = () => Promise.allSettled([...pendingRecords]);

// --- git helpers (best effort; silent when not a repo or git is missing). All async: they run on the dispatch path,
// and a synchronous git call per task (up to 10 s each) stalled every chat and poll when tasks started together. ---
const execFileP = promisify(execFile);
let gitBin;
async function git(cwd, args) {
  if (!existsSync(join(cwd, '.git'))) return null;
  if (gitBin === undefined) gitBin = findCli('git');
  if (!gitBin) return null;
  try { return (await execFileP(gitBin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 })).stdout; } catch { return null; }
}
async function gitStatus(cwd) {
  const out = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (out == null) return null;
  const entries = out.split('\0'); const statusMap = new Map(); const untracked = [], tracked = [];
  for (let i = 0; i < entries.length; i++) {
    const l = entries[i]; if (!l) continue;
    const name = l.slice(3); const status = l.slice(0, 2);
    if (/[RC]/.test(status)) i++; // -z emits the original name after a rename/copy destination.
    if (status === '??') untracked.push(name);
    else tracked.push(name);
    statusMap.set(name, status);
  }
  // An untracked file carries its mtime+size, so an edit to it counts as a change too.
  await Promise.all(untracked.map(async (name) => { try { const s = await stat(join(cwd, name)); statusMap.set(name, `?? ${s.mtimeMs}:${s.size}`); } catch {} }));
  // Porcelain stays " M" when a worker edits an already-dirty file; compare its content too.
  await Promise.all(tracked.map(async (name) => { try { const hash = createHash('sha256').update(await readFile(join(cwd, name))).digest('hex'); statusMap.set(name, `${statusMap.get(name)} ${hash}`); } catch {} }));
  return statusMap;
}
/** Pure: files whose status differs between two snapshots (everything, when there was no before). */
function diffStatus(before, after) {
  if (!after) return [];
  if (!before) return [...after.keys()];
  return [...after.keys()].filter((f) => !before.has(f) || before.get(f) !== after.get(f));
}
async function changedSince(cwd, before) { return diffStatus(before, await gitStatus(cwd)); }
async function gitDiffStat(cwd, status = null) {
  const [a, b] = await Promise.all([git(cwd, ['diff', '--stat']), git(cwd, ['diff', '--cached', '--stat'])]);
  const untracked = [...(status || await gitStatus(cwd) || [])].filter(([, s]) => s.startsWith('??')).map(([name]) => name).slice(0, 50);
  return [((a || '') + (b || '')).trim().slice(0, 3000), untracked.length ? `untracked: ${untracked.join(', ')}` : ''].filter(Boolean).join('\n');
}

export const _git = { gitStatus, changedSince, gitDiffStat, diffStatus };

/** Which tools/programs/MCP calls a worker used: { calls, errors, byName } from its items (all of them, not the journaled tail). */
export function countTools(items) {
  const out = { calls: 0, errors: 0, byName: {} };
  for (const i of items || []) {
    if (!i || !/tool_use|command_execution|mcp_tool_call/.test(i.type || '')) continue;
    const name = i.type === 'mcp_tool_call' ? `mcp:${i.server || '?'}:${i.tool || '?'}` : i.type === 'command_execution' ? `run:${String(i.command || '').trim().split(/\s+/)[0] || '?'}` : String(i.name || '?');
    out.calls++; out.byName[name] = (out.byName[name] || 0) + 1;
    if (i.error || i.isError || (typeof i.exitCode === 'number' && i.exitCode !== 0) || (typeof i.exit_code === 'number' && i.exit_code !== 0) || /^error:/i.test(String(i.output || ''))) out.errors++;
  }
  return out.calls ? out : null;
}

// Tracked-file count and bytes of a task's repo (git ls-tree at HEAD), cached per cwd for ten minutes: the cheap
// "small project or large repo" signal recorded on every run row, so tool scores can later be split by it.
const sizeCache = new Map();
async function repoSize(cwd) {
  const hit = sizeCache.get(cwd); if (hit && Date.now() - hit.at < 600_000) return hit.v;
  let v = { repoFiles: null, repoBytes: null };
  const out = await git(cwd, ['ls-tree', '-r', '-l', 'HEAD']);
  if (out != null) { let files = 0, bytes = 0; for (const line of out.split('\n')) { const m = /^\S+ blob \S+\s+(\d+|-)\t/.exec(line); if (m) { files++; bytes += Number(m[1]) || 0; } } v = { repoFiles: files, repoBytes: bytes }; }
  sizeCache.set(cwd, { at: Date.now(), v });
  return v;
}

/** One compact, conductor-facing summary of a task. */
export function describeTask(t) {
  if (!t) return 'unknown task';
  const r = t.result || {};
  const cmds = (r.items || []).filter((i) => i.type === 'command_execution' || i.type === 'tool_use').length;
  const lines = [
    `Task ${t.id} [${t.status}] ${t.title} — ${t.provider}${t.model ? `/${t.model}` : ''}${t.effort ? ` (${t.effort})` : ''}, round ${t.rounds + 1}${r.durationMs ? `, ${Math.round(r.durationMs / 1000)}s` : ''}${t.threadId ? `, thread ${t.threadId}` : ''}`,
  ];
  if (t.warning) lines.push(`Warning: ${t.warning}`);
  if (t.error) lines.push(`Error: ${t.error}`);
  if (t.failedOverTo) lines.push(`Failed over to task ${t.failedOverTo}: call await_task on it; this id will not complete.`);
  if (t.status === 'parked') lines.push(`Parked until ${t.resumeAt ? new Date(t.resumeAt).toISOString() : '?'} (auto-resumes)`);
  if (t.changedFiles?.length) lines.push(`Changed files: ${t.changedFiles.join(', ')}`);
  if (t.diffStat) lines.push(`Diff stat:\n${t.diffStat}`);
  if (r.usage) lines.push(`Usage: ${JSON.stringify(r.usage)}`);
  if (r.files?.length) lines.push(`Files: ${r.files.join(', ')}`);
  if (cmds) lines.push(`Actions: ${cmds} commands/tool calls`);
  if (r.finalMessage) lines.push(`Worker report:\n${r.finalMessage}`);
  return lines.join('\n');
}
