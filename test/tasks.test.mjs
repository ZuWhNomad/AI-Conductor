import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const { createTask, cancelTask, awaitTask, getTask, listTasks, describeTask, publicTask, schedule, abortRunning } = await import('../core/tasks.mjs');

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

test('awaitTask times out with a snapshot', async () => {
  const t = createTask({ cwd: tmpDir('t2'), title: 'slow', spec: 'x', provider: 'ollama', model: 'qwen3.8' });
  const r = await awaitTask(t.id, 50);
  assert.equal(r.timedOut, true);
  assert.equal(r.status, 'queued');
  cancelTask(t.id);
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
  ctx.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
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
  ctx.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
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
  const { writeJson } = await import('../core/paths.mjs');
  writeJson(join(HOME, 'models.json'), { updatedAt: 'x', providers: {}, models: [{ provider: 'ollama', id: 'qwen', kind: 'agent', cost: 'free-local' }] });
  saveConfig({ providers: { deepseek: { apiKey: 'test-key' } }, scorecard: { minSamples: 1 } });
  for (let i = 0; i < 2; i++) { const id = `fo${i}`; recordRun({ id, title: 't', status: 'done', provider: 'ollama', model: 'qwen', effort: null, category: 'review', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } }); rateTask(id, 'pass'); }
  ctx.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429, headers: { 'retry-after': '60' } }));
  const cwd = tmpDir('failover');
  const t = createTask({ sessionId: 'fo', cwd, title: 'review it', spec: 'x', provider: 'deepseek', model: 'deepseek-flash', category: 'review', difficulty: 2 });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  let done;
  try { schedule(); done = await awaitTask(t.id, 15000); } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; }
  assert.equal(done.status, 'failed');
  assert.match(done.error, /failed over to task/);
  const next = getTask(done.failedOverTo);
  assert.equal(next.provider, 'ollama');
  assert.equal(next.retryOf, t.id);
  assert.match(describeTask(getTask(t.id)), /Failed over to task/);
  cancelTask(next.id);
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => a.taskId === t.id)), 'the cut-off attempt is not in the ledger');
  saveConfig({ scorecard: { minSamples: 3 } });
});

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

test('dispatch is not serialized on git: two tasks are running before the first git read resolves', async (ctx) => {
  const { findCli } = await import('../core/proc.mjs');
  const { execFileSync } = await import('node:child_process');
  const git = findCli('git'); if (!git) return;
  const dirs = [tmpDir('inter-a'), tmpDir('inter-b')];
  for (const d of dirs) execFileSync(git, ['init', '--quiet'], { cwd: d, windowsHide: true });
  const starts = [];
  ctx.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => { starts.push(Date.now()); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }));
  const lim = await import('../core/limits.mjs'); delete lim.getLimits().providers.deepseek; // an earlier test may have left it blocked
  const batch = dirs.map((cwd) => createTask({ cwd, provider: 'deepseek', spec: 'x' }));
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    schedule();
    assert.deepEqual(batch.map((t) => getTask(t.id).status), ['running', 'running']); // both flipped synchronously; neither waited for the other's git status
    for (let i = 0; i < 100 && starts.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(starts.length, 2);
  } finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; abortRunning(); for (const t of batch) cancelTask(t.id); }
});
