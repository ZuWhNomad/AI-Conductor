import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bus } from '../core/bus.ts';
import { classify, createWatchdog, recentFileActivity, registerWatch, listWatches } from '../core/watchdog.mjs';
import { createTask, getTask, touchTaskAlive, cancelTask } from '../core/tasks.mjs';
import { statePath, writeJson } from '../core/paths.ts';

const cfg = () => ({ watchdog: { intervalMinutes: 30, killAfterStuckChecks: 3, loopRepeat: 5 } });
const noSnapshot = async () => ({ ok: false, processes: new Map() });
const noProcess = () => ({ available: false, alive: false, cpuSeconds: null, rssBytes: null, names: [] });
const noFiles = () => ({ changed: false });

test('classify covers waits, loops, progress, quiet CPU work, stuck counters and late reset', () => {
  const settings = cfg().watchdog;
  const dead = { available: true, alive: false, cpuSeconds: 0, names: [] };
  const live = { available: true, alive: true, cpuSeconds: 10, names: ['python.exe'] };
  assert.equal(classify(null, { waitingOwner: true, eventDelta: 9, toolRepeat: 9 }, settings).verdict, 'waiting-owner');
  assert.deepEqual(classify(null, { waitingTasks: ['t'], waitingOnVerdict: 'quiet-alive' }, settings), { verdict: 'waiting-task', stuckChecks: 0, loopChecks: 0, waitingOnVerdict: 'quiet-alive' });
  assert.equal(classify(null, { parked: true }, settings).verdict, 'waiting-owner');
  assert.equal(classify(null, { eventDelta: 5, toolRepeat: 5, fileChanged: false }, settings).verdict, 'looping', 'specific repeat signal outranks generic events');
  assert.notEqual(classify(null, { tokenDelta: 20_000_000, fileChanged: false }, settings).verdict, 'looping', 'tokens alone never signal a loop');
  assert.equal(classify(null, { toolLessTurns: 5, fileChanged: false }, settings).verdict, 'looping', 'repeated tool-less turns signal a loop');
  assert.equal(classify(null, { toolRepeat: 5, fileChanged: true }, settings).verdict, 'progressing', 'a written file is concrete progress');
  assert.equal(classify(null, { eventDelta: 1, process: dead }, settings).verdict, 'progressing');
  assert.equal(classify(null, { process: live, cpuDelta: 1 }, settings).verdict, 'quiet-alive');
  assert.equal(classify(null, { process: { available: false } }, settings).verdict, 'quiet-alive', 'a failed OS probe is not proof of a hang');
  const first = classify(null, { process: dead }, settings);
  const second = classify(first, { process: dead }, settings);
  assert.equal(second.verdict, 'stuck'); assert.equal(second.stuckChecks, 2);
  const late = classify(second, { late: true, process: dead }, settings);
  assert.equal(late.verdict, 'quiet-alive'); assert.equal(late.stuckChecks, 0);
});

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
    jobStatus: () => null, processSnapshot: noSnapshot, processSample: noProcess, fileSample: noFiles,
    publish: (event) => events.push(event), logFriction: () => {}, config: cfg, clock: () => now,
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
    jobStatus: () => ({ status: jobState, exitCode: 0 }), processSnapshot: noSnapshot, processSample: noProcess, fileSample: noFiles,
    publish: () => {}, logFriction: () => {}, config: cfg,
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

test('bounded file sampling finds work files and skips dependency/cache trees', () => {
  const cwd = tmpDir('watchdog-files');
  const before = Date.now() - 1000;
  mkdirSync(join(cwd, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(cwd, 'node_modules', 'pkg', 'generated.js'), 'ignored');
  assert.equal(recentFileActivity(cwd, before).changed, false);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'changed.js'), 'changed');
  assert.equal(recentFileActivity(cwd, before).changed, true);
});

