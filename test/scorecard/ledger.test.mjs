import { HOME } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sc, pr, loadConfig, saveConfig, DEFAULTS, getModels,
  registryModels, USAGE, run, seed,
  join, appendNdjson, statePath, writeJson,
} from './_helpers.mjs';

test('envFailure identifies provider and CLI environment failures without scanning report prose', () => {
  for (const error of [
    'HTTP status 503 from provider', '503 UNAVAILABLE', 'unknown option --effort',
    'unexpected argument --effort', 'requires --effort', "invalid value for '--effort'", 'WinError 32: file locked',
    'EBUSY: resource busy or locked', 'CUDA out of memory', 'CUDA error: driver', 'llama-server crashed',
    'cudaMalloc failed', 'provider quota rejected task at startup',
    'Selected model is at capacity', 'model is at capacity',
  ]) assert.ok(sc.envFailure({ error }), error);
  assert.ok(sc.envFailure({ error: 'worker failed', result: { items: [{ output: '503 UNAVAILABLE' }] } }));
  assert.ok(sc.envFailure({ error: 'worker failed', result: { items: [{ output: 'Selected model is at capacity' }] } }));
  assert.equal(sc.envFailure({ result: { finalMessage: 'This report discusses HTTP 503 handling in prose.' } }), null);
  assert.ok(sc.envFailure({ error: '{"status": "UNAVAILABLE"}' }));
  assert.equal(sc.envFailure({ error: 'worker failed', result: { items: [{ output: 'feature unavailable in this build' }] } }), null);
  for (const error of [
    'max iterations reached', 'UnauthorizedAccessException', 'access was denied', 'permission denied', 'EACCES', 'EPERM',
    'waiting for network', 'Connection failed', 'ECONNRESET', 'ENOTFOUND api.example', 'fetch failed',
    'unexpected status 401', 'Incorrect API key provided', 'refresh token was already used',
  ]) assert.ok(sc.envFailure({ error }), error);
});

test('HTTP 502 and 504 gateway responses are provider environment failures', () => {
  for (const error of ['502 Bad Gateway', 'HTTP 504 Gateway Timeout']) assert.ok(sc.envFailure({ error }), error);
});

test('CLI flag rejection is environmental only for the worker CLI error, not workspace command output', () => {
  for (const output of ["error: unknown option '--flag'", "error: unexpected argument 'bar'"]) {
    assert.ok(sc.envFailure({ error: output }), `worker CLI error: ${output}`);
    assert.equal(sc.envFailure({ error: 'worker failed', result: { items: [{ output }] } }), null, `workspace output: ${output}`);
  }
});

