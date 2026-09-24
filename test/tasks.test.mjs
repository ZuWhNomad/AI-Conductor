import { HOME, tmpDir } from './_env.mjs';
import { test, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { join } from 'node:path';

const { PROVIDERS } = await import('../core/providers/index.mjs');
const originalProviders = { ...PROVIDERS };
for (const [id, provider] of Object.entries(PROVIDERS)) {
  PROVIDERS[id] = { ...provider, pollLimits: mock.fn(async () => ({ provider: id, windows: [], blocked: false })) };
}
const unexpectedIO = [];
const rejectIO = (operation) => {
  unexpectedIO.push(operation);
  throw new Error(`unexpected external I/O: ${operation}`);
};
mock.method(globalThis, 'fetch', (url) => rejectIO(`fetch ${url}`));
const { findCli } = await import('../core/proc.mjs');
const git = findCli('git');
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = childProcess[method];
  mock.method(childProcess, method, (command, ...args) => {
    if (git && command === git && ['execFile', 'execFileSync'].includes(method)) return original(command, ...args);
    return rejectIO(`${method} ${command}`);
  });
}
syncBuiltinESMExports();
// Only the worker completion endpoint belongs in worker-start/completion counts.
const mockCompletions = (ctx, respond) => ctx.mock.method(globalThis, 'fetch', (url, options) => {
  if (new URL(url).pathname !== '/v1/chat/completions') return rejectIO(`fetch ${url}`);
  return respond(url, options);
});

const { createTask, cancelTask, cancelChain, awaitTask, getTask, listTasks, openTasks, describeTask, publicTask, taskSummary, schedule, abortRunning, flushRecords } = await import('../core/tasks.mjs');
const { getModels } = await import('../core/models.mjs');
const registryModels = (ctx, models) => {
  const reg = getModels(), previous = { models: reg.models, providers: reg.providers };
  // Selection reads the imported registry cache, not later writes to models.json.
  reg.models = models;
  reg.providers = Object.fromEntries(models.map((m) => [m.provider, { status: 'ok' }]));
  ctx.after(() => Object.assign(reg, previous));
};
afterEach(async () => {
  await flushRecords(); // scoring outlives awaitTask; finish it before the next test installs its fetch spy
  assert.deepEqual(unexpectedIO, [], 'caught worker/poll errors must still fail the test');
});
after(async () => {
  await flushRecords();
  Object.assign(PROVIDERS, originalProviders);
  mock.restoreAll();
  syncBuiltinESMExports();
});

test('tasks are journaled, default to the configured worker, and follow-ups need a thread', async () => {
  const cwd = tmpDir('tasks');
  const t = createTask({ sessionId: 's1', cwd, title: 'add feature', spec: 'do the thing', paths: ['src'] });
  assert.equal(t.status, 'queued');
  assert.equal(t.provider, 'codex');
  assert.equal(t.model, 'gpt-6-astra');
  assert.ok(existsSync(join(HOME, 'tasks', `${t.id}.json`)));
  assert.throws(() => createTask({ cwd, spec: 'fix', followUpOf: t.id }), /no resumable thread/);
  assert.throws(() => createTask({ cwd, spec: 'fix', followUpOf: 'nope' }), /unknown task/);

  const pending = awaitTask(t.id, 5000);
  assert.equal(cancelTask(t.id).status, 'canceled');
  const done = await pending;
  assert.equal(done.status, 'canceled');
  assert.equal(listTasks({ sessionId: 's1' }).length, 1);
  assert.equal(listTasks({ sessionId: 'other' }).length, 0);
  assert.match(describeTask(getTask(t.id)), /\[canceled\] add feature/);
  assert.equal(await awaitTask('missing'), null);
});

test('task ID collisions regenerate without overwriting existing journals', async (ctx) => {
  const { writeJson } = await import('../core/paths.mjs');
  const samples = [0.125, 0.125, 0.25, 0.375];
  const random = ctx.mock.method(Math, 'random', () => {
    assert.ok(samples.length, 'must stop regenerating once an unused ID is found');
    return samples.shift();
  });
  const cwd = tmpDir('task-collision');
  const first = createTask({ cwd, spec: 'keep this task' });
  const file = join(HOME, 'tasks', `${first.id}.json`);
  const original = readFileSync(file, 'utf8');
  // A journal can exist on disk without having been loaded into the task map.
  const diskId = (0.25).toString(36).slice(2, 10);
  const diskFile = join(HOME, 'tasks', `${diskId}.json`);
  const diskTask = { id: diskId, spec: 'keep this journal too' };
  writeJson(diskFile, diskTask);
  const second = createTask({ cwd, spec: 'new task' });
  assert.equal(second.id, (0.375).toString(36).slice(2, 10));
  assert.equal(random.mock.callCount(), 4);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(JSON.parse(readFileSync(diskFile, 'utf8')), diskTask);
  assert.equal(getTask(first.id), first);
  assert.equal(JSON.parse(readFileSync(join(HOME, 'tasks', `${second.id}.json`), 'utf8')).spec, 'new task');
});

test('awaitTask times out with a snapshot', async () => {
  const t = createTask({ cwd: tmpDir('t2'), title: 'slow', spec: 'x', provider: 'ollama', model: 'qwen3.8' });
  const r = await awaitTask(t.id, 50);
  assert.equal(r.timedOut, true);
  assert.equal(r.status, 'queued');
  cancelTask(t.id);
});

