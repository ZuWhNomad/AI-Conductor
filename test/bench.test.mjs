import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeJson } from '../core/paths.mjs';

const { loadConfig, saveConfig } = await import('../core/config.mjs');
const { BENCH_TASK_IDS, dueForBench, noteNewModels, getBenchState, enqueueBench, runBenchQueue } = await import('../core/bench.mjs');
const FILE = join(HOME, 'bench.json');
const reset = () => writeJson(FILE, { version: 1, seededAt: null, updatedAt: null, seen: [], aliases: {}, answers: {}, lanes: {} });
const reg = (models, providers = [...new Set(models.map((m) => m.provider))]) => ({ updatedAt: new Date().toISOString(), providers: Object.fromEntries(providers.map((p) => [p, { status: 'ok' }])), models });
const model = (provider, id, efforts = [], extra = {}) => ({ provider, id, efforts, kind: 'agent', cost: 'subscription', ...extra });
const attempt = (provider, modelId, effort, smokeId, verdict = 'pass') => ({ provider, model: modelId, effort, smokeId, verdict, ts: new Date().toISOString() });

test('coverage is per offered effort at 8/11; a probe is not a battery and effortless models accept historical tags', () => {
  const registry = reg([model('codex', 'covered', ['low', 'high']), model('grok', 'effortless')]);
  const runs = [{ attempts: [
    ...BENCH_TASK_IDS.slice(0, 8).map((id) => attempt('codex', 'covered', 'low', id)),
    ...BENCH_TASK_IDS.slice(0, 7).map((id) => attempt('codex', 'covered', 'high', id)),
    attempt('codex', 'probe-only', 'low', 'read-1'),
    ...BENCH_TASK_IDS.slice(0, 8).map((id) => attempt('grok', 'effortless', 'high', id)),
  ] }];
  const due = dueForBench({ days: Infinity, reg: registry, runs });
  assert.deepEqual(due.map((d) => `${d.provider}:${d.model}:${d.effort || 'default'}`), ['codex:covered:high']);
  assert.equal(due[0].covered, 7);

  const probeRegistry = reg([model('codex', 'probe-only', ['low'])]);
  assert.equal(dueForBench({ days: Infinity, reg: probeRegistry, runs })[0].covered, 1);
});

test('bench.json silently seeds once, absorbs list flaps, records answers, and detects new efforts once', () => {
  const previous = loadConfig().bench;
  try {
    reset(); saveConfig({ bench: { newModels: 'off' }, scorecard: { archived: [] } });
    const first = reg([model('codex', 'steady', ['low'])]);
    assert.deepEqual(noteNewModels(null, first), []);

    const expanded = reg([model('codex', 'steady', ['low', 'high'])]);
    assert.deepEqual(noteNewModels(first, expanded).map((s) => s.effort), ['high']);
    assert.equal(getBenchState().answers['codex:steady:high'].answer, 'no');
    assert.deepEqual(noteNewModels(expanded, first), []);
    assert.deepEqual(noteNewModels(first, expanded), [], 'a disappeared effort remains in the durable seen-set');

    const excluded = reg([
      ...expanded.models,
      model('ollama', 'local', [], { cost: 'free-local' }),
      model('qwen-code', 'qwen-new'),
      model('kimi', 'kimi-new'),
    ]);
    assert.deepEqual(noteNewModels(expanded, excluded), []);
    const disk = JSON.parse(readFileSync(FILE, 'utf8'));
    assert.ok(disk.seen.includes('ollama:local:default'), 'excluded listings are still remembered across flaps');
  } finally { saveConfig({ bench: previous }); }
});

test('alias moves are noticed once even when the new exact target was already seen', () => {
  reset();
  const first = reg([model('claude', 'old', ['low'], { aliasOf: ['default'] }), model('claude', 'new', ['low'])]);
  const moved = reg([model('claude', 'old', ['low']), model('claude', 'new', ['low'], { aliasOf: ['default'] })]);
  assert.deepEqual(noteNewModels(null, first), []);
  const fresh = noteNewModels(first, moved);
  assert.deepEqual(fresh.map((s) => `${s.model}:${s.effort}:${s.aliasMoved}`), ['new:low:true']);
  assert.deepEqual(noteNewModels(moved, moved), []);
});

