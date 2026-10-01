import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeJson } from '../core/paths.mjs';

const { loadConfig, saveConfig } = await import('../core/config.mjs');
const { BENCH_TASK_IDS, dueForBench, noteNewModels, getBenchState, enqueueBench, runBenchQueue, isOffPeak, nextOffPeakStart, nextBenchWakeAt, formatBench } = await import('../core/bench.mjs');
const FILE = join(HOME, 'bench.json');
const reset = () => writeJson(FILE, { version: 1, seededAt: null, updatedAt: null, seen: [], aliases: {}, lanes: {} });
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

test('bench repeats a task sequentially without making completed repeats due again', async () => {
  reset();
  const registry = reg([model('codex', 'repeatable', ['low'])]);
  enqueueBench([{ provider: 'codex', model: 'repeatable', effort: 'low' }], { reg: registry, taskIds: ['a'], probe: false, repeats: 3 });
  const seen = [];
  const drained = await runBenchQueue({
    execute: async (_selection, task, meta) => { seen.push({ task, repeat: meta.repeat, repeats: meta.repeats }); return { verdict: 'pass' }; },
    tasks: () => [], blockedUntil: () => null, reg: registry,
  });
  assert.equal(drained.results.length, 3);
  assert.deepEqual(seen, [
    { task: 'a', repeat: 1, repeats: 3 }, { task: 'a', repeat: 2, repeats: 3 }, { task: 'a', repeat: 3, repeats: 3 },
  ]);
  assert.equal(getBenchState().lanes.codex.queue.length, 0);

  const repeatedRuns = [{ attempts: [
    ...BENCH_TASK_IDS.map((id) => attempt('codex', 'repeatable', 'low', id)),
    ...BENCH_TASK_IDS.map((id) => attempt('codex', 'repeatable', 'low', id)),
  ] }];
  assert.deepEqual(dueForBench({ days: Infinity, reg: registry, runs: repeatedRuns }), []);
});