test('CPU-active work remains quiet-alive while dead silence is failed once on the configured third check', async () => {
  writeJson(statePath('watches.json'), []);
  let now = Date.parse('2026-09-27T12:00:00.000Z'), cpu = 10;
  const tasks = [
    { id: 'cpu-task', status: 'running', cwd: HOME, startedAt: new Date(now - 3_600_000).toISOString() },
    { id: 'dead-task', status: 'running', cwd: HOME, startedAt: new Date(now - 3_600_000).toISOString() },
  ];
  const checks = [], failed = [];
  const watchdog = createWatchdog({
    listSessions: () => [], listTasks: () => tasks,
    touchTaskAlive: (id, state) => { checks.push([id, state.verdict, state.stuckChecks]); return true; },
    markTaskWakeReported() {}, recordSessionCheckIn: () => false, sendMessage: async () => {}, jobStatus: () => null,
    processSnapshot: async () => ({ ok: true, processes: new Map() }),
    processSample: (owner) => owner === 'cpu-task'
      ? { available: true, alive: true, cpuSeconds: cpu, rssBytes: 1, names: ['python.exe'] }
      : { available: true, alive: false, cpuSeconds: 0, rssBytes: 0, names: [] },
    fileSample: noFiles, failHungTask: (id, reason) => { failed.push([id, reason]); tasks.find((t) => t.id === id).status = 'failed'; },
    publish: () => {}, logFriction: () => {}, config: cfg, clock: () => now,
  });
  await watchdog.tick();
  for (let i = 0; i < 2; i++) { now += 30 * 60_000; cpu += 2; await watchdog.tick(); }
  assert.deepEqual(failed.map(([id]) => id), ['dead-task']);
  assert.match(failed[0][1], /3 checks \(90 min\)/);
  assert.ok(checks.filter(([id]) => id === 'cpu-task').every(([, verdict]) => verdict === 'quiet-alive'));
});

test('pending permission is resurfaced and a chat waiting on a quiet task inherits that verdict without interruption', async () => {
  writeJson(statePath('watches.json'), []);
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const sessions = [
    { id: 'owner-chat', status: 'running', pendingCount: 1, cwd: HOME, startedAt: new Date(now - 60_000).toISOString() },
    { id: 'waiting-chat', status: 'running', pendingCount: 0, cwd: HOME, startedAt: new Date(now - 60_000).toISOString() },
  ];
  const tasks = [{ id: 'quiet-task', sessionId: 'waiting-chat', status: 'running', cwd: HOME, startedAt: new Date(now - 60_000).toISOString() }];
  const sessionChecks = [], resurfaced = [], interrupted = [];
  const watchdog = createWatchdog({
    listSessions: () => sessions, listTasks: () => tasks,
    touchTaskAlive: () => true, markTaskWakeReported() {}, recordSessionCheckIn: (id, state) => { sessionChecks.push([id, state]); return true; },
    sendMessage: async () => {}, jobStatus: () => null, waitingTasks: (id) => id === 'waiting-chat' ? ['quiet-task'] : [],
    resurfacePermissions: (id) => resurfaced.push(id), interrupt: async (id) => interrupted.push(id),
    processSnapshot: async () => ({ ok: true, processes: new Map() }),
    processSample: (owner) => owner === 'quiet-task'
      ? { available: true, alive: true, cpuSeconds: 10, rssBytes: 1, names: ['python.exe'] }
      : { available: true, alive: false, cpuSeconds: 0, rssBytes: 0, names: [] },
    fileSample: noFiles, publish: () => {}, logFriction: () => {}, config: cfg, clock: () => now,
  });
  await watchdog.tick();
  assert.deepEqual(resurfaced, ['owner-chat']);
  assert.equal(sessionChecks.find(([id]) => id === 'owner-chat')[1].verdict, 'waiting-owner');
  const waiting = sessionChecks.find(([id]) => id === 'waiting-chat')[1];
  assert.equal(waiting.verdict, 'waiting-task'); assert.equal(waiting.waitingOnVerdict, 'quiet-alive');
  assert.deepEqual(interrupted, []);
});

