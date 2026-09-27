import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

const app = readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const sse = app.slice(app.indexOf('// ---------- SSE ----------'), app.indexOf('function onSessionEvent('));
function client({ lastSeq = 10, boot = 'same', stateError = false, failPath = null } = {}) {
  const nodes = new Map(), streams = [], timers = [], gets = [], opened = [];
  const state = { seq: 3000, sessions: [], models: {}, limits: {}, tasks: [], improvements: [{ id: 'remaining' }], config: { ui: {} }, providers: [] };
  const S = { lastSeq, boot, current: { id: 'selected' }, improvements: [{}, {}, {}] };
  const context = {
    S, $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); },
    api: { get: async (path) => { gets.push(path); if (stateError || path === failPath) throw new Error('offline'); return state; } },
    EventSource: class {
      constructor(url) { this.url = url; this.handlers = new Map(); this.closed = false; streams.push(this); }
      addEventListener(type, fn) { this.handlers.set(type, fn); }
      close() { this.closed = true; }
    },
    setTimeout: (fn) => { timers.push(fn); }, clearTimeout() {}, clearInterval() {},
    renderSessions() {}, renderProviders() {}, renderBudget() {}, renderTasks() {}, renderUpdate() {}, onSessionEvent() {}, seedNewChatDefaults() {},
    openSession: async (id) => { opened.push(id); },
  };
  runInNewContext(sse + '\nconnect();', context);
  return { S, nodes, streams, timers, gets, opened, hello: (data) => { state.boot = data.boot; streams[0].handlers.get('hello')({ data: JSON.stringify(data) }); }, event: (type, data) => streams[0].handlers.get(type)({ data: JSON.stringify(data) }) };
}

test('a same-boot replay gap refreshes state, transcript and improvement count before reconnecting', async () => {
  const c = client();
  c.hello({ boot: 'same', oldest: 12 });
  assert.equal(c.streams[0].closed, true);
  await nextTurn();
  assert.deepEqual(c.gets, ['/api/state']);
  assert.deepEqual(c.opened, ['selected']);
  assert.equal(c.nodes.get('#improve-count').textContent, 1);
  assert.equal(c.S.lastSeq, 3000);
  assert.equal(c.timers.length, 1);
  c.timers[0]();
  assert.equal(c.streams[1].url, '/api/events?since=3000');
});

test('hello keeps contiguous replays and zero cursors connected, and still recovers server restarts', async () => {
  for (const [lastSeq, oldest] of [[10, 11], [10, 1], [0, 100]]) {
    const c = client({ lastSeq });
    c.hello({ boot: 'same', oldest });
    assert.equal(c.streams[0].closed, false);
    assert.deepEqual(c.gets, []);
  }
  const c = client();
  c.hello({ boot: 'new', oldest: 1 });
  await nextTurn();
  assert.equal(c.streams[0].closed, true);
  assert.equal(c.S.boot, 'new');
  assert.deepEqual(c.gets, ['/api/state']);
  assert.equal(c.timers.length, 1);
});

test('a failed gap resync still reconnects with the previous cursor', async () => {
  const c = client({ stateError: true });
  c.hello({ boot: 'same', oldest: 12 });
  await nextTurn();
  assert.equal(c.timers.length, 1);
  c.timers[0]();
  assert.equal(c.streams[1].url, '/api/events?since=10');
});

test('a failed coalesced refetch runs a full resync after advancing the cursor', async () => {
  const c = client({ failPath: '/api/models' });
  c.event('models', { seq: 11 });
  assert.equal(c.S.lastSeq, 11);
  c.timers[0]();
  await nextTurn();
  assert.deepEqual(c.gets, ['/api/models', '/api/state']);
  assert.equal(c.S.lastSeq, 3000);
});

const openSrc = app.slice(app.indexOf('async function openSession(id)'), app.indexOf('\nfunction clearCurrent()'));
const onSrc = app.slice(app.indexOf('function onSessionEvent(ev)'), app.indexOf('// ---------- modals ----------'));
function openingClient() {
  const el = { textContent: '', checked: false, focus() {}, classList: { remove() {} } };
  const pending = [], deltas = [], permissions = [], renders = [];
  const S = { opening: null, bufferedEvents: null, current: null, sessions: [] };
  const context = {
    S, pending, deltas,
    api: { get: (path) => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); pending.push({ path, resolve, reject }); return promise; } },
    localStorage: { setItem() {}, getItem: () => null },
    document: { body: { classList: { remove() {} } } },
    $: () => el,
    refreshHeaderPicker() {}, renderChip() {}, renderBudget() {}, setStatus() {},
    renderHistory() {}, addPermission(req) { permissions.push(req); }, renderSessions() { renders.push('sessions'); }, renderTasks() {},
    refreshSessions() { throw new Error('session list refetched'); }, clearCurrent() {}, addUser() {},
    addDelta(block, text) { deltas.push({ block, text }); },
    addAssistant() {}, addToolResult() {}, addResult() {}, addSys() {}, resolvePermission() {},
  };
  runInNewContext(openSrc + '\n' + app.slice(app.indexOf('function upsertSession(s)'), app.indexOf('async function refreshSessions()')) + '\n' + onSrc, context);
  return { S, pending, deltas, permissions, renders, openSession: (...a) => context.openSession(...a), onSessionEvent: (...a) => context.onSessionEvent(...a) };
}

