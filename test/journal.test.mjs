import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const { getTask, listTasks } = await import('../core/tasks.mjs');

test('journal reload queues interrupted and parked tasks and tolerates numeric specs', () => {
  for (const id of ['p1', 'r1']) {
    assert.equal(getTask(id).status, 'queued');
    assert.equal(getTask(id).resume, true);
  }
  assert.doesNotThrow(() => listTasks());
  assert.equal(listTasks().find((t) => t.id === 'bad').specPreview, '42');
});

test('journal reload does not replay work interrupted more than resumeMaxAgeHours ago', async () => {
  for (const id of ['old', 'nodate']) {
    assert.equal(getTask(id).status, 'canceled');
    assert.match(getTask(id).error, /not resumed: interrupted more than 6 h/);
    assert.equal(getTask(id).resume, false);
  }
  const { readFileSync } = await import('node:fs');
  assert.equal(JSON.parse(readFileSync(join(dir, 'old.json'), 'utf8')).status, 'canceled'); // written back, so a second start does not re-evaluate
  const { listImprovements } = await import('../core/improve.mjs');
  assert.ok(listImprovements().some((i) => i.message.includes('2 interrupted task(s) older than 6 h')));
});

test('queued resume tasks older than resumeMaxAgeHours are not replayed; never-started queued tasks are', async () => {
  const dayAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
  const now = new Date().toISOString();
  writeFileSync(join(dir, 'qold.json'), JSON.stringify({ id: 'qold', cwd, status: 'queued', resume: true, updatedAt: dayAgo }));
  writeFileSync(join(dir, 'qnew.json'), JSON.stringify({ id: 'qnew', cwd, status: 'queued', resume: true, updatedAt: now }));
  writeFileSync(join(dir, 'qfresh.json'), JSON.stringify({ id: 'qfresh', cwd, status: 'queued', updatedAt: dayAgo }));
  const { getTask } = await import(`../core/tasks.mjs?og3=${Date.now()}`);
  assert.equal(getTask('qold').status, 'canceled');
  assert.match(getTask('qold').error, /not resumed: interrupted more than 6 h/);
  assert.equal(getTask('qold').resume, false);
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
  for (const id of ['future-park', 'recent-reset', 'recent-park']) {
    assert.equal(tk.getTask(id).status, 'queued');
    assert.equal(tk.getTask(id).resume, true);
  }
  assert.equal(tk.getTask('future-park').resumeAt, resumeAt);
});

test('L36: recovery does not give never-started parked tasks an interruption prompt', async () => {
  writeFileSync(join(dir, 'never-started.json'), JSON.stringify({ id: 'never-started', cwd, status: 'parked', attempts: 0, updatedAt: now, resumeAt: Date.now() + 60_000, spec: 'start fresh' }));
  const tk = await import('../core/tasks.mjs?l36-recovery');
  const t = tk.getTask('never-started');
  assert.equal(t.status, 'queued');
  assert.equal(t.resume, false);
  assert.doesNotMatch(tk.buildPrompt(t), /You were interrupted earlier/);
});

for (const [args, refusal] of [
  [['bench', '--run'], 'refusing to run: 1 open task(s) in the journal (a running server owns them).'],
  [['smoke'], 'refusing to run: 1 task(s) are queued/running/parked in'],
  [['review'], 'refusing to run: 1 open task(s) in'],
]) test(`${args.join(' ')} refuses an open task behind 10000 completed tasks`, () => {
  const result = spawnSync(process.execPath, ['--import', './test/_env.mjs', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import childProcess from 'node:child_process';
    import { join } from 'node:path';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    const dir = join(process.env.CONDUCTOR_HOME, 'tasks');
    // 10000 is the former guard cutoff: simulate a large journal without writing all its records.
    const journal = new Map(Array.from({ length: 10000 }, (_, i) => [
      join(dir, i + '.json'), { id: String(i), status: 'done', createdAt: '2026-01-02' },
    ]));
    journal.set(join(dir, 'open.json'), { id: 'open', status: 'queued', createdAt: '2026-01-01' });
    const readdir = fs.readdirSync, readFile = fs.readFileSync;
    fs.readdirSync = (path, ...rest) => path === dir
      ? [...journal.keys()].map(path => path.slice(dir.length + 1)) : readdir(path, ...rest);
    fs.readFileSync = (path, ...rest) => journal.has(path)
      ? JSON.stringify(journal.get(path)) : readFile(path, ...rest);
    // A cached empty registry prevents bench from probing installed providers.
    fs.writeFileSync(join(process.env.CONDUCTOR_HOME, 'models.json'), JSON.stringify({
      updatedAt: new Date().toISOString(), providers: {}, models: [],
    }));
    const unexpectedIO = [];
    const rejectIO = () => { unexpectedIO.push('external I/O'); throw new Error('unexpected external I/O'); };
    globalThis.fetch = rejectIO;
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      childProcess[method] = rejectIO;
    }
    syncBuiltinESMExports();
    process.on('exit', () => assert.deepEqual(unexpectedIO, []));
    registerHooks({ load(url, context, nextLoad) {
      if (url === new URL('./core/conductor.mjs', import.meta.url).href) return {
        format: 'module', shortCircuit: true,
        source: "export const parseSelection = () => ({ provider: 'claude' }); export const runOnce = () => { throw new Error('review passed the journal guard'); };",
      };
      return nextLoad(url, context);
    } });
    const { listTasks } = await import('./core/tasks.mjs');
    assert.equal(listTasks({ limit: 10000 }).some(t => t.id === 'open'), true);
    const full = listTasks({ limit: Infinity });
    const { DEFAULTS } = await import('./core/config.mjs');
    assert.equal(full.length, DEFAULTS.worker.tasksInMemory + 1);
    assert.equal(full.at(-1).id, 'open');
    assert.equal(full.at(-1).status, 'queued');
    // parseArgs skips only argv[0] when Node runs with --eval.
    process.argv = [process.execPath, ...${JSON.stringify(args)}];
    await import('./bin/conductor.mjs');
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.ok(result.stderr.trim().startsWith(refusal), result.stderr);
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
    assert.equal((await tk.awaitTask('root')).status, 'failed');
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
    reads = [];
    const relaunched = await import('./core/tasks.mjs?p9-relaunch');
    assert.deepEqual(reads.sort(), relaunched.listTasks({ limit: Infinity }).map(t => t.id).sort());
    assert.equal(relaunched.getTask('retry').retryOf, 'root');
  `], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