test('all task waits use the category timeout or worker timeout unless explicitly overridden', async (ctx) => {
  const { loadConfig, saveConfig, DEFAULTS } = await import('../core/config.mjs');
  const { conductorToolDefs } = await import('../core/tools.mjs');
  const previous = loadConfig().worker;
  const waits = [];
  ctx.mock.method(globalThis, 'setTimeout', (fn, ms) => { waits.push(ms); queueMicrotask(fn); return {}; });
  const cwd = tmpDir('wait-defaults');
  const defs = conductorToolDefs({ sessionId: 'waits', cwd });
  const call = (name, args) => defs.find((d) => d.name === name).handler(args);
  try {
    const modeling = createTask({ cwd, category: 'modeling' });
    assert.equal((await awaitTask(modeling.id)).timedOut, true);
    assert.equal(waits.pop(), DEFAULTS.worker.timeoutByCategory.modeling * 60_000);
    // Change settings after constructing the tools: wait defaults must come from the current config.
    saveConfig({ worker: { timeoutMinutes: 7, timeoutByCategory: { modeling: 11 } } });
    for (const [category, minutes] of [['modeling', 11], ['read', 7], [undefined, 7]]) {
      const t = createTask({ cwd, category });
      await awaitTask(t.id); assert.equal(waits.pop(), minutes * 60_000);
      await call('await_task', { task_id: t.id }); assert.equal(waits.pop(), minutes * 60_000);
      await call('delegate', { title: 'wait', spec: 'wait', provider: 'codex', category }); assert.equal(waits.pop(), minutes * 60_000);
      Object.assign(t, { status: 'done', threadId: `wait-thread-${t.id}` });
      await call('follow_up', { task_id: t.id, comments: 'wait' }); assert.equal(waits.pop(), minutes * 60_000);
    }
    await awaitTask(modeling.id, 123); assert.equal(waits.pop(), 123);
    for (const minutes of [0, 2]) {
      await call('await_task', { task_id: modeling.id, timeout_minutes: minutes }); assert.equal(waits.pop(), minutes * 60_000);
      await call('delegate', { title: 'wait', spec: 'wait', provider: 'codex', category: 'modeling', timeout_minutes: minutes }); assert.equal(waits.pop(), minutes * 60_000);
    }
    assert.equal(await call('await_task', { task_id: 'missing' }), 'unknown task missing');
  } finally {
    for (const t of listTasks()) cancelTask(t.id);
    saveConfig({ worker: previous });
  }
});

test('task inputs are validated and normalized before journaling', () => {
  const cwd = tmpDir('inputs');
  for (const bad of [123, '', join(cwd, 'missing')]) assert.throws(() => createTask({ cwd: bad, spec: 'x' }), { status: 400, message: 'cwd must be an existing directory' });
  for (const key of ['provider', 'model', 'effort']) assert.throws(() => createTask({ cwd, [key]: 123 }), { status: 400 });
  assert.throws(() => createTask({ cwd, sandbox: 'nope' }), { status: 400 });
  const t = createTask({ cwd, spec: 42, paths: 'src', title: 'a'.repeat(250), sessionId: 123 });
  assert.equal(t.spec, '42');
  assert.equal(publicTask(t).specPreview, '42');
  assert.equal(t.title.length, 200);
  assert.equal(t.sessionId, null);
  assert.deepEqual(t.paths, []);
  assert.doesNotThrow(() => listTasks());
  assert.deepEqual(createTask({ cwd, paths: ['src', 123, null], sandbox: null }).paths, ['src']);
});

test('scorecard tags are validated and inherited by follow-ups', () => {
  const cwd = tmpDir('tags');
  const t = createTask({ cwd, category: 'implement', difficulty: 3, source: 'smoke' });
  assert.equal(t.category, 'implement'); assert.equal(t.difficulty, 3); assert.equal(t.source, 'smoke');
  const u = createTask({ cwd, category: 'weird', difficulty: 9 });
  assert.equal(u.category, 'other'); assert.equal(u.difficulty, null); assert.equal(u.source, 'live');
  assert.equal(createTask({ cwd }).category, null);
  // No category given: a UI spec is auto-classified as 'ui' so hand-diverted /worker UI tasks are recorded there.
  assert.equal(createTask({ cwd, title: 'fix layout', spec: 'the sidebar CSS is misaligned' }).category, 'ui');
  assert.equal(createTask({ cwd, spec: 'add a database index' }).category, null); // non-UI stays untagged
  assert.equal(createTask({ cwd, category: 'implement', spec: 'tweak the CSS' }).category, 'implement'); // explicit wins
  assert.equal(createTask({ cwd, retryOf: t.id }).retryOf, t.id);
  assert.equal(createTask({ cwd, retryOf: 5 }).retryOf, null);
  Object.assign(getTask(t.id), { status: 'done', threadId: 'th' });
  const f = createTask({ cwd, spec: 'fix', followUpOf: t.id });
  assert.equal(f.category, 'implement'); assert.equal(f.difficulty, 3); assert.equal(f.source, 'smoke');
});

test('follow-ups wait for a terminal parent and inherit effort and sandbox', () => {
  const parent = createTask({ cwd: tmpDir('follow-up') });
  getTask(parent.id).threadId = 't';
  assert.throws(() => createTask({ followUpOf: parent.id }), (e) => e.status === 400 && /still queued/.test(e.message));
  Object.assign(parent, { status: 'done', effort: 'ultra', sandbox: 'read-only' });
  const follow = createTask({ followUpOf: parent.id });
  assert.equal(follow.effort, 'ultra');
  assert.equal(follow.sandbox, 'read-only');
  assert.equal(follow.cwd, parent.cwd);
});

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

test('follow-up errors carry client status codes', () => {
  const cwd = tmpDir('follow-status');
  assert.throws(() => createTask({ cwd, spec: 'x', followUpOf: 'nope' }), { status: 404 });
  const parent = createTask({ cwd, spec: 'x' });
  parent.status = 'done';
  assert.throws(() => createTask({ cwd, spec: 'x', followUpOf: parent.id }), { status: 400, message: /no resumable thread/ });
});

