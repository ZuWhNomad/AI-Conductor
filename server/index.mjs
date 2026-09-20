// Local HTTP server: static UI, JSON API, SSE event stream. Binds to 127.0.0.1 only.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, extname, resolve, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { REPO_ROOT, readJson, writeJson, statePath } from '../core/paths.mjs';
import { loadConfig, saveConfig, publicConfig } from '../core/config.mjs';
import { bus } from '../core/bus.mjs';
import { getModels, refreshModels, startModelPolling, stopModelPolling } from '../core/models.mjs';
import { getLimits, refreshLimits, startLimitPolling, stopLimitPolling } from '../core/limits.mjs';
import { killProbes } from '../core/proc.mjs';
import { estimateUsage, recordUsage } from '../core/usage-estimate.mjs';
import { providerSummaries, PROVIDERS } from '../core/providers/index.mjs';
import * as ollama from '../core/providers/ollama.mjs';
import { listTasks, cancelTask, getTask, publicTask, schedule, createTask, abortRunning } from '../core/tasks.mjs';
import { listImprovements, logImprovement, resolveImprovement, buildReviewPrompt, installGlobalErrorCapture } from '../core/improve.mjs';
import * as conductor from '../core/conductor.mjs';
import { conductorToolDefs, toolsAsMcp } from '../core/tools.mjs';
import { summarize, formatScores, nextScheduledReset, migrateScorecard } from '../core/scorecard.mjs';
import { updateStatus, applyUpdate, lastUpdateStatus, checkForUpdates } from '../core/update.mjs';
import { detectCapabilities, capabilityReport } from '../core/capabilities.mjs';

const UI = join(REPO_ROOT, 'ui');
const BOOT = Date.now();
let boundPort = null;              // the port this server actually bound — the self-restart relauncher reuses it
const RELAUNCH_WAIT_MS = 20_000;  // how long a relaunch child retries binding while the outgoing process releases the port

export function stopBackgroundWork() {
  try { clearInterval(lagTimer); loopLag.disable(); } catch {}
  try { stopModelPolling(); } catch {}
  try { stopLimitPolling(); } catch {}
  try { stopSignInWatches(); clearInterval(detectTimer); detectTimer = null; } catch {}
  try { killProbes(); } catch {}
}

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
  const minutes = Number(cfg.ui?.detectMinutes ?? 5);
  if (!(minutes > 0)) return;
  detectTimer = setInterval(() => {
    const stale = staleAuthProviders();
    if (stale.length) refreshModels({ only: stale }).catch(() => {});
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
    const tasks = listTasks({ limit: 10000 });
    const v = lagVerdict(p99Ms, Number(loadConfig().server?.lagWarnMs ?? 500), { running: tasks.filter((t) => t.status === 'running').length, queued: tasks.filter((t) => t.status === 'queued').length, sessions: conductor.listSessions().filter((s) => s.status === 'running').length });
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
// Oversized bodies are drained (not destroyed) so the 413 actually reaches the client.
const readBody = (req) => new Promise((resolve, reject) => { let d = '', stopped = false; req.on('data', (c) => { if (stopped) return; d += c; if (d.length > 5e6) { stopped = true; d = ''; reject(Object.assign(new Error('body too large'), { status: 413 })); req.resume(); } }); req.on('end', () => { if (stopped) return; try { resolve(d ? JSON.parse(d) : {}); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); } }); req.on('error', reject); });

function listDirs(p) {
  const dir = resolve(p || homedir());
  let entries;
  try { entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name).sort((a, b) => a.localeCompare(b)) : []; }
  catch (e) { return { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, dirs: [], error: e.code }; }
  return { path: dir, parent: dirname(dir) !== dir ? dirname(dir) : null, dirs: entries, hasGit: existsSync(join(dir, '.git')), hasClaudeMd: existsSync(join(dir, 'CLAUDE.md')) };
}

