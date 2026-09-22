import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const OK = join(process.env.CONDUCTOR_HOME, 'relaunch-ok');

const { scheduleRelaunch, startServer } = await import('../../server/index.mjs');

const fakeChild = () => Object.assign(new EventEmitter(), { unref() {} });
const listen0 = async () => { const s = createServer((_, res) => res.end()); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s; };

test('scheduleRelaunch spawns a detached same-port conductor with THIS process env, and hands off only once the child is alive', async () => {
  const calls = []; let exited = 0;
  const child = fakeChild();
  const ok = scheduleRelaunch({ port: 47474, spawnFn: (cmd, args, opts) => (calls.push({ cmd, args, opts }), child), exit: () => { exited++; } });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, process.execPath);                                   // relaunch with the same node binary
  assert.match(args[0].replaceAll('\\', '/'), /bin\/conductor\.mjs$/);   // ... running the CLI entry
  assert.deepEqual(args.slice(1), ['start', '--no-open', '--port', '47474']); // same port, don't reopen the browser
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
  assert.equal(opts.env.CONDUCTOR_RELAUNCH_WAIT, '20000');               // child tolerates the port not being free yet
  assert.equal(opts.env.CONDUCTOR_HOME, process.env.CONDUCTOR_HOME);     // inherits the server's own env, not an ambient shell
  assert.equal(exited, 0);                                               // no exit until the child confirms it started
  child.emit('spawn');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(exited, 0);                                               // alive is not enough: it must signal that it could start
  writeFileSync(OK, '1');                                                // the child writes this as it enters its bind loop
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(exited, 1);                                               // signalled → handed off and exited
});

test('scheduleRelaunch stays up (never exits) when the relaunch child errors — fallback to manual restart', async () => {
  let exited = 0;
  const child = fakeChild();
  assert.equal(scheduleRelaunch({ port: 1, spawnFn: () => child, exit: () => { exited++; } }), true);
  child.emit('error', new Error('spawn ENOENT'));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(exited, 0);
});

test('scheduleRelaunch returns false and never exits when spawn throws', () => {
  let exited = 0;
  assert.equal(scheduleRelaunch({ port: 1, spawnFn: () => { throw new Error('no'); }, exit: () => { exited++; } }), false);
  assert.equal(exited, 0);
});

test('startServer retries the bind while CONDUCTOR_RELAUNCH_WAIT is set, then binds the SAME port once it frees', async () => {
  const blocker = await listen0();
  const port = blocker.address().port;
  process.env.CONDUCTOR_RELAUNCH_WAIT = '5000';
  const startP = startServer({ port });
  setTimeout(() => blocker.close(), 600);                                // free the port mid-retry
  const { server, port: bound } = await startP;
  assert.equal(bound, port);                                            // recaptured the same port after retrying
  assert.ok(existsSync(OK));                                            // the child signalled it can start before binding
  assert.equal(process.env.CONDUCTOR_RELAUNCH_WAIT, undefined);         // flag cleared on a successful bind (no lingering into normal operation)
  server.close();
});

test('startServer fails fast on a busy port when no relaunch flag is set (unchanged normal behavior)', async () => {
  const blocker = await listen0();
  delete process.env.CONDUCTOR_RELAUNCH_WAIT;
  await assert.rejects(startServer({ port: blocker.address().port }), (e) => e.code === 'EADDRINUSE');
  blocker.close();
});

