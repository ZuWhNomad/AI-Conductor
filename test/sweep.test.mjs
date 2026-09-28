import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const { measuredCostByWindow, ownPct, targetFor, admit } = await import('../core/sweep.mjs');
const lim = await import('../core/limits.mjs');

test('measuredCostByWindow averages per-task deltas per window, honouring model-group windows and concurrency', () => {
  lim.getLimits().providers.antigravity = { provider: 'antigravity', windows: [{ id: 'antigravity:gemini-5h', usedPercent: 10, models: '^(gemini)' }, { id: 'antigravity:3p-5h', usedPercent: 50, models: '^(claude|gpt)' }] };
  const rows = [
    { provider: 'antigravity', model: 'gemini-3.8-flash-low', pct: { 'antigravity:gemini-5h': 0.4, 'antigravity:3p-5h': 0.2 } }, // 3p-5h moved for someone else: not this model's window
    { provider: 'antigravity', model: 'claude-sonnet-4-6', pct: { 'antigravity:gemini-5h': 0, 'antigravity:3p-5h': 3.1 } },
    { provider: 'codex', model: 'gpt-5.6-luna', pct: { 'codex:primary': 1 } },
    { provider: 'codex', model: 'gpt-5.6-sol', pct: { 'codex:primary': 3 }, concurrent: 5 }, // 3% moved while 6 tasks ran: 0.5% each
  ];
  assert.deepEqual(measuredCostByWindow(rows, 'antigravity', { model: 'gemini-3.8-flash-low' }), { 'antigravity:gemini-5h': 0.4 });
  assert.deepEqual(measuredCostByWindow(rows, 'antigravity', { model: 'claude-sonnet-4-6' }), { 'antigravity:3p-5h': 3.1 });
  assert.deepEqual(measuredCostByWindow(rows, 'codex'), { 'codex:primary': 0.75 }); // (1 + 0.5) / 2
  assert.deepEqual(measuredCostByWindow(rows, 'codex', { model: 'gpt-5.6-sol' }), { 'codex:primary': 0.5 });
  assert.deepEqual(measuredCostByWindow(rows, 'grok'), {});
  delete lim.getLimits().providers.antigravity;
});

