import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { logImprovement, listImprovements, resolveImprovement, buildReviewPrompt } = await import('../core/improve.mjs');
const { formatModels, formatLimits, conductorToolDefs } = await import('../core/tools.mjs');

test('improvement log appends, lists, resolves and feeds the review prompt', () => {
  const e = logImprovement('error', 'worker:codex', 'boom', { taskId: 't1' });
  assert.equal(listImprovements().length, 1);
  assert.match(buildReviewPrompt(), new RegExp(`\\[${e.id}\\]`));
  resolveImprovement(e.id);
  assert.equal(listImprovements().length, 0);
  assert.equal(listImprovements({ includeResolved: true })[0].resolved, true);
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
  assert.equal(await tool.handler({ kind: 'idea', message: `resolved ${e.id}: done` }), `resolved ${e.id}`);
  assert.ok(!listImprovements().some((entry) => entry.id === e.id));
  assert.match(await tool.handler({ kind: 'idea', message: 'ordinary idea' }), /^logged /);
  assert.ok(listImprovements().some((entry) => entry.message === 'ordinary idea'));
});

test('limit formatting marks stale windows and truncates the poll error', () => {
  const error = 'not installed '.repeat(10);
  const text = formatLimits({ providers: { codex: { error, windows: [{ label: 'weekly', usedPercent: 42 }] } } });
  assert.ok(text.includes(`weekly 42% (stale: ${error.slice(0, 80)})`));
  assert.ok(!text.includes(error));
});