test('relaunch refreshes the outgoing journal after binding without replaying completed tasks', () => {
  const result = spawnSync(process.execPath, ['--import', './test/_env.mjs', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    import childProcess from 'node:child_process';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const home = process.env.CONDUCTOR_HOME, dir = join(home, 'tasks');
    mkdirSync(dir);
    const fixture = id => ({ id, cwd: home, title: id, spec: 'read only', provider: 'ollama',
      model: 'fixture', status: 'running', attempts: 1, updatedAt: new Date().toISOString() });
    const write = task => writeFileSync(join(dir, task.id + '.json'), JSON.stringify(task));
    for (const id of ['completed', 'canceled', 'interrupted', 'shutdown', 'aged']) write(fixture(id));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ conductor: { budgetGate: false } }));
    const calls = [], release = Promise.withResolvers();
    globalThis.fixtureWorker = async task => {
      calls.push(task.id);
      assert.equal(task.resume, true);
      await release.promise;
      return { ok: true, finalMessage: 'Recovered', items: [] };
    };
    registerHooks({ load(url, context, nextLoad) {
      if (url === new URL('./core/workers/index.mjs', import.meta.url).href) return {
        format: 'module', shortCircuit: true,
        source: 'export const runWorker = (...args) => globalThis.fixtureWorker(...args);',
      };
      return nextLoad(url, context);
    } });
    const unexpectedIO = [];
    const rejectIO = () => { unexpectedIO.push('external I/O'); throw new Error('unexpected external I/O'); };
    globalThis.fetch = rejectIO;
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = rejectIO;
    // Stub task Git observations too: this regression needs no external processes.
    childProcess.execFile = (command, args, options, callback) => {
      assert.match(command, /git(?:\.exe)?$/i);
      callback(null, '', '');
    };
    syncBuiltinESMExports();
    process.env.CONDUCTOR_RELAUNCH_WAIT = '20000'; // production handover allowance
    const { getTask, recoverTasks, awaitTask, flushRecords } = await import('./core/tasks.mjs');
    const { startServer, stopBackgroundWork } = await import('./server/index.mjs');
    for (const id of ['completed', 'canceled', 'interrupted', 'shutdown', 'aged']) assert.equal(getTask(id).status, 'queued');
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    const starting = startServer({ port: 0 });
    assert.ok(existsSync(join(home, 'relaunch-ok')));
    // Same turn, before the asynchronous listen callback: the outgoing process persists its final records.
    write({ ...fixture('completed'), status: 'done', result: { finalMessage: 'Outgoing result' } });
    write({ ...fixture('canceled'), status: 'canceled' });
    write({ ...fixture('shutdown'), status: 'queued', resume: true });
    // Six hours is the configured default recovery age; make the final record older than it.
    write({ ...fixture('aged'), updatedAt: new Date(Date.now() - 7 * 3_600_000).toISOString() });
    assert.equal(getTask('completed').status, 'queued');
    const { server } = await starting;
    try {
      assert.equal(getTask('completed').status, 'done');
      assert.equal(getTask('completed').result.finalMessage, 'Outgoing result');
      assert.equal(getTask('canceled').status, 'canceled');
      assert.equal(getTask('aged').status, 'canceled');
      const active = getTask('interrupted');
      assert.equal(active.status, 'running');
      recoverTasks();
      assert.equal(getTask('interrupted'), active, 'recovery must not replace live worker objects');
      assert.equal(active.status, 'running');
      release.resolve();
      for (const id of ['interrupted', 'shutdown']) assert.equal((await awaitTask(id)).status, 'done');
      await flushRecords();
      assert.deepEqual(calls.sort(), ['interrupted', 'shutdown']); // completed dispatch count is ZERO
      assert.deepEqual(unexpectedIO, []);
    } finally {
      release.resolve();
      process.env.CONDUCTOR_NO_SCHEDULE = '1';
      stopBackgroundWork();
      await new Promise(resolve => server.close(resolve));
    }
  `], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('scheduleRelaunch keeps the old server when the child exits before it can bind, or never signals', async () => {
  let exited = 0, killed = 0;
  try { unlinkSync(OK); } catch {}
  const child = Object.assign(fakeChild(), { kill() { killed++; } });
  assert.equal(scheduleRelaunch({ port: 1, spawnFn: () => child, exit: () => { exited++; }, okTimeoutMs: 600 }), true);
  child.emit('spawn'); child.emit('exit', 1, null);                      // died on import (missing dependency, syntax error)
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(exited, 0); assert.equal(killed, 1);
  const { listImprovements } = await import('../../core/improve.mjs');
  assert.ok(listImprovements().some((i) => i.message.includes('failed to start (exited with code 1 before binding)')));
  let exited2 = 0; const quiet = Object.assign(fakeChild(), { kill() {} });
  assert.equal(scheduleRelaunch({ port: 1, spawnFn: () => quiet, exit: () => { exited2++; }, okTimeoutMs: 400 }), true);
  quiet.emit('spawn');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(exited2, 0);                                              // no signal within the budget → stay up
  assert.ok(listImprovements().some((i) => i.message.includes('no start signal within 0 s')));
});
