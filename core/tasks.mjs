// Worker tasks: journal on disk, FIFO scheduler with a concurrency cap, and park/resume when a
// provider hits a usage limit. A task = one worker run (or one follow-up on an existing thread).
//
// The stateful core stays here: the task Map, journal, scheduler, run lifecycle and the worktree lifecycle that reads
// or journals tasks. Tests re-import this file with a query string for a fresh instance and hook its own
// './workers/index.mjs' / './sweep.mjs' imports, so that state and those imports cannot move. The stateless parts live
// in tasks/ (view, prompt, git; leaves that import nothing from each other) and are re-exported below.
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { statePath, readJson, writeJson, nowIso, shortId } from './paths.mjs';
import { loadConfig, codexSandboxFor, runTimeoutMs } from './config.mjs';
import { bus } from './bus.mjs';
import { runWorker } from './workers/index.mjs';
import { groupOf, modelBlock, noteLimitAvailable, noteLimitHit, refreshLimits, refreshLimitsWithMeta, withLimitsSnapshot } from './limits.mjs';
import { logImprovement } from './improve.mjs';
import { recordRun, rateTask, claimedWrites, isPhantomCompletion, snapshotWindows, windowDelta, CATEGORIES, ROUTED_MAX_DIFFICULTY, classifyCategory, recommend, providerWindows, activeRunRows, EFFORTS, nextScheduledReset, envFailure, reliabilityMetrics } from './scorecard.mjs';
import { findModel, getModels, familyOf, normFamilies, selsInFamilies } from './models.mjs';
import { PROVIDERS } from './providers/index.mjs';
import { admit, measuredCostByWindow, isBudgetWindow } from './sweep.mjs';
import { accessProviders } from './capabilities.mjs';
import { resourceStatus } from './resources.mjs';
import { publicTask, taskSummary, countTools } from './tasks/view.mjs';
import { buildPrompt } from './tasks/prompt.mjs';
import { findGitRoot, gitExec, gitStatus, diffStatus, gitDiffStat, isolatedCwd, linkIsolateDirs, unlinkIsolateLinks, ageLabel, repoSize } from './tasks/git.mjs';
export * from './tasks/view.mjs';
export * from './tasks/prompt.mjs';
export * from './tasks/git.mjs';

const DIR = () => statePath('tasks');
const INDEX = () => statePath('tasks-index.json');

const FAILOVER_NOTE = 'Note: another worker was stopped by a usage limit part-way through this task and may have left edits in the working tree. Check the current state (git status / diff) first; do not redo finished work.\n';
const TERMINAL = new Set(['done', 'failed', 'canceled']);

const tasks = new Map();
const running = new Map();   // id -> AbortController
const runningSettle = new Map(); // id -> Promise
const settling = new Set(); // completed tasks retain budget reservations until polling and scoring settle
const waiters = new Map();   // id -> { deadline, done }[]
let ramRetryTimer = null;
let journalIndex = new Map(); // small metadata only; journal files remain authoritative
const validId = (id) => typeof id === 'string' && /^[a-z0-9_-]+$/i.test(id);
const newestFirst = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || String(b.id).localeCompare(String(a.id));
function journalStamp(file) { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return null; } }
function indexTask(t, file = join(DIR(), `${t.id}.json`)) {
  journalIndex.set(t.id, { status: t.status, createdAt: t.createdAt, stamp: journalStamp(file) });
}
function saveIndex() { try { writeJson(INDEX(), Object.fromEntries(journalIndex)); } catch {} } // disposable cache; a stale/missing entry is rebuilt from its journal
let indexTimer = null;
function saveIndexSoon() { if (indexTimer) return; indexTimer = setImmediate(() => { indexTimer = null; saveIndex(); }); } // one write per event-loop turn, not per task update
function trimTasks(keep = loadConfig().worker.tasksInMemory) {
  const terminal = [...tasks.values()].filter((t) => TERMINAL.has(t.status)).sort(newestFirst);
  for (const t of terminal.slice(keep)) {
    // Accounting still owns these records until its final limits sample and score settle.
    if (!running.has(t.id) && !settling.has(t.id)) tasks.delete(t.id);
  }
}

// Load the journal without changing task state. CLI imports need the history and open-task guard, but only the server
// owns restart transitions. Age must not silently cancel work: queued and parked tasks remain durable.
function loadTasks() {
  if (running.size || settling.size) return false; // never replace objects owned by this process's in-flight workers
  try {
    const cfg = loadConfig().worker;
    const saved = readJson(INDEX(), {});
    journalIndex = new Map();
    for (const f of readdirSync(DIR())) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -5), file = join(DIR(), f), stamp = journalStamp(file);
      if (!validId(id)) continue;
      const entry = saved?.[id];
      if (stamp && entry?.stamp === stamp && typeof entry.status === 'string') journalIndex.set(id, entry);
      else {
        const t = readJson(file);
        if (t?.id === id) indexTask(t, file);
      }
    }
    const entries = [...journalIndex].map(([id, entry]) => ({ id, ...entry }));
    const retained = [...entries.filter((t) => !TERMINAL.has(t.status)), ...entries.filter((t) => TERMINAL.has(t.status)).sort(newestFirst).slice(0, cfg.tasksInMemory)];
    tasks.clear();
    for (const entry of retained) {
      const t = readJson(join(DIR(), `${entry.id}.json`));
      if (t?.id !== entry.id) continue;
      tasks.set(t.id, t);
    }
    trimTasks(cfg.tasksInMemory);
    saveIndex();
    return true;
  } catch { return false; }
}

function resumeAtMs(value) { return typeof value === 'number' ? value : Date.parse(value); }

