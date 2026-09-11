import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const { findCli } = await import('../core/proc.mjs');
const { _git } = await import('../core/tasks.mjs');
const git = findCli('git');

test('git detects new and modified untracked files and includes them in the summary', { skip: !git }, () => {
  const cwd = tmpDir('git');
  execFileSync(git, ['init', '--quiet'], { cwd, windowsHide: true });
  const before = _git.gitStatus(cwd);
  const file = join(cwd, 'new.txt');
  writeFileSync(file, 'new');
  assert.deepEqual(_git.changedSince(cwd, before), ['new.txt']);
  const created = _git.gitStatus(cwd);
  writeFileSync(file, 'different content');
  const later = new Date(Date.now() + 2000); utimesSync(file, later, later);
  assert.deepEqual(_git.changedSince(cwd, created), ['new.txt']);
  assert.match(_git.gitDiffStat(cwd), /untracked: new\.txt/);
  mkdirSync(join(cwd, 'nested'));
  writeFileSync(join(cwd, 'nested', 'space name.txt'), 'first');
  const nested = _git.gitStatus(cwd);
  writeFileSync(join(cwd, 'nested', 'space name.txt'), 'second and longer');
  assert.deepEqual(_git.changedSince(cwd, nested), ['nested/space name.txt']);
});
