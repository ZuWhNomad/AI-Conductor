import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, saveConfig } from '../core/config.mjs';
import { bus } from '../core/bus.mjs';
import { statePath, readJson, writeJson } from '../core/paths.mjs';
import { compactForNextTurn, compactHistory, contextWindowFor, recordLearnedContextWindow } from '../core/compaction.ts';

test('model windows honor override, learned ceiling, shipped data and fallback', () => {
  recordLearnedContextWindow('test', 'learned', 7654);
  assert.equal(contextWindowFor('test', 'learned'), 7654);
  assert.equal(contextWindowFor('test', 'learned', { models: { contextWindows: { 'test:learned': 4000 } } }), 4000);
  assert.equal(contextWindowFor('grok', 'grok-4.7'), 500000);
  assert.equal(contextWindowFor('unlisted', 'model'), 128000);
  assert.equal(contextWindowFor('unlisted', 'model', undefined, null), null);
  assert.equal(readJson(statePath('context-windows.json'))['test:learned'], 7654);
});

function longHistory(count = 12) {
  return [
    { role: 'system', content: 'system' },
    ...Array.from({ length: count }, (_, i) => [
      { role: 'user', content: `question ${i} ${'u'.repeat(900)}` },
      { role: 'assistant', content: `answer ${i} ${'a'.repeat(1100)}` },
    ]).flat(),
  ];
}

test('compaction cuts at user turns, keeps system first, digests deterministically and folds prior digests', () => {
  const history = longHistory(4);
  const first = compactHistory(history, 1700);
  assert.equal(first.compacted, true);
  assert.equal(first.messages[0].role, 'system');
  assert.equal(first.messages[1].role, 'user');
  assert.match(first.messages[1].content, /^\[Earlier conversation, compacted\]/);
  assert.match(first.messages[1].content, /- User: question 0/);
  assert.match(first.messages[1].content, /Assistant: answer 0/);
  assert.ok(first.messages.at(-2).role === 'user', 'retained history begins on a user boundary');
  const second = compactHistory(first.messages, 1200);
  assert.equal(second.compacted, true);
  assert.match(second.messages[1].content, /question 0/);
  assert.match(second.messages[1].content, /question 1/);
  assert.ok(second.afterTokens <= 1200);
});

test('size threshold and idle cache expiry select compaction reasons and land at compactTo', () => {
  const cfg = { conductor: { compactAt: 0.7, compactTo: 0.4, cacheLifetimes: { fixture: 10 } }, models: { contextWindows: { 'fixture:m': 10000 } } };
  const history = longHistory();
  const size = compactForNextTurn({ history, prompt: 'new', provider: 'fixture', model: 'm', lastPromptTokens: 7100, lastRequestAt: Date.now(), now: Date.now(), config: cfg });
  assert.equal(size.reason, 'size');
  assert.ok(size.afterTokens <= 4000);
  const idle = compactForNextTurn({ history, prompt: 'new', provider: 'fixture', model: 'm', lastPromptTokens: 5000, lastRequestAt: 1, now: 600002, config: cfg });
  assert.equal(idle.reason, 'idle');
  assert.ok(idle.afterTokens <= 4000);
});

test('worker context-length error learns the attempted prompt size', async (t) => {
  const { runOpenAICompat } = await import('../core/workers/openai-compat.mjs');
  t.mock.method(globalThis, 'fetch', async () => new Response('{"error":{"message":"context_length_exceeded"}}', { status: 400 }));
  const result = await runOpenAICompat({ id: 'context-error', cwd: HOME, prompt: 'too large', provider: 'fixture-error', model: 'm', baseUrl: 'https://fixture.invalid/v1' });
  assert.match(result.error, /context_length_exceeded/);
  assert.ok(result.lastRequestTokens > 0);
  assert.equal(contextWindowFor('fixture-error', 'm'), result.lastRequestTokens);
});

test('conductor mocked fetch requests append history between compaction points and emit digest on cut', async (t) => {
  const { createSession, sendMessage, deleteSession } = await import('../core/conductor.mjs');
  const before = loadConfig();
  saveConfig({ providers: { deepseek: { apiKey: 'test-key', baseUrl: 'https://fixture.invalid/v1' } }, models: { contextWindows: { 'deepseek:fixture-model': 20000 } }, conductor: { compactAt: 0.7, compactTo: 0.4 } });
  t.after(() => saveConfig(before));
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: `reply ${requests.length}` } }],
      usage: { prompt_tokens: 15000, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const session = createSession({ cwd: HOME, provider: 'deepseek', model: 'fixture-model' });
  t.after(() => deleteSession(session.id));
  const seq = bus.seq;
  const send = async (text) => {
    const done = new Promise((resolve) => {
      const h = (e) => { if (e.type === 'session' && e.sessionId === session.id && e.kind === 'status' && e.status === 'idle') { bus.off('event', h); resolve(); } };
      bus.on('event', h);
    });
    await sendMessage(session.id, text);
    await done;
  };
  await send('turn one');
  await send('turn two');
  await send('turn three');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages);
  assert.equal(requests[1].messages[0].role, 'system');
  assert.notDeepEqual(requests[2].messages.slice(0, requests[1].messages.length), requests[1].messages);
  assert.equal(requests[2].messages[0].role, 'system');
  assert.match(requests[2].messages[1].content, /^\[Earlier conversation, compacted\]/);
  assert.ok(bus.since(seq).some((e) => e.type === 'session' && e.sessionId === session.id && e.kind === 'compaction' && e.reason === 'size'));
});

