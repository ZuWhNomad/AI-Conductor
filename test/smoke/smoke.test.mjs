import { HOME, tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';

const { BATTERY, copiedFromGrader } = await import('../../core/smoke/battery.mjs');
const { runSmoke, formatSmoke, SMOKE_TASKS } = await import('../../core/smoke/index.mjs');
const { recordRun, rootRuns, recommend } = await import('../../core/scorecard.mjs');
const { CANARY, bare } = await import('../../core/smoke/private/common.mjs');
const PRIVATE = new URL('../../core/smoke/private/', import.meta.url);
const write = (dir, files) => { for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); } };

for (const b of BATTERY) {
  test(`battery ${b.id}: check fails on the untouched fixture and passes on the reference solution`, async () => {
    const dir = tmpDir(`smoke-${b.id}`);
    b.setup(dir);
    assert.equal(copiedFromGrader(dir), false, 'a fixture carries the canary');
    const untouched = await b.check(dir, { result: { finalMessage: 'Done. See src/http/parse.mjs:1 for area, distance.' } });
    assert.equal(untouched.pass, false, `untouched fixture passed: ${untouched.notes}`);
    assert.notEqual(untouched.notes, 'copied from the grader');
    const solved = b.solve(dir) || {};
    assert.equal(copiedFromGrader(dir), false, 'solve() writes the canary');
    const ok = await b.check(dir, { result: { finalMessage: solved.finalMessage || 'done' } });
    assert.equal(ok.pass, true, ok.notes);
    for (const rel of b.hidden || []) assert.equal(existsSync(join(dir, rel)), false, `${rel} left behind`);
    rmSync(dir, { recursive: true, force: true });
  });
}

// Level 6-7 graders: every plausible wrong solution fails, every different-but-correct one passes. Mutants that fail only
// by timing out (refactor-6's benchmark kill, implement-7's 60 s test timeout) run with CONDUCTOR_SMOKE_SLOW=1.
const SLOW = process.env.CONDUCTOR_SMOKE_SLOW === '1';
for (const id of ['refactor-6', 'implement-6', 'implement-7', 'debug-7']) {
  const b = BATTERY.find((x) => x.id === id);
  const { MUTANTS, SLOW_MUTANTS = {}, VARIANTS } = await import(new URL(`${id}.mjs`, PRIVATE));
  const cases = [...Object.entries(MUTANTS), ...(SLOW ? Object.entries(SLOW_MUTANTS) : [])].map(([name, files]) => ['mutant', name, files, false])
    .concat(Object.entries(VARIANTS).map(([name, files]) => ['variant', name, files, true]));
  for (const [kind, name, files, pass] of cases) {
    test(`${id} ${kind} ${pass ? 'passes' : 'fails'}: ${name}`, async () => {
      const dir = tmpDir(`smoke-${id}`);
      b.setup(dir); b.solve(dir); write(dir, bare(files));
      const r = await b.check(dir, { result: { finalMessage: 'done' } });
      assert.equal(r.pass, pass, r.notes);
      assert.notEqual(r.notes, 'copied from the grader');
      rmSync(dir, { recursive: true, force: true });
    });
  }
}

test('canary: every private module and every body in it except a fixture carries it; a planted copy fails every check', async () => {
  const fixtures = new Set();
  for (const b of BATTERY) {
    const dir = tmpDir(`smoke-fixture-${b.id}`);
    b.setup(dir);
    for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) fixtures.add(readFileSync(join(e.parentPath, e.name), 'utf8'));
    rmSync(dir, { recursive: true, force: true });
  }
  const bodies = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(bodies) : []);
  for (const f of readdirSync(PRIVATE).filter((f) => f.endsWith('.mjs'))) {
    assert.ok(readFileSync(new URL(f, PRIVATE), 'utf8').includes(CANARY), f);
    if (f === 'common.mjs') continue; // the canary itself, the helpers and the PRNG source
    for (const [name, v] of Object.entries(await import(new URL(f, PRIVATE)))) for (const s of bodies(v)) assert.ok(fixtures.has(s) || s.includes(CANARY), `${f} ${name}: no canary`);
  }
  assert.ok((await import(new URL('implement-6.mjs', PRIVATE))).patchHidden().includes(CANARY));
  const { OVERLAP_FAST } = await import(new URL('refactor-6.mjs', PRIVATE));
  for (const b of BATTERY) {
    const dir = tmpDir(`smoke-canary-${b.id}`);
    b.setup(dir); b.solve(dir);
    write(dir, { 'lib/deep/notes.txt': `copied\n// ${CANARY}\n` });
    assert.deepEqual(await b.check(dir, { result: { finalMessage: 'done' } }), { pass: false, notes: 'copied from the grader' }, b.id);
    rmSync(dir, { recursive: true, force: true });
  }
  const dir = tmpDir('smoke-canary-verbatim'); // the reference copied verbatim from private/ is caught too
  const b = BATTERY.find((x) => x.id === 'refactor-6');
  b.setup(dir); write(dir, { 'src/overlap.mjs': OVERLAP_FAST });
  assert.equal((await b.check(dir)).notes, 'copied from the grader');
  rmSync(dir, { recursive: true, force: true });
});

