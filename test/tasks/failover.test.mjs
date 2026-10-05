import { HOME, tmpDir } from '../_env.mjs';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS, git, mockCompletions, createTask, cancelTask, failHungTask, awaitTask, getTask, listTasks, describeTask, schedule, abortRunning, bus, waitForTaskStatus, waitForLocalTaskStatus, registryModels, tasksWithWorker } from './_helpers.mjs';

// The provider-limit and access-gate tests record a deepseek 429 and leave it. In the single file a later test deleted that block before the next failover.
beforeEach(async () => {
  const { getLimits } = await import('../../core/limits.mjs');
  delete getLimits().providers.deepseek;
});

test('awaitTask follows failedOverTo without resetting its deadline and identifies the prior task', async (ctx) => {
  const timers = [];
  ctx.mock.method(globalThis, 'setTimeout', (fn, ms) => { timers.push({ fn, ms }); return {}; });
  const cwd = tmpDir('await-failover');
  const original = createTask({ cwd, spec: 'original' }, { dispatch: false });
  const target = createTask({ cwd, spec: 'replacement' }, { dispatch: false });
  original.failedOverTo = target.id;
  const pending = awaitTask(original.id, 1000);
  assert.equal(timers.length, 1);
  failHungTask(original.id, 'fixture failover'); // wake the waiter on the original, which follows the replacement
  assert.equal(timers.length, 1, 'following the target keeps the original timer');
  timers[0].fn();
  const result = await pending;
  assert.equal(result.id, target.id);
  assert.equal(result.status, 'queued');
  assert.equal(result.timedOut, true);
  assert.equal(result.followedFrom, original.id);
  cancelTask(target.id);
});

