// Basic watchdog: periodic, non-destructive check-ins for running chats/tasks plus one batched wake when an idle
// chat's whole background batch (tasks and registered detached jobs) has finished.
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { bus } from './bus.mjs';
import { loadConfig } from './config.mjs';
import { statePath, readJson, writeJson, shortId, nowIso } from './paths.mjs';

const TERMINAL = new Set(['done', 'failed', 'canceled', 'lost']);
const FILE = () => statePath('watches.json');
const lastEvents = new Map();
const eventKey = (kind, id) => `${kind}:${id}`;

bus.on('event', (event) => {
  if (event.type === 'watchdog') return;
  const at = Number(event.ts) || Date.now();
  if (event.sessionId) lastEvents.set(eventKey('session', event.sessionId), at);
  if (event.task?.sessionId) lastEvents.set(eventKey('session', event.task.sessionId), at);
  const taskId = event.taskId || event.task?.id;
  if (taskId) {
    if (String(taskId).startsWith('conductor:')) lastEvents.set(eventKey('session', String(taskId).slice('conductor:'.length)), at);
    else lastEvents.set(eventKey('task', taskId), at);
  }
});

function watches() {
  const rows = readJson(FILE(), []);
  return Array.isArray(rows) ? rows : [];
}
function saveWatches(rows) { writeJson(FILE(), rows); }
function pathStamp(path) {
  try { const s = statSync(path); return { exists: true, mtimeMs: s.mtimeMs, size: s.size }; }
  catch { return { exists: false, mtimeMs: null, size: null }; }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** Persist a detached-job/output watch. At least one of jobId, pid or path is required. */
export function registerWatch({ sessionId, jobId = null, pid = null, path = null, note = '', cwd = process.cwd() }) {
  if (typeof sessionId !== 'string' || !sessionId) throw Object.assign(new Error('sessionId is required'), { status: 400 });
  if (jobId != null && (typeof jobId !== 'string' || !/^[a-z0-9]+$/.test(jobId))) throw Object.assign(new Error('job_id is invalid'), { status: 400 });
  if (pid != null && (!Number.isInteger(pid) || pid <= 0)) throw Object.assign(new Error('pid must be a positive integer'), { status: 400 });
  const fullPath = typeof path === 'string' && path.trim() ? resolve(cwd, path) : null;
  if (!jobId && !pid && !fullPath) throw Object.assign(new Error('job_id, pid or path is required'), { status: 400 });
  const rows = watches();
  const duplicate = rows.find((w) => w.sessionId === sessionId && w.status === 'running'
    && (jobId && w.jobId === jobId || pid && w.pid === pid || fullPath && w.path === fullPath));
  if (duplicate) return duplicate;
  const row = {
    id: shortId((id) => rows.some((w) => w.id === id)), sessionId, jobId, pid, path: fullPath,
    note: String(note || '').slice(0, 500), status: 'running', createdAt: nowIso(), finishedAt: null,
    pathInitial: fullPath ? pathStamp(fullPath) : null, wakeReportedAt: null,
  };
  rows.push(row); saveWatches(rows);
  return row;
}

export function listWatches({ sessionId = null } = {}) {
  return watches().filter((w) => !sessionId || w.sessionId === sessionId);
}

function describeDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours} h${rest ? ` ${rest} min` : ''}`;
}

function checkIn(kind, item, at, late) {
  const last = lastEvents.get(eventKey(kind, item.id)) || Date.parse(item.updatedAt || item.startedAt || item.createdAt || '') || at;
  const started = Date.parse(item.startedAt || item.updatedAt || item.createdAt || '') || at;
  const summary = `running ${describeDuration(at - started)} · check-in · last output ${describeDuration(at - last)} ago${late ? ' · resumed after a late tick' : ''}`;
  return { verdict: 'running', checkedAt: new Date(at).toISOString(), lastEventAt: new Date(last).toISOString(), late, summary };
}

function refreshWatches(rows, jobStatus, at) {
  let changed = false;
  for (const w of rows) {
    if (w.status !== 'running') continue;
    let terminal = null;
    if (w.jobId) {
      const job = jobStatus(w.jobId);
      if (job && job.status !== 'running') terminal = { status: job.status, detail: job.exitCode == null ? null : `exit ${job.exitCode}` };
    }
    if (!terminal && w.path) {
      const current = pathStamp(w.path), initial = w.pathInitial || { exists: false };
      if (current.exists && (!initial.exists || current.mtimeMs !== initial.mtimeMs || current.size !== initial.size)) terminal = { status: 'done', detail: 'output ready' };
    }
    if (!terminal && w.pid && !processAlive(w.pid)) terminal = { status: 'done', detail: 'process exited' };
    if (!terminal) continue;
    w.status = terminal.status; w.detail = terminal.detail; w.finishedAt = new Date(at).toISOString(); changed = true;
  }
  return changed;
}

function wakeMessage(tasks, rows) {
  const parts = [];
  if (tasks.length) parts.push(`tasks ${tasks.map((t) => `${t.id} (${t.status})`).join(', ')}`);
  if (rows.length) parts.push(`detached ${rows.map((w) => `${w.jobId ? `job ${w.jobId}` : `watch ${w.id}`} (${w.status})${w.note ? ` — ${w.note}` : ''}`).join(', ')}`);
  const review = [tasks.length && 'task_status', rows.some((w) => w.jobId) && 'job_status'].filter(Boolean).join(' and ');
  return `[watchdog] All background work for this chat has finished: ${parts.join('; ')}.${review ? ` Review it with ${review}.` : ''}`;
}

/** Build an independently testable, non-overlapping watchdog around the supplied task/session adapters. */
export function createWatchdog({
  listSessions, listTasks, touchTaskAlive, markTaskWakeReported, recordSessionCheckIn, sendMessage,
  jobStatus, publish = (data) => bus.publish('watchdog', data), config = loadConfig, clock = () => Date.now(),
}) {
  let timer = null, busy = false, lastTickAt = null;

  const tick = async () => {
    if (busy) return false;
    busy = true;
    try {
      const at = clock(), intervalMs = config().watchdog.intervalMinutes * 60_000;
      const late = lastTickAt != null && at - lastTickAt > 2 * intervalMs;
      lastTickAt = at;
      const sessions = listSessions();
      const tasks = listTasks({ limit: Infinity });

      for (const session of sessions.filter((s) => s.status === 'running')) {
        const state = checkIn('session', session, at, late);
        if (recordSessionCheckIn(session.id, state)) publish({ itemKind: 'session', sessionId: session.id, ...state });
      }
      for (const task of tasks.filter((t) => t.status === 'running')) {
        const state = checkIn('task', task, at, late);
        if (touchTaskAlive(task.id, state, new Date(at).toISOString())) publish({ itemKind: 'task', taskId: task.id, sessionId: task.sessionId || null, aliveAt: new Date(at).toISOString(), ...state });
      }

      const rows = watches();
      if (refreshWatches(rows, jobStatus, at)) saveWatches(rows);
      const sessionById = new Map(sessions.map((s) => [s.id, s]));
      for (const [sessionId, session] of sessionById) {
        if (session.status !== 'idle') continue;
        const sessionTasks = tasks.filter((t) => t.sessionId === sessionId);
        const sessionWatches = rows.filter((w) => w.sessionId === sessionId);
        if (sessionTasks.some((t) => !TERMINAL.has(t.status)) || sessionWatches.some((w) => w.status === 'running')) continue;
        const finishedTasks = sessionTasks.filter((t) => t.wakeEligible && TERMINAL.has(t.status) && !t.wakeConsumedAt && !t.wakeReportedAt);
        const finishedWatches = sessionWatches.filter((w) => TERMINAL.has(w.status) && !w.wakeReportedAt);
        if (!finishedTasks.length && !finishedWatches.length) continue;
        await sendMessage(sessionId, wakeMessage(finishedTasks, finishedWatches));
        const reportedAt = new Date(at).toISOString();
        markTaskWakeReported(finishedTasks.map((t) => t.id), reportedAt);
        for (const w of finishedWatches) w.wakeReportedAt = reportedAt;
        if (finishedWatches.length) saveWatches(rows);
      }
      return true;
    } finally { busy = false; }
  };

  const start = () => {
    stop();
    const ms = config().watchdog.intervalMinutes * 60_000;
    timer = setInterval(() => { void tick(); }, ms); timer.unref?.();
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  return { tick, start, stop };
}
