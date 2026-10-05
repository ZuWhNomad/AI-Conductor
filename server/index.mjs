// Local HTTP server: static UI, JSON API, SSE event stream. Binds to 127.0.0.1 only.
// Route handlers live in ./routes/. This file keeps the process lifecycle and the bits tests eval from this source.
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { REPO_ROOT, readJson, writeJson, statePath } from '../core/paths.ts';
import { loadConfig } from '../core/config.mjs';
import { bus } from '../core/bus.ts';
import { getModels, refreshModels, startModelPolling, stopModelPolling } from '../core/models.mjs';
import { refreshLimits, startLimitPolling, stopLimitPolling } from '../core/limits.mjs';
import { killProbes, codexCommand, findCli } from '../core/proc.ts';
import { PROVIDERS } from '../core/providers/index.mjs';
import { listTasks, openTasks, schedule, abortRunning, recoverTasks, touchTaskAlive, markTaskWakeReported, failHungTask, setDraining, awaitRunning } from '../core/tasks.mjs';
import { listImprovements, logImprovement, buildReviewPrompt, installGlobalErrorCapture } from '../core/improve.mjs';
import * as conductor from '../core/conductor.mjs';
import { conductorToolDefs, toolsAsMcp, waitingTasks } from '../core/tools.mjs';
import { migrateScorecard, scorecardModelId } from '../core/scorecard.mjs';
import { priceFor } from '../core/priors.mjs';
import { lastUpdateStatus, applyUpdate, checkForUpdates } from '../core/update.mjs';
import { detectCapabilities, capabilityReport } from '../core/capabilities.mjs';
import { dailyCheck } from '../core/cli-update.mjs';
import { DEFAULT_TOOL_TIMEOUT_SEC } from '../core/mcp.mjs';
import { startBenchQueue, stopBenchQueue, wakeBenchQueue } from '../core/bench.mjs';
import { jobStatus } from '../core/jobs.mjs';
import { createWatchdog } from '../core/watchdog.mjs';
import { json, readBody } from './routes/_http.mjs';
import { handle as handleState } from './routes/state.mjs';
import { handle as handleSessions } from './routes/sessions.mjs';
import { handle as handleTasks } from './routes/tasks.mjs';
import { handle as handleModelsLimits } from './routes/models-limits.mjs';
import { handle as handleScores } from './routes/scores.mjs';
import { handle as handleSettings } from './routes/settings.mjs';
import { handle as handleImprovements } from './routes/improvements.mjs';
import { handle as handleProviders } from './routes/providers.mjs';
import { handle as handleJobs } from './routes/jobs.mjs';
import { handle as handleCliUpdate } from './routes/cli-update.mjs';
import { handle as handleMisc } from './routes/misc.mjs';

const UI = join(REPO_ROOT, 'ui');
const BOOT = Date.now();
let boundPort = null;              // the port this server actually bound — the self-restart relauncher reuses it
let activeServer = null;
const RELAUNCH_WAIT_MS = 20_000;  // how long a relaunch child retries binding while the outgoing process releases the port
const watchdog = createWatchdog({
  listSessions: conductor.listSessions, listTasks, touchTaskAlive, markTaskWakeReported,
  recordSessionCheckIn: conductor.recordWatchdogCheckIn, sendMessage: conductor.sendMessage, jobStatus,
  waitingTasks, resurfacePermissions: conductor.resurfacePermissions, canNudge: conductor.canNudge, nudgeRunaway: conductor.nudgeRunaway,
  interrupt: conductor.interrupt, failHungTask,
});

const HANDLERS = [handleState, handleSessions, handleTasks, handleModelsLimits, handleScores, handleSettings, handleImprovements, handleProviders, handleCliUpdate, handleMisc];

export function stopBackgroundWork() {
  try { watchdog.stop(); } catch {}
  stopUpdateChecks();
  try { clearInterval(lagTimer); loopLag.disable(); } catch {}
  try { stopModelPolling(); } catch {}
  try { stopLimitPolling(); } catch {}
  try { stopSignInWatches(); clearInterval(detectTimer); detectTimer = null; } catch {}
  try { stopBenchQueue(); } catch {}
  try { killProbes(); } catch {}
}

