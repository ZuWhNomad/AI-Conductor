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