test('graceful shutdown requeues in-flight tasks instead of failing them', async (ctx) => {
  mockCompletions(ctx, async (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
  const t = createTask({ cwd: tmpDir('requeue'), provider: 'deepseek' });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(getTask(t.id).status, 'running');
    abortRunning({ requeue: true });
    await new Promise((r) => setTimeout(r, 100));
    const after = getTask(t.id);
    assert.equal(after.status, 'queued');
    assert.equal(after.resume, true);
    assert.match(after.error, /shutdown/);
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; abortRunning(); cancelTask(t.id); }
});

test('abortRunning aborts every active worker', async (ctx) => {
  const signals = [];
  mockCompletions(ctx, async (_url, { signal }) => new Promise((_resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const batch = Array.from({ length: 2 }, () => createTask({ cwd: tmpDir('abort'), provider: 'deepseek' }));
  const pending = batch.map((t) => awaitTask(t.id, 2000));
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    for (let i = 0; i < 50 && signals.length < 2; i++) await new Promise((r) => setTimeout(r, 20)); // the worker starts after an async git read
    assert.equal(signals.length, 2);
    abortRunning();
    assert.ok(signals.every((signal) => signal.aborted));
    for (const t of await Promise.all(pending)) { assert.equal(t.status, 'failed'); assert.match(t.error, /aborted/); }
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; abortRunning(); }
});

test('a provider limit mid-task fails over to the next qualified provider as a retry chain and is not scored', async (ctx) => {
  const { saveConfig } = await import('../core/config.mjs');
  const { recordRun, rateTask, rootRuns } = await import('../core/scorecard.mjs');
  registryModels(ctx, [{ provider: 'ollama', id: 'qwen', kind: 'agent', cost: 'free-local' }]);
  saveConfig({ providers: { deepseek: { apiKey: 'test-key' } }, scorecard: { minSamples: 1 } });
  for (let i = 0; i < 2; i++) { const id = `fo${i}`; recordRun({ id, title: 't', status: 'done', provider: 'ollama', model: 'qwen', effort: null, category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } }); rateTask(id, 'pass'); }
  mockCompletions(ctx, async () => {
    // Verify the retry is queued, without dispatching its Ollama worker into live detection.
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers: { 'retry-after': '60' } });
  });
  const cwd = tmpDir('failover');
  const t = createTask({ sessionId: 'fo', cwd, title: 'review it', spec: 'x', provider: 'deepseek', model: 'deepseek-flash', category: 'review', difficulty: 2, sandbox: 'read-only', parallelOverride: true, overflowApi: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  let done;
  try {
    schedule(); done = await awaitTask(t.id, 15000);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /failed over to task/);
    const next = getTask(done.failedOverTo);
    assert.equal(next.status, 'queued');
    assert.equal(next.provider, 'ollama');
    assert.equal(next.model, 'qwen');
    assert.equal(next.retryOf, t.id);
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

test('failover excludes the whole current provider before choosing an eligible alternative', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../core/config.mjs');
  const { recordRun, rateTask, recommend } = await import('../core/scorecard.mjs');
  const { getLimits } = await import('../core/limits.mjs');
  const { bus } = await import('../core/bus.mjs');
  registryModels(ctx, [
    { provider: 'ollama', id: 'qwen', kind: 'agent', cost: 'free-local' },
    { provider: 'deepseek', id: 'deepseek-reasoner', kind: 'agent' },
  ]);
  const scorecard = loadConfig().scorecard;
  saveConfig({ scorecard: { minSamples: 1, classOrder: ['api', 'free'] } });
  delete getLimits().providers.deepseek;
  const id = 'same-provider-alternative';
  recordRun({ id, title: 't', status: 'done', provider: 'deepseek', model: 'deepseek-reasoner', effort: null, category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
  rateTask(id, 'pass');
  // A fresh model-scoped quota view permits the same-provider model again.
  ctx.mock.method(PROVIDERS.deepseek, 'pollLimits', async () => ({ provider: 'deepseek', windows: [{ id: 'requests', usedPercent: 0 }], blocked: false }));
  mockCompletions(ctx, async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429 });
  });
  const t = createTask({ cwd: tmpDir('failover-provider'), provider: 'deepseek', model: 'deepseek-flash', spec: 'x', category: 'review', difficulty: 2, overflowApi: true });
  const finished = Promise.withResolvers();
  const onEvent = (e) => { if (e.type === 'task' && e.task.id === t.id && e.task.finishedAt) finished.resolve(e.task); };
  bus.on('event', onEvent);
  try {
    assert.equal(recommend({ category: 'review', difficulty: 2, exclude: ['deepseek:deepseek-flash'], overflowApi: true }).provider, 'deepseek', 'the same-provider model would win without provider filtering');
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    const done = await finished.promise;
    assert.equal(done.status, 'failed');
    assert.equal(getTask(done.failedOverTo)?.provider, 'ollama');
    assert.equal(getTask(done.failedOverTo)?.model, 'qwen');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    bus.off('event', onEvent);
    if (t.failedOverTo) cancelTask(t.failedOverTo);
    cancelTask(t.id);
    saveConfig({ scorecard });
    delete getLimits().providers.deepseek;
  }
});

for (const action of ['cancel', 'shutdown']) for (const noFailover of [false, true]) {
  test(`${action} during quota refresh prevents ${noFailover ? 'parking' : 'failover'}`, async (ctx) => {
    const { loadConfig, saveConfig } = await import('../core/config.mjs');
    const { getLimits } = await import('../core/limits.mjs');
    const { bus } = await import('../core/bus.mjs');
    const scorecard = loadConfig().scorecard;
    saveConfig({ scorecard: { minSamples: 1 } });
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

test('a task created with noFailover is parked on a limit, never handed to another provider', () => {
  const t = createTask({ cwd: tmpDir(), title: 'bench', spec: 'x', provider: 'grok', model: 'grok-4.6', category: 'modeling', difficulty: 2, noFailover: true });
  assert.equal(getTask(t.id).noFailover, true);
  cancelTask(t.id);
});

test('createTask strips an effort a model cannot honor (Method C guard D)', async () => {
  const cwd = tmpDir('guard-d');
  const { getModels } = await import('../core/models.mjs');
  getModels().models.push(
    { provider: 'antigravity', id: 'claude-sonnet-4-6', kind: 'agent', efforts: [] },                        // no effort dimension
    { provider: 'antigravity', id: 'gemini-3.8-flash', kind: 'agent', efforts: ['low', 'medium', 'high'], effortIds: { low: 'gemini-3.8-flash-low', medium: 'gemini-3.8-flash-medium', high: 'gemini-3.8-flash-high' } }, // collapsed family
  );
  const stripped = createTask({ cwd, provider: 'antigravity', model: 'claude-sonnet-4-6', effort: 'high' });
  assert.equal(stripped.effort, null);
  assert.match(stripped.warning || '', /dropped effort/);
  const kept = createTask({ cwd, provider: 'antigravity', model: 'gemini-3.8-flash', effort: 'high' });
  assert.equal(kept.effort, 'high');                                                    // a family that offers the effort keeps it
  const clamped = createTask({ cwd, provider: 'antigravity', model: 'gemini-3.8-flash', effort: 'ultra' });
  assert.equal(clamped.effort, 'high');                                                 // out-of-range effort on an effort-in-id family clamps to its top level
  assert.match(clamped.warning || '', /clamped effort/);
  const unknown = createTask({ cwd, provider: 'antigravity', model: 'not-in-registry', effort: 'high' });
  assert.equal(unknown.effort, 'high');                                                 // unknown model: the guard can't judge, leaves it
  for (const t of [stripped, kept, clamped, unknown]) cancelTask(t.id);
});

// A fresh task module captures the controlled execFile promise, without adding a production test hook.
async function tasksWithGit(ctx, exec) {
  const original = childProcess.execFile;
  const originalSync = childProcess.execFileSync;
  const syncCalls = [];
  childProcess.execFile = Object.assign(() => { throw new Error('expected promisified execFile'); }, { [promisify.custom]: (bin, args, opts) => {
    assert.deepEqual(args.slice(0, 5), ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '--no-optional-locks']);
    return exec(bin, args.slice(5), opts);
  } });
  childProcess.execFileSync = (...args) => { syncCalls.push(args); throw new Error('synchronous git on the task path'); };
  syncBuiltinESMExports();
  ctx.after(() => {
    childProcess.execFile = original;
    childProcess.execFileSync = originalSync;
    syncBuiltinESMExports();
    assert.deepEqual(syncCalls, [], 'task creation, dispatch and completion must not run synchronous git');
  });
  const tk = await import(`../core/tasks.mjs?${encodeURIComponent(ctx.name)}`);
  for (const t of tk.listTasks()) tk.cancelTask(t.id); // isolate this scheduler from earlier journal entries
  return tk;
}

test('dispatch is not serialized on git: two tasks are running before the first git read resolves', async (ctx) => {
  const { findCli } = await import('../core/proc.mjs');
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
  const lim = await import('../core/limits.mjs'); delete lim.getLimits().providers.deepseek; // an earlier test may have left it blocked
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
    const { getLimits, noteRateLimitEvent } = await import('../core/limits.mjs');
    const { loadConfig, saveConfig } = await import('../core/config.mjs');
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
    const { getLimits, refreshLimits } = await import('../core/limits.mjs');
    const { loadConfig, saveConfig } = await import('../core/config.mjs');
    const { appendNdjson, statePath } = await import('../core/paths.mjs');
    const { runRows } = await import('../core/scorecard.mjs');
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
  const { getLimits } = await import('../core/limits.mjs');
  const { runRows } = await import('../core/scorecard.mjs');
  const { measuredCostByWindow } = await import('../core/sweep.mjs');
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
    assert.deepEqual(measuredCostByWindow(rows, 'claude', { model: 'sonnet' }), { five_hour: 6, seven_day: 3, seven_day_sonnet: 8 });
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

test('non-repository task creation, dispatch and completion never invoke git', async (ctx) => {
  const calls = [];
  const tk = await tasksWithGit(ctx, async (...args) => { calls.push(args); return { stdout: '' }; });
  ctx.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] })));
  const lim = await import('../core/limits.mjs'); delete lim.getLimits().providers.deepseek;
  let task;
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    task = tk.createTask({ cwd: tmpDir('no-git'), provider: 'deepseek', spec: 'x' });
    const done = await tk.awaitTask(task.id);
    assert.equal(done.status, 'done');
    assert.deepEqual(calls, []);
    assert.deepEqual(done.changedFiles, []);
    assert.equal(done.diffStat, '');
    assert.equal(done.repoFiles, null);
    assert.equal(done.repoBytes, null);
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    tk.abortRunning();
    if (task?.status === 'running') await tk.awaitTask(task.id);
    if (task) tk.cancelTask(task.id);
    await tk.flushRecords();
  }
});