test('bench.json silently seeds once, absorbs list flaps, and detects new efforts once', () => {
  const previous = loadConfig().bench;
  try {
    reset(); saveConfig({ bench: { newModels: 'off' }, scorecard: { archived: [] } });
    const first = reg([model('codex', 'steady', ['low'])]);
    assert.deepEqual(noteNewModels(null, first), []);

    const expanded = reg([model('codex', 'steady', ['low', 'high'])]);
    assert.deepEqual(noteNewModels(first, expanded).map((s) => s.effort), ['high']);
    assert.equal('answers' in getBenchState(), false);
    assert.deepEqual(noteNewModels(expanded, first), []);
    assert.deepEqual(noteNewModels(first, expanded), [], 'a disappeared effort remains in the durable seen-set');
    const unchanged = readFileSync(FILE, 'utf8');
    assert.deepEqual(noteNewModels(expanded, expanded), []);
    assert.equal(readFileSync(FILE, 'utf8'), unchanged, 'unchanged models and aliases do not rewrite bench.json');

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

test('auto mode queues eligible selections but never executes them during detection', () => {
  const previous = loadConfig().bench;
  try {
    reset(); saveConfig({ bench: { newModels: 'auto' }, scorecard: { archived: [] } });
    const first = reg([model('codex', 'old', ['low'])]);
    const next = reg([...first.models, model('codex', 'new', ['high', 'low']), model('deepseek', 'paid', ['low'], { cost: 'api' })]);
    noteNewModels(null, first);
    noteNewModels(first, next);
    const state = getBenchState();
    assert.deepEqual(state.lanes.codex.queue.map((q) => `${q.selection.model}:${q.selection.effort}`), ['new:low', 'new:high']);
    assert.equal(state.lanes.deepseek, undefined, 'pay-per-token providers are not auto-benched');
    assert.equal('answers' in state, false);
    assert.equal(state.lanes.codex.running, null);
  } finally { saveConfig({ bench: previous }); }
});

test('local off-peak windows include endpoints correctly and may wrap midnight', () => {
  const at = (hour, minute = 0) => new Date(2026, 0, 15, hour, minute);
  assert.equal(isOffPeak(at(1), { start: '00:00', end: '07:00' }), true);
  assert.equal(isOffPeak(at(7), { start: '00:00', end: '07:00' }), false);
  assert.equal(isOffPeak(at(23), { start: '22:00', end: '06:00' }), true);
  assert.equal(isOffPeak(at(5, 59), { start: '22:00', end: '06:00' }), true);
  assert.equal(isOffPeak(at(12), { start: '22:00', end: '06:00' }), false);
  assert.equal(isOffPeak(at(12), null), true);
});

test('local weekends are entirely off-peak and Friday wakes at Saturday midnight', () => {
  const window = { start: '00:00', end: '07:00', weekends: true };
  const fridayAfterClose = new Date(2026, 0, 16, 7, 1);
  const saturday = new Date(2026, 0, 17, 12, 0);
  const sundayEnd = new Date(2026, 0, 18, 23, 59);
  const mondayClose = new Date(2026, 0, 19, 7, 0);
  assert.equal(isOffPeak(saturday, window), true);
  assert.equal(nextOffPeakStart(saturday, window), null, 'Saturday is already open');
  assert.equal(isOffPeak(sundayEnd, window), true);
  assert.equal(isOffPeak(mondayClose, window), false);
  assert.equal(nextOffPeakStart(fridayAfterClose, window).getTime(), new Date(2026, 0, 17, 0, 0).getTime());
});

test('next off-peak opening stays at the configured local clock across DST', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const from = new Date(2026, 2, 7, 9, 0);
    const next = nextOffPeakStart(from, { start: '07:00', end: '08:00' });
    assert.equal(next.getDate(), 8);
    assert.equal(next.getHours(), 7);
    assert.equal(next.getTime() - from.getTime(), 21 * 60 * 60_000, 'spring-forward day is not treated as a fixed 24 hours');
    const repeatedHour = new Date(Date.UTC(2026, 10, 1, 6, 15)); // second 01:15, after clocks fall back
    const repeatedStart = nextOffPeakStart(repeatedHour, { start: '01:30', end: '01:45' });
    assert.equal(repeatedStart.getTime() - repeatedHour.getTime(), 15 * 60_000, 'the second occurrence of a repeated local start is still found');
  } finally {
    if (previous == null) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('automatic lanes wait outside off-peak, then finish a running task without starting the next', async () => {
  reset(); saveConfig({ bench: { offPeak: { start: '00:00', end: '07:00' } }, scorecard: { archived: [] } });
  const registry = reg([model('codex', 'c', ['low'])]);
  enqueueBench([{ provider: 'codex', model: 'c', effort: 'low' }], { reg: registry, taskIds: ['a', 'b'], probe: false });
  let at = new Date(2026, 0, 15, 12).getTime(), calls = 0;
  await runBenchQueue({ execute: async () => { calls++; return { verdict: 'pass' }; }, tasks: () => [], blockedUntil: () => null, now: () => at, reg: registry, respectOffPeak: true });
  assert.equal(calls, 0);
  const waiting = getBenchState();
  assert.deepEqual(waiting.lanes.codex.queue[0].remaining, ['a', 'b']);
  assert.equal(nextBenchWakeAt(waiting, at, { start: '00:00', end: '07:00' }), new Date(2026, 0, 16, 0).getTime());
  waiting.lanes.codex.parkedUntil = new Date(2026, 0, 16, 2).getTime();
  assert.equal(nextBenchWakeAt(waiting, at, { start: '00:00', end: '07:00' }), waiting.lanes.codex.parkedUntil, 'a limit reset inside the next window remains the wake time');
  waiting.lanes.codex.parkedUntil = new Date(2026, 0, 16, 8).getTime();
  assert.equal(nextBenchWakeAt(waiting, at, { start: '00:00', end: '07:00' }), new Date(2026, 0, 17, 0).getTime(), 'a reset after the next window waits for the following opening');

  at = new Date(2026, 0, 15, 1).getTime();
  await runBenchQueue({ execute: async () => { calls++; at = new Date(2026, 0, 15, 12).getTime(); return { verdict: 'pass' }; }, tasks: () => [], blockedUntil: () => null, now: () => at, reg: registry, respectOffPeak: true });
  assert.equal(calls, 1, 'the task started inside the window finishes, but no new task starts after close');
  assert.deepEqual(getBenchState().lanes.codex.queue[0].remaining, ['b']);
});

test('manual lane drains are not restricted and bench status describes an off-peak wait', async () => {
  reset(); saveConfig({ bench: { newModels: 'auto', offPeak: { start: '00:00', end: '07:00' } }, scorecard: { archived: [] } });
  const registry = reg([model('codex', 'c', ['low'])]);
  enqueueBench([{ provider: 'codex', model: 'c', effort: 'low' }], { reg: registry, taskIds: ['a'], probe: false });
  let calls = 0;
  await runBenchQueue({ execute: async () => { calls++; return { verdict: 'pass' }; }, tasks: () => [], blockedUntil: () => null, now: () => new Date(2026, 0, 15, 12).getTime(), reg: registry });
  assert.equal(calls, 1);
  const cfg = { bench: { newModels: 'auto', offPeak: { start: '00:00', end: '07:00', weekends: true } } };
  assert.match(formatBench([{ provider: 'codex', model: 'c', effort: 'low', why: 'never benchmarked' }], { cfg, now: new Date(2026, 0, 15, 12) }), /auto-bench waits for off-peak \(00:00; weekends included\)/);
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

test('queued archived selections are refused, and live work yields every lane', async () => {
  reset();
  saveConfig({ scorecard: { archived: ['codex:old'] } });
  const registry = reg([
    model('codex', 'old', ['low']), model('codex', 'new', ['low']),
  ]);
  enqueueBench(registry.models.map((m) => ({ provider: m.provider, model: m.id, effort: m.efforts[0] || null })), { reg: registry, taskIds: ['a'], probe: false });
  assert.deepEqual(Object.values(getBenchState().lanes).flatMap((lane) => lane.queue.map((q) => q.selection.model)), ['new']);
  let calls = 0;
  await runBenchQueue({ execute: async () => { calls++; return { verdict: 'pass' }; }, tasks: () => [{ source: 'live', status: 'queued', provider: 'grok' }], blockedUntil: () => null, reg: registry });
  assert.equal(calls, 0);
  assert.equal(getBenchState().lanes.codex.queue.length, 1);
  saveConfig({ scorecard: { archived: [] } });
});