test('measuredCostByWindow charges a Fable-labelled window only for Fable runs', () => {
  lim.getLimits().providers.claude = { provider: 'claude', windows: [
    { id: 'claude:5h', label: '5-hour', usedPercent: 10 },
    { id: 'claude:wf', label: 'weekly Fable', usedPercent: 40 },
  ] };
  try {
    const rows = [
      { provider: 'claude', model: 'claude-opus-4-8', pct: { 'claude:5h': 2, 'claude:wf': 9 } },
      { provider: 'claude', model: 'claude-fable-5-1', pct: { 'claude:5h': 4, 'claude:wf': 6 } },
    ];
    assert.deepEqual(measuredCostByWindow(rows, 'claude', { model: 'claude-opus-4-8' }), { 'claude:5h': 2 });
    assert.deepEqual(measuredCostByWindow(rows, 'claude', { model: 'claude-fable-5-1' }), { 'claude:5h': 4, 'claude:wf': 6 });
    assert.deepEqual(measuredCostByWindow(rows, 'claude'), { 'claude:5h': 3, 'claude:wf': 6 });
  } finally { delete lim.getLimits().providers.claude; }
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

test('measuredCostByWindow: an outlier among the last 30 rows does not dominate', () => {
  const rows = [
    ...Array.from({ length: 29 }, () => ({ provider: 'codex', model: 'm', pct: { w: 3 } })),
    { provider: 'codex', model: 'm', pct: { w: 63 } },
  ];
  assert.deepEqual(measuredCostByWindow(rows, 'codex'), { w: 5 }); // (29 * 3 + 63) / 30
});

test('ownPct keeps shared and vanished windows but drops another model group', () => {
  const id = 'own-pct';
  lim.getLimits().providers[id] = { provider: id, windows: [
    { id: 'shared' }, { id: 'gemini', models: 'gemini' }, { id: 'third-party', models: 'claude|gpt' },
  ] };
  try {
    assert.deepEqual(ownPct({ provider: id, model: 'gemini-pro', pct: { shared: 1, gemini: 2, 'third-party': 90, vanished: 3 } }), { shared: 1, gemini: 2, vanished: 3 });
  } finally { delete lim.getLimits().providers[id]; }
});

test('measuredCostByWindow fits a model/window rate from solo runs and applies cell expected tokens', () => {
  const id = 'fitted-window-cost', model = 'model-a';
  lim.getLimits().providers[id] = { provider: id, windows: [{ id: 'weekly', models: 'model-a' }, { id: 'other', models: 'model-b' }] };
  const row = (taskId, tokens, pct, concurrent, category = 'edit') => ({
    taskId, provider: id, model, effort: 'high', category, difficulty: 3,
    tokens: { in: tokens, out: 0, cached: 0, v: 2 }, pct: { weekly: pct, other: 99 }, concurrentByWindow: { weekly: concurrent, other: 0 },
  });
  const rows = [
    row('solo-1', 100, 1, 0),
    row('solo-2', 200, 4, 0),
    row('overlap', 300, 100, 1),
    { ...row('token-only', 400, 0, 0), pct: null },
    row('different-cell', 1000, 10, 1, 'debug'),
  ];
  try {
    assert.deepEqual(measuredCostByWindow(rows, id, { model, effort: 'high', category: 'edit', difficulty: 3 }), { weekly: 4.5 });
    assert.deepEqual(measuredCostByWindow([row('overlap-only', 300, 100, 1)], id, { model, effort: 'high', category: 'edit', difficulty: 3 }), { weekly: 50 }, 'without a solo rate, keep the concurrency-adjusted last-30 average');
  } finally { delete lim.getLimits().providers[id]; }
});

test('measuredCostByWindow averages only the last 30 matching values per window', () => {
  const rows = [
    { provider: 'codex', pct: { stale: 9, w: 100 } },
    ...Array.from({ length: 30 }, () => ({ provider: 'codex', pct: { w: 2 } })),
  ];
  assert.deepEqual(measuredCostByWindow(rows, 'codex'), { stale: 9, w: 2 });
});


test('per-window targets: session windows to 95%, weekly and budgets to 100%', () => {
  assert.equal(targetFor({ id: 'claude:5h', label: '5-hour' }), 95);
  assert.equal(targetFor({ id: 'claude:w', label: 'weekly' }), 100);
});

test('admit: gates dispatch on per-window headroom under targets', () => {
  const tw = Date.now() + 5 * 86400e3;
  const c = (n) => ({ costs: { 'codex:w': n } });
  const codex91 = [{ id: 'codex:w', label: 'Codex weekly', usedPercent: 91, resetsAt: tw, windowMinutes: 10080 }]; // weekly target 100 -> 9% headroom
  assert.equal(admit(codex91, [c(3), c(3), c(3), c(3)]).n, 3);                                  // 3+3+3=9 fits, 4th does not
  assert.equal(admit(codex91, [c(3)], { runningByWindow: { 'codex:w': 8 } }).n, 0);             // 8% already in flight: only 1% free
  const full = [{ id: 'codex:w', label: 'Codex weekly', usedPercent: 100, resetsAt: tw }];
  assert.equal(admit(full, [c(1)]).n, 0);                                                       // tapped out
  assert.equal(admit([], [c(5)]).n, 1);                                                         // no windows reported (grok/deepseek): not gated
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

test('P1: sweep reads window targets once per admission and compiles each model pattern once per measurement', async (ctx) => {
  globalThis.__w1ConfigReads = 0;
  const configUrl = 'w1-config:sweep';
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './config.mjs' && context.parentURL?.endsWith('?p1-config')) return { url: configUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === configUrl) return { format: 'module', shortCircuit: true, source: 'export function loadConfig() { globalThis.__w1ConfigReads++; return { scorecard: { windowTargets: { session: 95, other: 100 } } }; }' };
      return nextLoad(url, context);
    },
  });
  try {
    const sweep = await import('../core/sweep.mjs?p1-config');
    const windows = [{ id: 'session', label: 'session', usedPercent: 96, resetsAt: 100 }, { id: 'weekly', label: 'weekly', usedPercent: 100, resetsAt: 200 }];
    assert.equal(sweep.admit(windows, [{ costs: { session: 1, weekly: 1 } }]).n, 0);
    assert.equal(globalThis.__w1ConfigReads, 1);
    lim.getLimits().providers['w1-pattern'] = { windows: [{ id: 'w', models: '^model' }] };
    const NativeRegExp = RegExp, compiled = [];
    ctx.mock.method(globalThis, 'RegExp', new Proxy(NativeRegExp, { construct(target, args) { compiled.push(args); return new target(...args); } }));
    assert.deepEqual(sweep.measuredCostByWindow([
      { provider: 'w1-pattern', model: 'model', pct: { w: 2 } },
      { provider: 'w1-pattern', model: 'model', pct: { w: 3 } },
    ], 'w1-pattern'), { w: 2.5 });
    assert.deepEqual(compiled, [['^model', 'i']]);
  } finally { hooks.deregister(); delete globalThis.__w1ConfigReads; delete lim.getLimits().providers['w1-pattern']; }
});

test('P2: admission excludes rate and unknown-percentage windows without weakening budget windows', () => {
  const ignored = [{ id: 'rate', rate: true, usedPercent: 100, resetsAt: 1 }, { id: 'unknown', usedPercent: null }];
  assert.equal(admit(ignored, [{ costs: {} }, { costs: {} }]).n, 2);
  const windows = [...ignored, { id: 'budget', usedPercent: 90 }];
  assert.equal(admit(windows, [{ costs: { budget: 5 } }, { costs: { budget: 5 } }]).n, 2);
  assert.equal(admit(windows, [{ costs: { budget: 11 } }]).n, 0);
});
