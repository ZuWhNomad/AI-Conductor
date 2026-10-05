import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME, readJson, writeJson, statePath, saveConfig, loadConfig, bus, setSessionFlags, createTask, getTask,
  validatePlan, findingsOf, findingKey, parseVerdict, tally, expandStage, runPlan, abortPlans, getPlan, buildPrompt,
  calls, pick, handler, attempt, delegate, conductorToolDefs, selOf,
} from './_helpers.mjs';

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
        const output = input.spec.startsWith('Stage: vote\n') ? { real: true, reason: 'verified' }
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
        const output = input.spec.startsWith('Stage: vote\n') ? { real: true } : { findings: [finding, finding] };
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
  for (const input of created.slice(1)) assert.match(input.spec, /seen: - Bug A \(a.mjs\)/);
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
