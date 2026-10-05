import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS, git, mockCompletions, createTask, cancelTask, awaitTask, listTasks, schedule, flushRecords, tasksWithGit, tasksWithWorker } from './_helpers.mjs';

test('setup, journal and worker failures wake waiters and release scheduler slots', async () => {
  for (const t of listTasks()) cancelTask(t.id);
  const cwd = tmpDir('scheduler');
  const batch = Array.from({ length: 5 }, () => createTask({ cwd, provider: 'missing-test-provider' }));
  batch[0].cwd = 123; // Legacy journal entry: gitStatus throws before the worker starts.
  batch[1].paths = {}; // buildPrompt throws.
  batch[2].circular = batch[2]; // persist throws, including the failure write.
  const pending = batch.map((t) => awaitTask(t.id, 2000));
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    for (const t of await Promise.all(pending)) {
      assert.equal(t.status, 'failed');
      assert.ok(t.error);
      assert.ok(!t.timedOut);
      assert.equal(t.attempts, 1);
    }
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; delete batch[2].circular; }
});

test('dispatch is not serialized on git: two tasks are running before the first git read resolves', async (ctx) => {
  const { findCli } = await import('../../core/proc.mjs');
  if (!findCli('git')) { ctx.skip('git is not installed'); return; }
  const dirs = [tmpDir('inter-a'), tmpDir('inter-b')];
  for (const d of dirs) mkdirSync(join(d, '.git'));
  const reads = new Map();
  const calls = [];
  const tk = await tasksWithGit(ctx, async (_bin, args, { cwd }) => {
    calls.push({ cwd, args });
    if (args[0] === 'status' && !reads.has(cwd)) {
      const read = Promise.withResolvers();
      reads.set(cwd, read);
      await read.promise;
    }
    return { stdout: '' };
  });
  const worker = ctx.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] })));
  const lim = await import('../../core/limits.mjs'); delete lim.getLimits().providers.deepseek; // an earlier test may have left it blocked
  const batch = [];
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    for (const cwd of dirs) batch.push(tk.createTask({ cwd, provider: 'deepseek', spec: 'x' }));
    assert.deepEqual(batch.map((t) => t.status), ['running', 'running']);
    assert.equal(reads.size, dirs.length, 'both git reads started while neither had resolved');
    await new Promise(setImmediate); // the event loop progresses with both git reads still pending
    assert.equal(worker.mock.callCount(), 0, 'workers wait for their git snapshots');
    for (const read of reads.values()) read.resolve();
    for (const t of await Promise.all(batch.map((t) => tk.awaitTask(t.id)))) assert.equal(t.status, 'done');
    assert.equal(worker.mock.calls.filter((c) => String(c.arguments[0]).endsWith('/chat/completions')).length, dirs.length);
    for (const cwd of dirs) assert.deepEqual(calls.filter((c) => c.cwd === cwd).map((c) => c.args[0]), ['status', 'ls-tree', 'status']); // no observed changes: no diff needed
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    for (const read of reads.values()) read.resolve();
    tk.abortRunning();
    await Promise.all(batch.filter((t) => t.status === 'running').map((t) => tk.awaitTask(t.id)));
    for (const t of batch) tk.cancelTask(t.id);
    await tk.flushRecords();
  }
});

