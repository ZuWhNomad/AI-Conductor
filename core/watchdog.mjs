// Server-owned liveness watchdog: one process snapshot and bounded file walk per tick, deterministic verdicts,
// graduated hang handling, persisted detached-job watches, and one batched wake for completed background work.
import { readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { bus } from './bus.mjs';
import { loadConfig } from './config.mjs';
import { logImprovement } from './improve.mjs';
import { ownerProcessSample, snapshotProcesses } from './proc.mjs';
import { statePath, readJson, writeJson, shortId, nowIso } from './paths.mjs';
import { alive as jobAlive } from './jobs.mjs';

const TERMINAL = new Set(['done', 'failed', 'canceled', 'lost']);
const SKIP_DIRS = new Set(['.git', '.state', 'node_modules', '.venv', 'venv', 'env', '__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const FILE_BUDGET = 20_000;
const FILE = () => statePath('watches.json');
const activity = new Map();
const eventKey = (kind, id) => `${kind}:${id}`;

function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  let total = 0;
  for (const [key, value] of Object.entries(usage)) {
    if (value && typeof value === 'object') total += usageTokens(value);
    else if (/^(?:input|output|prompt|completion)(?:_tokens|Tokens)$/.test(key)) total += Number(value) || 0;
  }
  return total;
}

function stable(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function toolKey(name, input) { return `${name || 'tool'}\0${stable(input ?? {})}`; }

function noteTool(a, key) {
  a.toolRepeat = key === a.lastToolKey ? a.toolRepeat + 1 : 1;
  a.lastToolKey = key;
  a.toolLessTurns = 0;
}

function noteEvent(key, event) {
  const a = activity.get(key) || { count: 0, lastAt: 0, tokens: 0, lastToolKey: null, toolRepeat: 0, toolLessTurns: 0 };
  a.count++;
  a.lastAt = Number(event.ts) || Date.now();
  const tokens = usageTokens(event.usage);
  if (tokens) a.tokens = Math.max(a.tokens, tokens);

  if (event.type === 'session') {
    if (event.kind === 'user') { a.lastToolKey = null; a.toolRepeat = 0; a.toolLessTurns = 0; }
    if (event.kind === 'assistant' && Array.isArray(event.blocks)) {
      const tools = event.blocks.filter((b) => b?.type === 'tool_use');
      if (tools.length) for (const b of tools) noteTool(a, toolKey(b.name, b.input));
      else if (event.blocks.some((b) => b?.type === 'text' && String(b.text || '').trim())) a.toolLessTurns++;
    }
  } else if (event.type === 'worker' && event.event === 'item' && event.phase === 'started' && event.item) {
    const i = event.item;
    noteTool(a, toolKey(i.name || i.tool || i.type, i.args ?? i.input ?? i.command ?? i.arguments));
  } else if (event.type === 'worker' && event.event === 'item' && event.phase === 'completed' && event.item?.type === 'agent_message') {
    a.toolLessTurns++;
  }
  activity.set(key, a);
}

bus.on('event', (event) => {
  if (event.type === 'watchdog') return;
  const keys = new Set();
  if (event.sessionId) keys.add(eventKey('session', event.sessionId));
  if (event.task?.sessionId) keys.add(eventKey('session', event.task.sessionId));
  const taskId = event.taskId || event.task?.id;
  if (taskId && String(taskId).startsWith('conductor:')) keys.add(eventKey('session', String(taskId).slice('conductor:'.length)));
  for (const key of keys) {
    // Conductor worker events are translated into session events; parse tools from the latter so they count once.
    if (event.type === 'worker' && String(taskId || '').startsWith('conductor:')) {
      const a = activity.get(key) || { count: 0, lastAt: 0, tokens: 0, lastToolKey: null, toolRepeat: 0, toolLessTurns: 0 };
      a.count++; a.lastAt = Number(event.ts) || Date.now();
      const tokens = usageTokens(event.usage); if (tokens) a.tokens = Math.max(a.tokens, tokens);
      activity.set(key, a);
    } else noteEvent(key, event);
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

/** Stop after the first file newer than `sinceMs`; directory exclusions and the entry budget are plan-level bounds. */
export function recentFileActivity(cwd, sinceMs, budget = FILE_BUDGET) {
  if (!cwd || !Number.isFinite(sinceMs)) return { changed: false, scanned: 0, limited: false };
  const pending = [cwd]; let scanned = 0;
  try {
    while (pending.length && scanned < budget) {
      const dir = pending.pop();
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++scanned > budget) return { changed: false, scanned, limited: true };
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name.toLowerCase())) pending.push(join(dir, entry.name)); continue; }
        if (!entry.isFile()) continue;
        const path = join(dir, entry.name);
        try { if (statSync(path).mtimeMs > sinceMs) return { changed: true, path, scanned, limited: false }; } catch {}
      }
    }
  } catch {}
  return { changed: false, scanned, limited: pending.length > 0 };
}

/** Pure verdict/counter transition. Specific loop signals outrank generic event activity so looping is reachable. */
export function classify(prev = null, sample = {}, settings = {}) {
  const base = { verdict: 'stuck', stuckChecks: 0, loopChecks: 0, waitingOnVerdict: null };
  if (sample.waitingOwner || sample.parked) return { ...base, verdict: 'waiting-owner' };
  if (sample.waitingTasks?.length) return { ...base, verdict: 'waiting-task', waitingOnVerdict: sample.waitingOnVerdict || 'stuck' };
  if (sample.late) return { ...base, verdict: sample.eventDelta > 0 || sample.fileChanged ? 'progressing' : 'quiet-alive' };
  const repeatAt = Number(settings.loopRepeat) || 5;
  const tokenAt = Number(settings.loopTokens) || 2_000_000;
  const looping = !sample.fileChanged && (sample.toolRepeat >= repeatAt || sample.toolLessTurns >= repeatAt || sample.tokenDelta >= tokenAt);
  if (looping) return { ...base, verdict: 'looping', loopChecks: (prev?.verdict === 'looping' ? prev.loopChecks : 0) + 1 };
  if (sample.eventDelta > 0 || sample.fileChanged) return { ...base, verdict: 'progressing' };
  if (!sample.process?.available || (sample.process.alive && (sample.cpuDelta == null || sample.cpuDelta >= 1))) return { ...base, verdict: 'quiet-alive' };
  return { ...base, verdict: 'stuck', stuckChecks: (prev?.verdict === 'stuck' ? prev.stuckChecks : 0) + 1 };
}

function describeDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return `${hours} h${rest ? ` ${rest} min` : ''}`;
}

