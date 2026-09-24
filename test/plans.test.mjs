import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, writeJson, statePath } from '../core/paths.mjs';
import { bus } from '../core/bus.mjs';

const { validatePlan, extractJson, findingsOf, findingKey, parseVerdict, tally, expandStage, runPlan, abortPlans, getPlan } = await import('../core/plans.mjs');

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

for (const loop of [false, true]) {
  test(`plan task cap preserves completed ${loop ? 'rounds' : 'stages'} and publishes incomplete`, async () => {
    const created = [];
    const taskRuntime = {
      createTask(input) { created.push(input); return { id: `cap-${created.length}` }; },
      async awaitTask(id) { return { id, status: 'done', result: { finalMessage: '```json\n' + JSON.stringify({ findings: Array.from({ length: loop ? 1 : 30 }, (_, i) => ({ title: `${id} finding ${i}` })) }) + '\n```' } }; },
    };
    // Existing MAX_TASKS=200: 30 findings * 7 votes overflows; 99 tasks fits twice after the seed, then overflows.
    const seq = bus.seq;
    const out = await runPlan({ stages: [
      { id: 'seed', tasks: [{ spec: 'seed' }] },
      loop ? { id: 'work', tasks: Array.from({ length: 99 }, () => ({ spec: 'find more' })) }
        : { id: 'work', for_each: 'seed', votes: 7, task: { spec: 'vote {{item}}' } },
      { id: 'later', tasks: [{ spec: 'must not run' }] },
    ], ...(loop ? { until_dry: { stage: 'work', max_rounds: 3 } } : {}) }, { taskRuntime });
    assert.equal(created.length, loop ? 199 : 1);
    assert.equal(out.status, 'incomplete');
    assert.equal(out.stages.seed.tasks[0].id, 'cap-1');
    assert.equal(out.stages.seed.findings.length, loop ? 1 : 30);
    assert.equal(out.stages.work.tasks.length, loop ? 198 : 0);
    assert.equal(out.stages.work.findings.length, loop ? 198 : 0);
    assert.equal(out.stages.later, undefined);
    assert.match(out.report, /Incomplete: plan exceeds 200 tasks/);
    assert.deepEqual(readJson(statePath('plans', `${out.id}.json`)).stages, out.stages);
    const events = bus.since(seq).filter((e) => e.planId === out.id);
    assert.equal(events.at(-1).kind, 'incomplete');
    assert.ok(events.some((e) => e.kind === 'stage_incomplete' && e.stage === 'work'));
  });
}

test('plan validation catches structural mistakes', () => {
  assert.throws(() => validatePlan({}), /stages/);
  assert.throws(() => validatePlan({ stages: [{ id: 'a', tasks: [{ spec: 'x' }] }, { id: 'a', tasks: [{ spec: 'y' }] }] }), /duplicate/);
  assert.throws(() => validatePlan({ stages: [{ id: 'v', for_each: 'find', task: { spec: 'x' } }] }), /unknown earlier stage/);
  assert.throws(() => validatePlan({ stages: [{ id: 'f', tasks: [{ spec: 'x' }] }, { id: 'v', for_each: 'f' }] }), /task template/);
  const p = validatePlan({ stages: [{ tasks: [{ spec: 'x' }] }, { id: 'v', for_each: 'stage1', task: { spec: 'y' }, votes: 99 }] });
  assert.equal(p.stages[0].id, 'stage1');
  assert.equal(p.stages[1].votes, 7);
});

test('findings and verdicts are read from JSON blocks, with sane fallbacks', () => {
  const report = 'Looked around.\n```json\n{"findings":[{"title":"Null deref","file":"a.js","line":3,"severity":"high"}]}\n```';
  const fs = findingsOf(report, 't1');
  assert.equal(fs.length, 1); assert.equal(fs[0].id, 't1-1'); assert.equal(fs[0].source, 't1');
  assert.equal(findingsOf('plain prose report', 't2')[0].title, 'plain prose report');
  assert.equal(findingsOf('', 't3').length, 0);
  assert.equal(findingKey({ file: 'A.JS', title: 'Null   deref' }), 'a.js|null deref');
  assert.deepEqual(extractJson('x {"a":1}'), { a: 1 });
  assert.equal(parseVerdict('```json\n{"real": false, "reason": "handled upstream"}\n```').real, false);
  assert.equal(parseVerdict('{"verdict":"confirmed"}').real, true);
  assert.equal(parseVerdict('{"score": 7}').real, true);
  assert.equal(parseVerdict('I could not reproduce it; refuted.').real, false);
  assert.equal(parseVerdict('Confirmed: reproduces with input 0.').real, true);
});

test('unfenced nested JSON extracts the outer object; a parsed object is not a prose verdict', () => {
  const nested = '{"findings":[{"title":"Null deref","file":"a.js","severity":"high"}]}';
  assert.equal(extractJson(nested).findings[0].title, 'Null deref');
  assert.equal(findingsOf(nested, 't4').length, 1);
  assert.equal(findingsOf(nested, 't4')[0].title, 'Null deref');
  const v = parseVerdict('{"real":false,"reason":"has {brace}"}');
  assert.equal(v.real, false);
  assert.match(v.reason, /brace/);
  assert.equal(parseVerdict('On a 12" screen it looks real. {"real":false,"reason":"not reproducible"}').real, false); // an odd prose quote
  const prose = parseVerdict('```json\n{"note":"this is real and confirmed"}\n```');
  assert.equal(prose.real, false);
  assert.match(prose.reason, /note/);
  assert.deepEqual(extractJson('x {"a":1}'), { a: 1 });
});

test('parseVerdict ignores incidental unfenced objects without verdict keys', () => {
  assert.equal(parseVerdict('Confirmed: real bug. `readJson(FILE(), {})` and move on.').real, true);
  assert.equal(parseVerdict('{"real": true, "reason": "x"}\nNote: the handler returns {} on error.').real, true);
  assert.equal(parseVerdict('{"note":"this is real and confirmed"}').real, true);
});

test('a planner report containing {} keeps its long summary', async () => {
  const report = 'Plan: do the thing.\nUse readJson(FILE(), {}) for defaults.\n' + 'step '.repeat(200);
  const out = await runPlan({ stages: [{ id: 'plan', tasks: [{ spec: 'plan' }] }] }, { taskRuntime: {
    createTask() { return { id: 'p1' }; },
    async awaitTask() { return { id: 'p1', status: 'done', result: { finalMessage: report } }; },
    getTask() { assert.fail('use the awaitTask snapshot'); },
  } });
  assert.equal(out.status, 'done');
  assert.equal(out.stages.plan.summary, report.slice(0, 4000));
  assert.ok(out.stages.plan.summary.length > 140);
});