test('image-kind tasks send the raw spec as the picture prompt, not the coding-worker preamble', async (ctx) => {
  let prompt;
  ctx.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!String(url).includes('/sdapi/v1/txt2img')) return rejectIO(`fetch ${url}`);
    prompt = JSON.parse(opts.body).prompt;
    return new Response(JSON.stringify({ images: [Buffer.from('png').toString('base64')] }), { status: 200 });
  });
  const cwd = tmpDir('image-prompt');
  const spec = 'a red cube on a table, studio lighting';
  const t = createTask({ cwd, provider: 'sd', title: 'draw cube', spec });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    const done = await awaitTask(t.id, 15000);
    assert.equal(done.status, 'done', done.error);
    assert.equal(prompt, spec);
    assert.doesNotMatch(prompt, /# Task:/);
    assert.doesNotMatch(prompt, /MSW/);
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    cancelTask(t.id);
  }
});

test('createTask clamps an unknown effort to the nearest listed effort even without effortIds', () => {
  const cwd = tmpDir('h3-effort');
  getModels().models.push({ provider: 'grok', id: 'h3-grok-fixture', kind: 'agent', efforts: ['low', 'medium', 'high'] });
  const ultra = createTask({ cwd, provider: 'grok', model: 'h3-grok-fixture', effort: 'ultra' });
  assert.equal(ultra.effort, 'high');
  assert.match(ultra.warning || '', /clamped effort "ultra" to "high"/);
  const max = createTask({ cwd, provider: 'grok', model: 'h3-grok-fixture', effort: 'max' });
  assert.equal(max.effort, 'high');
  const kept = createTask({ cwd, provider: 'grok', model: 'h3-grok-fixture', effort: 'medium' });
  assert.equal(kept.effort, 'medium');
  assert.doesNotMatch(kept.warning || '', /clamped effort "medium"/);
  for (const t of [ultra, max, kept]) cancelTask(t.id);
});

