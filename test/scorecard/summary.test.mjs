import { HOME } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sc, pr, loadConfig, saveConfig, DEFAULTS, getModels,
  registryModels, USAGE, run, seed,
  join, appendNdjson, statePath, writeJson,
} from './_helpers.mjs';

test('run identity records the reported model while retaining the requested selection', () => {
  const exact = run({ id: 'served-exact', source: 'served-identity', provider: 'claude', model: 'default', effort: 'high', result: { servedModel: 'claude-opus-5-5[1m]', usage: USAGE, durationMs: 1 } });
  assert.equal(exact.model, 'claude-opus-5-5[1m]');
  assert.equal(exact.requestedModel, 'default');
  assert.equal(exact.servedModel, 'claude-opus-5-5[1m]');
  assert.equal(exact.effort, 'high');
  assert.equal(sc.rootRuns({ source: 'served-identity' })[0].attempts[0].model, 'claude-opus-5-5');

  const effortInId = run({ id: 'served-effort-id', source: 'served-effort-id', provider: 'antigravity', model: 'gemini-3.8-flash', effort: 'low', result: { servedModel: 'gemini-3.8-flash-low', usage: USAGE, durationMs: 1 } });
  assert.equal(effortInId.model, 'gemini-3.8-flash-low');
  assert.equal(effortInId.requestedModel, 'gemini-3.8-flash');
  assert.equal(effortInId.servedModel, 'gemini-3.8-flash-low');
  assert.equal(effortInId.effort, 'low');
  assert.equal(sc.rootRuns({ source: 'served-effort-id' })[0].attempts[0].sel, 'antigravity:gemini-3.8-flash:low');
  assert.equal(sc.migrateScorecard(), 0, 'the legacy Method-C migration does not void a newly recorded exact dispatch');
});

test('amend rows correct identity in runRows and rootRuns, last value wins, and unvoid restores', () => {
  const source = 'amend-identity';
  const cfg = loadConfig().scorecard;
  run({ id: 'amend-run', source, model: 'old-alias', effort: 'low' });
  sc.rateTask('amend-run', 'pass');
  sc.voidTask('amend-run', 'wrong identity');
  assert.equal(sc.runRows().find((r) => r.taskId === 'amend-run'), undefined);

  sc.amendTask('amend-run', { model: 'gpt-5.6-terra', effort: 'medium', unvoid: true, reason: 'resolved from journal' });
  sc.amendTask('amend-run', { model: 'gpt-6-sol', reason: 'later correction' });
  const row = sc.runRows().find((r) => r.taskId === 'amend-run');
  assert.equal(row.model, 'gpt-6-sol');
  assert.equal(row.effort, 'medium');
  const attempt = sc.rootRuns({ source })[0].attempts[0];
  assert.equal(attempt.model, row.model);
  assert.equal(attempt.effort, row.effort);
  assert.equal(attempt.verdict, 'pass');
  assert.ok(sc.summarize({ source }).some((g) => g.sel === 'codex:gpt-6-sol:medium'));
  try {
    saveConfig({ scorecard: { archived: ['codex:gpt-6-sol'] } });
    assert.equal(sc.summarize({ source }).length, 0);
    assert.ok(sc.summarize({ source, archived: true }).some((g) => g.sel === 'codex:gpt-6-sol:medium'));
  } finally { saveConfig({ scorecard: cfg }); }

  sc.voidTask('amend-run', 'later exclusion');
  assert.equal(sc.runRows().find((r) => r.taskId === 'amend-run'), undefined);
  assert.equal(sc.rootRuns({ source }).length, 0);
});