test("canary: the grader's own hidden files never trigger it, even when left behind", async () => {
  const hidden = {
    'refactor-6': (m) => [m.OVERLAP_HIDDEN, m.OVERLAP_BENCH], 'implement-6': (m) => [m.patchHidden()],
    'implement-7': (m) => [m.MULTIPART_HIDDEN], 'debug-7': (m) => [m.CACHE_HIDDEN],
  };
  for (const [id, bodies] of Object.entries(hidden)) {
    const b = BATTERY.find((x) => x.id === id);
    const dir = tmpDir(`smoke-hidden-${id}`);
    b.setup(dir); b.solve(dir);
    const left = bodies(await import(new URL(`${id}.mjs`, PRIVATE)));
    b.hidden.forEach((rel, i) => write(dir, { [rel]: left[i] })); // as if a killed earlier check had left them behind
    const r = await b.check(dir, { result: { finalMessage: 'done' } });
    assert.equal(r.pass, true, `${id}: ${r.notes}`);
    for (const rel of b.hidden) assert.equal(existsSync(join(dir, rel)), false, `${id}: ${rel} left behind`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scratch dirs and task titles are neutral (no conductor, smoke or task id); the dirs are removed', async () => {
  const specs = [];
  const execute = async (spec) => { specs.push(spec); assert.ok(existsSync(spec.cwd)); return { status: 'canceled', timedOut: true }; };
  await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['read-1', 'debug-7'], execute });
  assert.equal(specs.length, 2);
  assert.deepEqual(specs.map((s) => s.smokeId), ['read-1', 'debug-7']); // the id travels beside the title, not in it
  for (const { cwd, title } of specs) {
    assert.equal(dirname(cwd), realpathSync.native(tmpdir()));
    assert.match(basename(cwd), /^w-[A-Za-z0-9]{6}$/);
    assert.doesNotMatch(title, /conductor|smoke|read-1|debug-7/i);
    assert.equal(existsSync(cwd), false);
  }
});

test('smoke tasks at difficulty 7+ get smoke.hardTimeoutMinutes (30); the rest smoke.timeoutMinutes (20)', async () => {
  const { loadConfig, saveConfig, DEFAULTS } = await import('../../core/config.mjs');
  assert.deepEqual([DEFAULTS.smoke.timeoutMinutes, DEFAULTS.smoke.hardTimeoutMinutes], [20, 30]);
  const previous = loadConfig().smoke;
  const waits = [];
  const execute = async (spec, minutes) => { waits.push([spec.difficulty, minutes]); return { status: 'canceled', timedOut: true }; };
  const models = [{ provider: 'ollama', model: 'qwen' }], tasks = ['debug-5', 'refactor-6', 'implement-6', 'implement-7', 'debug-7'];
  try {
    await runSmoke({ models, tasks, execute });
    assert.deepEqual(waits.splice(0), [[5, 20], [6, 20], [6, 20], [7, 30], [7, 30]]);
    saveConfig({ smoke: { hardTimeoutMinutes: 45 } });
    await runSmoke({ models, tasks: ['debug-5', 'debug-7'], execute });
    await runSmoke({ models, tasks: ['debug-5', 'debug-7'], execute, timeoutMinutes: 3, hardTimeoutMinutes: 4 });
    assert.deepEqual(waits.splice(0), [[5, 20], [7, 45], [5, 3], [7, 4]]);
    saveConfig({ smoke: { hardTimeoutMinutes: -1 } });
    assert.equal(loadConfig().smoke.hardTimeoutMinutes, 30);
    saveConfig({ smoke: { hardTimeoutMinutes: 1e9 } });
    assert.equal(loadConfig().smoke.hardTimeoutMinutes, 1440);
  } finally { saveConfig({ smoke: previous }); }
});