test('persist failure after a decided outcome does not overwrite it', async (ctx) => {
  mockCompletions(ctx, async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] })));
  const t = createTask({ cwd: tmpDir('g8-persist'), provider: 'deepseek', spec: 'x' });
  let cur = t.status;
  Object.defineProperty(t, 'status', {
    configurable: true, enumerable: true,
    get() { return cur; },
    set(v) { cur = v; if (v === 'done') t.circular = t; },
  });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    const done = await awaitTask(t.id, 15000);
    assert.equal(done.status, 'done');
    assert.notEqual(done.status, 'failed');
    const { listImprovements } = await import('../core/improve.mjs');
    assert.ok(listImprovements().some((i) => /journal persist failed after done/.test(i.message)));
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    delete t.circular;
    cancelTask(t.id);
  }
});

test('claimed writes gitignore hides are not phantom when the file landed on disk', async (ctx) => {
  const { findCli } = await import('../core/proc.mjs');
  const gitBin = findCli('git');
  if (!gitBin) { ctx.skip('git is not installed'); return; }
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './workers/index.mjs' && context.parentURL?.includes('/core/tasks.mjs')) {
        return { url: 'g5-worker://run', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === 'g5-worker://run') {
        return { format: 'module', shortCircuit: true, source: 'export async function runWorker(t) { return globalThis.__g5Worker(t); }' };
      }
      return nextLoad(url, context);
    },
  });
  ctx.after(() => { hooks.deregister(); delete globalThis.__g5Worker; });
  globalThis.__g5Worker = async (t) => {
    writeFileSync(join(t.cwd, 'ignored.bin'), 'landed');
    return { ok: true, finalMessage: 'wrote ignored.bin', items: [{ type: 'file_change', changes: [{ path: 'ignored.bin' }] }], usage: { input_tokens: 3, output_tokens: 1 }, durationMs: 5 };
  };
  const tk = await import(`../core/tasks.mjs?g5=${encodeURIComponent(ctx.name)}`);
  for (const existing of tk.listTasks()) tk.cancelTask(existing.id);
  const cwd = tmpDir('phantom-ignore');
  childProcess.execFileSync(gitBin, ['init', '--quiet'], { cwd, windowsHide: true });
  writeFileSync(join(cwd, '.gitignore'), 'ignored.bin\n');
  childProcess.execFileSync(gitBin, ['add', '.gitignore'], { cwd, windowsHide: true });
  childProcess.execFileSync(gitBin, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'ignore'], { cwd, windowsHide: true });
  const t = tk.createTask({ cwd, provider: 'deepseek', spec: 'write ignored.bin', category: 'edit', difficulty: 1 });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    tk.schedule();
    const done = await tk.awaitTask(t.id, 15000);
    assert.equal(done.status, 'done', done.error);
    assert.notEqual(done.failKind, 'phantom');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    tk.abortRunning();
    tk.cancelTask(t.id);
    await tk.flushRecords();
  }
});

test('failover passes the access-gate provider restriction intersected with the excluded provider', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../core/config.mjs');
  const { recordRun, rateTask, recommend } = await import('../core/scorecard.mjs');
  registryModels(ctx, [
    { provider: 'ollama', id: 'qwen', kind: 'agent', cost: 'free-local' },
    { provider: 'grok', id: 'grok-4.6', kind: 'agent' },
  ]);
  const scorecard = loadConfig().scorecard;
  const tools = loadConfig().tools;
  saveConfig({
    scorecard: { minSamples: 1 },
    tools: { index: { og4_gate: { kind: 'access', match: ['og4-gate.test/'], providers: ['grok'] } } },
  });
  for (const [id, provider, model] of [['og4o', 'ollama', 'qwen'], ['og4g', 'grok', 'grok-4.6']]) {
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
    assert.equal(recommend({ category: 'search', difficulty: 2, overflowApi: true }).provider, 'ollama', 'without the gate, free-local would win');
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    const done = await awaitTask(t.id, 15000);
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

test('graceful shutdown after the worker returns does not requeue a finished run', { skip: !git }, async (ctx) => {
  const cwd = tmpDir('e1-finished');
  mkdirSync(join(cwd, '.git'));
  let statusCalls = 0;
  const enteredAfter = Promise.withResolvers(), afterStatus = Promise.withResolvers();
  const tk = await tasksWithGit(ctx, async (_bin, args) => {
    if (args[0] === 'status') {
      statusCalls++;
      if (statusCalls === 2) { enteredAfter.resolve(); await afterStatus.promise; }
    }
    return { stdout: '' };
  });
  ctx.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] })));
  const lim = await import('../core/limits.mjs'); delete lim.getLimits().providers.deepseek;
  let task;
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    task = tk.createTask({ cwd, provider: 'deepseek', spec: 'x' });
    tk.schedule();
    await enteredAfter.promise;
    assert.equal(tk.getTask(task.id).status, 'running');
    tk.abortRunning({ requeue: true });
    afterStatus.resolve();
    const done = await tk.awaitTask(task.id, 15000);
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.resume, false);
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    afterStatus.resolve();
    tk.abortRunning();
    if (task) tk.cancelTask(task.id);
    await tk.flushRecords();
  }
});

test('awaitTask and worker timeoutMs are clamped to the Node timer maximum', async (ctx) => {
  const waits = [];
  ctx.mock.method(globalThis, 'setTimeout', (fn, ms) => { waits.push(ms); queueMicrotask(fn); return {}; });
  const queued = createTask({ cwd: tmpDir('e8-await'), spec: 'x' });
  await awaitTask(queued.id, 2 ** 40);
  cancelTask(queued.id);
  assert.equal(waits.at(-1), 2 ** 31 - 1);

  // Config clamps timeoutMinutes to 1440, so the worker path cannot be driven past 2^31-1 through saveConfig.
  // Assert the runWorker call site still applies the same clamp to whatever minutes loadConfig returns.
  const src = readFileSync(new URL('../core/tasks.mjs', import.meta.url), 'utf8');
  assert.match(src, /timeoutMs:\s*Math\.min\(2 \*\* 31 - 1,\s*\(wcfg\.timeoutByCategory\[t\.category\] \?\? wcfg\.timeoutMinutes\) \* 60_000\)/);
});

