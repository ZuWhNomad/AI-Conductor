import './_env.mjs';
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
