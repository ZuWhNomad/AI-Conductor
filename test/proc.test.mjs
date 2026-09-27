import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { spawnCli, spawnCodex, killTree, resolveNpmShim, parseWindowsProcesses, parsePsProcesses, registerProc, registeredPids, ownerProcessSample, spawnTracked } from '../core/proc.mjs';
import { capture, providerFor, VENDORS } from '../core/providers/vendors.mjs';

const WIN = process.platform === 'win32';
const collect = (child) => new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', (data) => out += data);
  child.on('error', reject);
  child.on('close', (code) => { assert.equal(code, 0); resolve(out); });
});

test('portable process snapshot parsers normalize PID, parent, CPU and RSS', () => {
  const win = parseWindowsProcesses(JSON.stringify({ ProcessId: '10', ParentProcessId: '2', KernelModeTime: '10000000', UserModeTime: '25000000', WorkingSetSize: '4096', Name: 'python.exe' }));
  assert.deepEqual(win.get(10), { pid: 10, ppid: 2, cpuSeconds: 3.5, rssBytes: 4096, name: 'python.exe' });
  const ps = parsePsProcesses(' 20 10 1-02:03:04 8 python\n 21 20 05:06 4 child\n');
  assert.deepEqual(ps.get(20), { pid: 20, ppid: 10, cpuSeconds: 93784, rssBytes: 8192, name: 'python' });
  assert.equal(ps.get(21).cpuSeconds, 306);
});

test('owner samples include registered roots and all descendants', () => {
  const child = Object.assign(new EventEmitter(), { pid: 41001 });
  registerProc('owner-tree', child);
  try {
    const processes = new Map([
      [41001, { pid: 41001, ppid: 1, cpuSeconds: 2, rssBytes: 10, name: 'node' }],
      [41002, { pid: 41002, ppid: 41001, cpuSeconds: 3, rssBytes: 20, name: 'python' }],
      [41003, { pid: 41003, ppid: 41002, cpuSeconds: 5, rssBytes: 30, name: 'worker' }],
    ]);
    assert.deepEqual(ownerProcessSample('owner-tree', { ok: true, processes }), { available: true, alive: true, cpuSeconds: 10, rssBytes: 60, names: ['node', 'python', 'worker'] });
  } finally { child.emit('close'); }
  assert.deepEqual(registeredPids('owner-tree'), []);
});

test('the Claude SDK spawn hook returns a real child and registers its PID under the supplied owner', async () => {
  const owner = 'sdk-spawn-fixture';
  const child = spawnTracked(owner, { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: process.cwd(), env: process.env, signal: undefined });
  assert.ok(child.pid > 0);
  assert.ok(registeredPids(owner).includes(child.pid));
  child.kill();
  await once(child, 'close');
  assert.deepEqual(registeredPids(owner), []);
});

test('spawnCli and vendor capture refuse unresolved Windows scripts without executing them', { skip: !WIN }, async () => {
  const cwd = tmpDir('proc-refuse');
  const marker = join(cwd, 'executed');
  for (const ext of ['cmd', 'bat']) {
    const bin = join(cwd, `tool.${ext}`);
    writeFileSync(bin, `@echo executed>"${marker}"\r\n`);
    assert.throws(() => spawnCli(bin, ['literal%PATH%&echo injected']), /cannot run .* without a shell/);
    const r = await capture(bin, ['--version']);
    assert.equal(r.code, 1);
    assert.equal(r.timedOut, false);
    assert.match(r.out, /cannot run .* without a shell/);
    assert.equal(existsSync(marker), false);
    const provider = providerFor({ ...VENDORS.grok, bin: () => bin });
    assert.equal((await provider.detect()).loggedIn, false, 'refusal cannot look like a successful auth probe');
  }
});