test('conductor compacts after a context-length error and records the error reason', async (t) => {
  const { createSession, sendMessage, deleteSession } = await import('../core/conductor.mjs');
  const before = loadConfig();
  saveConfig({ providers: { deepseek: { apiKey: 'test-key', baseUrl: 'https://fixture.invalid/v1' } }, models: { contextWindows: { 'deepseek:error-model': 20000 } } });
  t.after(() => saveConfig(before));
  t.mock.method(globalThis, 'fetch', async () => new Response('{"error":{"message":"context_length_exceeded"}}', { status: 400 }));
  const session = createSession({ cwd: HOME, provider: 'deepseek', model: 'error-model' });
  t.after(() => deleteSession(session.id));
  writeJson(statePath('history', `${session.id}.loop.json`), [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'older question' }, { role: 'assistant', content: 'older answer' },
    { role: 'user', content: 'recent question' }, { role: 'assistant', content: 'recent answer' },
  ]);
  const seq = bus.seq;
  const done = new Promise((resolve) => {
    const h = (e) => { if (e.type === 'session' && e.sessionId === session.id && e.kind === 'status' && e.status === 'idle') { bus.off('event', h); resolve(); } };
    bus.on('event', h);
  });
  await sendMessage(session.id, 'failing turn');
  await done;
  assert.ok(readJson(statePath('context-windows.json'))['deepseek:error-model'] > 0);
  assert.ok(bus.since(seq).some((e) => e.type === 'session' && e.sessionId === session.id && e.kind === 'compaction' && e.reason === 'error'));
});

test('buildPrompt keeps shared preamble first and puts resume and title after stable instructions', async () => {
  const { buildPrompt } = await import('../core/tasks.mjs');
  const a = buildPrompt({ cwd: HOME, title: 'A', spec: 'SPEC', category: 'summarize', provider: 'deepseek', resume: false });
  const b = buildPrompt({ cwd: HOME, title: 'B', spec: 'SPEC', category: 'edit', provider: 'deepseek', resume: true });
  const stable = a.slice(0, a.indexOf('# Project context notes') >= 0 ? a.indexOf('# Project context notes') : a.indexOf('# Task'));
  assert.ok(b.startsWith(stable));
  assert.ok(a.indexOf('Remember to follow the MSW deletion rule') < a.indexOf('# Task'));
  assert.ok(b.indexOf('You were interrupted earlier') > b.indexOf('Remember to follow the MSW deletion rule'));
  assert.ok(b.indexOf('You were interrupted earlier') < b.indexOf('# Task'));
  assert.match(a, /# Task\n\nSPEC\n\nTitle: A/);
  const voteA = buildPrompt({ cwd: HOME, title: 'review: thing [1/2]', spec: 'same vote spec', category: 'review', provider: 'deepseek' });
  const voteB = buildPrompt({ cwd: HOME, title: 'review: thing [2/2]', spec: 'same vote spec', category: 'review', provider: 'deepseek' });
  assert.equal(voteA.slice(0, voteA.indexOf('Title: ')), voteB.slice(0, voteB.indexOf('Title: ')));
});

test('plan warm-up waits for first worker event; zero disables it', async () => {
  const { runPlan } = await import('../core/plans.mjs');
  const created = [];
  const runtime = {
    createTask(input) { const id = `warm-${created.length + 1}`; created.push(id); return { id }; },
    async awaitTask(id) { return { id, status: 'done', result: { finalMessage: 'ok' } }; },
    getTask() { return null; },
  };
  const pending = runPlan({ stages: [{ id: 's', tasks: [{ spec: 'one' }, { spec: 'two' }, { spec: 'three' }] }] }, { taskRuntime: runtime, warmupSeconds: 20 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(created, ['warm-1']);
  bus.publish('worker', { taskId: 'warm-1', event: 'item' });
  const result = await pending;
  assert.equal(result.status, 'done');
  assert.deepEqual(created, ['warm-1', 'warm-2', 'warm-3']);
  created.length = 0;
  const timeoutRun = runPlan({ stages: [{ id: 's', tasks: [{ spec: 'one' }, { spec: 'two' }, { spec: 'three' }] }] }, { taskRuntime: runtime, warmupSeconds: 0.01 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(created, ['warm-1']);
  await timeoutRun;
  assert.deepEqual(created, ['warm-1', 'warm-2', 'warm-3']);
  created.length = 0;
  await runPlan({ stages: [{ id: 's', tasks: [{ spec: 'one' }, { spec: 'two' }, { spec: 'three' }] }] }, { taskRuntime: runtime, warmupSeconds: 0 });
  assert.deepEqual(created, ['warm-1', 'warm-2', 'warm-3']);
  created.length = 0;
  await runPlan({ stages: [{ id: 's', tasks: [{ spec: 'one' }, { spec: 'two' }] }] }, { taskRuntime: runtime, warmupSeconds: 20 });
  assert.deepEqual(created, ['warm-1', 'warm-2']);
});