test('a provider limit mid-task fails over to the next qualified provider as a retry chain and is not scored', async (ctx) => {
  const { saveConfig } = await import('../../core/config.mjs');
  const { recordRun, rateTask, rootRuns } = await import('../../core/scorecard.mjs');
  registryModels(ctx, [{ provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent', cost: 'subscription', efforts: ['low'] }]);
  saveConfig({ providers: { deepseek: { apiKey: 'test-key' } }, scorecard: { minSamples: 1, classes: { deepseek: 'free' } } });
  for (let i = 0; i < 2; i++) { const id = `fo${i}`; recordRun({ id, title: 't', status: 'done', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } }); rateTask(id, 'pass'); }
  mockCompletions(ctx, async () => {
    // Verify the retry is queued, without dispatching its DeepSeek worker into live detection.
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers: { 'retry-after': '60' } });
  });
  const cwd = tmpDir('failover');
  const originalId = 'quality-original';
  const t = createTask({ sessionId: 'fo', cwd, title: 'review it', spec: 'x', provider: 'deepseek', model: 'deepseek-flash', category: 'review', difficulty: 2, retryOf: originalId, sandbox: 'read-only', parallelOverride: true, overflowApi: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  let done;
  try {
    schedule(); done = await waitForTaskStatus(t.id, ['failed']);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /failed over to task/);
    const next = getTask(done.failedOverTo);
    assert.equal(next.status, 'queued');
    assert.equal(next.provider, 'codex');
    assert.equal(next.model, 'gpt-5.6-luna');
    assert.equal(next.retryOf, originalId);
    assert.equal(next.reroutedFrom, t.id);
    assert.equal(t.failedOverTo, next.id);
    assert.equal(next.spec, 'Note: another worker was stopped by a usage limit part-way through this task and may have left edits in the working tree. Check the current state (git status / diff) first; do not redo finished work.\nx');
    assert.equal(next.sandbox, 'read-only');
    assert.equal(next.parallelOverride, true);
    assert.equal(next.overflowApi, true);
    assert.match(describeTask(getTask(t.id)), /Failed over to task/);
    assert.ok(!rootRuns().some((c) => c.attempts.some((a) => a.taskId === t.id)), 'the cut-off attempt is not in the ledger');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    if (t.failedOverTo) cancelTask(t.failedOverTo);
    cancelTask(t.id);
    saveConfig({ scorecard: { minSamples: 3 } });
  }
});

test('an auto-picked Antigravity Claude task fails over to Gemini, outside the exhausted quota group', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { getLimits, save: saveLimits } = await import('../../core/limits.mjs');
  const { recordRun, rateTask, recommend } = await import('../../core/scorecard.mjs');
  const models = [
    { provider: 'antigravity', id: 'claude-sonnet-4-6', kind: 'agent', efforts: [] },
    { provider: 'antigravity', id: 'claude-opus-4-6', kind: 'agent', efforts: [] },
    { provider: 'antigravity', id: 'gemini-3.8-flash', kind: 'agent', efforts: [] },
  ];
  registryModels(ctx, models);
  const scorecard = loadConfig().scorecard;
  saveConfig({ scorecard: { minSamples: 1, usePriors: false, classOrder: ['included'] } });
  for (const m of models) {
    const id = `agy-seed-${m.id}`;
    recordRun({ id, title: 'seed', status: 'done', provider: m.provider, model: m.id, effort: null, category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    rateTask(id, 'pass');
  }
  const reset = Date.now() + 60_000;
  const windows = [
    { id: 'claude-five-hour', label: '5-hour Claude', models: '^claude-', usedPercent: 10, resetsAt: reset },
    { id: 'gemini-five-hour', label: '5-hour Gemini', models: '^gemini-', usedPercent: 10, resetsAt: reset },
  ];
  delete getLimits().providers.antigravity;
  getLimits().providers.antigravity = { provider: 'antigravity', blocked: false, windows };
  saveLimits(false);
  ctx.mock.method(PROVIDERS.antigravity, 'pollLimits', async () => ({ provider: 'antigravity', blocked: false, windows }));
  const picked = recommend({ category: 'review', difficulty: 2, providers: ['antigravity'], exclude: ['antigravity:gemini-3.8-flash'] });
  assert.equal(picked?.provider, 'antigravity');
  assert.ok(picked.model.startsWith('claude-'), 'initial auto-pick is Claude on Antigravity');
  const tk = await tasksWithWorker(ctx, async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return { ok: false, limitHit: true, error: 'usage limit' };
  });
  const t = tk.createTask({ sessionId: 'agy-same-group', cwd: tmpDir('agy-same-group'), spec: 'x', provider: picked.provider, model: picked.model, effort: picked.effort, category: 'review', difficulty: 2, parallelOverride: true });
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await waitForLocalTaskStatus(tk, t.id, ['failed']);
    const next = tk.getTask(done.failedOverTo);
    assert.equal(done.status, 'failed');
    assert.equal(next?.provider, 'antigravity');
    assert.equal(next?.model, 'gemini-3.8-flash');
    assert.ok(!models.filter((m) => m.id.startsWith('claude-')).some((m) => m.id === next.model), 'models in the failed Claude window group are excluded');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    if (t.failedOverTo) tk.cancelTask(t.failedOverTo);
    tk.cancelTask(t.id);
    await tk.flushRecords();
    delete getLimits().providers.antigravity;
    saveLimits(false);
    saveConfig({ scorecard });
  }
});

test('a Claude five-hour group shared by all Claude models fails over to another provider', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { getLimits, save: saveLimits } = await import('../../core/limits.mjs');
  const { recordRun, rateTask, recommend } = await import('../../core/scorecard.mjs');
  const models = [
    { provider: 'claude', id: 'claude-opus-5-5', kind: 'agent', efforts: [] },
    { provider: 'claude', id: 'claude-sonnet-5', kind: 'agent', efforts: [] },
    { provider: 'deepseek', id: 'deepseek-chat', kind: 'agent', cost: 'api', efforts: [] },
  ];
  registryModels(ctx, models);
  const scorecard = loadConfig().scorecard;
  saveConfig({ scorecard: { minSamples: 1, usePriors: false, classOrder: ['free', 'conductor'], classes: { deepseek: 'free' } } });
  for (const m of models) {
    const id = `claude-group-seed-${m.provider}-${m.id}`;
    recordRun({ id, title: 'seed', status: 'done', provider: m.provider, model: m.id, effort: null, category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    rateTask(id, 'pass');
  }
  const reset = Date.now() + 60_000;
  const windows = [{ id: 'five_hour', label: '5-hour', usedPercent: 10, resetsAt: reset }];
  delete getLimits().providers.claude;
  getLimits().providers.claude = { provider: 'claude', blocked: false, windows };
  saveLimits(false);
  ctx.mock.method(PROVIDERS.claude, 'pollLimits', async () => ({ provider: 'claude', blocked: false, windows }));
  const picked = recommend({ category: 'review', difficulty: 2, providers: ['claude'] });
  assert.equal(picked?.provider, 'claude');
  const tk = await tasksWithWorker(ctx, async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return { ok: false, limitHit: true, error: 'usage limit' };
  });
  const t = tk.createTask({ sessionId: 'claude-shared-group', cwd: tmpDir('claude-shared-group'), spec: 'x', provider: picked.provider, model: picked.model, category: 'review', difficulty: 2, parallelOverride: true });
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await waitForLocalTaskStatus(tk, t.id, ['failed']);
    const next = tk.getTask(done.failedOverTo);
    assert.equal(done.status, 'failed');
    assert.equal(next?.provider, 'deepseek');
    assert.equal(next?.model, 'deepseek-chat');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    if (t.failedOverTo) tk.cancelTask(t.failedOverTo);
    tk.cancelTask(t.id);
    await tk.flushRecords();
    delete getLimits().providers.claude;
    saveLimits(false);
    saveConfig({ scorecard });
  }
});

