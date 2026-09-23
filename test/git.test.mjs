import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, utimesSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const { findCli } = await import('../core/proc.mjs');
const { _git } = await import('../core/tasks.mjs');
const { isPhantomCompletion } = await import('../core/scorecard.mjs');
const git = findCli('git');

test('git observes a dirty tracked file restored to HEAD without classifying it as phantom', { skip: !git }, async () => {
  const cwd = tmpDir('git-restored');
  const run = (...args) => execFileSync(git, args, { cwd, windowsHide: true, encoding: 'utf8' });
  run('init', '--quiet');
  const name = 'restored.txt';
  const file = join(cwd, name);
  writeFileSync(file, 'base');
  run('add', '--', name);
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture');
  writeFileSync(file, 'dirty');
  const before = await _git.gitStatus(cwd);
  assert.ok(before.has(name));
  assert.deepEqual(await _git.changedSince(cwd, before), [], 'unchanged dirty content is not a worker edit');
  run('restore', '--source=HEAD', '--', name);
  const after = await _git.gitStatus(cwd);
  assert.equal(after.size, 0, 'restoring to HEAD removes the path from porcelain');
  const observed = _git.diffStatus(before, after);
  assert.deepEqual(observed, [name]);
  assert.equal(isPhantomCompletion({ ok: true, claimed: [name], canVerify: before !== null, observedCount: observed.length }), false);
});

test('git status comparison preserves unavailable snapshot handling', () => {
  const dirty = new Map([['dirty.txt', ' M']]);
  assert.deepEqual(_git.diffStatus(dirty, null), []);
  assert.deepEqual(_git.diffStatus(null, dirty), ['dirty.txt']);
  assert.deepEqual(_git.diffStatus(null, null), []);
});

test('git observes content edits to already-dirty tracked files with unchanged status, size and mtime', { skip: !git }, async () => {
  const cwd = tmpDir('git-dirty');
  const run = (...args) => execFileSync(git, args, { cwd, windowsHide: true, encoding: 'utf8' });
  run('init', '--quiet');
  const name = 'space café.txt';
  const file = join(cwd, name);
  writeFileSync(file, 'base');
  run('add', '--', name);
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture');
  writeFileSync(file, 'edit');
  const before = await _git.gitStatus(cwd);
  const porcelain = run('status', '--porcelain', '-z');
  assert.equal(porcelain, ` M ${name}\0`);
  assert.deepEqual(await _git.changedSince(cwd, before), [], 'unchanged dirty content is not a worker edit');
  const times = statSync(file);
  writeFileSync(file, 'real');
  utimesSync(file, times.atime, times.mtime);
  assert.equal(run('status', '--porcelain', '-z'), porcelain);
  assert.deepEqual(await _git.changedSince(cwd, before), [name]);
});

test('git status from a subdirectory reports cwd-relative dirty tracked and existing untracked edits', { skip: !git }, async () => {
  const repo = tmpDir('git-pkg');
  const run = (...args) => execFileSync(git, args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
  run('init', '--quiet');
  const pkg = join(repo, 'pkg');
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'a.txt'), 'base');
  run('add', '--', 'pkg/a.txt');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture');
  writeFileSync(join(pkg, 'a.txt'), 'dirty');
  writeFileSync(join(pkg, 'u.txt'), 'untracked');
  const before = await _git.gitStatus(pkg);
  assert.ok(before.has('a.txt'), [...before.keys()]);
  assert.ok(before.has('u.txt'), [...before.keys()]);
  writeFileSync(join(pkg, 'a.txt'), 'edited-again');
  writeFileSync(join(pkg, 'u.txt'), 'rewritten');
  const changed = await _git.changedSince(pkg, before);
  assert.deepEqual([...changed].sort(), ['a.txt', 'u.txt']);
});

test('git status walks parent directories so a subdirectory cwd is still a repo', { skip: !git }, async () => {
  const cwd = tmpDir('git-sub');
  const run = (...args) => execFileSync(git, args, { cwd, windowsHide: true, encoding: 'utf8' });
  run('init', '--quiet');
  writeFileSync(join(cwd, 'root.txt'), 'root');
  run('add', '--', 'root.txt');
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture');
  const sub = join(cwd, 'nested', 'deep');
  mkdirSync(sub, { recursive: true });
  const before = await _git.gitStatus(sub);
  assert.ok(before, 'a cwd inside a repo must get a git snapshot');
  writeFileSync(join(sub, 'new.txt'), 'new');
  const changed = await _git.changedSince(sub, before);
  assert.equal(changed.length, 1);
  assert.ok(changed[0].endsWith('new.txt'), changed);
});

test('git fingerprints tracked files at or above 8 MiB by mtime and size, not content', { skip: !git }, async () => {
  const cwd = tmpDir('git-large');
  const run = (...args) => execFileSync(git, args, { cwd, windowsHide: true, encoding: 'utf8' });
  run('init', '--quiet');
  const name = 'big.bin';
  const file = join(cwd, name);
  const size = 8 * 1024 * 1024;
  writeFileSync(file, Buffer.alloc(size, 1));
  run('add', '--', name);
  run('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'fixture');
  writeFileSync(file, Buffer.alloc(size, 2));
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
  utimesSync(file, pinned, pinned);
  const before = await _git.gitStatus(cwd);
  assert.ok(before.has(name));
  writeFileSync(file, Buffer.alloc(size, 3));
  utimesSync(file, pinned, pinned);
  assert.deepEqual(await _git.changedSince(cwd, before), [], 'same size and mtime is not a change for a large file');
  const later = new Date(pinned.getTime() + 2000);
  utimesSync(file, later, later);
  assert.deepEqual(await _git.changedSince(cwd, before), [name]);
});

test('git detects new and modified untracked files and includes them in the summary', { skip: !git }, async () => {
  const cwd = tmpDir('git');
  execFileSync(git, ['init', '--quiet'], { cwd, windowsHide: true });
  const before = await _git.gitStatus(cwd);
  const file = join(cwd, 'new.txt');
  writeFileSync(file, 'new');
  assert.deepEqual(await _git.changedSince(cwd, before), ['new.txt']);
  const created = await _git.gitStatus(cwd);
  writeFileSync(file, 'different content');
  const later = new Date(Date.now() + 2000); utimesSync(file, later, later);
  assert.deepEqual(await _git.changedSince(cwd, created), ['new.txt']);
  assert.match(await _git.gitDiffStat(cwd), /untracked: new\.txt/);
  mkdirSync(join(cwd, 'nested'));
  writeFileSync(join(cwd, 'nested', 'space name.txt'), 'first');
  const nested = await _git.gitStatus(cwd);
  writeFileSync(join(cwd, 'nested', 'space name.txt'), 'second and longer');
  assert.deepEqual(await _git.changedSince(cwd, nested), ['nested/space name.txt']);
});
