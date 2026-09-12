import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { planBatch, measuredCost, nextBatch } = await import('../core/sweep.mjs');
const lim = await import('../core/limits.mjs');

test('planBatch sizes a batch from headroom under the buffer, capped by parallelism and remaining work', () => {
  assert.deepEqual(planBatch({ costPct: 3, usedPct: 40 }).n, 4);                       // 35% headroom / 3% = 11, capped at 4
  assert.equal(planBatch({ costPct: 3, usedPct: 40, maxParallel: 8 }).n, 8);
  assert.equal(planBatch({ costPct: 3, usedPct: 40, remaining: 2 }).n, 2);
  assert.equal(planBatch({ costPct: 10, usedPct: 60 }).n, 1);                            // 15% headroom / 10% = 1
  assert.equal(planBatch({ costPct: 20, usedPct: 60 }).n, 0);                            // one task would cross the line
  assert.equal(planBatch({ costPct: 3, usedPct: 80 }).n, 0);                             // inside the buffer already
  assert.equal(planBatch({ costPct: 0, usedPct: 10 }).n, 1);                             // unknown cost: probe one
  assert.equal(planBatch({ costPct: 0, usedPct: 10, unlimited: true, maxParallel: 3 }).n, 3);
  assert.match(planBatch({ costPct: 3, usedPct: 80 }).reason, /wait for reset/);
});

test('measuredCost takes the largest window delta a probe consumed, honouring model-group windows', () => {
  lim.getLimits().providers.antigravity = { provider: 'antigravity', windows: [{ id: 'antigravity:gemini-5h', usedPercent: 10, models: '^(gemini)' }, { id: 'antigravity:3p-5h', usedPercent: 50, models: '^(claude|gpt)' }] };
  const rows = [
    { provider: 'antigravity', model: 'gemini-3.8-flash-low', pct: { 'antigravity:gemini-5h': 0.4, 'antigravity:3p-5h': 0 } },
    { provider: 'antigravity', model: 'claude-sonnet-4-6', pct: { 'antigravity:gemini-5h': 0, 'antigravity:3p-5h': 3.1 } },
    { provider: 'codex', model: 'gpt-5.6-luna', pct: { 'codex:primary': 1 } },
  ];
  assert.equal(measuredCost(rows, 'antigravity', { model: 'gemini-3.8-flash-low' }), 0.4);
  assert.equal(measuredCost(rows, 'antigravity', { model: 'claude-sonnet-4-6' }), 3.1);
  assert.equal(measuredCost(rows, 'codex'), 1);
  assert.equal(measuredCost(rows, 'grok'), 0);
  const g = nextBatch({ provider: 'antigravity', model: 'gemini-3.8-flash-low', rows, remaining: 20, bufferPct: 25, maxParallel: 6 });
  assert.equal(g.n, 6);                                                                   // 65% headroom / 0.4% per task, capped at 6
  const c = nextBatch({ provider: 'antigravity', model: 'claude-sonnet-4-6', rows, remaining: 20, bufferPct: 25, maxParallel: 6 });
  assert.equal(c.n, 6);                                                                   // 25% headroom / 3.1% = 8, capped at 6
  delete lim.getLimits().providers.antigravity;
});
