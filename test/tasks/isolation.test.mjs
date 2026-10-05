import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { git, findCli, tasksWithGit, tasksWithWorker, initRepo } from './_helpers.mjs';

test('non-repository task creation, dispatch and completion never invoke git', async (ctx) => {
  const calls = [];
  const tk = await tasksWithGit(ctx, async (...args) => { calls.push(args); return { stdout: '' }; });
  ctx.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'done' } }] })));
  const lim = await import('../../core/limits.mjs'); delete lim.getLimits().providers.deepseek;
  let task;
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    task = tk.createTask({ cwd: tmpDir('no-git'), provider: 'deepseek', spec: 'x' });
    const done = await tk.awaitTask(task.id);
    assert.equal(done.status, 'done');
    assert.deepEqual(calls, []);
    assert.deepEqual(done.changedFiles, []);
    assert.equal(done.diffStat, '');
    assert.equal(done.repoFiles, null);
    assert.equal(done.repoBytes, null);
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    tk.abortRunning();
    if (task?.status === 'running') await tk.awaitTask(task.id);
    if (task) tk.cancelTask(task.id);
    await tk.flushRecords();
  }
});

test('changedFiles lists a file once when git and a Windows worker report it with different separators', async (ctx) => {
  const gitBin = findCli('git');
  if (!gitBin) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('changed-slashes');
  childProcess.execFileSync(gitBin, ['init', '--quiet'], { cwd, windowsHide: true });
  const tk = await tasksWithWorker(ctx, async () => {
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    writeFileSync(join(cwd, 'sub', 'a.txt'), 'x');
    return { ok: true, finalMessage: 'wrote sub/a.txt', items: [{ type: 'file_change', changes: [{ path: join(cwd, 'sub', 'a.txt') }] }] };
  });
  const t = tk.createTask({ cwd, provider: 'codex', spec: 'x' });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  assert.equal(done.status, 'done', done.error);
  assert.deepEqual(done.changedFiles, ['sub/a.txt']);
});