for (const scenario of ['exhausted', 'rejected', 'budget-disabled', 'expired', 'soft-sequential', 'soft-parallel']) {
  test(`scoped quotas on pinned tasks: ${scenario}`, async (ctx) => {
    const { getLimits, noteRateLimitEvent } = await import('../../core/limits.mjs');
    const { loadConfig, saveConfig } = await import('../../core/config.mjs');
    const original = getLimits().providers.claude;
    const conductor = loadConfig().conductor;
    const provider = PROVIDERS.claude;
    const finish = Promise.withResolvers();
    const calls = [];
    mockCompletions(ctx, async (_url, { body }) => {
      calls.push(JSON.parse(body).model);
      await finish.promise;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 });
    });
    const soft = scenario.startsWith('soft');
    const reset = Date.now() + (scenario === 'expired' ? -1 : 60_000);
    getLimits().providers.claude = { provider: 'claude', blocked: false, windows: [
      { id: 'five_hour', label: '5-hour', usedPercent: soft ? 96 : 40 },
      { id: 'seven_day_opus', label: 'weekly Opus', models: 'opus', usedPercent: soft ? 99 : 100, resetsAt: reset },
    ] };
    if (scenario === 'rejected') noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: reset });
    PROVIDERS.claude = { ...provider, kind: 'openai-compat', workerConfig: () => ({ baseUrl: 'https://offline.example/v1', apiKey: 'test-only' }), pollLimits: async () => getLimits().providers.claude };
    saveConfig({ conductor: { budgetGate: scenario !== 'budget-disabled' } });
    const batch = ['opus', 'opus', 'sonnet'].map((model) => createTask({ cwd: tmpDir('scoped-pinned'), provider: 'claude', model, spec: 'x', parallelOverride: scenario !== 'soft-sequential' }));
    try {
      delete process.env.CONDUCTOR_NO_SCHEDULE;
      schedule();
      const expected = scenario === 'soft-sequential' ? ['running', 'queued', 'queued'] : soft || scenario === 'expired' ? ['running', 'running', 'running'] : ['parked', 'parked', 'running'];
      assert.deepEqual(batch.map((t) => t.status), expected);
      for (const t of batch.filter((t) => t.status === 'parked')) { assert.equal(t.resumeAt, reset); assert.equal(t.attempts, 0); }
      process.env.CONDUCTOR_NO_SCHEDULE = '1';
      const active = batch.filter((t) => t.status === 'running');
      finish.resolve();
      for (const t of await Promise.all(active.map((t) => awaitTask(t.id)))) assert.equal(t.status, 'done');
      assert.deepEqual(calls.sort(), active.map((t) => t.model).sort());
    } finally {
      process.env.CONDUCTOR_NO_SCHEDULE = '1';
      finish.resolve();
      for (const t of batch) if (t.status === 'queued' || t.status === 'parked') cancelTask(t.id);
      await Promise.all(batch.map((t) => awaitTask(t.id)));
      await flushRecords();
      PROVIDERS.claude = provider;
      getLimits().providers.claude = original;
      saveConfig({ conductor });
    }
  });
}