test('Codex failover to another model resolves that model’s configured sandbox', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { getLimits, save: saveLimits } = await import('../../core/limits.mjs');
  const { recordRun, rateTask } = await import('../../core/scorecard.mjs');
  const models = [
    { provider: 'codex', id: 'gpt-5.6-sol', kind: 'agent', efforts: [] },
    { provider: 'codex', id: 'gpt-6-astra', kind: 'agent', efforts: [] },
  ];
  registryModels(ctx, models);
  const previous = loadConfig();
  saveConfig({
    scorecard: { minSamples: 1, usePriors: false, classOrder: ['subscription'] },
    worker: { codexSandboxByModel: { 'gpt-5.6-sol': 'workspace-write', 'gpt-6-astra': 'danger-full-access' } },
  });
  for (const m of models) {
    const id = `codex-sandbox-seed-${m.id}`;
    recordRun({ id, title: 'seed', status: 'done', provider: m.provider, model: m.id, effort: null, category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    rateTask(id, 'pass');
  }
  const reset = Date.now() + 60_000;
  const windows = [
    { id: 'sol-quota', label: '5-hour sol', models: 'gpt-5[.]6-sol', usedPercent: 10, resetsAt: reset },
    { id: 'astra-quota', label: '5-hour astra', models: 'gpt-6-astra', usedPercent: 10, resetsAt: reset },
  ];
  delete getLimits().providers.codex;
  getLimits().providers.codex = { provider: 'codex', blocked: false, windows };
  saveLimits(false);
  ctx.mock.method(PROVIDERS.codex, 'pollLimits', async () => ({ provider: 'codex', blocked: false, windows }));
  const tk = await tasksWithWorker(ctx, async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return { ok: false, limitHit: true, error: 'usage limit' };
  });
  const t = tk.createTask({ sessionId: 'codex-sandbox', cwd: tmpDir('codex-sandbox'), spec: 'x', provider: 'codex', model: 'gpt-5.6-sol', category: 'review', difficulty: 2, parallelOverride: true });
  assert.equal(t.sandbox, 'workspace-write');
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await waitForLocalTaskStatus(tk, t.id, ['failed']);
    const next = tk.getTask(done.failedOverTo);
    assert.equal(done.status, 'failed');
    assert.equal(next?.provider, 'codex');
    assert.equal(next?.model, 'gpt-6-astra');
    assert.equal(next?.sandbox, 'danger-full-access');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    if (t.failedOverTo) tk.cancelTask(t.failedOverTo);
    tk.cancelTask(t.id);
    await tk.flushRecords();
    delete getLimits().providers.codex;
    saveLimits(false);
    saveConfig({ scorecard: previous.scorecard, worker: previous.worker });
  }
});

