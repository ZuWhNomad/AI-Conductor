import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME, readJson, writeJson, statePath, saveConfig, loadConfig, bus, setSessionFlags, createTask, getTask,
  validatePlan, findingsOf, findingKey, parseVerdict, tally, expandStage, runPlan, abortPlans, getPlan, buildPrompt,
  calls, pick, handler, attempt, delegate, conductorToolDefs, selOf,
} from './_helpers.mjs';

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

test('stages expand with templates, per-item votes and lenses, and inherited defaults', () => {
  const ctx = { goal: 'audit', defaults: { provider: 'codex', effort: 'low' }, seen: [{ title: 'old one' }], results: { find: { findings: [{ id: 'f1', title: 'Bug A', file: 'a.js' }, { id: 'f2', title: 'Bug B' }], summary: 'two findings' } } };
  const finders = expandStage({ id: 'find', tasks: [{ spec: 'Goal: {{goal}}. Already known:\n{{seen}}' }, { spec: 'x', provider: 'deepseek', model: 'deepseek-chat:latest' }] }, ctx);
  assert.equal(finders.length, 2);
  assert.match(finders[0].spec, /Goal: audit/); assert.match(finders[0].spec, /- old one/);
  assert.equal(finders[0].provider, 'codex'); assert.equal(finders[1].provider, 'deepseek');
  const refuters = expandStage({ id: 'verify', for_each: 'find', votes: 2, lenses: ['read', 'reproduce'], task: { spec: 'Refute {{item}} via {{lens}}' } }, ctx);
  assert.equal(refuters.length, 4);
  assert.match(refuters[0].spec, /Refute the item below via the lens below/);
  assert.match(refuters[0].spec, /Bug A/); assert.match(refuters[0].spec, /Lens: read/); assert.match(refuters[0].spec, /Vote index: 0/);
  assert.match(refuters[1].spec, /Lens: reproduce/);
  assert.equal(refuters[3].item.id, 'f2'); assert.equal(refuters[3].vote, 1);
  const votePrompts = refuters.slice(0, 2).map((t) => buildPrompt({ ...t, cwd: HOME, category: 'other', provider: 'deepseek', paths: [] }));
  const sharedSpec = refuters[0].spec.slice(0, refuters[0].spec.indexOf('\n\nPer-item vote context:'));
  let common = 0;
  while (common < votePrompts[0].length && common < votePrompts[1].length && votePrompts[0][common] === votePrompts[1][common]) common++;
  assert.ok(common >= votePrompts[0].indexOf(sharedSpec) + sharedSpec.length, 'vote prompts share the complete stage title and spec before item details');
  const critic = expandStage({ id: 'critic', tasks: [{ spec: 'Given:\n{{results:find}}\nWhat is missing?' }] }, ctx);
  assert.match(critic[0].spec, /Bug A/);
  assert.match(critic[0].spec, /"file": "a.js"/);
  assert.deepEqual(expandStage({ id: 'v2', for_each: 'find.confirmed', task: { spec: 'x' } }, ctx), []);
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
      { category: 'auto', difficulty: 4, exclude: ['excluded'], escalate: false, overflowApi: false, providers: null },
      { category: 'auto', difficulty: 2, exclude: [], escalate: false, overflowApi: false, providers: null },
    ]);
  } finally { terminal.resolve(); }
  const out = await pending;
  assert.equal(out.status, 'done');
  assert.deepEqual(out.stages.find.tasks.map((t) => t.status), ['done', 'done', 'done']);
  assert.deepEqual(out.stages.find.tasks.map((t) => t.id), ['task-1', 'task-2', 'task-3']);
  assert.equal(out.stages.later.tasks.length, 1);
});

