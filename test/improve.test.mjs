import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readNdjson, appendNdjson, statePath } from '../core/paths.mjs';
import { bus } from '../core/bus.mjs';

const { logImprovement, listImprovements, resolveImprovement, buildReviewPrompt } = await import('../core/improve.mjs');
const { formatModels, formatLimits, conductorToolDefs } = await import('../core/tools.mjs');

test('improvement log appends, lists, resolves and feeds the review prompt', () => {
  const e = logImprovement('error', 'worker:codex', 'boom', { taskId: 't1' });
  assert.equal(listImprovements().length, 1);
  assert.match(buildReviewPrompt(), new RegExp(`\\[${e.id}\\]`));
  const seq = bus.seq;
  resolveImprovement(e.id);
  assert.deepEqual(bus.since(seq).filter((event) => event.type === 'improvement').map((event) => event.resolved), [e.id]);
  assert.equal(listImprovements().length, 0);
  assert.equal(listImprovements({ includeResolved: true })[0].resolved, true);
});

test('improvement context uses the message cap while preserving small objects', async () => {
  const { bus } = await import('../core/bus.mjs');
  const small = { taskId: 'context-test', nested: { status: 'failed' } };
  const normal = logImprovement('error', 'context-test', 'small context', small);
  assert.deepEqual(normal.context, small);
  const context = { output: 'x'.repeat(100_000), nested: { detail: 'y'.repeat(100_000) } };
  const entry = logImprovement('error', 'context-test', 'm'.repeat(100_000), context);
  assert.equal(entry.message.length, 4000);
  assert.equal(entry.context, JSON.stringify(context).slice(0, entry.message.length));
  assert.equal(context.output.length, 100_000, 'the caller context is not mutated');
  assert.deepEqual(listImprovements().find((e) => e.id === entry.id), entry);
  assert.deepEqual(bus.since(0).find((e) => e.type === 'improvement' && e.entry?.id === entry.id).entry, entry);
});

test('registry formatting for the conductor', () => {
  const m = formatModels({ updatedAt: 'now', providers: { codex: { status: 'ok', plan: 'prolite' }, claude: { status: 'unavailable', loggedIn: false } }, models: [{ provider: 'codex', id: 'gpt-6-astra', efforts: ['low', 'ultra'], isDefault: true }] });
  assert.match(m, /gpt-6-astra\* \[low\/ultra\]/);
  assert.match(m, /claude .*not logged in/);
  const l = formatLimits({ updatedAt: 'now', providers: { codex: { plan: 'prolite', blocked: true, blockedUntil: Date.now() + 1000, blockedReason: 'rate_limit_reached', windows: [{ label: 'Codex weekly', usedPercent: 100, resetsAt: Date.now() + 1000 }] } } });
  assert.match(l, /BLOCKED/);
  assert.match(l, /Codex weekly 100%/);
});

test('log_improvement resolves entries using the review convention', async () => {
  const e = logImprovement('error', 'review-test', 'fix this');
  const tool = conductorToolDefs({ sessionId: 's', cwd: tmpDir('review') }).find((d) => d.name === 'log_improvement');
  const seq = bus.seq;
  assert.equal(await tool.handler({ kind: 'idea', message: `resolved ${e.id}: done` }), `resolved ${e.id}`);
  assert.deepEqual(bus.since(seq).filter((event) => event.type === 'improvement').map((event) => event.resolved), [e.id]);
  assert.ok(!listImprovements().some((entry) => entry.id === e.id));
  assert.match(await tool.handler({ kind: 'idea', message: 'ordinary idea' }), /^logged /);
  assert.ok(listImprovements().some((entry) => entry.message === 'ordinary idea'));
});

test('improvement IDs avoid persisted and resolved entries without conflating resolutions', (ctx) => {
  const file = statePath('improvements.ndjson');
  const diskId = (0.125).toString(36).slice(2, 10);
  appendNdjson(file, { id: diskId, message: 'from an earlier process', resolved: false });
  resolveImprovement(diskId);
  const samples = [0.125, 0.25, 0.25, 0.375];
  ctx.mock.method(Math, 'random', () => { assert.ok(samples.length); return samples.shift(); });
  const first = logImprovement('idea', 'collision', 'first entry');
  const second = logImprovement('idea', 'collision', 'second entry');
  assert.notEqual(first.id, diskId);
  assert.notEqual(second.id, first.id);
  resolveImprovement(first.id);
  assert.ok(!listImprovements().some((entry) => entry.id === first.id));
  assert.ok(listImprovements().some((entry) => entry.id === second.id));
  assert.equal(readNdjson(file).filter((entry) => !entry.op && entry.id === diskId).length, 1);
});

for (const event of ['uncaughtException', 'unhandledRejection']) {
  test(`global ${event} capture survives a persistence failure`, () => {
    const result = spawnSync(process.execPath, ['--import', './test/_env.mjs', '--input-type=module', '--eval', `
      import { mkdirSync } from 'node:fs';
      import { statePath } from './core/paths.mjs';
      import { installGlobalErrorCapture } from './core/improve.mjs';
      mkdirSync(statePath('improvements.ndjson'));
      installGlobalErrorCapture();
      setTimeout(() => process.stdout.write('survived'), 0);
      ${event === 'uncaughtException' ? "throw new Error('capture test');" : "Promise.reject(new Error('capture test'));"}
    `], { encoding: 'utf8', env: { ...process.env, CONDUCTOR_HOME: HOME } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'survived');
  });
}

test('logImprovement collapses repeats by kind+source+message even when another entry is interleaved', () => {
  const src = 'collapse-key-test';
  const a = logImprovement('friction', src, 'same problem');
  logImprovement('friction', src, 'a different problem');
  const b = logImprovement('friction', src, 'same problem');
  const c = logImprovement('friction', src, 'yet another message');
  const mine = listImprovements().filter((e) => e.source === src);
  assert.equal(a.id, b.id);
  assert.equal(mine.filter((e) => e.message === 'same problem').length, 1);
  assert.ok(mine.some((e) => e.message === 'a different problem'));
  assert.ok(c.id !== a.id && mine.some((e) => e.message === 'yet another message'));
});

test('limit formatting marks stale windows and truncates the poll error', () => {
  const error = 'not installed '.repeat(10);
  const text = formatLimits({ providers: { codex: { error, windows: [{ label: 'weekly', usedPercent: 42 }] } } });
  assert.ok(text.includes(`weekly 42% (stale: ${error.slice(0, 80)})`));
  assert.ok(!text.includes(error));
});
