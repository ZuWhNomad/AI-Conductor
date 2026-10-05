import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME, readJson, writeJson, statePath, saveConfig, loadConfig, bus, setSessionFlags, createTask, getTask,
  validatePlan, findingsOf, findingKey, parseVerdict, tally, expandStage, runPlan, abortPlans, getPlan, buildPrompt,
  calls, pick, handler, attempt, delegate, conductorToolDefs, selOf,
} from './_helpers.mjs';

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

test('L22: the first quality failure after a failover is still the value fallback, not an escalation', async () => {
  const original = attempt();
  const failover = attempt({ title: `FAILOVER: ${original.title}`, model: 'other', retryOf: original.retryOf, reroutedFrom: original.id });
  original.failedOverTo = failover.id; // what tasks.mjs failover() records on the exhausted task
  calls.length = 0;
  await delegate(failover);
  assert.equal(calls.at(-1).escalate, false, 'the first counted failure is still below the escalation depth');
});

test('retry_of skips limit-cut and never-started attempts but counts a started cancellation', async () => {
  for (const [stop, escalate] of [
    [{ status: 'canceled', limitHit: true }, false],
    [{ status: 'canceled' }, true],
    [{ status: 'failed', limitHit: true }, false],
    [{ status: 'canceled', attempts: 0 }, false],
  ]) {
    const original = attempt();
    const stopped = attempt({ model: 'other', retryOf: original.id });
    Object.assign(stopped, stop);
    calls.length = 0;
    await delegate(stopped);
    assert.equal(calls.at(-1).escalate, escalate, JSON.stringify(stop));
  }
  // Control: a real failed retry after the original is a model switch (depth 2), so the next retry escalates.
  const original = attempt();
  const failed = attempt({ model: 'other', retryOf: original.id });
  failed.status = 'failed';
  calls.length = 0;
  await delegate(failed);
  assert.equal(calls.at(-1).escalate, true);
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