test('a read-only task keeps its sandbox when it fails over to Codex', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { getLimits, save: saveLimits } = await import('../../core/limits.mjs');
  const { recordRun, rateTask } = await import('../../core/scorecard.mjs');
  const models = [
    { provider: 'antigravity', id: 'claude-sonnet-4-6', kind: 'agent', efforts: [] },
    { provider: 'codex', id: 'gpt-6-astra', kind: 'agent', efforts: [] },
  ];
  registryModels(ctx, models);
  const previous = loadConfig();
  saveConfig({
    scorecard: { minSamples: 1, usePriors: false, classOrder: ['included', 'subscription'] },
    worker: { codexSandboxByModel: { 'gpt-6-astra': 'danger-full-access' } },
  });
  for (const m of models) {
    const id = `readonly-codex-seed-${m.provider}-${m.id}`;
    recordRun({ id, title: 'seed', status: 'done', provider: m.provider, model: m.id, effort: null, category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    rateTask(id, 'pass');
  }
  const reset = Date.now() + 60_000;
  const windows = [{ id: 'claude-five-hour', label: '5-hour Claude', models: '^claude-', usedPercent: 10, resetsAt: reset }];
  delete getLimits().providers.antigravity;
  getLimits().providers.antigravity = { provider: 'antigravity', blocked: false, windows };
  saveLimits(false);
  ctx.mock.method(PROVIDERS.antigravity, 'pollLimits', async () => ({ provider: 'antigravity', blocked: false, windows }));
  const tk = await tasksWithWorker(ctx, async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return { ok: false, limitHit: true, error: 'usage limit' };
  });
  const t = tk.createTask({ sessionId: 'readonly-codex', cwd: tmpDir('readonly-codex'), spec: 'review x', provider: 'antigravity', model: 'claude-sonnet-4-6', category: 'review', difficulty: 2, sandbox: 'read-only', parallelOverride: true });
  try {
    assert.equal(t.sandbox, 'read-only');
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await waitForLocalTaskStatus(tk, t.id, ['failed']);
    const next = tk.getTask(done.failedOverTo);
    assert.equal(done.status, 'failed');
    assert.equal(next?.provider, 'codex');
    assert.equal(next?.model, 'gpt-6-astra');
    assert.equal(next?.sandbox, 'read-only');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    if (t.failedOverTo) tk.cancelTask(t.failedOverTo);
    tk.cancelTask(t.id);
    await tk.flushRecords();
    delete getLimits().providers.antigravity;
    saveLimits(false);
    saveConfig({ scorecard: previous.scorecard, worker: previous.worker });
  }
});

for (const action of ['cancel', 'shutdown']) for (const noFailover of [false, true]) {
  test(`${action} during quota refresh prevents ${noFailover ? 'parking' : 'failover'}`, async (ctx) => {
    const { loadConfig, saveConfig } = await import('../../core/config.mjs');
    const { getLimits } = await import('../../core/limits.mjs');
    const { bus } = await import('../../core/bus.mjs');
    const scorecard = loadConfig().scorecard;
    saveConfig({ scorecard: { minSamples: 1, classes: { deepseek: 'free' } } });
    delete getLimits().providers.deepseek;
    const entered = Promise.withResolvers(), refresh = Promise.withResolvers(), finished = Promise.withResolvers();
    ctx.mock.method(PROVIDERS.deepseek, 'pollLimits', () => { entered.resolve(); return refresh.promise; });
    mockCompletions(ctx, async () => {
      process.env.CONDUCTOR_NO_SCHEDULE = '1';
      return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429 });
    });
    const cwd = tmpDir('refresh-race');
    const t = createTask({ sessionId: cwd, cwd, provider: 'deepseek', model: 'deepseek-flash', category: 'review', difficulty: 2, noFailover });
    const onEvent = (e) => { if (e.type === 'task' && e.task.id === t.id && e.task.finishedAt) finished.resolve(e.task); };
    bus.on('event', onEvent);
    try {
      delete process.env.CONDUCTOR_NO_SCHEDULE;
      schedule();
      await entered.promise;
      assert.equal(t.status, 'running');
      if (action === 'cancel') cancelTask(t.id);
      else abortRunning({ requeue: true });
      refresh.resolve({ provider: 'deepseek', windows: [], blocked: false });
      const done = await finished.promise; // cancellation wakes awaitTask before run() has actually settled
      assert.equal(done.status, action === 'cancel' ? 'canceled' : 'queued');
      assert.equal(done.failedOverTo, undefined);
      assert.equal(done.resumeAt, null);
      assert.equal(listTasks({ sessionId: cwd }).length, 1, 'no replacement was created');
      if (action === 'shutdown') { assert.equal(done.resume, true); assert.match(done.error, /shutdown/); }
      else assert.equal(done.error, 'canceled');
    } finally {
      process.env.CONDUCTOR_NO_SCHEDULE = '1';
      refresh.resolve({ provider: 'deepseek', windows: [], blocked: false });
      bus.off('event', onEvent);
      abortRunning();
      if (t.failedOverTo) cancelTask(t.failedOverTo);
      cancelTask(t.id);
      saveConfig({ scorecard });
      delete getLimits().providers.deepseek;
    }
  });
}