test('fix rounds fold into an attempt; retries fold attempts into a chain with the last verdict', () => {
  run({ id: 'root', category: 'edit', before: [{ id: 'codex:primary', usedPercent: 10, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] });
  run({ id: 'fix1', category: 'edit', followUpOf: 'root', result: { usage: { input_tokens: 500, output_tokens: 100 }, durationMs: 500 } });
  sc.rateTask('fix1', 'fixable');
  let c = sc.rootRuns().find((r) => r.taskId === 'root');
  assert.equal(c.verdict, 'fixable');
  sc.rateTask('root', 'pass', 'fine');
  c = sc.rootRuns().find((r) => r.taskId === 'root');
  assert.equal(c.verdict, 'pass');
  assert.deepEqual(c.tokens, { in: 50_500, out: 10_100, cached: 50_000, write: 0 });
  assert.equal(c.rounds, 1);
  assert.equal(c.durationMs, 1500);
  assert.deepEqual(c.pct, { 'codex:primary': 2, 'codex:secondary': 0 });
  assert.ok(Math.abs(c.usd - (50_500 * 0.2 + 50_000 * 0.02 + 10_100 * 1.2) / 1e6) < 1e-9);

  // A failed Luna attempt retried on Terra: one chain, path luna>terra, verdict from Terra, cost summed.
  run({ id: 'try1', category: 'debug', difficulty: 4 });
  sc.rateTask('try1', 'fail', 'wrong fix');
  run({ id: 'try2', category: 'debug', difficulty: 4, model: 'gpt-5.6-terra', effort: 'medium', retryOf: 'try1' });
  sc.rateTask('try2', 'pass');
  const chain = sc.rootRuns().find((r) => r.taskId === 'try1');
  assert.deepEqual(chain.path, ['codex:gpt-5.6-luna:low', 'codex:gpt-5.6-terra:medium']);
  assert.equal(chain.verdict, 'pass');
  assert.equal(chain.attempts.length, 2);
  assert.ok(chain.usd > chain.attempts[0].usd && chain.usd > chain.attempts[1].usd);
  // an unrated earlier attempt that was retried counts as a fail
  run({ id: 'u1', category: 'docs', difficulty: 1 });
  run({ id: 'u2', category: 'docs', difficulty: 1, model: 'gpt-6-astra', retryOf: 'u1' });
  assert.equal(sc.rootRuns().find((r) => r.taskId === 'u1').attempts[0].verdict, 'fail');

  run({ id: 'crashed', category: 'edit', status: 'failed' });
  assert.equal(sc.rootRuns().find((r) => r.taskId === 'crashed').verdict, 'fail');
  sc.voidTask('crashed', 'sandbox denied the workspace');
  assert.equal(sc.rootRuns().find((r) => r.taskId === 'crashed'), undefined);
  // rate_task's `void` verdict routes to voidTask: the run leaves every aggregate.
  run({ id: 'signin', category: 'edit', status: 'failed' });
  assert.equal(sc.rateTask('signin', 'void', 'codex 401').op, 'void');
  assert.equal(sc.rootRuns().find((r) => r.taskId === 'signin'), undefined);
  assert.throws(() => sc.rateTask('root', 'meh'), { status: 400 });
});

test('a usage-limit reroute skips the cut-off run in the quality chain', () => {
  const source = 'failover-reroute';
  run({ id: `${source}-a`, source, category: 'review', difficulty: 2 });
  sc.rateTask(`${source}-a`, 'fail');
  // B hit a usage limit and has no scorecard row. C keeps A as its quality predecessor and records B separately.
  run({ id: `${source}-c`, source, category: 'review', difficulty: 2, model: 'gpt-5.6-terra', effort: 'medium', retryOf: `${source}-a`, reroutedFrom: `${source}-b` });
  sc.rateTask(`${source}-c`, 'pass');
  const chain = sc.rootRuns({ source }).find((c) => c.taskId === `${source}-a`);
  assert.deepEqual(chain.path, ['codex:gpt-5.6-luna:low', 'codex:gpt-5.6-terra:medium']);
  assert.ok(!chain.attempts.some((a) => a.taskId === `${source}-b`));
  assert.equal(sc.runRows().find((r) => r.taskId === `${source}-c`)?.reroutedFrom, `${source}-b`);
  sc.voidTask(`${source}-a`, 'test fixture');
  sc.voidTask(`${source}-c`, 'test fixture');
});

test('summarize: single-step rows count every attempt, path rows count observed ladders', () => {
  const sum = sc.summarize();
  const luna4 = sum.find((g) => g.sel === 'codex:gpt-5.6-luna:low' && g.category === 'debug' && g.difficulty === 4);
  assert.equal(luna4.fail, 1);
  const ladder = sum.find((g) => g.steps === 2 && g.category === 'debug');
  assert.equal(ladder.sel, 'codex:gpt-5.6-luna:low>codex:gpt-5.6-terra:medium');
  assert.equal(ladder.pass, 1);
  assert.equal(luna4.priorTier, 'B');
  assert.equal(ladder.priorTier, null);
});

test('source filter separates smoke from live runs', () => {
  run({ id: 'sm1', source: 'smoke', category: 'read', difficulty: 1 });
  sc.rateTask('sm1', 'pass');
  assert.ok(sc.rootRuns({ source: 'smoke' }).every((r) => r.source === 'smoke'));
  assert.ok(!sc.rootRuns({ source: 'live' }).some((r) => r.taskId === 'sm1'));
});

test('B11: avgPct is per-window concurrency-adjusted and ignores other quota groups', async () => {
  const lim = await import('../../core/limits.mjs');
  const source = 'B11-avg-pct', provider = 'b11-provider', model = 'gemini-pro';
  const previous = lim.getLimits().providers[provider];
  lim.getLimits().providers[provider] = { provider, windows: [
    { id: 'shared' }, { id: 'gemini', models: 'gemini' }, { id: 'third-party', models: 'claude|gpt' },
  ] };
  try {
    for (const [i, pct] of [{ shared: 8, gemini: 6, 'third-party': 90 }, { shared: 4, gemini: 4, 'third-party': 80 }, { 'third-party': 70 }].entries()) {
      const id = `${source}-${i}`;
      appendNdjson(statePath('scorecard.ndjson'), {
        op: 'run', taskId: id, ts: new Date(Date.now() + i).toISOString(), source, provider, model, effort: null, category: 'edit', difficulty: 2,
        status: 'done', tokens: { in: 100, out: 0, cached: 0, v: 2 }, durationMs: 1, rounds: 1,
        pct, concurrentByWindow: i ? { shared: 0, gemini: 0, 'third-party': 0 } : { shared: 3, gemini: 1, 'third-party': 0 },
      });
      sc.rateTask(id, 'pass');
    }
    const cell = sc.summarize({ source, shipped: false }).find((g) => g.model === model);
    assert.equal(cell.avgPct, 3.5); // maxes are 3 and 4 after divisors; a run with only an unrelated window adds no value
  } finally { lim.getLimits().providers[provider] = previous; }
});

test('a retry chain survives a voided original, and a rating on the voided id settles the retry', () => {
  run({ id: 'cap1', category: 'summarize', difficulty: 2 });          // died on a harness cap
  sc.voidTask('cap1', 'environment: iteration cap');
  run({ id: 'cap2', category: 'summarize', difficulty: 2, retryOf: 'cap1' });
  sc.rateTask('cap1', 'pass', 'rated on the original id, as instructed');
  const chain = sc.rootRuns().find((c) => c.attempts.some((a) => a.taskId === 'cap2'));
  assert.equal(chain.attempts.length, 1);          // the voided attempt does not count
  assert.equal(chain.verdict, 'pass');             // but its rating reaches the retry
});

test('modeling is a first-class category (journaled and scored as itself, not as other)', () => {
  assert.ok(sc.CATEGORIES.includes('modeling'));
  run({ id: 'mod1', category: 'modeling', difficulty: 4 });
  sc.rateTask('mod1', 'fixable');
  assert.ok(sc.summarize().some((g) => g.category === 'modeling' && g.difficulty === 4));
});

test('a run recorded from outside Conductor (unmeasured tokens) counts for quality but is unpriced', async () => {
  const { appendNdjson, statePath } = await import('../../core/paths.mjs');
  appendNdjson(statePath('scorecard.ndjson'), { op: 'run', ts: new Date().toISOString(), taskId: 'ext1', source: 'live', provider: 'codex', model: 'gpt-6-astra', effort: 'ultra', category: 'modeling', difficulty: 4, status: 'done', tokens: { in: 0, out: 0, cached: 0, v: 2 }, costUsd: 0, durationMs: 0, unmeasured: true, title: 'external' });
  sc.rateTask('ext1', 'pass', 'recorded from an external run');
  const a = sc.rootRuns().flatMap((c) => c.attempts).find((x) => x.taskId === 'ext1');
  assert.equal(a.verdict, 'pass'); assert.equal(a.usd, null);
  const g = sc.summarize().find((x) => x.category === 'modeling' && x.difficulty === 4 && /astra/.test(x.sel));
  assert.equal(g.pass, 1); assert.equal(g.avgUsd, null);
});

test('method-c migration voids antigravity rows whose sel carried a spurious effort, idempotently', async () => {
  const { appendNdjson, statePath } = await import('../../core/paths.mjs');
  const row = (taskId, model, effort) => appendNdjson(statePath('scorecard.ndjson'), { op: 'run', ts: new Date().toISOString(), taskId, source: 'live', provider: 'antigravity', model, effort, category: 'edit', difficulty: 2, status: 'done', tokens: { in: 100, out: 10, cached: 0, v: 2 }, durationMs: 100, title: 'x' });
  row('agy-bad', 'gemini-3.6-flash-low', 'high'); // raw effort-in-id model + spurious effort (the old bug)
  row('agy-good', 'gemini-3.8-flash', 'high');    // Method-C shape: family id + real effort
  sc.rateTask('agy-bad', 'pass'); sc.rateTask('agy-good', 'pass');
  assert.equal(sc.migrateScorecard(), 1);                                        // exactly the polluted row is voided
  assert.equal(sc.migrateScorecard(), 0);                                        // idempotent: nothing left to void
  assert.equal(sc.rootRuns().find((c) => c.taskId === 'agy-bad'), undefined);    // dropped from the aggregates
  assert.ok(sc.rootRuns().find((c) => c.taskId === 'agy-good'));                  // the clean family row survives
});

test('scorecard migration voids only harness-error smoke failures and is idempotent', async () => {
  const { appendNdjson, readNdjson, statePath } = await import('../../core/paths.mjs');
  const source = 'smoke';
  const row = (taskId, runSource = 'smoke') => appendNdjson(statePath('scorecard.ndjson'), {
    op: 'run', ts: new Date().toISOString(), taskId, source: runSource, provider: 'codex', model: 'gpt-6-sol', effort: 'medium',
    category: 'test', difficulty: 6, status: 'failed', tokens: { in: 1, out: 1, cached: 0, v: 2 }, durationMs: 1, title: 'legacy',
  });
  const cases = [
    ['migration-400', '{"type":"error","status":400,"message":"bad request"}'],
    ['migration-401', 'unexpected status 401 Unauthorized'],
    ['migration-limit', "You've hit your usage limit for this model."],
    ['migration-genuine', '8/9 tests passed'],
    ['migration-genuine-status', 'expected status 400 in the fixture output'],
  ];
  for (const [id, notes] of cases) { row(id); sc.rateTask(id, 'fail', notes); }
  row('migration-live', 'live'); sc.rateTask('migration-live', 'fail', 'HTTP status 500 from provider');
  assert.equal(sc.migrateScorecard(), 3);
  assert.equal(sc.migrateScorecard(), 0);
  const all = readNdjson(statePath('scorecard.ndjson'));
  for (const id of ['migration-400', 'migration-401', 'migration-limit']) assert.ok(all.some((r) => r.op === 'void' && r.taskId === id));
  assert.ok(sc.rootRuns({ source }).some((c) => c.taskId === 'migration-genuine'));
  assert.ok(sc.rootRuns({ source: 'live' }).some((c) => c.taskId === 'migration-live'));
  assert.equal(sc.rootRuns({ source }).some((c) => c.taskId === 'migration-400'), false);
});

test('phantom verdict is distinct: scored 0, counted, surfaced in error rates', () => {
  sc.recordRun({ id: 'ph1', title: 'p', status: 'failed', failKind: 'phantom', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'test', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } }, {});
  sc.rateTask('ph1', 'phantom');
  const g = sc.summarize().find((x) => x.sel === 'codex:gpt-5.6-luna:low' && x.category === 'test' && x.difficulty === 2);
  assert.equal(g.phantom, 1); assert.equal(g.fail, 0); assert.equal(g.quality, 0); assert.equal(g.errorRate, 0); assert.equal(g.phantomRate, 1);
  const er = sc.errorRates();
  assert.ok(er.byProvider.find((e) => e.key === 'codex' && e.phantom >= 1));
  assert.ok(er.byModel.find((e) => e.key === 'codex:gpt-5.6-luna:low' && e.phantom >= 1));
  assert.doesNotThrow(() => sc.rateTask('ph1', 'phantom'));
  assert.throws(() => sc.rateTask('ph1', 'meh'), { status: 400 });
});