/** Minimal MCP streamable-HTTP server (JSON responses) so Codex conductors can call the workbench tools. */
async function mcpRoute(req, res, seg) {
  const ctx = conductor.sessionContext(seg[1]);
  if (!ctx) return json(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'unknown session' } });
  if (req.method === 'GET') { res.writeHead(405); res.end(); return true; }        // no server-initiated stream
  if (req.method === 'DELETE') { res.writeHead(200); res.end(); return true; }
  const body = await readBody(req);
  const reply = (id, result) => json(res, 200, { jsonrpc: '2.0', id, result });
  const defs = conductorToolDefs({ sessionId: ctx.id, cwd: ctx.cwd });
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

  if (m === 'GET' && p === '/api/state') return json(res, 200, { version: VERSION, boot: BOOT, seq: bus.seq, config: publicConfig(), providers: providerSummaries(), models: getModels(), limits: limitsWithEstimates(), sessions: conductor.listSessions(), tasks: listTasks({ limit: 50 }), improvements: listImprovements().slice(-50), update: lastUpdateStatus(), home: homedir(), repoRoot: REPO_ROOT });
  if (m === 'POST' && p === '/api/shutdown') { // the UI Quit button — stop this server (in-flight tasks requeue and resume on next start)
    json(res, 200, { ok: true, stopping: true });
    setTimeout(() => { try { stopBackgroundWork(); } catch {} try { abortRunning({ requeue: true }); } catch {} try { unlinkSync(statePath('server.pid')); } catch {} setTimeout(() => process.exit(0), 1200); }, 50);
    return true;
  }

  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ boot: BOOT })}\n\n`);
    const send = (ev) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    for (const ev of bus.since(Number(url.searchParams.get('since') || 0))) send(ev);
    const h = (ev) => send(ev);
    bus.on('event', h);
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => { bus.off('event', h); clearInterval(hb); });
    return true;
  }

  if (seg[1] === 'sessions') {
    if (m === 'GET' && !seg[2]) return json(res, 200, conductor.listSessions());
    if (m === 'POST' && !seg[2]) { const b = await readBody(req); return json(res, 200, conductor.createSession({ ...b, overflowApi: b.overflowApi == null ? null : !!b.overflowApi })); }
    const id = seg[2];
    if (m === 'GET' && !seg[3]) { const s = await conductor.getSession(id); return s ? json(res, 200, s) : json(res, 404, { error: 'not found' }); }
    if (m === 'DELETE' && !seg[3]) return json(res, 200, { ok: conductor.deleteSession(id) });
    const b = m === 'POST' ? await readBody(req) : {};
    if (m === 'POST' && seg[3] === 'messages') return json(res, 200, await conductor.sendMessage(id, String(b.text || '')));
    if (m === 'POST' && seg[3] === 'interrupt') return json(res, 200, { ok: await conductor.interrupt(id) });
    if (m === 'POST' && seg[3] === 'stop') return json(res, 200, { ok: conductor.stopSession(id) });
    if (m === 'POST' && seg[3] === 'permission') return json(res, 200, { ok: conductor.answerPermission(id, b.requestId, { allow: !!b.allow, message: b.message }) });
    if (m === 'POST' && seg[3] === 'title') return json(res, 200, conductor.setTitle(id, b.title));
    if (m === 'POST' && seg[3] === 'model') { await conductor.setModel(id, b.model || null); return json(res, 200, { ok: true }); }
    if (m === 'POST' && seg[3] === 'effort') { conductor.setEffort(id, b.effort || null); return json(res, 200, { ok: true }); }
    if (m === 'POST' && seg[3] === 'mode') { await conductor.setPermissionMode(id, b.permissionMode); return json(res, 200, { ok: true }); }
    if (m === 'POST' && seg[3] === 'overflow') { conductor.setOverflow(id, !!b.overflowApi); return json(res, 200, { ok: true }); }
  }

  if (p === '/api/models' && m === 'GET') return json(res, 200, getModels());
  if (p === '/api/models/refresh' && m === 'POST') { const b = await readBody(req).catch(() => ({})); const only = Array.isArray(b?.only) && b.only.length ? b.only : null; const r = await refreshModels(only ? { only } : undefined); if (!only) detectCapabilities().catch(() => {}); return json(res, 200, r); }
  if (p === '/api/limits' && m === 'GET') return json(res, 200, limitsWithEstimates());
  if (seg[1] === 'providers' && seg[2] && seg[3] === 'usage' && m === 'POST') {
    const b = await readBody(req); const pct = Number(b.pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return json(res, 400, { error: 'pct must be 0-100' });
    const row = recordUsage(seg[2], pct); bus.publish('limits', { updatedAt: getLimits().updatedAt });
    return json(res, 200, { ok: true, recorded: row, estimate: estimateUsage(seg[2], { budgetTokens: loadConfig().scorecard?.usageBudgets?.[seg[2]] || null }) });
  }
  if (p === '/api/bench' && m === 'GET') { const { dueForBench, formatBench } = await import('../core/bench.mjs'); const due = dueForBench(); return json(res, 200, { due, text: formatBench(due) }); }
  if (p === '/api/scores' && m === 'GET') { const source = url.searchParams.get('source') || null; return json(res, 200, { summary: summarize({ source }), text: formatScores({ source, category: url.searchParams.get('category') || null }) }); }
  if (p === '/api/limits/refresh' && m === 'POST') return json(res, 200, await refreshLimits());

  if (seg[1] === 'tasks') {
    if (m === 'GET' && !seg[2]) return json(res, 200, listTasks({ sessionId: url.searchParams.get('session') || null }));
    if (m === 'POST' && !seg[2]) { // direct-to-worker (no conductor tokens): the UI's "/worker …" shortcut
      const b = await readBody(req);
      if (typeof b.cwd !== 'string' || typeof b.spec !== 'string' || !b.cwd || !b.spec) return json(res, 400, { error: 'cwd and spec must be nonempty strings' });
      return json(res, 200, publicTask(createTask({ sessionId: b.sessionId || null, cwd: b.cwd, title: b.title || String(b.spec).slice(0, 50), spec: b.spec, provider: b.provider, model: b.model, effort: b.effort, paths: b.paths, followUpOf: b.followUpOf, sandbox: b.sandbox, category: b.category, difficulty: b.difficulty, variant: b.variant, noFailover: b.noFailover })));
    }
    if (m === 'GET' && seg[2] && !seg[3]) { const t = getTask(seg[2]); return t ? json(res, 200, { ...publicTask(t), spec: t.spec }) : json(res, 404, { error: 'not found' }); }
    if (m === 'POST' && seg[3] === 'cancel') return json(res, 200, { ok: !!cancelTask(seg[2]) });
  }

  if (p === '/api/settings') {
    if (m === 'GET') return json(res, 200, publicConfig());
    if (m === 'POST') { const b = await readBody(req); const next = saveConfig(b); applyPolling(next); applyDetectSweep(next); /* the "auto" control governs the server poll */ schedule(); /* a raised concurrency cap starts queued work now */ bus.publish('settings', {}); return json(res, 200, publicConfig(next)); }
  }

  if (seg[1] === 'improvements') {
    if (m === 'GET') return json(res, 200, listImprovements({ includeResolved: url.searchParams.get('all') === '1' }));
    if (m === 'POST' && !seg[2]) { const b = await readBody(req); return json(res, 200, logImprovement(b.kind || 'idea', 'ui', b.message || '', b.context || {})); }
    if (m === 'POST' && seg[3] === 'resolve') { resolveImprovement(seg[2]); bus.publish('improvement', { resolved: seg[2] }); return json(res, 200, { ok: true }); }
  }
  if (p === '/api/review' && m === 'POST') {
    const b = await readBody(req);
    const s = conductor.createSession({ cwd: REPO_ROOT, model: b.model || null, title: 'Self-review' });
    await conductor.sendMessage(s.id, buildReviewPrompt());
    return json(res, 200, s);
  }
  if (p === '/api/ollama/pull' && m === 'POST') { const b = await readBody(req); ollama.pullModel(String(b.model || '')).then(() => refreshModels({ only: ['ollama'] })).catch((e) => logImprovement('error', 'ollama', e.message)); return json(res, 200, { ok: true }); }
  if (p === '/api/browse' && m === 'GET') return json(res, 200, listDirs(url.searchParams.get('path')));
  if (seg[1] === 'providers' && seg[2] && ['login', 'relogin', 'install'].includes(seg[3]) && m === 'POST') {
    const prov = PROVIDERS[seg[2]];
    if (!prov) return json(res, 404, { error: 'unknown provider' });
    let command;
    if (seg[3] === 'install') command = prov.installCommand?.();
    else { // login / relogin: re-auth clears a stale token first (logout) where the CLI supports it, then signs in
      const login = prov.loginCommand?.();
      const logout = seg[3] === 'relogin' ? prov.logoutCommand?.() : null;
      command = login && logout ? `${logout} & ${login}` : login; // `&` = run login even if logout errored
    }
    if (!command) return json(res, 400, { error: `${seg[2]} has no ${seg[3]} command` });
    const note = seg[3] === 'install' ? 'Wait for the installer to finish in the window that opened — Conductor re-checks by itself.'
      : (prov.spec?.login?.note || `Finish the ${seg[3] === 'relogin' ? 're-auth (log out, then sign in)' : 'sign-in'} in the window that opened — Conductor re-checks by itself.`);
    const opened = openTerminal(`Conductor — ${seg[2]} ${seg[3]}`, command);
    if (opened && !process.env.CONDUCTOR_NO_POLL) watchSignIn(seg[2], { awaitDrop: seg[3] === 'relogin' }); // re-probe until it comes back ok: no manual Refresh
    return json(res, 200, { ok: opened, command, note: opened ? note : `Could not open a terminal here; run this yourself: ${command}` });
  }
  if (p === '/api/update' && m === 'GET') return json(res, 200, url.searchParams.get('fetch') === '1' ? updateStatus() : lastUpdateStatus() || updateStatus({ fetch: false }));
  if (p === '/api/update' && m === 'POST') { // pull, then self-restart into the new version; relaunching:false falls back to the manual-restart message
    const r = applyUpdate();
    const relaunching = !!(r.updated && r.restartNeeded && !r.npmError && scheduleRelaunch({ port: boundPort ?? req.socket.localPort }));
    return json(res, 200, { ...r, relaunching });
  }
  if (p === '/api/doctor' && m === 'GET') return json(res, 200, await doctorReport());
  return json(res, 404, { error: `no route ${m} ${p}` });
}

/** Serve limits with a synthetic "estimated" window for subscription providers whose CLI reports no window (Grok):
 *  usage is estimated from token spend, calibrated by the user's check-ins (POST /api/providers/:id/usage). */
const pct1 = (n) => Math.round(n * 10) / 10; // %/M tokens, one decimal
function limitsWithEstimates() {
  const lim = getLimits();
  const out = { ...lim, providers: { ...lim.providers } };
  for (const id of Object.keys(PROVIDERS)) {
    const p = out.providers[id] || {};
    if ((p.windows || []).length) continue; // real windows win
    const budgetTokens = loadConfig().scorecard?.usageBudgets?.[id] || null;
    const resetsAt = nextScheduledReset(id) || null; // from the configured reset schedule (usageResets), so the estimate shows a reset + drives the waste discount
    const est = estimateUsage(id, { budgetTokens, resetsAt });
    // Show the bar whenever we can produce ANY estimate — even before a real check-in (a flat token budget is a
    // sensible uncalibrated fallback) — so a subscription CLI like Grok never sits blank. It is clearly marked as an
    // estimate; a check-in refines it. Providers with neither a budget nor a check-in still produce no estimate.
    if (!est) continue;
    const note = est.needsCheck
      ? `past projected limit (~${est.rawPct}%) but still running — did it reset early, or is the budget too low? Re-check the real usage and calibrate.`
      : est.calibrated
        ? `${est.anchorPct}% ${est.anchorFrom === 'reset' ? 'at the scheduled reset' : 'recorded'}${est.anchorAt ? ` ${new Date(est.anchorAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''} + ~${est.ratePctPerMToken}%/M tokens since${est.rateBasis === 'runs' ? ` (${est.runs} measured run${est.runs > 1 ? 's' : ''}${est.runs > 1 ? `, ${pct1(est.rateLo * 1e6)}–${pct1(est.rateHi * 1e6)}` : ''})` : ' — burn rate not measured yet, record a second, higher % to learn it'}`
        : budgetTokens
          ? `uncalibrated estimate against a ${(budgetTokens / 1e6).toLocaleString()}M-token budget — record a real usage % to calibrate`
          : 'uncalibrated estimate — record a real usage % to calibrate';
    out.providers[id] = { ...p, provider: id, windows: [{ id: `${id}:estimated`, label: 'estimated usage', usedPercent: est.pct, resetsAt: est.resetsAt, estimated: true, calibrated: !!est.calibrated, needsCheck: !!est.needsCheck, note }] };
  }
  return out;
}

