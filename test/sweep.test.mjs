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

test('nextReset names the earliest reset among the windows holding the provider back', async () => {
  const { nextReset } = await import('../core/sweep.mjs');
  const lim = await import('../core/limits.mjs');
  const t5 = Date.now() + 3600e3, tw = Date.now() + 5 * 86400e3;
  lim.getLimits().providers.claude = { provider: 'claude', windows: [{ id: 'claude:5h', label: '5-hour', usedPercent: 81, resetsAt: t5 }, { id: 'claude:w', label: 'weekly', usedPercent: 90, resetsAt: tw }] };
  assert.equal(nextReset('claude', null, { bufferPct: 25 }), t5);                               // both binding: earliest
  assert.equal(nextReset('claude', null, { bufferPct: 25, sessionOnly: true }), t5);
  assert.equal(nextReset('claude', null, { bufferPct: 5 }), null);                               // nothing over 95%: not blocked by a window
  lim.getLimits().providers.grok = { provider: 'grok', windows: [] };
  assert.equal(nextReset('grok'), null);                                                          // unknown: caller polls
  delete lim.getLimits().providers.claude; delete lim.getLimits().providers.grok;
});

test('per-window targets: session windows to 95%, weekly and budgets to 100%; the tightest window decides', async () => {
  const { targetFor, headroomFor, planGreedyWindows, nextResetWindows } = await import('../core/sweep.mjs');
  const t5 = Date.now() + 3600e3, tw = Date.now() + 5 * 86400e3;
  const claude = [{ id: 'claude:5h', label: '5-hour', usedPercent: 90, resetsAt: t5 }, { id: 'claude:w', label: 'weekly', usedPercent: 60, resetsAt: tw }];
  assert.equal(targetFor(claude[0]), 95); assert.equal(targetFor(claude[1]), 100);
  assert.deepEqual(headroomFor(claude).headroom, 5);                                     // session: 95 - 90
  assert.equal(planGreedyWindows([2, 2, 2], claude).n, 2);                                // 5% headroom fits two 2% tasks
  const codex = [{ id: 'codex:primary', label: 'Codex weekly', usedPercent: 92, resetsAt: tw, windowMinutes: 10080 }];
  assert.equal(headroomFor(codex).headroom, 8);                                           // weekly-only: to 100%
  assert.equal(planGreedyWindows([5, 5], codex).n, 1);
  assert.equal(planGreedyWindows([5], [{ id: 'codex:primary', label: 'Codex weekly', usedPercent: 100, resetsAt: tw }]).n, 0);
  assert.equal(nextResetWindows([{ id: 'x', label: '5-hour', usedPercent: 95, resetsAt: t5 }, { id: 'y', label: 'weekly', usedPercent: 99, resetsAt: tw }]), t5);
  assert.equal(nextResetWindows(codex), null);                                            // 92% of a 100% target: not full
  assert.equal(headroomFor([]).headroom, 100);                                            // no windows reported: planner falls back to cost-unknown probing
});

test('admit: gates dispatch on per-window headroom under targets, and parks (until reset) when a provider is tapped out', async () => {
  const { admit } = await import('../core/sweep.mjs');
  const tw = Date.now() + 5 * 86400e3;
  const codex91 = [{ id: 'codex:w', label: 'Codex weekly', usedPercent: 91, resetsAt: tw, windowMinutes: 10080 }]; // weekly target 100 -> 9% headroom
  assert.equal(admit(codex91, [{ cost: 3 }, { cost: 3 }, { cost: 3 }, { cost: 3 }]).n, 3);   // 3+3+3=9 fits, 4th does not
  assert.equal(admit(codex91, [{ cost: 3 }], { runningCost: 8 }).n, 0);                        // 8% already in flight: only 1% free
  const full = [{ id: 'codex:w', label: 'Codex weekly', usedPercent: 100, resetsAt: tw }];
  const r = admit(full, [{ cost: 1 }]);
  assert.equal(r.n, 0); assert.equal(r.until, tw);                                              // tapped out -> park until reset
  assert.equal(admit([], [{ cost: 5 }]).n, 1);                                                  // no windows reported (grok/ollama): not gated
  const sess = [{ id: 'c:5h', label: '5-hour', usedPercent: 94, resetsAt: Date.now() + 3600e3 }]; // session target 95 -> 1% headroom
  assert.equal(admit(sess, [{ cost: 2 }]).n, 0);                                                 // 2% > 1% -> park (session capped at 95%, not 100%)
});

test('admit: per-window costs charge each window its own cost, not one window\'s % against all', async () => {
  const { admit } = await import('../core/sweep.mjs');
  const tw = Date.now() + 5 * 86400e3;
  // Codex at 91% weekly (9% headroom) plus a fresh 5-hour window (0% used, 95% headroom).
  const windows = [
    { id: 'w', label: 'Codex weekly', usedPercent: 91, resetsAt: tw, windowMinutes: 10080 },
    { id: 's', label: '5-hour', usedPercent: 0, resetsAt: Date.now() + 3600e3 },
  ];
  // A build costs 13% of the 5-hour window but only 3% of the weekly. It fits BOTH (weekly 3<9, 5h 13<95).
  assert.equal(admit(windows, [{ costs: { w: 3, s: 13 } }], { maxParallel: 1 }).n, 1);   // regression: was wrongly blocked when 13% was charged to the weekly too
  // If it really cost 10% of the weekly, it would not fit the weekly's 9% headroom.
  assert.equal(admit(windows, [{ costs: { w: 10, s: 13 } }], { maxParallel: 1 }).n, 0);
  // Unknown per-window cost -> exactly one probe admitted (never floods a fresh window).
  assert.equal(admit(windows, [{ costs: {} }, { costs: {} }, { costs: {} }]).n, 1);
});
