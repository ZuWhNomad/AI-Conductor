import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const dir = join(HOME, 'tasks'); const cwd = tmpDir('journal');
mkdirSync(dir, { recursive: true });
const now = new Date().toISOString(), dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
for (const t of [
  { id: 'p1', status: 'parked', resumeAt: Date.now() - 1000, resume: true, attempts: 1, updatedAt: now },
  { id: 'r1', status: 'running', updatedAt: now },
  { id: 'old', status: 'running', updatedAt: dayAgo },
  { id: 'nodate', status: 'parked' },
  { id: 'bad', status: 'done', spec: 42 },
]) writeFileSync(join(dir, `${t.id}.json`), JSON.stringify({ cwd, ...t }));
const { saveConfig } = await import('../core/config.mjs');
saveConfig({ worker: { resumeStaggerSeconds: 0 } });
const { getTask, listTasks, recoverTasks } = await import('../core/tasks.mjs');

test('journal import is read-only; server recovery queues interrupted and expired parked tasks', () => {
  assert.equal(getTask('p1').status, 'parked');
  assert.equal(getTask('r1').status, 'running');
  assert.equal(JSON.parse(readFileSync(join(dir, 'p1.json'), 'utf8')).status, 'parked');
  assert.equal(JSON.parse(readFileSync(join(dir, 'r1.json'), 'utf8')).status, 'running');
  const recovery = recoverTasks();
  for (const id of ['p1', 'r1', 'old', 'nodate']) assert.equal(getTask(id).status, 'queued');
  for (const id of ['p1', 'r1', 'old']) assert.equal(getTask(id).resume, true);
  assert.equal(getTask('nodate').resume, false, 'a never-started parked task stays fresh');
  assert.equal(recovery.resumed, 4);
  assert.equal(JSON.parse(readFileSync(join(dir, 'r1.json'), 'utf8')).status, 'queued');
  assert.doesNotThrow(() => listTasks());
  assert.equal(listTasks().find((t) => t.id === 'bad').specPreview, '42');
});

test('journal reload resumes old interrupted work instead of canceling it by age', async () => {
  for (const id of ['old', 'nodate']) {
    assert.equal(getTask(id).status, 'queued');
  }
  assert.equal(getTask('old').resume, true);
  assert.equal(getTask('nodate').resume, false, 'a never-started parked task stays fresh even when it has no timestamp');
  const { readFileSync } = await import('node:fs');
  assert.equal(JSON.parse(readFileSync(join(dir, 'old.json'), 'utf8')).status, 'queued', 'server recovery persists the transition');
  const { listImprovements } = await import('../core/improve.mjs');
  assert.ok(!listImprovements().some((i) => i.message.includes('interrupted task(s) older than')));
});

test('queued resume tasks survive regardless of age; never-started queued tasks remain fresh', async () => {
  const dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const now = new Date().toISOString();
  writeFileSync(join(dir, 'qold.json'), JSON.stringify({ id: 'qold', cwd, status: 'queued', resume: true, updatedAt: dayAgo }));
  writeFileSync(join(dir, 'qnew.json'), JSON.stringify({ id: 'qnew', cwd, status: 'queued', resume: true, updatedAt: now }));
  writeFileSync(join(dir, 'qfresh.json'), JSON.stringify({ id: 'qfresh', cwd, status: 'queued', updatedAt: dayAgo }));
  const { getTask } = await import(`../core/tasks.mjs?og3=${Date.now()}`);
  assert.equal(getTask('qold').status, 'queued');
  assert.equal(getTask('qold').resume, true);
  assert.equal(getTask('qnew').status, 'queued');
  assert.equal(getTask('qnew').resume, true);
  assert.equal(getTask('qfresh').status, 'queued');
  assert.notEqual(getTask('qfresh').resume, true); // never-started queued tasks are left as they were (no resume flag)
});

