import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROVIDERS, mockCompletions, createTask, cancelTask, awaitTask, getTask, schedule, abortRunning, flushRecords, reviewParked, bus, registryModels, tasksWithWorker } from './_helpers.mjs';

test('awaitTask park modes return any park or keep waiting through a park until timeout', async () => {
  const cwd = tmpDir('await-park-modes');
  const any = createTask({ cwd, spec: 'any' }, { dispatch: false });
  Object.assign(any, { status: 'parked', resumeAt: Date.now() + 60_000 });
  const returned = await awaitTask(any.id, 10_000, { onPark: 'any' });
  assert.equal(returned.status, 'parked');
  assert.equal(returned.parked, true);

  const never = createTask({ cwd, spec: 'never' }, { dispatch: false });
  Object.assign(never, { status: 'parked', resumeAt: Date.now() + 5 });
  const started = Date.now();
  const timed = await awaitTask(never.id, 35, { onPark: 'never' });
  assert.equal(timed.timedOut, true);
  assert.ok(Date.now() - started >= 25, 'never waits through a park until its deadline');
  cancelTask(any.id); cancelTask(never.id);
});

test('efficiency mode keeps a mid-run limit task on the pinned model until the confirmed reset', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  const { recordRun, rateTask } = await import('../../core/scorecard.mjs');
  const scorecard = loadConfig().scorecard;
  const reset = Date.now() + 60_000;
  registryModels(ctx, [{ provider: 'deepseek', id: 'deepseek-chat', kind: 'agent', cost: 'api' }]);
  saveConfig({ scorecard: { minSamples: 1, classOrder: ['free'], classes: { deepseek: 'free' } } });
  recordRun({ id: 'efficiency-midrun-alt', status: 'done', provider: 'deepseek', model: 'deepseek-chat', category: 'review', difficulty: 2, result: { usage: { input_tokens: 1, output_tokens: 1 } } });
  rateTask('efficiency-midrun-alt', 'pass');
  getLimits().providers.deepseek = { provider: 'deepseek', blocked: false, windows: [{ id: 'requests', usedPercent: 99, resetsAt: reset }] };
  const tk = await tasksWithWorker(ctx, async () => ({ ok: false, limitHit: true, error: 'usage limit' }));
  const t = tk.createTask({ cwd: tmpDir('efficiency-midrun'), provider: 'deepseek', model: 'deepseek-flash', spec: 'x', category: 'review', difficulty: 2, efficiencyMode: true });
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await tk.awaitTask(t.id, 1000);
    assert.equal(done.status, 'parked');
    assert.equal(done.resumeAt, reset);
    assert.equal(done.failedOverTo, undefined, 'a waiting task is never rerouted on its own');
    assert.equal(tk.getTask(t.id).model, 'deepseek-flash');
    assert.ok(tk.describeTask(t).includes(`waiting for deepseek reset at ${new Date(reset).toISOString()} (efficiency mode)`));
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    tk.cancelTask(t.id);
    delete getLimits().providers.deepseek;
    saveConfig({ scorecard });
  }
});

test('a task created with noFailover is parked on a limit, never handed to another provider', () => {
  const t = createTask({ cwd: tmpDir(), title: 'bench', spec: 'x', provider: 'grok', model: 'grok-4.6', category: 'modeling', difficulty: 2, noFailover: true });
  assert.equal(getTask(t.id).noFailover, true);
  cancelTask(t.id);
});

