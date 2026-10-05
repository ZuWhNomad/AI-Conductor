import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, createTask, cancelTask, failHungTask, cancelChain, awaitTask, getTask, listTasks, openTasks, describeTask, publicTask, taskSummary, bus, getModels, registryModels, tasksWithWorker } from './_helpers.mjs';

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

test('createTask resolves Claude aliases to exact registry ids and preserves unknown ids', (t) => {
  const cwd = tmpDir('claude-alias');
  registryModels(t, [
    { provider: 'claude', id: 'claude-opus-5-5[1m]', aliasOf: ['opus', 'opus[1m]'] },
    { provider: 'claude', id: 'claude-sonnet-5', aliasOf: ['sonnet'] },
    { provider: 'claude', id: 'claude-haiku-5', aliasOf: ['haiku', 'default'] },
  ]);
  for (const [alias, exact] of [['opus', 'claude-opus-5-5[1m]'], ['opus[1m]', 'claude-opus-5-5[1m]'], ['sonnet', 'claude-sonnet-5'], ['haiku', 'claude-haiku-5'], ['default', 'claude-haiku-5']]) {
    assert.equal(createTask({ cwd, provider: 'claude', model: alias, spec: 'x' }, { dispatch: false }).model, exact);
  }
  assert.equal(createTask({ cwd, provider: 'claude', model: 'claude-opus-4-6', spec: 'x' }, { dispatch: false }).model, 'claude-opus-4-6');
});

test('watchdog hang failure is terminal, labeled hung and journaled', () => {
  const t = createTask({ cwd: tmpDir('hung-task'), title: 'hung', spec: 'wait' }, { dispatch: false });
  t.status = 'running';
  const failed = failHungTask(t.id, 'watchdog fixture');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failKind, 'hung');
  assert.equal(failed.error, 'watchdog fixture');
  const disk = JSON.parse(readFileSync(join(HOME, 'tasks', `${t.id}.json`), 'utf8'));
  assert.equal(disk.failKind, 'hung');
});

test('task ID collisions regenerate without overwriting existing journals', async (ctx) => {
  const { writeJson } = await import('../../core/paths.mjs');
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
  const t = createTask({ cwd: tmpDir('t2'), title: 'slow', spec: 'x', provider: 'deepseek', model: 'deepseek-chat' });
  const r = await awaitTask(t.id, 50);
  assert.equal(r.timedOut, true);
  assert.equal(r.status, 'queued');
  cancelTask(t.id);
});

