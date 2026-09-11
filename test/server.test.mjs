import { tmpDir } from './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';

const { startServer } = await import('../server/index.mjs');
const { server, url } = await startServer({ port: 0 });
after(() => server.close());

const get = (p) => fetch(url + p).then((r) => r.json());
const post = (p, b) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());

test('static UI and state endpoint', async () => {
  const html = await fetch(url + '/').then((r) => r.text());
  assert.match(html, /Conductor 2\.0/);
  assert.equal((await fetch(url + '/../package.json')).status, 404);
  const st = await get('/api/state');
  assert.equal(st.version, '2.0.0');
  assert.ok(Array.isArray(st.providers) && st.providers.some((p) => p.id === 'codex'));
  assert.equal(st.config.providers.deepseek.apiKey, null);
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
  const { DEFAULTS } = await import('../core/config.mjs');
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