test('summary reliability fields use known values and leave legacy rows unknown', async () => {
  const { appendNdjson, statePath } = await import('../../core/paths.mjs');
  const source = 'reliability-summary';
  const add = (id, result, verdict) => {
    sc.recordRun({ id, title: id, status: 'done', provider: 'claude', model: 'haiku', effort: null, category: 'docs', difficulty: 1, source, result });
    sc.rateTask(id, verdict);
  };
  add('reliability-pass', { ok: true, turns: 2, toolCalls: 4, toolErrors: 1, thrash: 2, timedOut: false, costUsd: 0.4, usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 }, 'pass');
  add('reliability-fix', { ok: false, turns: 4, toolCalls: 2, toolErrors: 1, thrash: 0, timedOut: true, costUsd: 0.2, usage: { input_tokens: 1, output_tokens: 1 }, durationMs: 1 }, 'fixable');
  const known = sc.summarize({ source, shipped: false }).find((g) => g.sel === 'claude:haiku:default');
  assert.equal(known.errorRate, 0.5);
  assert.equal(known.toolErrorRate, 2 / 6);
  assert.equal(known.avgTurns, 3);
  assert.equal(known.thrash, 2);
  assert.equal(known.timeouts, 1);
  assert.ok(Math.abs(known.costPerSuccess - 0.6) < 1e-9);
  appendNdjson(statePath('scorecard.ndjson'), { op: 'run', ts: new Date().toISOString(), taskId: 'reliability-old', source, provider: 'claude', model: 'legacy', effort: null, category: 'docs', difficulty: 1, status: 'done', tokens: { in: 1, out: 1, cached: 0, v: 2 }, durationMs: 1, title: 'old' });
  sc.rateTask('reliability-old', 'pass');
  const old = sc.summarize({ source, shipped: false }).find((g) => g.sel === 'claude:legacy:default');
  assert.equal(old.toolErrorRate, null); assert.equal(old.avgTurns, null); assert.equal(old.thrash, null); assert.equal(old.timeouts, null);
});