test('L7: parked staleness starts at the later of the last update and the reset', async () => {
  const resumeAt = Date.now() + 7 * 24 * 3_600_000; // weekly provider reset, despite a day-old park
  for (const t of [
    { id: 'future-park', updatedAt: dayAgo, resumeAt },
    { id: 'recent-reset', updatedAt: dayAgo, resumeAt: Date.now() - 1000 },
    { id: 'recent-park', updatedAt: now, resumeAt: Date.parse(dayAgo) },
  ]) writeFileSync(join(dir, `${t.id}.json`), JSON.stringify({ cwd, status: 'parked', attempts: 1, ...t }));
  const tk = await import('../core/tasks.mjs?l7-recovery');
  tk.recoverTasks();
  assert.equal(tk.getTask('future-park').status, 'parked');
  for (const id of ['recent-reset', 'recent-park']) {
    assert.equal(tk.getTask(id).status, 'queued');
    assert.equal(tk.getTask(id).resume, true);
  }
  assert.equal(tk.getTask('future-park').resumeAt, resumeAt);
});

test('L36: recovery keeps a future never-started park without an interruption prompt', async () => {
  writeFileSync(join(dir, 'never-started.json'), JSON.stringify({ id: 'never-started', cwd, status: 'parked', attempts: 0, updatedAt: now, resumeAt: Date.now() + 60_000, spec: 'start fresh' }));
  const tk = await import('../core/tasks.mjs?l36-recovery');
  tk.recoverTasks();
  const t = tk.getTask('never-started');
  assert.equal(t.status, 'parked');
  assert.notEqual(t.resume, true);
  assert.doesNotMatch(tk.buildPrompt(t), /You were interrupted earlier/);
});

