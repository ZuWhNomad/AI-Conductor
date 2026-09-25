import { tmpDir } from '../_env.mjs';
import { test, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { request } from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Explicit refresh/doctor calls bypass CONDUCTOR_NO_POLL. Keep their real routes,
// but replace every provider probe and the machine-specific capability catalogue.
const { PROVIDERS } = await import('../../core/providers/index.mjs');
const { loadIndex } = await import('../../core/capabilities.mjs');
const { saveConfig } = await import('../../core/config.mjs');
const originalProviders = { ...PROVIDERS };
for (const [id, provider] of Object.entries(PROVIDERS)) {
  PROVIDERS[id] = { ...provider,
    detect: mock.fn(async () => ({ installed: true, configured: true, loggedIn: true, version: 'test-version' })),
    listModels: mock.fn(async () => [{ provider: id, id: 'test-model', kind: 'agent' }]),
    account: mock.fn(async () => ({ loggedIn: true })),
    pollLimits: mock.fn(async () => ({ provider: id, windows: [], blocked: false })),
  };
}
saveConfig({ tools: { index: {
  ...Object.fromEntries(loadIndex().map(({ name }) => [name, null])),
  'test-capability': { kind: 'app', purpose: 'offline fixture' },
} } });

const unexpectedIO = [];
const rejectIO = (operation) => {
  unexpectedIO.push(operation);
  throw new Error(`unexpected external I/O: ${operation}`);
};
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  mock.method(childProcess, method, () => rejectIO(method));
}
syncBuiltinESMExports();

const { startServer, lagVerdict, doctorReport, isIdle } = await import('../../server/index.mjs');
const { server, url } = await startServer({ port: 0 });
const realFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', (input, options) => {
  if (new URL(input).origin !== url) return rejectIO(`fetch ${input}`);
  return realFetch(input, { ...options, redirect: 'error' });
});
afterEach(() => assert.deepEqual(unexpectedIO, [], 'caught probe errors must still fail the test'));
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  Object.assign(PROVIDERS, originalProviders);
  mock.restoreAll();
  syncBuiltinESMExports();
});

const get = (p) => fetch(url + p).then((r) => r.json());
const post = (p, b) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

test('static UI and state endpoint', async () => {
  const html = await fetch(url + '/').then((r) => r.text());
  assert.match(html, /Conductor 2\.0/);
  assert.match((await fetch(url + '/app.js')).headers.get('content-type'), /javascript/); // guard: UI served from REPO_ROOT/ui
  assert.equal((await fetch(url + '/../package.json')).status, 404);
  const st = await get('/api/state');
  assert.equal(st.version, '2.0.0');
  assert.equal(st.pid, process.pid);
  assert.equal(typeof st.improvementCount, 'number');
  assert.ok(Array.isArray(st.providers) && st.providers.some((p) => p.id === 'codex'));
  assert.equal(st.config.providers.deepseek.apiKey, null);
});

test('Grok shows an estimated usage bar even before any check-in (uncalibrated)', async () => {
  const lim = await get('/api/limits');
  const w = (lim.providers.grok?.windows || []).find((x) => x.id === 'grok:estimated');
  assert.ok(w, 'grok has a synthetic estimated window');
  assert.equal(w.estimated, true);
  assert.equal(w.calibrated, false);
  assert.equal(typeof w.usedPercent, 'number'); // a number (not blank), so the UI renders a bar
  assert.match(w.note, /uncalibrated/);
});

