import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';

const app = readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
const sse = app.slice(app.indexOf('// ---------- SSE ----------'), app.indexOf('function onSessionEvent('));
function client({ lastSeq = 10, boot = 'same', stateError = false } = {}) {
  const nodes = new Map(), streams = [], timers = [], gets = [], opened = [];
  const state = { seq: 3000, sessions: [], models: {}, limits: {}, tasks: [], improvements: [{ id: 'remaining' }], config: { ui: {} }, providers: [] };
  const S = { lastSeq, boot, current: { id: 'selected' }, improvements: [{}, {}, {}] };
  const context = {
    S, $: (selector) => { if (!nodes.has(selector)) nodes.set(selector, {}); return nodes.get(selector); },
    api: { get: async (path) => { gets.push(path); if (stateError) throw new Error('offline'); return state; } },
    EventSource: class {
      constructor(url) { this.url = url; this.handlers = new Map(); this.closed = false; streams.push(this); }
      addEventListener(type, fn) { this.handlers.set(type, fn); }
      close() { this.closed = true; }
    },
    setTimeout: (fn) => { timers.push(fn); }, clearTimeout() {}, clearInterval() {},
    renderSessions() {}, renderProviders() {}, renderBudget() {}, renderTasks() {}, renderUpdate() {}, onSessionEvent() {},
    openSession: async (id) => { opened.push(id); },
  };
  runInNewContext(sse + '\nconnect();', context);
  return { S, nodes, streams, timers, gets, opened, hello: (data) => streams[0].handlers.get('hello')({ data: JSON.stringify(data) }) };
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

const openSrc = app.slice(app.indexOf('async function openSession(id)'), app.indexOf('\nfunction clearCurrent()'));
const onSrc = app.slice(app.indexOf('function onSessionEvent(ev)'), app.indexOf('// ---------- modals ----------'));
function openingClient() {
  const el = { textContent: '', checked: false, focus() {}, classList: { remove() {} } };
  const pending = [], deltas = [];
  const S = { opening: null, bufferedEvents: null, current: null, sessions: [] };
  const context = {
    S, pending, deltas,
    api: { get: (path) => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); pending.push({ path, resolve, reject }); return promise; } },
    localStorage: { setItem() {}, getItem: () => null },
    document: { body: { classList: { remove() {} } } },
    $: () => el,
    refreshHeaderPicker() {}, renderChip() {}, renderBudget() {}, setStatus() {},
    renderHistory() {}, addPermission() {}, renderSessions() {}, renderTasks() {},
    refreshSessions() {}, clearCurrent() {}, addUser() {},
    addDelta(block, text) { deltas.push({ block, text }); },
    addAssistant() {}, addToolResult() {}, addResult() {}, addSys() {}, resolvePermission() {},
  };
  runInNewContext(openSrc + '\n' + onSrc, context);
  return { S, pending, deltas, openSession: (...a) => context.openSession(...a), onSessionEvent: (...a) => context.onSessionEvent(...a) };
}

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
});