test('R2B4: a predecessor failure does not rate its unreviewed replacement', () => {
  const source = 'R2B4';
  run({ id: `${source}-original`, source });
  sc.rateTask(`${source}-original`, 'fail', 'reviewed before replacement');
  run({ id: `${source}-replacement`, source, retryOf: `${source}-original`, model: 'gpt-5.6-terra' });
  const summary = sc.summarize({ source });
  const original = summary.find((g) => g.steps === 1 && g.model === 'gpt-5.6-luna');
  const replacement = summary.find((g) => g.steps === 1 && g.model === 'gpt-5.6-terra');
  assert.equal(original.fail, 1);
  assert.equal(replacement.rated, 0);
  assert.equal(replacement.fail, 0);
  assert.equal(summary.find((g) => g.steps === 2).rated, 0);
  run({ id: `${source}-followup`, source, followUpOf: `${source}-replacement`, model: 'gpt-5.6-terra' });
  sc.rateTask(`${source}-replacement`, 'pass', 'reviewed attempt including its follow-up');
  assert.equal(sc.rootRuns({ source })[0].verdict, 'pass');
  sc.voidTask(`${source}-original`, 'harness failure');
  assert.equal(sc.rootRuns({ source })[0].verdict, 'pass', 'an explicit replacement verdict beats a voided ancestor verdict');
});