test('sessions, tasks, browse and SSE replay', async () => {
  const cwd = tmpDir('srv');
  const s = await post('/api/sessions', { cwd, model: 'sonnet', effort: 'low' });
  assert.equal(s.model, 'sonnet');
  const full = await get(`/api/sessions/${s.id}`);
  assert.deepEqual(full.messages, []);
  assert.equal(typeof full.seq, 'number');
  const t = await post('/api/tasks', { sessionId: s.id, cwd, spec: 'write tests' });
  assert.equal(t.status, 'queued');
  assert.equal((await get(`/api/tasks?session=${s.id}`)).length, 1);
  const bad = await fetch(url + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(bad.status, 400);
  const b = await get(`/api/browse?path=${encodeURIComponent(cwd)}`);
  assert.equal(b.hasGit, false);
  assert.ok(Array.isArray(b.dirs));

  const res = await fetch(url + '/api/events?since=0');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const chunk = new TextDecoder().decode(value);
  assert.match(chunk, /^event: hello\ndata: \{"boot":/);
  assert.equal(JSON.parse(chunk.split('\n')[1].slice(6)).boot, (await get('/api/state')).boot);
  assert.match(chunk, /event: session/);
  assert.match(chunk, /event: task/);
  await reader.cancel();
  await post(`/api/tasks/${t.id}/cancel`);
  assert.equal((await fetch(url + `/api/sessions/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await get('/api/sessions')).length, 0);
});

test('task follow-ups inherit cwd without requiring it in the request', async () => {
  const { getTask } = await import('../../core/tasks.mjs');
  const cwd = tmpDir('srv-follow-up');
  const parent = await post('/api/tasks', { cwd, spec: 'initial task' });
  Object.assign(getTask(parent.id), { status: 'done', threadId: 'test-thread' });
  const send = (body) => fetch(url + '/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await send({ followUpOf: parent.id, spec: 'fix it' });
  assert.equal(response.status, 200);
  const follow = await response.json();
  assert.equal(follow.cwd, cwd);
  assert.equal(follow.followUpOf, parent.id);
  assert.equal(follow.threadId, 'test-thread');
  assert.equal((await get(`/api/tasks/${follow.id}`)).cwd, cwd);
  assert.equal((await send({ spec: 'new task' })).status, 400);
  assert.equal((await send({ followUpOf: parent.id, spec: '' })).status, 400);
  assert.equal((await send({ followUpOf: parent.id, spec: 42 })).status, 400);
  assert.equal((await send({ followUpOf: 'missing', spec: 'fix it' })).status, 404);
  await post(`/api/tasks/${follow.id}/cancel`);
});

test('SSE hello exposes the oldest retained event when the replay cursor has fallen behind', async () => {
  const { bus } = await import('../../core/bus.mjs');
  const empty = new bus.constructor();
  assert.equal(empty.oldest, empty.seq + 1);
  const cursor = bus.seq;
  // The bus contract retains 2000 events; one more evicts the event immediately after this cursor.
  for (let i = 0; i < 2001; i++) bus.publish('replay-test');
  assert.equal(bus.oldest, cursor + 2);
  assert.equal(bus.since(cursor).length, 2000);
  const res = await fetch(url + `/api/events?since=${cursor}`);
  const reader = res.body.getReader();
  try {
    let chunk = '';
    while (!chunk.includes('\n\n')) chunk += new TextDecoder().decode((await reader.read()).value);
    const hello = JSON.parse(chunk.split('\n')[1].slice(6));
    assert.equal(hello.oldest, cursor + 2);
    assert.equal(hello.boot, (await get('/api/state')).boot);
    bus.publish('live-after-gap');
    while (!chunk.includes('live-after-gap') && !chunk.includes('replay-test')) {
      const { value, done } = await reader.read();
      if (done) break;
      chunk += new TextDecoder().decode(value);
    }
    assert.doesNotMatch(chunk, /replay-test/, 'skip replay when oldest > since+1; the client resyncs');
    assert.match(chunk, /live-after-gap/);
  } finally { await reader.cancel(); }
});

test('resolving an improvement over HTTP publishes exactly one event', async () => {
  const { bus } = await import('../../core/bus.mjs');
  const entry = await post('/api/improvements', { kind: 'idea', message: 'resolution route fixture' });
  const seq = bus.seq;
  assert.deepEqual(await post(`/api/improvements/${entry.id}/resolve`), { ok: true });
  const events = bus.since(seq).filter((e) => e.type === 'improvement' && e.resolved === entry.id);
  assert.equal(events.length, 1);
  assert.ok(!(await get('/api/improvements')).some((e) => e.id === entry.id));
});

test('bad requests are client errors and leave state usable', async () => {
  const cwd = tmpDir('srv-validation');
  const send = (p, body, headers = {}) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  for (const [p, body, status] of [
    ['/api/tasks', { cwd, spec: 42 }, 400],
    ['/api/settings', 'x', 400], ['/api/settings', null, 400], ['/api/settings', [], 400],
    ['/api/sessions', { cwd: 123 }, 400], ['/api/sessions', { cwd: join(cwd, 'missing') }, 400],
    ['/api/sessions', { cwd, permissionMode: 'bogus' }, 400], ['/api/sessions/nope/messages', { text: 'hello' }, 404],
  ]) {
    assert.equal((await send(p, body)).status, status, p);
    assert.equal((await fetch(url + '/api/state')).status, 200);
  }
  assert.equal((await send('/api/settings', { conductor: null })).status, 200);
  const { DEFAULTS } = await import('../../core/config.mjs');
  assert.deepEqual((await get('/api/settings')).conductor, DEFAULTS.conductor);
  assert.equal((await send('/api/settings', { pollMinutes: 'abc' })).status, 200);
  assert.equal((await get('/api/settings')).pollMinutes, 15);
  const invalid = await fetch(url + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, 'invalid JSON body');
  assert.equal((await send('/api/settings', {}, { Origin: 'http://evil.test' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { const req = request(url + '/api/state', { headers: { Host: 'evil.test:1' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(hostStatus, 403);
  const upperHost = await new Promise((resolve, reject) => { const req = request(url + '/api/state', { headers: { Host: `LOCALHOST:${new URL(url).port}` } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(upperHost, 200, 'host check is case-insensitive');
  const huge = await fetch(url + '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":"' + 'a'.repeat(5_100_000) + '"}' });
  assert.equal(huge.status, 413, 'oversized body gets a real 413');
  assert.equal((await send('/api/settings', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send('/api/settings', {}, { Origin: url })).status, 200);
  const file = join(cwd, 'file.txt'); writeFileSync(file, 'test');
  const browse = await fetch(url + '/api/browse?path=' + encodeURIComponent(file));
  assert.equal(browse.status, 200); const b = await browse.json(); assert.deepEqual(b.dirs, []); assert.equal(b.error, 'ENOTDIR');
});

test('event-loop lag: sampled live for doctor; a friction verdict only above the threshold', async (ctx) => {
  assert.equal(lagVerdict(120, 500), null);
  const v = lagVerdict(900, 500, { running: 3 });
  assert.match(v.message, /p99=900ms/); assert.equal(v.context.running, 3);
  const previousCodex = process.env.CONDUCTOR_CODEX;
  process.env.CONDUCTOR_CODEX = process.execPath; // deterministic resolution; version execution is stubbed below
  ctx.mock.method(childProcess, 'execFile', (command, args, opts, callback) => {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    const argv = Array.isArray(args) ? args : [];
    assert.ok(argv.includes('--version') || argv[argv.length - 1] === '--version' || command === process.execPath);
    const stdout = 'test-version';
    if (typeof callback === 'function') queueMicrotask(() => callback(null, stdout, ''));
    return { stdout };
  });
  syncBuiltinESMExports();
  try {
    for (const d of [await doctorReport(), await get('/api/doctor')]) {
      assert.equal(typeof d.eventLoop.p99Ms, 'number'); assert.ok(d.eventLoop.p99Ms >= 0);
      assert.equal(d.rows.find((r) => r.name === 'codex').value, 'test-version');
      assert.equal(d.rows.find((r) => r.name === 'codex').status, 'logged in');
    }
  } finally {
    if (previousCodex === undefined) delete process.env.CONDUCTOR_CODEX;
    else process.env.CONDUCTOR_CODEX = previousCodex;
    ctx.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('auto-update idle gate: empty is not enough, it must also have been quiet', () => {
  const now = 1_000_000, quietMs = 15 * 60_000;
  assert.equal(isIdle({ runningSessions: 0, openTasks: 0, lastActivity: now - 60_000, now, quietMs }), false);   // a driver posted a minute ago
  assert.equal(isIdle({ runningSessions: 0, openTasks: 0, lastActivity: now - quietMs, now, quietMs }), true);
  assert.equal(isIdle({ runningSessions: 1, openTasks: 0, lastActivity: now - quietMs * 2, now, quietMs }), false);
  assert.equal(isIdle({ runningSessions: 0, openTasks: 2, lastActivity: now - quietMs * 2, now, quietMs }), false);
});

test('POST /api/models/refresh: no body, {} and {only:[…]} all work', async () => {
  // The route started reading a body when `only` was added; the UI posts it both with and without one, so a bodyless
  // POST must not hang or 400. (A scoped refresh also skips the capability detection a full one triggers.)
  const send = (body) => fetch(url + '/api/models/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body }) });
  const { detectionStatus } = await import('../../core/capabilities.mjs');
  for (const body of [undefined, '{}', JSON.stringify({ only: ['grok'] }), JSON.stringify({ only: [] }), 'not json']) {
    const before = Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, [p.detect.mock.callCount(), p.listModels.mock.callCount()]]));
    const capabilitiesBefore = detectionStatus();
    const r = await send(body);
    assert.equal(r.status, 200, `body: ${body}`);
    const j = await r.json();
    assert.ok(j.providers, `body: ${body}`);
    const scoped = body === JSON.stringify({ only: ['grok'] });
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const calls = scoped && id !== 'grok' ? 0 : 1;
      assert.equal(p.detect.mock.callCount() - before[id][0], calls, `${id} detect, body: ${body}`);
      assert.equal(p.listModels.mock.callCount() - before[id][1], calls, `${id} list, body: ${body}`);
      assert.ok(j.models.some((m) => m.provider === id && m.id === 'test-model'));
    }
    if (scoped) assert.equal(detectionStatus(), capabilitiesBefore);
    else {
      assert.notEqual(detectionStatus(), capabilitiesBefore);
      assert.deepEqual(Object.keys(detectionStatus()), ['test-capability']);
      assert.equal(detectionStatus()['test-capability'].available, true);
    }
  }
});

test('saving settings replaces the update interval and off or shutdown clears it', async (ctx) => {
  const { loadConfig, saveConfig, DEFAULTS } = await import('../../core/config.mjs');
  const { stopBackgroundWork } = await import('../../server/index.mjs');
  const previous = loadConfig();
  const timers = [];
  ctx.mock.method(globalThis, 'setInterval', (_fn, ms) => {
    const timer = { ms, cleared: false, unref() { return this; } }; timers.push(timer); return timer;
  });
  ctx.mock.method(globalThis, 'clearInterval', (timer) => { if (timer) timer.cleared = true; });
  delete process.env.CONDUCTOR_NO_POLL;
  try {
    await post('/api/settings', { conductor: { autoUpdate: 'off' } });
    const initial = await post('/api/settings', { conductor: DEFAULTS.conductor });
    assert.equal(initial.conductor.autoUpdate, 'auto');
    const first = timers.find((t) => t.ms === DEFAULTS.conductor.updateCheckHours * 3_600_000);
    assert.ok(first, 'uses the default interval');
    const uncleared = timers.filter((t) => !t.cleared).length;
    await post('/api/settings', { pollMinutes: 20 });
    assert.equal(timers.filter((t) => !t.cleared).length, uncleared, 'unrelated settings do not re-arm update timers');
    await post('/api/settings', { conductor: { updateCheckHours: 2.5 } });
    assert.equal(first.cleared, true);
    const second = timers.find((t) => t.ms === 2.5 * 3_600_000);
    assert.ok(second, 'uses the saved interval without restarting the server');
    await post('/api/settings', { conductor: { autoUpdate: 'off' } });
    assert.equal(second.cleared, true);
    assert.ok(timers.filter((t) => t.ms !== DEFAULTS.ui.detectMinutes * 60_000).every((t) => t.cleared));
    await post('/api/settings', { conductor: { autoUpdate: 'ask' } });
    assert.equal(timers.at(-1).ms, 2.5 * 3_600_000);
    stopBackgroundWork();
    assert.ok(timers.every((t) => t.cleared));
  } finally { process.env.CONDUCTOR_NO_POLL = '1'; stopBackgroundWork(); saveConfig(previous); }
});

test('changing the update cadence preserves startup and busy rechecks; off cancels them', async () => {
  const { DEFAULTS } = await import('../../core/config.mjs');
  const cfg = structuredClone(DEFAULTS), timers = [];
  const timer = (fn, ms) => { const t = { fn, ms, fired: false, cleared: false, unref() { return this; } }; timers.push(t); return t; };
  // Run the timer closure with no provider or git side effects.
  const src = readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8');
  const context = {
    loadConfig: () => cfg, process: { env: {} }, setInterval: timer, setTimeout: timer,
    clearInterval: (t) => { if (t) t.cleared = true; }, clearTimeout: (t) => { if (t) t.cleared = true; },
    conductor: { listSessions: () => [{ status: 'running' }] }, listTasks: () => [], lastActivity: Date.now(), isIdle,
    checkForUpdates: async () => ({ git: true, behind: 1 }), lastUpdateStatus: () => ({ git: true, behind: 1 }), logImprovement() {},
  };
  runInNewContext(src.slice(src.indexOf('let updateInterval ='), src.indexOf('\nfunction serveStatic')) + '\nglobalThis.start = startUpdateChecks;', context);
  context.start();
  const startup = timers.find((t) => t.ms === 3000);
  cfg.conductor.updateCheckHours = 2.5;
  context.start({ initial: false });
  assert.equal(startup.cleared, false);
  startup.fired = true; await startup.fn(); // auto policy notices the update but defers while a conductor turn is running
  const busy = timers.find((t) => t.ms === 60_000);
  assert.ok(busy);
  busy.fired = true; await busy.fn(); // busy recheck uses the already-known update instead of fetching again
  context.start({ initial: false });
  assert.equal(busy.cleared, false);
  cfg.conductor.autoUpdate = 'off';
  context.start({ initial: false });
  assert.ok(timers.filter((t) => !t.fired).every((t) => t.cleared));
});

test('auto-update defers relaunch when work starts during applyUpdate, then relaunches on idle recheck without a second pull', async () => {
  const { DEFAULTS } = await import('../../core/config.mjs');
  const cfg = structuredClone(DEFAULTS), timers = [];
  const timer = (fn, ms) => { const t = { fn, ms, fired: false, cleared: false, unref() { return this; } }; timers.push(t); return t; };
  let running = 0, applyCalls = 0, applyRelease, applying, relaunches = 0;
  const applyResult = { updated: true, from: 'aaa', to: 'bbb', commits: 1, npmInstalled: false, npmError: null, restartNeeded: true };
  const src = readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8');
  const context = {
    loadConfig: () => cfg, process: { env: {} }, setInterval: timer, setTimeout: timer,
    clearInterval: (t) => { if (t) t.cleared = true; }, clearTimeout: (t) => { if (t) t.cleared = true; },
    conductor: { listSessions: () => running ? [{ status: 'running' }] : [] }, listTasks: () => [], lastActivity: 0, isIdle,
    checkForUpdates: async () => ({ git: true, behind: 1, error: null, dirty: 0, ahead: 0 }),
    lastUpdateStatus: () => ({ git: true, behind: 1, error: null, dirty: 0, ahead: 0 }), logImprovement() {},
    applyUpdate: () => {
      applyCalls++;
      const p = new Promise((resolve) => { applyRelease = () => resolve(applyResult); });
      applying();
      return p;
    },
    scheduleRelaunch: () => { relaunches++; return true; },
    bus: { publish() {} },
  };
  runInNewContext(src.slice(src.indexOf('let updateInterval ='), src.indexOf('\nfunction serveStatic')) + '\nglobalThis.start = startUpdateChecks;', context);
  context.start();
  const startup = timers.find((t) => t.ms === 3000);
  const enteredApply = new Promise((resolve) => { applying = resolve; });
  const started = startup.fn();
  await enteredApply;
  assert.equal(applyCalls, 1);
  running = 1; // a chat starts while pull + npm install are in flight
  applyRelease();
  await started;
  assert.equal(relaunches, 0, 'no relaunch while busy after apply');
  const busy = timers.find((t) => t.ms === 60_000);
  assert.ok(busy, 'schedules the idle recheck');
  running = 0;
  await busy.fn();
  assert.equal(applyCalls, 1, 'no second pull');
  assert.equal(relaunches, 1, 'relaunches once idle');
});

test('stopped update checks do not pull or relaunch from an in-flight run', async () => {
  const { DEFAULTS } = await import('../../core/config.mjs');
  const src = readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8');
  const slice = src.slice(src.indexOf('let updateInterval ='), src.indexOf('\nfunction serveStatic')) + '\nglobalThis.start = startUpdateChecks;';
  const applyResult = { updated: true, from: 'aaa', to: 'bbb', commits: 1, npmInstalled: false, npmError: null, restartNeeded: true };
  const boot = (extra) => {
    const cfg = structuredClone(DEFAULTS), timers = [];
    const timer = (fn, ms) => { const t = { fn, ms, fired: false, cleared: false, unref() { return this; } }; timers.push(t); return t; };
    const context = {
      loadConfig: () => cfg, process: { env: {} }, setInterval: timer, setTimeout: timer,
      clearInterval: (t) => { if (t) t.cleared = true; }, clearTimeout: (t) => { if (t) t.cleared = true; },
      conductor: { listSessions: () => [] }, listTasks: () => [], lastActivity: 0, isIdle,
      lastUpdateStatus: () => ({ git: true, behind: 1, error: null, dirty: 0, ahead: 0 }), logImprovement() {},
      bus: { publish() {} },
      ...extra,
    };
    runInNewContext(slice, context);
    return { cfg, timers, context };
  };

  let applyCalls = 0, relaunches = 0, checkRelease, checking;
  const a = boot({
    checkForUpdates: () => {
      const p = new Promise((resolve) => { checkRelease = () => resolve({ git: true, behind: 1, error: null, dirty: 0, ahead: 0 }); });
      checking();
      return p;
    },
    applyUpdate: async () => { applyCalls++; return applyResult; },
    scheduleRelaunch: () => { relaunches++; return true; },
  });
  a.context.start();
  const enteredCheck = new Promise((resolve) => { checking = resolve; });
  const startedCheck = a.timers.find((t) => t.ms === 3000).fn();
  await enteredCheck;
  a.cfg.conductor.autoUpdate = 'off';
  a.context.start({ initial: false });
  checkRelease();
  await startedCheck;
  assert.equal(applyCalls, 0, 'does not pull after stop during check');
  assert.equal(relaunches, 0, 'does not relaunch after stop during check');

  applyCalls = 0; relaunches = 0;
  let applyRelease, applying;
  const b = boot({
    checkForUpdates: async () => ({ git: true, behind: 1, error: null, dirty: 0, ahead: 0 }),
    applyUpdate: () => {
      applyCalls++;
      const p = new Promise((resolve) => { applyRelease = () => resolve(applyResult); });
      applying();
      return p;
    },
    scheduleRelaunch: () => { relaunches++; return true; },
  });
  b.context.start();
  const enteredApply = new Promise((resolve) => { applying = resolve; });
  const startedApply = b.timers.find((t) => t.ms === 3000).fn();
  await enteredApply;
  b.cfg.conductor.autoUpdate = 'off';
  b.context.start({ initial: false });
  applyRelease();
  await startedApply;
  assert.equal(applyCalls, 1, 'in-flight pull already started');
  assert.equal(relaunches, 0, 'does not relaunch after stop during apply');
});

test('cross-site GET is 403 when sec-fetch-site is present and not same-origin/none', async () => {
  const port = new URL(url).port;
  const status = (headers) => new Promise((resolve, reject) => {
    const req = request(url + '/api/state', { headers }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await status({ 'sec-fetch-site': 'cross-site' }), 403);
  assert.equal(await status({ 'sec-fetch-site': 'same-origin' }), 200);
  assert.equal(await status({ 'sec-fetch-site': 'none' }), 200);
  assert.equal(await status({ Host: `127.0.0.1:${port}` }), 200);
  const unc = await fetch(url + '/api/browse?path=' + encodeURIComponent('//host/share'));
  assert.equal(unc.status, 400);
  const uncWin = await fetch(url + '/api/browse?path=' + encodeURIComponent('\\\\host\\share'));
  assert.equal(uncWin.status, 400);
});

test('session mode/effort/model routes and provider ids reject invalid enums with 400', async () => {
  const cwd = tmpDir('enums');
  const s = await post('/api/sessions', { cwd, model: 'sonnet', effort: 'low' });
  const send = (p, body) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await send(`/api/sessions/${s.id}/mode`, { permissionMode: 'bogus' })).status, 400);
  assert.equal((await send(`/api/sessions/${s.id}/effort`, { effort: 'ludicrous' })).status, 400);
  assert.equal((await send(`/api/sessions/${s.id}/model`, { model: 12 })).status, 400);
  assert.equal((await send(`/api/sessions/${s.id}/effort`, { effort: 'high' })).status, 200);
  assert.equal((await send('/api/providers/not-a-vendor/usage', { pct: 10 })).status, 400);
  assert.equal((await send('/api/providers/not-a-vendor/login', {})).status, 400);
  await fetch(url + `/api/sessions/${s.id}`, { method: 'DELETE' });
});

test('POST /api/tasks defaults parallelOverride and overflowApi from the session', async () => {
  const cwd = tmpDir('flags');
  const s = await post('/api/sessions', { cwd, parallelOverride: true, overflowApi: true });
  const t = await post('/api/tasks', { sessionId: s.id, cwd, spec: 'inherit flags' });
  assert.equal(t.parallelOverride, true);
  assert.equal(t.overflowApi, true);
  const off = await post('/api/sessions', { cwd, parallelOverride: false, overflowApi: false });
  const explicit = await post('/api/tasks', { sessionId: off.id, cwd, spec: 'explicit', parallelOverride: true, overflowApi: true });
  assert.equal(explicit.parallelOverride, true);
  assert.equal(explicit.overflowApi, true);
  await post(`/api/tasks/${t.id}/cancel`);
  await post(`/api/tasks/${explicit.id}/cancel`);
});

test('GET /api/scores returns only the text the UI reads', async () => {
  const sc = await get('/api/scores');
  assert.equal(typeof sc.text, 'string');
  assert.equal(sc.summary, undefined);
});

test('POST /api/ollama/pull is gone', async () => {
  const pull = await fetch(url + '/api/ollama/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(pull.status, 404);
});

test('relogin chains logout and login with ; on POSIX and & on Windows', () => {
  const src = readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /process\.platform === 'win32' \? '&' : ';'/);
});

test('/mcp/<session> JSON-RPC initialize, tools/list, tools/call', async () => {
  const cwd = tmpDir('mcp');
  const s = await post('/api/sessions', { cwd });
  const rpc = (method, params = {}, id = 1) => fetch(url + `/mcp/${s.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }).then((r) => r.json());
  const src = readFileSync(new URL('../../server/index.mjs', import.meta.url), 'utf8');
  assert.match(src, /maxBlockMs = \(\(loadConfig\(\)\.mcp\?\.toolTimeoutSec \?\? 3600\) - 60\) \* 1000/);
  const init = await rpc('initialize');
  assert.equal(init.result.serverInfo.name, 'conductor');
  const listed = await rpc('tools/list');
  assert.ok(listed.result.tools.some((t) => t.name === 'list_tasks'));
  const called = await rpc('tools/call', { name: 'list_tasks', arguments: {} });
  assert.equal(called.result.isError, false);
  assert.match(called.result.content[0].text, /no tasks yet/);
  const { toolsAsFunctions, conductorToolDefs } = await import('../../core/tools.mjs');
  const fns = toolsAsFunctions(conductorToolDefs({ sessionId: s.id, cwd }));
  assert.ok(fns.some((f) => f.def.name === 'list_tasks' && typeof f.impl === 'function'));
  assert.equal((await fetch(url + '/mcp/no-such-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' })).status, 404);
  await fetch(url + `/api/sessions/${s.id}`, { method: 'DELETE' });
});

test('POST /api/tasks accepts avoidFamilies (normalized)', async () => {
  const cwd = tmpDir('avoid');
  const t = await post('/api/tasks', { cwd, spec: 'review', avoidFamilies: ['Claude', 'grok', 'claude'] });
  assert.deepEqual(t.avoidFamilies, ['claude', 'grok']);
  await post(`/api/tasks/${t.id}/cancel`);
});
