import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { measuredCostByWindow, targetFor, nextResetWindows, admit } = await import('../core/sweep.mjs');
const lim = await import('../core/limits.mjs');

test('measuredCostByWindow takes the largest delta per window, honouring model-group windows and concurrency', () => {
  lim.getLimits().providers.antigravity = { provider: 'antigravity', windows: [{ id: 'antigravity:gemini-5h', usedPercent: 10, models: '^(gemini)' }, { id: 'antigravity:3p-5h', usedPercent: 50, models: '^(claude|gpt)' }] };
  const rows = [
    { provider: 'antigravity', model: 'gemini-3.8-flash-low', pct: { 'antigravity:gemini-5h': 0.4, 'antigravity:3p-5h': 0.2 } }, // 3p-5h moved for someone else: not this model's window
    { provider: 'antigravity', model: 'claude-sonnet-4-6', pct: { 'antigravity:gemini-5h': 0, 'antigravity:3p-5h': 3.1 } },
    { provider: 'codex', model: 'gpt-5.6-luna', pct: { 'codex:primary': 1 } },
    { provider: 'codex', model: 'gpt-5.6-sol', pct: { 'codex:primary': 3 }, concurrent: 5 }, // 3% moved while 6 tasks ran: 0.5% each
  ];
  assert.deepEqual(measuredCostByWindow(rows, 'antigravity', { model: 'gemini-3.8-flash-low' }), { 'antigravity:gemini-5h': 0.4 });
  assert.deepEqual(measuredCostByWindow(rows, 'antigravity', { model: 'claude-sonnet-4-6' }), { 'antigravity:3p-5h': 3.1 });
  assert.deepEqual(measuredCostByWindow(rows, 'codex'), { 'codex:primary': 1 });
  assert.deepEqual(measuredCostByWindow(rows, 'codex', { model: 'gpt-5.6-sol' }), { 'codex:primary': 0.5 });
  assert.deepEqual(measuredCostByWindow(rows, 'grok'), {});
  delete lim.getLimits().providers.antigravity;
});

test('measuredCostByWindow does not throw on an invalid models pattern', () => {
  const id = 'sweep-bad-re';
  try {
    lim.getLimits().providers[id] = { provider: id, windows: [{ id: 'spark', models: 'Spark+ (unclosed' }] };
    const rows = [
      { provider: id, model: 'gpt-5.3-codex-spark', pct: { spark: 5 } },
      { provider: id, model: 'Spark+ (unclosed-x', pct: { spark: 3 } },
    ];
    assert.doesNotThrow(() => measuredCostByWindow(rows, id));
    assert.deepEqual(measuredCostByWindow(rows, id), { spark: 3 });
    assert.deepEqual(measuredCostByWindow(rows, id, { model: 'gpt-5.3-codex-spark' }), {});
  } finally { delete lim.getLimits().providers[id]; }
});

test('OB2: a measured 0% delta still records the window so it is not treated as unmeasured', () => {
  const rows = [{ provider: 'codex', model: 'x', pct: { w1: 5, w2: 0 } }];
  assert.deepEqual(measuredCostByWindow(rows, 'codex'), { w1: 5, w2: 0 });
});


test('per-window targets: session windows to 95%, weekly and budgets to 100%', () => {
  const t5 = Date.now() + 3600e3, tw = Date.now() + 5 * 86400e3;
  assert.equal(targetFor({ id: 'claude:5h', label: '5-hour' }), 95);
  assert.equal(targetFor({ id: 'claude:w', label: 'weekly' }), 100);
  assert.equal(nextResetWindows([{ id: 'x', label: '5-hour', usedPercent: 95, resetsAt: t5 }, { id: 'y', label: 'weekly', usedPercent: 99, resetsAt: tw }]), t5);
  assert.equal(nextResetWindows([{ id: 'codex:primary', label: 'Codex weekly', usedPercent: 92, resetsAt: tw, windowMinutes: 10080 }]), null); // 92% of a 100% target: not full
});

test('admit: gates dispatch on per-window headroom under targets, and reports the reset when a provider is tapped out', () => {
  const tw = Date.now() + 5 * 86400e3;
  const c = (n) => ({ costs: { 'codex:w': n } });
  const codex91 = [{ id: 'codex:w', label: 'Codex weekly', usedPercent: 91, resetsAt: tw, windowMinutes: 10080 }]; // weekly target 100 -> 9% headroom
  assert.equal(admit(codex91, [c(3), c(3), c(3), c(3)]).n, 3);                                  // 3+3+3=9 fits, 4th does not
  assert.equal(admit(codex91, [c(3)], { runningByWindow: { 'codex:w': 8 } }).n, 0);             // 8% already in flight: only 1% free
  const full = [{ id: 'codex:w', label: 'Codex weekly', usedPercent: 100, resetsAt: tw }];
  const r = admit(full, [c(1)]);
  assert.equal(r.n, 0); assert.equal(r.until, tw);                                              // tapped out -> reset time
  assert.equal(admit([], [c(5)]).n, 1);                                                         // no windows reported (grok/ollama): not gated
  const sess = [{ id: 'c:5h', label: '5-hour', usedPercent: 94, resetsAt: Date.now() + 3600e3 }]; // session target 95 -> 1% headroom
  assert.equal(admit(sess, [{ costs: { 'c:5h': 2 } }]).n, 0);                                   // 2% > 1% (session capped at 95%, not 100%)
});

test('admit: per-window costs charge each window its own cost, not one window\'s % against all', () => {
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