/** Apply restart-only transitions after the server binds. Returns counts for the startup friction line. */
export function recoverTasks() {
  const summary = { resumed: 0, parkedKept: 0, earliestParked: null, stale: 0, smokeCanceled: 0, bySession: {} };
  if (running.size || settling.size || !loadTasks()) return summary;
  const recovered = [];
  let earliestParkedMs = Infinity;
  const noteOutcome = (t, status, resumeAt = null) => {
    if (!t.sessionId) return;
    (summary.bySession[t.sessionId] ||= []).push({ id: t.id, status, ...(resumeAt ? { resumeAt: new Date(resumeAt).toISOString() } : {}) });
  };
  for (const t of tasks.values()) {
    if (TERMINAL.has(t.status)) continue;
    if (t.source === 'smoke') {
      t.status = 'canceled'; t.error = 'battery interrupted by a restart'; t.finishedAt = nowIso();
      summary.smokeCanceled++; persist(t); wake(t);
    } else if (t.status === 'running') {
      t.recoveries = (t.recoveries || 0) + 1;
      t.interruptedAt = t.aliveAt || t.updatedAt;
      if (t.recoveries >= 2) {
        t.status = 'stale'; t.error = 'interrupted by 2 restarts in a row; Re-run or Discard';
        summary.stale++; noteOutcome(t, 'stale'); persist(t); wake(t);
      } else {
        t.status = 'queued'; t.resume = true; recovered.push(t); summary.resumed++; noteOutcome(t, 'resumed');
      }
    } else if (t.status === 'queued' && t.resume === true) {
      recovered.push(t); summary.resumed++; noteOutcome(t, 'resumed');
    } else if (t.status === 'parked') {
      const until = resumeAtMs(t.resumeAt);
      if (until > Date.now()) {
        summary.parkedKept++;
        earliestParkedMs = Math.min(earliestParkedMs, until);
        noteOutcome(t, 'parked', until);
        t.park ||= { kind: 'limit', until, source: 'guess', provider: t.provider };
      } else {
        t.status = 'queued'; t.resumeAt = null; delete t.park; t.resume = t.attempts > 0;
        summary.resumed++; noteOutcome(t, 'resumed'); persist(t);
      }
    }
  }
  if (earliestParkedMs < Infinity) summary.earliestParked = new Date(earliestParkedMs).toISOString();
  recovered.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  const staggerMs = loadConfig().worker.resumeStaggerSeconds * 1000, startedAt = Date.now();
  for (let i = 0; i < recovered.length; i++) {
    const t = recovered[i];
    if (staggerMs > 0 && i > 0) park(t, startedAt + i * staggerMs, 'restart stagger', { kind: 'replay', source: 'guess' });
    else persist(t);
  }
  armWake();
  return summary;
}

// Loading is safe in CLI processes; status changes and timers are server-start-only.
loadTasks();

// Coarse progress for task_status while a worker runs (not a live stream): the last activity line or tool, and tokens
// when the runtime reports them. Every worker event updates `live`; the task's snapshot copies it at most once a minute.
const PROGRESS_MS = 60_000;
const live = new Map(); // taskId -> { activity, tokens }
const tokensOf = (u) => { if (!u) return null; const n = (Number(u.input_tokens ?? u.inputTokens) || 0) + (Number(u.output_tokens ?? u.outputTokens) || 0); return n || null; };
bus.on('event', (e) => {
  if (e.type !== 'worker' || !running.has(e.taskId)) return;
  const t = tasks.get(e.taskId); if (!t) return;
  const l = live.get(t.id) || {};
  const i = e.item;
  const activity = i ? (i.command || (i.type === 'mcp_tool_call' ? `mcp:${i.server}:${i.tool}` : i.name) || (i.text && String(i.text).trim().split('\n').pop())) : null;
  if (activity) l.activity = String(activity).slice(0, 160);
  const n = tokensOf(e.usage); if (n) l.tokens = n;
  live.set(t.id, l);
  if (!t.progress || Date.now() - t.progress.at >= PROGRESS_MS) t.progress = { at: Date.now(), ...l };
});

function persist(t) {
  if (t.status !== 'parked' && t.park) { delete t.park; armWake(); }
  t.updatedAt = nowIso();
  writeJson(join(DIR(), `${t.id}.json`), t);
  indexTask(t); saveIndexSoon(); trimTasks();
  bus.publish('task', { task: taskSummary(t) });
}

/** Journal watchdog-only metadata without publishing a task event or changing updatedAt. */
function persistQuiet(t) {
  writeJson(join(DIR(), `${t.id}.json`), t);
  indexTask(t); saveIndexSoon(); trimTasks();
}

export function touchTaskAlive(id, watchdog, at = nowIso()) {
  const t = getTask(id);
  if (!t || t.status !== 'running') return false;
  t.aliveAt = at; t.watchdog = watchdog;
  persistQuiet(t);
  return true;
}

export function markTaskWakeReported(ids, at = nowIso()) {
  for (const id of ids) {
    const t = getTask(id);
    if (!t || t.wakeReportedAt) continue;
    t.wakeReportedAt = at; persistQuiet(t);
  }
}

export function getTask(id) {
  if (tasks.has(id)) return tasks.get(id);
  if (!validId(id)) return null;
  const t = readJson(join(DIR(), `${id}.json`));
  return t?.id === id ? t : null;
}

export function openTasks() { return [...tasks.values()].filter((t) => !TERMINAL.has(t.status) && t.status !== 'stale'); }

/** Queued, running and parked tasks. `bench --run`, `smoke` and `review` refuse to start when this is non-zero. */
export function openTaskCount() { return openTasks().length; }

export function listTasks({ sessionId = null, limit = 200 } = {}) {
  return [...tasks.values()].filter((t) => !sessionId || t.sessionId === sessionId)
    .sort(newestFirst).slice(0, limit).map(taskSummary);
}

/**
 * @param {object} i { sessionId, cwd, title, spec, provider, model, effort, paths, followUpOf }
 */