test('GP7: a noFailover task that parks on a limit hit is scored after a successful resume', async (ctx) => {
  const { runRows } = await import('../core/scorecard.mjs');
  const { getLimits } = await import('../core/limits.mjs');
  delete getLimits().providers.deepseek;
  let n = 0;
  mockCompletions(ctx, async () => {
    n++;
    if (n === 1) return new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers: { 'retry-after': '1' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  });
  const t = createTask({ cwd: tmpDir('gp7-limit'), provider: 'deepseek', model: 'deepseek-flash', spec: 'x', category: 'review', difficulty: 2, noFailover: true });
  const { bus } = await import('../core/bus.mjs');
  const resumed = Promise.withResolvers();
  const watchdog = setTimeout(() => resumed.reject(new Error('resume did not complete')), 15000); // same wait budget as this regression
  const onTask = (e) => { if (e.type === 'task' && e.task.id === t.id && e.task.status === 'done') resumed.resolve(e.task); };
  bus.on('event', onTask);
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    const parked = await awaitTask(t.id, 15000);
    assert.equal(parked.parked, true);
    await resumed.promise;
    const done = await awaitTask(t.id, 15000);
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

// Exercise scheduler outcomes without depending on a vendor's parser or external service.
async function tasksWithWorker(ctx, worker) {
  globalThis.__w1Worker = ctx.mock.fn(worker);
  globalThis.__w1Costs = [];
  const workerUrl = `w1-worker:${encodeURIComponent(ctx.name)}`;
  const sweepUrl = `w1-sweep:${encodeURIComponent(ctx.name)}`;
  const realSweep = new URL('../core/sweep.mjs', import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.includes('/core/tasks.mjs')) {
        if (specifier === './workers/index.mjs') return { url: workerUrl, shortCircuit: true };
        if (specifier === './sweep.mjs') return { url: sweepUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === workerUrl) return { format: 'module', shortCircuit: true, source: 'export const runWorker = (...args) => globalThis.__w1Worker(...args);' };
      if (url === sweepUrl) return { format: 'module', shortCircuit: true, source: `
        export * from ${JSON.stringify(realSweep)};
        import { measuredCostByWindow as measure } from ${JSON.stringify(realSweep)};
        export const measuredCostByWindow = (...args) => { globalThis.__w1Costs.push(args.slice(1)); return measure(...args); };
      ` };
      return nextLoad(url, context);
    },
  });
  const tk = await import(`../core/tasks.mjs?w1=${encodeURIComponent(ctx.name)}`);
  for (const t of tk.openTasks()) tk.cancelTask(t.id);
  ctx.after(async () => {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    for (const t of tk.openTasks()) tk.cancelTask(t.id);
    await tk.flushRecords();
    hooks.deregister(); delete globalThis.__w1Worker; delete globalThis.__w1Costs;
  });
  return tk;
}

for (const [id, provider] of [['L1', 'codex'], ['L4', 'claude']]) {
  test(`${id}: a successful worker with limitHit completes and is scored without a limit refresh`, async (ctx) => {
    const { getLimits } = await import('../core/limits.mjs');
    const { runRows } = await import('../core/scorecard.mjs');
    delete getLimits().providers[provider];
    const polls = ctx.mock.method(PROVIDERS[provider], 'pollLimits', async () => ({ provider, windows: [], blocked: false }));
    const tk = await tasksWithWorker(ctx, async () => ({ ok: true, limitHit: true, finalMessage: 'finished', usage: { input_tokens: 5, output_tokens: 2 } }));
    const t = tk.createTask({ cwd: tmpDir(id), provider, spec: 'x' });
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await tk.awaitTask(t.id);
    assert.equal(done.status, 'done');
    assert.equal(done.limitHit, false);
    assert.equal(done.failedOverTo, undefined);
    assert.equal(done.resumeAt, null);
    await tk.flushRecords();
    assert.ok(runRows().some((r) => r.taskId === t.id));
    assert.equal(globalThis.__w1Worker.mock.callCount(), 1);
    assert.equal(polls.mock.callCount(), 1, 'one fresh accounting poll; no limit-handling or redundant accounting poll');
  });
}

test('L10: a live follow-up owns its thread through queued, running and parked states', () => {
  const parent = createTask({ cwd: tmpDir('thread-owner'), spec: 'x' });
  Object.assign(parent, { status: 'done', threadId: `thread-${parent.id}` });
  const follow = createTask({ followUpOf: parent.id });
  for (const status of ['queued', 'running', 'parked']) {
    follow.status = status;
    assert.throws(() => createTask({ followUpOf: parent.id }), (e) => e.status === 409 && e.message.includes(follow.id));
  }
  cancelTask(follow.id);
  const next = createTask({ followUpOf: parent.id });
  assert.equal(next.threadId, parent.threadId);
  cancelTask(next.id);
});

test('P1: one scheduling pass measures each provider/model once and the next pass remeasures', async (ctx) => {
  const { getLimits } = await import('../core/limits.mjs');
  const { loadConfig, saveConfig } = await import('../core/config.mjs');
  const conductor = loadConfig().conductor;
  saveConfig({ conductor: { maxWorkerConcurrency: 3 } });
  ctx.after(() => saveConfig({ conductor }));
  getLimits().providers['w1-cost'] = { windows: [{ id: 'budget', usedPercent: 0 }, { id: 'weekly', usedPercent: 0 }] };
  ctx.after(() => delete getLimits().providers['w1-cost']);
  const finish = Promise.withResolvers();
  const tk = await tasksWithWorker(ctx, () => finish.promise);
  const cwd = tmpDir('cost-cache');
  const batch = ['a', 'a', 'b'].map((model) => tk.createTask({ cwd, provider: 'w1-cost', model }));
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(batch.map((t) => t.status), ['running', 'queued', 'queued']);
    assert.deepEqual(globalThis.__w1Costs, [['w1-cost', { model: 'a' }]]);
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    finish.resolve({ ok: true });
    await tk.awaitTask(batch[0].id);
    await tk.flushRecords();
    globalThis.__w1Costs.length = 0;
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(globalThis.__w1Costs, [['w1-cost', { model: 'a' }], ['w1-cost', { model: 'b' }]], 'the measured model and the next unmeasured model are each scanned once');
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    await tk.awaitTask(batch[1].id);
    await tk.flushRecords();
    globalThis.__w1Costs.length = 0;
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(globalThis.__w1Costs, [['w1-cost', { model: 'b' }]]);
    await tk.awaitTask(batch[2].id);
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; finish.resolve({ ok: true }); await tk.flushRecords(); }
});

