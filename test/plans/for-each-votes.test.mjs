import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME, readJson, writeJson, statePath, saveConfig, loadConfig, bus, setSessionFlags, createTask, getTask,
  validatePlan, findingsOf, findingKey, parseVerdict, tally, expandStage, runPlan, abortPlans, getPlan, buildPrompt,
  calls, pick, handler, attempt, delegate, conductorToolDefs, selOf,
} from './_helpers.mjs';

test('findings and verdicts are read from JSON blocks, with sane fallbacks', () => {
  const report = 'Looked around.\n```json\n{"findings":[{"title":"Null deref","file":"a.js","line":3,"severity":"high"}]}\n```';
  const fs = findingsOf(report, 't1');
  assert.equal(fs.length, 1); assert.equal(fs[0].id, 't1-1'); assert.equal(fs[0].source, 't1');
  assert.equal(findingsOf('plain prose report', 't2')[0].title, 'plain prose report');
  assert.equal(findingsOf('', 't3').length, 0);
  assert.equal(findingKey({ file: 'A.JS', title: 'Null   deref' }), 'a.js|null deref');
  assert.equal(parseVerdict('```json\n{"real": false, "reason": "handled upstream"}\n```').real, false);
  assert.equal(parseVerdict('{"verdict":"confirmed"}').real, true);
  assert.equal(parseVerdict('{"score": 7}').real, true);
  assert.equal(parseVerdict('I could not reproduce it; refuted.').real, false);
  assert.equal(parseVerdict('Confirmed: reproduces with input 0.').real, true);
});

test('unfenced nested JSON extracts the outer object; a parsed object is not a prose verdict', () => {
  const nested = '{"findings":[{"title":"Null deref","file":"a.js","severity":"high"}]}';
  assert.equal(findingsOf(nested, 't4').length, 1);
  assert.equal(findingsOf(nested, 't4')[0].title, 'Null deref');
  const v = parseVerdict('{"real":false,"reason":"has {brace}"}');
  assert.equal(v.real, false);
  assert.match(v.reason, /brace/);
  assert.equal(parseVerdict('On a 12" screen it looks real. {"real":false,"reason":"not reproducible"}').real, false); // an odd prose quote
  const prose = parseVerdict('```json\n{"note":"this is real and confirmed"}\n```');
  assert.equal(prose.real, false);
  assert.match(prose.reason, /note/);
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
  assert.equal(parseVerdict(bomb).real, false);
  assert.equal(findingsOf(bomb, 't')[0].title.length, 140);
  const ms = performance.now() - t0;
  t.diagnostic(`brace bomb: ${ms.toFixed(2)} ms`);
  assert.ok(ms < 200, `brace bomb took ${ms} ms`);
});

test('tally modes', () => {
  const v = [{ real: true }, { real: false }, { real: true }];
  assert.equal(tally(v).confirmed, true);
  assert.equal(tally(v, 'all').confirmed, false);
  assert.equal(tally([{ real: false }, { real: true }], 'any').confirmed, true);
  assert.equal(tally([]).confirmed, false);
});

test('all votes failed in voting stage marks stage incomplete and prevents dependent fixes', async (t) => {
  for (const pass of ['all', 'majority', 'any']) {
    for (const statuses of [['failed', 'failed', 'failed'], ['canceled', 'canceled', 'canceled']]) {
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
        for (const field of ['findings', 'confirmed', 'rejected', 'unverified']) assert.deepEqual(out.stages.vote[field], []);
        assert.equal(out.stages.fix, undefined);
        assert.equal(out.stages.rejected, undefined);
        assert.match(out.report, /Incomplete: all voters failed or were canceled; no verdict was reached/);
        assert.equal(readJson(statePath('plans', `${out.id}.json`)).status, 'incomplete');
      });
    }
  }
});

test('mixed ok and failed votes tally on finished votes, and following stage runs', async (t) => {
  for (const pass of ['all', 'majority', 'any']) {
    await t.test(pass, async () => {
      const created = [];
      const out = await runPlan({ stages: [
        { id: 'find', tasks: [{ spec: 'find' }] },
        { id: 'vote', for_each: 'find', votes: 3, pass, task: { spec: 'vote {{item}}' } },
        { id: 'fix', for_each: 'vote.confirmed', task: { spec: 'fix {{item}}' } },
      ] }, { taskRuntime: {
        createTask(input) { created.push(input); return { id: String(created.length) }; },
        async awaitTask(id) {
          const statuses = ['done', 'failed', 'canceled'];
          return { id, status: id === '1' ? 'done' : id === '5' ? 'done' : statuses[Number(id) - 2], result: {
            finalMessage: id === '1' ? '{"findings":[{"id":"bug","title":"Bug"}]}' : id === '5' ? 'fixed' : '{"real":true}',
          } };
        },
        getTask() { assert.fail('use terminal snapshots'); },
      } });
      assert.equal(created.length, 5); // find + 3 votes + 1 fix
      assert.equal(out.status, 'done');
      assert.equal(out.stages.vote.incomplete, undefined);
      assert.equal(out.stages.vote.confirmed.length, 1);
      assert.equal(out.stages.vote.confirmed[0].tally, '1/1 (2 votes failed)');
      assert.equal(out.stages.vote.rejected.length, 0);
      assert.equal(out.stages.vote.unverified.length, 0);
      assert.equal(out.stages.fix.tasks.length, 1);
      assert.match(out.stages.vote.summary, /1 confirmed, 0 rejected/);
      assert.match(out.stages.vote.summary, /1\/1 \(2 votes failed\)/);
      assert.match(out.report, /1\/1 \(2 votes failed\)/);
    });
  }
});