function summaryFor(item, state, sample, at) {
  const started = Date.parse(item.startedAt || item.updatedAt || item.createdAt || '') || at;
  const last = sample.lastEventAt || started;
  const parts = [`running ${describeDuration(at - started)}`, state.verdict];
  if (state.verdict === 'waiting-task') parts.push(`task ${state.waitingOnVerdict}`);
  if (sample.process?.names?.length) parts.push(sample.process.names.slice(0, 3).map((n) => basename(n)).join(', '));
  if (sample.cpuDelta != null) parts.push(`CPU +${Math.max(0, Math.round(sample.cpuDelta))} s`);
  if (state.stuckChecks) parts.push(`stuck ${state.stuckChecks}`);
  if (state.loopChecks) parts.push(`loop ${state.loopChecks}`);
  parts.push(`last output ${describeDuration(at - last)} ago`);
  if (sample.late) parts.push('resumed after a late tick');
  return parts.join(' | ');
}

function refreshWatches(rows, jobStatus, at, snapshot) {
  let changed = false;
  for (const w of rows) {
    if (w.status !== 'running') continue;
    let terminal = null;
    if (w.jobId) {
      const job = jobStatus(w.jobId, { tailChars: 0 });
      if (job && job.status !== 'running') terminal = { status: job.status, detail: job.exitCode == null ? null : `exit ${job.exitCode}` };
    }
    if (!terminal && w.path) {
      const current = pathStamp(w.path), initial = w.pathInitial || { exists: false };
      if (current.exists && (!initial.exists || current.mtimeMs !== initial.mtimeMs || current.size !== initial.size)) terminal = { status: 'done', detail: 'output ready' };
    }
    const alive = w.pid && snapshot?.ok ? snapshot.processes.has(w.pid) : w.pid ? jobAlive(w.pid) : true;
    if (!terminal && w.pid && !alive) terminal = { status: 'done', detail: 'process exited' };
    if (!terminal) continue;
    w.status = terminal.status; w.detail = terminal.detail; w.finishedAt = new Date(at).toISOString(); changed = true;
  }
  return changed;
}

