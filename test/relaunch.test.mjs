import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';

const { scheduleRelaunch, startServer } = await import('../server/index.mjs');

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
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(exited, 1);                                               // child alive → handed off and exited
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
  assert.equal(process.env.CONDUCTOR_RELAUNCH_WAIT, undefined);         // flag cleared on a successful bind (no lingering into normal operation)
  server.close();
});

test('startServer fails fast on a busy port when no relaunch flag is set (unchanged normal behavior)', async () => {
  const blocker = await listen0();
  delete process.env.CONDUCTOR_RELAUNCH_WAIT;
  await assert.rejects(startServer({ port: blocker.address().port }), (e) => e.code === 'EADDRINUSE');
  blocker.close();
});
