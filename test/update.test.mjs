import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findCli } from '../core/proc.mjs';
const { updateStatus, applyUpdate, formatUpdate } = await import('../core/update.mjs');

const git = findCli('git');
const run = (cwd, ...args) => execFileSync(git, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const setup = () => {
  const origin = tmpDir('origin'); run(origin, 'init', '--quiet', '--bare', '-b', 'main');
  const a = tmpDir('clone-a'); run(a, 'clone', '--quiet', origin, '.');
  for (const d of [a]) { run(d, 'config', 'user.email', 't@example.com'); run(d, 'config', 'user.name', 't'); }
  writeFileSync(join(a, 'f.txt'), '1'); run(a, 'add', '.'); run(a, 'commit', '--quiet', '-m', 'one'); run(a, 'push', '--quiet', '-u', 'origin', 'main');
  const b = tmpDir('clone-b'); run(b, 'clone', '--quiet', origin, '.'); run(b, 'config', 'user.email', 't@example.com'); run(b, 'config', 'user.name', 't');
  return { origin, a, b };
};

test('update: status counts commits behind the remote and applyUpdate fast-forwards', { skip: !git && 'git not installed' }, () => {
  const { a, b } = setup();
  assert.equal(updateStatus({ cwd: b }).behind, 0);
  writeFileSync(join(a, 'f.txt'), '2'); run(a, 'commit', '--quiet', '-am', 'two'); run(a, 'push', '--quiet');
  const st = updateStatus({ cwd: b });
  assert.equal(st.behind, 1); assert.equal(st.dirty, 0); assert.match(formatUpdate(st), /1 update\(s\) available/);
  const r = applyUpdate({ cwd: b, npm: false });
  assert.equal(r.updated, true); assert.equal(r.commits, 1); assert.equal(r.restartNeeded, true);
  assert.equal(run(b, 'rev-parse', 'HEAD'), run(a, 'rev-parse', 'HEAD'));
  assert.equal(applyUpdate({ cwd: b, npm: false }).updated, false);
});

test('update: refuses over uncommitted changes or unpushed commits, and explains a non-git folder', { skip: !git && 'git not installed' }, () => {
  const { a, b } = setup();
  writeFileSync(join(a, 'f.txt'), '3'); run(a, 'commit', '--quiet', '-am', 'three'); run(a, 'push', '--quiet');
  writeFileSync(join(b, 'local.txt'), 'x');
  assert.throws(() => applyUpdate({ cwd: b, npm: false }), /not committed/);
  run(b, 'add', '.'); run(b, 'commit', '--quiet', '-m', 'mine');
  assert.throws(() => applyUpdate({ cwd: b, npm: false }), /push them first/);
  const plain = tmpDir('plain');
  assert.equal(updateStatus({ cwd: plain }).git, false);
  assert.match(formatUpdate(updateStatus({ cwd: plain })), /clone the repo/);
});