test('item with all votes failed goes to unverified with failed task ids, and results/report show unverified', async () => {
  const created = [];
  const out = await runPlan({ stages: [
    { id: 'find', tasks: [{ spec: 'find' }] },
    { id: 'vote', for_each: 'find', votes: 2, task: { spec: 'vote {{item}}' } },
    { id: 'critic', tasks: [{ spec: 'Critique:\n{{results:vote}}' }] },
    { id: 'recheck', for_each: 'vote.unverified', task: { spec: 'recheck {{item}}' } },
  ] }, { taskRuntime: {
    createTask(input) { created.push(input); return { id: `t${created.length}` }; },
    async awaitTask(id) {
      if (id === 't1') {
        return { id, status: 'done', result: { finalMessage: JSON.stringify({ findings: [
          { id: 'b1', title: 'Bug One', file: 'src/one.js', severity: 'high' },
          { id: 'b2', title: 'Bug Two', file: 'src/two.js', severity: 'medium' },
        ] }) } };
      }
      if (id === 't2') return { id, status: 'done', result: { finalMessage: '{"real":true,"reason":"confirmed"}' } };
      if (id === 't3') return { id, status: 'failed', error: 'crash', result: {} };
      if (id === 't4') return { id, status: 'failed', error: 'timeout', result: {} };
      if (id === 't5') return { id, status: 'canceled', error: 'abort', result: {} };
      return { id, status: 'done', result: { finalMessage: 'ok' } };
    },
    getTask() { assert.fail('use terminal snapshots'); },
  } });
  assert.equal(out.status, 'done');
  assert.equal(out.stages.vote.incomplete, undefined);
  assert.equal(out.stages.vote.confirmed.length, 1);
  assert.equal(out.stages.vote.confirmed[0].id, 'b1');
  assert.equal(out.stages.vote.confirmed[0].tally, '1/1 (1 vote failed)');
  assert.equal(out.stages.vote.rejected.length, 0);
  assert.equal(out.stages.vote.unverified.length, 1);
  assert.equal(out.stages.vote.unverified[0].id, 'b2');
  assert.deepEqual(out.stages.vote.unverified[0].failedTasks, ['t4', 't5']);
  assert.match(out.stages.vote.summary, /1 confirmed, 0 rejected, 1 unverified/);
  assert.match(out.stages.vote.summary, /- \[high\] src\/one\.js: Bug One \(1\/1 \(1 vote failed\)\)/);
  assert.match(out.stages.vote.summary, /- \[medium\] src\/two\.js: Bug Two \(unverified: failed tasks t4, t5\)/);
  assert.match(out.report, /Bug Two \(unverified: failed tasks t4, t5\)/);
  const criticTask = created.find((c) => c.spec.startsWith('Critique:'));
  assert.ok(criticTask, 'critic task was created');
  assert.match(criticTask.spec, /Bug One/);
  assert.match(criticTask.spec, /Unverified:/);
  assert.match(criticTask.spec, /Bug Two/);
  assert.match(criticTask.spec, /"failedTasks": \[\s*"t4",\s*"t5"\s*\]/);
  const recheckTask = created.find((c) => c.spec.startsWith('Stage: recheck'));
  assert.ok(recheckTask, 'recheck task ran on unverified item');
  assert.match(recheckTask.spec, /Bug Two/);
});

test('tally and pass rule over finished votes with different outcomes and modes', async (t) => {
  for (const { pass, expectedConfirmed } of [
    { pass: 'any', expectedConfirmed: true },
    { pass: 'majority', expectedConfirmed: false },
    { pass: 'all', expectedConfirmed: false },
  ]) {
    await t.test(pass, async () => {
      let n = 0;
      const out = await runPlan({ stages: [
        { id: 'find', tasks: [{ spec: 'find' }] },
        { id: 'vote', for_each: 'find', votes: 3, pass, task: { spec: 'vote {{item}}' } },
      ] }, { taskRuntime: {
        createTask() { return { id: String(++n) }; },
        async awaitTask(id) {
          if (id === '1') return { id, status: 'done', result: { finalMessage: '{"findings":[{"title":"Bug"}]}' } };
          if (id === '2') return { id, status: 'done', result: { finalMessage: '{"real":true}' } };
          if (id === '3') return { id, status: 'done', result: { finalMessage: '{"real":false}' } };
          return { id, status: 'failed', error: 'boom', result: {} };
        },
        getTask() { assert.fail('use terminal snapshots'); },
      } });
      assert.equal(out.status, 'done');
      if (expectedConfirmed) {
        assert.equal(out.stages.vote.confirmed.length, 1);
        assert.equal(out.stages.vote.confirmed[0].tally, '1/2 (1 vote failed)');
      } else {
        assert.equal(out.stages.vote.rejected.length, 1);
        assert.equal(out.stages.vote.rejected[0].tally, '1/2 (1 vote failed)');
      }
    });
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

test('L45: findings without title/file fall back to issue/summary and a content key', () => {
  assert.notEqual(findingKey({ issue: 'alpha-bug' }), findingKey({ issue: 'beta-bug' }));
  assert.notEqual(findingKey({ summary: 'one' }), findingKey({ summary: 'two' }));
  assert.notEqual(findingKey({ extra: 'unique-payload-1' }), findingKey({ extra: 'unique-payload-2' }));
  assert.equal(findingKey({ location: 'A.JS', issue: 'Null   deref' }), 'a.js|null deref');
});
