// Local HTTP server: static UI, JSON API, SSE event stream. Binds to 127.0.0.1 only.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, extname, resolve, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT, readJson, writeJson, statePath } from '../core/paths.mjs';
import { loadConfig, saveConfig, publicConfig } from '../core/config.mjs';
import { bus } from '../core/bus.mjs';
import { getModels, refreshModels, startModelPolling } from '../core/models.mjs';
import { getLimits, refreshLimits, startLimitPolling } from '../core/limits.mjs';
import { estimateUsage, recordUsage } from '../core/usage-estimate.mjs';
import { providerSummaries, PROVIDERS } from '../core/providers/index.mjs';
import * as ollama from '../core/providers/ollama.mjs';
import { listTasks, cancelTask, getTask, publicTask, schedule, createTask, abortRunning } from '../core/tasks.mjs';
import { listImprovements, logImprovement, resolveImprovement, buildReviewPrompt, installGlobalErrorCapture } from '../core/improve.mjs';
import * as conductor from '../core/conductor.mjs';
import { conductorToolDefs, toolsAsMcp } from '../core/tools.mjs';
import { summarize, formatScores, nextScheduledReset } from '../core/scorecard.mjs';
import { updateStatus, applyUpdate, lastUpdateStatus, checkForUpdates } from '../core/update.mjs';

const UI = join(REPO_ROOT, 'ui');
const BOOT = Date.now();
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

  if (m === 'GET' && p === '/api/state') return json(res, 200, { version: VERSION, boot: BOOT, seq: bus.seq, config: publicConfig(), providers: providerSummaries(), models: getModels(), limits: limitsWithEstimates(), sessions: conductor.listSessions(), tasks: listTasks({ limit: 50 }), improvements: listImprovements().slice(-50), home: homedir(), repoRoot: REPO_ROOT });
  if (m === 'POST' && p === '/api/shutdown') { // the UI Quit button — stop this server (in-flight tasks requeue and resume on next start)
    json(res, 200, { ok: true, stopping: true });
    setTimeout(() => { try { abortRunning({ requeue: true }); } catch {} try { unlinkSync(statePath('server.pid')); } catch {} setTimeout(() => process.exit(0), 1200); }, 50);
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
  if (p === '/api/models/refresh' && m === 'POST') return json(res, 200, await refreshModels());
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
    if (m === 'POST') { const b = await readBody(req); const next = saveConfig(b); if (!process.env.CONDUCTOR_NO_POLL) { startModelPolling(next.pollMinutes); startLimitPolling(next.pollMinutes); } schedule(); /* a raised concurrency cap starts queued work now */ bus.publish('settings', {}); return json(res, 200, publicConfig(next)); }
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
    const note = seg[3] === 'install' ? 'Wait for the installer to finish in the window that opened, then press Refresh.'
      : (prov.spec?.login?.note || `Finish the ${seg[3] === 'relogin' ? 're-auth (log out, then sign in)' : 'sign-in'} in the window that opened, then press Refresh.`);
    const opened = openTerminal(`Conductor — ${seg[2]} ${seg[3]}`, command);
    return json(res, 200, { ok: opened, command, note: opened ? note : `Could not open a terminal here; run this yourself: ${command}` });
  }
  if (p === '/api/update' && m === 'GET') return json(res, 200, url.searchParams.get('fetch') === '1' ? updateStatus() : lastUpdateStatus() || updateStatus({ fetch: false }));
  if (p === '/api/update' && m === 'POST') return json(res, 200, applyUpdate());
  if (p === '/api/doctor' && m === 'GET') return json(res, 200, await doctorReport());
  return json(res, 404, { error: `no route ${m} ${p}` });
}

/** Serve limits with a synthetic "estimated" window for subscription providers whose CLI reports no window (Grok):
 *  usage is estimated from token spend, calibrated by the user's check-ins (POST /api/providers/:id/usage). */
function limitsWithEstimates() {
  const lim = getLimits();
  const out = { ...lim, providers: { ...lim.providers } };
  for (const id of Object.keys(PROVIDERS)) {
    const p = out.providers[id] || {};
    if ((p.windows || []).length) continue; // real windows win
    const budgetTokens = loadConfig().scorecard?.usageBudgets?.[id] || null;
    const resetsAt = nextScheduledReset(id) || null; // from the configured reset schedule (usageResets), so the estimate shows a reset + drives the waste discount
    const est = estimateUsage(id, { budgetTokens, resetsAt });
    if (!est || !est.calibrated) continue;
    const note = est.needsCheck
      ? `past projected limit (~${est.rawPct}%) but still running — did it reset early, or is the budget too low? Re-check the real usage and calibrate.`
      : `~${est.ratePctPerMToken}%/M tokens from ${est.points} check-in(s)`;
    out.providers[id] = { ...p, provider: id, windows: [{ id: `${id}:estimated`, label: 'estimated usage', usedPercent: est.pct, resetsAt: est.resetsAt, estimated: true, needsCheck: !!est.needsCheck, note }] };
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
  return { rows, path: (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean), cwd: process.cwd(), stateDir: statePath() };
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

/** Periodic GitHub update check, governed by conductor.autoUpdate ('auto' | 'ask' | 'off'). */
function startUpdateChecks() {
  const run = () => {
    try {
      const cfg = loadConfig();
      const policy = cfg.conductor?.autoUpdate ?? 'ask';
      if (policy === 'off') return;
      const st = checkForUpdates(); // publishes an 'update' event when behind — that's the 'ask' prompt for the UI
      if (policy === 'auto' && st?.git && !st.error && st.behind && !st.dirty) {
        const r = applyUpdate(); // git pull + npm install; takes effect on the next restart
        bus.publish('update', { ...r }); // {updated, from, to, commits, npmInstalled, restartNeeded} — the UI shows "Updated … restart to apply"
        logImprovement('idea', 'update', `auto-updated ${r.commits} commit(s) to ${String(r.to || '').slice(0, 8)} — restart to apply`, {});
      }
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
  const cfg = loadConfig();
  const server = createServer(async (req, res) => {
    const port = server.address().port;
    const host = String(req.headers.host || '').toLowerCase(); const origin = req.headers.origin === undefined ? undefined : String(req.headers.origin).toLowerCase();
    if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(host)) return json(res, 403, { error: 'bad host' });
    if (origin !== undefined && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(res, 403, { error: 'bad origin' });
    if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'content-type must be application/json' });
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
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(listenPort, '127.0.0.1', () => {
      const addr = `http://127.0.0.1:${server.address().port}`;
      conductor.setServerUrl(addr);
      if (!process.env.CONDUCTOR_NO_POLL) {
        startModelPolling(cfg.pollMinutes); startLimitPolling(cfg.pollMinutes);
        refreshModels().then(() => refreshLimits()).catch(() => {});
        startScheduledReview();
        startUpdateChecks();
      }
      schedule();
      resolve({ server, url: addr, port: server.address().port });
    });
  });
}
