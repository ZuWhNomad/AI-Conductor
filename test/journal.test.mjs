import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