test('P2: rate and null-percent windows do not serialize a provider behind a probe', async (ctx) => {
  const { getLimits } = await import('../core/limits.mjs');
  const finish = Promise.withResolvers();
  const tk = await tasksWithWorker(ctx, () => finish.promise);
  getLimits().providers['w1-rate'] = { windows: [{ id: 'requests', rate: true, usedPercent: 90 }, { id: 'unknown', usedPercent: null }] };
  const batch = ['one', 'two'].map((spec) => tk.createTask({ cwd: tmpDir('rate-probe'), provider: 'w1-rate', spec }));
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.deepEqual(batch.map((t) => t.status), ['running', 'running']);
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    finish.resolve({ ok: true });
    await Promise.all(batch.map((t) => tk.awaitTask(t.id)));
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; finish.resolve({ ok: true }); await tk.flushRecords(); delete getLimits().providers['w1-rate']; }
});

test('P8: lists and task events omit bulky results while the full record preserves them', async () => {
  const { bus } = await import('../core/bus.mjs');
  const t = createTask({ cwd: tmpDir('task-summary'), paths: ['scope'], imageOptions: { source: 'image' }, spec: 'full spec' });
  t.result = { items: [{ type: 'tool_use', input: { file_path: 'edited.txt', content: 'full contents' } }], finalMessage: 'report'.repeat(40), tools: { calls: 1, byName: { Write: 1 } }, files: ['image.png'], usage: { input_tokens: 3 }, durationMs: 10, costUsd: 2 };
  t.diffStat = 'full diff';
  const events = [];
  const onTask = (e) => { if (e.type === 'task' && e.task.id === t.id) events.push(e.task); };
  bus.on('event', onTask);
  try {
    cancelTask(t.id);
    const summary = taskSummary(t);
    assert.deepEqual(listTasks().find((x) => x.id === t.id), summary);
    assert.deepEqual(events, [summary]);
    for (const key of ['paths', 'imageOptions', 'diffStat']) assert.equal(key in summary, false);
    for (const key of ['items', 'files', 'tools']) assert.equal(key in summary.result, false);
    assert.equal(summary.result.finalMessage, t.result.finalMessage.slice(0, 120));
    assert.equal(summary.result.durationMs, 10);
    assert.equal(summary.result.costUsd, 2);
    assert.deepEqual(publicTask(getTask(t.id)).result, t.result);
    assert.deepEqual(JSON.parse(readFileSync(join(HOME, 'tasks', `${t.id}.json`))).result, t.result);
  } finally { bus.off('event', onTask); }
});

test('L23: cancelChain follows replacements, reports terminal status and stops on cycles', () => {
  const cwd = tmpDir('cancel-chain');
  const original = createTask({ cwd }), replacement = createTask({ cwd });
  Object.assign(original, { status: 'failed', failedOverTo: replacement.id });
  assert.deepEqual(cancelChain(original.id), { canceled: [replacement.id], already: null });
  assert.deepEqual(cancelChain(original.id), { canceled: [], already: 'canceled' });
  assert.equal(cancelChain('unknown-chain'), null);
  const a = createTask({ cwd }), b = createTask({ cwd });
  a.failedOverTo = b.id; b.failedOverTo = a.id;
  assert.deepEqual(cancelChain(a.id), { canceled: [a.id, b.id], already: null });
  assert.deepEqual(cancelChain(a.id), { canceled: [], already: 'canceled' });
});

test('L37: schedule does not dispatch queued tasks during graceful shutdown', () => {
  const t = createTask({ cwd: tmpDir('shutdown-gate'), provider: 'missing-test-provider' });
  try {
    abortRunning({ requeue: true });
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    assert.equal(t.status, 'queued');
    assert.equal(t.attempts, 0);
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; abortRunning(); cancelTask(t.id); }
});

test('L46: existing and new awaiters return immediately when a task parks', async () => {
  const { getLimits } = await import('../core/limits.mjs');
  const provider = 'w1-await-park', until = Date.now() + 60_000;
  getLimits().providers[provider] = { blocked: true, blockedUntil: until, windows: [] };
  const t = createTask({ cwd: tmpDir('wait-park'), provider });
  const pending = awaitTask(t.id);
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    for (const result of [await pending, await awaitTask(t.id)]) {
      assert.equal(result.parked, true);
      assert.equal(result.status, 'parked');
      assert.equal(result.resumeAt, until);
      assert.equal(result.message, `parked until ${new Date(until).toISOString()}`);
      assert.equal(result.timedOut, undefined);
    }
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; cancelTask(t.id); delete getLimits().providers[provider]; }
});

test('L14: park timer re-polls before requeueing and preserves an indefinite provider block', async (ctx) => {
  const { getLimits, modelBlockedUntil } = await import('../core/limits.mjs');
  const { bus } = await import('../core/bus.mjs');
  const provider = 'w1-park-poll', timers = [];
  getLimits().providers[provider] = { provider, blocked: true, windows: [] };
  ctx.mock.method(globalThis, 'setTimeout', (fn) => { timers.push(fn); return { unref() {} }; });
  const poll = Promise.withResolvers();
  const polls = [];
  PROVIDERS[provider] = { id: provider, pollLimits: () => { polls.push(provider); return poll.promise; } };
  const t = createTask({ cwd: tmpDir('park-poll'), provider });
  const events = [];
  const onTask = (e) => { if (e.type === 'task' && e.task.id === t.id) events.push(e.task.status); };
  bus.on('event', onTask);
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    assert.equal(t.status, 'parked');
    const checking = timers.shift()();
    assert.deepEqual(polls, [provider]);
    assert.equal(t.status, 'parked', 'must await the refresh');
    poll.resolve({ provider, blocked: true, windows: [] });
    await checking;
    assert.deepEqual(events, ['parked', 'queued', 'parked']);
    assert.ok(modelBlockedUntil(provider) > Date.now());
    assert.equal(getLimits().providers[provider].blockedUntil, null, 'no invented expiration for an indefinite block');
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; poll.resolve({ provider, blocked: true, windows: [] }); cancelTask(t.id); delete PROVIDERS[provider]; delete getLimits().providers[provider]; bus.off('event', onTask); }
});

