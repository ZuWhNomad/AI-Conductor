import { HOME } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Use the production relaunch handover allowance (see relaunch.test.mjs) for each deadline.
const waitMs = 20_000;
const journal = id => JSON.parse(readFileSync(join(HOME, 'tasks', `${id}.json`), 'utf8'));
const write = task => writeFileSync(join(HOME, 'tasks', `${task.id}.json`), JSON.stringify(task));

async function until(check, label, child) {
  const deadline = Date.now() + waitMs;
  do {
    const value = await check();
    if (value) return value;
    assert.ok(!child?.closed, `${label}: child exited\n${child?.output}`);
    // Match the shutdown route's response-to-abort delay; no timing assertion depends on polling cadence.
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`${label}: deadline exceeded\n${child?.output || ''}`);
}

function launch() {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const releases = new Map();
    process.on('message', ({ release }) => releases.get(release)?.());
    globalThis.fixtureWorker = async (task, { signal }) => {
      process.send({ run: { id: task.id, title: task.title, resume: task.resume, startedAt: task.startedAt } });
      await new Promise(resolve => {
        releases.set(task.id, resolve);
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      releases.delete(task.id);
      return { ok: !signal.aborted, finalMessage: 'Fixture finished', items: [] };
    };
    registerHooks({ load(url, context, nextLoad) {
      if (url === new URL('./core/workers/index.mjs', import.meta.url).href) return {
        format: 'module', shortCircuit: true,
        source: 'export const runWorker = (...args) => globalThis.fixtureWorker(...args);',
      };
      return nextLoad(url, context);
    } });
    const rejectIO = () => { throw new Error('unexpected external I/O'); };
    globalThis.fetch = rejectIO;
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = rejectIO;
    childProcess.execFile = (command, args, options, callback) => {
      assert.match(command, /git(?:\\.exe)?$/i);
      callback(null, '', '');
    };
    syncBuiltinESMExports();
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    delete process.env.CONDUCTOR_RELAUNCH_WAIT;
    const { startServer } = await import('./server/index.mjs');
    const { listTasks } = await import('./core/tasks.mjs');
    const { url } = await startServer({ port: 0 });
    process.send({ url, startup: listTasks() });
  `], {
    cwd: root, env: { ...process.env, CONDUCTOR_HOME: HOME, CONDUCTOR_NO_POLL: '1' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const state = { child, runs: [], output: '', closed: false };
  child.stdout.on('data', data => { state.output += data; });
  child.stderr.on('data', data => { state.output += data; });
  child.on('message', message => {
    if (message.run) state.runs.push(message.run);
    else Object.assign(state, message);
  });
  child.on('error', error => { state.output += error.stack; });
  child.on('close', (code, signal) => { Object.assign(state, { closed: true, code, signal }); });
  return state;
}

async function api(server, path, body) {
  const response = await fetch(`${server.url}/api/${path}`, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(waitMs),
  });
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json();
}

test('two server processes preserve the queue, stagger resumes, and require rerun for stale work', async () => {
  mkdirSync(join(HOME, 'tasks'), { recursive: true });
  writeFileSync(join(HOME, 'config.json'), JSON.stringify({
    worker: { resumeStaggerSeconds: 1 },
    conductor: { maxWorkerConcurrency: 1, budgetGate: false, autoUpdate: 'off' },
  }));
  const fixture = (id, extra) => ({
    id, title: id, cwd: HOME, provider: 'ollama', model: 'fixture', spec: 'Read only fixture',
    createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(), attempts: 1, ...extra,
  });
  const resumeAt = Date.now() + 2 * 60 * 60 * 1000;
  write(fixture('A', { status: 'parked', resumeAt }));
  write(fixture('D', { status: 'running', source: 'smoke' }));
  const children = [];
  try {
    const first = launch(); children.push(first);
    await until(() => first.url, 'first server ready', first);
    const b = await api(first, 'tasks', { cwd: HOME, title: 'B', spec: 'Block until aborted', provider: 'ollama', model: 'fixture' });
    await until(() => first.runs.some(run => run.id === b.id), 'B worker started', first);
    const c = await api(first, 'tasks', { cwd: HOME, title: 'C', spec: 'Queued work', provider: 'ollama', model: 'fixture' });
    assert.equal(c.status, 'queued');
    await api(first, 'shutdown', {});
    await until(() => first.closed, 'first server shutdown');
    assert.equal(first.code, 0, first.output);
    assert.equal(journal(b.id).status, 'queued');
    assert.equal(journal(b.id).resume, true);
    assert.ok(Number.isFinite(Date.parse(journal(b.id).interruptedAt)));
    assert.equal(journal('A').status, 'parked');
    assert.equal(journal('A').resumeAt, resumeAt);
    assert.equal(journal(c.id).status, 'queued');
    assert.deepEqual(first.runs.map(run => run.title), ['B']);

    write(fixture('E', { status: 'running', recoveries: 1 }));
    // F predates B, so F is the immediate resume and B must be staggered behind it.
    write(fixture('F', { status: 'running' }));
    const second = launch(); children.push(second);
    await until(() => second.url, 'second server ready', second);
    const startup = id => second.startup.find(task => task.id === id);
    assert.equal(startup('A').status, 'parked');
    assert.equal(startup('A').resumeAt, resumeAt);
    assert.equal(startup('D').status, 'canceled');
    assert.match(startup('D').error, /restart/);
    assert.equal(startup('E').status, 'stale');
    assert.equal(startup('E').recoveries, 2);
    assert.equal(startup('F').status, 'running');
    assert.equal(startup('F').resume, true);
    assert.equal(startup(b.id).status, 'parked', 'gracefully requeued B participates in restart staggering');
    assert.equal(startup(b.id).error, 'restart stagger');
    assert.equal(startup(c.id).status, 'queued');

    // Keep the first worker occupied until B's real stagger timer expires, so C stays behind both resumes.
    await until(() => journal(b.id).status === 'queued', 'B restart stagger elapsed', second);
    for (const id of ['F', b.id]) {
      await until(() => second.runs.some(run => run.id === id), `${id} resumed`, second);
      assert.equal(second.runs.find(run => run.id === id).resume, true);
      second.child.send({ release: id });
      await until(() => journal(id).status === 'done', `${id} completed`, second);
    }
    await until(() => second.runs.some(run => run.id === c.id), 'C started after resumes', second);
    assert.equal((await api(second, 'tasks/E')).status, 'stale');
    const rerun = await api(second, 'tasks/E/rerun', {});
    assert.equal(rerun.task.status, 'queued', 'C holds the sole worker slot');
    second.child.send({ release: c.id });
    await until(() => second.runs.some(run => run.id === 'E'), 'E rerun started', second);
    second.child.send({ release: 'E' });
    await until(() => journal('E').status === 'done', 'E rerun completed', second);
    assert.deepEqual(second.runs.map(run => run.title), ['F', 'B', 'C', 'E']);
    assert.equal(journal('A').status, 'parked');
    assert.equal(journal('A').resumeAt, resumeAt);
    assert.equal(journal('A').attempts, 1);
    await api(second, 'shutdown', {});
    await until(() => second.closed, 'second server shutdown');
    assert.equal(second.code, 0, second.output);
  } finally {
    for (const state of children) {
      if (!state.closed) state.child.kill(); // only the specific child spawned by this test
      await until(() => state.closed, 'child cleanup');
    }
  }
});