// Registry changes may have queued a newly detected selection; terminal live work may have released a yielded lane.
bus.on('event', (e) => {
  if (e.type === 'models' || (e.type === 'task' && ['done', 'failed', 'canceled'].includes(e.task?.status))) wakeBenchQueue();
});

// --- noticing an auth change we did not cause ------------------------------------------------------------------
// The provider registry is a cache, and with auto-refresh off nothing re-probes it: signing in outside the app — or
// while the boot probe was mid-flight — left "not logged in" on screen until the user pressed ↻ Refresh. Two cheap
// probes close that: a burst right after we open a sign-in terminal, and a slow sweep of installed-but-signed-out
// providers. Both go through refreshModels, so the registry write and the `models` event stay in one place.
const signInWatches = new Map();

/** Re-probe one provider until it comes back `ok` (or the window runs out). `awaitDrop` is for re-auth, where the
 *  provider is still signed in when the watch starts: stopping at the first `ok` would end it before the logout even
 *  ran. Injectables are for tests. */
export function watchSignIn(id, { intervalMs = 5000, maxMs = 5 * 60_000, awaitDrop = false, refresh = (only) => refreshModels({ only }), statusOf = (p) => getModels().providers?.[p]?.status } = {}) {
  stopSignInWatch(id);
  const w = { until: Date.now() + maxMs, stopped: false, timer: null, ticks: 0, sawDrop: !awaitDrop };
  const tick = async () => {
    if (w.stopped) return;
    w.ticks++;
    try { await refresh([id]); } catch {}
    if (w.stopped) return;
    const status = statusOf(id);
    if (status !== 'ok') w.sawDrop = true;
    if ((status === 'ok' && w.sawDrop) || Date.now() >= w.until) return stopSignInWatch(id);
    w.timer = setTimeout(tick, intervalMs); w.timer.unref?.();
  };
  w.timer = setTimeout(tick, intervalMs); w.timer.unref?.();
  signInWatches.set(id, w);
  return w;
}
export function stopSignInWatch(id) { const w = signInWatches.get(id); if (w) { w.stopped = true; clearTimeout(w.timer); signInWatches.delete(id); } }
function stopSignInWatches() { for (const id of [...signInWatches.keys()]) stopSignInWatch(id); }

/** Which providers are worth re-probing on a timer: installed, but signed out. A missing API key never fixes itself
 *  in the background (it arrives through Settings, which refreshes already), so those are left alone. */
export function staleAuthProviders(providers = getModels().providers || {}) {
  return Object.keys(PROVIDERS).filter((id) => providers[id]?.installed !== false && providers[id]?.loggedIn === false);
}

let detectTimer = null;
function applyDetectSweep(cfg) {
  if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
  if (process.env.CONDUCTOR_NO_POLL) return;
  const minutes = cfg.ui.detectMinutes;
  if (!(minutes > 0)) return;
  detectTimer = setInterval(() => {
    const stale = staleAuthProviders();
    if (stale.length) refreshModels({ only: stale }).catch(() => {});
    dailyCheck(); // worker CLI updates: a timestamp compare until the day is up; 'auto' installs wait for an idle provider
  }, minutes * 60_000);
  detectTimer.unref();
}

/** The model+limit background poll is governed by the UI "auto" control (config ui.autoRefresh): on → poll at
 *  pollMinutes; off → no poll at all (manual ↻ Refresh and the one-time startup refresh still work). */
