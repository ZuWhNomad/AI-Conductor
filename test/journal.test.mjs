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
  { id: 'p1', status: 'parked', resumeAt: Date.now() - 1000, resume: true, updatedAt: now },
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
    // 10000 is the former guard cutoff: keep the large journal in memory.
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
    assert.equal(listTasks({ limit: 10000 }).some(t => t.id === 'open'), false);
    const full = listTasks({ limit: Infinity });
    assert.equal(full.length, journal.size);
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
