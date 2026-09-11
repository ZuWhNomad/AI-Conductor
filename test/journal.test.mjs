import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(HOME, 'tasks'); const cwd = tmpDir('journal');
mkdirSync(dir, { recursive: true });
for (const t of [
  { id: 'p1', status: 'parked', resumeAt: Date.now() - 1000, resume: true },
  { id: 'r1', status: 'running' },
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
