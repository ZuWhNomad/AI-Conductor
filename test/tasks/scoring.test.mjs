import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PROVIDERS, git, findCli, mockCompletions, createTask, cancelTask, awaitTask, schedule, tasksWithWorker } from './_helpers.mjs';

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
    const { listImprovements } = await import('../../core/improve.mjs');
    assert.ok(listImprovements().some((i) => /journal persist failed after done/.test(i.message)));
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    delete t.circular;
    cancelTask(t.id);
  }
});

test('claimed writes gitignore hides are not phantom when the file landed on disk', async (ctx) => {
  const { findCli } = await import('../../core/proc.mjs');
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
  const tk = await import(`../../core/tasks.mjs?g5=${encodeURIComponent(ctx.name)}`);
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

for (const [id, provider] of [['L1', 'codex'], ['L4', 'claude']]) {
  test(`${id}: a successful worker with limitHit completes and is scored without a limit refresh`, async (ctx) => {
    const { getLimits } = await import('../../core/limits.mjs');
    const { runRows } = await import('../../core/scorecard.mjs');
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

test('an auth failure is never scored, and the echoed key never reaches the journal or the improvement log', async (ctx) => {
  const { runRows } = await import('../../core/scorecard.mjs');
  const { statePath } = await import('../../core/paths.mjs');
  const echo = 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac*************************fvMA.';
  const tk = await tasksWithWorker(ctx, async () => ({ ok: false, authFailed: true, error: echo, usage: { input_tokens: 0, output_tokens: 0 } }));
  const t = tk.createTask({ cwd: tmpDir('auth'), provider: 'codex', spec: 'x', category: 'edit', difficulty: 2 });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  await tk.flushRecords();
  assert.equal(done.status, 'failed');
  assert.equal(done.failKind, 'auth');
  assert.equal(done.failedOverTo, undefined, 'not a limit: no failover');
  assert.ok(!runRows().some((r) => r.taskId === t.id), 'no scorecard row');
  for (const f of [statePath('tasks', `${t.id}.json`), statePath('improvements.ndjson')]) assert.doesNotMatch(readFileSync(f, 'utf8'), /sk-svcac|fvMA/, f);
});

test('an environment failure (grok plan-mode cancel) is recorded but never scored', async (ctx) => {
  const { runRows } = await import('../../core/scorecard.mjs');
  const tk = await tasksWithWorker(ctx, async () => ({ ok: false, envFailed: true, error: "error_during_execution: grok's read-only (plan) mode cancelled the write call and ended the turn (environment failure, not scored)", usage: { input_tokens: 75542, output_tokens: 10084 } }));
  const t = tk.createTask({ cwd: tmpDir('env'), provider: 'grok', spec: 'x', category: 'search', difficulty: 3, sandbox: 'read-only' });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  await tk.flushRecords();
  assert.deepEqual([done.status, done.failKind, done.envFailed, done.authFailed], ['failed', 'env', true, false]);
  assert.equal(done.failedOverTo, undefined);
  assert.ok(!runRows().some((r) => r.taskId === t.id), 'no scorecard row');
});

test('a plain worker 503 failure is classified as environment and is not scored', async (ctx) => {
  const { runRows } = await import('../../core/scorecard.mjs');
  const tk = await tasksWithWorker(ctx, async () => ({ ok: false, error: '503 UNAVAILABLE', usage: { input_tokens: 0, output_tokens: 0 } }));
  const t = tk.createTask({ cwd: tmpDir('env-503'), provider: 'codex', spec: 'x', category: 'edit', difficulty: 2 });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  await tk.flushRecords();
  assert.deepEqual([done.status, done.failKind, done.envFailed], ['failed', 'env', true]);
  assert.equal(done.error, 'environment: 503 UNAVAILABLE');
  assert.ok(!runRows().some((r) => r.taskId === t.id), 'no scorecard row');
});

test('a plain worker failure still writes a scorecard row', async (ctx) => {
  const { runRows } = await import('../../core/scorecard.mjs');
  const tk = await tasksWithWorker(ctx, async () => ({ ok: false, error: 'tests failed', usage: { input_tokens: 3, output_tokens: 1 } }));
  const t = tk.createTask({ cwd: tmpDir('model-failure'), provider: 'codex', spec: 'x', category: 'edit', difficulty: 2 });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  await tk.flushRecords();
  assert.equal(done.status, 'failed');
  assert.equal(done.failKind, undefined);
  assert.ok(runRows().some((r) => r.taskId === t.id), 'scorecard row');
});

for (const joined of [false, true]) test(`P11: task accounting ${joined ? 're-polls after joining an earlier poll' : 'uses one newly started poll'}`, async (ctx) => {
  const { refreshLimits, getLimits } = await import('../../core/limits.mjs');
  const { runRows } = await import('../../core/scorecard.mjs');
  const provider = `p11-${joined}`, finish = Promise.withResolvers();
  const initial = { provider, blocked: false, windows: [{ id: 'budget', usedPercent: 10 }] };
  const updated = { provider, blocked: false, windows: [{ id: 'budget', usedPercent: 20 }] };
  getLimits().providers[provider] = initial;
  let polls = 0;
  PROVIDERS[provider] = { id: provider, pollLimits: () => ++polls === 1 ? finish.promise : updated };
  const tk = await tasksWithWorker(ctx, async () => ({ ok: true, finalMessage: 'ok' }));
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

test('a worker that ends ok with no report and no file change fails as an empty report, not done', async (ctx) => {
  const tk = await tasksWithWorker(ctx, async () => ({ ok: true, finalMessage: '  ', usage: { input_tokens: 3, output_tokens: 1 }, durationMs: 5 }));
  const gitBin = findCli('git');
  if (!gitBin) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('empty-report');
  childProcess.execFileSync(gitBin, ['init', '--quiet'], { cwd, windowsHide: true });
  const t = tk.createTask({ cwd, provider: 'codex', spec: 'x' });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.failKind, 'empty');
  assert.match(done.error, /empty report/);
});

test('R24: a persist that fails once then succeeds ends with the terminal status on disk', async (ctx) => {
  const cwd = tmpDir('r24-retry');
  let firstPersistFailed = false;
  const originalWriteFileSync = fs.writeFileSync;
  const tk = await tasksWithWorker(ctx, async () => ({ ok: true, finalMessage: 'done' }));
  const t = tk.createTask({ cwd, provider: 'codex', title: 'r24-persist-retry', spec: 'x' }, { dispatch: false });
  const taskFile = join(HOME, 'tasks', `${t.id}.json`);

  ctx.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
    if (typeof file === 'string' && file.startsWith(taskFile) && !firstPersistFailed) {
      const parsed = JSON.parse(typeof data === 'string' ? data : data.toString());
      if (parsed.status === 'done') {
        firstPersistFailed = true;
        throw new Error('disk transient failure');
      }
    }
    return originalWriteFileSync(file, data, ...args);
  });
  syncBuiltinESMExports();

  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    tk.schedule();
    const done = await tk.awaitTask(t.id, 5000);
    assert.equal(done.status, 'done');
    assert.equal(firstPersistFailed, true, 'first terminal persist attempt threw');

    // Wait for the scheduled retry (50ms) to land on disk
    for (let i = 0; i < 20; i++) {
      const onDisk = JSON.parse(readFileSync(taskFile, 'utf8'));
      if (onDisk.status === 'done') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const finalDisk = JSON.parse(readFileSync(taskFile, 'utf8'));
    assert.equal(finalDisk.status, 'done');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    tk.cancelTask(t.id);
  }
});