export function createTask(i, { dispatch = true } = {}) {
  if (!i.followUpOf) {
    let valid = false;
    try { valid = typeof i.cwd === 'string' && !!i.cwd.trim() && statSync(i.cwd).isDirectory(); } catch {}
    if (!valid) throw Object.assign(new Error('cwd must be an existing directory'), { status: 400 });
  }
  for (const k of ['provider', 'model', 'effort']) if (i[k] != null && typeof i[k] !== 'string') throw Object.assign(new Error(`${k} must be a string`), { status: 400 });
  if (i.sandbox != null && !['read-only', 'workspace-write', 'danger-full-access'].includes(i.sandbox)) throw Object.assign(new Error('invalid sandbox'), { status: 400 });
  const writableRoots = checkWritableRoots(i.writableRoots);
  const cfg = loadConfig();
  const t = {
    id: shortId(), sessionId: typeof i.sessionId === 'string' ? i.sessionId : null, cwd: i.cwd, title: String(i.title || 'task').slice(0, 200), spec: String(i.spec ?? ''),
    provider: i.provider || cfg.worker.provider, model: i.model || null, effort: i.effort || cfg.worker.effort,
    paths: Array.isArray(i.paths) ? i.paths.filter((p) => typeof p === 'string') : [], followUpOf: i.followUpOf || null, sandbox: i.sandbox || null,
    threadId: null, rounds: 0, status: 'queued', createdAt: nowIso(), updatedAt: nowIso(), attempts: 0,
    result: null, error: null, resumeAt: null, changedFiles: [], diffStat: '',
    // Scorecard tags: what kind of work this is and how hard; `source` separates smoke runs from real ones.
    // Explicit category wins; an unknown non-empty one collapses to 'other'; when none is given, classify the spec
    // (today: UI tasks → 'ui') so hand-diverted /worker UI tasks still land under the right category.
    category: CATEGORIES.includes(i.category) ? i.category : i.category ? 'other' : classifyCategory(`${i.title || ''}\n${i.spec || ''}`),
    // 1-7 route work.
    difficulty: Number.isInteger(i.difficulty) && i.difficulty >= 1 && i.difficulty <= ROUTED_MAX_DIFFICULTY ? i.difficulty : null,
    source: i.source === 'smoke' ? 'smoke' : 'live',
    smokeId: i.source === 'smoke' && typeof i.smokeId === 'string' ? i.smokeId : null, // battery id, kept out of the worker's prompt
    retryOf: typeof i.retryOf === 'string' && i.retryOf ? i.retryOf : null, // a new attempt after a failed task (any model): costs fold into one chain
    reroutedFrom: typeof i.reroutedFrom === 'string' && i.reroutedFrom ? i.reroutedFrom : null, // usage-limit handoff: audit link, not a quality-chain step
    variant: typeof i.variant === 'string' && i.variant ? i.variant.slice(0, 40) : null, // A/B label (e.g. a policy file under test); rows keep it
    overflowApi: !!i.overflowApi, // the chat's API-overflow toggle at delegation time; failover honours it
    parallelOverride: !!i.parallelOverride, // the chat's parallel toggle at delegation time: skip the budget gate
    efficiencyMode: i.efficiencyMode == null ? !!cfg.worker.efficiencyMode : !!i.efficiencyMode, // wait on this model at a confirmed limit instead of failing over
    noFailover: !!i.noFailover,   // benchmark/bench runs: a limit parks the task, it is never handed to another model
    avoidFamilies: normFamilies(i.avoidFamilies), // reviews: failover never lands on these model families (see familyOf)
    writableRoots, // extra directories the worker may write besides cwd (a sibling git worktree): Codex --add-dir, Claude additionalDirectories
    wakeEligible: true, // watchdog may summarize an un-awaited completion once this chat's whole background batch is done
  };
  if (!t.model && t.provider === cfg.worker.provider) t.model = cfg.worker.model;
  if (t.provider === 'claude' && t.model) t.model = getModels().models.find((m) => m.provider === 'claude' && m.aliasOf?.includes(t.model))?.id || t.model;
  // Resolve a Codex task's sandbox now, not at dispatch, so the task record shows what it will actually run under.
  if (!t.sandbox && !i.followUpOf && t.provider === 'codex') t.sandbox = codexSandboxFor(t.model, cfg);
  if (t.followUpOf) {
    const parent = getTask(t.followUpOf);
    if (!parent) throw Object.assign(new Error(`unknown task ${t.followUpOf}`), { status: 404 });
    if (!parent.threadId) throw Object.assign(new Error(`task ${parent.id} has no resumable thread (provider ${parent.provider})`), { status: 400 });
    if (!TERMINAL.has(parent.status)) throw Object.assign(new Error(`task ${parent.id} is still ${parent.status}; wait for it before following up`), { status: 400 });
    const holder = openTasks().find((task) => task.threadId === parent.threadId);
    if (holder) throw Object.assign(new Error(`task ${holder.id} is still ${holder.status} on thread ${parent.threadId}; wait for it before following up`), { status: 409 });
    Object.assign(t, { writableRoots: writableRoots.length ? writableRoots : parent.writableRoots || [], cwd: parent.cwd, provider: parent.provider, model: parent.model, effort: i.effort || parent.effort, sandbox: i.sandbox || parent.sandbox || null, parallelOverride: !!(i.parallelOverride || parent.parallelOverride), threadId: parent.threadId, rounds: parent.rounds + 1, paths: parent.paths, title: t.title === 'task' ? `${parent.title} (round ${parent.rounds + 2})` : t.title, category: parent.category, difficulty: parent.difficulty, source: parent.source || 'live' });
    if (parent.isolation) { t.isolate = true; t.isolation = parent.isolation; }
    if (t.rounds > cfg.worker.maxRounds) t.warning = `fix round ${t.rounds} exceeds maxRounds=${cfg.worker.maxRounds}: consider escalating — delegate with retry_of ${t.id} to auto-pick the best AVAILABLE model (up to worker.escalationRounds=${cfg.worker.escalationRounds} attempt(s)); finish it yourself only if that also fails. If this worker is ALREADY the best available model for ${t.category || 'this'}@${t.difficulty ?? 2}, the cap does not apply: keep following up, because a retry_of would route downward (delegate will say so and refuse).`;
  }
  if (i.isolation && typeof i.isolation.dir === 'string') { t.isolation = i.isolation; t.isolate = true; }
  else if (!t.followUpOf && (i.isolate === true || (t.retryOf && getTask(t.retryOf)?.isolate))) {
    if (t.sandbox === 'read-only') t.warning = [t.warning, 'isolate ignored: sandbox is read-only (nothing to isolate)'].filter(Boolean).join(' ');
    else if (!findGitRoot(t.cwd)) t.warning = [t.warning, 'isolate ignored: cwd is not inside a git repo'].filter(Boolean).join(' ');
    else t.isolate = true;
  }
  // Guard (Method C / D): never record or dispatch an effort a model can't honor. A model with NO effort dimension
  // (agy passthrough and codex-spark) must carry none. An effort-in-id family (agy: it has an
  // effortIds map) given a level it doesn't offer (a hand-routed xhigh/max/ultra on a flash family) is clamped to
  // its top real level, so neither a nonsensical sel like `…-flash-low:high` nor a bare-family dispatch can land.
  if (t.effort && t.model) {
    const m = findModel(t.provider, t.model);
    if (m && Array.isArray(m.efforts)) {
      if (!m.efforts.length) { t.warning = [t.warning, `dropped effort "${t.effort}": ${t.provider}:${t.model} has no effort levels`].filter(Boolean).join(' '); t.effort = null; }
      else if (!m.efforts.includes(t.effort) && m.efforts.some((e) => EFFORTS.includes(e))) {
        // H3: clamp to the nearest offered effort by EFFORTS ordering (works for both effortIds families and plain efforts lists like Grok's low/medium/high)
        const wantIdx = EFFORTS.indexOf(t.effort);
        const ranked = m.efforts.filter((e) => EFFORTS.includes(e)).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
        const c = wantIdx < 0 ? ranked[ranked.length - 1] : (ranked.findLast((e) => EFFORTS.indexOf(e) <= wantIdx) ?? ranked[ranked.length - 1]);
        t.warning = [t.warning, `clamped effort "${t.effort}" to "${c}": ${t.provider}:${t.model} offers only ${m.efforts.join('/')}`].filter(Boolean).join(' ');
        t.effort = c;
      }
    }
  }
  tasks.set(t.id, t);
  persist(t);
  if (dispatch) schedule();
  return t;
}

/** writable_roots: absolute paths of existing directories (a typo must not silently leave the worker without access). */
function checkWritableRoots(roots) {
  if (roots == null) return [];
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== 'string')) throw Object.assign(new Error('writable_roots must be an array of absolute directory paths'), { status: 400 });
  for (const r of roots) {
    let dir = false;
    try { dir = isAbsolute(r) && statSync(r).isDirectory(); } catch {}
    if (!dir) throw Object.assign(new Error(`writable_roots: ${r} is not an existing absolute directory`), { status: 400 });
  }
  return [...new Set(roots.map((r) => resolve(r)))];
}