test('task waits use the run timeout when set and otherwise use the 55 minute soft-wait default', async (ctx) => {
  const { loadConfig, saveConfig, DEFAULTS } = await import('../../core/config.mjs');
  const { conductorToolDefs } = await import('../../core/tools.mjs');
  const previous = loadConfig().worker;
  const waits = [];
  ctx.mock.method(globalThis, 'setTimeout', (fn, ms) => { waits.push(ms); queueMicrotask(fn); return {}; });
  const cwd = tmpDir('wait-defaults');
  const defs = conductorToolDefs({ sessionId: 'waits', cwd });
  const call = (name, args) => defs.find((d) => d.name === name).handler(args);
  try {
    const modeling = createTask({ cwd, category: 'modeling' });
    assert.equal((await awaitTask(modeling.id)).timedOut, true);
    assert.equal(waits.pop(), 55 * 60_000);
    const cappedDefs = conductorToolDefs({ sessionId: 'wait-cap', cwd, maxBlockMs: 59 * 60_000 });
    await cappedDefs.find((d) => d.name === 'await_task').handler({ task_id: modeling.id });
    assert.equal(waits.pop(), 55 * 60_000, 'the MCP ceiling does not replace the 55 minute default');
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

test('follow-up errors carry client status codes', () => {
  const cwd = tmpDir('follow-status');
  assert.throws(() => createTask({ cwd, spec: 'x', followUpOf: 'nope' }), { status: 404 });
  const parent = createTask({ cwd, spec: 'x' });
  parent.status = 'done';
  assert.throws(() => createTask({ cwd, spec: 'x', followUpOf: parent.id }), { status: 400, message: /no resumable thread/ });
});

test('createTask strips an effort a model cannot honor (Method C guard D)', async () => {
  const cwd = tmpDir('guard-d');
  const { getModels } = await import('../../core/models.mjs');
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

test('awaitTask is clamped to the Node timer maximum and worker run caps use the shared zero-aware helper', async (ctx) => {
  const waits = [];
  ctx.mock.method(globalThis, 'setTimeout', (fn, ms) => { waits.push(ms); queueMicrotask(fn); return {}; });
  const queued = createTask({ cwd: tmpDir('e8-await'), spec: 'x' });
  await awaitTask(queued.id, 2 ** 40);
  cancelTask(queued.id);
  assert.equal(waits.at(-1), 2 ** 31 - 1);

  // Config clamps timeoutMinutes to 1440, so the worker path cannot be driven past 2^31-1 through saveConfig.
  // Assert the runWorker call site still applies the same clamp to whatever minutes loadConfig returns.
  const src = readFileSync(new URL('../../core/tasks.mjs', import.meta.url), 'utf8');
  assert.match(src, /const timeoutMs = runTimeoutMs\(wcfg\.timeoutByCategory\[t\.category\] \?\? wcfg\.timeoutMinutes\)/);
  assert.match(src, /\.\.\.\(timeoutMs \? \{ timeoutMs \} : \{\}\)/);
});

test('a running task shows a coarse progress snapshot, refreshed at most once a minute', async (ctx) => {
  const { bus } = await import('../../core/bus.mjs');
  const finish = Promise.withResolvers(), started = Promise.withResolvers();
  const tk = await tasksWithWorker(ctx, (t) => { started.resolve(t.id); return finish.promise; });
  const t = tk.createTask({ cwd: tmpDir('progress'), provider: 'codex', spec: 'x' });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  await started.promise;
  assert.match(tk.describeTask(tk.getTask(t.id)), /Progress: running 0 min; no worker activity yet/);
  const item = (command) => bus.publish('worker', { taskId: t.id, provider: 'codex', event: 'item', item: { type: 'command_execution', command } });
  item('npm test');
  bus.publish('worker', { taskId: t.id, provider: 'codex', event: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 34 } });
  assert.match(tk.describeTask(tk.getTask(t.id)), /last: npm test \(as of 0 min ago\)/);
  item('npm run build'); // within the minute: the snapshot stays put
  assert.doesNotMatch(tk.describeTask(tk.getTask(t.id)), /npm run build/);
  tk.getTask(t.id).progress.at -= 61_000; // a minute later, the next event refreshes it with everything seen since
  item('git diff');
  assert.match(tk.describeTask(tk.getTask(t.id)), /last: git diff; 1234 tokens so far/);
  finish.resolve({ ok: true, finalMessage: 'done' });
  const done = await tk.awaitTask(t.id);
  assert.equal(done.progress, undefined, 'the snapshot is dropped when the result lands');
});

test('writable_roots must be existing absolute directories; follow-ups inherit them', () => {
  const cwd = tmpDir('roots'), sibling = tmpDir('roots-sibling');
  for (const bad of ['relative/dir', join(sibling, 'missing'), 42]) assert.throws(() => createTask({ cwd, spec: 'x', writableRoots: [bad] }), (e) => e.status === 400);
  assert.throws(() => createTask({ cwd, spec: 'x', writableRoots: sibling }), (e) => e.status === 400);
  const t = createTask({ cwd, spec: 'x', writableRoots: [sibling, sibling] });
  assert.deepEqual(t.writableRoots, [sibling]);
  const plain = createTask({ cwd, spec: 'y' });
  assert.deepEqual(plain.writableRoots, []);
  cancelTask(plain.id);
  Object.assign(t, { status: 'done', threadId: `thread-${t.id}` });
  const follow = createTask({ followUpOf: t.id, spec: 'fix' });
  assert.deepEqual(follow.writableRoots, [sibling]);
  cancelTask(follow.id);
});

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

test('P8: lists and task events omit bulky results while the full record preserves them', async () => {
  const { bus } = await import('../../core/bus.mjs');
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
    assert.equal(taskSummary({ ...t, spec: 'x'.repeat(400) }).specPreview, 'x'.repeat(120));
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

test('L52: describeTask uses all counted actions including MCP calls beyond the journal tail', async () => {
  const { countTools } = await import('../../core/tasks.mjs');
  const items = Array.from({ length: 41 }, () => ({ type: 'mcp_tool_call', server: 'data', tool: 'read' })); // one beyond the journal's 40-item tail
  const t = { id: 'actions', status: 'done', title: 'x', provider: 'test', rounds: 0, result: { items: items.slice(-40), tools: countTools(items) } };
  assert.match(describeTask(t), /Actions: 41 commands\/tool calls/);
});

test('I9: openTasks returns every open state except restart-stale tasks without the list limit', () => {
  const cwd = tmpDir('open-tasks');
  const batch = ['queued', 'running', 'parked', 'stale', 'done', 'failed', 'canceled'].map((status) => {
    const t = createTask({ cwd }); t.status = status; return t;
  });
  try {
    assert.deepEqual(openTasks().filter((t) => t.cwd === cwd).map((t) => t.status), ['queued', 'running', 'parked']);
  } finally { for (const t of batch) cancelTask(t.id); }
});

test('createTask accepts difficulty 1-7 and clamps out-of-range to null', () => {
  const dir = tmpDir('difficulty-range');
  const t6 = createTask({ cwd: dir, provider: 'codex', model: 'gpt-6-astra', spec: 'x', category: 'implement', difficulty: 6 });
  const t7 = createTask({ cwd: dir, provider: 'codex', model: 'gpt-6-astra', spec: 'x', category: 'implement', difficulty: 7 });
  const t8 = createTask({ cwd: dir, provider: 'codex', model: 'gpt-6-astra', spec: 'x', category: 'implement', difficulty: 8 });
  const t0 = createTask({ cwd: dir, provider: 'codex', model: 'gpt-6-astra', spec: 'x', category: 'implement', difficulty: 0 });
  assert.equal(t6.difficulty, 6);
  assert.equal(t7.difficulty, 7);
  assert.equal(t8.difficulty, null);
  assert.equal(t0.difficulty, null);
  for (const t of [t6, t7, t8, t0]) cancelTask(t.id);
});