test('D7: a run with no reported usage is unknown cost, except a zero list price is really $0', () => {
  run({ id: 'D7-missing', source: 'D7-missing', category: 'read', difficulty: 1, result: { durationMs: 1000 } });
  sc.rateTask('D7-missing', 'pass');
  const missing = sc.rootRuns({ source: 'D7-missing' }).find((c) => c.taskId === 'D7-missing');
  assert.equal(missing.usd, null);
  assert.equal(missing.attempts[0].usd, null);
  assert.equal(sc.summarize({ source: 'D7-missing' }).find((g) => g.sel === 'codex:gpt-5.6-luna:low').avgUsd, null);

  run({ id: 'D7-local', source: 'D7-local', provider: 'deepseek', model: 'deepseek-chat', effort: null, category: 'read', difficulty: 1, result: { durationMs: 1000 } });
  sc.rateTask('D7-local', 'pass');
  const local = sc.rootRuns({ source: 'D7-local' }).find((c) => c.taskId === 'D7-local');
  assert.equal(local.usd, 0);
  assert.equal(sc.summarize({ source: 'D7-local' }).find((g) => g.provider === 'deepseek').avgUsd, 0);
});

test('chain cost estimates an untagged step using the chain category and difficulty', () => {
  const source = 'chain-cost-inherited-tags';
  run({ id: `${source}-history`, source, model: 'gpt-5.6-terra', effort: 'medium', category: 'test', difficulty: 2 });
  run({ id: `${source}-head`, source, category: 'test', difficulty: 2 });
  run({ id: `${source}-tail`, source, model: 'gpt-5.6-terra', effort: 'medium', category: null, difficulty: null, retryOf: `${source}-head`, result: { durationMs: 1 } });
  const chain = sc.rootRuns({ source }).find((c) => c.taskId === `${source}-head`);
  assert.equal(chain.attempts[1].usd, null);
  assert.equal(chain.partialCost, false);
  assert.ok(chain.usd > chain.attempts[0].usd);
});

