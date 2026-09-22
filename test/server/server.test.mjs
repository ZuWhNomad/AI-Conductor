import { tmpDir } from '../_env.mjs';
import { test, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
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
  ctx.mock.method(childProcess, 'execFileSync', (_command, args) => {
    assert.deepEqual(args, ['--version']);
    return 'test-version';
  });
  ctx.mock.method(childProcess, 'execSync', (command) => {
    assert.match(command, / --version$/);
    return 'test-version';
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