function applyPolling(cfg) {
  if (process.env.CONDUCTOR_NO_POLL) return;
  if (cfg.ui?.autoRefresh) { startModelPolling(cfg.pollMinutes); startLimitPolling(cfg.pollMinutes); }
  else { stopModelPolling(); stopLimitPolling(); }
}
// Event-loop lag: the one number that says whether the server is stalling (synchronous work on the dispatch path,
// too many tasks at once). Sampled continuously; read live by /api/doctor; every minute the p99 is checked and reset.
const loopLag = monitorEventLoopDelay({ resolution: 20 });
let lagTimer = null;
const lagStats = () => ({ p99Ms: Math.round(loopLag.percentile(99) / 1e6), maxMs: Math.round(loopLag.max / 1e6), sinceMs: Math.round(loopLag.count * 20) });
/** Pure: a friction entry when the last minute's p99 crosses the threshold, else null. */
export const lagVerdict = (p99Ms, thresholdMs, context = {}) => p99Ms > thresholdMs ? { message: `event loop lag p99=${Math.round(p99Ms)}ms over the last minute (threshold ${thresholdMs}ms)`, context } : null;
function startLagMonitor() {
  loopLag.enable();
  lagTimer = setInterval(() => {
    const { p99Ms } = lagStats(); loopLag.reset();
    const threshold = loadConfig().server.lagWarnMs;
    if (p99Ms <= threshold) return;
    const tasks = openTasks();
    const v = lagVerdict(p99Ms, threshold, { running: tasks.filter((t) => t.status === 'running').length, queued: tasks.filter((t) => t.status === 'queued').length, sessions: conductor.listSessions().filter((s) => s.status === 'running').length });
    if (v) { try { logImprovement('friction', 'server', v.message, v.context); } catch {} }
  }, 60_000).unref();
}
// Activity stamp for the auto-update gate: every API write and every task status change. "Idle" must mean quiet,
// not merely empty — an external driver between two passes has no running turn and no open task, yet a restart
// then loses its job (the 09-15 incident).
let lastActivity = Date.now();
bus.on('event', (ev) => { if (ev.type === 'task') lastActivity = Date.now(); });
/** Pure: may the server restart itself now? */
export const isIdle = ({ runningSessions, openTasks, lastActivity, now = Date.now(), quietMs }) => runningSessions === 0 && openTasks === 0 && now - lastActivity >= quietMs;
export const taskBusyCount = (tasks) => tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
export function updateWaitingDetail(sessions = conductor.listSessions(), tasks = listTasks({ limit: Infinity })) {
  const parked = tasks.filter((t) => t.status === 'parked');
  const earliest = parked.map((t) => Date.parse(t.resumeAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return `waiting for ${sessions.filter((s) => s.status === 'running').length} chat turn(s), ${tasks.filter((t) => t.status === 'running').length} running, ${tasks.filter((t) => t.status === 'queued').length} queued · carries over ${parked.length} parked (earliest ${earliest ? new Date(earliest).toISOString() : 'none'}), ${tasks.filter((t) => t.status === 'stale').length} stale`;
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

// POSIX `&` backgrounds logout; `;` runs login after. Windows `&` still runs login if logout errored.
// Kept here: test/server/server.test.mjs matches this expression in this file.
function chainShell(logout, login) {
  return `${logout} ${process.platform === 'win32' ? '&' : ';'} ${login}`;
}

function beginShutdown() {
  setDraining(true);
  setTimeout(async () => {
    try { activeServer?.close(); } catch {}
    try { stopBackgroundWork(); } catch {}
    try { abortRunning({ requeue: true }); } catch {}
    try { await awaitRunning(1200); } catch {}
    try { unlinkSync(statePath('server.pid')); } catch {}
    process.exit(0);
  }, 50);
}

function applySettings(prev, next) {
  applyPolling(next); applyDetectSweep(next);
  if (prev.watchdog.intervalMinutes !== next.watchdog.intervalMinutes) watchdog.start();
  const auChanged = prev.conductor.autoUpdate !== next.conductor.autoUpdate;
  const hoursChanged = prev.conductor.updateCheckHours !== next.conductor.updateCheckHours;
  if (auChanged || hoursChanged) startUpdateChecks({ initial: prev.conductor.autoUpdate === 'off' && next.conductor.autoUpdate !== 'off' });
  schedule(); /* a raised concurrency cap starts queued work now */ wakeBenchQueue(); bus.publish('settings', {});
}

/** Minimal MCP streamable-HTTP server (JSON responses) so Codex conductors can call the workbench tools. */
async function mcpRoute(req, res, seg) {
  const ctx = conductor.sessionContext(seg[1]);
  if (!ctx) return json(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unknown session' } });
  if (req.method === 'GET') { res.writeHead(405); res.end(); return true; }        // no server-initiated stream
  if (req.method === 'DELETE') { res.writeHead(200); res.end(); return true; }
  const body = await readBody(req);
  const reply = (id, result) => json(res, 200, { jsonrpc: '2.0', id, result });
  // Cap blocking tools below the Codex MCP transport timeout.
  const maxBlockMs = (DEFAULT_TOOL_TIMEOUT_SEC - 60) * 1000;
  const defs = conductorToolDefs({ sessionId: ctx.id, cwd: ctx.cwd, maxBlockMs });
  switch (body.method) {
    case 'initialize': return reply(body.id, { protocolVersion: body.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'conductor', version: VERSION }, instructions: `Workbench tools for delegating work from this conductor session. Tasks run in ${ctx.cwd}.` });
    case 'notifications/initialized': case 'notifications/cancelled': res.writeHead(202); res.end(); return true;
    case 'ping': return reply(body.id, {});
    case 'tools/list': return reply(body.id, { tools: toolsAsMcp(defs) });
    case 'tools/call': {
      const d = defs.find((x) => x.name === body.params?.name);
      if (!d) return json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: `unknown tool ${body.params?.name}` } });
      try { const out = await d.handler(d.schema.parse(body.params.arguments || {})); return reply(body.id, { content: [{ type: 'text', text: String(out) }], isError: false }); }
      catch (e) { return reply(body.id, { content: [{ type: 'text', text: String(e?.message || e) }], isError: true }); }
    }
    default: return json(res, 200, { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: `unknown method ${body.method}` } });
  }
}