test('a 100 KB brace bomb returns in under 200 ms', (t) => {
  const bomb = '{'.repeat(100_000);
  const t0 = performance.now();
  assert.equal(extractJson(bomb), null);
  const ms = performance.now() - t0;
  t.diagnostic(`extractJson: ${ms.toFixed(2)} ms`);
  assert.ok(ms < 200, `extractJson took ${ms} ms`);
  assert.equal(parseVerdict(bomb).real, false);
  assert.equal(findingsOf(bomb, 't')[0].title.length, 140);
});

test('tally modes', () => {
  const v = [{ real: true }, { real: false }, { real: true }];
  assert.equal(tally(v).confirmed, true);
  assert.equal(tally(v, 'all').confirmed, false);
  assert.equal(tally([{ real: false }, { real: true }], 'any').confirmed, true);
  assert.equal(tally([]).confirmed, false);
});

test('unsuccessful voters leave the requested electorate incomplete and prevent dependent fixes', async (t) => {
  for (const pass of ['all', 'majority', 'any']) {
    for (const statuses of [['done', 'failed', 'canceled'], ['failed', 'failed', 'failed'], ['canceled', 'canceled', 'canceled']]) {
      await t.test(`${pass}: ${statuses.join('/')}`, async () => {
        const created = [];
        const out = await runPlan({ stages: [
          { id: 'find', tasks: [{ spec: 'find' }] },
          { id: 'vote', for_each: 'find', votes: statuses.length, pass, task: { spec: 'vote {{item}}' } },
          { id: 'fix', for_each: 'vote.confirmed', task: { spec: 'fix {{item}}' } },
          { id: 'rejected', for_each: 'vote.rejected', task: { spec: 'must not start {{item}}' } },
        ] }, { taskRuntime: {
          createTask(input) { created.push(input); return { id: String(created.length) }; },
          async awaitTask(id) {
            return { id, status: id === '1' ? 'done' : statuses[Number(id) - 2], result: {
              finalMessage: id === '1' ? '{"findings":[{"id":"bug","title":"Bug"}]}' : '{"real":true}',
            } };
          },
          getTask() { assert.fail('use terminal snapshots'); },
        } });
        assert.equal(created.length, 1 + statuses.length);
        assert.equal(out.status, 'incomplete');
        assert.equal(out.stages.vote.incomplete, true);
        assert.deepEqual(out.stages.vote.tasks.map((task) => task.status), statuses);
        for (const field of ['findings', 'confirmed', 'rejected']) assert.deepEqual(out.stages.vote[field], []);
        assert.equal(out.stages.fix, undefined);
        assert.equal(out.stages.rejected, undefined);
        assert.match(out.report, /Incomplete: one or more voters failed or were canceled/);
        assert.equal(readJson(statePath('plans', `${out.id}.json`)).status, 'incomplete');
      });
    }
  }
});

test('a non-for_each stage with no ok task is incomplete and does not harvest failure text', async (t) => {
  for (const statuses of [['failed'], ['failed', 'canceled'], ['canceled', 'canceled']]) {
    await t.test(statuses.join('/'), async () => {
      const created = [];
      const out = await runPlan({ stages: [
        { id: 'find', tasks: statuses.map((_, i) => ({ spec: `t${i}` })) },
        { id: 'later', tasks: [{ spec: 'must not start' }] },
      ] }, { taskRuntime: {
        createTask(input) { created.push(input); return { id: String(created.length) }; },
        async awaitTask(id) {
          return { id, status: statuses[Number(id) - 1], error: 'boom', result: { finalMessage: 'Confirmed: this is real.\n{"findings":[{"title":"from failure"}]}' } };
        },
        getTask() { assert.fail('use terminal snapshots'); },
      } });
      assert.equal(created.length, statuses.length);
      assert.equal(out.status, 'incomplete');
      assert.equal(out.stages.find.incomplete, true);
      assert.deepEqual(out.stages.find.findings, []);
      assert.equal(out.stages.later, undefined);
      assert.match(out.report, /Incomplete: all tasks failed or were canceled/);
      assert.doesNotMatch(out.report, /from failure/);
    });
  }
  await t.test('partial fan-out harvests only ok tasks and continues', async () => {
    let n = 0;
    const out = await runPlan({ stages: [
      { id: 'find', tasks: [{ spec: 'ok' }, { spec: 'bad' }] },
      { id: 'later', tasks: [{ spec: 'next' }] },
    ] }, { taskRuntime: {
      createTask() { return { id: String(++n) }; },
      async awaitTask(id) {
        if (id === '2') return { id, status: 'failed', error: 'boom', result: { finalMessage: '{"findings":[{"title":"from failure"}]}' } };
        return { id, status: 'done', result: { finalMessage: id === '1' ? '{"findings":[{"title":"kept"}]}' : 'ok' } };
      },
      getTask() { assert.fail('use terminal snapshots'); },
    } });
    assert.equal(out.status, 'done');
    assert.deepEqual(out.stages.find.findings.map((f) => f.title), ['kept']);
    assert.equal(out.stages.later.tasks.length, 1);
    assert.match(out.report, /task 2 failed/);
  });
});

test('completed voters retain the full electorate for majority and all decisions', async (t) => {
  for (const pass of ['all', 'majority']) await t.test(pass, async () => {
    let created = 0;
    const out = await runPlan({ stages: [
      { id: 'find', tasks: [{ spec: 'find' }] },
      { id: 'vote', for_each: 'find', votes: 3, pass, task: { spec: 'vote {{item}}' } },
    ] }, { taskRuntime: {
      createTask() { return { id: String(++created) }; },
      async awaitTask(id) { return { id, status: 'done', result: { finalMessage: id === '1' ? '{"findings":[{"title":"Bug"}]}' : JSON.stringify({ real: id !== '4' }) } }; },
      getTask() { assert.fail('use terminal snapshots'); },
    } });
    assert.equal(out.status, 'done');
    const decision = pass === 'all' ? out.stages.vote.rejected : out.stages.vote.confirmed;
    assert.equal(decision.length, 1);
    assert.equal(decision[0].tally, '2/3');
  });
});

