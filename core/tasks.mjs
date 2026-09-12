// Worker tasks: journal on disk, FIFO scheduler with a concurrency cap, and park/resume when a
// provider hits a usage limit. A task = one worker run (or one follow-up on an existing thread).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute, relative } from 'node:path';
import { statePath, readJson, writeJson, nowIso, shortId, REPO_ROOT } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { bus } from './bus.mjs';
import { runWorker } from './workers/index.mjs';
import { contextBlock } from './context.mjs';
import { blockedUntil, refreshLimits } from './limits.mjs';
import { logImprovement } from './improve.mjs';
import { findCli } from './proc.mjs';
import { recordRun, snapshotWindows, CATEGORIES, recommend } from './scorecard.mjs';
import { recipeFor } from './recipes.mjs';
import { mcpServers } from './mcp.mjs';

const DIR = () => statePath('tasks');
const WORKER_PREAMBLE = readFileSync(join(REPO_ROOT, 'core', 'prompts', 'worker.md'), 'utf8');
// MSW kernel (necessity test for every claim): measured 2026-09-09 on the battery as 5-15% faster and 3-10% fewer output tokens at equal pass rate.
const MSW = readFileSync(join(REPO_ROOT, 'core', 'prompts', 'msw.md'), 'utf8');
const RESUME_NOTE = 'You were interrupted earlier (usage limit or restart). Continue from the current state of the files; do not redo finished work.\n\n';
const TERMINAL = new Set(['done', 'failed', 'canceled']);

const tasks = new Map();
const running = new Map();   // id -> AbortController
const waiters = new Map();   // id -> resolve[]