for (const mode of ['session-reservation', 'weekly-reservation', 'probe', 'soft-sequential', 'fits']) {
  test(`completion retains budget ownership through a fresh poll and scoring: ${mode}`, async (ctx) => {
    const { getLimits, refreshLimits } = await import('../../core/limits.mjs');
    const { loadConfig, saveConfig } = await import('../../core/config.mjs');
    const { appendNdjson, statePath } = await import('../../core/paths.mjs');
    const { runRows } = await import('../../core/scorecard.mjs');
    for (const task of listTasks()) cancelTask(task.id);
    const conductor = loadConfig().conductor;
    saveConfig({ conductor: { maxWorkerConcurrency: 1, budgetGate: true } });
    const provider = `settling-${mode}`, model = 'test-model';
    const usage = (session, weekly) => ({ provider, blocked: false, windows: [
      { id: 'session', label: '5-hour', usedPercent: session },
      { id: 'weekly', label: 'weekly', usedPercent: weekly },
    ] });
    const initial = usage(mode === 'session-reservation' ? 80 : mode === 'soft-sequential' ? 96 : 0, mode === 'weekly-reservation' ? 85 : 0);
    const updated = usage(initial.windows[0].usedPercent + (mode === 'soft-sequential' ? 1 : 10), initial.windows[1].usedPercent + 10);
    getLimits().providers[provider] = initial;
    if (mode !== 'probe') appendNdjson(statePath('scorecard.ndjson'), {
      op: 'run', taskId: `seed-${provider}`, provider, model, pct: { session: 10, weekly: 10 }, concurrent: 0,
    });
    const oldPoll = Promise.withResolvers(), freshPoll = Promise.withResolvers(), freshEntered = Promise.withResolvers();
    let polls = 0;
    PROVIDERS[provider] = {
      id: provider, kind: 'openai-compat', workerConfig: () => ({ baseUrl: 'https://offline.example/v1', apiKey: 'test-only' }),
      pollLimits: () => {
        if (++polls === 1) return oldPoll.promise;
        if (polls === 2) { freshEntered.resolve(); return freshPoll.promise; }
        return updated;
      },
    };
    let calls = 0;
    const secondStarted = Promise.withResolvers(), secondFinish = Promise.withResolvers();
    mockCompletions(ctx, async () => {
      if (++calls === 2) {
        secondStarted.resolve(runRows().some((row) => row.taskId === first.id));
        await secondFinish.promise;
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 });
    });
    const stale = refreshLimits({ only: [provider] }); // already in flight before the worker finishes
    const cwd = tmpDir('settling');
    const first = createTask({ cwd, provider, model, spec: 'first' });
    let second, other;
    try {
      delete process.env.CONDUCTOR_NO_SCHEDULE;
      schedule();
      assert.equal((await awaitTask(first.id)).status, 'done', 'waiters do not wait for accounting');
      assert.equal(polls, 1);
      assert.ok(!runRows().some((row) => row.taskId === first.id));
      process.env.CONDUCTOR_NO_SCHEDULE = '1';
      second = createTask({ cwd, provider, model, spec: 'second' });
      if (mode !== 'fits') other = createTask({ cwd, provider: 'missing-test-provider', spec: 'other provider can use the slot' });
      delete process.env.CONDUCTOR_NO_SCHEDULE;
      schedule();
      assert.equal(second.status, mode === 'fits' ? 'running' : 'queued');
      if (other) assert.equal((await awaitTask(other.id)).status, 'failed', 'settling does not occupy maxWorkerConcurrency');
      if (mode === 'fits') assert.equal(await secondStarted.promise, false, 'remaining headroom permits dispatch while accounting settles');
      oldPoll.resolve(initial);
      await stale;
      await freshEntered.promise;
      assert.ok(!runRows().some((row) => row.taskId === first.id), 'a pre-completion poll cannot settle the score');
      assert.equal(second.status, mode === 'fits' ? 'running' : 'queued');
      freshPoll.resolve(updated);
      await flushRecords();
      assert.deepEqual(runRows().find((row) => row.taskId === first.id).pct, {
        session: updated.windows[0].usedPercent - initial.windows[0].usedPercent, weekly: 10,
      });
      if (mode !== 'fits') assert.equal(await secondStarted.promise, true, 'settlement reschedules only after recording the cost');
      secondFinish.resolve();
      assert.equal((await awaitTask(second.id)).status, 'done');
    } finally {
      process.env.CONDUCTOR_NO_SCHEDULE = '1';
      oldPoll.resolve(initial); freshPoll.resolve(updated); secondFinish.resolve();
      for (const task of [first, second, other].filter(Boolean)) cancelTask(task.id);
      await stale;
      await flushRecords();
      delete PROVIDERS[provider];
      delete getLimits().providers[provider];
      saveConfig({ conductor });
    }
  });
}

