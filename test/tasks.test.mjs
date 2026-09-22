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

const { createTask, cancelTask, awaitTask, getTask, listTasks, describeTask, publicTask, schedule, abortRunning, flushRecords } = await import('../core/tasks.mjs');
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
      Object.assign(t, { status: 'done', threadId: 'wait-thread' });
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
  childProcess.execFile = Object.assign(() => { throw new Error('expected promisified execFile'); }, { [promisify.custom]: exec });
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
    for (const cwd of dirs) assert.deepEqual(calls.filter((c) => c.cwd === cwd).map((c) => c.args[0]), ['status', 'ls-tree', 'status', 'diff', 'diff']);
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