test('L52: describeTask uses all counted actions including MCP calls beyond the journal tail', async () => {
  const { countTools } = await import('../core/tasks.mjs');
  const items = Array.from({ length: 41 }, () => ({ type: 'mcp_tool_call', server: 'data', tool: 'read' })); // one beyond the journal's 40-item tail
  const t = { id: 'actions', status: 'done', title: 'x', provider: 'test', rounds: 0, result: { items: items.slice(-40), tools: countTools(items) } };
  assert.match(describeTask(t), /Actions: 41 commands\/tool calls/);
});

test('I9: openTasks returns every non-terminal state without the list limit', () => {
  const cwd = tmpDir('open-tasks');
  const batch = ['queued', 'running', 'parked', 'done', 'failed', 'canceled'].map((status) => {
    const t = createTask({ cwd }); t.status = status; return t;
  });
  try {
    assert.deepEqual(openTasks().filter((t) => t.cwd === cwd).map((t) => t.status), ['queued', 'running', 'parked']);
  } finally { for (const t of batch) cancelTask(t.id); }
});

for (const scenario of [
  { name: 'short 429', minutes: 15, remaining: 60_000, failover: false },
  { name: 'threshold boundary', minutes: 15, remaining: 15 * 60_000, failover: false },
  { name: 'long block', minutes: 15, remaining: 15 * 60_000 + 1, failover: true },
  { name: 'disabled', minutes: 0, remaining: 15 * 60_000 + 1, failover: false },
  { name: 'no alternative', minutes: 15, remaining: 15 * 60_000 + 1, failover: false, unavailable: true },
]) test(`L6: queued failover respects ${scenario.name} and dispatches after collecting replacements`, async (ctx) => {
  const { loadConfig, saveConfig } = await import('../core/config.mjs');
  const { getLimits } = await import('../core/limits.mjs');
  const { recordRun, rateTask } = await import('../core/scorecard.mjs');
  const { bus } = await import('../core/bus.mjs');
  const previous = loadConfig(), provider = 'l6-blocked', model = 'l6-alternative';
  const now = Date.now(); ctx.mock.method(Date, 'now', () => now);
  saveConfig({ worker: { failoverAfterBlockMinutes: scenario.minutes }, scorecard: { minSamples: 1, classOrder: ['free'] } });
  registryModels(ctx, scenario.unavailable ? [] : [{ provider: 'ollama', id: model, kind: 'agent', cost: 'free-local' }]);
  recordRun({ id: `l6-seed-${scenario.name}`, status: 'done', provider: 'ollama', model, category: 'review', difficulty: 2, result: { usage: { input_tokens: 1, output_tokens: 1 } } });
  rateTask(`l6-seed-${scenario.name}`, 'pass');
  getLimits().providers[provider] = { provider, blocked: true, blockedUntil: now + scenario.remaining, windows: [] };
  const tk = await tasksWithWorker(ctx, async () => ({ ok: true }));
  const batch = ['first', 'second'].map((title) => tk.createTask({ cwd: tmpDir('l6'), provider, title, spec: 'x', category: 'review', difficulty: 2 }));
  const waiting = batch.map((t) => tk.awaitTask(t.id));
  const statesAtDispatch = [];
  const onTask = (e) => {
    if (e.type === 'task' && e.task.status === 'running' && batch.some((t) => t.id === e.task.retryOf)) statesAtDispatch.push(batch.map((t) => t.status));
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
      assert.deepEqual(replacements.map((t) => t.retryOf), batch.map((t) => t.id));
      assert.ok(replacements.every((t) => t.provider === 'ollama' && t.model === model));
      for (const done of await Promise.all(replacements.map((t) => tk.awaitTask(t.id)))) assert.equal(done.status, 'done');
    } else assert.ok(batch.every((t) => !t.failedOverTo && t.resumeAt === now + scenario.remaining));
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    bus.off('event', onTask);
    for (const t of batch) tk.cancelChain(t.id);
    await tk.flushRecords();
    delete getLimits().providers[provider];
    saveConfig({ worker: previous.worker, scorecard: previous.scorecard });
  }
});

for (const joined of [false, true]) test(`P11: task accounting ${joined ? 're-polls after joining an earlier poll' : 'uses one newly started poll'}`, async (ctx) => {
  const { refreshLimits, getLimits } = await import('../core/limits.mjs');
  const { runRows } = await import('../core/scorecard.mjs');
  const provider = `p11-${joined}`, finish = Promise.withResolvers();
  const initial = { provider, blocked: false, windows: [{ id: 'budget', usedPercent: 10 }] };
  const updated = { provider, blocked: false, windows: [{ id: 'budget', usedPercent: 20 }] };
  getLimits().providers[provider] = initial;
  let polls = 0;
  PROVIDERS[provider] = { id: provider, pollLimits: () => ++polls === 1 ? finish.promise : updated };
  const tk = await tasksWithWorker(ctx, async () => ({ ok: true }));
  const old = joined ? refreshLimits({ only: [provider] }) : null;
  const t = tk.createTask({ cwd: tmpDir('p11-score'), provider, spec: 'x' });
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    assert.equal((await tk.awaitTask(t.id)).status, 'done');
    assert.equal(polls, 1);
    assert.ok(!runRows().some((r) => r.taskId === t.id));
    finish.resolve(joined ? initial : updated);
    await tk.flushRecords();
    assert.equal(polls, joined ? 2 : 1);
    assert.deepEqual(runRows().find((r) => r.taskId === t.id).pct, { budget: 10 });
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1'; finish.resolve(updated);
    await old; await tk.flushRecords();
    delete PROVIDERS[provider]; delete getLimits().providers[provider];
  }
});