export function cancelTask(id, reason) {
  const t = getTask(id); if (!t) return null;
  if (TERMINAL.has(t.status)) return t;
  t.status = 'canceled'; t.error = reason || 'canceled';
  if (reason === 'timeout') { t.timedOut = true; t.failKind = 'timeout'; }
  delete t.park; t.resumeAt = null; armWake();
  running.get(id)?.abort();
  persist(t); wake(t);
  return t;
}

/** Move a restart-stale task back to the queue after the user chooses Re-run. */
export function rerunTask(id) {
  const t = getTask(id);
  if (!t || t.status !== 'stale') return null;
  t.status = 'queued'; t.resume = true; t.recoveries = 0; t.error = null;
  persist(t);
  return t;
}

/** Watchdog last resort: abort a proven hang, but do not score infrastructure silence against the model. */
export function failHungTask(id, reason) {
  const t = getTask(id); if (!t || TERMINAL.has(t.status)) return null;
  t.status = 'failed'; t.failKind = 'hung'; t.error = reason; t.finishedAt = nowIso();
  running.get(id)?.abort();
  persist(t); wake(t);
  return t;
}

/** Cancel the live replacement(s), including malformed cyclic chains, without claiming a terminal task was canceled. */
export function cancelChain(id) {
  let t = getTask(id);
  if (!t) return null;
  const visited = new Set(), canceled = [];
  let already = null;
  while (t && !visited.has(t.id)) {
    visited.add(t.id);
    if (TERMINAL.has(t.status)) already = t.status;
    else { cancelTask(t.id); canceled.push(t.id); }
    t = t.failedOverTo ? getTask(t.failedOverTo) : null;
  }
  return { canceled, already: canceled.length ? null : already };
}

let shuttingDown = false;
let draining = false;
export function setDraining(value) { draining = !!value; }
/** Abort every active worker. With `requeue`, persist queued+resume before aborting (graceful shutdown). */
export function abortRunning({ requeue = false } = {}) {
  shuttingDown = requeue;
  let journalError = null;
  if (requeue) for (const id of running.keys()) {
    const t = tasks.get(id);
    if (!t || t.status !== 'running') continue;
    t.status = 'queued'; t.resume = true; t.interruptedAt = nowIso(); t.error = 'interrupted by shutdown; resumes on next start';
    try { persist(t); } catch (e) { journalError ||= e; }
  }
  for (const ac of running.values()) ac.abort();
  if (journalError) throw journalError;
}

/** Await in-flight task settle promises, bounded by timeoutMs. */
export async function awaitRunning(timeoutMs = 1200) {
  const pending = [...runningSettle.values()];
  if (!pending.length) return;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function consumeWake(t) {
  if (t?.wakeEligible && TERMINAL.has(t.status) && !t.wakeConsumedAt) {
    t.wakeConsumedAt = nowIso();
    try { persistQuiet(t); } catch {} // a broken journal must never strand an awaiter
  }
}
const waitResult = (t) => {
  consumeWake(t);
  return t?.status === 'parked' ? { ...publicTask(t), parked: true, message: `parked until ${new Date(t.resumeAt).toISOString()}` } : publicTask(t);
};

/** Resolve at a terminal state or a park beyond this wait's deadline, else wait until timeout. */
export function awaitTask(id, timeoutMs, { onPark = 'deadline' } = {}) {
  let t = getTask(id);
  if (!t) return Promise.resolve(null);
  if (timeoutMs == null) {
    const wcfg = loadConfig().worker;
    const minutes = wcfg.timeoutByCategory[t.category] ?? wcfg.timeoutMinutes;
    timeoutMs = (minutes > 0 ? minutes : 55) * 60_000;
  }
  timeoutMs = Math.min(2 ** 31 - 1, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    let currentId = id, followedFrom = null, timer;
    const followed = new Set([id]);
    const unlink = () => {
      const list = waiters.get(currentId) || [];
      const next = list.filter((x) => x !== waiter);
      if (next.length) waiters.set(currentId, next); else waiters.delete(currentId);
    };
    const detach = () => {
      unlink();
      clearTimeout(timer);
    };
    const finish = (task, extra = {}) => {
      detach();
      resolve(task ? { ...waitResult(task), ...(followedFrom ? { followedFrom } : {}), ...extra } : null);
    };
    const attach = (task) => {
      if (!task) return finish(getTask(currentId));
      currentId = task.id;
      if (TERMINAL.has(task.status) || task.status === 'stale') {
        if (task.status === 'failed' && task.failedOverTo) {
          const target = getTask(task.failedOverTo);
          if (target && !followed.has(target.id)) { followed.add(target.id); followedFrom ||= task.id; attach(target); return; }
        }
        finish(task); return;
      }
      if (task.status === 'parked') {
        const until = resumeAtMs(task.resumeAt);
        if (onPark === 'any' || (onPark === 'deadline' && until > deadline)) { finish(task); return; }
      }
      waiters.set(currentId, [...(waiters.get(currentId) || []), waiter]);
    };
    const waiter = {
      deadline,
      onPark,
      done: (task) => {
        if (task.status === 'failed' && task.failedOverTo) {
          const target = getTask(task.failedOverTo);
          if (target && !followed.has(target.id)) { unlink(); followed.add(target.id); followedFrom ||= task.id; attach(target); return true; }
        }
        if (task.status === 'parked') {
          if (onPark === 'any' || (onPark === 'deadline' && resumeAtMs(task.resumeAt) > deadline)) finish(task);
          else return false;
        } else if (onPark === 'never' && !TERMINAL.has(task.status) && task.status !== 'stale') {
          return false;
        }
        finish(task);
        return true;
      },
    };
    timer = setTimeout(() => {
      detach();
      const task = getTask(currentId);
      resolve(task ? { ...publicTask(task), timedOut: true, ...(followedFrom ? { followedFrom } : {}) } : null);
    }, timeoutMs);
    attach(t);
  });
}

function wake(t) {
  const pending = [];
  for (const w of waiters.get(t.id) || []) {
    if (w.done(t) === false) pending.push(w);
  }
  if (pending.length) waiters.set(t.id, pending);
  else waiters.delete(t.id);
}

/** Providers whose CLI is being updated (core/cli-update.mjs): their queued tasks wait; only the update's own check task runs. */
export const heldProviders = new Set();

export function schedule() {
  if (shuttingDown || draining) return;
  if (process.env.CONDUCTOR_NO_SCHEDULE) return; // tests
  withLimitsSnapshot(scheduleOnce); // one limits read per pass
}