test('B3: each retry attempt is scored under its own category/difficulty; untagged attempts are skipped', () => {
  const source = 'B3-tags';
  run({ id: `${source}-head`, source, category: null, difficulty: null });
  run({ id: `${source}-retry`, source, retryOf: `${source}-head`, model: 'gpt-5.6-terra', effort: 'medium', category: 'debug', difficulty: 3 });
  sc.rateTask(`${source}-retry`, 'pass');
  const chain = sc.rootRuns({ source }).find((c) => c.taskId === `${source}-head`);
  assert.equal(chain.attempts.length, 2);
  assert.ok(chain.usd > chain.attempts[0].usd && chain.usd > chain.attempts[1].usd, 'chain cost still sums both attempts');
  const sum = sc.summarize({ source });
  const tagged = sum.find((g) => g.steps === 1 && g.model === 'gpt-5.6-terra' && g.category === 'debug' && g.difficulty === 3);
  assert.equal(tagged.pass, 1);
  assert.equal(sum.find((g) => g.steps === 1 && g.model === 'gpt-5.6-luna'), undefined, 'untagged head is not summarized');
});

test('P3: rootRuns reuses the runRows size/mtime cache', async (t) => {
  const fs = (await import('node:fs')).default;
  const paths = await import('../../core/paths.mjs');
  const { syncBuiltinESMExports } = await import('node:module');
  sc.runRows();
  const orig = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === statePath('scorecard.ndjson')) throw new Error('P3: cache miss re-read');
    return orig.call(fs, file, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => paths.readNdjson(statePath('scorecard.ndjson')), /P3: cache miss re-read/);
    assert.doesNotThrow(() => sc.rootRuns());
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test('M8: summarize memoizes until the ledger or scorecard config changes', () => {
  const source = 'M8-summary-memo';
  const cfg = loadConfig().scorecard;
  try {
    run({ id: `${source}-0`, source, category: 'review', difficulty: 1 });
    sc.rateTask(`${source}-0`, 'pass');
    const first = sc.summarize({ source });
    assert.strictEqual(sc.summarize({ source }), first);
    run({ id: `${source}-1`, source, category: 'review', difficulty: 1 });
    const afterLedger = sc.summarize({ source });
    assert.notStrictEqual(afterLedger, first);
    saveConfig({ scorecard: { reservePct: cfg.reservePct === 0.5 ? 0.6 : 0.5 } });
    assert.notStrictEqual(sc.summarize({ source }), afterLedger);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('L2: the latest rating across a root and follow-up decides the attempt verdict', () => {
  const check = (source, rootVerdictAt, followVerdictAt, expected) => {
    const root = `${source}-root`, follow = `${source}-follow`;
    run({ id: root, source, category: 'review', difficulty: 1 });
    run({ id: follow, source, followUpOf: root, category: 'review', difficulty: 1 });
    appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: rootVerdictAt, taskId: root, verdict: 'fail' });
    appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: followVerdictAt, taskId: follow, verdict: 'pass' });
    assert.equal(sc.rootRuns({ source })[0].attempts[0].verdict, expected);
  };
  check('L2-follow-latest', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', 'pass');
  check('L2-root-latest', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:00.000Z', 'fail');
});