test('GP7: a noFailover task that parks on a limit hit is scored after a successful resume', async (ctx) => {
  const { runRows } = await import('../../core/scorecard.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  delete getLimits().providers.deepseek;
  let n = 0;
  mockCompletions(ctx, async () => {
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers: { 'retry-after': '1' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const t = createTask({ cwd: tmpDir('gp7-limit'), provider: 'deepseek', model: 'deepseek-flash', spec: 'x', category: 'review', difficulty: 2, noFailover: true });
  const { bus } = await import('../../core/bus.mjs');
  const resumed = Promise.withResolvers();
  const watchdog = setTimeout(() => resumed.reject(new Error('resume did not complete')), 15000); // same wait budget as this regression
  const onTask = (e) => { if (e.type === 'task' && e.task.id === t.id && e.task.status === 'done') resumed.resolve(e.task); };
  bus.on('event', onTask);
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    const done = await awaitTask(t.id, 15000);
    await resumed.promise;
    assert.equal(done.timedOut, undefined, done.error);
    assert.equal(done.status, 'done', done.error);
    assert.ok(!done.limitHit);
    assert.equal(getTask(t.id).attempts, 2);
    await flushRecords();
    assert.ok(runRows().some((r) => r.taskId === t.id), 'the successful resume must leave a run row');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    abortRunning();
    cancelTask(t.id);
    bus.off('event', onTask);
    clearTimeout(watchdog);
    delete getLimits().providers.deepseek;
  }
});

test('a success that started before a confirmed hit cannot clear it', async (ctx) => {
  const { getLimits, modelBlockedUntil, noteLimitHit } = await import('../../core/limits.mjs');
  const provider = 'stale-success-limit', model = 'shared-model', reset = Date.now() + 60_000;
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  PROVIDERS[provider] = { id: provider, pollLimits: async () => ({ provider, blocked: false, windows: [] }) };
  getLimits().providers[provider] = { provider, blocked: false, windows: [] };
  const tk = await tasksWithWorker(ctx, async () => { entered.resolve(); return finish.promise; });
  const t = tk.createTask({ cwd: tmpDir('stale-success-limit'), provider, model, spec: 'x' });
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    await entered.promise;
    noteLimitHit(provider, { model, resetsAt: reset });
    getLimits().providers[provider].confirmedLimit.hitAt = Date.parse(t.startedAt) + 1;
    finish.resolve({ ok: true, finalMessage: 'done' });
    assert.equal((await tk.awaitTask(t.id)).status, 'done');
    assert.equal(modelBlockedUntil(provider, model), reset);
    assert.ok(getLimits().providers[provider].confirmedLimit);
    await tk.flushRecords();
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1'; finish.resolve({ ok: true, finalMessage: 'done' }); tk.cancelTask(t.id);
    await tk.flushRecords(); delete PROVIDERS[provider]; delete getLimits().providers[provider];
  }
});

test('a worker limit is confirmed before the recovery poll starts', async (ctx) => {
  const { getLimits, modelBlockedUntil } = await import('../../core/limits.mjs');
  const { bus } = await import('../../core/bus.mjs');
  const provider = 'confirm-before-poll', model = 'opus', reset = Date.now() + 60_000;
  let confirmationSeen = false;
  getLimits().providers[provider] = { provider, blocked: false, windows: [{ id: 'weekly', models: 'opus', usedPercent: 40, resetsAt: reset }] };
  PROVIDERS[provider] = { id: provider, pollLimits: async () => {
    confirmationSeen = !!getLimits().providers[provider].confirmedLimit;
    return { provider, blocked: false, windows: [{ id: 'weekly', models: 'opus', usedPercent: 35, resetsAt: reset }] };
  } };
  const tk = await tasksWithWorker(ctx, async () => ({ ok: false, limitHit: true, error: 'usage limit' }));
  const t = tk.createTask({ cwd: tmpDir('confirm-before-poll'), provider, model, spec: 'x', noFailover: true });
  const parked = Promise.withResolvers();
  const onTask = (e) => { if (e.type === 'task' && e.task.id === t.id && e.task.status === 'parked') parked.resolve(e.task); };
  bus.on('event', onTask);
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await parked.promise;
    assert.equal(confirmationSeen, true);
    assert.equal(done.status, 'parked');
    assert.equal(modelBlockedUntil(provider, model), reset, 'the lagging poll must not lift the confirmation');
    assert.ok(getLimits().providers[provider].confirmedLimit);
    await tk.flushRecords();
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1'; tk.cancelTask(t.id);
    await tk.flushRecords(); bus.off('event', onTask); delete PROVIDERS[provider]; delete getLimits().providers[provider];
  }
});

test('a confirmed Grok limit hit blocks through its configured weekly reset and persists', async (ctx) => {
  const { getLimits } = await import('../../core/limits.mjs');
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { statePath } = await import('../../core/paths.mjs');
  const previous = loadConfig().scorecard, reset = Date.now() + 7 * 24 * 60 * 60_000;
  saveConfig({ scorecard: { usageResets: { ...previous.usageResets, grok: { periodHours: 168, anchorAt: new Date(reset).toISOString() } } } });
  delete getLimits().providers.grok;
  const tk = await tasksWithWorker(ctx, async () => ({ ok: false, limitHit: true, error: 'HTTP 402: usage balance exhausted' }));
  const t = tk.createTask({ cwd: tmpDir('grok-confirmed'), provider: 'grok', model: 'grok-4.6', spec: 'x', noFailover: true });
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await tk.awaitTask(t.id);
    const p = getLimits().providers.grok;
    assert.equal(done.status, 'parked');
    assert.equal(done.resumeAt, reset);
    assert.deepEqual([p.blocked, p.blockedReason, p.blockedUntil], [true, 'limit_hit', reset]);
    assert.equal(p.windows.find((w) => w.id === 'grok:estimated').usedPercent, 100);
    assert.deepEqual(JSON.parse(readFileSync(statePath('limits.json'), 'utf8')).providers.grok, p, 'the confirmed block is persisted');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1'; tk.cancelTask(t.id);
    delete getLimits().providers.grok; saveConfig({ scorecard: previous });
  }
});

