import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME, readJson, writeJson, statePath, saveConfig, loadConfig, bus, setSessionFlags, createTask, getTask,
  validatePlan, findingsOf, findingKey, parseVerdict, tally, expandStage, runPlan, abortPlans, getPlan, buildPrompt,
  calls, pick, handler, attempt, delegate, conductorToolDefs, selOf,
} from './_helpers.mjs';

test('plan IDs avoid persisted journals and simultaneous active plans', async (ctx) => {
  const diskId = (0.125).toString(36).slice(2, 10), file = statePath('plans', `${diskId}.json`);
  const old = { id: diskId, goal: 'keep this plan', status: 'done' };
  writeJson(file, old);
  const samples = [0.125, 0.25, 0.25, 0.375, 0.25, 0.375, 0.5];
  ctx.mock.method(Math, 'random', () => { assert.ok(samples.length); return samples.shift(); });
  const finish = Promise.withResolvers();
  const taskRuntime = { createTask: () => ({ id: 'stub' }), awaitTask: () => finish.promise };
  const plan = (goal) => ({ goal, stages: [{ id: 'work', tasks: [{ spec: goal }] }] });
  const seq = bus.seq;
  const first = runPlan(plan('first'), { taskRuntime });
  const second = runPlan(plan('second'), { taskRuntime });
  const started = bus.since(seq).filter((e) => e.type === 'plan' && e.kind === 'started');
  try {
    assert.equal(started.length, 2);
    assert.notEqual(started[0].planId, started[1].planId, 'active plans have no final journal yet');
  } finally { finish.resolve({ status: 'done', result: { finalMessage: 'done' } }); }
  const results = await Promise.all([first, second]);
  results.push(await runPlan(plan('third'), { taskRuntime }));
  assert.equal(new Set(results.map((r) => r.id)).size, results.length);
  assert.deepEqual(readJson(file), old);
  for (const out of results) assert.equal(readJson(statePath('plans', `${out.id}.json`)).goal, out.goal);
});

test('timeout snapshots persist an incomplete plan without findings or later stages', async (t) => {
  for (const failover of [false, true]) await t.test(failover ? 'parked replacement' : 'running original', async () => {
    const created = [];
    const seq = bus.seq;
    const taskRuntime = {
      createTask(input) { created.push(input); return { id: 'original' }; },
      async awaitTask(id) {
        if (failover && id === 'original') return { id, status: 'failed', failedOverTo: 'replacement' };
        return { id, status: failover ? 'parked' : 'running', timedOut: true, result: { finalMessage: '```json\n{"findings":[{"title":"Unfinished output"}]}\n```' } };
      },
      getTask() { assert.fail('do not discard timeout snapshots'); },
    };
    const out = await runPlan({ stages: [
      { id: 'find', tasks: [{ spec: 'find' }] },
      { id: 'later', tasks: [{ spec: 'must not start' }] },
    ], until_dry: { stage: 'find', max_rounds: 3, dry_rounds: 2 } }, { taskRuntime });
    assert.equal(created.length, 1);
    assert.equal(out.status, 'incomplete');
    assert.equal(out.stages.find.incomplete, true);
    assert.equal(out.stages.find.tasks[0].timedOut, true);
    assert.deepEqual(out.stages.find.findings, []);
    assert.equal(out.stages.later, undefined);
    assert.match(out.report, /Incomplete: stage deadline reached/);
    assert.doesNotMatch(out.report, /Unfinished output/);
    const saved = readJson(statePath('plans', `${out.id}.json`));
    assert.equal(saved.status, 'incomplete');
    assert.deepEqual(saved.stages, out.stages);
    assert.equal(saved.report, out.report);
    const events = bus.since(seq).filter((e) => e.planId === out.id);
    assert.equal(events.at(-1).kind, 'incomplete');
    assert.equal(events.some((e) => ['stage_done', 'done'].includes(e.kind)), false);
  });
});

