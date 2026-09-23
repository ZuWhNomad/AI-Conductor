import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { spawnCli, spawnCodex, killTree } from '../core/proc.mjs';
import { capture, providerFor, VENDORS } from '../core/providers/vendors.mjs';

const WIN = process.platform === 'win32';
const collect = (child) => new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', (data) => out += data);
  child.on('error', reject);
  child.on('close', (code) => { assert.equal(code, 0); resolve(out); });
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
  const r = await capture(process.execPath, ['-e', "process.stdout.write('started');setInterval(() => {}, 1000)"], { timeoutMs: 100 });
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