test('stages expand with templates, per-item votes and lenses, and inherited defaults', () => {
  const ctx = { goal: 'audit', defaults: { provider: 'codex', effort: 'low' }, seen: [{ title: 'old one' }], results: { find: { findings: [{ id: 'f1', title: 'Bug A', file: 'a.js' }, { id: 'f2', title: 'Bug B' }], summary: 'two findings' } } };
  const finders = expandStage({ id: 'find', tasks: [{ spec: 'Goal: {{goal}}. Already known:\n{{seen}}' }, { spec: 'x', provider: 'ollama', model: 'qwen3.8:latest' }] }, ctx);
  assert.equal(finders.length, 2);
  assert.match(finders[0].spec, /Goal: audit/); assert.match(finders[0].spec, /- old one/);
  assert.equal(finders[0].provider, 'codex'); assert.equal(finders[1].provider, 'ollama');
  const refuters = expandStage({ id: 'verify', for_each: 'find', votes: 2, lenses: ['read', 'reproduce'], task: { spec: 'Refute {{item}} via {{lens}}' } }, ctx);
  assert.equal(refuters.length, 4);
  assert.match(refuters[0].spec, /Bug A/); assert.match(refuters[0].spec, /via read/); assert.match(refuters[1].spec, /via reproduce/);
  assert.equal(refuters[3].item.id, 'f2'); assert.equal(refuters[3].vote, 1);
  const critic = expandStage({ id: 'critic', tasks: [{ spec: 'Given:\n{{results:find}}\nWhat is missing?' }] }, ctx);
  assert.match(critic[0].spec, /Bug A/);
  assert.match(critic[0].spec, /"file": "a.js"/);
  assert.deepEqual(expandStage({ id: 'v2', for_each: 'find.confirmed', task: { spec: 'x' } }, ctx), []);
});