test('an exhausted deadline does not grant a replacement a fresh wait', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const created = [], waited = [];
  const taskRuntime = {
    createTask(input) { created.push(input); return { id: 'original' }; },
    async awaitTask(id, timeoutMs) {
      waited.push(id);
      now += timeoutMs;
      return { id, status: 'failed', failedOverTo: 'replacement' };
    },
    getTask(id) { assert.equal(id, 'replacement'); return { id, status: 'running' }; },
  };
  const out = await runPlan({ timeout_minutes: 1, stages: [
    { id: 'find', tasks: [{ spec: 'find' }] },
    { id: 'later', tasks: [{ spec: 'must not start' }] },
  ] }, { taskRuntime });
  assert.equal(created.length, 1);
  assert.deepEqual(waited, ['original']);
  assert.equal(out.status, 'incomplete');
  assert.equal(out.stages.find.tasks[0].taskId, 'replacement');
  assert.equal(out.stages.find.tasks[0].timedOut, true);
});

test('run_plan forwards current session flags to recommendations and every task, and reports its persisted path', async (t) => {
  for (const enabled of [true, false]) await t.test(`flags ${enabled}`, async () => {
    const run = handler('run_plan');
    // Read flags at invocation, including changes made after the tool table was constructed.
    setSessionFlags('run_plan', { overflowApi: enabled, parallelOverride: enabled });
    calls.length = 0;
    const report = await run({ goal: 'fixture', stages: [
      { id: 'find', tasks: [{ spec: 'find', category: 'code' }] },
      { id: 'vote', for_each: 'find', votes: 2, task: { spec: 'vote', provider: 'stub', model: 'pinned' } },
      { id: 'fix', for_each: 'vote.confirmed', task: { spec: 'fix', category: 'code' } },
    ] });
    const id = /^Plan (\S+)/.exec(report)[1];
    const path = statePath('plans', `${id}.json`);
    assert.ok(report.endsWith(`Full record: ${path}`));
    const record = readJson(path);
    assert.equal(record.status, 'done');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.overflowApi === enabled));
    const tasks = Object.values(record.stages).flatMap((stage) => stage.tasks).map(({ id }) => readJson(statePath('tasks', `${id}.json`)));
    assert.equal(tasks.length, 4);
    for (const task of tasks) {
      assert.equal(task.overflowApi, enabled);
      assert.equal(task.parallelOverride, enabled);
      assert.equal(task.sessionId, 'run_plan');
    }
    assert.equal(tasks[0].model, 'next');
    assert.equal(tasks[1].model, 'pinned');
  });
});