test('spawnCli and vendor capture preserve direct executables and resolvable npm shims', async () => {
  const cwd = tmpDir('proc-argv');
  const dir = join(cwd, 'node_modules', 'fixture');
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'cli.js');
  writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const bins = [{ bin: process.execPath, prefix: [entry] }];
  if (WIN) {
    const bin = join(cwd, 'fixture.cmd');
    writeFileSync(bin, '@echo off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\fixture\\cli.js" %*\r\n');
    bins.push({ bin, prefix: [] });
  }
  const values = ['literal%PATH%', 'a&echo injected', 'b|whoami', 'quote"and\\', 'with spaces'];
  for (const { bin, prefix } of bins) {
    const out = await collect(spawnCli(bin, [...prefix, ...values], { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.deepEqual(JSON.parse(out), values);
    const r = await capture(bin, [...prefix, ...values], { cwd });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(r.out), values);
  }
});

test('spawnCodex forwards its supplied environment to the executable', async () => {
  const previous = process.env.CONDUCTOR_CODEX;
  process.env.CONDUCTOR_CODEX = process.execPath;
  try {
    const child = spawnCodex(['-e', 'process.stdout.write(process.env.MCP_TEST_CREDENTIAL)'], {
      env: { ...process.env, MCP_TEST_CREDENTIAL: 'child-secret' },
    });
    child.stdin.end();
    assert.equal(await collect(child), 'child-secret');
  } finally {
    if (previous === undefined) delete process.env.CONDUCTOR_CODEX; else process.env.CONDUCTOR_CODEX = previous;
  }
});

test('vendor capture marks a timed-out probe and returns its captured output', async () => {
  // 500 ms: under full-suite load a Node child prints 'started' within ~50 ms; timeout fires shortly after.
  const r = await capture(process.execPath, ['-e', "process.stdout.write('started');setInterval(() => {}, 1000)"], { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.match(r.out, /started/);
});

test('POSIX CLI children are process-group leaders for tree termination', { skip: WIN }, () => {
  const child = spawnCli(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.doesNotThrow(() => process.kill(-child.pid, 0));
  } finally {
    try { process.kill(-child.pid); } catch {}
  }
});

test('killTree fires taskkill via async execFile, not execFileSync', { skip: !WIN }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore', windowsHide: true });
  const asyncCalls = [];
  const sync = t.mock.method(childProcess, 'execFileSync', () => { throw new Error('must not use execFileSync'); });
  const asyncKill = t.mock.method(childProcess, 'execFile', (cmd, args, opts, cb) => { asyncCalls.push([cmd, args]); if (typeof cb === 'function') cb(null); });
  syncBuiltinESMExports();
  try {
    killTree(child);
    assert.equal(asyncCalls.length, 1);
    assert.equal(asyncCalls[0][0], 'taskkill');
    assert.deepEqual(asyncCalls[0][1], ['/pid', String(child.pid), '/T', '/F']);
  } finally {
    sync.mock.restore(); asyncKill.mock.restore(); syncBuiltinESMExports();
    try { child.kill(); } catch {}
  }
});

test('resolveNpmShim accepts a quoted native .exe target', { skip: !WIN }, async () => {
  const cwd = tmpDir('shim-exe');
  const exe = join(cwd, 'tool.exe');
  copyFileSync(process.execPath, exe);
  const bin = join(cwd, 'tool.cmd');
  writeFileSync(bin, `@echo off\r\n"%~dp0\\tool.exe" %*\r\n`);
  const shim = resolveNpmShim(bin);
  assert.equal(shim.command, exe);
  assert.deepEqual(shim.args, []);
  const binAbs = join(cwd, 'tool-abs.cmd');
  writeFileSync(binAbs, `@echo off\r\n"${exe}" %*\r\n`);
  assert.equal(resolveNpmShim(binAbs).command, exe);
  const out = await collect(spawnCli(bin, ['-e', 'process.stdout.write("ok")'], { stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(out, 'ok');
});

test('killTree unblocks close when a grandchild still holds the pipes', async () => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    process.stdout.write(String(g.pid));
    g.unref();
  `], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let pidBuf = '';
  child.stdout.on('data', (d) => { pidBuf += d; });
  await new Promise((resolve) => child.on('exit', resolve));
  const gp = Number(pidBuf);
  try {
    const closed = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('close did not fire')), 2000);
      child.on('close', () => { clearTimeout(t); resolve(); });
    });
    killTree(child);
    await closed;
  } finally {
    if (Number.isFinite(gp) && gp > 0) try { process.kill(gp); } catch {}
  }
});
