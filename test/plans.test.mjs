import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, statePath } from '../core/paths.mjs';
import { bus } from '../core/bus.mjs';

const { validatePlan, extractJson, findingsOf, findingKey, parseVerdict, tally, expandStage, runPlan } = await import('../core/plans.mjs');

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
  assert.match(critic[0].spec, /two findings/);
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
      { spec: 'refused', category: 'refused' },
      { spec: 'automatic', category: 'auto', difficulty: 4, exclude: ['excluded'] },
      { spec: 'automatic with effort', category: 'auto', effort: 'low' },
    ] },
    { id: 'later', tasks: [{ spec: 'must not start' }] },
  ] }, {
    recommend(input) {
      recommendations.push(input);
      return input.category === 'refused' ? null : { provider: 'recommended', model: 'qualified', effort: 'medium' };
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
      { category: 'refused', difficulty: 2, exclude: [], overflowApi: false },
      { category: 'auto', difficulty: 4, exclude: ['excluded'], overflowApi: false },
      { category: 'auto', difficulty: 2, exclude: [], overflowApi: false },
    ]);
  } finally { terminal.resolve(); }
  const out = await pending;
  assert.equal(out.status, 'incomplete');
  assert.deepEqual(out.stages.find.tasks.map((t) => t.status), ['done', 'no_worker', 'done', 'done']);
  assert.deepEqual(out.stages.find.tasks.map((t) => t.id), ['task-1', null, 'task-2', 'task-3']);
  assert.deepEqual(out.stages.find.findings, []);
  assert.equal(out.stages.later, undefined);
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
  capabilities: 'export const accessProviders = () => null, missingFor = () => [], shouldResearch = () => false, researchSpec = () => "", parseResearched = () => [];',
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