async function route(req, res, url) {
  const p = url.pathname; const m = req.method;
  const seg = p.split('/').filter(Boolean); // ['api', ...]
  if (seg[0] === 'mcp' && seg[1]) return mcpRoute(req, res, seg);
  if (seg[0] !== 'api') return false;
  const ctx = {
    req, res, url, p, m, seg, version: VERSION, boot: BOOT,
    watchSignIn, chainShell, beginShutdown, applySettings, doctorReport,
    relaunchPort: () => boundPort ?? req.socket.localPort,
    scheduleRelaunch, workInFlight, publishUpdateWaiting, deferPendingRelaunch,
    setPendingRelaunch: (r) => { pendingRelaunch = r; },
  };

  // SSE stays inline: test/server/server.test.mjs evals this block up to the jobs marker.
  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    let closed = false;
    let hb = null;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      bus.off('event', h);
      if (hb) clearInterval(hb);
      try { res.end(); } catch {}
    };
    const safeWrite = (data) => {
      if (closed) return false;
      const ok = res.write(data);
      if (ok === false) { cleanup(); return false; }
      return true;
    };
    const h = (ev) => safeWrite(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    if (!safeWrite(`event: hello\ndata: ${JSON.stringify({ boot: BOOT, oldest: bus.oldest })}\n\n`)) return true;
    const since = Number(url.searchParams.get('since') || 0);
    if (!(bus.oldest > since + 1)) {
      for (const ev of bus.since(since)) {
        if (!h(ev)) return true;
      }
    }
    bus.on('event', h);
    hb = setInterval(() => safeWrite(': hb\n\n'), 15000);
    req.on('close', cleanup);
    return true;
  }

  if (seg[1] === 'jobs') { // detached long jobs (core/jobs.mjs); `conductor job` calls these from a worker's shell
    return handleJobs(ctx); // false → static file, same as the old fall-through
  }

  for (const handle of HANDLERS) if (await handle(ctx)) return true;
  return json(res, 404, { error: `no route ${m} ${p}` });
}

