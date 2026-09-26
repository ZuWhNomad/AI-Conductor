import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { startJob, jobStatus, cancelJob, formatJob } = await import('../core/jobs.mjs');
const { statePath, writeJson } = await import('../core/paths.mjs');
const node = JSON.stringify(process.execPath);
const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 50)); } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

test('a detached job records its exit code and output; the record lives on disk, not in memory', async () => {
  const j = startJob({ command: `${node} -e "console.log('hello from job'); process.exit(3)"`, cwd: tmpDir('job') });
  assert.equal(j.status, 'running');
  const done = await until(() => { const s = jobStatus(j.id); return s.status !== 'running' && s; });
  assert.equal(done.status, 'failed');
  assert.equal(done.exitCode, 3);
  assert.match(done.tail, /hello from job/);
  assert.equal(JSON.parse(readFileSync(statePath('jobs', `${j.id}.json`), 'utf8')).exitCode, 3, 'a restarted server reads the same record');
  assert.match(formatJob(done), /\[failed\] exit 3/);
});

test('cancel kills the job tree by PID; a job whose process vanished is reported lost', async () => {
  const j = startJob({ command: `${node} -e "setTimeout(() => {}, 60000)"`, cwd: tmpDir('job') });
  const running = await until(() => { const s = jobStatus(j.id); return s.pid && s.childPid && s; });
  assert.equal(cancelJob(j.id).status, 'canceled');
  assert.ok(await until(() => !alive(running.pid) && !alive(running.childPid)), 'wrapper and command are gone');
  assert.equal(jobStatus(j.id).status, 'canceled');

  writeJson(statePath('jobs', 'ghost1.json'), { id: 'ghost1', command: 'x', cwd: '.', status: 'running', startedAt: new Date().toISOString(), pid: 2 ** 22 + 7 });
  assert.equal(jobStatus('ghost1').status, 'lost');
});

test('bad input is refused; the output tail is redacted', async () => {
  assert.throws(() => startJob({ command: '', cwd: tmpDir('job') }), { status: 400 });
  assert.throws(() => startJob({ command: 'echo', cwd: 'Z:/definitely/missing' }), { status: 400 });
  assert.equal(jobStatus('../etc'), null);
  const j = startJob({ command: `${node} -e "console.log('key sk-svcac****************fvMA')"`, cwd: tmpDir('job') });
  const done = await until(() => { const s = jobStatus(j.id); return s.status !== 'running' && s; });
  assert.equal(done.exitCode, 0);
  assert.match(done.tail, /key \[redacted\]/);
});

test('a job outlives the process that started it', async () => {
  const { execFileSync } = await import('node:child_process');
  const jobsUrl = new URL('../core/jobs.mjs', import.meta.url).href;
  const starter = `const { startJob } = await import(${JSON.stringify(jobsUrl)}); const j = startJob({ command: process.argv[1], cwd: process.cwd() }); console.log(j.id); process.exit(0);`;
  const id = execFileSync(process.execPath, ['--input-type=module', '-e', starter, `${node} -e "setTimeout(() => console.log('still here'), 1500)"`], { cwd: tmpDir('job'), env: process.env, encoding: 'utf8' }).trim();
  const done = await until(() => { const s = jobStatus(id); return s && s.status !== 'running' && s; });
  assert.equal(done.status, 'done');
  assert.match(done.tail, /still here/);
});