test('session events upsert and remove locally in updated order', () => {
  const c = openingClient();
  c.S.sessions = [{ id: 'old', updatedAt: '2026-01-01' }, { id: 'new', updatedAt: '2026-01-02' }];
  c.onSessionEvent({ kind: 'updated', sessionId: 'old', session: { id: 'old', updatedAt: '2026-01-03' } });
  c.onSessionEvent({ kind: 'created', sessionId: 'third', session: { id: 'third', updatedAt: '2026-01-04' } });
  c.onSessionEvent({ kind: 'deleted', sessionId: 'new' });
  assert.equal(c.S.sessions.map((s) => s.id).join(','), 'third,old');
  assert.equal(c.renders.length, 3);
});

test('new chat uses the POST response and restores its button state', async () => {
  const src = app.slice(app.indexOf('async function newSession()'), app.indexOf('// Slash commands'));
  const nodes = new Map([['#btn-new', { disabled: false, textContent: 'Start chat' }], ['#cwd', { value: '/project' }]]);
  let resolveCreate;
  const posts = [], opened = [], renders = [];
  const S = { sessions: [], config: { conductor: { provider: 'claude', model: null, effort: 'high' } } };
  const context = {
    S, $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, { checked: false }); return nodes.get(selector); },
    api: { post: (path) => { posts.push(path); return new Promise((resolve) => { resolveCreate = resolve; }); }, get: () => { throw new Error('unexpected GET'); } },
    localStorage: { setItem() {} }, pickerValue: () => ({ provider: 'claude', model: null, effort: 'high' }),
    renderSessions: () => renders.push('sessions'), openSession: async (id) => opened.push(id),
  };
  runInNewContext('let newSessionPromise = null;\n' + src, context);
  const pending = context.newSession();
  assert.equal(nodes.get('#btn-new').disabled, true);
  assert.equal(nodes.get('#btn-new').textContent, 'Starting…');
  resolveCreate({ id: 'created', updatedAt: '2026-01-01' });
  await pending;
  assert.equal(posts.join(','), '/api/sessions');
  assert.equal(S.sessions[0].id, 'created');
  assert.equal(renders.length, 1);
  assert.equal(opened.join(','), 'created');
  assert.equal(nodes.get('#btn-new').disabled, false);
  assert.equal(nodes.get('#btn-new').textContent, 'Start chat');
});

test('fleet orders open tasks before terminal tasks', () => {
  const src = app.slice(app.indexOf('function terminalTask(t)'), app.indexOf('function renderTasks()'));
  const S = { tasks: [{ id: 'finished', status: 'done' }, { id: 'active', status: 'parked' }] };
  const context = { S, inFleet: () => true };
  runInNewContext(src, context);
  assert.equal(context.myTasks().map((t) => t.id).join(','), 'active,finished');
});

test('concurrent openSession of the same id keeps the buffer and applies only the latest response', async () => {
  const c = openingClient();
  const first = c.openSession('s1');
  assert.equal(c.pending.length, 1);
  c.onSessionEvent({ sessionId: 's1', seq: 5, kind: 'delta', block: 0, text: 'a' });
  assert.equal(c.S.bufferedEvents.length, 1);
  const second = c.openSession('s1');
  assert.equal(c.pending.length, 2);
  assert.equal(c.S.bufferedEvents.length, 1, 'same-id reopen must not drop buffered events');
  c.onSessionEvent({ sessionId: 's1', seq: 6, kind: 'delta', block: 0, text: 'b' });
  assert.equal(c.S.bufferedEvents.length, 2);
  c.pending[0].resolve({ id: 's1', seq: 4, title: 'first', cwd: '/x', messages: [], pending: [] });
  await first;
  assert.equal(c.S.current, null);
  assert.ok(c.S.opening);
  c.pending[1].resolve({ id: 's1', seq: 4, title: 'second', cwd: '/x', messages: [], pending: [] });
  await second;
  assert.equal(c.S.current.title, 'second');
  assert.equal(c.S.opening, null);
  assert.deepEqual(c.deltas.map((d) => d.text), ['a', 'b']);
});

test('openSession error on the latest call clears opening state', async () => {
  const c = openingClient();
  const p = c.openSession('s1');
  c.pending[0].reject(new Error('offline'));
  await assert.rejects(p, /offline/);
  assert.equal(c.S.opening, null);
  assert.equal(c.S.bufferedEvents, null);

  const d = openingClient();
  d.S.current = { id: 's1' };
  const p2 = d.openSession('s1');
  d.onSessionEvent({ sessionId: 's1', seq: 8, kind: 'permission', request: { id: 'r1', toolName: 'bash', input: {} } });
  assert.equal(d.permissions.length, 0, 'permission is buffered while the reopen is in flight');
  d.pending[0].reject(new Error('offline'));
  await assert.rejects(p2, /offline/);
  assert.equal(d.S.opening, null);
  assert.equal(d.S.bufferedEvents, null);
  assert.equal(d.permissions.length, 1, 'buffered permission still renders when the current session reopen fails');
  assert.equal(d.permissions[0].id, 'r1');
});