test('failover chains block dependent votes until the replacement is terminal, using one deadline', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const replacement = Promise.withResolvers();
  const created = [], waits = [];
  const taskRuntime = {
    createTask(input) { created.push(input); return { id: `task-${created.length}` }; },
    async awaitTask(id, timeoutMs) {
      waits.push({ id, timeoutMs });
      if (id === 'task-1') { now += 10_000; return { id, status: 'failed', failedOverTo: 'retry-1' }; }
      if (id === 'retry-1') { now += 10_000; return { id, status: 'failed', failedOverTo: 'retry-2' }; }
      if (id === 'retry-2') return replacement.promise;
      return { id, status: 'done', result: { finalMessage: '{"real":true,"reason":"verified"}' } };
    },
    getTask() { assert.fail('use the awaitTask snapshot'); },
  };
  const pending = runPlan({ timeout_minutes: 1, stages: [
    { id: 'find', tasks: [{ spec: 'find bugs' }] },
    { id: 'vote', for_each: 'find', votes: 2, task: { spec: 'check {{item}}' } },
  ] }, { taskRuntime });
  try {
    await new Promise(setImmediate); // drain resolved waits while the replacement remains deferred
    assert.equal(created.length, 1);
    assert.deepEqual(waits, [
      { id: 'task-1', timeoutMs: 60_000 },
      { id: 'retry-1', timeoutMs: 50_000 },
      { id: 'retry-2', timeoutMs: 40_000 },
    ]);
  } finally {
    replacement.resolve({ id: 'retry-2', status: 'done', provider: 'stub', model: 'replacement', result: { finalMessage: '```json\n{"findings":[{"title":"Terminal finding"}]}\n```' } });
  }
  const out = await pending;
  assert.equal(out.status, 'done');
  assert.equal(created.length, 3);
  assert.match(created[1].spec, /Terminal finding/);
  assert.equal(out.stages.vote.confirmed.length, 1);
  assert.equal(out.stages.vote.confirmed[0].tally, '2/2');
  assert.equal(out.stages.find.tasks[0].id, 'task-1');
  assert.equal(out.stages.find.findings[0].title, 'Terminal finding');
  assert.equal(out.stages.find.tasks[0].taskId, 'retry-2');
  assert.deepEqual(out.stages.find.tasks[0].taskIds, ['task-1', 'retry-1', 'retry-2']);
  assert.match(out.report, /task-1 -> retry-1 -> retry-2\[done\]/);
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

test('timeout during an until_dry repeat preserves finalized findings and stops the plan', async () => {
  const created = [];
  const taskRuntime = {
    createTask(input) { created.push(input); return { id: `task-${created.length}` }; },
    async awaitTask(id) {
      return id === 'task-1'
        ? { id, status: 'done', result: { finalMessage: '```json\n{"findings":[{"title":"Finalized"}]}\n```' } }
        : { id, status: 'running', timedOut: true, result: { finalMessage: '```json\n{"findings":[{"title":"Partial"}]}\n```' } };
    },
    getTask() { assert.fail('use the awaitTask snapshot'); },
  };
  const out = await runPlan({ stages: [
    { id: 'find', tasks: [{ spec: 'find; seen: {{seen}}' }] },
    { id: 'later', tasks: [{ spec: 'must not start' }] },
  ], until_dry: { stage: 'find', max_rounds: 3 } }, { taskRuntime });
  assert.equal(created.length, 2);
  assert.match(created[1].spec, /Finalized/);
  assert.equal(out.status, 'incomplete');
  assert.equal(out.stages.find.tasks.length, 2);
  assert.deepEqual(out.stages.find.findings.map((f) => f.title), ['Finalized']);
  assert.equal(out.stages.later, undefined);
  assert.match(out.report, /Incomplete/);
  assert.doesNotMatch(out.report, /Partial/);
});

test('refused automatic selections stop the plan without dispatch or dependent stages', async (t) => {
  for (const throws of [false, true]) await t.test(throws ? 'throwing recommender' : 'null recommendation', async () => {
    let recommendations = 0;
    const seq = bus.seq;
    const out = await runPlan({ stages: [
      { id: 'find', tasks: [{ spec: 'find', category: 'code' }] },
      { id: 'later', tasks: [{ spec: 'must not start' }] },
    ], until_dry: { stage: 'find', max_rounds: 3, dry_rounds: 2 } }, {
      recommend() { recommendations++; if (throws) throw new Error('unavailable'); return null; },
      taskRuntime: {
        createTask() { assert.fail('a refused selection must not dispatch the default worker'); },
        awaitTask() { assert.fail('no task was created'); },
        getTask() { assert.fail('no task was created'); },
      },
    });
    assert.equal(recommendations, 1);
    assert.equal(out.status, 'incomplete');
    assert.equal(out.stages.find.incomplete, true);
    assert.equal(out.stages.find.tasks[0].id, null);
    assert.equal(out.stages.find.tasks[0].status, 'no_worker');
    assert.match(out.stages.find.tasks[0].error, throws ? /recommendation failed/i : /no worker/i);
    assert.deepEqual(out.stages.find.findings, []);
    assert.equal(out.stages.later, undefined);
    assert.match(out.report, /Incomplete: no worker/);
    assert.equal(readJson(statePath('plans', `${out.id}.json`)).status, 'incomplete');
    const events = bus.since(seq).filter((e) => e.planId === out.id);
    assert.equal(events.at(-1).kind, 'incomplete');
    assert.equal(events.some((e) => ['stage_done', 'done'].includes(e.kind)), false);
  });
});

test('a mixed stage awaits eligible inputs and preserves explicit and recommended selections', async () => {
  const created = [], waited = [], recommendations = [];
  const terminal = Promise.withResolvers();
  const pending = runPlan({ stages: [
    { id: 'find', tasks: [
      { spec: 'explicit', category: 'explicit', provider: 'pinned', model: 'chosen', effort: 'high' },
      { spec: 'automatic', category: 'auto', difficulty: 4, exclude: ['excluded'] },
      { spec: 'automatic with effort', category: 'auto', effort: 'low' },
    ] },
    { id: 'later', tasks: [{ spec: 'after' }] },
  ] }, {
    recommend(input) {
      recommendations.push(input);
      return { provider: 'recommended', model: 'qualified', effort: 'medium' };
    },
    taskRuntime: {
      createTask(input) { created.push(input); return { id: `task-${created.length}` }; },
      async awaitTask(id) { waited.push(id); await terminal.promise; return { id, ...created[Number(id.slice(5)) - 1], status: 'done', result: { finalMessage: 'Finished' } }; },
      getTask() { assert.fail('use the awaitTask snapshot'); },
    },
  });
  let settled = false;
  pending.then(() => { settled = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false);
    assert.deepEqual(created.map(({ provider, model, effort }) => ({ provider, model, effort })), [
      { provider: 'pinned', model: 'chosen', effort: 'high' },
      { provider: 'recommended', model: 'qualified', effort: 'medium' },
      { provider: 'recommended', model: 'qualified', effort: 'low' },
    ]);
    assert.deepEqual(waited, ['task-1', 'task-2', 'task-3']);
    assert.deepEqual(recommendations, [
      { category: 'auto', difficulty: 4, exclude: ['excluded'], overflowApi: false },
      { category: 'auto', difficulty: 2, exclude: [], overflowApi: false },
    ]);
  } finally { terminal.resolve(); }
  const out = await pending;
  assert.equal(out.status, 'done');
  assert.deepEqual(out.stages.find.tasks.map((t) => t.status), ['done', 'done', 'done']);
  assert.deepEqual(out.stages.find.tasks.map((t) => t.id), ['task-1', 'task-2', 'task-3']);
  assert.equal(out.stages.later.tasks.length, 1);
});

test('finder rounds accumulate unique findings that survive dedupe and receive every refuter vote', async () => {
  const a = { id: 'a', title: 'Bug A', file: 'a.mjs' }, b = { id: 'b', title: 'Bug B', file: 'b.mjs' };
  const created = [];
  let rounds = 0;
  const out = await runPlan({ defaults: { provider: 'stub', model: 'selected' }, stages: [
    { id: 'find', tasks: [{ spec: 'find; seen: {{seen}}' }] },
    { id: 'dedupe', tasks: [{ spec: 'dedupe {{results:find}}; seen: {{seen}}' }, { spec: 'dedupe again' }] },
    { id: 'vote', for_each: 'dedupe', votes: 3, task: { spec: 'vote {{item}}' } },
  ], until_dry: { stage: 'find', max_rounds: 5, dry_rounds: 2 } }, {
    taskRuntime: {
      createTask(input) { created.push(input); return { id: `task-${created.length}` }; },
      async awaitTask(id) {
        const input = created[Number(id.slice(5)) - 1];
        const output = input.spec.startsWith('vote') ? { real: true, reason: 'verified' }
          : { findings: input.spec.startsWith('find') && ++rounds === 1 ? [a, a] : [a, b, a, b] };
        return { id, status: 'done', result: { finalMessage: '```json\n' + JSON.stringify(output) + '\n```' } };
      },
      getTask() { assert.fail('use the awaitTask snapshot'); },
    },
  });
  assert.equal(out.status, 'done');
  assert.equal(rounds, 4); // Two novel rounds, then the two requested dry rounds.
  assert.equal(out.stages.find.tasks.length, 4);
  assert.equal(out.stages.dedupe.tasks.length, 2);
  for (const stage of ['find', 'dedupe', 'vote']) assert.deepEqual(out.stages[stage].findings.map((f) => f.id), ['a', 'b']);
  assert.equal(out.stages.dedupe.fresh, 0);
  assert.equal(out.stages.vote.tasks.length, 6);
  assert.deepEqual(out.stages.vote.confirmed.map((f) => f.tally), ['3/3', '3/3']);
  assert.deepEqual(out.stages.vote.rejected, []);
  assert.match(created[0].spec, /seen: \(nothing yet\)/);
  assert.match(created[1].spec, /seen: - Bug A \(a.mjs\)$/);
  assert.match(created[4].spec, /seen: - Bug A \(a.mjs\)\n- Bug B \(b.mjs\)$/);
});

test('dedupe repeats keep unchanged findings once while global novelty controls dry convergence', async () => {
  const finding = { id: 'a', title: 'Bug A', file: 'a.mjs' };
  const created = [];
  const out = await runPlan({ stages: [
    { id: 'find', tasks: [{ spec: 'find' }] },
    { id: 'dedupe', tasks: [{ spec: 'dedupe; seen: {{seen}}' }] },
    { id: 'vote', for_each: 'dedupe', votes: 2, task: { spec: 'vote {{item}}; seen: {{seen}}' } },
  ], until_dry: { stage: 'dedupe', max_rounds: 3, dry_rounds: 2 } }, {
    taskRuntime: {
      createTask(input) { created.push(input); return { id: `task-${created.length}` }; },
      async awaitTask(id) {
        const input = created[Number(id.slice(5)) - 1];
        const output = input.spec.startsWith('vote') ? { real: true } : { findings: [finding, finding] };
        return { id, status: 'done', result: { finalMessage: '```json\n' + JSON.stringify(output) + '\n```' } };
      },
      getTask() { assert.fail('use the awaitTask snapshot'); },
    },
  });
  assert.equal(out.status, 'done');
  assert.equal(out.stages.dedupe.tasks.length, 2);
  assert.deepEqual(out.stages.dedupe.findings.map((f) => f.id), ['a']);
  assert.equal(out.stages.dedupe.fresh, 0);
  assert.equal(out.stages.vote.tasks.length, 2);
  assert.equal(out.stages.vote.confirmed[0].tally, '2/2');
  for (const input of created.slice(1)) assert.match(input.spec, /seen: - Bug A \(a.mjs\)$/);
});

test('until_dry records capped when max_rounds is hit with fresh findings', async () => {
  let n = 0;
  const out = await runPlan({ stages: [
    { id: 'find', tasks: [{ spec: 'find' }] },
    { id: 'later', tasks: [{ spec: 'after' }] },
  ], until_dry: { stage: 'find', max_rounds: 2 } }, { taskRuntime: {
    createTask() { return { id: `t${++n}` }; },
    async awaitTask(id) { return { id, status: 'done', result: { finalMessage: JSON.stringify({ findings: [{ title: `new ${id}` }] }) } }; },
    getTask() { assert.fail('use terminal snapshots'); },
  } });
  assert.equal(out.status, 'done');
  assert.equal(n, 3); // two finder rounds, then later
  assert.deepEqual(out.stages.find.untilDry, { rounds: 2, dry: false, capped: true });
  assert.match(out.report, /capped at max_rounds=2/);
  assert.equal(out.stages.later.tasks.length, 1);
});

// Handler regressions for plan routing and retry ancestry.
import { registerHooks } from 'node:module';
import { setSessionFlags } from '../core/session-flags.mjs';
import { createTask, getTask } from '../core/tasks.mjs';
import { loadConfig } from '../core/config.mjs';

// Execute the actual handlers and plan executor. Only selection, capability research and task waits
// are mocked; createTask persists real records under _env and its scheduler is disabled.
const calls = [];
const pick = { provider: 'stub', model: 'next', effort: 'high', reason: 'fixture' };
globalThis.toolFixtures = {
  recommend(input) { calls.push(input); return pick; },
  async awaitTask(id) {
    const task = getTask(id);
    task.status = 'done';
    task.result = { finalMessage: task.spec === 'find' ? '{"findings":[{"title":"Bug"}]}' : '{"real":true}' };
    return task;
  },
};
const urls = Object.fromEntries(['tools', 'plans', 'tasks', 'scorecard', 'capabilities'].map((name) => [name, new URL(`../core/${name}.mjs`, import.meta.url).href]));
const sources = {
  tasks: `export * from ${JSON.stringify(urls.tasks)}; export const awaitTask = (...args) => globalThis.toolFixtures.awaitTask(...args);`,
  scorecard: `export * from ${JSON.stringify(urls.scorecard)}; export const recommend = (...args) => globalThis.toolFixtures.recommend(...args);`,
  capabilities: 'export const accessProviders = () => null, missingFor = () => [], shouldResearch = () => false, researchSpec = () => "", parseResearched = () => [], loadIndex = () => [];',
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === urls.tools && specifier === './plans.mjs') return { url: `${urls.plans}?tool-fixture`, shortCircuit: true };
    if ([urls.tools, `${urls.plans}?tool-fixture`].includes(context.parentURL)) {
      const name = Object.keys(sources).find((name) => specifier === `./${name}.mjs`);
      if (name) return { url: `tool-fixture:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('tool-fixture:')) return { format: 'module', source: sources[url.slice('tool-fixture:'.length)], shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { conductorToolDefs, selOf } = await import('../core/tools.mjs');
hooks.deregister();
const handler = (name, sessionId = name) => conductorToolDefs({ sessionId, cwd: HOME }).find((tool) => tool.name === name).handler;
const attempt = (input = {}) => {
  const task = createTask({ cwd: HOME, spec: 'fixture', provider: 'stub', model: 'original', effort: 'low', category: 'code', difficulty: 2, ...input });
  Object.assign(task, { status: 'done', threadId: `thread-${task.id}` });
  return task;
};
const delegate = (failed) => handler('delegate')({ title: 'retry', spec: 'fixture', retry_of: failed.id, background: true });

test('delegate and run_plan preserve pass-gated visual effort, including inherited defaults and explicit pins', async (t) => {
  const { getModels } = await import('../core/models.mjs');
  const { recommend } = await import('../core/scorecard.mjs');
  const { saveConfig } = await import('../core/config.mjs');
  const reg = getModels(), previous = { models: reg.models, providers: reg.providers }, cfg = loadConfig();
  reg.models = [{ provider: 'codex', id: 'gpt-6-astra', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'] }];
  reg.providers = { codex: { status: 'ok' } };
  saveConfig({ worker: { provider: 'codex', model: 'gpt-6-astra', effort: 'high' }, scorecard: { usePriors: false } });
  t.after(() => { Object.assign(reg, previous); saveConfig({ worker: cfg.worker, scorecard: cfg.scorecard }); });
  t.mock.method(globalThis.toolFixtures, 'recommend', (input) => { calls.push(input); return recommend({ ...input, summary: [] }); });

  for (const [category, effort] of [['drafting', 'xhigh'], ['modeling', 'ultra']]) await t.test(category, async () => {
    const expected = `codex:gpt-6-astra:${effort}`;
    for (const input of [{}, { effort: 'high' }, { provider: 'codex', effort: 'high' }, { model: 'gpt-6-astra', effort: 'high' }]) {
      calls.length = 0;
      const report = await handler('delegate')({ title: 'visual', spec: 'fixture', category, difficulty: 2, background: true, ...input });
      const task = getTask(/^Task (\S+)/.exec(report)?.[1]);
      assert.ok(task, report);
      const pinned = !!(input.provider || input.model);
      assert.equal(selOf(task), pinned ? 'codex:gpt-6-astra:high' : expected);
      assert.equal(calls.length, pinned ? 0 : 1);
    }

    calls.length = 0;
    const report = await handler('run_plan')({ defaults: { category, difficulty: 2, effort: 'high' }, stages: [
      { id: 'plan_default', tasks: [{ spec: 'fixture' }, { spec: 'fixture', effort: 'high' }] },
      { id: 'stage_default', defaults: { effort: 'low' }, tasks: [{ spec: 'fixture' }] },
      { id: 'task_pins', tasks: [{ spec: 'fixture', provider: 'codex' }, { spec: 'fixture', model: 'gpt-6-astra' }] },
      { id: 'inherited_pin', defaults: { provider: 'codex', model: 'gpt-6-astra' }, tasks: [{ spec: 'fixture' }] },
    ] });
    const record = readJson(statePath('plans', `${/^Plan (\S+)/.exec(report)?.[1]}.json`));
    assert.equal(record?.status, 'done', report);
    assert.equal(calls.length, 3);
    for (const [stage, selections] of Object.entries({
      plan_default: [expected, expected], stage_default: [expected],
      task_pins: ['codex:gpt-6-astra:high', 'codex:gpt-6-astra:high'], inherited_pin: ['codex:gpt-6-astra:high'],
    })) {
      assert.deepEqual(record.stages[stage].tasks.map(({ id }) => selOf(getTask(id))), selections);
    }
  });
});

test('GP2-02: delegate and runPlan never create unsupported automatic visual tasks', async (t) => {
  const { getModels } = await import('../core/models.mjs');
  const { recommend, recordRun, rateTask } = await import('../core/scorecard.mjs');
  const { saveConfig } = await import('../core/config.mjs');
  const { listTasks } = await import('../core/tasks.mjs');
  const reg = getModels(), previous = { models: reg.models, providers: reg.providers }, cfg = loadConfig();
  const source = 'gp2-02-visual-effort';
  const astra = { provider: 'codex', id: 'gpt-6-astra', kind: 'agent', efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'] };
  reg.providers = { codex: { status: 'ok' } };
  saveConfig({ worker: { provider: 'codex', model: astra.id }, scorecard: { usePriors: true } });
  t.after(() => { Object.assign(reg, previous); saveConfig({ worker: cfg.worker, scorecard: cfg.scorecard }); });
  const recordPass = (category, effort) => {
    for (let i = 0; i < cfg.scorecard.minSamples; i++) {
      const id = `${source}-${category}-${i}`;
      recordRun({ id, source, provider: 'codex', model: astra.id, effort, category, difficulty: 2, status: 'done',
        result: { usage: { input_tokens: 100, output_tokens: 10 } } });
      rateTask(id, 'pass');
    }
  };
  const dispatch = async (kind, input, sessionId) => {
    const report = kind === 'delegate'
      ? await handler(kind, sessionId)({ title: 'visual', spec: 'fixture', background: true, ...input })
      : await handler(kind, sessionId)({ defaults: input, stages: [{ id: 'work', tasks: [{ spec: 'fixture' }] }] });
    return { report, tasks: listTasks({ sessionId }) };
  };
  for (const [category, effort, clamped] of [['drafting', 'xhigh', 'high'], ['modeling', 'ultra', 'xhigh']]) {
    recordPass(category, effort);
    for (const route of ['measured', 'prior']) for (const supported of [false, true]) {
      await t.test(`${category}, ${route}, supported=${supported}`, async (ctx) => {
        reg.models = [{ ...astra, efforts: supported ? astra.efforts : astra.efforts.filter((e) => e !== effort) }];
        const picks = [];
        ctx.mock.method(globalThis.toolFixtures, 'recommend', (input) => {
          const result = recommend({ ...input, source, ...(route === 'prior' ? { summary: [] } : {}) });
          picks.push(result); return result;
        });
        for (const kind of ['delegate', 'run_plan']) {
          const session = `${category}-${route}-${supported}-${kind}`;
          const automatic = await dispatch(kind, { category, difficulty: 2, effort: 'high' }, session);
          assert.equal(automatic.tasks.length, supported ? 1 : 0, automatic.report);
          if (supported) {
            assert.equal(selOf(automatic.tasks[0]), `codex:${astra.id}:${effort}`);
            assert.equal(!!picks.at(-1).plan, route === 'measured', 'exercise the requested recommendation route');
          } else {
            assert.equal(picks.at(-1), null);
            assert.match(automatic.report, /no worker/i);
          }
          const count = picks.length;
          const pinned = await dispatch(kind, { category, difficulty: 2, provider: 'codex', model: astra.id, effort }, `${session}-pin`);
          assert.equal(pinned.tasks.length, 1, pinned.report);
          assert.equal(selOf(pinned.tasks[0]), `codex:${astra.id}:${supported ? effort : clamped}`);
          assert.equal(picks.length, count, 'explicit pins bypass recommendation');
        }
      });
    }
  }
  // Ordinary measured selections still use createTask's existing normalization.
  recordPass('implement', 'ultra');
  reg.models = [{ ...astra, efforts: ['low', 'medium', 'high', 'xhigh'] }];
  t.mock.method(globalThis.toolFixtures, 'recommend', (input) => recommend({ ...input, source }));
  for (const kind of ['delegate', 'run_plan']) {
    const ordinary = await dispatch(kind, { category: 'implement', difficulty: 2 }, `ordinary-${kind}`);
    assert.equal(ordinary.tasks.length, 1, ordinary.report);
    assert.equal(selOf(ordinary.tasks[0]), `codex:${astra.id}:xhigh`);
    assert.match(ordinary.tasks[0].warning, /clamped effort/);
  }
});

test('delegate keeps effort-only overrides for ordinary categories', async () => {
  const report = await handler('delegate')({ title: 'ordinary', spec: 'fixture', category: 'implement', difficulty: 2, effort: 'low', background: true });
  const task = getTask(/^Task (\S+)/.exec(report)?.[1]);
  assert.ok(task, report);
  assert.equal(selOf(task), `${pick.provider}:${pick.model}:low`);
});

test('run_plan auto-pick passes the access-gate provider list to recommend', async () => {
  const { saveConfig, loadConfig } = await import('../core/config.mjs');
  const previous = loadConfig().tools;
  saveConfig({ tools: { index: { og4_plan: { kind: 'access', match: ['og4-plan.test/'], providers: ['grok'] } } } });
  try {
    let seen;
    const out = await runPlan({ stages: [{ id: 'a', tasks: [{ title: 'read', spec: 'open og4-plan.test/page', category: 'search' }] }] }, {
      recommend(opts) { seen = opts; return { provider: 'grok', model: 'grok-4.6', effort: 'low' }; },
      taskRuntime: {
        createTask() { return { id: 'p1' }; },
        async awaitTask() { return { id: 'p1', status: 'done', result: { finalMessage: 'ok' } }; },
        getTask() { return { id: 'p1', status: 'done' }; },
      },
    });
    assert.equal(out.status, 'done');
    assert.deepEqual(seen.providers, ['grok']);
  } finally { saveConfig({ tools: previous }); }
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

test('delegate resolves retry ancestry through follow-ups and excludes every prior selection', async () => {
  const original = attempt();
  const retry = attempt({ model: 'fallback', retryOf: original.id });
  const reviewed = attempt({ followUpOf: retry.id, effort: 'medium' });
  calls.length = 0;
  const report = await delegate(reviewed);
  assert.equal(calls.length, 2); // ceiling query followed by the excluded selection query
  assert.equal(calls[1].escalate, true);
  assert.deepEqual(new Set(calls[1].exclude), new Set([selOf(original), selOf(retry), selOf(reviewed)]));
  assert.match(report, /Escalation attempt 1\//);
  const id = /^Task (\S+)/.exec(report)[1];
  assert.equal(getTask(id).retryOf, reviewed.id);
});

test('follow-up rounds do not count as new attempts or lose the latest reviewed round count', async () => {
  const original = attempt();
  let reviewed = original;
  const maxRounds = loadConfig().worker.maxRounds;
  for (let round = 1; round <= maxRounds; round++) {
    reviewed = attempt({ followUpOf: reviewed.id });
    calls.length = 0;
    await delegate(reviewed);
    assert.equal(calls.at(-1).escalate, round >= maxRounds);
  }
  const retry = attempt({ model: 'escalation', retryOf: reviewed.id });
  const retryReview = attempt({ followUpOf: retry.id });
  calls.length = 0;
  const report = await delegate(retryReview);
  assert.match(report, /Escalation attempt 2\//); // original's latest review exhausted its rounds
  assert.deepEqual(new Set(calls.at(-1).exclude), new Set([selOf(original), selOf(retry)]));
});

test('delegate terminates cyclic follow-up and retry ancestry without counting an attempt twice', async (t) => {
  for (const link of ['followUpOf', 'retryOf']) await t.test(link, async () => {
    const a = attempt(), b = attempt({ model: 'second' });
    a[link] = b.id; b[link] = a.id;
    calls.length = 0;
    const report = await delegate(a);
    assert.match(report, /queued/);
    assert.deepEqual(new Set(calls.at(-1).exclude), new Set([selOf(a), selOf(b)]));
    assert.equal(calls.at(-1).escalate, link === 'retryOf');
  });
});

test('run_plan sandbox shares the delegate enum; a throwing createTask cancels earlier tasks', async () => {
  const defs = conductorToolDefs({ sessionId: 'e10', cwd: HOME });
  const planSchema = defs.find((d) => d.name === 'run_plan').schema;
  const base = { goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x' }] }] };
  for (const bad of [
    { ...base, defaults: { sandbox: 'nope' } },
    { goal: 'g', stages: [{ id: 'a', defaults: { sandbox: 'nope' }, tasks: [{ spec: 'x' }] }] },
    { goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x', sandbox: 'nope' }] }] },
  ]) assert.throws(() => planSchema.parse(bad));
  assert.equal(planSchema.parse({ goal: 'g', stages: [{ id: 'a', tasks: [{ spec: 'x', sandbox: 'read-only' }] }] }).stages[0].tasks[0].sandbox, 'read-only');

  const ids = [];
  let n = 0;
  const out = await runPlan({ stages: [
    { id: 'work', tasks: [{ spec: 'first' }, { spec: 'second' }, { spec: 'third' }] },
    { id: 'later', tasks: [{ spec: 'must not run' }] },
  ] }, { taskRuntime: {
    createTask(input) {
      n++;
      if (n === 2) throw new Error('invalid sandbox');
      const t = createTask({ cwd: HOME, title: input.title, spec: input.spec, provider: 'stub', model: 'x' });
      ids.push(t.id);
      return t;
    },
    async awaitTask() { assert.fail('must not wait after createTask throw'); },
    getTask() { assert.fail('must not wait after createTask throw'); },
  } });
  assert.equal(out.status, 'incomplete');
  assert.equal(ids.length, 1);
  assert.equal(getTask(ids[0]).status, 'canceled');
  assert.equal(n, 2);
  assert.equal(out.stages.later, undefined);
  assert.match(out.report, /createTask failed: invalid sandbox|Incomplete/);
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

test('L2: for_each tallies by item object reference, never by worker-supplied id', async () => {
  const a = { id: 'F1', title: 'Bug A', file: 'a.js' }, b = { id: 'F1', title: 'Bug B', file: 'b.js' };
  let n = 0;
  const out = await runPlan({ stages: [
    { id: 'find', tasks: [{ spec: 'find' }] },
    { id: 'vote', for_each: 'find', votes: 1, task: { spec: 'vote {{item}}' } },
  ] }, { taskRuntime: {
    createTask() { return { id: `t${++n}` }; },
    async awaitTask(id) {
      if (id === 't1') return { id, status: 'done', result: { finalMessage: JSON.stringify({ findings: [a, b] }) } };
      return { id, status: 'done', result: { finalMessage: JSON.stringify({ real: id === 't2' }) } };
    },
    getTask() { assert.fail('use terminal snapshots'); },
  } });
  assert.equal(out.status, 'done');
  assert.equal(out.stages.vote.confirmed.length, 1);
  assert.equal(out.stages.vote.rejected.length, 1);
  assert.equal(out.stages.vote.confirmed[0].title, 'Bug A');
  assert.equal(out.stages.vote.rejected[0].title, 'Bug B');
});

test('L16: {{results}} is bounded findings JSON (location/line/evidence/fix); {{seen}} prints location', async () => {
  const finding = { title: 'Null deref', location: 'src/a.js:3', line: 3, evidence: 'ptr is null', fix: 'check ptr', severity: 'high' };
  const created = [];
  await runPlan({ stages: [
    { id: 'find', tasks: [{ spec: 'find' }] },
    { id: 'next', tasks: [{ spec: 'seen:\n{{seen}}\nresults:\n{{results:find}}' }] },
  ] }, { taskRuntime: {
    createTask(input) { created.push(input); return { id: `t${created.length}` }; },
    async awaitTask(id) {
      return { id, status: 'done', result: { finalMessage: id === 't1' ? JSON.stringify({ findings: [finding] }) : 'ok' } };
    },
    getTask() { assert.fail('use terminal snapshots'); },
  } });
  assert.match(created[1].spec, /src\/a\.js:3/);
  assert.match(created[1].spec, /ptr is null/);
  assert.match(created[1].spec, /check ptr/);
  assert.match(created[1].spec, /"line": 3/);
  assert.match(created[1].spec, /seen:\n- Null deref \(src\/a\.js:3\)/);
});

test('L17: a planner report with fenced non-finding JSON keeps the full summary', async () => {
  const report = 'Plan: do the thing.\n' + 'step '.repeat(200) + '\n```json\n["step1","step2"]\n```';
  const out = await runPlan({ stages: [{ id: 'plan', tasks: [{ spec: 'plan' }] }] }, { taskRuntime: {
    createTask() { return { id: 'p1' }; },
    async awaitTask() { return { id: 'p1', status: 'done', result: { finalMessage: report } }; },
    getTask() { assert.fail('use the awaitTask snapshot'); },
  } });
  assert.equal(out.stages.plan.summary, report.slice(0, 4000));
  assert.ok(out.stages.plan.summary.length > 140);
});

test('L18: lastFenced want-predicate: a trailing fence without findings/verdict does not win', () => {
  const findings = '```json\n{"findings":[{"title":"Bug","file":"a.js"}]}\n```\n```json\n{"timeout":30}\n```';
  assert.equal(findingsOf(findings, 't')[0].title, 'Bug');
  const verdict = '```json\n{"real":true,"reason":"reproduced"}\n```\n```json\n{"timeout":30}\n```';
  assert.equal(parseVerdict(verdict).real, true);
  const prose = parseVerdict('```json\n{"note":"this is real and confirmed"}\n```');
  assert.equal(prose.real, false);
  assert.match(prose.reason, /note/);
});

test('GP: empty final findings override examples and stop dry loops without losing planner prose', async () => {
  const example = 'Example:\n```json\n{"findings":[{"title":"Example bug"}]}\n```\n';
  for (const report of [
    example + 'Final:\n```json\n{"findings":[]}\n```',
    example + 'Final:\n```json\n[]\n```',
    '```json\n[]\n```',
    'Plan: keep this prose summary.\n```json\n{"findings":[]}\n```',
  ]) {
    assert.deepEqual(findingsOf(report, 'empty'), []);
    let created = 0;
    const out = await runPlan({ stages: [{ id: 'find', tasks: [{ spec: 'review' }] }], until_dry: { stage: 'find' } }, { taskRuntime: {
      createTask() { return { id: `empty-${++created}` }; },
      async awaitTask(id) { return { id, status: 'done', result: { finalMessage: report } }; },
    } });
    assert.equal(created, 1);
    assert.deepEqual(out.stages.find.findings, []);
    assert.equal(out.stages.find.untilDry.dry, true);
    assert.equal(out.stages.find.summary, report);
  }
});

test('GP: abortPlans cancels a real failover replacement and stops later stages', async () => {
  const { schedule, openTasks, cancelChain } = await import('../core/tasks.mjs');
  const { saveConfig } = await import('../core/config.mjs');
  const { getModels } = await import('../core/models.mjs');
  const { getLimits } = await import('../core/limits.mjs');
  const { recordRun, rateTask } = await import('../core/scorecard.mjs');
  const previous = loadConfig(), reg = getModels(), saved = { models: reg.models, providers: reg.providers };
  for (const task of openTasks()) cancelChain(task.id);
  const provider = 'gp-abort-blocked', model = 'gp-abort-alternative', sessionId = 'gp-abort';
  reg.models = [{ provider: 'ollama', id: model, kind: 'agent', cost: 'free-local' }];
  reg.providers = { ollama: { status: 'ok' } };
  saveConfig({ scorecard: { minSamples: 1, classOrder: ['free'] } });
  recordRun({ id: 'gp-abort-seed', status: 'done', provider: 'ollama', model, category: 'review', difficulty: 2, result: { usage: { input_tokens: 1, output_tokens: 1 } } });
  rateTask('gp-abort-seed', 'pass');
  getLimits().providers[provider] = { provider, blocked: true, blockedUntil: Date.now() + (previous.worker.failoverAfterBlockMinutes + 1) * 60_000, windows: [] };
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
    assert.equal(replacement.retryOf, original.id);
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

test('L45: findings without title/file fall back to issue/summary and a content key', () => {
  assert.notEqual(findingKey({ issue: 'alpha-bug' }), findingKey({ issue: 'beta-bug' }));
  assert.notEqual(findingKey({ summary: 'one' }), findingKey({ summary: 'two' }));
  assert.notEqual(findingKey({ extra: 'unique-payload-1' }), findingKey({ extra: 'unique-payload-2' }));
  assert.equal(findingKey({ location: 'A.JS', issue: 'Null   deref' }), 'a.js|null deref');
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

test('P10: an unroutable input does not dispatch siblings', async () => {
  const created = [];
  const out = await runPlan({ stages: [
    { id: 'find', tasks: [
      { spec: 'explicit', provider: 'pinned', model: 'chosen' },
      { spec: 'refused', category: 'refused' },
      { spec: 'automatic', category: 'auto' },
    ] },
    { id: 'later', tasks: [{ spec: 'must not start' }] },
  ] }, {
    recommend(input) { return input.category === 'refused' ? null : { provider: 'recommended', model: 'qualified', effort: 'medium' }; },
    taskRuntime: {
      createTask(input) { created.push(input); return { id: `task-${created.length}` }; },
      awaitTask() { assert.fail('no task was created'); },
      getTask() { assert.fail('no task was created'); },
    },
  });
  assert.equal(created.length, 0);
  assert.equal(out.status, 'incomplete');
  assert.deepEqual(out.stages.find.tasks.map((t) => t.status), ['no_worker', 'no_worker', 'no_worker']);
  assert.equal(out.stages.later, undefined);
  assert.match(out.report, /Incomplete: no worker/);
});

test('L22: failover hops skip depth++ and root, so the first retry is not an escalation', async () => {
  const original = attempt();
  const failover = attempt({ title: `FAILOVER: ${original.title}`, model: 'other', retryOf: original.id });
  original.failedOverTo = failover.id; // what tasks.mjs failover() records on the exhausted task
  calls.length = 0;
  await delegate(failover);
  assert.equal(calls.at(-1).escalate, false, 'failover must not count as a prior model switch');
});

test('L43: retry_of that resolves to a selection already in the chain is refused', async () => {
  const failed = attempt();
  const report = await handler('delegate')({ title: 'retry', spec: 'fixture', retry_of: failed.id, provider: 'stub', model: 'original', effort: 'low', background: true });
  assert.match(report, /already in the chain|would re-run/);
});

test('L44: at-ceiling compares top against every selection in the chain, not only the latest', async (t) => {
  const original = attempt();
  const retry = attempt({ model: 'fallback', retryOf: original.id });
  t.mock.method(globalThis.toolFixtures, 'recommend', (input) => {
    calls.push(input);
    return { provider: 'stub', model: 'original', effort: 'low', reason: 'top' };
  });
  calls.length = 0;
  const report = await delegate(retry);
  assert.match(report, /Already at the ceiling/);
  assert.equal(calls.length, 1); // ceiling query only; no downward pick
});

test('L19: auto-pick persists difficulty 2 when omitted', async () => {
  const created = [];
  await runPlan({ stages: [{ id: 'a', tasks: [{ spec: 'x', category: 'implement' }] }] }, {
    recommend() { return { provider: 'stub', model: 'm', effort: 'low' }; },
    taskRuntime: {
      createTask(input) { created.push(input); return { id: 't1' }; },
      async awaitTask() { return { id: 't1', status: 'done', result: { finalMessage: 'ok' } }; },
      getTask() { assert.fail(); },
    },
  });
  assert.equal(created[0].difficulty, 2);
});