test('restart transitions stagger running work, keep future parks, cancel smoke work, and stale a second interruption', () => {
  const result = spawnSync(process.execPath, ['--import', './test/_env.mjs', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { saveConfig } from './core/config.mjs';
    const home = process.env.CONDUCTOR_HOME, dir = join(home, 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now(), cwd = home;
    const put = (id, status, extra = {}) => fs.writeFileSync(join(dir, id + '.json'), JSON.stringify({ id, cwd, title: id, spec: 'work', provider: 'codex', attempts: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now - 1000).toISOString(), status, ...extra }));
    put('run-old', 'running', { createdAt: new Date(now - 2000).toISOString(), aliveAt: new Date(now - 500).toISOString() });
    put('run-new', 'running', { createdAt: new Date(now - 1000).toISOString() });
    put('park-future', 'parked', { resumeAt: now + 60_000 });
    put('park-past', 'parked', { resumeAt: now - 1000, attempts: 1 });
    put('queued-resume', 'queued', { resume: true });
    put('smoke-queued', 'queued', { source: 'smoke' });
    put('smoke-running', 'running', { source: 'smoke' });
    saveConfig({ worker: { resumeStaggerSeconds: 1 } });
    const first = await import('./core/tasks.mjs');
    assert.equal(first.getTask('run-old').status, 'running', 'import only loads the journal');
    assert.equal(JSON.parse(fs.readFileSync(join(dir, 'run-old.json'), 'utf8')).status, 'running');
    const timers = [], setTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (_fn, ms) => { timers.push(ms); return { unref() {} }; };
    let summary;
    try { summary = first.recoverTasks(); } finally { globalThis.setTimeout = setTimeout; }
    assert.equal(first.getTask('run-old').status, 'queued');
    assert.equal(first.getTask('run-old').recoveries, 1);
    assert.equal(first.getTask('run-old').interruptedAt, first.getTask('run-old').aliveAt);
    assert.equal(first.getTask('run-new').status, 'parked');
    assert.equal(first.getTask('run-new').error, 'restart stagger');
    assert.ok(first.getTask('run-new').resumeAt > Date.now());
    assert.equal(first.getTask('park-future').status, 'parked');
    assert.equal(first.getTask('park-past').status, 'queued');
    assert.equal(first.getTask('queued-resume').status, 'parked');
    for (const id of ['smoke-queued', 'smoke-running']) {
      assert.equal(first.getTask(id).status, 'canceled');
      assert.equal(first.getTask(id).error, 'battery interrupted by a restart');
    }
    assert.equal(summary.resumed, 4);
    assert.equal(summary.parkedKept, 1);
    assert.ok(summary.earliestParked);
    assert.equal(summary.smokeCanceled, 2);
    assert.ok(timers.some((ms) => ms > 50_000), 'future parked work gets a wake timer');
    assert.ok(timers.some((ms) => ms >= 1000 && ms < 1500), 'staggered work uses the park timer');

    const old = first.getTask('run-old');
    fs.writeFileSync(join(dir, 'run-old.json'), JSON.stringify({ ...old, status: 'running' }));
    const second = await import('./core/tasks.mjs?second-start');
    assert.equal(second.getTask('run-old').status, 'running', 'second import remains read-only');
    const secondSummary = second.recoverTasks();
    assert.equal(second.getTask('run-old').status, 'stale');
    assert.equal(second.getTask('run-old').recoveries, 2);
    assert.equal(second.getTask('run-old').error, 'interrupted by 2 restarts in a row; Re-run or Discard');
    assert.equal(secondSummary.stale, 1);
    assert.equal(second.openTasks().some((t) => t.id === 'run-old'), false);
    assert.match(second.describeTask(second.getTask('run-old')), /Stale: interrupted by 2 restarts in a row\. Ask the user to Re-run or Discard it\./);
    assert.equal((await second.awaitTask('run-old', 60_000)).status, 'stale');
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('graceful requeues share crash recovery staggering and notes without incrementing recoveries', () => {
  const result = spawnSync(process.execPath, ['--import', './test/_env.mjs', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { saveConfig } from './core/config.mjs';
    const dir = join(process.env.CONDUCTOR_HOME, 'tasks');
    mkdirSync(dir, { recursive: true });
    const records = [
      { id: 'z-graceful-old', status: 'queued', resume: true, createdAt: '2026-01-01', recoveries: 1 },
      { id: 'm-crash', status: 'running', createdAt: '2026-01-02' },
      { id: 'a-graceful-new', status: 'queued', resume: true, createdAt: '2026-01-03' },
      { id: 'fresh', status: 'queued', resume: false, attempts: 0, createdAt: '2026-01-04' },
    ];
    for (const task of records) writeFileSync(join(dir, task.id + '.json'), JSON.stringify({
      cwd: process.env.CONDUCTOR_HOME, sessionId: 'chat', attempts: 1,
      updatedAt: '2026-01-05', interruptedAt: '2026-01-05', ...task,
    }));
    saveConfig({ worker: { resumeStaggerSeconds: 1 } });
    const { recoverTasks, getTask } = await import('./core/tasks.mjs');
    const setTimeout = globalThis.setTimeout;
    globalThis.setTimeout = () => ({ unref() {} });
    let summary;
    try { summary = recoverTasks(); } finally { globalThis.setTimeout = setTimeout; }
    assert.equal(summary.resumed, 3);
    assert.equal(summary.stale, 0);
    assert.deepEqual(summary.bySession.chat.sort((a, b) => a.id.localeCompare(b.id)),
      records.slice(0, 3).map(({ id }) => ({ id, status: 'resumed' })).sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(getTask('z-graceful-old').status, 'queued');
    assert.equal(getTask('z-graceful-old').recoveries, 1);
    assert.equal(getTask('z-graceful-old').interruptedAt, '2026-01-05');
    assert.equal(getTask('m-crash').recoveries, 1);
    assert.equal(getTask('a-graceful-new').recoveries, undefined);
    for (const id of ['m-crash', 'a-graceful-new']) {
      assert.equal(getTask(id).status, 'parked');
      assert.equal(getTask(id).error, 'restart stagger');
      assert.equal(getTask(id).resume, true);
    }
    assert.equal(getTask('a-graceful-new').resumeAt - getTask('m-crash').resumeAt, 1000);
    assert.equal(getTask('fresh').status, 'queued');
    assert.equal(getTask('fresh').resume, false);
    for (const { id } of records) assert.deepEqual(JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')), getTask(id));
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('openTaskCount sees one open task behind 10000 completed tasks', async () => {
  const fs = require('node:fs');
  const dir = join(process.env.CONDUCTOR_HOME, 'tasks');
  // 10000 is the former guard cutoff: simulate a large journal without writing all its records.
  const journal = new Map(Array.from({ length: 10000 }, (_, i) => [
    join(dir, `${i}.json`), { id: String(i), status: 'done', createdAt: '2026-01-02' },
  ]));
  journal.set(join(dir, 'open.json'), { id: 'open', status: 'queued', createdAt: '2026-01-01' });
  const readdir = fs.readdirSync, readFile = fs.readFileSync;
  fs.readdirSync = (path, ...rest) => path === dir
    ? [...journal.keys()].map((p) => p.slice(dir.length + 1)) : readdir(path, ...rest);
  fs.readFileSync = (path, ...rest) => journal.has(path)
    ? JSON.stringify(journal.get(path)) : readFile(path, ...rest);
  syncBuiltinESMExports();
  try {
    const tk = await import(`../core/tasks.mjs?journal-guard=${Date.now()}`);
    assert.equal(tk.openTaskCount(), 1);
    assert.equal(tk.listTasks({ limit: 10000 }).some((t) => t.id === 'open'), true);
    const full = tk.listTasks({ limit: Infinity });
    const { DEFAULTS } = await import('../core/config.mjs');
    assert.equal(full.length, DEFAULTS.worker.tasksInMemory + 1);
    assert.equal(full.at(-1).id, 'open');
    assert.equal(full.at(-1).status, 'queued');
  } finally {
    fs.readdirSync = readdir;
    fs.readFileSync = readFile;
    syncBuiltinESMExports();
  }
});

test('bench --run refuses an open journal task', () => {
  const result = spawnSync(process.execPath, ['--import', './test/_env.mjs', '--input-type=module', '--eval', `
    import fs from 'node:fs';
    import { join } from 'node:path';
    const home = process.env.CONDUCTOR_HOME;
    const dir = join(home, 'tasks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(home, 'models.json'), JSON.stringify({ updatedAt: new Date().toISOString(), providers: {}, models: [] }));
    fs.writeFileSync(join(dir, 'open.json'), JSON.stringify({ id: 'open', cwd: home, status: 'queued', createdAt: new Date().toISOString(), spec: 'stay' }));
    // parseArgs skips only argv[0] when Node runs with --eval.
    process.argv = [process.execPath, 'bench', '--run'];
    await import('./bin/conductor.mjs');
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.ok(result.stderr.trim().startsWith('refusing to run: 1 open task(s) in the journal (a running server owns them).'), result.stderr);
});

test('P9: bounded records, disk-backed chains and indexed recovery preserve the journal', () => {
  const result = spawnSync(process.execPath, ['--import', './test/_env.mjs', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { join, dirname, basename } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { saveConfig } from './core/config.mjs';
    const dir = join(process.env.CONDUCTOR_HOME, 'tasks'), cwd = process.env.CONDUCTOR_HOME;
    fs.mkdirSync(dir, { recursive: true });
    saveConfig({ worker: { tasksInMemory: 50 } }); // owner's minimum; one extra terminal crosses it
    const put = (t) => fs.writeFileSync(join(dir, t.id + '.json'), JSON.stringify({ cwd, title: t.id, spec: 'full record', rounds: 0, ...t }));
    put({ id: 'root', status: 'failed', failedOverTo: 'live', createdAt: '2020-01-01', result: { items: [{ content: 'retained on disk' }] } });
    put({ id: 'retry', status: 'done', retryOf: 'root', createdAt: '2020-01-02' });
    put({ id: 'follow', status: 'done', followUpOf: 'retry', threadId: 'old-thread', provider: 'fixture', createdAt: '2020-01-03' });
    for (let i = 0; i < 51; i++) put({ id: 'terminal-' + i, status: 'done', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    for (const [id, status] of [['live', 'queued'], ['running', 'running'], ['parked', 'parked']]) put({ id, status, createdAt: '2020-01-01', updatedAt: new Date().toISOString(), resumeAt: Date.now() + 60000 });
    const readFile = fs.readFileSync;
    let reads = [];
    fs.readFileSync = (path, ...rest) => {
      if (dirname(String(path)) === dir && String(path).endsWith('.json')) reads.push(basename(String(path), '.json'));
      return readFile(path, ...rest);
    };
    syncBuiltinESMExports();
    const tk = await import('./core/tasks.mjs');
    const records = tk.listTasks({ limit: Infinity });
    assert.equal(records.length, 53);
    assert.equal(tk.openTasks().length, 3);
    assert.ok(!records.some(t => t.id === 'terminal-0' || t.id === 'root'));
    assert.ok(records.some(t => t.id === 'terminal-50'));
    reads = [];
    tk.recoverTasks();
    assert.deepEqual(reads.sort(), records.map(t => t.id).sort(), 'warm recovery reads only open and retained records');
    reads = [];
    const root = tk.getTask('root');
    assert.deepEqual(root.result.items, [{ content: 'retained on disk' }]);
    assert.deepEqual(reads, ['root']);
    assert.notEqual(tk.getTask('root'), root, 'old full records are not retained on lookup');
    assert.equal(tk.getTask(tk.getTask('follow').followUpOf).retryOf, 'root');
    const follow = tk.createTask({ followUpOf: 'follow', spec: 'continue' });
    assert.equal(follow.threadId, 'old-thread');
    assert.deepEqual(tk.cancelChain('root'), { canceled: ['live'], already: null });
    assert.deepEqual(tk.cancelChain('root'), { canceled: [], already: 'canceled' });
    const waited = await tk.awaitTask('root');
    assert.equal(waited.id, 'live');
    assert.equal(waited.status, 'canceled');
    assert.equal(waited.followedFrom, 'root');
    reads = [];
    for (const id of ['../config', '..\\\\config', 'root:stream']) assert.equal(tk.getTask(id), null);
    assert.deepEqual(reads, []);
    // New completions obey the same retention bound as recovery, without removing journal files.
    tk.cancelTask(follow.id);
    const terminal = tk.listTasks({ limit: Infinity }).filter(t => ['done', 'failed', 'canceled'].includes(t.status));
    assert.equal(terminal.length, 50);
    assert.ok(fs.existsSync(join(dir, 'root.json')));
    assert.ok(fs.existsSync(join(dir, 'terminal-0.json')));
    // An external edit invalidates its metadata even when that record was evicted.
    put({ id: 'root', status: 'queued', createdAt: '2020-01-01', spec: 'externally requeued' });
    reads = [];
    tk.recoverTasks();
    assert.equal(tk.getTask('root').status, 'queued');
    assert.ok(tk.openTasks().some(t => t.id === 'root'));
    assert.ok(reads.includes('root'));
    assert.ok(!reads.includes('terminal-0'), 'unchanged evicted terminal payload stays on disk');
    // The same index survives a new task-module instance, as in a relaunch.
    await new Promise(setImmediate); // recovery persists queued resumes; let the batched index save settle
    reads = [];
    const relaunched = await import('./core/tasks.mjs?p9-relaunch');
    assert.deepEqual(reads.sort(), relaunched.listTasks({ limit: Infinity }).map(t => t.id).sort());
    assert.equal(relaunched.getTask('retry').retryOf, 'root');
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