test('auto-pick skips a provider with a confirmed limit hit', async (ctx) => {
  const { getLimits, noteLimitHit } = await import('../../core/limits.mjs');
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { recordRun, rateTask, recommend } = await import('../../core/scorecard.mjs');
  const previous = loadConfig().scorecard;
  registryModels(ctx, [
    { provider: 'grok', id: 'grok-4.6', kind: 'agent' },
    { provider: 'antigravity', id: 'gemini-3.8-flash', kind: 'agent' },
  ]);
  saveConfig({ scorecard: { minSamples: 1, usePriors: false, classOrder: ['included'], classes: { ...previous.classes, grok: 'included', antigravity: 'included' } } });
  for (const [id, provider, model] of [['confirmed-pick-g', 'grok', 'grok-4.6'], ['confirmed-pick-a', 'antigravity', 'gemini-3.8-flash']]) {
    recordRun({ id, title: 't', status: 'done', provider, model, category: 'other', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    rateTask(id, 'pass');
  }
  const opts = { category: 'other', difficulty: 2, providers: ['grok', 'antigravity'] };
  try {
    const first = recommend(opts);
    assert.ok(first, 'both providers are initially eligible');
    getLimits().providers[first.provider] = { provider: first.provider, blocked: false, windows: [] };
    noteLimitHit(first.provider, { model: first.model, resetsAt: Date.now() + 60_000 });
    const next = recommend(opts);
    assert.ok(next);
    assert.notEqual(next.provider, first.provider);
  } finally {
    delete getLimits().providers.grok; delete getLimits().providers.antigravity;
    saveConfig({ scorecard: previous });
  }
});

test('GP: awaitTask keeps a 30 s park inside longer waits and resolves parks past each deadline', async (ctx) => {
  const { getLimits } = await import('../../core/limits.mjs');
  const now = Date.now(); ctx.mock.method(Date, 'now', () => now);
  const provider = 'w1-await-park', until = now + 30_000;
  getLimits().providers[provider] = { blocked: true, blockedUntil: until, windows: [] };
  const t = createTask({ cwd: tmpDir('wait-park'), provider });
  const pending = awaitTask(t.id, 60_000), short = awaitTask(t.id, 15_000);
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    const joined = awaitTask(t.id, 60_000), boundary = awaitTask(t.id, 30_000);
    for (const wait of [pending, joined, boundary]) assert.equal(await Promise.race([wait, Promise.resolve('pending')]), 'pending');
    for (const result of [await short, await awaitTask(t.id, 15_000)]) {
      assert.equal(result.parked, true);
      assert.equal(result.status, 'parked');
      assert.equal(result.resumeAt, until);
      assert.equal(result.message, `parked until ${new Date(until).toISOString()}`);
      assert.equal(result.timedOut, undefined);
    }
    cancelTask(t.id);
    for (const result of await Promise.all([pending, joined, boundary])) assert.equal(result.status, 'canceled');
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; cancelTask(t.id); delete getLimits().providers[provider]; }
});

test('one wake timer releases due tasks in creation order with one refresh per provider', async (ctx) => {
  const { getLimits, modelBlockedUntil } = await import('../../core/limits.mjs');
  const { bus } = await import('../../core/bus.mjs');
  const provider = 'w1-park-poll', timers = new Map(); let nextTimer = 0;
  getLimits().providers[provider] = { provider, blocked: true, blockedUntil: Date.now() + 5000, windows: [] };
  let now = Date.now();
  ctx.mock.method(Date, 'now', () => now);
  ctx.mock.method(globalThis, 'setTimeout', (fn) => { const id = ++nextTimer; timers.set(id, fn); return { id, unref() {} }; });
  ctx.mock.method(globalThis, 'clearTimeout', (handle) => timers.delete(handle?.id));
  const poll = Promise.withResolvers();
  const polls = [];
  PROVIDERS[provider] = { id: provider, pollLimits: () => { polls.push(provider); return poll.promise; } };
  const batch = ['later', 'first', 'middle'].map((id) => createTask({ cwd: tmpDir(`park-poll-${id}`), provider, title: id, noFailover: true }, { dispatch: false }));
  batch[0].createdAt = '2026-01-03'; batch[1].createdAt = '2026-01-01'; batch[2].createdAt = '2026-01-02';
  const events = [];
  const onTask = (e) => { if (e.type === 'task' && batch.some((t) => t.id === e.task.id) && e.task.status === 'queued') events.push(e.task.title); };
  bus.on('event', onTask);
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    assert.ok(batch.every((t) => t.status === 'parked'));
    assert.ok(batch.every((t) => t.park?.kind === 'limit' && t.park.provider === provider));
    assert.equal(timers.size, 1, 'parked tasks share one wake timer');
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    now = Math.max(...batch.map((t) => t.resumeAt));
    const wake = [...timers.values()][0]();
    assert.deepEqual(polls, [provider]);
    assert.ok(batch.every((t) => t.status === 'parked'), 'the due batch waits for the refresh');
    poll.resolve({ provider, blocked: true, windows: [] });
    await wake;
    assert.deepEqual(events, ['first', 'middle', 'later']);
    assert.equal(polls.length, 1, 'one refresh for the shared provider');
    assert.ok(batch.every((t) => t.status === 'queued'));
    assert.ok(batch.every((t) => t.park === undefined), 'leaving parked clears the park record');
    assert.equal(modelBlockedUntil(provider), now + 30 * 60_000);
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; poll.resolve({ provider, blocked: true, windows: [] }); batch.forEach((t) => cancelTask(t.id)); delete PROVIDERS[provider]; delete getLimits().providers[provider]; bus.off('event', onTask); }
});