test('failover passes the access-gate provider restriction intersected with the excluded provider', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { recordRun, rateTask, recommend } = await import('../../core/scorecard.mjs');
  registryModels(ctx, [
    { provider: 'deepseek', id: 'deepseek-chat', kind: 'agent', cost: 'api' },
    { provider: 'grok', id: 'grok-4.6', kind: 'agent' },
  ]);
  const scorecard = loadConfig().scorecard;
  const tools = loadConfig().tools;
  saveConfig({
    scorecard: { minSamples: 1, classes: { deepseek: 'free' } },
    tools: { index: { og4_gate: { kind: 'access', match: ['og4-gate.test/'], providers: ['grok'] } } },
  });
  for (const [id, provider, model] of [['og4o', 'deepseek', 'deepseek-chat'], ['og4g', 'grok', 'grok-4.6']]) {
    recordRun({ id, title: 't', status: 'done', provider, model, effort: null, category: 'search', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    rateTask(id, 'pass');
  }
  mockCompletions(ctx, async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers: { 'retry-after': '60' } });
  });
  const cwd = tmpDir('og4-failover');
  const t = createTask({ cwd, provider: 'deepseek', model: 'deepseek-flash', title: 'read', spec: 'fetch og4-gate.test/page', category: 'search', difficulty: 2, overflowApi: true });
  try {
    assert.equal(recommend({ category: 'search', difficulty: 2, overflowApi: true }).provider, 'deepseek', 'without the gate, free-local would win');
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    const done = await waitForTaskStatus(t.id, ['failed']);
    assert.equal(done.status, 'failed');
    assert.equal(getTask(done.failedOverTo)?.provider, 'grok');
    assert.equal(getTask(done.failedOverTo)?.model, 'grok-4.6');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    if (t.failedOverTo) cancelTask(t.failedOverTo);
    cancelTask(t.id);
    saveConfig({ scorecard, tools });
  }
});

for (const scenario of [
  { name: 'default failover', global: false, remaining: 60_000, failover: true },
  { name: 'global efficiency wait', global: true, remaining: 60_000, failover: false },
  { name: 'per-task wait override', global: false, task: true, remaining: 60_000, failover: false },
  { name: 'per-task failover override', global: true, task: false, remaining: 60_000, failover: true },
  { name: 'no alternative', global: false, remaining: 60_000, failover: false, unavailable: true },
]) test(`queued limit handling uses ${scenario.name} and dispatches after collecting replacements`, async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  const { recordRun, rateTask } = await import('../../core/scorecard.mjs');
  const { bus } = await import('../../core/bus.mjs');
  const previous = loadConfig(), provider = 'l6-blocked', model = 'l6-alternative';
  const now = Date.now(); ctx.mock.method(Date, 'now', () => now);
  saveConfig({ worker: { efficiencyMode: scenario.global }, scorecard: { minSamples: 1, classOrder: ['free'], classes: { deepseek: 'free' } } });
  registryModels(ctx, scenario.unavailable ? [] : [{ provider: 'deepseek', id: model, kind: 'agent', cost: 'api' }]);
  recordRun({ id: `l6-seed-${scenario.name}`, status: 'done', provider: 'deepseek', model, category: 'review', difficulty: 2, result: { usage: { input_tokens: 1, output_tokens: 1 } } });
  rateTask(`l6-seed-${scenario.name}`, 'pass');
  getLimits().providers[provider] = { provider, blocked: true, blockedUntil: now + scenario.remaining, windows: [] };
  const tk = await tasksWithWorker(ctx, async () => ({ ok: true, finalMessage: 'ok' }));
  const batch = ['first', 'second'].map((title) => tk.createTask({ cwd: tmpDir('l6'), provider, title, spec: 'x', category: 'review', difficulty: 2, efficiencyMode: scenario.task }));
  const waiting = batch.map((t) => tk.awaitTask(t.id, scenario.remaining / 2)); // these waits end before the park
  const statesAtDispatch = [];
  const onTask = (e) => {
    if (e.type === 'task' && e.task.status === 'running' && batch.some((t) => t.id === e.task.reroutedFrom)) statesAtDispatch.push(batch.map((t) => t.status));
  };
  bus.on('event', onTask);
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(batch.map((t) => t.status), scenario.failover ? ['failed', 'failed'] : ['parked', 'parked']);
    assert.ok(batch.every((t) => t.attempts === 0));
    await Promise.all(waiting);
    if (scenario.failover) {
      assert.deepEqual(statesAtDispatch, [['failed', 'failed'], ['failed', 'failed']], 'no replacement starts inside the collection loop');
      const replacements = batch.map((t) => tk.getTask(t.failedOverTo));
      assert.deepEqual(replacements.map((t) => t.retryOf), [null, null]);
      assert.deepEqual(replacements.map((t) => t.reroutedFrom), batch.map((t) => t.id));
      assert.ok(replacements.every((t) => t.spec === 'x'), 'a never-started task adds no handoff note');
      assert.ok(replacements.every((t) => t.provider === 'deepseek' && t.model === model));
      for (const done of await Promise.all(replacements.map((t) => tk.awaitTask(t.id)))) assert.equal(done.status, 'done');
    } else {
      assert.ok(batch.every((t) => !t.failedOverTo && t.resumeAt === now + scenario.remaining));
      if (scenario.global || scenario.task) for (const t of batch) assert.ok(tk.describeTask(t).includes(`waiting for ${provider} reset at ${new Date(now + scenario.remaining).toISOString()} (efficiency mode)`));
    }
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    bus.off('event', onTask);
    for (const t of batch) tk.cancelChain(t.id);
    await tk.flushRecords();
    delete getLimits().providers[provider];
    saveConfig({ worker: previous.worker, scorecard: previous.scorecard });
  }
});