// Load the journal so history survives restarts and interrupted work resumes.
try {
  for (const f of readdirSync(DIR())) {
    if (!f.endsWith('.json')) continue;
    const t = readJson(join(DIR(), f));
    if (!t?.id) continue;
    if (t.status === 'running' || t.status === 'parked') { t.status = 'queued'; t.resume = true; }
    tasks.set(t.id, t);
  }
} catch {}

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
    category: CATEGORIES.includes(i.category) ? i.category : i.category ? 'other' : null,
    difficulty: Number.isInteger(i.difficulty) && i.difficulty >= 1 && i.difficulty <= 5 ? i.difficulty : null,
    source: i.source === 'smoke' ? 'smoke' : 'live',
    retryOf: typeof i.retryOf === 'string' && i.retryOf ? i.retryOf : null, // a new attempt after a failed task (any model): costs fold into one chain
    variant: typeof i.variant === 'string' && i.variant ? i.variant.slice(0, 40) : null, // A/B label (e.g. a policy file under test); rows keep it
    overflowApi: !!i.overflowApi, // the chat's API-overflow toggle at delegation time; failover honours it
  };
  if (!t.model && t.provider === cfg.worker.provider) t.model = cfg.worker.model;
  if (t.followUpOf) {
    const parent = tasks.get(t.followUpOf);
    if (!parent) throw Object.assign(new Error(`unknown task ${t.followUpOf}`), { status: 404 });
    if (!parent.threadId) throw Object.assign(new Error(`task ${parent.id} has no resumable thread (provider ${parent.provider})`), { status: 400 });
    if (!TERMINAL.has(parent.status)) throw Object.assign(new Error(`task ${parent.id} is still ${parent.status}; wait for it before following up`), { status: 400 });
    Object.assign(t, { cwd: parent.cwd, provider: parent.provider, model: parent.model, effort: i.effort || parent.effort, sandbox: i.sandbox || parent.sandbox || null, threadId: parent.threadId, rounds: parent.rounds + 1, paths: parent.paths, title: t.title === 'task' ? `${parent.title} (round ${parent.rounds + 2})` : t.title, category: parent.category, difficulty: parent.difficulty, source: parent.source || 'live' });
    if (t.rounds > (cfg.worker.maxRounds || 3)) t.warning = `fix round ${t.rounds} exceeds maxRounds=${cfg.worker.maxRounds}; consider finishing this yourself`;
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

function buildPrompt(t) {
  const pre = t.resume ? RESUME_NOTE : '';
  if (t.followUpOf) return `${pre}Follow-up from the conductor on your previous work in this same thread. Address every point, re-run the verification, and report in the same format.\n\n${t.spec}`;
  const ctx = contextBlock(t.cwd, t.paths);
  const mcp = t.provider === 'codex' || t.provider === 'claude' ? Object.keys(mcpServers()) : [];
  const mcpNote = mcp.length ? `\n\nMCP servers available to you: ${mcp.join(', ')}. Use them for data instead of guessing.` : '';
  const msw = loadConfig().worker.msw === false ? '' : `

${MSW}

Remember to follow the MSW deletion rule for all claims - no exceptions.`;
  const recipe = recipeFor(t.category);
  return `${pre}${WORKER_PREAMBLE}${mcpNote}${msw}\n\n${ctx ? `# Project context notes\n${ctx}\n\n` : ''}# Task: ${t.title}\n\n${t.spec}${recipe ? `\n\n---\n\n${recipe}` : ''}`;
}

export function schedule() {
  if (process.env.CONDUCTOR_NO_SCHEDULE) return; // tests
  const max = loadConfig().conductor.maxWorkerConcurrency || 3;
  const queued = [...tasks.values()].filter((t) => t.status === 'queued').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  for (const t of queued) {
    if (t.status !== 'queued') continue; // A synchronous setup failure can schedule the next task immediately.
    if (running.size >= max) break;
    const until = blockedUntil(t.provider);
    if (until) { park(t, until, `provider ${t.provider} is at its usage limit`); continue; }
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
    const concurrent = [...running.keys()].filter((id) => id !== t.id && tasks.get(id)?.provider === t.provider).length;
    const before = gitStatus(t.cwd);
    const r = await runWorker({ ...t, prompt: buildPrompt(t), timeoutMs: (loadConfig().worker.timeoutMinutes || 45) * 60_000 }, { signal: ac.signal });
    t.threadId = r.threadId || t.threadId;
    t.result = { finalMessage: r.finalMessage || '', usage: r.usage || null, costUsd: r.costUsd || 0, durationMs: r.durationMs || 0, items: (r.items || []).slice(-40), files: r.files };
    const rel = (p) => { try { return isAbsolute(p) ? relative(t.cwd, p) || p : p; } catch { return p; } };
    t.changedFiles = [...new Set([...changedSince(t.cwd, before), ...(r.items || []).filter((i) => i.type === 'file_change').flatMap((i) => (i.changes || []).map((c) => c.path).filter(Boolean))].map(rel))];
    t.diffStat = gitDiffStat(t.cwd);
    t.resume = false;
    if (t.status === 'canceled') { /* keep */ }
    else if (shuttingDown && ac.signal.aborted) { t.status = 'queued'; t.resume = true; t.error = 'interrupted by shutdown; resumes on next start'; }
    else if (r.limitHit) {
      t.limitHit = true; // never scored against the model
      await refreshLimits({ only: [t.provider] }).catch(() => {}); // the provider's own quota view (per model group where it has one) drives the next pick
      const next = failover(t);
      if (next) { t.status = 'failed'; t.failedOverTo = next.id; t.error = `provider ${t.provider} at its limit; failed over to task ${next.id} (${next.provider}:${next.model || 'default'}:${next.effort || 'default'}) — await that id`; }
      else {
        const until = blockedUntil(t.provider) || Date.now() + (r.retryAfterMs || 30 * 60_000);
        park(t, until, r.error || 'usage limit');
        logImprovement('friction', `worker:${t.provider}`, `usage limit hit; task parked until ${new Date(until).toISOString()}`, { taskId: t.id, model: t.model });
      }
    } else if (!r.ok) {
      t.status = 'failed'; t.error = r.error || 'worker failed';
      logImprovement('error', `worker:${t.provider}`, t.error, { taskId: t.id, model: t.model, title: t.title });
    } else { t.status = 'done'; }
    t.finishedAt = nowIso();
    persist(t);
    if (TERMINAL.has(t.status) && !t.limitHit) score(t, limitsBefore, concurrent);
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
  if (!t.category || !t.difficulty || t.followUpOf || t.source === 'smoke') return null; // a battery measures one selection; never hand its tasks to another
  try {
    const sel = `${t.provider}:${t.model || 'default'}:${t.effort || 'default'}`;
    const alt = recommend({ category: t.category, difficulty: t.difficulty, exclude: [sel, `${t.provider}:${t.model || 'default'}`], overflowApi: !!t.overflowApi });
    if (!alt || alt.provider === t.provider) return null;
    const n = createTask({ sessionId: t.sessionId, cwd: t.cwd, title: `FAILOVER: ${t.title}`.slice(0, 200), spec: t.spec, provider: alt.provider, model: alt.model, effort: alt.effort, paths: t.paths, category: t.category, difficulty: t.difficulty, retryOf: t.id, source: t.source, variant: t.variant, overflowApi: t.overflowApi });
    logImprovement('friction', `worker:${t.provider}`, `usage limit hit; failed over to ${n.provider}:${n.model || 'default'}`, { taskId: t.id, next: n.id });
    return n;
  } catch { return null; }
}

// Scorecard row after the provider's limits are re-polled (so the window delta is fresh). Waiters are
// not held up; `flushRecords` lets the CLI/smoke runner wait for the rows before reading them.
const pendingRecords = new Set();
function score(t, limitsBefore, concurrent) {
  const p = refreshLimits({ only: [t.provider] }).catch(() => {}).then(() => { try { recordRun(t, { before: limitsBefore, concurrent }); } catch {} });
  pendingRecords.add(p);
  p.finally(() => pendingRecords.delete(p));
}
export const flushRecords = () => Promise.allSettled([...pendingRecords]);

// --- git helpers (best effort; silent when not a repo or git is missing) ---
let gitBin;
function git(cwd, args) {
  if (!existsSync(join(cwd, '.git'))) return null;
  if (gitBin === undefined) gitBin = findCli('git');
  if (!gitBin) return null;
  try { return execFileSync(gitBin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 }); } catch { return null; }
}
function gitStatus(cwd) {
  const out = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (out == null) return null;
  const entries = out.split('\0'); const statusMap = new Map();
  for (let i = 0; i < entries.length; i++) {
    const l = entries[i]; if (!l) continue;
    const name = l.slice(3); let status = l.slice(0, 2);
    if (/[RC]/.test(status)) i++; // -z emits the original name after a rename/copy destination.
    if (status === '??') { try { const s = statSync(join(cwd, name)); status = `?? ${s.mtimeMs}:${s.size}`; } catch {} }
    statusMap.set(name, status);
  }
  return statusMap;
}
function changedSince(cwd, before) {
  const after = gitStatus(cwd);
  if (!after) return [];
  if (!before) return [...after.keys()];
  return [...after.keys()].filter((f) => !before.has(f) || before.get(f) !== after.get(f));
}
function gitDiffStat(cwd) {
  const a = git(cwd, ['diff', '--stat']) || '';
  const b = git(cwd, ['diff', '--cached', '--stat']) || '';
  const untracked = [...(gitStatus(cwd) || [])].filter(([, s]) => s.startsWith('??')).map(([name]) => name).slice(0, 50);
  return [(a + b).trim().slice(0, 3000), untracked.length ? `untracked: ${untracked.join(', ')}` : ''].filter(Boolean).join('\n');
}

export const _git = { gitStatus, changedSince, gitDiffStat };

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