function wakeMessage(tasks, rows) {
  const parts = [];
  if (tasks.length) parts.push(`tasks ${tasks.map((t) => `${t.id} (${t.status})`).join(', ')}`);
  if (rows.length) parts.push(`detached ${rows.map((w) => `${w.jobId ? `job ${w.jobId}` : `watch ${w.id}`} (${w.status})${w.note ? ` - ${w.note}` : ''}`).join(', ')}`);
  const review = [tasks.length && 'task_status', rows.some((w) => w.jobId) && 'job_status'].filter(Boolean).join(' and ');
  return `[watchdog] All background work for this chat has finished: ${parts.join('; ')}.${review ? ` Review it with ${review}.` : ''}`;
}

const bestTaskVerdict = (ids, verdicts, tasks) => {
  const values = ids.map((id) => verdicts.get(id) || (tasks.get(id)?.status === 'parked' ? 'waiting-owner' : 'stuck'));
  for (const v of ['progressing', 'quiet-alive', 'waiting-owner', 'looping', 'stuck']) if (values.includes(v)) return v;
  return 'stuck';
};

/** Build an independently testable, non-overlapping watchdog around the supplied task/session adapters. */
export function createWatchdog({
  listSessions, listTasks, touchTaskAlive, markTaskWakeReported, recordSessionCheckIn, sendMessage,
  jobStatus, waitingTasks = () => [], resurfacePermissions = () => false, nudgeRunaway = () => false,
  interrupt = async () => false, failHungTask = () => null,
  processSnapshot = snapshotProcesses, processSample = ownerProcessSample, fileSample = recentFileActivity,
  publish = (data) => bus.publish('watchdog', data),
  logFriction = (source, message, context) => logImprovement('friction', source, message, context),
  config = loadConfig, clock = () => Date.now(),
}) {
  let timer = null, busy = false, lastTickAt = null;
  const states = new Map();

  const tick = async () => {
    if (busy) return false;
    busy = true;
    try {
      const at = clock(), cfg = config(), intervalMs = cfg.watchdog.intervalMinutes * 60_000;
      const late = lastTickAt != null && at - lastTickAt > 2 * intervalMs;
      const since = late ? at : lastTickAt;
      lastTickAt = at;
      const sessions = listSessions();
      const tasks = listTasks({ limit: Infinity });
      const taskById = new Map(tasks.map((t) => [t.id, t]));
      const snapshot = await processSnapshot();
      const taskVerdicts = new Map();
      const activeKeys = new Set();

      const inspect = (kind, item, waiting = []) => {
        const key = eventKey(kind, item.id); activeKeys.add(key);
        const prev = states.get(key);
        const a = activity.get(key) || { count: 0, lastAt: 0, tokens: 0, toolRepeat: 0, toolLessTurns: 0 };
        const proc = processSample(kind === 'session' ? `conductor:${item.id}` : item.id, snapshot);
        const file = fileSample(item.cwd, since ?? (Date.parse(item.startedAt || item.updatedAt || item.createdAt || '') || at));
        const sample = {
          late, waitingOwner: (item.pendingCount || 0) > 0, parked: item.status === 'parked', waitingTasks: waiting,
          waitingOnVerdict: waiting.length ? bestTaskVerdict(waiting, taskVerdicts, taskById) : null,
          eventDelta: prev && !late ? Math.max(0, a.count - prev.eventCount) : a.count,
          tokenDelta: prev && !late ? Math.max(0, a.tokens - prev.tokens) : a.tokens,
          toolRepeat: a.toolRepeat || 0, toolLessTurns: a.toolLessTurns || 0,
          fileChanged: !!file.changed, process: proc,
          cpuDelta: prev && !late && proc.available && prev.cpuSeconds != null && proc.cpuSeconds >= prev.cpuSeconds ? proc.cpuSeconds - prev.cpuSeconds : null,
          lastEventAt: (kind === 'task' ? Number(item.progress?.at) || Date.parse(item.progress?.at || '') : a.lastAt) || Date.parse(item.updatedAt || item.startedAt || item.createdAt || '') || at,
        };
        const state = { ...classify(prev, sample, cfg.watchdog), checkedAt: new Date(at).toISOString(), lastEventAt: new Date(sample.lastEventAt).toISOString(), late };
        state.summary = summaryFor(item, state, sample, at);
        Object.assign(state, { eventCount: a.count, tokens: a.tokens, cpuSeconds: proc.cpuSeconds, runawayStopped: prev?.runawayStopped || false });
        states.set(key, state);
        return { state, sample };
      };

      for (const task of tasks.filter((t) => t.status === 'running')) {
        const { state } = inspect('task', task);
        taskVerdicts.set(task.id, state.verdict);
        const aliveAt = new Date(at).toISOString();
        if (touchTaskAlive(task.id, state, aliveAt)) publish({ itemKind: 'task', taskId: task.id, sessionId: task.sessionId || null, aliveAt, ...state });
        if (state.verdict === 'looping') logFriction('watchdog', `task ${task.id} appears to be looping`, { taskId: task.id, summary: state.summary });
        if (state.verdict === 'stuck') {
          logFriction('watchdog', `task ${task.id} is stuck (${state.stuckChecks}/${cfg.watchdog.killAfterStuckChecks || 'never kill'})`, { taskId: task.id, summary: state.summary });
          if (cfg.watchdog.killAfterStuckChecks > 0 && state.stuckChecks >= cfg.watchdog.killAfterStuckChecks) {
            failHungTask(task.id, `watchdog: no output, no files, no CPU for ${state.stuckChecks} checks (${Math.round(state.stuckChecks * intervalMs / 60_000)} min)`);
          }
        }
      }

      for (const session of sessions.filter((s) => s.status === 'running')) {
        const waits = waitingTasks(session.id);
        const { state } = inspect('session', session, waits);
        if (recordSessionCheckIn(session.id, state)) publish({ itemKind: 'session', sessionId: session.id, ...state });
        if (state.verdict === 'waiting-owner') resurfacePermissions(session.id);
        if (state.verdict === 'looping') {
          logFriction('watchdog', `chat ${session.id} appears to be looping`, { sessionId: session.id, summary: state.summary });
          if (state.loopChecks === 1) nudgeRunaway(session.id);
          else if (!state.runawayStopped) {
            state.runawayStopped = true;
            await interrupt(session.id, 'watchdog: runaway loop continued after a nudge');
          }
        } else if (state.verdict === 'stuck') {
          logFriction('watchdog', `chat ${session.id} is stuck (${state.stuckChecks}/${cfg.watchdog.killAfterStuckChecks || 'never kill'})`, { sessionId: session.id, summary: state.summary });
          if (cfg.watchdog.killAfterStuckChecks > 0 && state.stuckChecks >= cfg.watchdog.killAfterStuckChecks) {
            await interrupt(session.id, `watchdog: no output, no files, no CPU for ${state.stuckChecks} checks (${Math.round(state.stuckChecks * intervalMs / 60_000)} min)`);
          }
        }
      }
      for (const key of states.keys()) if (!activeKeys.has(key)) states.delete(key);
      for (const key of activity.keys()) if (!activeKeys.has(key)) activity.delete(key);

      const rows = watches();
      if (refreshWatches(rows, jobStatus, at, snapshot)) saveWatches(rows);
      const sessionById = new Map(sessions.map((s) => [s.id, s]));
      for (const [sessionId, session] of sessionById) {
        if (session.status !== 'idle') continue;
        activity.delete(eventKey('session', sessionId));
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