test('timeout_minutes is bounded to 1440 at the tool schema and in runPlan', async () => {
  const defs = conductorToolDefs({ sessionId: 'e8', cwd: HOME });
  const cases = [
    ['delegate', { title: 't', spec: 's' }],
    ['follow_up', { task_id: 'x', comments: 'c' }],
    ['await_task', { task_id: 'x' }],
    ['run_plan', { goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x' }] }] }],
  ];
  for (const [name, required] of cases) {
    const schema = defs.find((d) => d.name === name).schema;
    schema.parse({ ...required, timeout_minutes: 1440 });
    assert.throws(() => schema.parse({ ...required, timeout_minutes: 1441 }), undefined, name);
    assert.throws(() => schema.parse({ ...required, timeout_minutes: 35792 }), undefined, name);
  }
  const waits = [];
  const out = await runPlan({ timeout_minutes: 35792, stages: [{ id: 'find', tasks: [{ spec: 'find' }] }] }, { taskRuntime: {
    createTask() { return { id: 't1' }; },
    async awaitTask(id, timeoutMs) { waits.push(timeoutMs); return { id, status: 'done', result: { finalMessage: 'ok' } }; },
    getTask() { assert.fail('use the awaitTask snapshot'); },
  } });
  assert.equal(out.status, 'done');
  assert.equal(waits[0], 1440 * 60_000);
});

test('GP: abortPlans cancels a real failover replacement and stops later stages', async () => {
  const { schedule, openTasks, cancelChain } = await import('../../core/tasks.mjs');
  const { saveConfig } = await import('../../core/config.mjs');
  const { getModels } = await import('../../core/models.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  const { recordRun, rateTask } = await import('../../core/scorecard.mjs');
  const previous = loadConfig(), reg = getModels(), saved = { models: reg.models, providers: reg.providers };
  for (const task of openTasks()) cancelChain(task.id);
  const provider = 'gp-abort-blocked', model = 'gp-abort-alternative', sessionId = 'gp-abort';
  reg.models = [{ provider: 'deepseek', id: model, kind: 'agent', cost: 'api' }];
  reg.providers = { deepseek: { status: 'ok' } };
  saveConfig({ scorecard: { minSamples: 1, classOrder: ['free'], classes: { deepseek: 'free' } } });
  recordRun({ id: 'gp-abort-seed', status: 'done', provider: 'deepseek', model, category: 'review', difficulty: 2, result: { usage: { input_tokens: 1, output_tokens: 1 } } });
  rateTask('gp-abort-seed', 'pass');
  getLimits().providers[provider] = { provider, blocked: true, blockedUntil: Date.now() + 60_000, windows: [] };
  let planId;
  // Observe the real scheduler's failover, then leave the replacement queued without launching a provider.
  const onTask = (e) => {
    if (e.type === 'task' && e.task.sessionId === sessionId && e.task.failedOverTo) process.env.CONDUCTOR_NO_SCHEDULE = '1';
  };
  bus.on('event', onTask);
  const pending = runPlan({ defaults: { provider, category: 'review', difficulty: 2 }, stages: [
    { id: 'a', tasks: [{ spec: 'review' }] },
    { id: 'b', tasks: [{ spec: 'must not start' }] },
  ] }, { sessionId, cwd: HOME, onId: (id) => { planId = id; } });
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    schedule();
    const original = getTask(getPlan(planId).taskIds[0]);
    const replacement = getTask(original.failedOverTo);
    assert.equal(original.status, 'failed');
    assert.equal(replacement.retryOf, original.retryOf);
    assert.equal(replacement.reroutedFrom, original.id);
    assert.equal(replacement.status, 'queued');
    await new Promise(setImmediate); // let the plan follow the replacement
    abortPlans(sessionId);
    assert.equal(replacement.status, 'canceled');
    const out = await pending;
    assert.equal(out.status, 'incomplete');
    assert.match(out.report, /aborted/);
    assert.equal(out.stages.b, undefined);
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    bus.off('event', onTask);
    for (const id of getPlan(planId)?.taskIds || []) cancelChain(id);
    await pending;
    delete getLimits().providers[provider]; Object.assign(reg, saved);
    saveConfig({ scorecard: previous.scorecard });
  }
});

test('X3: abortPlans cancels the current stage and does not dispatch later stages', async () => {
  const created = [];
  const hang = Promise.withResolvers();
  const pending = runPlan({ stages: [
    { id: 'a', tasks: [{ spec: 'one' }] },
    { id: 'b', tasks: [{ spec: 'must not start' }] },
  ] }, { sessionId: 'abort-me', taskRuntime: {
    createTask(input) { created.push(input); return { id: `t${created.length}` }; },
    async awaitTask(id) { await hang.promise; return { id, status: 'canceled' }; },
    getTask() { return { id: 't1', status: 'canceled' }; },
  } });
  await new Promise(setImmediate);
  assert.equal(created.length, 1);
  abortPlans('abort-me');
  hang.resolve();
  const out = await pending;
  assert.equal(out.status, 'incomplete');
  assert.match(out.report, /aborted/);
  assert.equal(out.stages.b, undefined);
  assert.equal(getPlan(out.id).status, 'incomplete');
});

test('L48: startedAt is captured first; for_each cannot target itself; until_dry rejects for_each', async () => {
  assert.throws(() => validatePlan({ stages: [{ id: 'a', for_each: 'a', task: { spec: 'x' } }] }), /unknown earlier stage/);
  assert.throws(() => validatePlan({ stages: [{ id: 'a', tasks: [{ spec: 'x' }] }, { id: 'v', for_each: 'a', task: { spec: 'y' } }], until_dry: { stage: 'v' } }), /for_each/);
  const out = await runPlan({ stages: [{ id: 'a', tasks: [{ spec: 'x' }] }] }, { taskRuntime: {
    createTask() { return { id: 't' }; },
    async awaitTask() { return { id: 't', status: 'done', result: { finalMessage: 'ok' } }; },
    getTask() { assert.fail('use terminal snapshots'); },
  } });
  assert.ok(out.startedAt);
  assert.ok(out.finishedAt);
  assert.ok(out.startedAt <= out.finishedAt);
});