test('routing ignores difficulty > 5: L6/L7 rows neither pool into nor lift a level-1-5 pick; delegate stays 1-5', async () => {
  const reg = { providers: { codex: { status: 'ok' } }, models: ['gpt-5.6-luna', 'gpt-5.6-terra'].map((id) => ({ provider: 'codex', id, kind: 'agent' })) };
  const row = (model, difficulty, rated, quality, avgUsd) => ({ sel: `codex:${model}:low`, steps: 1, provider: 'codex', model, effort: 'low', category: 'debug', difficulty, rated, n: rated, pass: rated * quality, fixable: 0, fail: rated * (1 - quality), phantom: 0, quality, accept: quality, avgUsd, avgDurationMs: 1000 });
  // Luna: one cheap rated run at L5 (below the sample floor) plus passing L6/L7 runs that would pool into it. Terra: proven at L5.
  const base = [row('gpt-5.6-luna', 5, 1, 1, 0.001), row('gpt-5.6-terra', 5, 3, 1, 0.05)];
  const hard = [row('gpt-5.6-luna', 6, 3, 1, 0.001), row('gpt-5.6-luna', 7, 3, 1, 0.001), row('gpt-5.6-terra', 6, 3, 0, 0.05), row('gpt-5.6-terra', 7, 3, 0, 0.05)];
  for (let d = 1; d <= 5; d++) assert.deepEqual(recommend({ category: 'debug', difficulty: d, summary: [...base, ...hard], reg }), recommend({ category: 'debug', difficulty: d, summary: base, reg }), `level ${d}`);
  const r = recommend({ category: 'debug', difficulty: 5, summary: [...base, ...hard], reg });
  assert.equal(r.model, 'gpt-5.6-terra');
  assert.doesNotMatch(r.reason, /pooled|reserve/);
  const { createTask, cancelTask } = await import('../../core/tasks.mjs');
  const cwd = tmpDir('smoke-difficulty');
  const smoke = createTask({ cwd, spec: 'x', provider: 'ollama', difficulty: 7, source: 'smoke' });
  const live = createTask({ cwd, spec: 'x', provider: 'ollama', difficulty: 6 });
  assert.equal(smoke.difficulty, 7);
  assert.equal(live.difficulty, null);
  cancelTask(smoke.id); cancelTask(live.id);
  rmSync(cwd, { recursive: true, force: true });
});

test('implement-4: eval named in a comment or string passes; a real eval or new Function fails', async () => {
  const b = BATTERY.find((x) => x.id === 'implement-4');
  const dir = tmpDir('smoke-implement-4-eval');
  b.setup(dir); b.solve(dir);
  const calc = readFileSync(join(dir, 'src/calc.mjs'), 'utf8');
  writeFileSync(join(dir, 'src/calc.mjs'), `// Recursive descent: no eval() / new Function.\n/* never eval(src) */\nconst note = 'no new Function here';\n${calc}`);
  const prose = await b.check(dir, { result: { finalMessage: 'done' } });
  assert.equal(prose.pass, true, prose.notes);
  for (const bad of ['const f = new Function("return 1");', 'const v = eval("1+1");']) {
    writeFileSync(join(dir, 'src/calc.mjs'), `${bad}\n${calc}`);
    const r = await b.check(dir, { result: { finalMessage: 'done' } });
    assert.equal(r.pass, false); assert.match(r.notes, /^uses eval \/ new Function: /);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('battery ids are unique and follow category-level', () => {
  const ids = SMOKE_TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of SMOKE_TASKS) {
    assert.equal(t.id, `${t.category}-${t.difficulty}`);
    assert.ok(Number.isInteger(t.difficulty) && t.difficulty >= 1 && t.difficulty <= 7, t.id);
  }
  assert.deepEqual([6, 7].map((d) => SMOKE_TASKS.filter((t) => t.difficulty === d).map((t) => t.id).sort()), [['implement-6', 'refactor-6'], ['debug-7', 'implement-7']]);
});

test('runSmoke rates each run from its check and the rows reach the scorecard as smoke runs', async () => {
  let n = 0;
  const execute = async (spec) => {
    const b = BATTERY.find((x) => x.spec === spec.spec);
    const solved = n++ % 2 === 0 ? b.solve(spec.cwd) || {} : {};
    const t = { id: `smoke${n}`, ...spec, status: 'done', attempts: 1, result: { finalMessage: solved.finalMessage || 'done', usage: { input_tokens: 100, output_tokens: 10 }, durationMs: 5 } };
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
  const execute = async (spec) => ({ id: 'late', ...spec, status: 'canceled', timedOut: true, attempts: 1, result: null });
  const [r] = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['read-1'], execute });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.notes, 'timeout');
});

test('a smoke task that never dispatched is skipped and not rated', async () => {
  const execute = async (spec) => ({ id: 'queued', ...spec, status: 'canceled', attempts: 0, error: 'skipped', result: null });
  const [r] = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['read-1'], execute });
  assert.equal(r.verdict, 'skipped');
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => a.taskId === 'queued' && a.verdict)), 'never rateTask when attempts is 0');
});