test('failover skips avoided families, carries avoidFamilies to the replacement, and parks when only avoided ones qualify', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { recordRun, rateTask, recommend } = await import('../../core/scorecard.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  registryModels(ctx, [
    { provider: 'deepseek', id: 'deepseek-chat', kind: 'agent', cost: 'api' },
    { provider: 'grok', id: 'grok-4.6', kind: 'agent' },
  ]);
  const scorecard = loadConfig().scorecard;
  saveConfig({ scorecard: { minSamples: 1, classes: { deepseek: 'free' } } });
  for (const [id, provider, model] of [['avf-o', 'deepseek', 'deepseek-chat'], ['avf-g', 'grok', 'grok-4.6']]) {
    recordRun({ id, title: 't', status: 'done', provider, model, effort: null, category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    rateTask(id, 'pass');
  }
  mockCompletions(ctx, async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers: { 'retry-after': '60' } });
  });
  const run = async (avoidFamilies) => {
    const t = createTask({ cwd: tmpDir('avoid-failover'), provider: 'deepseek', model: 'deepseek-flash', title: 'review', spec: 'x', category: 'review', difficulty: 2, overflowApi: true, avoidFamilies });
    delete getLimits().providers.deepseek; // else the previous run's 429 parks this task before it runs
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    return { t, done: await waitForTaskStatus(t.id, ['failed', 'parked']) };
  };
  const made = [];
  try {
    assert.equal(recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'deepseek', 'without avoidFamilies, the deepseek-chat model would win');
    const a = await run([' DeepSeek', 'deepseek', 'deepseek']); made.push(a.t);
    assert.deepEqual(a.t.avoidFamilies, ['deepseek']);
    assert.equal(a.done.status, 'failed');
    const next = getTask(a.done.failedOverTo);
    assert.equal(next.provider, 'grok');
    assert.deepEqual(next.avoidFamilies, ['deepseek'], 'a second failover respects it too');
    assert.deepEqual(JSON.parse(readFileSync(join(HOME, 'tasks', `${next.id}.json`), 'utf8')).avoidFamilies, ['deepseek'], 'journaled, so a restart keeps it');
    cancelTask(next.id); // keep the replacement from dispatching during the next run
    const b = await run(['deepseek', 'grok']); made.push(b.t);
    assert.equal(b.done.status, 'parked');
    assert.equal(b.done.limitHit, true, 'it ran into the limit, and failover found nothing outside the avoided families');
    assert.equal(getTask(b.t.id).failedOverTo, undefined);
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    for (const t of made) { if (t.failedOverTo) cancelTask(t.failedOverTo); cancelTask(t.id); }
    saveConfig({ scorecard });
    delete getLimits().providers.deepseek;
  }
});
