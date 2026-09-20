import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

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

test('an environment failure is voided immediately, not left as a failed attempt', async () => {
  const execute = async (spec) => { const t = { id: 'envfail', ...spec, status: 'failed', error: 'getaddrinfo ENOTFOUND api.example', result: null }; recordRun(t); return t; };
  const [r] = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['read-1'], execute });
  assert.equal(r.verdict, 'error');
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => a.taskId === 'envfail')), 'voided at detection time');
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