test('isolate: two parallel editors of the same file succeed on their own branches; main checkout is untouched', async (ctx) => {
  if (!git) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('iso-parallel');
  const run = initRepo(cwd);
  writeFileSync(join(cwd, 'dirty.txt'), 'uncommitted in main');
  const tk = await tasksWithWorker(ctx, async (t) => {
    writeFileSync(join(t.cwd, 'same.txt'), `${t.title}\n`);
    return { ok: true, finalMessage: `wrote ${t.title}`, threadId: `th-${t.id}` };
  });
  const a = tk.createTask({ cwd, title: 'edit-a', spec: 'x', provider: 'codex', isolate: true, parallelOverride: true });
  const b = tk.createTask({ cwd, title: 'edit-b', spec: 'x', provider: 'codex', isolate: true, parallelOverride: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const [da, db] = await Promise.all([tk.awaitTask(a.id), tk.awaitTask(b.id)]);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(da.status, 'done', da.error);
  assert.equal(db.status, 'done', db.error);
  assert.equal(readFileSync(join(cwd, 'same.txt'), 'utf8'), 'base\n');
  assert.ok(existsSync(join(cwd, 'dirty.txt')), 'main uncommitted file remains');
  assert.ok(da.isolation?.dir && db.isolation?.dir);
  assert.notEqual(da.isolation.dir, db.isolation.dir);
  assert.equal(da.isolation.branch, `conductor/${da.id}`);
  assert.equal(db.isolation.branch, `conductor/${db.id}`);
  assert.deepEqual(da.changedFiles, ['same.txt']);
  assert.deepEqual(db.changedFiles, ['same.txt']);
  assert.match(da.diffStat, /same\.txt/);
  assert.match(db.diffStat, /same\.txt/);
  assert.match(tk.describeTask(tk.getTask(da.id)), /uncommitted changes in the main checkout are not in the worktree/);
  assert.equal(run('show', `${da.isolation.branch}:same.txt`).trim(), 'edit-a');
  assert.equal(run('show', `${db.isolation.branch}:same.txt`).trim(), 'edit-b');
});

test('isolate: follow-up reuses the dir and adds a second commit; retry_of gets a new dir', async (ctx) => {
  if (!git) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('iso-follow');
  const run = initRepo(cwd);
  const tk = await tasksWithWorker(ctx, async (t) => {
    writeFileSync(join(t.cwd, 'same.txt'), `${t.spec}\n`);
    return { ok: true, finalMessage: 'ok', threadId: 'th-iso' };
  });
  const first = tk.createTask({ cwd, title: 'round1', spec: 'first', provider: 'codex', isolate: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const d1 = await tk.awaitTask(first.id);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(d1.status, 'done', d1.error);
  const follow = tk.createTask({ spec: 'second', followUpOf: first.id });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const d2 = await tk.awaitTask(follow.id);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(d2.status, 'done', d2.error);
  assert.equal(d2.isolation.dir, d1.isolation.dir);
  assert.equal(d2.isolation.branch, d1.isolation.branch);
  assert.equal(run('rev-list', '--count', `${d1.isolation.base}..${d1.isolation.branch}`).trim(), '2');
  assert.equal(run('show', `${d1.isolation.branch}:same.txt`).trim(), 'second');
  const retry = tk.createTask({ cwd, title: 'retry', spec: 'retry', provider: 'codex', retryOf: first.id });
  assert.equal(retry.isolate, true);
  assert.equal(retry.isolation, undefined);
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const d3 = await tk.awaitTask(retry.id);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(d3.status, 'done', d3.error);
  assert.ok(d3.isolation.dir);
  assert.notEqual(d3.isolation.dir, d1.isolation.dir);
  assert.equal(d3.isolation.branch, `conductor/${d3.id}`);
});

test('isolate ignored: non-git cwd and read-only run in place', async (ctx) => {
  if (!git) { ctx.skip('git is not installed'); return; }
  const seen = [];
  const tk = await tasksWithWorker(ctx, async (t) => { seen.push(t.cwd); writeFileSync(join(t.cwd, 'out.txt'), 'x'); return { ok: true, finalMessage: 'ok' }; });
  const plain = tmpDir('iso-nongit');
  const a = tk.createTask({ cwd: plain, title: 'nongit', spec: 'x', provider: 'codex', isolate: true, parallelOverride: true });
  assert.match(a.warning || '', /isolate ignored: cwd is not inside a git repo/);
  assert.equal(a.isolate, undefined);
  const repo = tmpDir('iso-ro');
  initRepo(repo);
  const b = tk.createTask({ cwd: repo, title: 'ro', spec: 'x', provider: 'codex', isolate: true, sandbox: 'read-only', parallelOverride: true });
  assert.match(b.warning || '', /isolate ignored: sandbox is read-only/);
  assert.equal(b.isolate, undefined);
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const [da, db] = await Promise.all([tk.awaitTask(a.id), tk.awaitTask(b.id)]);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(da.status, 'done', da.error);
  assert.equal(db.status, 'done', db.error);
  assert.equal(da.cwd, plain);
  assert.equal(db.cwd, repo);
  assert.ok(seen.includes(plain) && seen.includes(repo));
  assert.ok(existsSync(join(plain, 'out.txt')));
  assert.ok(existsSync(join(repo, 'out.txt')));
});

test('worktree_cleanup removes the dir and optionally the branch', async (ctx) => {
  if (!git) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('iso-clean');
  const run = initRepo(cwd);
  mkdirSync(join(cwd, 'node_modules'));
  mkdirSync(join(cwd, '.venv'));
  writeFileSync(join(cwd, 'node_modules', 'dependency.txt'), 'node dependency');
  writeFileSync(join(cwd, '.venv', 'dependency.txt'), 'python dependency');
  const linked = [];
  const tk = await tasksWithWorker(ctx, async (t) => {
    linked.push(lstatSync(join(t.cwd, 'node_modules')).isSymbolicLink(), lstatSync(join(t.cwd, '.venv')).isSymbolicLink());
    writeFileSync(join(t.cwd, 'same.txt'), 'edited\n');
    return { ok: true, finalMessage: 'ok' };
  });
  const t = tk.createTask({ cwd, title: 'clean-me', spec: 'x', provider: 'codex', isolate: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(done.status, 'done', done.error);
  const dir = done.isolation.dir;
  const branch = done.isolation.branch;
  assert.ok(existsSync(dir));
  assert.deepEqual(linked, [true, true], 'the isolated worker shares the checkout dependencies through directory links');
  assert.match(run('branch', '--list', branch), new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const msg = await tk.cleanupWorktree(t.id, { deleteBranch: true });
  assert.match(msg, /removed worktree/);
  assert.match(msg, /deleted branch/);
  assert.equal(existsSync(dir), false);
  assert.equal(readFileSync(join(cwd, 'node_modules', 'dependency.txt'), 'utf8'), 'node dependency', 'cleanup unlinks instead of traversing node_modules');
  assert.equal(readFileSync(join(cwd, '.venv', 'dependency.txt'), 'utf8'), 'python dependency', 'cleanup unlinks instead of traversing .venv');
  assert.equal(run('branch', '--list', branch).trim(), '');
});

test('conductor worktrees lists entries and prune-days removes ended worktrees not branches', async (ctx) => {
  if (!git) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('iso-list');
  const run = initRepo(cwd);
  const tk = await tasksWithWorker(ctx, async (t) => {
    writeFileSync(join(t.cwd, 'same.txt'), 'listed\n');
    return { ok: true, finalMessage: 'ok' };
  });
  const t = tk.createTask({ cwd, title: 'list-me', spec: 'x', provider: 'codex', isolate: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(done.status, 'done', done.error);
  const listed = await tk.listWorktrees();
  const row = listed.find((e) => e.taskId === t.id);
  assert.ok(row, JSON.stringify(listed));
  assert.equal(row.branch, done.isolation.branch);
  assert.equal(row.status, 'done');
  assert.ok(row.age);
  const rec = tk.getTask(t.id);
  rec.finishedAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
  rec.updatedAt = rec.finishedAt;
  const pruned = await tk.listWorktrees({ pruneDays: 7 });
  assert.equal(pruned.find((e) => e.taskId === t.id)?.pruned, true);
  assert.equal(existsSync(done.isolation.dir), false);
  assert.match(run('branch', '--list', done.isolation.branch), new RegExp(done.isolation.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('isolate: worker can read ignored node_modules via a link; commit omits it; cleanup keeps the source', async (ctx) => {
  if (!git) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('iso-nm');
  const run = initRepo(cwd);
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n');
  run('add', '--', '.gitignore');
  run('commit', '--quiet', '-m', 'ignore');
  mkdirSync(join(cwd, 'node_modules'));
  writeFileSync(join(cwd, 'node_modules', 'marker.txt'), 'KEEP\n');
  const tk = await tasksWithWorker(ctx, async (t) => {
    const body = readFileSync(join(t.cwd, 'node_modules', 'marker.txt'), 'utf8');
    writeFileSync(join(t.cwd, 'same.txt'), body);
    return { ok: true, finalMessage: body.trim() };
  });
  const t = tk.createTask({ cwd, title: 'use-nm', spec: 'x', provider: 'codex', isolate: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(done.status, 'done', done.error);
  assert.equal(done.result.finalMessage, 'KEEP');
  assert.equal(run('show', `${done.isolation.branch}:same.txt`).trim(), 'KEEP');
  assert.doesNotMatch(run('ls-tree', '-r', '--name-only', done.isolation.branch), /node_modules/);
  assert.ok(!done.changedFiles.some((f) => f.includes('node_modules')));
  await tk.cleanupWorktree(t.id);
  assert.equal(existsSync(done.isolation.dir), false);
  assert.equal(readFileSync(join(cwd, 'node_modules', 'marker.txt'), 'utf8'), 'KEEP\n');
});

test('isolate: cleanup aborts before worktree removal when a dependency link cannot be unlinked', async (ctx) => {
  if (!git) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('iso-unlink-fail');
  const run = initRepo(cwd);
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n');
  run('add', '--', '.gitignore');
  run('commit', '--quiet', '-m', 'ignore');
  mkdirSync(join(cwd, 'node_modules'));
  const marker = join(cwd, 'node_modules', 'marker.txt');
  writeFileSync(marker, 'KEEP\n');
  const tk = await tasksWithWorker(ctx, async (t) => {
    writeFileSync(join(t.cwd, 'same.txt'), readFileSync(join(t.cwd, 'node_modules', 'marker.txt'), 'utf8'));
    return { ok: true, finalMessage: 'ok' };
  });
  const t = tk.createTask({ cwd, title: 'unlink-failure', spec: 'x', provider: 'codex', isolate: true });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  tk.schedule();
  const done = await tk.awaitTask(t.id);
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  assert.equal(done.status, 'done', done.error);
  const link = join(done.isolation.dir, 'node_modules');
  assert.equal(lstatSync(link).isSymbolicLink(), true);

  const rmdir = ctx.mock.method(fs, 'rmdirSync', () => { throw Object.assign(new Error('forced rmdir failure'), { code: 'EPERM' }); });
  const unlink = ctx.mock.method(fs, 'unlinkSync', () => { throw Object.assign(new Error('forced unlink failure'), { code: 'EPERM' }); });
  syncBuiltinESMExports();
  try {
    const message = await tk.cleanupWorktree(t.id);
    assert.match(message, new RegExp(`worktree_cleanup failed:.*${t.id}.*node_modules`, 'i'));
    assert.equal(existsSync(done.isolation.dir), true, 'cleanup must not remove the worktree after unlink failure');
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the failed link remains available for a later retry');
    assert.equal(readFileSync(marker, 'utf8'), 'KEEP\n', 'the source dependency tree is untouched');
  } finally {
    rmdir.mock.restore(); unlink.mock.restore(); syncBuiltinESMExports();
    await tk.cleanupWorktree(t.id);
  }
  assert.equal(existsSync(done.isolation.dir), false);
  assert.equal(readFileSync(marker, 'utf8'), 'KEEP\n');
});

test('isolate: an unignored isolateLinks dir is kept out of the commit via info/exclude', async (ctx) => {
  if (!git) { ctx.skip('git is not installed'); return; }
  const cwd = tmpDir('iso-excl');
  const run = initRepo(cwd);
  mkdirSync(join(cwd, 'vendor'));
  writeFileSync(join(cwd, 'vendor', 'x.js'), 'FROM-VENDOR\n');
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const previous = loadConfig().worker;
  saveConfig({ worker: { isolateLinks: ['vendor'] } });
  try {
    const tk = await tasksWithWorker(ctx, async (t) => {
      const body = readFileSync(join(t.cwd, 'vendor', 'x.js'), 'utf8');
      writeFileSync(join(t.cwd, 'same.txt'), body);
      return { ok: true, finalMessage: body.trim() };
    });
    const t = tk.createTask({ cwd, title: 'use-vendor', spec: 'x', provider: 'codex', isolate: true });
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    tk.schedule();
    const done = await tk.awaitTask(t.id);
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    assert.equal(done.status, 'done', done.error);
    assert.equal(done.result.finalMessage, 'FROM-VENDOR');
    assert.doesNotMatch(run('ls-tree', '-r', '--name-only', done.isolation.branch), /vendor/);
    await tk.cleanupWorktree(t.id);
    assert.equal(readFileSync(join(cwd, 'vendor', 'x.js'), 'utf8'), 'FROM-VENDOR\n');
  } finally { saveConfig({ worker: previous }); }
});