test('auto mode queues new selections but never executes them during detection', () => {
  const previous = loadConfig().bench;
  try {
    reset(); saveConfig({ bench: { newModels: 'auto' }, scorecard: { archived: [] } });
    const first = reg([model('codex', 'old', ['low'])]);
    const next = reg([...first.models, model('codex', 'new', ['high', 'low']), model('deepseek', 'paid', ['low'], { cost: 'api' })]);
    noteNewModels(null, first);
    noteNewModels(first, next);
    const state = getBenchState();
    assert.deepEqual(state.lanes.codex.queue.map((q) => `${q.selection.model}:${q.selection.effort}`), ['new:low', 'new:high']);
    assert.equal(state.lanes.deepseek, undefined, 'pay-per-token providers still require an answer');
    assert.equal(state.answers['deepseek:paid:low'].answer, 'ask');
    assert.equal(state.lanes.codex.running, null);
  } finally { saveConfig({ bench: previous }); }
});

test('durable provider lanes run in parallel across providers, serially within one, and resume after a limit park', async () => {
  reset(); saveConfig({ scorecard: { archived: [] } });
  const registry = reg([model('codex', 'c', ['low']), model('grok', 'g')]);
  enqueueBench([{ provider: 'codex', model: 'c', effort: 'low' }, { provider: 'grok', model: 'g', effort: null }], { reg: registry, taskIds: ['a', 'b'], probe: false });
  assert.deepEqual(JSON.parse(readFileSync(FILE, 'utf8')).lanes.codex.queue[0].remaining, ['a', 'b']);

  let active = 0, maxActive = 0; const byProvider = new Map(), maxByProvider = new Map();
  const execute = async (selection, task) => {
    active++; maxActive = Math.max(maxActive, active);
    byProvider.set(selection.provider, (byProvider.get(selection.provider) || 0) + 1);
    maxByProvider.set(selection.provider, Math.max(maxByProvider.get(selection.provider) || 0, byProvider.get(selection.provider)));
    await new Promise((resolve) => setImmediate(resolve));
    active--; byProvider.set(selection.provider, byProvider.get(selection.provider) - 1);
    return { verdict: 'pass', task };
  };
  const drained = await runBenchQueue({ execute, tasks: () => [], blockedUntil: () => null, reg: registry });
  assert.equal(drained.results.length, 4);
  assert.equal(maxActive, 2);
  assert.deepEqual(Object.fromEntries(maxByProvider), { codex: 1, grok: 1 });
  assert.ok(Object.values(getBenchState().lanes).every((lane) => lane.queue.length === 0));

  enqueueBench([{ provider: 'codex', model: 'c', effort: 'low' }], { reg: registry, taskIds: ['a'], probe: false });
  const resetAt = Date.now() + 60_000; let calls = 0;
  await runBenchQueue({ execute: async () => { calls++; return { verdict: 'pass' }; }, tasks: () => [], blockedUntil: () => resetAt, now: () => resetAt - 1, reg: registry });
  assert.equal(calls, 0);
  assert.equal(getBenchState().lanes.codex.parkedUntil, resetAt);
  const resumed = await runBenchQueue({ execute: async () => { calls++; return { verdict: 'pass' }; }, tasks: () => [], blockedUntil: () => null, now: () => resetAt + 1, reg: registry });
  assert.equal(calls, 1);
  assert.equal(resumed.state.lanes.codex.queue.length, 0);
});

test('queued archived, local, qwen-code and kimi selections are refused, and live work yields every lane', async () => {
  reset();
  saveConfig({ scorecard: { archived: ['codex:old'] } });
  const registry = reg([
    model('codex', 'old', ['low']), model('codex', 'new', ['low']),
    model('ollama', 'local', [], { cost: 'free-local' }), model('qwen-code', 'q'), model('kimi', 'k'),
  ]);
  enqueueBench(registry.models.map((m) => ({ provider: m.provider, model: m.id, effort: m.efforts[0] || null })), { reg: registry, taskIds: ['a'], probe: false });
  assert.deepEqual(Object.values(getBenchState().lanes).flatMap((lane) => lane.queue.map((q) => q.selection.model)), ['new']);
  let calls = 0;
  await runBenchQueue({ execute: async () => { calls++; return { verdict: 'pass' }; }, tasks: () => [{ source: 'live', status: 'queued', provider: 'grok' }], blockedUntil: () => null, reg: registry });
  assert.equal(calls, 0);
  assert.equal(getBenchState().lanes.codex.queue.length, 1);
  saveConfig({ scorecard: { archived: [] } });
});