test('delegate and run_plan preserve pass-gated visual effort, including inherited defaults and explicit pins', async (t) => {
  const { getModels } = await import('../../core/models.mjs');
  const { recommend } = await import('../../core/scorecard.mjs');
  const { saveConfig } = await import('../../core/config.mjs');
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
  const { getModels } = await import('../../core/models.mjs');
  const { recommend, recordRun, rateTask } = await import('../../core/scorecard.mjs');
  const { saveConfig } = await import('../../core/config.mjs');
  const { listTasks } = await import('../../core/tasks.mjs');
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
  const { saveConfig, loadConfig } = await import('../../core/config.mjs');
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

test('run_plan routes per-task categories without defaults like delegate', async () => {
  const session = 'plan-pick-parity';
  setSessionFlags(session, { overflowApi: true, parallelOverride: false });
  const matchingInput = { title: 'debug task', spec: 'same prompt', category: 'debug', difficulty: 3, isolate: true };
  calls.length = 0;
  const delegateReport = await handler('delegate', session)({ ...matchingInput, background: true });
  const delegatedId = /^Task (\S+)/.exec(delegateReport)?.[1];
  assert.ok(delegatedId, delegateReport);
  const delegateOptions = calls.at(-1);

  calls.length = 0;
  const planReport = await handler('run_plan', session)({ goal: 'Route each task', stages: [{ id: 'work', tasks: [
    matchingInput,
    { title: 'test task', spec: 'test prompt', category: 'test', difficulty: 2, isolate: true },
  ] }] });
  const planId = /^Plan (\S+)/.exec(planReport)?.[1];
  assert.ok(planId, planReport);
  const record = readJson(statePath('plans', `${planId}.json`));
  assert.equal(record.status, 'done', planReport);
  assert.deepEqual(calls[0], delegateOptions, 'same task input reaches recommend with the same options as delegate');
  assert.deepEqual(calls.map(({ category, difficulty }) => [category, difficulty]), [['debug', 3], ['test', 2]]);
  assert.deepEqual(record.stages.work.tasks.map(({ status }) => status), ['done', 'done']);
  assert.deepEqual(record.stages.work.tasks.map(({ id }) => {
    const task = getTask(id);
    return { category: task.category, difficulty: task.difficulty, provider: task.provider, model: task.model };
  }), [
    { category: 'debug', difficulty: 3, provider: pick.provider, model: pick.model },
    { category: 'test', difficulty: 2, provider: pick.provider, model: pick.model },
  ]);
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

test('P10: an unroutable input does not prevent eligible siblings from running', async () => {
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
      async awaitTask(id) { return { id, status: 'done', result: { finalMessage: 'Finished' } }; },
      getTask() { assert.fail('no task was created'); },
    },
  });
  assert.deepEqual(created.map((task) => task.spec), ['explicit', 'automatic']);
  assert.equal(out.status, 'incomplete');
  assert.deepEqual(out.stages.find.tasks.map((t) => t.status), ['done', 'no_worker', 'done']);
  assert.match(out.stages.find.tasks[1].error, /No worker is available for refused@2: nothing is proven at this level yet/);
  assert.equal(out.stages.later, undefined);
  assert.match(out.report, /Incomplete: no worker/);
  assert.match(out.report, /nothing is proven at this level yet/);
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

test('run_plan passes writable_roots (task or defaults) to createTask', async () => {
  const created = [];
  await runPlan({ defaults: { writable_roots: ['D:/wt-default'] }, stages: [{ id: 'a', tasks: [{ spec: 'x', provider: 'stub' }, { spec: 'y', provider: 'stub', writable_roots: ['D:/wt-a'] }] }] }, {
    taskRuntime: {
      createTask(input) { created.push(input); return { id: `t${created.length}` }; },
      async awaitTask(id) { return { id, status: 'done', result: { finalMessage: 'ok' } }; },
      getTask() { assert.fail(); },
    },
  });
  assert.deepEqual(created.map((c) => c.writableRoots), [['D:/wt-default'], ['D:/wt-a']]);
});

test('avoid_families keeps the auto-pick off those families and reaches createTask', async (t) => {
  const { getModels } = await import('../../core/models.mjs');
  const reg = getModels(), models = reg.models;
  reg.models = [{ provider: 'claude', id: 'claude-opus-5' }, { provider: 'antigravity', id: 'claude-sonnet-4-6' }, { provider: 'grok', id: 'grok-4.6' }];
  t.after(() => { reg.models = models; });
  const created = [], excluded = [];
  await runPlan({ stages: [{ id: 'a', tasks: [{ spec: 'x', category: 'review', avoid_families: ['Claude'], exclude: ['codex:gpt-5.5'] }] }] }, {
    recommend(input) { excluded.push(input.exclude); return { provider: 'grok', model: 'grok-4.6', effort: 'low' }; },
    taskRuntime: {
      createTask(input) { created.push(input); return { id: 't1' }; },
      async awaitTask() { return { id: 't1', status: 'done', result: { finalMessage: 'ok' } }; },
      getTask() { assert.fail(); },
    },
  });
  assert.deepEqual(excluded, [['codex:gpt-5.5', 'claude:claude-opus-5', 'antigravity:claude-sonnet-4-6']]);
  assert.deepEqual(created[0].avoidFamilies, ['Claude']); // createTask normalizes it
});