test('a worker task repeating the same tool call is classified looping (task events keep loop counts)', async () => {
  writeJson(statePath('watches.json'), []);
  const id = 'loop-task';
  for (let i = 0; i < 5; i++) bus.publish('worker', { taskId: id, event: 'item', phase: 'started', item: { type: 'command_execution', command: 'npm test' } });
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const tasks = [{ id, status: 'running', cwd: HOME, startedAt: new Date(now - 60_000).toISOString() }];
  const checks = [], friction = [], nudges = [], interrupts = [];
  const watchdog = createWatchdog({
    listSessions: () => [], listTasks: () => tasks, touchTaskAlive: (_id, state) => { checks.push(state.verdict); return true; },
    markTaskWakeReported() {}, recordSessionCheckIn: () => false, sendMessage: async () => {}, jobStatus: () => null,
    nudgeRunaway: (sid) => nudges.push(sid), interrupt: async (sid) => interrupts.push(sid),
    processSnapshot: noSnapshot, processSample: noProcess, fileSample: noFiles,
    publish: () => {}, logFriction: (...entry) => friction.push(entry), config: cfg, clock: () => now,
  });
  await watchdog.tick();
  assert.deepEqual(checks, ['looping']);
  assert.equal(friction.length, 1);
  assert.deepEqual(nudges, []);
  assert.deepEqual(interrupts, []);
});

test('a looping Claude chat is nudged once and never interrupted across checks', async () => {
  writeJson(statePath('watches.json'), []);
  const id = 'runaway-chat';
  for (let i = 0; i < 5; i++) bus.publish('session', { sessionId: id, kind: 'assistant', blocks: [{ type: 'text', text: 'still running' }] });
  let now = Date.parse('2026-09-27T12:00:00.000Z');
  const sessions = [{ id, status: 'running', cwd: HOME, startedAt: new Date(now - 60_000).toISOString() }];
  const checks = [], nudges = [], stops = [], events = [];
  const watchdog = createWatchdog({
    listSessions: () => sessions, listTasks: () => [], touchTaskAlive: () => false, markTaskWakeReported() {},
    recordSessionCheckIn: (_id, state) => { checks.push(state); return true; }, sendMessage: async () => {}, jobStatus: () => null,
    canNudge: () => true, nudgeRunaway: (sid) => { nudges.push(sid); return true; },
    interrupt: async (sid, reason) => { stops.push([sid, reason]); return true; },
    processSnapshot: noSnapshot, processSample: noProcess, fileSample: noFiles,
    publish: (event) => events.push(event), logFriction: () => {}, config: cfg, clock: () => now,
  });
  for (let i = 0; i < 4; i++) { await watchdog.tick(); now += 30 * 60_000; }
  assert.deepEqual(checks.map((x) => [x.verdict, x.loopChecks]), [['looping', 1], ['looping', 2], ['looping', 3], ['looping', 4]]);
  assert.deepEqual(nudges, [id]);
  assert.deepEqual(stops, []);
  assert.ok(checks.every((x) => x.loopAction === 'nudged' && x.summary.includes('nudged')));
  assert.ok(events.every((event) => event.summary.includes('nudged')));
});

test('a looping Codex chat is alert-only and is never nudged or interrupted', async () => {
  writeJson(statePath('watches.json'), []);
  const id = 'looping-codex';
  for (let i = 0; i < 5; i++) bus.publish('session', { sessionId: id, kind: 'assistant', blocks: [{ type: 'text', text: 'still running' }] });
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  const sessions = [{ id, runtime: 'codex', status: 'running', cwd: HOME, startedAt: new Date(now - 60_000).toISOString() }];
  const nudges = [], interrupts = [], events = [];
  const watchdog = createWatchdog({
    listSessions: () => sessions, listTasks: () => [], touchTaskAlive: () => false, markTaskWakeReported() {},
    recordSessionCheckIn: () => true, sendMessage: async () => {}, jobStatus: () => null,
    canNudge: () => false, nudgeRunaway: (sid) => nudges.push(sid), interrupt: async (sid) => interrupts.push(sid),
    processSnapshot: noSnapshot, processSample: noProcess, fileSample: noFiles,
    publish: (event) => events.push(event), logFriction: () => {}, config: cfg, clock: () => now,
  });
  await watchdog.tick();
  assert.deepEqual(nudges, []);
  assert.deepEqual(interrupts, []);
  assert.match(events[0].summary, /alert only \(runtime cannot take mid-turn input\)/);
});
