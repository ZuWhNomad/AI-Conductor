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
    { provider: 'codex', model: 'gpt-5.6-sol', pct: { 'codex:primary': 3 }, concurrent: 5 }, // 3% moved while 6 tasks ran: 0.5% each
  ];
  assert.equal(measuredCost(rows, 'antigravity', { model: 'gemini-3.8-flash-low' }), 0.4);
  assert.equal(measuredCost(rows, 'antigravity', { model: 'claude-sonnet-4-6' }), 3.1);
  assert.equal(measuredCost(rows, 'codex'), 1);
  assert.equal(measuredCost(rows, 'codex', { model: 'gpt-5.6-sol' }), 0.5);
  assert.equal(measuredCost(rows, 'grok'), 0);
  const g = nextBatch({ provider: 'antigravity', model: 'gemini-3.8-flash-low', rows, remaining: 20, bufferPct: 25, maxParallel: 6 });
  assert.equal(g.n, 6);                                                                   // 65% headroom / 0.4% per task, capped at 6
  const c = nextBatch({ provider: 'antigravity', model: 'claude-sonnet-4-6', rows, remaining: 20, bufferPct: 25, maxParallel: 6 });
  assert.equal(c.n, 6);                                                                   // 25% headroom / 3.1% = 8, capped at 6
  delete lim.getLimits().providers.antigravity;
});

test('effortMultiplier scales a probe cost by measured tokens per effort, with a conservative fallback', async () => {
  const { effortMultiplier } = await import('../core/sweep.mjs');
  const summary = [
    { steps: 1, sel: 'codex:gpt-5.6-sol:low', avgTokens: 50000, n: 3 },
    { steps: 1, sel: 'codex:gpt-5.6-sol:low', avgTokens: 70000, n: 1 },
    { steps: 1, sel: 'codex:gpt-5.6-sol:ultra', avgTokens: 330000, n: 2 },
    { steps: 2, sel: 'codex:gpt-5.6-sol:ultra', avgTokens: 999999, n: 9 }, // ladders are ignored
  ];
  assert.equal(Number(effortMultiplier(summary, 'codex', 'gpt-5.6-sol', 'ultra').toFixed(2)), 6.0);   // 330k / 55k
  assert.equal(effortMultiplier(summary, 'codex', 'gpt-5.6-sol', 'low'), 1);
  assert.equal(effortMultiplier(summary, 'codex', 'gpt-5.6-terra', 'max'), 4);                          // no rows: ladder
  assert.equal(effortMultiplier(summary, 'codex', 'gpt-5.6-terra', 'high', 'medium'), 2 / 1.5);
});

test('planGreedy fills the headroom with the cheapest tasks first and isolates unknown costs', async () => {
  const { planGreedy } = await import('../core/sweep.mjs');
  const g = planGreedy([8, 1, 30, 2, 4], { usedPct: 20, bufferPct: 25 });        // headroom 55: 1+2+4+8+30 = 45 fits
  assert.equal(g.n, 5); assert.deepEqual(g.order, [1, 3, 4, 0, 2]);
  assert.equal(planGreedy([8, 1, 30, 2, 4], { usedPct: 60 }).n, 4);              // headroom 15: 1+2+4+8 = 15 fits, 30 does not
  assert.equal(planGreedy([40], { usedPct: 60 }).n, 0);
  assert.equal(planGreedy([0, 0, 3], { usedPct: 10 }).n, 1);                     // unknown cost: one probe alone
  assert.equal(planGreedy([1, 1, 1], { usedPct: 10, maxParallel: 2 }).n, 2);
  assert.equal(planGreedy([1, 1], { usedPct: 80 }).n, 0);
});
