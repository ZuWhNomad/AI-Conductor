import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTask, cancelTask, describeTask, getTask, tasksWithWorker } from './_helpers.mjs';
import { loadConfig, saveConfig } from '../../core/config.mjs';
import { briefPath, syncBrief } from '../../core/tasks/brief.mjs';

test('creating a task writes the brief once; a running persist does not rewrite it', async (ctx) => {
  const finish = Promise.withResolvers();
  const started = Promise.withResolvers();
  const tk = await tasksWithWorker(ctx, () => { started.resolve(); return finish.promise; });
  const cwd = tmpDir('brief-once');
  const spec = 'do the thing\nexactly this text';
  const t = tk.createTask({ cwd, title: 'add feature', spec, provider: 'deepseek', model: 'x', effort: 'low', category: 'implement', difficulty: 2 }, { dispatch: false });
  const file = join(HOME, 'tasks', `${t.id}.md`);
  const first = readFileSync(file, 'utf8');
  assert.match(first, /^# add feature$/m);
  assert.match(first, new RegExp(`- id: ${t.id}`));
  assert.match(first, new RegExp(`- cwd: ${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(first, /- provider: deepseek:x:low/);
  assert.match(first, /- category: implement@2/);
  assert.match(first, /## Spec\n\ndo the thing\nexactly this text\n/);
  assert.equal((first.match(/## Spec/g) || []).length, 1);
  assert.doesNotMatch(first, /## Result/);

  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    tk.schedule();
    await started.promise;
    assert.equal(readFileSync(file, 'utf8'), first);
    finish.resolve({ ok: true, finalMessage: 'worker said this', usage: { input_tokens: 3, output_tokens: 4 } });
    await tk.awaitTask(t.id);
    await tk.flushRecords();
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
  }

  const done = readFileSync(file, 'utf8');
  assert.equal((done.match(/^## Result <!-- conductor:result -->$/gm) || []).length, 1);
  assert.ok(done.startsWith(first.trimEnd()) || done.startsWith(first.replace(/\n$/, '')));
  assert.match(done, /worker said this/);
  assert.equal((done.match(/worker said this/g) || []).length, 1);
  assert.match(done, /Usage: \{"input_tokens":3,"output_tokens":4\}/);
  const task = tk.getTask(t.id);
  assert.ok(done.includes(tk.describeTask(task).split('\n')[0]));
  syncBrief(task);
  assert.equal(readFileSync(file, 'utf8'), done);
});

test('a terminal persist appends one result and a further persist appends nothing', () => {
  const cwd = tmpDir('brief-terminal');
  const t = createTask({ cwd, title: 'stop me', spec: 'stop', provider: 'deepseek', model: 'x' }, { dispatch: false });
  const file = join(HOME, 'tasks', `${t.id}.md`);
  const created = readFileSync(file, 'utf8');
  assert.doesNotMatch(created, /## Result/);
  cancelTask(t.id);
  const once = readFileSync(file, 'utf8');
  assert.equal((once.match(/^## Result <!-- conductor:result -->$/gm) || []).length, 1);
  assert.match(once, /Error: canceled/);
  assert.ok(once.includes(describeTask(getTask(t.id)).split('\n')[0]));
  assert.ok(once.startsWith(created.trimEnd()));
  cancelTask(t.id);
  syncBrief(getTask(t.id));
  assert.equal(readFileSync(file, 'utf8'), once);
});

test('a secret-shaped string in the spec is redacted in the brief', () => {
  const secret = ['sk', 'abcDEF1234567890extra'].join('-'); // built at runtime so the hub's leak hook does not see a key-shaped literal
  const t = createTask({ cwd: tmpDir('brief-secret'), title: 'keys', spec: `token ${secret} stays out`, provider: 'deepseek', model: 'x' }, { dispatch: false });
  const text = readFileSync(briefPath(t.id), 'utf8');
  assert.equal(text.includes(secret), false);
  assert.match(text, /\[redacted\]/);
  assert.match(text, /## Spec/);
});

test('describeTask compact mode keeps 12 report lines; an unknown reportInTool is full', () => {
  const report = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n\n');
  const t = { id: 'briefview', status: 'done', title: 'view', provider: 'deepseek', model: 'x', effort: 'low', rounds: 0, result: { finalMessage: report } };
  const compact = describeTask(t, { reportMode: 'compact' });
  const body = compact.split('Worker report:\n')[1];
  const kept = body.split('\n').filter((line) => /^line \d+$/.test(line));
  assert.equal(kept.length, 12);
  assert.equal(kept[0], 'line 1');
  assert.equal(kept[11], 'line 12');
  assert.match(compact, /Worker report:\nline 1\n\nline 2\n/);
  assert.match(compact, /… \(full report in the brief file\)/);
  assert.doesNotMatch(compact, /Brief:/);
  assert.doesNotMatch(compact, /line 13/);

  const short = describeTask({ ...t, id: 'briefshort', result: { finalMessage: 'alpha\n\nbeta' } }, { reportMode: 'compact' });
  assert.match(short, /Worker report:\nalpha\n\nbeta/);
  assert.doesNotMatch(short, /full report in the brief file/);

  const full = describeTask(t, { reportMode: 'full' });
  assert.match(full, /line 15/);
  assert.doesNotMatch(full, /full report in the brief file/);
  assert.doesNotMatch(full, /Brief:/);

  saveConfig({ worker: { reportInTool: 'essay' } });
  try {
    assert.equal(loadConfig().worker.reportInTool, 'full');
    const viaConfig = describeTask(t);
    assert.match(viaConfig, /line 15/);
    assert.doesNotMatch(viaConfig, /full report in the brief file/);
    saveConfig({ worker: { reportInTool: 'compact' } });
    assert.equal(loadConfig().worker.reportInTool, 'compact');
    assert.match(describeTask(t), /… \(full report in the brief file\)/);
    assert.doesNotMatch(describeTask(t), /line 13/);
  } finally {
    saveConfig({ worker: { reportInTool: 'full' } });
  }
  syncBrief(t);
  assert.match(describeTask(t, { reportMode: 'full' }), new RegExp(`Brief: ${briefPath(t.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('a spec containing a Result heading still gets its result appended once', () => {
  const spec = 'Review the stage.\n\n## Result\nThe worker wrote this heading.\n';
  const t = createTask({ cwd: tmpDir('brief-marker'), title: 'judge', spec, provider: 'deepseek', model: 'x' }, { dispatch: false });
  const file = briefPath(t.id);
  const created = readFileSync(file, 'utf8');
  assert.match(created, /^## Result$/m);
  assert.doesNotMatch(created, /<!-- conductor:result -->/);
  cancelTask(t.id);
  const done = readFileSync(file, 'utf8');
  assert.equal((done.match(/^## Result <!-- conductor:result -->$/gm) || []).length, 1);
  assert.match(done, /Error: canceled/);
  cancelTask(t.id);
  syncBrief(getTask(t.id));
  assert.equal(readFileSync(file, 'utf8'), done);
});

test('isolation set after creation is named in the result', () => {
  const t = createTask({ cwd: tmpDir('brief-iso'), title: 'isolate me', spec: 'work', provider: 'deepseek', model: 'x' }, { dispatch: false });
  const file = briefPath(t.id);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /isolation/);
  getTask(t.id).isolation = { dir: 'C:\\wt\\iso', branch: 'conductor/iso-branch' };
  cancelTask(t.id);
  const done = readFileSync(file, 'utf8');
  const [head, result] = done.split('## Result <!-- conductor:result -->');
  assert.ok(result);
  assert.doesNotMatch(head, /iso-branch/);
  assert.match(result, /C:\\wt\\iso/);
  assert.match(result, /branch conductor\/iso-branch/);
});

test('optional brief links are recorded when the task has them', () => {
  const id = 'briefmeta01';
  syncBrief({
    id, title: 'linked', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z', cwd: 'C:\\work',
    provider: 'deepseek', model: 'x', effort: 'low', category: 'implement', difficulty: 3, rounds: 0, spec: 'body',
    followUpOf: 'parent1', retryOf: 'retry1', isolation: { dir: 'C:\\wt', base: 'C:\\repo', branch: 'conductor/briefmeta01' },
  });
  const text = readFileSync(briefPath(id), 'utf8');
  assert.match(text, /- followUpOf: parent1/);
  assert.match(text, /- retryOf: retry1/);
  assert.match(text, /- isolation: C:\\wt from C:\\repo, branch conductor\/briefmeta01/);
  syncBrief({ id, status: 'running', title: 'linked', spec: 'other', provider: 'deepseek', rounds: 0 });
  assert.equal(readFileSync(briefPath(id), 'utf8'), text);
});
