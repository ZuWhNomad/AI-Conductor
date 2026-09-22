import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { escalationState, conductorToolDefs } = await import('../core/tools.mjs');

// maxRounds 3, escalationRounds 2 (the defaults) unless noted.
const S = (o) => escalationState({ maxRounds: 3, escRounds: 2, ...o });

test('no failed task: never an escalation', () => {
  const s = S({ hasFailed: false, depth: 0 });
  assert.equal(s.escalate, false); assert.equal(s.escalationsUsed, 0); assert.equal(s.blocked, false);
});

test('review-first path: retry after the reviewed worker escalates immediately, bounded to escalationRounds', () => {
  // depth 1 = first retry_of the reviewed worker (rounds 3). This IS escalation #1.
  const e1 = S({ hasFailed: true, depth: 1, rootRounds: 3, failedRounds: 3 });
  assert.deepEqual([e1.escalate, e1.escalationsUsed, e1.blocked, e1.remaining], [true, 0, false, 1]);
  // depth 2 = the second best-available attempt (its own rounds 0; root still reviewed). Escalation #2, last one.
  const e2 = S({ hasFailed: true, depth: 2, rootRounds: 3, failedRounds: 0 });
  assert.deepEqual([e2.escalate, e2.escalationsUsed, e2.blocked, e2.remaining], [true, 1, false, 0]);
  // depth 3 = escalation budget spent -> the conductor takes over.
  const e3 = S({ hasFailed: true, depth: 3, rootRounds: 3, failedRounds: 0 });
  assert.equal(e3.blocked, true); assert.equal(e3.escalationsUsed, 2);
});

test('value-fallback path: the first retry is a value rung and is NOT counted as an escalation (the off-by-one fix)', () => {
  // root never reviewed. depth 1 = value fallback, not an escalation.
  const v = S({ hasFailed: true, depth: 1, rootRounds: 0, failedRounds: 0 });
  assert.equal(v.escalate, false); assert.equal(v.escalationsUsed, 0);
  // depth 2 = FIRST real escalation (value fallback not counted). Old buggy code reported escalationsUsed 1 here.
  const e1 = S({ hasFailed: true, depth: 2, rootRounds: 0, failedRounds: 0 });
  assert.deepEqual([e1.escalate, e1.escalationsUsed, e1.blocked, e1.remaining], [true, 0, false, 1]);
  // depth 3 = second escalation; depth 4 = budget spent.
  assert.equal(S({ hasFailed: true, depth: 3, rootRounds: 0 }).escalationsUsed, 1);
  assert.equal(S({ hasFailed: true, depth: 4, rootRounds: 0 }).blocked, true);
});

test('escalationRounds 0 disables escalation: the reviewed worker hands straight to the conductor', () => {
  const s = escalationState({ hasFailed: true, depth: 1, rootRounds: 3, failedRounds: 3, maxRounds: 3, escRounds: 0 });
  assert.equal(s.escalate, true); assert.equal(s.blocked, true); // escalate would apply, but the budget is 0 -> blocked now
});

// --- "escalate, or stay at the ceiling" -------------------------------------------------------------------
const { atCeiling, selOf } = await import('../core/tools.mjs');

test('selOf normalises a task and a recommend() pick to the same selection string', () => {
  assert.equal(selOf({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' }), 'codex:gpt-6-astra:ultra');
  assert.equal(selOf({ provider: 'claude' }), 'claude:default:default'); // absent model/effort are the defaults
});

test('at the ceiling: the best available IS the failed worker, so a retry_of would route downward', () => {
  const failed = { provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' };
  assert.equal(atCeiling({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' }, failed), true);
});

test('not at the ceiling: a better model, or the same model at a higher effort, is a real escalation', () => {
  const failed = { provider: 'codex', model: 'gpt-6-astra', effort: 'high' };
  assert.equal(atCeiling({ provider: 'claude', model: 'claude-opus-4-8', effort: 'max' }, failed), false);
  // effort is part of the selection: same model, higher effort, still an escalation
  assert.equal(atCeiling({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' }, failed), false);
});

test('no pick and no failed task are never "at the ceiling"', () => {
  assert.equal(atCeiling(null, { provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' }), false);
  assert.equal(atCeiling({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' }, null), false);
});

test('OB8: rate_task follows failedOverTo so the rating reaches the replacement chain', async () => {
  const { createTask, cancelTask } = await import('../core/tasks.mjs');
  const sc = await import('../core/scorecard.mjs');
  const cwd = tmpDir('ob8');
  const t1 = createTask({ cwd, title: 'T1', spec: 'x', provider: 'codex', model: 'gpt-5.6-luna' });
  const t2 = createTask({ cwd, title: 'T2', spec: 'x', provider: 'ollama', model: 'qwen' });
  try {
    t1.failedOverTo = t2.id;
    sc.recordRun({ id: t2.id, title: 'T2', status: 'done', provider: 'ollama', model: 'qwen', category: 'edit', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } });
    const rate = conductorToolDefs({ sessionId: 'ob8', cwd }).find((d) => d.name === 'rate_task').handler;
    const msg = await rate({ task_id: t1.id, verdict: 'pass' });
    assert.equal(msg, `rated ${t2.id} (followed failedOverTo from ${t1.id}): pass`);
    assert.equal(sc.rootRuns().find((c) => c.taskId === t2.id)?.verdict, 'pass');
    assert.equal(sc.rootRuns().find((c) => c.taskId === t1.id), undefined);
  } finally { cancelTask(t1.id); cancelTask(t2.id); }
});
