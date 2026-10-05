import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, mockCompletions, createTask, cancelTask, awaitTask, getTask, schedule, abortRunning, awaitRunning, setDraining, tasksWithGit, tasksWithWorker } from './_helpers.mjs';

test('recovery keeps a long interrupted task whose watchdog aliveAt is recent', async () => {
  const { recoverTasks } = await import('../../core/tasks.mjs');
  const { writeJson } = await import('../../core/paths.ts');
  const id = 'alive-recovery', now = Date.now();
  writeJson(join(HOME, 'tasks', `${id}.json`), {
    id, sessionId: 'alive-recovery-session', cwd: tmpDir('alive-recovery'), title: 'long run', spec: 'x', provider: 'codex', model: 'gpt-6-astra',
    status: 'running', attempts: 1, createdAt: new Date(now - 8 * 3_600_000).toISOString(),
    updatedAt: new Date(now - 7 * 3_600_000).toISOString(), aliveAt: new Date(now - 10 * 60_000).toISOString(),
  });
  const summary = recoverTasks();
  const recovered = getTask(id);
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.resume, true);
  assert.deepEqual(summary.bySession['alive-recovery-session'], [{ id, status: 'resumed' }]);
  cancelTask(id);
});

test('graceful shutdown requeues in-flight tasks instead of failing them', async (ctx) => {
  let diskAtAbort; const entered = Promise.withResolvers();
  mockCompletions(ctx, async (_url, { signal }) => { entered.resolve(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => {
    diskAtAbort = JSON.parse(readFileSync(join(HOME, 'tasks', `${t.id}.json`), 'utf8'));
    reject(new Error('aborted'));
  }, { once: true }); }); });
  const t = createTask({ cwd: tmpDir('requeue'), provider: 'deepseek' });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    await entered.promise;
    assert.equal(getTask(t.id).status, 'running');
    abortRunning({ requeue: true });
    assert.equal(diskAtAbort.status, 'queued', 'the journal transition is durable before abort is signaled');
    assert.equal(diskAtAbort.resume, true);
    assert.ok(diskAtAbort.interruptedAt);
    await new Promise((r) => setTimeout(r, 100));
    const after = getTask(t.id);
    assert.equal(after.status, 'queued');
    assert.equal(after.resume, true);
    assert.ok(after.interruptedAt);
    assert.equal(after.recoveries, undefined, 'graceful requeue does not count as a crash recovery');
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
  const lim = await import('../../core/limits.mjs'); delete lim.getLimits().providers.deepseek;
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

test('recoveries reset when a worker run finishes', async (ctx) => {
  const tk = await tasksWithWorker(ctx, async () => ({ ok: true, finalMessage: 'done' }));
  const t = tk.createTask({ cwd: tmpDir('recoveries-finish'), provider: 'codex' }, { dispatch: false });
  t.recoveries = 2;
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    tk.schedule();
    assert.equal((await tk.awaitTask(t.id, 5000)).status, 'done');
    assert.equal(t.recoveries, 0);
    await tk.flushRecords();
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; tk.cancelTask(t.id); }
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

test('draining leaves queued work undispatched and scheduling resumes when draining clears', () => {
  const t = createTask({ cwd: tmpDir('draining-gate'), provider: 'missing-test-provider' }, { dispatch: false });
  const previous = process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    abortRunning();
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    setDraining(true); schedule();
    assert.equal(t.status, 'queued');
    assert.equal(t.attempts, 0);
    setDraining(false); schedule();
    assert.equal(t.status, 'running');
  } finally {
    setDraining(false); abortRunning(); cancelTask(t.id);
    if (previous === undefined) delete process.env.CONDUCTOR_NO_SCHEDULE; else process.env.CONDUCTOR_NO_SCHEDULE = previous;
  }
});

test('stale tasks return immediately from awaitTask and never enter the scheduler', async (ctx) => {
  let calls = 0;
  const tk = await tasksWithWorker(ctx, async () => { calls++; return { ok: true, finalMessage: 'done' }; });
  const t = tk.createTask({ cwd: tmpDir('stale-task'), spec: 'wait' }, { dispatch: false });
  t.status = 'stale'; t.recoveries = 2;
  assert.equal(tk.openTasks().some((task) => task.id === t.id), false);
  assert.equal(tk.openTaskCount(), 0);
  const result = await tk.awaitTask(t.id, 60_000);
  assert.equal(result.status, 'stale');
  assert.equal(result.timedOut, undefined);
  assert.match(tk.describeTask(t), /Stale: interrupted by 2 restarts in a row\. Ask the user to Re-run or Discard it\./);
  const previous = process.env.CONDUCTOR_NO_SCHEDULE;
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    tk.schedule();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(t.status, 'stale');
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_NO_SCHEDULE;
    else process.env.CONDUCTOR_NO_SCHEDULE = previous;
    tk.cancelTask(t.id);
  }
});

test('R25: shutdown drain awaits a task that settles quickly instead of exiting before it', async (ctx) => {
  const cwd = tmpDir('r25-drain');
  let workerFinished = false;
  const tk = await tasksWithWorker(ctx, async () => {
    await new Promise((r) => setTimeout(r, 50));
    workerFinished = true;
    return { ok: true, finalMessage: 'fast worker' };
  });
  const t = tk.createTask({ cwd, provider: 'codex', title: 'r25-quick-settle', spec: 'x' });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    tk.schedule();
    // Worker starts, then shutdown begins: signal abort and awaitRunning
    await new Promise((r) => setTimeout(r, 10));
    tk.abortRunning({ requeue: true });
    await tk.awaitRunning(1200);
    assert.equal(workerFinished, true, 'fast task settled before drain finished');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    tk.cancelTask(t.id);
  }
});