test('recorded concurrency divides global and model-exclusive window costs independently', async (ctx) => {
  const { getLimits } = await import('../../core/limits.mjs');
  const { runRows } = await import('../../core/scorecard.mjs');
  const { measuredCostByWindow } = await import('../../core/sweep.mjs');
  const previous = getLimits().providers.claude;
  const provider = PROVIDERS.claude;
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  let calls = 0;
  mockCompletions(ctx, async () => {
    if (++calls === batch.length) entered.resolve();
    await finish.promise;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] }), { status: 200 });
  });
  getLimits().providers.claude = { provider: 'claude', blocked: false, windows: [
    { id: 'five_hour', label: '5-hour', usedPercent: 10 },
    { id: 'seven_day', label: 'weekly', usedPercent: 10 },
    { id: 'seven_day_sonnet', label: 'weekly Sonnet', models: 'sonnet', usedPercent: 10 },
  ] };
  PROVIDERS.claude = { ...provider, kind: 'openai-compat', workerConfig: () => ({ baseUrl: 'https://offline.example/v1', apiKey: 'test-only' }), pollLimits: async () => getLimits().providers.claude };
  const batch = ['opus', 'sonnet', 'sonnet'].map((model) => createTask({ cwd: tmpDir('window-concurrency'), provider: 'claude', model, spec: 'x', parallelOverride: true }));
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    assert.deepEqual(batch.map((t) => t.status), ['running', 'running', 'running']);
    await entered.promise;
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    const windows = getLimits().providers.claude.windows;
    windows[0].usedPercent += 12; windows[1].usedPercent += 6; windows[2].usedPercent += 8;
    finish.resolve();
    for (const t of await Promise.all(batch.map((t) => awaitTask(t.id)))) assert.equal(t.status, 'done');
    await flushRecords();
    const rows = batch.map((t) => runRows().find((r) => r.taskId === t.id));
    assert.deepEqual(rows.map((r) => r.concurrentByWindow), [
      { five_hour: 0, seven_day: 0 },
      { five_hour: 1, seven_day: 1, seven_day_sonnet: 0 },
      { five_hour: 2, seven_day: 2, seven_day_sonnet: 1 },
    ]);
    assert.deepEqual(rows.map((r) => r.concurrent), [0, 1, 2]);
    assert.deepEqual(rows[1].pct, { five_hour: 12, seven_day: 6, seven_day_sonnet: 8 });
    assert.deepEqual(measuredCostByWindow([rows[0]], 'claude'), { five_hour: 12, seven_day: 6 });
    assert.deepEqual(measuredCostByWindow([rows[1]], 'claude'), { five_hour: 6, seven_day: 3, seven_day_sonnet: 8 });
    assert.deepEqual(measuredCostByWindow([rows[2]], 'claude'), { five_hour: 4, seven_day: 2, seven_day_sonnet: 4 });
    assert.deepEqual(measuredCostByWindow(rows, 'claude', { model: 'sonnet' }), { five_hour: 5, seven_day: 2.5, seven_day_sonnet: 6 });
    const { concurrentByWindow, ...legacy } = rows[1];
    assert.deepEqual(measuredCostByWindow([legacy], 'claude'), { five_hour: 6, seven_day: 3, seven_day_sonnet: 4 });
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    finish.resolve();
    await Promise.all(batch.map((t) => awaitTask(t.id)));
    await flushRecords();
    PROVIDERS.claude = provider;
    getLimits().providers.claude = previous;
  }
});

test('a worker run with timeout zero receives no timeoutMs', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const previous = loadConfig().worker;
  let input;
  const tk = await tasksWithWorker(ctx, async (t) => { input = t; return { ok: true, finalMessage: 'done' }; });
  saveConfig({ worker: { timeoutMinutes: 0, timeoutByCategory: {} } });
  try {
    const t = tk.createTask({ cwd: tmpDir('no-run-timeout'), provider: 'codex', parallelOverride: true });
    delete process.env.CONDUCTOR_NO_SCHEDULE; tk.schedule();
    assert.equal((await tk.awaitTask(t.id)).status, 'done');
    assert.equal(Object.hasOwn(input, 'timeoutMs'), false);
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; saveConfig({ worker: previous }); }
});

test('P1: one scheduling pass measures each provider/model once and the next pass remeasures', async (ctx) => {
  const { getLimits } = await import('../../core/limits.mjs');
  const { PROVIDERS } = await import('../../core/providers/index.mjs');
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const conductor = loadConfig().conductor;
  saveConfig({ conductor: { maxWorkerConcurrency: 3 } });
  ctx.after(() => saveConfig({ conductor }));
  PROVIDERS['w1-cost'] = { id: 'w1-cost' };
  getLimits().providers['w1-cost'] = { windows: [{ id: 'budget', usedPercent: 0 }, { id: 'weekly', usedPercent: 0 }] };
  ctx.after(() => { delete PROVIDERS['w1-cost']; delete getLimits().providers['w1-cost']; });
  const finish = Promise.withResolvers();
  const tk = await tasksWithWorker(ctx, () => finish.promise);
  const cwd = tmpDir('cost-cache');
  const batch = ['a', 'a', 'b'].map((model) => tk.createTask({ cwd, provider: 'w1-cost', model }));
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(batch.map((t) => t.status), ['running', 'queued', 'queued']);
    assert.deepEqual(globalThis.__w1Costs, [['w1-cost', { model: 'a', effort: 'medium', category: null, difficulty: null }]]);
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    finish.resolve({ ok: true, finalMessage: 'ok' });
    await tk.awaitTask(batch[0].id);
    await tk.flushRecords();
    globalThis.__w1Costs.length = 0;
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(globalThis.__w1Costs, [['w1-cost', { model: 'a', effort: 'medium', category: null, difficulty: null }], ['w1-cost', { model: 'b', effort: 'medium', category: null, difficulty: null }]], 'the measured model/cell and the next unmeasured model are each scanned once');
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    await tk.awaitTask(batch[1].id);
    await tk.flushRecords();
    globalThis.__w1Costs.length = 0;
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(globalThis.__w1Costs, [['w1-cost', { model: 'b', effort: 'medium', category: null, difficulty: null }]]);
    await tk.awaitTask(batch[2].id);
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; finish.resolve({ ok: true }); await tk.flushRecords(); }
});