test('GP: a parked smoke task is canceled before scratch cleanup and remains skipped', async (ctx) => {
  const { loadConfig, saveConfig } = await import('../../core/config.mjs');
  const { PROVIDERS } = await import('../../core/providers/index.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  const { getTask, cancelTask } = await import('../../core/tasks.mjs');
  const { bus } = await import('../../core/bus.mjs');
  const previous = loadConfig(), priorLimit = getLimits().providers.deepseek;
  const timeoutMinutes = previous.smoke.timeoutMinutes;
  delete getLimits().providers.deepseek;
  saveConfig({ providers: { deepseek: { apiKey: 'test-key' } } });
  ctx.mock.method(PROVIDERS.deepseek, 'pollLimits', async () => ({ provider: 'deepseek', windows: [], blocked: false }));
  ctx.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).pathname, '/v1/chat/completions');
    return new Response('rate limit', { status: 429, headers: { 'retry-after': String((timeoutMinutes + 1) * 60) } });
  });
  let taskId, scratchPresentAtCancel = false;
  const onTask = (e) => {
    if (e.type !== 'task' || e.task.sessionId !== 'gp-smoke-park') return;
    taskId = e.task.id;
    if (e.task.status === 'canceled') scratchPresentAtCancel = existsSync(e.task.cwd);
  };
  bus.on('event', onTask);
  try {
    delete process.env.CONDUCTOR_NO_SCHEDULE;
    const [r] = await runSmoke({ models: [{ provider: 'deepseek', model: 'deepseek-flash' }], tasks: ['read-1'], sessionId: 'gp-smoke-park', timeoutMinutes });
    const task = getTask(r.taskId);
    assert.equal(r.verdict, 'skipped');
    assert.equal(task.attempts, 1);
    assert.equal(task.status, 'canceled');
    assert.equal(task.error, 'provider limit (parked)');
    assert.equal(task.limitHit, true);
    assert.equal(scratchPresentAtCancel, true);
    assert.equal(existsSync(task.cwd), false);
  } finally {
    process.env.CONDUCTOR_NO_SCHEDULE = '1';
    bus.off('event', onTask); if (taskId) cancelTask(taskId);
    if (priorLimit) getLimits().providers.deepseek = priorLimit;
    else delete getLimits().providers.deepseek;
    saveConfig({ providers: previous.providers });
  }
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
  const execute = async (spec) => { const t = { id: 'envfail', ...spec, status: 'failed', attempts: 1, error: 'getaddrinfo ENOTFOUND api.example', result: null }; recordRun(t); return t; };
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
    const t = n <= 2 ? { id: `stall${n}`, ...spec, status: 'canceled', timedOut: true, attempts: 1, result: null } : { id: `lim${n}`, ...spec, status: 'canceled', error: 'canceled', limitHit: true, attempts: 1, result: null };
    recordRun(t); return t;
  };
  const rs = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['read-1', 'search-1', 'edit-1', 'implement-2'], execute });
  assert.deepEqual(rs.map((r) => r.verdict), ['error', 'error', 'skipped']);
  assert.ok(!rootRuns().some((c) => c.attempts.some((a) => /^stall/.test(a.taskId) && a.verdict)), 'stalled timeouts do not count as failures');
});

test('importing a worker module that process.exit does not kill the check', async () => {
  const b = BATTERY.find((x) => x.id === 'edit-1');
  const dir = tmpDir('smoke-s5');
  b.setup(dir);
  writeFileSync(join(dir, 'src/math.mjs'), 'process.exit(0);\nexport function add() { return 0; }\n');
  const r = await b.check(dir);
  assert.equal(r.pass, false);
  assert.match(r.notes, /import did not finish|import failed/);
  rmSync(dir, { recursive: true, force: true });
});

test('L6/L7 smoke runs are recorded and listed in the scores table', async () => {
  const { formatScores } = await import('../../core/scorecard.mjs');
  const execute = async (spec) => { const t = { id: 'hard7', ...spec, status: 'done', attempts: 1, result: { finalMessage: 'done', usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 5 } }; recordRun(t); return t; };
  const [r] = await runSmoke({ models: [{ provider: 'ollama', model: 'qwen' }], tasks: ['debug-7'], execute });
  assert.equal(r.verdict, 'fail');
  assert.match(formatScores({ source: 'smoke' }), /\| debug@7 \|/);
});

test('a Codex 401 or a spent refresh token is an environment failure, not a model fail', async () => {
  const { envFailure } = await import('../../core/smoke/index.mjs');
  assert.ok(envFailure({ error: 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac***fvMA.' }));
  assert.ok(envFailure({ error: 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.' }));
  assert.equal(envFailure({ error: 'tests failed: expected 3, got 4' }), null);
});
