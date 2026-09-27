import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bus } from '../core/bus.mjs';
import { createWatchdog, registerWatch, listWatches } from '../core/watchdog.mjs';
import { createTask, getTask, touchTaskAlive, cancelTask } from '../core/tasks.mjs';
import { statePath, writeJson } from '../core/paths.mjs';

const cfg = () => ({ watchdog: { intervalMinutes: 30 } });

test('basic tick checks in each running chat/task and marks a tick over two intervals late', async () => {
  writeJson(statePath('watches.json'), []);
  let now = Date.parse('2026-09-27T12:00:00.000Z');
  const sessions = [{ id: 'wd-session', status: 'running', startedAt: new Date(now - 3_600_000).toISOString() }];
  const tasks = [{ id: 'wd-task', sessionId: 'wd-session', status: 'running', startedAt: new Date(now - 7_200_000).toISOString() }];
  const sessionChecks = [], taskChecks = [], events = [];
  const watchdog = createWatchdog({
    listSessions: () => sessions, listTasks: () => tasks,
    recordSessionCheckIn: (_id, state) => { sessionChecks.push(state); return true; },
    touchTaskAlive: (_id, state, at) => { taskChecks.push({ state, at }); return true; },
    markTaskWakeReported() {}, sendMessage: async () => assert.fail('running chat must not be woken'),
    jobStatus: () => null, publish: (event) => events.push(event), config: cfg, clock: () => now,
  });
  await watchdog.tick();
  now += 61 * 60_000;
  await watchdog.tick();
  assert.deepEqual(sessionChecks.map((x) => x.late), [false, true]);
  assert.deepEqual(taskChecks.map((x) => x.state.late), [false, true]);
  assert.equal(events.length, 4, 'one watchdog event per running item per tick');
  assert.equal(events.filter((e) => e.itemKind === 'task').length, 2);
});

test('aliveAt is journaled quietly without a task event', () => {
  const task = createTask({ cwd: tmpDir('watchdog-alive'), sessionId: 'quiet-session' });
  task.status = 'running';
  const seen = [];
  const onEvent = (event) => seen.push(event);
  bus.on('event', onEvent);
  try {
    const at = '2026-09-27T12:30:00.000Z';
    assert.equal(touchTaskAlive(task.id, { verdict: 'running', checkedAt: at, summary: 'check-in' }, at), true);
    assert.equal(JSON.parse(readFileSync(join(HOME, 'tasks', `${task.id}.json`), 'utf8')).aliveAt, at);
    assert.equal(seen.some((event) => event.type === 'task'), false);
  } finally { bus.off('event', onEvent); cancelTask(task.id); }
});

test('idle chat wakes once only after every task and detached watch is terminal', async () => {
  writeJson(statePath('watches.json'), []);
  const sessions = [{ id: 'wake-session', status: 'idle' }];
  const tasks = [
    { id: 'done-one', sessionId: 'wake-session', status: 'done', wakeEligible: true },
    { id: 'last-one', sessionId: 'wake-session', status: 'parked', wakeEligible: true },
    { id: 'already-read', sessionId: 'wake-session', status: 'done', wakeEligible: true, wakeConsumedAt: '2026-09-27T11:00:00.000Z' },
  ];
  registerWatch({ sessionId: 'wake-session', jobId: 'jobwake1', note: 'inspect the report' });
  assert.equal(listWatches({ sessionId: 'wake-session' }).length, 1, 'watch is persisted');
  let jobState = 'running';
  const messages = [];
  const watchdog = createWatchdog({
    listSessions: () => sessions, listTasks: () => tasks,
    recordSessionCheckIn: () => false, touchTaskAlive: () => false,
    markTaskWakeReported: (ids, at) => { for (const task of tasks.filter((t) => ids.includes(t.id))) task.wakeReportedAt = at; },
    sendMessage: async (_id, message) => { messages.push(message); },
    jobStatus: () => ({ status: jobState, exitCode: 0 }), publish: () => {}, config: cfg,
    clock: () => Date.parse('2026-09-27T13:00:00.000Z'),
  });
  await watchdog.tick();
  assert.equal(messages.length, 0, 'a finished task does not wake while another task and job remain outstanding');
  tasks[1].status = 'done';
  await watchdog.tick();
  assert.equal(messages.length, 0, 'the finished task batch still waits for its detached job');
  jobState = 'done';
  await watchdog.tick();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /All background work.*done-one \(done\).*last-one \(done\).*job jobwake1 \(done\).*inspect the report/);
  assert.doesNotMatch(messages[0], /already-read/);
  assert.ok(tasks.slice(0, 2).every((task) => task.wakeReportedAt));
  assert.ok(listWatches({ sessionId: 'wake-session' })[0].wakeReportedAt);
  await watchdog.tick();
  assert.equal(messages.length, 1, 'reported work never wakes the chat twice');
});