/** Environment check shared by `conductor doctor` and the UI. */
export async function doctorReport() {
  // Timeout 10_000 is the existing execFileSync budget this function already used for `codex --version`.
  const versionOf = (command, args = ['--version']) => new Promise((resolve) => {
    if (!command) return resolve(null);
    const done = (err, stdout) => resolve(err ? null : String(stdout || '').trim());
    const opts = { encoding: 'utf8', windowsHide: true, timeout: 10_000 };
    if (/\.(cmd|bat)$/i.test(command)) return resolve(null); // never through a shell (AGENTS.md: Windows spawns are shell-free)
    execFile(command, args, { ...opts, stdio: ['ignore', 'pipe', 'ignore'] }, done);
  });
  const rows = [];
  rows.push({ name: 'node', value: process.version, status: Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'need Node 22+' });
  const claude = await PROVIDERS.claude.detect();
  const claudePkg = readJson(join(REPO_ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'));
  rows.push({ name: 'claude (Agent SDK)', value: claudePkg?.version || 'unknown', status: claude.loggedIn ? `logged in (${claude.subscription || 'subscription'})` : `NOT logged in → run: ${PROVIDERS.claude.loginCommand()}` });
  const codex = codexCommand();
  const codexVersion = codex ? await versionOf(codex.command, [...codex.args, '--version']) : null;
  rows.push({ name: 'codex', value: codexVersion || 'missing', status: codex ? ((await PROVIDERS.codex.account().catch(() => ({ loggedIn: false }))).loggedIn ? 'logged in' : 'NOT logged in → run: codex login') : 'install: npm i -g @openai/codex', path: codex ? [codex.command, ...codex.args].join(' ') : findCli('codex') });
  const unpriced = unpricedModels(getModels());
  rows.push({ name: 'priced agent models', value: String(unpriced.length), status: unpriced.length ? `${unpriced.length} unpriced: ${unpriced.join(', ')} — their cells rank last as cost unknown` : 'ok' });
  rows.push({ name: 'git', value: await versionOf(findCli('git')) || 'missing', status: '' });
  return { rows, capabilities: capabilityReport(), path: (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean), cwd: process.cwd(), stateDir: statePath(), eventLoop: lagStats() };
}

export function unpricedModels(reg = getModels()) {
  return (reg.models || []).filter((m) => m.kind === 'agent' && Object.hasOwn(PROVIDERS, m.provider) && priceFor(m.provider, scorecardModelId(m.id)) == null).map((m) => m.id);
}

/** Optional periodic self-review (config.review.everyDays > 0): opens a review session when due. */
function startScheduledReview() {
  const check = async () => {
    const cfg = loadConfig();
    const every = Number(cfg.review?.everyDays || 0);
    if (!every) return;
    const last = readJson(statePath('review.json'), {}).lastReviewAt || 0;
    if (Date.now() - last < every * 86_400_000) return;
    if (!listImprovements().length) return;
    if (!(await getModels().providers?.claude?.loggedIn ?? true)) return;
    writeJson(statePath('review.json'), { lastReviewAt: Date.now() });
    const s = conductor.createSession({ cwd: REPO_ROOT, title: 'Scheduled self-review' });
    await conductor.sendMessage(s.id, buildReviewPrompt());
  };
  setTimeout(() => check().catch(() => {}), 60_000).unref();
  setInterval(() => check().catch(() => {}), 6 * 3_600_000).unref();
}

let relaunchPending = null; // in-flight child; overlapping scheduleRelaunch returns true without spawning another
/** Self-restart: spawn a DETACHED fresh conductor on the SAME port using THIS process's own env (so it inherits the
 *  real CONDUCTOR_HOME + port, never an ambient shell's), then hand off — once the child is confirmed alive we requeue
 *  in-flight work, drop the port and exit so the new version takes over. The child's retry-bind (CONDUCTOR_RELAUNCH_WAIT,
 *  honored in startServer) tolerates the brief window before this process exits. Returns false WITHOUT exiting when the
 *  child can't be spawned, so callers fall back to "restart manually" and never strand the app dead. spawnFn/exit are
 *  injectable for tests. */
export function scheduleRelaunch({ port = boundPort, spawnFn = spawn, exit = () => process.exit(0), okTimeoutMs = 10_000 } = {}) {
  if (relaunchPending) return true; // handoff already in progress
  setDraining(true);
  const argv = [join(REPO_ROOT, 'bin', 'conductor.mjs'), 'start', '--no-open', ...(port ? ['--port', String(port)] : [])];
  const okFile = statePath('relaunch-ok'); try { unlinkSync(okFile); } catch {}
  let child;
  let logFd = null;
  try { logFd = openSync(statePath('launcher.log'), 'a'); } catch {}
  try {
    child = spawnFn(process.execPath, argv, { detached: true, stdio: logFd != null ? ['ignore', logFd, logFd] : 'ignore', windowsHide: true, env: { ...process.env, CONDUCTOR_RELAUNCH_WAIT: String(RELAUNCH_WAIT_MS) } });
  } catch { if (logFd != null) try { closeSync(logFd); } catch {} setDraining(false); try { schedule(); } catch {} return false; } // couldn't even spawn → stay up, let the caller show the manual-restart message
  if (logFd != null) try { closeSync(logFd); } catch {}
  relaunchPending = child;
  const release = () => { if (relaunchPending === child) relaunchPending = null; };
  let settled = false;
  const handoff = async () => {
    if (settled) return; settled = true;
    try { child.unref?.(); } catch {}
    try { activeServer?.close(); } catch {}
    try { conductor.shutdownSessions?.(); } catch {}
    try { stopBackgroundWork(); } catch {}
    try { abortRunning({ requeue: true }); } catch {} // in-flight worker tasks resume in the new process
    try { await awaitRunning(300); } catch {}
    try { unlinkSync(statePath('server.pid')); } catch {}
    setTimeout(() => { try { exit(); } finally { release(); } }, 50); // let the HTTP response flush before we drop the port
  };
  // A child that dies on import (missing dependency, syntax error) must not take the running server down with it:
  // the previous version stays up, says so, and the user restarts by hand once it is fixed.
  const fail = (why) => {
    if (settled) return; settled = true;
    release();
    setDraining(false);
    try { schedule(); } catch {}
    try { child.kill?.(); } catch {}
    try { logImprovement('friction', 'update', 'update applied, but the new version failed to start (' + why + '); still running the previous version — fix it, then restart by hand'); } catch {}
    bus.publish('update', { relaunchFailed: true, why });
  };
  // Hand over only once the child proves it can start: it writes relaunch-ok as it enters its bind loop (imports done).
  child.once?.('spawn', () => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (settled) return clearInterval(timer);
      if (existsSync(okFile)) { clearInterval(timer); handoff(); }
      else if (Date.now() - t0 > okTimeoutMs) { clearInterval(timer); fail('no start signal within ' + Math.round(okTimeoutMs / 1000) + ' s'); }
    }, 200);
    timer.unref?.();
  });
  child.once?.('exit', (code, sig) => fail('exited with ' + (sig || 'code ' + code) + ' before binding'));
  child.once?.('error', (e) => fail('spawn failed: ' + (e?.message || e)));
  return true;
}