test('reliabilityMetrics follows the recorded transcript shape of every worker kind', () => {
  assert.deepEqual(sc.reliabilityMetrics({ result: { turns: 2, timedOut: false, items: [
    { type: 'command_execution', command: 'npm test', exitCode: 1 },
    { type: 'command_execution', command: 'npm test', exitCode: 2 },
    { type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', args: { id: 1 }, error: 'bad gateway' },
  ] } }), { turns: 2, toolCalls: 3, toolErrors: 3, thrash: 1, timedOut: false });
  assert.deepEqual(sc.reliabilityMetrics({ result: { ok: true, turns: 2, items: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] } }), { turns: 2, toolCalls: 1, toolErrors: null, thrash: null, timedOut: false });
  assert.deepEqual(sc.reliabilityMetrics({ result: { turns: 2, items: [
    { type: 'tool_use', name: 'read', input: { path: 'a' }, output: 'error: missing' },
    { type: 'tool_use', name: 'read', input: { path: 'a' }, output: 'error: missing' },
  ] } }), { turns: 2, toolCalls: 2, toolErrors: 2, thrash: 1, timedOut: null });
  assert.deepEqual(sc.reliabilityMetrics({ result: { ok: true, turns: 1, items: [{ type: 'tool_use', id: 'v1', name: 'search', input: { q: 'x' } }] } }), { turns: 1, toolCalls: 1, toolErrors: null, thrash: null, timedOut: false });
  assert.deepEqual(sc.reliabilityMetrics({ result: { items: [{ type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', args: {}, result: { status: 'error' } }] } }), { turns: null, toolCalls: 1, toolErrors: 1, thrash: 0, timedOut: null });
  assert.deepEqual(sc.reliabilityMetrics({ result: { items: [{ type: 'mcp_tool_call', server: 'fixture', tool: 'lookup', args: {}, result: '{"status":400}' }] } }), { turns: null, toolCalls: 1, toolErrors: 1, thrash: 0, timedOut: null });
  assert.deepEqual(sc.reliabilityMetrics({ status: 'canceled', result: { turns: 0, items: [], timedOut: true } }), { turns: 0, toolCalls: 0, toolErrors: 0, thrash: 0, timedOut: true });
  assert.deepEqual(sc.reliabilityMetrics({ result: { toolCalls: 2, items: [{ type: 'tool_use', name: 'read', input: {}, output: 'error: one' }] } }), { turns: null, toolCalls: 2, toolErrors: null, thrash: null, timedOut: null });
});

test('priors: price and tier lookup, config override, shadow dollars', () => {
  assert.equal(pr.priorFor('codex', 'gpt-5.6-luna').tier, 'B');
  assert.equal(pr.priorFor('codex', 'gpt-5.6-luna', 'implement').tier, 'B');   // code: Terminal-Bench 84.7
  assert.equal(pr.priorFor('codex', 'gpt-5.6-luna', 'summarize').tier, 'D');   // read: MRCR 41%
  assert.equal(pr.priorFor('grok', 'grok-4.6', 'review').tier, 'B');           // reason: GDPval 1730
  assert.equal(pr.priorFor('grok', 'grok-4.6', 'debug').tier, 'D');
  assert.equal(pr.priorFor('claude', 'claude-fable-5-1[1m]').tier, 'A');
  assert.equal(pr.priorFor('antigravity', 'gemini-3.8-flash-low').tier, 'A');
  assert.equal(pr.priorFor('deepseek', 'deepseek-chat:latest').price.in, 0.3);
  assert.equal(pr.priorFor('codex', 'gpt-5.3-codex-spark').price, null);
  assert.equal(pr.priorFor('nope', 'x'), null);
  assert.deepEqual(pr.priceFor('codex', 'gpt-5.6-luna'), { in: 0.2, out: 1.2, cached: 0.02 });
  // Official list prices checked 2026-09-24 (OpenAI and xAI pricing pages); build-fast must not fall to the 4.7 row.
  assert.deepEqual(pr.priceFor('codex', 'gpt-6-sol', {}), { in: 2, out: 10, cached: 0.2 });
  assert.deepEqual(pr.priceFor('codex', 'gpt-6.1-sol', {}), { in: 2, out: 10, cached: 0.2 });
  assert.deepEqual(pr.priceFor('codex', 'gpt-6-luna', {}), { in: 0.1, out: 0.5, cached: 0.01 });
  assert.deepEqual(pr.priceFor('grok', 'grok-4.7-build-fast', {}), { in: 4, out: 12, cached: 1 });
  assert.deepEqual(pr.priceFor('grok', 'grok-4.7', {}), { in: 2, out: 6, cached: 0.5 });
  assert.deepEqual(pr.priceFor('grok', 'grok-4.5', {}), { in: 2, out: 6, cached: 0.3 });
  assert.deepEqual(pr.priceFor('claude', 'claude-opus-5-5', {}), { in: 4, out: 20, cached: 0.2 });
  assert.deepEqual(pr.priceFor('claude', 'claude-opus-5-5[1m]', {}), { in: 4, out: 20, cached: 0.2 });
  assert.deepEqual(pr.priceFor('claude', 'claude-opus-5', {}), { in: 5, out: 25, cached: 0.5 });
  assert.equal(pr.priceFor('antigravity', 'gpt-oss-120b', {}), null);
  assert.equal(pr.priorFor('codex', 'gpt-6-sol').tier, null);                    // price only; its tier comes from measurement
  assert.deepEqual(pr.priceFor('codex', 'gpt-5.3-codex-spark', { scorecard: { prices: { 'codex:gpt-5.3-codex-spark': { in: 1, out: 2 } } } }), { in: 1, out: 2, cached: 0.1 });
  assert.deepEqual(pr.priceFor('codex', 'gpt-5.3-codex-spark', { scorecard: { prices: { 'codex:gpt-5.3-codex-spark': { in: 1, out: 2, write: 3 } } } }), { in: 1, out: 2, cached: 0.1, write: 3 });
  assert.deepEqual(pr.priceFor('codex', 'gpt-5.3-codex-spark', { scorecard: { prices: { 'codex:gpt-5.3-codex-spark': { in: 1, out: 2, write: 'nope' } } } }), { in: 1, out: 2, cached: 0.1 });
  assert.deepEqual(pr.priceFor('deepseek', 'deepseek-flash', { scorecard: { prices: { 'deepseek:deepseek-flash': { in: 2, out: 4, cached: 0.2, write: 8 } } } }, new Date('2026-09-09T12:00:00Z')), { in: 1, out: 2, cached: 0.1, write: 4 });
  // 50k uncached @0.2 + 50k cached @0.02 + 10k out @1.2 = 0.01 + 0.001 + 0.012
  assert.ok(Math.abs(pr.usdFor({ in: 50_000, cached: 50_000, out: 10_000 }, { in: 0.2, out: 1.2, cached: 0.02 }) - 0.023) < 1e-9);
  assert.equal(pr.usdFor({ in: 1 }, null), null);
});

test('usage shapes normalize to uncached in / out / cached', () => {
  assert.deepEqual(sc.normalizeUsage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 }), { in: 60, out: 20, cached: 40, write: 0, v: 2 });
  assert.deepEqual(sc.normalizeUsage({ 'claude-x': { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7 }, 'claude-y': { inputTokens: 1, outputTokens: 1 } }), { in: 6, out: 7, cached: 7, write: 0, v: 2 });
  assert.equal(sc.normalizeUsage(null), null);
  assert.equal(sc.normalizeUsage({}), null);
});

test('window delta ignores rolled-over windows and clamps at zero', () => {
  const before = [{ id: 'a', usedPercent: 10, resetsAt: 1 }, { id: 'b', usedPercent: 50, resetsAt: 1 }, { id: 'c', usedPercent: 5, resetsAt: 1 }];
  const after = [{ id: 'a', usedPercent: 13, resetsAt: 1 }, { id: 'b', usedPercent: 2, resetsAt: 2 }, { id: 'c', usedPercent: 4, resetsAt: 1 }];
  assert.deepEqual(sc.windowDelta(before, after), { a: 3, c: 0 });
  assert.equal(sc.windowDelta([], after), null);
  assert.equal(sc.windowDelta(before, [{ id: 'z', usedPercent: 1 }]), null);
});

test('voidTask publishes the same score event as rateTask', async () => {
  const { bus } = await import('../../core/bus.ts');
  const seen = [];
  const on = (e) => { if (e.type === 'score' && e.taskId === 'void-pub') seen.push({ type: e.type, taskId: e.taskId, verdict: e.verdict }); };
  bus.on('event', on);
  try { sc.voidTask('void-pub', 'sandbox denied the workspace'); }
  finally { bus.off('event', on); }
  assert.deepEqual(seen, [{ type: 'score', taskId: 'void-pub', verdict: 'void' }]);
});

test('scorecard config is normalized', () => {
  const cfg = loadConfig();
  assert.equal(cfg.scorecard.minSamples, DEFAULTS.scorecard.minSamples);
  assert.equal(cfg.scorecard.benchMinSamples, 3);
  assert.equal(cfg.scorecard.shippedBatteries, true);
  assert.equal(cfg.scorecard.quality, 0.75);
  assert.equal(cfg.scorecard.qualityValueUsd, 5);
  assert.equal(cfg.scorecard.hourlyUsd, 0);
  const bad = saveConfig({ scorecard: { quality: 5, minSamples: -1, qualityValueUsd: 'x', hourlyUsd: -3, prices: 'x', usePriors: 'yes' }, smoke: { timeoutMinutes: 0 } });
  assert.equal(bad.scorecard.quality, 0.75);
  assert.equal(bad.scorecard.minSamples, DEFAULTS.scorecard.minSamples);
  assert.equal(bad.scorecard.benchMinSamples, 3);
  assert.equal(bad.scorecard.qualityValueUsd, 5);
  assert.equal(bad.scorecard.hourlyUsd, 0);
  assert.deepEqual(bad.scorecard.prices, {});
  assert.equal(bad.scorecard.coldStart, 'priors');
  assert.equal(bad.scorecard.usePriors, undefined);
  assert.equal(bad.smoke.timeoutMinutes, 20);
  saveConfig({ scorecard: { usePriors: false } });
});

test('bench: lists models with no battery or a stale one', async () => {
  const { BENCH_TASK_IDS, dueForBench, formatBench } = await import('../../core/bench.mjs');
  const reg = { updatedAt: 'x', providers: { codex: { status: 'ok' }, deepseek: { status: 'ok' }, grok: { status: 'unavailable' } }, models: [
    { provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent', efforts: ['low', 'high'] },
    { provider: 'codex', id: 'brand-new', kind: 'agent', efforts: ['low'] },
    { provider: 'deepseek', id: 'deepseek-chat', kind: 'agent', cost: 'api', efforts: [] },
    { provider: 'grok', id: 'grok-4.7', kind: 'agent', efforts: [] },
  ] };
  const attempt = (effort, smokeId, i) => ({ provider: 'codex', model: 'gpt-5.6-luna', effort, smokeId, verdict: 'pass', ts: new Date(Date.now() - i).toISOString() });
  const runs = [{ attempts: BENCH_TASK_IDS.slice(0, 8).map((id, i) => attempt('low', id, i)).concat(BENCH_TASK_IDS.slice(0, 7).map((id, i) => attempt('high', id, i))) }];
  const due = dueForBench({ days: 21, reg, runs });
  assert.deepEqual(due.map((d) => `${d.provider}:${d.model}:${d.effort}`), ['codex:brand-new:low', 'codex:gpt-5.6-luna:high', 'deepseek:deepseek-chat:null']);
  assert.match(formatBench(due), /3 selection\(s\) due/);
  assert.equal(dueForBench({ days: -1, reg, runs }).length, 4); // the covered low effort becomes stale
});

test('modeling: only a recorded pass is routable, at the effort that passed', async () => {
  const p = await import('../../core/priors.mjs');
  assert.equal(p.priorFor('codex', 'gpt-6-astra', 'modeling').tier, 'A');
  assert.equal(p.priorFor('codex', 'gpt-6-astra', 'modeling').effort, 'ultra');
  assert.equal(p.priorFor('claude', 'opus-5', 'modeling').tier, null);      // "close" is not routable
  assert.equal(p.priorFor('codex', 'gpt-5.6-sol', 'modeling').tier, 'A');   // passed with the recipe (2026-09-12)
  assert.equal(p.priorFor('codex', 'gpt-5.6-luna', 'modeling').tier, null); // fail
  assert.equal(p.priorFor('kimi', 'kimi-k3', 'modeling').tier, null);       // never benchmarked: no code prior leaks in
  assert.equal(p.priorFor('codex', 'gpt-6-sol', 'modeling').tier, null);    // a newer gpt-6 model does not inherit Astra's verdict
  // Drafting has its own verdicts (good / weak / unusable recorded as pass / close / fail), not modeling's.
  assert.deepEqual([p.priorFor('codex', 'gpt-6-astra', 'drafting').tier, p.priorFor('codex', 'gpt-6-astra', 'drafting').effort], ['A', 'xhigh']);
  for (const [provider, model] of [['claude', 'claude-fable-5-1[1m]'], ['codex', 'gpt-5.6-sol'], ['grok', 'grok-4.7'], ['grok', 'grok-4.6'], ['claude', 'opus-5']]) {
    assert.equal(p.priorFor(provider, model, 'drafting').tier, null, `${provider}:${model} has no drafting pass`);
  }
});

test('phantom detection helpers', () => {
  assert.deepEqual(sc.claimedWrites([{ type: 'file_change', changes: [{ path: 'a.js' }, { path: 'b.js' }] }, { type: 'message' }, { type: 'file_change', changes: [{ path: '' }, { nopath: 1 }] }]), ['a.js', 'b.js']);
  assert.deepEqual(sc.claimedWrites(undefined), []);
  assert.equal(sc.isPhantomCompletion({ ok: true, claimed: ['a'], canVerify: true, observedCount: 0 }), true);
  assert.equal(sc.isPhantomCompletion({ ok: false, claimed: ['a'], canVerify: true, observedCount: 0 }), false);
  assert.equal(sc.isPhantomCompletion({ ok: true, claimed: ['a'], canVerify: false, observedCount: 0 }), false);
  assert.equal(sc.isPhantomCompletion({ ok: true, claimed: ['a'], canVerify: true, observedCount: 1 }), false);
  assert.equal(sc.isPhantomCompletion({ ok: true, claimed: [], canVerify: true, observedCount: 0 }), false);
});

test('ui is a first-class category and classifyCategory tags UI/frontend work', () => {
  assert.ok(sc.CATEGORIES.includes('ui'));
  assert.equal(pr.KIND.ui, 'code');                                  // ui rides the code priors for cold-start defaults
  assert.equal(pr.priorFor('codex', 'gpt-6-astra', 'ui').tier, 'A'); // sensible default via the code kind
  for (const s of ['fix the CSS layout of the sidebar', 'the modal button style is broken', 'update styles.css', 'React component re-renders', 'make the panel responsive']) assert.equal(sc.classifyCategory(s), 'ui', s);
  for (const s of ['refactor the scheduler', 'add a retry to the API client', 'summarize the docs', '']) assert.equal(sc.classifyCategory(s), null, s);
});

test('research, writing and video extraction are first-class categories with matching prior kinds', () => {
  for (const category of ['research', 'writing', 'video-extraction']) assert.ok(sc.CATEGORIES.includes(category));
  assert.equal(pr.KIND.research, 'read');
  assert.equal(pr.KIND.writing, 'reason');
  assert.equal(pr.KIND['video-extraction'], 'read');
});

test('R2B6: voids invalidate cached admission costs and are filtered on stat fallback', async (t) => {
  const { measuredCostByWindow, admit } = await import('../../core/sweep.mjs');
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const provider = 'r2b6-fixture';
  for (const [taskId, delta] of [['R2B6-valid', 3], ['R2B6-void', 90]]) {
    appendNdjson(statePath('scorecard.ndjson'), { op: 'run', taskId, provider, pct: { weekly: delta } });
  }
  const windows = [{ id: 'weekly', label: 'weekly', usedPercent: 60 }]; // headroom 40: average 46.5 does not fit; the remaining 3 does
  const cost = () => measuredCostByWindow(sc.runRows(), provider);
  assert.deepEqual(cost(), { weekly: 46.5 });
  const cached = sc.runRows();
  assert.equal(sc.runRows(), cached, 'unchanged ledger uses the cache');
  assert.equal(admit(windows, [{ costs: cost() }]).n, 0);
  sc.voidTask('R2B6-void', 'invalid measurement');
  assert.notEqual(sc.runRows(), cached, 'void append invalidates cached rows');
  assert.deepEqual(cost(), { weekly: 3 });
  assert.equal(admit(windows, [{ costs: cost() }]).n, 1);
  const stat = fs.statSync;
  let fallbacks = 0;
  const mock = t.mock.method(fs, 'statSync', (file, ...args) => {
    if (file === statePath('scorecard.ndjson')) { fallbacks++; throw new Error('fixture stat failure'); }
    return stat(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(cost(), { weekly: 3 });
    assert.equal(fallbacks, 1, 'readable ledger takes the stat-failure fallback');
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('B11: claude opus/default aliases are anchored so 4.x ids use the 4.x rules', () => {
  assert.equal(pr.priorFor('claude', 'opus').tier, 'A');
  assert.equal(pr.priorFor('claude', 'default').tier, 'A');
  assert.equal(pr.priorFor('claude', 'claude-opus-5').tier, 'A');
  assert.equal(pr.priorFor('claude', 'opus-5').tier, 'A');
  assert.equal(pr.priorFor('claude', 'opus-4-6').tier, 'B');
  assert.equal(pr.priorFor('claude', 'opus-4-5').tier, 'C');
});

test('L13: cache-write tokens are counted and priced at write ?? in*1.25', () => {
  assert.deepEqual(sc.normalizeUsage({ inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }), { in: 10, out: 2, cached: 3, write: 4, v: 2 });
  assert.deepEqual(sc.normalizeUsage({ input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 }), { in: 100, out: 5, cached: 0, write: 20, v: 2 });
  assert.ok(Math.abs(pr.usdFor({ in: 1e6, write: 1e6 }, { in: 1, out: 0, cached: 0 }) - 2.25) < 1e-9);
  assert.ok(Math.abs(pr.usdFor({ in: 1e6, write: 1e6 }, { in: 1, out: 0, cached: 0, write: 2 }) - 3) < 1e-9);
});

test('P16: migrateScorecard reads the ledger cache via allRows', async (t) => {
  const fs = (await import('node:fs')).default;
  const paths = await import('../../core/paths.ts');
  const { syncBuiltinESMExports } = await import('node:module');
  sc.runRows();
  const orig = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === paths.statePath('scorecard.ndjson')) throw new Error('P16: cache miss re-read');
    return orig.call(fs, file, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => paths.readNdjson(paths.statePath('scorecard.ndjson')), /P16: cache miss re-read/);
    assert.doesNotThrow(() => sc.migrateScorecard());
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('I11: dead conductor-facing priors text is gone; results still route', () => {
  assert.equal(pr.MODELING.best, undefined);
  assert.equal(pr.MODELING.caveat, undefined);
  assert.equal(pr.DRAFTING.caveat, undefined);
  assert.equal(pr.priorFor('codex', 'gpt-6-astra', 'modeling').tier, 'A');
  assert.equal(pr.priorFor('codex', 'gpt-6-astra').note, null);
});

test('D1: visual close is not a modest tier; Sol modeling is a pass', () => {
  assert.equal(pr.priorFor('claude', 'opus', 'modeling').tier, null);
  assert.equal(pr.priorFor('codex', 'gpt-5.6-sol', 'modeling').tier, 'A');
});

test('B10: shipped priors use category then kind then default, with exact config overrides', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { priors: { 'codex:gpt-5.6-luna': { category: { summarize: 'A' }, kind: { read: 'C' }, default: 'D' } } } });
    assert.deepEqual([
      pr.priorFor('codex', 'gpt-5.6-luna', 'summarize').tier,
      pr.priorFor('codex', 'gpt-5.6-luna', 'docs').tier,
      pr.priorFor('codex', 'gpt-5.6-luna', 'implement').tier,
    ], ['A', 'C', 'D']);
  } finally { saveConfig({ scorecard: cfg }); }
});
