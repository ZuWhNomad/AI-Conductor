import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-session "parallel override": a chat's delegated tasks skip Conductor's budget gate, which otherwise holds a
// provider to one task at a time while its window is over target or a task's cost is not yet measured.
const conductor = await import('../core/conductor.mjs');
const { sessionFlags } = await import('../core/session-flags.mjs');
const { createTask, getTask, schedule, cancelTask, abortRunning } = await import('../core/tasks.mjs');
const lim = await import('../core/limits.mjs');
const dir = (n) => mkdtempSync(join(tmpdir(), `parallel-${n}-`));

test('a new chat seeds its routing flags, so the delegate tools see them without a toggle click', () => {
  const s = conductor.createSession({ cwd: dir('seed'), overflowApi: true, parallelOverride: true });
  // The API-overflow half is a regression test: the flag store used to be written only by the toggle, so a chat
  // created with API overflow on read it as off until the box was unticked and ticked again.
  assert.equal(sessionFlags(s.id).overflowApi, true);
  assert.equal(sessionFlags(s.id).parallelOverride, true);
  assert.equal(conductor.publicSession(s).parallelOverride, true);
  const plain = conductor.createSession({ cwd: dir('plain') });
  assert.equal(sessionFlags(plain.id).parallelOverride, false, 'off unless asked for');
});

test('the toggle updates the session, the public view and the flag store together', () => {
  const s = conductor.createSession({ cwd: dir('toggle') });
  const live = () => conductor.listSessions().find((x) => x.id === s.id); // createSession returns a snapshot
  conductor.setParallel(s.id, true);
  assert.equal(sessionFlags(s.id).parallelOverride, true);
  assert.equal(live().parallelOverride, true);
  conductor.setParallel(s.id, false);
  assert.equal(sessionFlags(s.id).parallelOverride, false);
  assert.throws(() => conductor.setParallel('nope', true), { status: 404 });
});

test('a task carries the override, and a follow-up keeps it', () => {
  const t = createTask({ cwd: dir('carry'), provider: 'deepseek', spec: 'x', parallelOverride: true });
  assert.equal(t.parallelOverride, true);
  const plain = createTask({ cwd: dir('carry2'), provider: 'deepseek', spec: 'x' });
  assert.equal(plain.parallelOverride, false);
  // A follow-up of an overridden task keeps the override even when the follow-up call does not repeat it.
  Object.assign(t, { threadId: 'thread-1', status: 'done' });
  const follow = createTask({ cwd: t.cwd, spec: 'y', followUpOf: t.id });
  assert.equal(follow.parallelOverride, true);
  // a leftover queued task would become the probe and skew the scheduler test
  for (const x of [t, plain, follow]) cancelTask(x.id);
});

test('the budget gate holds a second task on an unmeasured provider; the override lets both run', async (ctx) => {
  ctx.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }); }));
  // A windowed provider with no cost history: the first task is a probe, and the gate holds everything else on it.
  lim.getLimits().providers.deepseek = { provider: 'deepseek', windows: [{ id: 'deepseek:budget', label: 'budget', usedPercent: 10 }] };
  const run = (override) => {
    const batch = [dir('g1'), dir('g2')].map((cwd) => createTask({ cwd, provider: 'deepseek', spec: 'x', parallelOverride: override }));
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    try { schedule(); return batch.map((t) => getTask(t.id).status); }
    finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; abortRunning(); for (const t of batch) cancelTask(t.id); }
  };
  try {
    assert.deepEqual(run(false), ['running', 'queued'], 'without the override the gate holds the second task');
    assert.deepEqual(run(true), ['running', 'running'], 'with it, both dispatch at once');
  } finally { delete lim.getLimits().providers.deepseek; }
});

test('the override does not lift a real provider limit: a blocked provider still parks the task', () => {
  lim.noteHttp('deepseek', 429, { 'Retry-After': '60' });
  const t = createTask({ cwd: dir('blocked'), provider: 'deepseek', spec: 'x', parallelOverride: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try { schedule(); assert.notEqual(getTask(t.id).status, 'running'); }
  finally { process.env.CONDUCTOR_NO_SCHEDULE = '1'; cancelTask(t.id); lim.noteHttp('deepseek', 200, {}); delete lim.getLimits().providers.deepseek; }
});