/** Periodic GitHub update check, governed by conductor.autoUpdate ('auto' | 'ask' | 'off'). On 'auto' it pulls AND
 *  self-restarts — but only while the server is IDLE (no chat turn running, no worker task active), so an update never
 *  interrupts in-flight work; while busy it defers and re-checks on a short cadence, applying as soon as work settles. */
let updateInterval = null, updateStartup = null, recheck = null, pendingRelaunch = null, updateGen = 0;
function publishUpdateWaiting() { bus.publish('update', { waitingForWork: true, detail: updateWaitingDetail() }); }
function workInFlight() {
  try {
    if (conductor.listSessions().some((s) => s.status === 'running')) return true;
    if (taskBusyCount(openTasks())) return true;
    return false;
  } catch { return true; }
}
function deferPendingRelaunch() {
  if (recheck) return;
  recheck = setTimeout(() => {
    recheck = null;
    if (!pendingRelaunch) return;
    if (workInFlight()) { deferPendingRelaunch(); return; }
    const r = pendingRelaunch; pendingRelaunch = null;
    if (scheduleRelaunch()) bus.publish('update', { relaunching: true, from: r.from, to: r.to });
  }, 60_000);
  recheck.unref?.();
}
function stopUpdateChecks() {
  clearInterval(updateInterval); clearTimeout(updateStartup); clearTimeout(recheck);
  updateInterval = updateStartup = recheck = pendingRelaunch = null;
  updateGen++;
}
function startUpdateChecks({ initial = true } = {}) {
  clearInterval(updateInterval); updateInterval = null;
  if (process.env.CONDUCTOR_NO_POLL || loadConfig().conductor.autoUpdate === 'off') return stopUpdateChecks();
  // A settings save changes the cadence without dropping a startup check or an update waiting for idle.
  const idle = () => {
    try {
      return isIdle({
        runningSessions: conductor.listSessions().filter((s) => s.status === 'running').length,
        openTasks: taskBusyCount(openTasks()),
        lastActivity, quietMs: loadConfig().conductor.updateQuietMinutes * 60_000,
      });
    } catch { return false; } // can't tell → defer rather than risk interrupting work
  };
  const run = async ({ fetch = true } = {}) => {
    try {
      const gen = updateGen;
      const cfg = loadConfig();
      const policy = cfg.conductor.autoUpdate;
      if (policy === 'off') return;
      const stale = () => updateGen !== gen;
      const auto = () => loadConfig().conductor.autoUpdate === 'auto';
      const defer = () => { if (!recheck) { recheck = setTimeout(() => { recheck = null; run({ fetch: false }); }, 60_000); recheck.unref?.(); } };
      const relaunch = (r) => {
        if (scheduleRelaunch()) { bus.publish('update', { relaunching: true, from: r.from, to: r.to }); logImprovement('idea', 'update', `auto-updated ${r.commits} commit(s) to ${String(r.to).slice(0, 8)} — restarting to apply`, {}); }
        else logImprovement('idea', 'update', `auto-updated ${r.commits} commit(s) to ${String(r.to).slice(0, 8)} — restart to apply (relaunch unavailable)`, {});
      };
      // Pull already landed while we were busy: relaunch once idle, never pull a second time.
      // Manual Update also parks here; do not require auto() so 'ask' still applies the pending restart.
      if (pendingRelaunch) {
        if (stale()) return;
        if (workInFlight()) { defer(); return; }
        const r = pendingRelaunch; pendingRelaunch = null;
        relaunch(r);
        return;
      }
      const st = fetch ? await checkForUpdates() : lastUpdateStatus(); // publishes an 'update' event when behind — flashes the button on 'ask' AND 'auto'
      if (stale()) return;
      if (!auto() || !st?.git || st.error || !st.behind || st.dirty || st.ahead) return;
      if (!idle()) { // update ready but work is in flight — defer; re-check soon so it applies as soon as we're idle
        publishUpdateWaiting();
        defer();
        return;
      }
      const r = await applyUpdate(); // git pull + npm install; publishes its own 'update' event
      if (stale() || !auto()) return;
      // Loop guard: only restart when the pull actually advanced HEAD. After a successful pull we're up to date, so the
      // next check finds nothing behind and never restarts — start→pull→restart→start cannot loop.
      const moved = !!(r.updated && r.to && r.to !== r.from);
      if (r.npmError) logImprovement('friction', 'update', `auto-updated ${r.commits} commit(s) to ${String(r.to).slice(0, 8)}, but npm install failed (${r.npmError}) — run \`npm install\` in the Conductor folder, then restart`, {});
      else if (moved && !idle()) { pendingRelaunch = r; publishUpdateWaiting(); defer(); }
      else if (moved) relaunch(r);
    } catch (e) { try { logImprovement('friction', 'update', `update check failed: ${e.message}`, {}); } catch {} }
  };
  if (initial) updateStartup = setTimeout(run, 3000).unref();
  // updateCheckHours 0 turns the periodic check off (the startup check above still runs). Never setInterval(run, 0):
  // that would be a hot loop against GitHub, not "off".
  const hours = loadConfig().conductor.updateCheckHours;
  if (hours > 0) updateInterval = setInterval(run, hours * 3_600_000).unref();
}

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = resolve(UI, rel);
  if (!(file === UI || file.startsWith(UI + sep)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(readFileSync(file));
}

export function startServer({ port = null } = {}) {
  installGlobalErrorCapture();
  try { const n = migrateScorecard(); if (n) logImprovement('idea', 'scorecard', `scorecard migration: voided ${n} legacy harness row(s)`); } catch {}
  const cfg = loadConfig();
  const server = createServer(async (req, res) => {
    const port = server.address().port;
    const host = String(req.headers.host || '').toLowerCase(); const origin = req.headers.origin === undefined ? undefined : String(req.headers.origin).toLowerCase();
    if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host)) return json(res, 403, { error: 'bad host' });
    if (origin !== undefined && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(res, 403, { error: 'bad origin' });
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'cross-site' });
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'content-type must be application/json' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' && url.pathname !== '/api/update') lastActivity = Date.now();
    try {
      if (!(await route(req, res, url))) serveStatic(req, res, url);
    } catch (e) {
      if ((e.status || 500) >= 500 && !url.pathname.startsWith('/api/improvements')) logImprovement('error', 'server', `${req.method} ${url.pathname}: ${e?.stack || e}`);
      if (!res.headersSent) json(res, e.status || 500, { error: String(e?.message || e) });
      else res.end();
    }
  });
  const listenPort = port ?? cfg.port;
  // A relaunch child (scheduleRelaunch) sets CONDUCTOR_RELAUNCH_WAIT so the fresh process tolerates the outgoing one
  // still holding the port for a moment: retry the bind until this budget elapses. A normal start (flag unset) has a
  // deadline of "now", so any EADDRINUSE rejects immediately, exactly as before.
  const relaunchDeadline = Date.now() + Number(process.env.CONDUCTOR_RELAUNCH_WAIT || 0);
  // Relaunch child: every import above succeeded, so tell the outgoing process it may hand over the port.
  if (process.env.CONDUCTOR_RELAUNCH_WAIT) { try { writeFileSync(statePath('relaunch-ok'), String(process.pid)); } catch {} }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onListen = () => {
      settled = true;
      activeServer = server;
      boundPort = server.address().port;
      // The outgoing process could finish tasks after our import, before releasing the port.
      const recovered = recoverTasks();
      if (recovered.resumed || recovered.parkedKept || recovered.stale || recovered.smokeCanceled) {
        const parked = `${recovered.parkedKept} parked kept${recovered.earliestParked ? ` (earliest ${recovered.earliestParked})` : ''}`;
        logImprovement('friction', 'restart', `restart: ${recovered.resumed} resumed, ${parked}, ${recovered.stale} stale, ${recovered.smokeCanceled} smoke canceled`, recovered);
      }
      if (process.env.CONDUCTOR_RELAUNCH_WAIT) { try { conductor.reloadSessions?.(); } catch {} }
      const restartAt = new Date();
      for (const [sessionId, outcomes] of Object.entries(recovered.bySession || {})) {
        const tasks = outcomes.map((t) => `${t.id}: ${t.status === 'parked' ? `parked until ${t.resumeAt}` : t.status === 'stale' ? 'stale (needs the user)' : 'resumed'}`).join('; ');
        const note = `Conductor restarted at ${restartAt.toISOString().slice(11, 16)}Z. Your tasks: ${tasks}. They were not lost: await them, do not delegate them again.`;
        void conductor.recordTaskRestartNote(sessionId, note).catch((e) => logImprovement('error', 'restart', `task restart note failed for session ${sessionId}: ${e.message}`, { sessionId }));
      }
      delete process.env.CONDUCTOR_RELAUNCH_WAIT; // don't let the relaunch flag linger into normal operation or child processes
      const addr = `http://127.0.0.1:${boundPort}`;
      conductor.setServerUrl(addr);
      watchdog.start();
      void conductor.resumeInterruptedTurns().catch((e) => logImprovement('error', 'watchdog', `interrupted-turn resume failed: ${e.message}`));
      startLagMonitor();
      if (!process.env.CONDUCTOR_NO_POLL) {
        applyPolling(cfg); // start the periodic model/limit poll only when auto-refresh is on
        applyDetectSweep(cfg); // and the slow re-probe of signed-out providers (independent of that control)
        refreshModels().then(() => refreshLimits()).then(() => detectCapabilities()).then(() => dailyCheck()).catch(() => {}); // one refresh at boot regardless, so the panel isn't blank
        startScheduledReview();
        startUpdateChecks();
      }
      schedule();
      startBenchQueue();
      resolve({ server, url: addr, port: boundPort });
    };
    const onError = (e) => {
      if (settled) return;
      if (e?.code === 'EADDRINUSE' && Date.now() < relaunchDeadline) { setTimeout(() => server.listen(listenPort, '127.0.0.1'), 250); return; }
      settled = true; reject(e);
    };
    server.on('error', onError);
    server.once('listening', onListen); // Bind retries must not register initialization again.
    server.listen(listenPort, '127.0.0.1');
  });
}