/** Open a visible terminal running `command` (sign-in flows need a real console + browser). */
function openTerminal(title, command) {
  try {
    const dir = statePath('tmp'); mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
      const file = join(dir, `run-${Date.now()}.cmd`);
      writeFileSync(file, `@echo off\r\ntitle ${title.replace(/[&|<>^]/g, ' ')}\r\necho ${command.replace(/[&|<>^%]/g, ' ')}\r\n${command}\r\necho.\r\necho Done. You can close this window and press Refresh in Conductor.\r\n`);
      spawn('cmd.exe', ['/c', 'start', '', file], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else if (process.platform === 'darwin') {
      const file = join(dir, `run-${Date.now()}.command`);
      writeFileSync(file, `#!/bin/bash\n${command}\necho; echo "Done. You can close this window and press Refresh in Conductor."\n`, { mode: 0o755 });
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', 'bash', '-c', `${command}; echo; read -p "Done. Press Enter to close."`], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch { return false; }
}

/** Environment check shared by `conductor doctor` and the UI. */
export async function doctorReport() {
  const { PROVIDERS } = await import('../core/providers/index.mjs');
  const { cliVersion, codexCommand, findCli } = await import('../core/proc.mjs');
  const { execFileSync } = await import('node:child_process');
  // Version through the same resolution the workers use (npm shim, CONDUCTOR_CODEX or the desktop app's exe).
  const codexVersion = () => { const c = codexCommand(); if (!c) return null; try { return execFileSync(c.command, [...c.args, '--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim(); } catch { return cliVersion('codex'); } };
  const rows = [];
  rows.push({ name: 'node', value: process.version, status: Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'need Node 22+' });
  const claude = await PROVIDERS.claude.detect();
  rows.push({ name: 'claude (Agent SDK)', value: JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version, status: claude.loggedIn ? `logged in (${claude.subscription || 'subscription'})` : `NOT logged in → run: ${PROVIDERS.claude.loginCommand()}` });
  const codex = codexCommand();
  rows.push({ name: 'codex', value: codexVersion() || 'missing', status: codex ? ((await PROVIDERS.codex.account().catch(() => ({ loggedIn: false }))).loggedIn ? 'logged in' : 'NOT logged in → run: codex login') : 'install: npm i -g @openai/codex', path: codex ? [codex.command, ...codex.args].join(' ') : findCli('codex') });
  const ol = await PROVIDERS.ollama.detect();
  rows.push({ name: 'ollama', value: ol.version || (ol.installed ? 'installed (not running)' : 'missing'), status: ol.installed ? 'ok' : 'optional: https://ollama.com' });
  rows.push({ name: 'git', value: cliVersion('git') || 'missing', status: '' });
  return { rows, capabilities: capabilityReport(), path: (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean), cwd: process.cwd(), stateDir: statePath(), eventLoop: lagStats() };
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

/** Self-restart: spawn a DETACHED fresh conductor on the SAME port using THIS process's own env (so it inherits the
 *  real CONDUCTOR_HOME + port, never an ambient shell's), then hand off — once the child is confirmed alive we requeue
 *  in-flight work, drop the port and exit so the new version takes over. The child's retry-bind (CONDUCTOR_RELAUNCH_WAIT,
 *  honored in startServer) tolerates the brief window before this process exits. Returns false WITHOUT exiting when the
 *  child can't be spawned, so callers fall back to "restart manually" and never strand the app dead. spawnFn/exit are
 *  injectable for tests. */
export function scheduleRelaunch({ port = boundPort, spawnFn = spawn, exit = () => process.exit(0), okTimeoutMs = 10_000 } = {}) {
  const argv = [join(REPO_ROOT, 'bin', 'conductor.mjs'), 'start', '--no-open', ...(port ? ['--port', String(port)] : [])];
  const okFile = statePath('relaunch-ok'); try { unlinkSync(okFile); } catch {}
  let child;
  try {
    child = spawnFn(process.execPath, argv, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CONDUCTOR_RELAUNCH_WAIT: String(RELAUNCH_WAIT_MS) } });
  } catch { return false; } // couldn't even spawn → stay up, let the caller show the manual-restart message
  let settled = false;
  const handoff = () => {
    if (settled) return; settled = true;
    try { child.unref?.(); } catch {}
    try { stopBackgroundWork(); } catch {}
    try { abortRunning({ requeue: true }); } catch {} // in-flight worker tasks resume in the new process
    try { unlinkSync(statePath('server.pid')); } catch {}
    setTimeout(exit, 300); // let the HTTP response flush before we drop the port
  };
  // A child that dies on import (missing dependency, syntax error) must not take the running server down with it:
  // the previous version stays up, says so, and the user restarts by hand once it is fixed.
  const fail = (why) => {
    if (settled) return; settled = true;
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
  child.once?.('error', (e) => { try { logImprovement('friction', 'update', 'relaunch child failed: ' + (e?.message || e) + ' — staying up; restart manually'); } catch {} });
  return true;
}

/** Periodic GitHub update check, governed by conductor.autoUpdate ('auto' | 'ask' | 'off'). On 'auto' it pulls AND
 *  self-restarts — but only while the server is IDLE (no chat turn running, no worker task active), so an update never
 *  interrupts in-flight work; while busy it defers and re-checks on a short cadence, applying as soon as work settles. */
function startUpdateChecks() {
  let recheck = null; // a short re-check armed while an update is pending but the server is busy
  const idle = () => {
    try {
      return isIdle({
        runningSessions: conductor.listSessions().filter((s) => s.status === 'running').length,
        openTasks: listTasks({ limit: 10000 }).filter((t) => !['done', 'failed', 'canceled'].includes(t.status)).length,
        lastActivity, quietMs: Number(loadConfig().conductor?.updateQuietMinutes ?? 15) * 60_000,
      });
    } catch { return false; } // can't tell → defer rather than risk interrupting work
  };
  const run = () => {
    try {
      const cfg = loadConfig();
      const policy = cfg.conductor?.autoUpdate ?? 'ask';
      if (policy === 'off') return;
      const st = checkForUpdates(); // publishes an 'update' event when behind — flashes the button on 'ask' AND 'auto'
      if (policy !== 'auto' || !st?.git || st.error || !st.behind || st.dirty || st.ahead) return;
      if (!idle()) { // update ready but work is in flight — defer; re-check soon so it applies as soon as we're idle
        if (!recheck) { recheck = setTimeout(() => { recheck = null; run(); }, 60_000); recheck.unref?.(); }
        return;
      }
      const r = applyUpdate(); // git pull + npm install; publishes its own 'update' event
      // Loop guard: only restart when the pull actually advanced HEAD. After a successful pull we're up to date, so the
      // next check finds nothing behind and never restarts — start→pull→restart→start cannot loop.
      const moved = !!(r.updated && r.to && r.to !== r.from);
      if (r.npmError) logImprovement('friction', 'update', `auto-updated ${r.commits} commit(s) to ${String(r.to).slice(0, 8)}, but npm install failed (${r.npmError}) — run \`npm install\` in the Conductor folder, then restart`, {});
      else if (moved && scheduleRelaunch()) { bus.publish('update', { relaunching: true, from: r.from, to: r.to }); logImprovement('idea', 'update', `auto-updated ${r.commits} commit(s) to ${String(r.to).slice(0, 8)} — restarting to apply`, {}); }
      else if (moved) logImprovement('idea', 'update', `auto-updated ${r.commits} commit(s) to ${String(r.to).slice(0, 8)} — restart to apply (relaunch unavailable)`, {});
    } catch (e) { try { logImprovement('friction', 'update', `update check failed: ${e.message}`, {}); } catch {} }
  };
  setTimeout(run, 3000).unref();
  const hours = Number(loadConfig().conductor?.updateCheckHours ?? 6);
  if (hours > 0) setInterval(run, hours * 3_600_000).unref();
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
  try { const n = migrateScorecard(); if (n) logImprovement('idea', 'scorecard', `method-c migration: voided ${n} polluted antigravity row(s) (effort tagged on an effort-in-id model)`); } catch {}
  const cfg = loadConfig();
  const server = createServer(async (req, res) => {
    const port = server.address().port;
    const host = String(req.headers.host || '').toLowerCase(); const origin = req.headers.origin === undefined ? undefined : String(req.headers.origin).toLowerCase();
    if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host)) return json(res, 403, { error: 'bad host' });
    if (origin !== undefined && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(res, 403, { error: 'bad origin' });
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'content-type must be application/json' });
    if (req.method !== 'GET') lastActivity = Date.now();
    const url = new URL(req.url, 'http://127.0.0.1');
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
      boundPort = server.address().port;
      delete process.env.CONDUCTOR_RELAUNCH_WAIT; // don't let the relaunch flag linger into normal operation or child processes
      const addr = `http://127.0.0.1:${boundPort}`;
      conductor.setServerUrl(addr);
      startLagMonitor();
      if (!process.env.CONDUCTOR_NO_POLL) {
        applyPolling(cfg); // start the periodic model/limit poll only when auto-refresh is on
        applyDetectSweep(cfg); // and the slow re-probe of signed-out providers (independent of that control)
        refreshModels().then(() => refreshLimits()).then(() => detectCapabilities()).catch(() => {}); // one refresh at boot regardless, so the panel isn't blank
        startScheduledReview();
        startUpdateChecks();
      }
      schedule();
      resolve({ server, url: addr, port: boundPort });
    };
    const onError = (e) => {
      if (settled) return;
      if (e?.code === 'EADDRINUSE' && Date.now() < relaunchDeadline) { setTimeout(() => server.listen(listenPort, '127.0.0.1', onListen), 250); return; }
      settled = true; reject(e);
    };
    server.on('error', onError);
    server.listen(listenPort, '127.0.0.1', onListen);
  });
}