test('P2: rate and null-percent windows do not serialize a provider behind a probe', async (ctx) => {
  const { getLimits } = await import('../../core/limits.mjs');
  const { PROVIDERS } = await import('../../core/providers/index.mjs');
  const finish = Promise.withResolvers();
  const tk = await tasksWithWorker(ctx, () => finish.promise);
  PROVIDERS['w1-rate'] = { id: 'w1-rate' };
  getLimits().providers['w1-rate'] = { windows: [{ id: 'requests', rate: true, usedPercent: 90 }, { id: 'unknown', usedPercent: null }] };
  const batch = ['one', 'two'].map((spec) => tk.createTask({ cwd: tmpDir('rate-probe'), provider: 'w1-rate', spec }));
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(batch.map((t) => t.status), ['running', 'running']);
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    finish.resolve({ ok: true, finalMessage: 'ok' });
    await Promise.all(batch.map((t) => tk.awaitTask(t.id)));
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; finish.resolve({ ok: true }); await tk.flushRecords(); delete PROVIDERS['w1-rate']; delete getLimits().providers['w1-rate']; }
});

test('RAM pressure arms one unrefed retry and starts queued work when headroom returns', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { setMemoryReader } = await import('../../core/resources.mjs');
  const resources = loadConfig().resources;
  let free = 10;
  const restoreMemory = setMemoryReader(() => ({ total: 100, free }));
  saveConfig({ resources: { maxRamPct: 85 } });
  const tk = await tasksWithWorker(ctx, async () => ({ ok: true, finalMessage: 'done' }));
  const t = tk.createTask({ cwd: tmpDir('ram-task'), provider: 'deepseek', model: 'deepseek-chat', spec: 'run when memory is available' }, { dispatch: false });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const retryTimers = [];
  ctx.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 30_000) {
      const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
      retryTimers.push({ callback: () => callback(...args), timer });
      return timer;
    }
    return originalSetTimeout(callback, delay, ...args);
  });
  ctx.mock.method(globalThis, 'clearTimeout', (timer) => {
    if (retryTimers.some((retry) => retry.timer === timer)) { timer.cleared = true; return; }
    return originalClearTimeout(timer);
  });
  const previous = process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.equal(tk.getTask(t.id).status, 'queued');
    assert.equal(tk.getTask(t.id).attempts, 0);
    tk.schedule();
    assert.equal(tk.getTask(t.id).status, 'queued', 'a held queue remains untouched on repeated passes');
    assert.equal(retryTimers.length, 1, 'held passes share one pending retry timer');
    assert.equal(retryTimers[0].timer.unrefCalled, true, 'the retry timer does not hold the process open');

    free = 90;
    retryTimers[0].callback();
    const done = await tk.awaitTask(t.id, 5000);
    assert.equal(done.status, 'done');
    assert.equal(done.attempts, 1);
  } finally {
    if (previous === undefined) process.env.CONDUCTOR_NO_SCHEDULE = '1'; else process.env.CONDUCTOR_NO_SCHEDULE = previous;
    tk.abortRunning();
    tk.cancelTask(t.id);
    restoreMemory();
    saveConfig({ resources });
  }
});

test('schedule wraps the pass in withLimitsSnapshot', () => {
  const src = readFileSync(new URL('../../core/tasks.mjs', import.meta.url), 'utf8');
  assert.match(src, /export function schedule\(\) \{[\s\S]*?withLimitsSnapshot\(/);
});