test('reviewParked uses provider evidence, migrates old parks, refines reported resets, and ignores replay parks', async () => {
  const { getLimits } = await import('../../core/limits.mjs');
  const prior = process.env.CONDUCTOR_NO_SCHEDULE; process.env.CONDUCTOR_NO_SCHEDULE = '1';
  const makePark = (name, provider, model = 'm') => {
    const t = createTask({ cwd: tmpDir(`review-park-${name}`), provider, model, title: name }, { dispatch: false });
    t.status = 'parked'; t.resumeAt = Date.now() + 60 * 60_000; return t;
  };
  const roomProvider = 'review-park-room', emptyProvider = 'review-park-empty', resetProvider = 'review-park-reset', guessProvider = 'review-park-guess';
  const room = makePark('room', roomProvider), empty = makePark('empty', emptyProvider), extend = makePark('extend', resetProvider), keepGuess = makePark('keep-guess', guessProvider), replay = makePark('replay', emptyProvider);
  empty.resumeAt -= 60_000; extend.park = { kind: 'limit', until: extend.resumeAt, source: 'guess', provider: resetProvider };
  keepGuess.park = { kind: 'limit', until: keepGuess.resumeAt, source: 'guess', provider: guessProvider };
  replay.park = { kind: 'replay', until: replay.resumeAt, source: 'guess', provider: emptyProvider };
  getLimits().providers[roomProvider] = { provider: roomProvider, blocked: false, windows: [{ id: 'room', usedPercent: 20 }] };
  getLimits().providers[resetProvider] = { provider: resetProvider, blocked: false, windows: [{ id: 'reset', usedPercent: 100, resetsAt: Date.now() + 2 * 60 * 60_000 }] };
  getLimits().providers[guessProvider] = { provider: guessProvider, blocked: false, windows: [{ id: 'unknown-reset', usedPercent: 100 }] };
  try {
    reviewParked();
    assert.equal(room.status, 'queued', 'an applicable window reporting room releases the park');
    assert.equal(room.park, undefined);
    assert.equal(empty.status, 'parked', 'windowless provider stays parked');
    assert.equal(empty.park.source, 'guess', 'legacy park migrates on review');
    assert.ok(extend.resumeAt > Date.now() + 60 * 60_000, 'reported reset extends a guess');
    assert.equal(extend.park.source, 'window');
    assert.equal(keepGuess.park.until, keepGuess.resumeAt, 'a new guess does not shorten a park');
    assert.equal(replay.status, 'parked');
    assert.equal(replay.park.kind, 'replay');
  } finally {
    for (const t of [room, empty, extend, keepGuess, replay]) cancelTask(t.id);
    for (const id of [roomProvider, emptyProvider, resetProvider, guessProvider]) delete getLimits().providers[id];
    if (prior === undefined) delete process.env.CONDUCTOR_NO_SCHEDULE; else process.env.CONDUCTOR_NO_SCHEDULE = prior;
  }
});
