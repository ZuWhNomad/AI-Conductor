import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { BATTERY } = await import('../../core/smoke/battery.mjs');
const { runSmoke, formatSmoke, SMOKE_TASKS } = await import('../../core/smoke/index.mjs');
const { recordRun, rootRuns } = await import('../../core/scorecard.mjs');

for (const b of BATTERY) {
  test(`battery ${b.id}: check fails on the untouched fixture and passes on the reference solution`, async () => {
    const dir = tmpDir(`smoke-${b.id}`);
    b.setup(dir);
    const untouched = await b.check(dir, { result: { finalMessage: 'Done. See src/http/parse.mjs:1 for area, distance.' } });
    assert.equal(untouched.pass, false, `untouched fixture passed: ${untouched.notes}`);
    const solved = b.solve(dir) || {};
    const ok = await b.check(dir, { result: { finalMessage: solved.finalMessage || 'done' } });
    assert.equal(ok.pass, true, ok.notes);
    rmSync(dir, { recursive: true, force: true });
  });
}

test('battery ids are unique and follow category-level', () => {
  const ids = SMOKE_TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of SMOKE_TASKS) assert.equal(t.id, `${t.category}-${t.difficulty}`);
});

test('runSmoke rates each run from its check and the rows reach the scorecard as smoke runs', async () => {
  let n = 0;
  const execute = async (spec) => {
    const b = BATTERY.find((x) => x.spec === spec.spec);
    const solved = n++ % 2 === 0 ? b.solve(spec.cwd) || {} : {};
    const t = { id: `smoke${n}`, ...spec, status: 'done', result: { finalMessage: solved.finalMessage || 'done', usage: { input_tokens: 100, output_tokens: 10 }, durationMs: 5 } };
    recordRun(t);
    return t;
  };
  const results = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen', effort: null }], tasks: ['read-1', 'edit-1', 'debug-3'], execute });
  assert.deepEqual(results.map((r) => r.verdict), ['pass', 'fail', 'pass']);
  assert.equal(results[1].category, 'edit');
  const smoke = rootRuns({ source: 'smoke' });
  assert.equal(smoke.length, 3);
  assert.deepEqual(smoke.map((r) => r.verdict).sort(), ['fail', 'pass', 'pass']);
  assert.match(formatSmoke(results), /ollama:qwen:default: 2\/3 passed/);
  await assert.rejects(runSmoke({ models: [] }), { status: 400 });
  await assert.rejects(runSmoke({ models: [{ provider: 'ollama' }], tasks: ['nope'], execute }), /no matching smoke tasks/);
});

test('a task that did not finish is rated fail with the reason', async () => {
  const execute = async (spec) => ({ id: 'late', ...spec, status: 'canceled', timedOut: true, result: null });
  const [r] = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['read-1'], execute });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.notes, 'timeout');
});

test('smoke timeouts are per invocation and bench probes never write config, even on failure', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { getModels } = await import('../../core/models.mjs');
  const { runBench } = await import('../../core/bench.mjs');
  const previous = loadConfig().smoke;
  saveConfig({ smoke: { timeoutMinutes: 17 } });
  const file = join(HOME, 'config.json');
  const before = readFileSync(file, 'utf8');
  const models = [{ provider: 'ollama', model: 'timeout-probe' }];
  const waits = [];
  const execute = async (_spec, minutes) => { waits.push(minutes); return { status: 'canceled', timedOut: true }; };
  const reg = getModels(); const saved = { models: reg.models, providers: reg.providers };
  const probeWaits = [], during = [];
  try {
    await runSmoke({ models, tasks: ['read-1'], execute, timeoutMinutes: 3 });
    await runSmoke({ models, tasks: ['read-1'], execute });
    assert.deepEqual(waits, [3, 17]);
    reg.models = [{ provider: 'ollama', id: 'timeout-probe', kind: 'agent' }]; reg.providers = { ollama: { status: 'ok' } };
    ctx.mock.method(globalThis, 'setTimeout', (fn, ms) => {
      probeWaits.push(ms); during.push(readFileSync(file, 'utf8'));
      queueMicrotask(fn); return {};
    });
    await assert.rejects(runBench({ onResult: () => { throw new Error('probe interrupted'); } }), /probe interrupted/);
    assert.deepEqual(probeWaits, [3 * 60_000], 'the bench passes the probe timeout to the real smoke executor');
    assert.deepEqual(during, [before], 'config stays untouched during the probe');
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(loadConfig().smoke.timeoutMinutes, 17);
  } finally { Object.assign(reg, saved); saveConfig({ smoke: previous }); }
});

test('an environment failure is voided immediately, not left as a failed attempt', async () => {
  const execute = async (spec) => { const t = { id: 'envfail', ...spec, status: 'failed', error: 'getaddrinfo ENOTFOUND api.example', result: null }; recordRun(t); return t; };
  const [r] = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['read-1'], execute });
  assert.equal(r.verdict, 'error');
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => a.taskId === 'envfail')), 'voided at detection time');
});

test('a smoke timeout still records a run so the fail rating lands', { timeout: 30_000 }, async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { PROVIDERS } = await import('../../core/providers/index.mjs');
  const conductor = loadConfig().conductor;
  const prevPoll = PROVIDERS.deepseek.pollLimits;
  PROVIDERS.deepseek.pollLimits = async () => ({ provider: 'deepseek', windows: [], blocked: false });
  saveConfig({ providers: { deepseek: { apiKey: 'test-key' } }, conductor: { budgetGate: false } });
  ctx.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).includes('/chat/completions')) {
      return new Promise((_, reject) => {
        const s = opts?.signal;
        if (!s) return;
        if (s.aborted) return reject(s.reason || new Error('aborted'));
        s.addEventListener('abort', () => reject(s.reason || new Error('aborted')), { once: true });
      });
    }
    return new Response('{}', { status: 200 });
  });
  delete process.env.CONDUCTOR_NO_SCHEDULE;
  try {
    const results = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-flash', effort: null }], tasks: ['read-1'], timeoutMinutes: 0.05 });
    assert.equal(results[0].verdict, 'fail');
    assert.equal(results[0].notes, 'timeout');
    assert.ok(results[0].taskId);
    const smoke = rootRuns({ source: 'smoke' });
    const row = smoke.find((c) => c.attempts.some((a) => a.taskId === results[0].taskId));
    assert.ok(row, 'timeout cancellation must leave a scorecard run row for rateTask to attach to');
    assert.equal(row.attempts[0].verdict, 'fail');
    assert.equal(row.attempts[0].notes, 'timeout');
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    PROVIDERS.deepseek.pollLimits = prevPoll;
    saveConfig({ conductor });
  }
});

test('timeouts immediately before a provider limit surfaces are voided as the same quota stall', async () => {
  let n = 0;
  const execute = async (spec) => {
    n++;
    const t = n <= 2 ? { id: `stall${n}`, ...spec, status: 'canceled', timedOut: true, result: null } : { id: `lim${n}`, ...spec, status: 'canceled', error: 'canceled', limitHit: true, result: null };
    recordRun(t); return t;
  };
  const rs = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['read-1', 'search-1', 'edit-1', 'implement-2'], execute });
  assert.deepEqual(rs.map((r) => r.verdict), ['error', 'error', 'skipped']);
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => /^stall/.test(a.taskId) && a.verdict)), 'stalled timeouts do not count as failures');
});