function scheduleOnce() {
  if (shuttingDown || draining) return;
  const cfg = loadConfig();
  const ramHeld = resourceStatus(cfg).held;
  const queued = openTasks().filter((t) => t.status === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  if (!queued.length) { clearRamRetry(); return; }
  if (ramHeld) { armRamRetry(); return; } // keep work queued and check again after the retry delay
  clearRamRetry();
  const max = cfg.conductor.maxWorkerConcurrency;
  const budget = cfg.conductor.budgetGate !== false; // framework budget gate: on unless explicitly disabled
  if (running.size >= max) return;
  const rows = budget ? activeRunRows() : null;
  const costCache = new Map();
  const costByWindow = (t) => {
    const cell = { model: t.model, effort: t.effort, category: t.category, difficulty: t.difficulty };
    const key = JSON.stringify([t.provider, cell]);
    if (!costCache.has(key)) costCache.set(key, measuredCostByWindow(rows, t.provider, cell));
    return costCache.get(key);
  };
  // Cost already committed by in-flight tasks, per provider AND per window id — so a batch does not collectively
  // overrun any one window (a Claude task's % is charged only to Claude's windows, not to a grouped provider's others).
  const addCost = (acc, prov, costs) => { acc[prov] = acc[prov] || {}; for (const [id, c] of Object.entries(costs)) acc[prov][id] = (acc[prov][id] || 0) + c; };
  // A task's cost is UNMEASURED (probe-gated) if the provider reports windows but the task lacks a measured cost
  // for ANY of them — a newly-appeared window with no history counts as unknown, not free.
  const isUnmeasured = (t) => providerWindows(t.provider, t.model).some((w) => isBudgetWindow(w) && !(w.id in costByWindow(t)));
  const runningByWindow = {};
  const probing = {}; // provider -> a probe (unmeasured task) is in flight / dispatched this pass; hold everything else on it
  const reserved = new Set([...running.keys(), ...settling]);
  if (budget) for (const id of reserved) { const rt = tasks.get(id); if (rt) { addCost(runningByWindow, rt.provider, costByWindow(rt)); if (isUnmeasured(rt)) probing[rt.provider] = true; } }
  const dispatchedByWindow = {}; // provider -> { windowId: % committed this pass }
  const providerBusy = (prov) => Object.keys(dispatchedByWindow[prov] || {}).length > 0 || [...running.keys(), ...settling].some((id) => tasks.get(id)?.provider === prov);
  const failovers = [];
  for (const t of queued) {
    if (t.status !== 'queued') continue; // a synchronous setup failure can schedule the next task immediately
    if (heldProviders.has(t.provider) && t.sessionId !== 'cli-update') continue;
    if (running.size >= max) break;
    const block = modelBlock(t.provider, t.model);
    if (block) {
      const next = t.efficiencyMode ? null : failover(t);
      if (next) {
        t.limitHit = true; t.finishedAt = nowIso(); persist(t); wake(t);
        failovers.push(next);
      } else park(t, block.until, `provider ${t.provider} is at its usage limit`, { source: block.source });
      continue;
    }
    if (budget && !t.parallelOverride) { // a task from a chat with the parallel override skips the gate entirely
      if (probing[t.provider]) continue; // a probe of unknown cost is measuring this provider; hold ALL its tasks until it returns
      const windows = providerWindows(t.provider, t.model);
      const costs = costByWindow(t);
      const unmeasured = isUnmeasured(t); // windowed provider missing a cost for some window -> one probe at a time (windowless API/local providers have no window to protect)
      const committed = { ...(runningByWindow[t.provider] || {}) };
      for (const [id, c] of Object.entries(dispatchedByWindow[t.provider] || {})) committed[id] = (committed[id] || 0) + c;
      const a = admit(windows, [{ costs }], { runningByWindow: committed, maxParallel: 1, windowTargets: cfg.scorecard.windowTargets });
      if (!a.n || unmeasured) {
        // Over the per-window target (or cost still unknown) we DON'T pause. Policy: degrade to SEQUENTIAL per
        // provider and keep issuing — a task that runs into the real provider limit then hands off via failover
        // (below), so another agent takes over instead of the queue stalling. Hold this task only while its
        // provider already has one in flight or settling; it resumes after usage and score settle. Never a queued-forever park.
        if (providerBusy(t.provider)) continue;
      }
      if (unmeasured) probing[t.provider] = true; // this dispatch IS the probe; nothing else on this provider runs alongside it
      addCost(dispatchedByWindow, t.provider, unmeasured ? { __probe: 100 } : costs);
    }
    void run(t);
  }
  if (failovers.length) schedule();
}

function armRamRetry() {
  if (ramRetryTimer) return;
  ramRetryTimer = setTimeout(() => { ramRetryTimer = null; schedule(); }, 30_000);
  ramRetryTimer.unref();
}

function clearRamRetry() {
  if (!ramRetryTimer) return;
  clearTimeout(ramRetryTimer);
  ramRetryTimer = null;
}

function park(t, until, reason, { kind = 'limit', source = 'guess' } = {}) {
  t.status = 'parked'; t.resumeAt = until; t.error = reason; t.resume = t.attempts > 0; // only a run that started can be resumed
  t.park = { kind, until, source, provider: t.provider };
  persist(t);
  wake(t);
  armWake();
}

let wakeTimer = null;
function armWake() {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  const earliest = [...tasks.values()].filter((t) => t.status === 'parked').reduce((at, t) => Math.min(at, resumeAtMs(t.park?.until ?? t.resumeAt)), Infinity);
  if (!Number.isFinite(earliest) || shuttingDown) return;
  wakeTimer = setTimeout(wakeDue, Math.min(2 ** 31 - 1, Math.max(1000, earliest - Date.now())));
  wakeTimer.unref();
}
async function wakeDue() {
  wakeTimer = null;
  if (shuttingDown) return;
  const due = [...tasks.values()].filter((t) => t.status === 'parked' && resumeAtMs(t.park?.until ?? t.resumeAt) <= Date.now())
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
  const providers = [...new Set(due.filter((t) => (t.park?.kind || 'limit') === 'limit').map((t) => t.park?.provider || t.provider))];
  for (const provider of providers) await refreshLimits({ only: [provider] }).catch(() => {});
  for (const t of due) if (t.status === 'parked' && !shuttingDown) { t.status = 'queued'; t.resumeAt = null; delete t.park; persist(t); }
  if (due.length && !draining && !shuttingDown) schedule();
  armWake();
}

export function reviewParked() {
  let released = false, changed = false;
  for (const t of tasks.values()) {
    if (t.status !== 'parked' || (t.park?.kind || 'limit') !== 'limit') continue;
    const migrated = !t.park;
    const park = t.park ||= { kind: 'limit', until: t.resumeAt, source: 'guess', provider: t.provider };
    const block = modelBlock(t.provider, t.model);
    if (!block) {
      if (providerWindows(t.provider, t.model).length) {
        t.status = 'queued'; t.resumeAt = null; delete t.park; persist(t); released = changed = true;
      } else if (migrated) { persist(t); changed = true; }
    } else if (block.source !== 'guess' && block.until !== resumeAtMs(park.until ?? t.resumeAt)) {
      park.until = t.resumeAt = block.until; park.source = block.source; park.provider ||= t.provider; persist(t); changed = true;
    } else if (migrated) { persist(t); changed = true; }
  }
  if (changed) armWake();
  if (released && !draining && !shuttingDown) schedule();
}
bus.on('event', (e) => { if (e.type === 'limits') reviewParked(); });

async function run(t) {
  let settleResolve;
  runningSettle.set(t.id, new Promise((resolve) => { settleResolve = resolve; }));
  try {
    const ac = new AbortController();
    running.set(t.id, ac);
    t.status = 'running'; t.resumeAt = null; delete t.park; t.startedAt = nowIso(); t.attempts += 1; t.error = null; t.limitHit = false; t.authFailed = false; t.envFailed = false;
    persist(t);
    const limitsBefore = snapshotWindows(t.provider);
    // Each window needs its own divisor: Opus and Sonnet share global windows, but only Sonnet consumes its
    // exclusive weekly window. Keep the scalar for older ledger readers; new accounting uses the per-window map.
    const myWins = new Set(providerWindows(t.provider, t.model).map((w) => w.id));
    const concurrentByWindow = Object.fromEntries([...myWins].map((id) => [id, 0]));
    const concurrent = [...running.keys()].filter((id) => {
      if (id === t.id) return false; const rt = tasks.get(id); if (rt?.provider !== t.provider) return false;
      const rw = providerWindows(rt.provider, rt.model).map((w) => w.id);
      for (const wid of rw) if (myWins.has(wid)) concurrentByWindow[wid]++;
      return rw.length === 0 || rw.some((wid) => myWins.has(wid));
    }).length;
    const runCwd = t.isolate ? await prepareIsolation(t) : t.cwd;
    const before = await gitStatus(runCwd); // async: N tasks starting together must not serialize the event loop on git
    Object.assign(t, await repoSize(runCwd)); // repoFiles / repoBytes on the run row: the project-size signal for later tool scoring
    const wcfg = loadConfig().worker;
    const prompt = buildPrompt(t);
    const timeoutMs = runTimeoutMs(wcfg.timeoutByCategory[t.category] ?? wcfg.timeoutMinutes);
    const r = await runWorker({ ...t, cwd: runCwd, prompt, ...(timeoutMs ? { timeoutMs } : {}) }, { signal: ac.signal });
    live.delete(t.id); delete t.progress; // the result replaces the snapshot
    const abortedDuringRun = ac.signal.aborted; // E1: a shutdown during the bookkeeping below must not requeue a finished run
    if ((r.durationMs || 0) > (wcfg.longRunMinutes) * 60_000) logImprovement('friction', `worker:${t.provider}`, `long run: ${Math.round(r.durationMs / 60_000)} min (${t.category || 'untagged'}, ${t.model || 'default'}:${t.effort || 'default'})`, { taskId: t.id, title: t.title });
    t.threadId = r.threadId || t.threadId;
    if (r.timedOut === true || /^timeout(?:\b| after)/i.test(String(r.error || ''))) { t.timedOut = true; t.failKind = 'timeout'; }
    t.httpStatus = r.httpStatus ?? null; t.exitCode = r.exitCode ?? null;
    const reliability = reliabilityMetrics({ ...t, result: r });
    t.result = { finalMessage: r.finalMessage || '', servedModel: r.servedModel || null, usage: r.usage || null, costUsd: r.costUsd || 0, durationMs: r.durationMs || 0, items: (r.items || []).slice(-40), files: r.files, tools: countTools(r.items),
      turns: reliability.turns, toolCalls: reliability.toolCalls, toolErrors: reliability.toolErrors, thrash: reliability.thrash, timedOut: reliability.timedOut,
      httpStatus: r.httpStatus ?? null, exitCode: r.exitCode ?? null, limitHit: !!r.limitHit, authFailed: !!r.authFailed, envFailed: !!r.envFailed };
    const slash = (p) => process.platform === 'win32' ? p.replaceAll('\\', '/') : p; // git reports '/', Windows workers '\\': one file, one entry
    const rel = (p) => { try { return slash(isAbsolute(p) ? relative(runCwd, p) || p : p); } catch { return p; } };
    const after = await gitStatus(runCwd); // one status read serves the changed-file list, the phantom check and the diff stat
    const observed = diffStatus(before, after);
    const claimed = claimedWrites(r.items);
    t.changedFiles = [...new Set([...observed, ...claimed].map(rel))];
    t.diffStat = await gitDiffStat(runCwd, after, observed);
    // G5: a claimed file that is gitignored or outside the repo won't appear in git status; confirm via disk mtime.
    // Only files that exist AND were modified at or after the task started are enough to disprove a phantom verdict.
    const taskStartMs = Date.parse(t.startedAt) || 0;
    const claimedExistsOnDisk = claimed.length > 0 && observed.length === 0 && await (async () => {
      for (const p of claimed) {
        try { const s = await stat(resolve(runCwd, p)); if (s.mtimeMs >= taskStartMs - 1000) return true; } catch {}
      }
      return false;
    })();
    const phantom = !claimedExistsOnDisk && isPhantomCompletion({ ok: r.ok, claimed, canVerify: before !== null, observedCount: observed.length });
    if (!(shuttingDown && ac.signal.aborted && t.status === 'queued' && (abortedDuringRun || (r.limitHit && !r.ok)))) t.resume = false;
    let confirmedLimitUntil = null;
    if (r.limitHit && !r.ok && t.status !== 'canceled' && !(shuttingDown && ac.signal.aborted)) {
      confirmedLimitUntil = noteLimitHit(t.provider, { model: t.model, retryAfterMs: r.retryAfterMs, resetsAt: nextScheduledReset(t.provider) });
      await refreshLimits({ only: [t.provider] }).catch(() => {}); // quota view drives the next pick; cancellation/shutdown must be checked AFTER this await
      if (t.status !== 'canceled' && !(shuttingDown && ac.signal.aborted)) {
        t.limitHit = true; // never scored against the model
      }
    }
    if (r.ok) noteLimitAvailable(t.provider, t.model, t.startedAt);
    if (t.status === 'canceled' || (t.status === 'failed' && t.failKind === 'hung')) { /* watchdog/user already decided it */ }
    else if (shuttingDown && ac.signal.aborted && (abortedDuringRun || (r.limitHit && !r.ok))) {
      if (t.status === 'running') {
        t.status = 'queued'; t.resume = true; t.interruptedAt ||= nowIso(); t.error = 'interrupted by shutdown; resumes on next start';
      } // abortRunning already persisted the graceful requeue before signaling this controller
    }
    else if (r.limitHit && !r.ok) {
      const next = t.efficiencyMode ? null : failover(t);
      if (!next) {
        const block = modelBlock(t.provider, t.model);
        const until = block?.until || confirmedLimitUntil;
        const source = block?.source || (r.retryAfterMs || nextScheduledReset(t.provider) ? 'retry-after' : 'guess');
        park(t, until, r.error || 'usage limit', { source });
        logImprovement('friction', `worker:${t.provider}`, 'usage limit hit; task parked until the provider window resets', { taskId: t.id, model: t.model, resumeAt: new Date(until).toISOString() });
      }
    } else if ((r.authFailed || r.envFailed) && !r.ok) {
      // A broken sign-in or API key, or a harness fault (grok plan mode cancelling a tool), is the environment, not the
      // model: recorded, never scored (the smoke battery voids these too).
      t.status = 'failed'; t.failKind = r.authFailed ? 'auth' : 'env'; t.authFailed = !!r.authFailed; t.envFailed = !r.authFailed; t.error = r.error || 'environment failure';
      logImprovement('error', `worker:${t.provider}`, t.error, { taskId: t.id, model: t.model, title: t.title });
    } else if (!r.ok) {
      t.status = 'failed'; t.error = r.error || 'worker failed';
      if (envFailure(t)) { t.failKind = 'env'; t.envFailed = true; t.error = `environment: ${t.error}`; }
      logImprovement('error', `worker:${t.provider}`, t.error, { taskId: t.id, model: t.model, title: t.title });
    } else if (phantom) {
      t.status = 'failed'; t.failKind = 'phantom';
      t.error = `phantom completion: worker reported file write(s) (${claimed.slice(0, 3).join(', ')}${claimed.length > 3 ? ', …' : ''}) but none landed on disk (git shows no change). Recorded as a phantom-failure verdict.`;
      logImprovement('error', `worker:${t.provider}`, `phantom completion: claimed ${claimed.length} write(s), 0 landed`, { taskId: t.id, model: t.model, title: t.title });
    } else if (!String(r.finalMessage || '').trim() && before !== null && !observed.length && !r.files?.length) { // git-visible only: outside a repo a change can't be seen
      // Seen from agy Gemini Flash on read-only tasks: "done" after one tool call with no report and no change.
      t.status = 'failed'; t.failKind = 'empty';
      t.error = 'empty report: the worker ended without a final message or any file change';
      logImprovement('error', `worker:${t.provider}`, t.error, { taskId: t.id, model: t.model, title: t.title });
    } else { t.status = 'done'; }
    if (t.isolate && t.isolation && (t.status === 'done' || t.status === 'failed')) await finishIsolation(t, runCwd);
    if (TERMINAL.has(t.status)) t.recoveries = 0;
    t.finishedAt = nowIso();
    persist(t);
    // A plain cancel is not scored (its ~0 tokens would drag the model's cost means). A smoke timeout
    // still needs a run row so rateTask(id, 'fail', 'timeout') has something to attach to (OB6).
    if (TERMINAL.has(t.status) && t.failKind !== 'hung' && !t.limitHit && !t.authFailed && !t.envFailed && (t.status !== 'canceled' || t.error === 'timeout')) score(t, limitsBefore, concurrent, concurrentByWindow);
    if (t.failKind === 'phantom') { try { rateTask(t.id, 'phantom', 'auto: reported file writes that never landed on disk'); } catch {} }
  } catch (e) {
    // G8: if the outcome was already decided (persist() threw after the status was set), keep the decided status.
    const alreadyDecided = TERMINAL.has(t.status) || t.status === 'parked' || t.status === 'queued';
    if (!alreadyDecided) { t.status = 'failed'; t.error = String(e?.message || e); t.finishedAt = nowIso(); }
    else { try { logImprovement('error', `worker:${t.provider}`, `journal persist failed after ${t.status}: ${e?.message || e}`, { taskId: t.id }); } catch {} }
    if (TERMINAL.has(t.status)) t.recoveries = 0;
    try {
      persist(t);
    } catch (err2) {
      if (alreadyDecided) {
        try { logImprovement('error', `worker:${t.provider}`, `retry persist failed after ${t.status}: ${err2?.message || err2}`, { taskId: t.id }); } catch {}
        setTimeout(() => { try { persist(t); } catch {} }, 50).unref?.();
      }
    }
  } finally {
    running.delete(t.id); live.delete(t.id); delete t.progress;
    runningSettle.delete(t.id);
    settleResolve?.();
    trimTasks();
    try { if (TERMINAL.has(t.status) || t.status === 'parked') wake(t); } catch {}
    try { if (!shuttingDown) schedule(); } catch {}
  }
}

/**
 * A provider hit its limit mid-task: re-issue the same spec on the next recommended provider as a retry chain
 * (the section that fell silent hands the part to the next one). null when nothing else qualifies.
 */
function failover(t) {
  if (!t.category || t.followUpOf || t.source === 'smoke' || t.noFailover) return null; // a battery/benchmark measures one selection; never hand its tasks to another
  try {
    const gate = accessProviders(`${t.title}\n${t.spec}`); // OG4: honour the capability access gate (same as delegate)
    let providers = Object.keys(PROVIDERS);
    if (gate?.providers) providers = providers.filter((id) => gate.providers.includes(id));
    const avoid = t.avoidFamilies || [];
    const groupWindows = t.model ? providerWindows(t.provider, t.model) : [];
    const exclude = selsInFamilies(avoid);
    if (groupWindows.length) {
      const group = groupOf(t.provider, t.model).ids.join(',');
      exclude.push(...getModels().models
        .filter((m) => m.provider === t.provider && groupOf(m.provider, m.id).ids.join(',') === group)
        .map((m) => `${m.provider}:${m.id}`));
    } else providers = providers.filter((id) => id !== t.provider);
    const difficulty = t.difficulty || 2;
    const alt = recommend({ category: t.category, difficulty, providers, overflowApi: !!t.overflowApi, exclude });
    if (!alt || avoid.includes(familyOf(alt.provider, alt.model))) return null;
    const spec = `${t.attempts > 0 ? FAILOVER_NOTE : ''}${t.spec}`;
    const sandbox = alt.provider === 'codex' && (alt.provider !== t.provider || alt.model !== t.model) && t.sandbox !== 'read-only' ? undefined : t.sandbox;
    const n = createTask({ sessionId: t.sessionId, cwd: t.cwd, title: `FAILOVER: ${t.title}`.slice(0, 200), spec, provider: alt.provider, model: alt.model, effort: alt.effort, paths: t.paths, category: t.category, difficulty, retryOf: t.retryOf || null, reroutedFrom: t.id, source: t.source, variant: t.variant, overflowApi: t.overflowApi, parallelOverride: t.parallelOverride, efficiencyMode: t.efficiencyMode, sandbox, avoidFamilies: avoid, writableRoots: t.writableRoots, isolate: t.isolate || undefined, isolation: t.isolation || undefined }, { dispatch: false });
    t.status = 'failed'; t.failedOverTo = n.id; t.error = `provider ${t.provider} at its limit; failed over to task ${n.id} (${n.provider}:${n.model || 'default'}:${n.effort || 'default'}) — await that id`;
    logImprovement('friction', `worker:${t.provider}`, `usage limit hit; failed over to ${n.provider}:${n.model || 'default'}`, { taskId: t.id, next: n.id });
    return n;
  } catch { return null; }
}

// Scorecard row after the provider's limits are re-polled (so the window delta is fresh). Waiters are
// not held up; `flushRecords` lets the CLI/smoke runner wait for the rows before reading them.
const pendingRecords = new Set();
function score(t, limitsBefore, concurrent, concurrentByWindow) {
  settling.add(t.id);
  // The first refresh may join a poll started before completion. Drain it before requesting a
  // second refresh, which must have started after completion (the scope entry clears on settlement).
  const { joined, promise } = refreshLimitsWithMeta({ only: [t.provider] });
  const p = promise.catch(() => {})
    .then(() => joined ? refreshLimits({ only: [t.provider] }) : undefined).catch(() => {}).then(() => { try {
    // Per-task % of the provider window this run burned (max across its windows) — surfaced on the Fleet card.
    const d = windowDelta(limitsBefore, snapshotWindows(t.provider));
    if (d) { const max = Math.max(...Object.values(d)); t.pctWindow = Math.round(max * 10) / 10; persist(t); }
    recordRun(t, { before: limitsBefore, concurrent, concurrentByWindow });
  } catch {} }).finally(() => {
    settling.delete(t.id);
    trimTasks();
    pendingRecords.delete(p);
    try { if (!shuttingDown) schedule(); } catch {}
  });
  pendingRecords.add(p);
}
export const flushRecords = () => Promise.allSettled([...pendingRecords]);

/** Attempt root: walk followUpOf only. A retry_of is a new chain root (fresh worktree). */
function chainRootId(t) {
  const seen = new Set();
  let cur = t;
  while (cur?.followUpOf && !seen.has(cur.id)) {
    seen.add(cur.id);
    const p = getTask(cur.followUpOf);
    if (!p) break;
    cur = p;
  }
  return cur.id;
}

async function prepareIsolation(t) {
  const root = findGitRoot(t.cwd);
  if (!root) throw new Error('isolate: cwd is not inside a git repo');
  if (t.isolation?.dir && existsSync(t.isolation.dir)) { await linkIsolateDirs(t, root, t.isolation.dir); return isolatedCwd(t); }
  const dir = t.isolation?.dir || statePath('worktrees', chainRootId(t));
  mkdirSync(statePath('worktrees'), { recursive: true });
  let base = t.isolation?.base;
  if (!existsSync(dir)) {
    base = (await gitExec(root, ['rev-parse', 'HEAD'])).trim();
    await gitExec(root, ['worktree', 'add', '--detach', dir, 'HEAD'], 120_000);
  }
  t.isolation = { dir, base: base || t.isolation?.base, branch: t.isolation?.branch ?? null };
  await linkIsolateDirs(t, root, dir);
  persist(t);
  return isolatedCwd(t);
}

async function finishIsolation(t, runCwd) {
  const dir = t.isolation.dir;
  const branch = t.isolation.branch || `conductor/${chainRootId(t)}`;
  if (!t.isolation.branch) {
    try { await gitExec(dir, ['switch', '-c', branch]); }
    catch { await gitExec(dir, ['switch', branch]); }
    t.isolation.branch = branch;
  }
  await gitExec(dir, ['add', '-A']);
  let committed = false;
  try {
    await gitExec(dir, ['commit', '-m', `${t.title} (conductor task ${t.id})`], 120_000);
    committed = true;
  } catch (e) {
    if (!/nothing to commit/i.test(String(e.message))) t.warning = [t.warning, `isolate commit skipped: ${e.message}`].filter(Boolean).join(' ');
  }
  if (!committed) return;
  const names = (await gitExec(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).trim();
  const slash = (p) => process.platform === 'win32' ? p.replaceAll('\\', '/') : p;
  t.changedFiles = names ? names.split(/\r?\n/).filter(Boolean).map((n) => {
    try { return slash(relative(runCwd, join(dir, n)) || n); } catch { return slash(n); }
  }) : [];
  t.diffStat = ((await gitExec(dir, ['show', '--stat', '--format=', 'HEAD'])) || '').trim().slice(0, 3000);
}

function tasksUsingDir(dir) {
  const out = [];
  try {
    for (const f of readdirSync(DIR())) {
      if (!f.endsWith('.json')) continue;
      const t = getTask(f.slice(0, -5));
      if (t?.isolation?.dir === dir) out.push(t);
    }
  } catch {}
  return out;
}

export async function cleanupWorktree(taskId, { deleteBranch = false } = {}) {
  const t = getTask(taskId);
  if (!t) return `unknown task ${taskId}`;
  const iso = t.isolation;
  if (!iso?.dir) return `task ${taskId} has no isolation worktree`;
  const root = findGitRoot(t.cwd);
  const notes = [];
  if (existsSync(iso.dir)) {
    if (!root) return `worktree_cleanup failed: cannot find git repo for ${taskId}`;
    try { unlinkIsolateLinks(root, iso.dir, t.cwd); await gitExec(root, ['worktree', 'remove', '--force', iso.dir], 120_000); notes.push(`removed worktree ${iso.dir}`); }
    catch (e) { return `worktree_cleanup failed: ${e.message}`; }
  } else notes.push(`worktree ${iso.dir} already gone`);
  if (deleteBranch && iso.branch && root) {
    try { await gitExec(root, ['branch', '-D', iso.branch]); notes.push(`deleted branch ${iso.branch}`); }
    catch (e) { notes.push(`branch ${iso.branch}: ${e.message}`); }
  }
  return notes.join('; ') || `removed worktree ${iso.dir}`;
}

export async function listWorktrees({ pruneDays } = {}) {
  const rootDir = statePath('worktrees');
  if (!existsSync(rootDir)) return [];
  const cutoff = pruneDays != null ? Date.now() - pruneDays * 86_400_000 : null;
  const out = [];
  for (const name of readdirSync(rootDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const dir = join(rootDir, name.name);
    const using = tasksUsingDir(dir);
    const live = using.find((x) => !TERMINAL.has(x.status));
    const latest = using.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || getTask(name.name);
    const endedAt = !live && using.length ? Math.max(...using.map((x) => Date.parse(x.finishedAt || x.updatedAt || '') || 0)) : null;
    let mtime = Date.now();
    try { mtime = statSync(dir).mtimeMs; } catch {}
    const ageMs = Date.now() - (endedAt || mtime);
    const entry = { taskId: name.name, dir, branch: latest?.isolation?.branch || null, status: live ? live.status : (latest?.status || 'unknown'), ageMs, age: ageLabel(ageMs), pruned: false };
    if (cutoff != null && endedAt && endedAt < cutoff) {
      const root = latest?.cwd ? findGitRoot(latest.cwd) : null;
      try {
        if (root) {
          unlinkIsolateLinks(root, dir, latest.cwd);
          await gitExec(root, ['worktree', 'remove', '--force', dir], 120_000);
        }
        entry.pruned = true;
      } catch (e) { entry.error = e.message; }
    }
    out.push(entry);
  }
  return out;
}
