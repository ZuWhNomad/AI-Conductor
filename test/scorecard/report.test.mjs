import { HOME } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sc, pr, loadConfig, saveConfig, DEFAULTS, getModels,
  registryModels, USAGE, run, seed,
  join, appendNdjson, statePath, writeJson,
} from './_helpers.mjs';

test('recommend: value not cheapness — a dearer model wins only when its extra quality is worth it', () => {
  saveConfig({ scorecard: { minSamples: 3, providerWeight: { codex: 1, claude: 1, deepseek: 0 }, reservePct: 0 } }); // list-price economics for this scenario
  // implement@2: Luna 0.8 quality (~$0.023/task), Terra 1.0 quality (10x the tokens price: ~$0.23), Astra 1.0 (~$1.15)
  seed('codex', 'gpt-5.6-luna', 'low', 'implement', 2, ['pass', 'pass', 'pass', 'fixable', 'fail']);
  seed('codex', 'gpt-5.6-terra', 'medium', 'implement', 2, ['pass', 'pass', 'pass']);
  seed('codex', 'gpt-6-astra', 'medium', 'implement', 2, ['pass', 'pass', 'pass']);
  const sum = sc.summarize();
  const luna = sum.find((g) => g.sel === 'codex:gpt-5.6-luna:low' && g.category === 'implement' && g.difficulty === 2);
  assert.equal(luna.quality, 0.7);
  assert.equal(luna.accept, 0.8);
  assert.ok(Math.abs(luna.avgUsd - 0.023) < 1e-9);

  // λ = $5: Luna alone fails the 0.75 bar; ladder Luna->Terra: quality 0.7 + 0.2*1.0 = 0.9 at 0.023 + 0.2*0.23 = 0.069 -> U 4.43
  // Terra alone: 1.0 at 0.23 -> U 4.77 -> Terra wins; Astra 1.0 at 1.15 -> U 3.85
  let r = sc.recommend({ category: 'implement', difficulty: 2 });
  assert.equal(r.model, 'gpt-5.6-terra');
  assert.equal(r.plan.steps.length, 1);
  assert.match(r.reason, /best value for implement@2/);
  // λ = $1: quality is cheap -> the ladder (U 0.831) beats Terra alone (U 0.77)
  saveConfig({ scorecard: { qualityValueUsd: 1 } });
  r = sc.recommend({ category: 'implement', difficulty: 2 });
  assert.deepEqual(r.plan.steps, ['codex:gpt-5.6-luna:low', 'codex:gpt-5.6-terra:medium']);
  assert.equal(r.plan.estimated, true);
  assert.equal(r.model, 'gpt-5.6-luna');
  assert.equal(r.fallback.model, 'gpt-5.6-terra');
  assert.match(r.reason, /then on fail/);
  // λ = $100: quality is everything -> both Terra and Astra hit 1.0; Terra is cheaper
  saveConfig({ scorecard: { qualityValueUsd: 100 } });
  assert.equal(sc.recommend({ category: 'implement', difficulty: 2 }).model, 'gpt-5.6-terra');
  saveConfig({ scorecard: { qualityValueUsd: 5 } });

  // exclusion and level logic. Without Terra, Astra alone ($1.15, U 3.85) loses to Luna-first with Astra as the net (U 4.25).
  let x = sc.recommend({ category: 'implement', difficulty: 2, exclude: ['codex:gpt-5.6-terra'] });
  assert.deepEqual(x.plan.steps, ['codex:gpt-5.6-luna:low', 'codex:gpt-6-astra:medium']);
  assert.equal(x.fallback.model, 'gpt-6-astra');
  assert.equal(sc.recommend({ category: 'implement', difficulty: 1 }).model, 'gpt-5.6-terra');   // level-2 evidence covers level 1
  x = sc.recommend({ category: 'implement', difficulty: 3 });                                        // no evidence at 3+: extrapolated, flagged
  assert.equal(x.model, 'gpt-5.6-terra');
  assert.match(x.reason, /extrapolated from level 2/);
  seed('codex', 'gpt-5.6-terra', 'medium', 'implement', 3, ['fail', 'fail', 'pass']);
  seed('codex', 'gpt-6-astra', 'medium', 'implement', 3, ['pass', 'pass', 'fixable']);
  x = sc.recommend({ category: 'implement', difficulty: 3 });
  assert.equal(x.plan.steps.at(-1), 'codex:gpt-6-astra:medium');                                 // Astra is the only qualified final step at 3
  assert.equal(sc.recommend({ category: 'implement', difficulty: 2 }).model, 'gpt-5.6-terra');     // failing at 3 does not disqualify at 2
  assert.match(sc.recommend({ category: 'implement', difficulty: 4 }).reason, /extrapolated from level 3/);

  // free local model: $0 -> wins as soon as it clears the bar with enough samples
  seed('deepseek', 'deepseek-chat', null, 'implement', 2, ['pass', 'pass']);
  assert.equal(sc.recommend({ category: 'implement', difficulty: 2 }).model, 'gpt-5.6-terra');
  seed('deepseek', 'deepseek-chat', null, 'implement', 2, ['pass']);
  assert.equal(sc.recommend({ category: 'implement', difficulty: 2 }).provider, 'deepseek');
  // ...unless wall clock is priced: deepseek-chat took 1000 ms like the others here, so make it slow
  assert.equal(sc.recommend({ category: 'docs', difficulty: 1 }), null);

  const text = sc.formatScores();
  assert.match(text, /implement@2/);
  assert.match(text, /- implement@3: class [a-z]+ · best value/);
  assert.match(text, /\| B$/m);
  assert.match(sc.formatScores({ category: 'review' }), /empty|none/);
});

test('a fully discounted plan keeps zero cost through utility and score formatting', async () => {
  const { getLimits } = await import('../../core/limits.mjs');
  const cfg = loadConfig().scorecard, limits = getLimits(), previous = limits.providers.codex;
  const source = 'waste-zero-cost';
  try {
    saveConfig({ scorecard: { usePriors: false, quality: 0.75, minSamples: 3, qualityValueUsd: 5, reservePct: 0, hourlyUsd: 0,
      wasteSteps: [[72, 0.5], [48, 0.8], [24, 1]], wasteStrength: 1,
      providerWeight: { codex: 1 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    limits.providers.codex = { windows: [{ id: 'weekly', label: 'weekly', usedPercent: 99, resetsAt: Date.now() + 23 * 3600e3, windowMinutes: 10080 }] };
    for (let i = 0; i < 3; i++) {
      const id = `${source}-${i}`;
      run({ id, source, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'search', difficulty: 2 });
      sc.rateTask(id, 'pass');
    }
    const summary = sc.summarize({ source });
    const pick = sc.recommend({ category: 'search', difficulty: 2, summary });
    assert.equal(pick.plan.usd, 0);
    assert.equal(pick.plan.utility, 5 * pick.plan.quality);
    assert.match(pick.reason, /at \$0\.000/);
    const short = sc.formatScoresShort({ source });
    const full = sc.formatScores({ category: 'search', source });
    assert.match(short, /\$0\.000/); assert.match(full, /at \$0\.000/);
    assert.doesNotMatch(short + full, /NaN|Infinity/);
  } finally { limits.providers.codex = previous; saveConfig({ scorecard: cfg }); }
});

test('formatScores surfaces the phantom column and error-rate section', () => {
  const text = sc.formatScores();
  assert.match(text, /pass\/fix\/close\/fail\/phantom/);
  assert.match(text, /Error rates/);
});

test('short view: every category@level is a compact pick, capped cell, or no-data cell; benched cells; csv', () => {
  const shortBefore = sc.formatScoresShort();
  const fullBefore = sc.formatScores();
  const pad = [];
  for (let i = 0; i < 40; i++) pad.push(...seed('codex', `length-pad-${i}`, 'low', 'implement', 2, ['pass']));
  try {
  const short = sc.formatScoresShort();
  const full = sc.formatScores();
  assert.equal(short.length, shortBefore.length, 'short view length changed when rows were added');
  assert.ok(shortBefore.length < fullBefore.length, 'short ' + shortBefore.length + ' vs full ' + fullBefore.length);
  const cfg = loadConfig().scorecard;
  for (const c of sc.CATEGORIES) for (const d of [1, 2, 3, 4, 5, 6, 7]) {
    const r = sc.recommend({ category: c, difficulty: d });
    const line = short.split('\n').find((l) => l.startsWith('- ' + c + '@1:'));
    assert.ok(line, 'no short line for ' + c + '@' + d);
    assert.ok(line.includes(c + '@' + d + ':'), line);
    if (r) assert.ok(line.includes(r.provider + ':' + (r.model || 'default') + ':' + (r.effort || 'default')), line);
    else assert.match(line, new RegExp(c + '@' + d + ': (?:capped:|no data)'));
  }
  assert.doesNotMatch(short, /runner-up/);
  const bad = sc.benchedCells(sc.summarize(), cfg)[0];
  if (bad) assert.ok(short.includes('- ' + bad.sel + ' ' + bad.category + '@' + bad.difficulty + ':'), 'benched cell listed');
  if (bad) assert.ok(full.includes('- ' + bad.sel + ' ' + bad.category + '@' + bad.difficulty + ':'), 'full view lists benched cell');
  assert.equal(sc.formatScoresShort(), short);                           // memoised: same inputs, same text
  const csv = sc.scoresCsv();
  assert.match(csv.split('\n')[0], /^sel,category,difficulty,/);
  assert.equal(csv.trim().split('\n').length, sc.summarize().length + 1);
  } finally {
    for (const id of pad) sc.voidTask(id, 'length fixture');
  }
});

test('A2: Claude uses reported list cost, cells expose priced share, and chains estimate known steps', () => {
  const source = 'A2-costs';
  const claude = run({ id: 'A2-claude', source, provider: 'claude', model: 'haiku', effort: null, category: 'read', difficulty: 2, result: { usage: { input_tokens: 100_000, output_tokens: 100_000 }, costUsd: 1.23 } });
  assert.equal(claude.costBasis, 'list');
  const codex = run({ id: 'A2-codex', source, category: 'read', difficulty: 2, result: { usage: USAGE, costUsd: 0 } });
  assert.equal(codex.costBasis, 'tokens');
  const claudeAttempt = sc.rootRuns({ source }).find((c) => c.taskId === 'A2-claude').attempts[0];
  assert.equal(claudeAttempt.usd, 1.23); assert.equal(claudeAttempt.costBasis, 'list');
  run({ id: 'A2-claude-fix', source, provider: 'claude', model: 'haiku', effort: null, category: 'read', difficulty: 3, result: { usage: { input_tokens: 100_000, output_tokens: 0 }, costUsd: 1 } });
  run({ id: 'A2-claude-fix-round', source, provider: 'claude', model: 'haiku', effort: null, category: 'read', difficulty: 3, followUpOf: 'A2-claude-fix', result: { usage: { input_tokens: 100_000, output_tokens: 0 }, costUsd: 0 } });
  const tokenClaude = sc.rootRuns({ source }).find((c) => c.taskId === 'A2-claude-fix').attempts[0];
  assert.equal(tokenClaude.costBasis, 'tokens'); assert.equal(tokenClaude.usd, 0.2);

  const row = (id, model, usage, retryOf = null) => run({ id, source, provider: 'codex', model, effort: 'low', category: 'test', difficulty: 2, retryOf, result: { usage, durationMs: 1 } });
  row('A2-history', 'gpt-5.6-luna', { input_tokens: 100_000, output_tokens: 0 });
  row('A2-head', 'gpt-5.6-luna', null);
  row('A2-tail', 'gpt-5.6-terra', { input_tokens: 100_000, output_tokens: 0 }, 'A2-head');
  const chain = sc.rootRuns({ source }).find((c) => c.taskId === 'A2-head');
  const lunaMean = sc.rootRuns().flatMap((c) => c.attempts).filter((a) => a.sel === 'codex:gpt-5.6-luna:low' && a.category === 'test' && a.difficulty === 2 && a.usd != null).map((a) => a.usd).reduce((sum, usd, _, xs) => sum + usd / xs.length, 0);
  assert.ok(Math.abs(chain.usd - (chain.attempts[1].usd + lunaMean)) < 1e-12);
  assert.equal(chain.partialCost, false);

  row('A2-no-history', 'gpt-6-astra', null);
  row('A2-priced-tail', 'gpt-5.6-terra', { input_tokens: 100_000, output_tokens: 0 }, 'A2-no-history');
  const partial = sc.rootRuns({ source }).find((c) => c.taskId === 'A2-no-history');
  assert.equal(partial.usd, null); assert.equal(partial.partialCost, true);

  for (const id of ['A2-share-1', 'A2-share-2', 'A2-share-3']) run({ id, source, category: 'docs', difficulty: 4, result: { usage: { input_tokens: 100_000, output_tokens: 0 } } });
  run({ id: 'A2-share-null', source, category: 'docs', difficulty: 4, result: { usage: null } });
  const cell = sc.summarize({ source }).find((g) => g.sel === 'codex:gpt-5.6-luna:low' && g.category === 'docs' && g.difficulty === 4);
  assert.equal(cell.pricedShare, 0.75);
  assert.equal(cell.avgUsd, 0.02);
  assert.match(sc.formatScores({ source }), /\(3\/4 priced\)/);
});

test('B5 deterministic replay: lower benchmarks extrapolate, live quality wins, and 45-day weights retire evidence', (t) => {
  const cfg = loadConfig().scorecard;
  const models = ['b5-bench', 'b5-override', 'b5-aging'];
  registryModels(t, models.map((model) => ['codex', model]));
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  const replay = ({ id, model, category, difficulty, verdict, source = 'live', ts }) => {
    appendNdjson(statePath('scorecard.ndjson'), {
      op: 'run', ts, taskId: id, followUpOf: null, retryOf: null, source, provider: 'codex', model, requestedModel: model,
      effort: null, category, difficulty, status: 'done', tokens: { in: 1, out: 1, cached: 0, write: 0, v: 2 }, durationMs: 1,
    });
    appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts, taskId: id, verdict });
  };
  try {
    saveConfig({ scorecard: {
      shippedBatteries: true, usePriors: false, minSamples: 1, benchMinSamples: 3, quality: 0.75,
      reservePct: 0, hourlyUsd: 0, wasteStrength: 0, providerWeight: { codex: 1 },
      classes: { codex: 'subscription' }, classOrder: ['subscription'],
      prices: Object.fromEntries(models.map((model) => [`codex:${model}`, { in: 1, out: 1, cached: 0 }])),
    } });

    replay({ id: 'b5-own-level', model: 'b5-bench', category: 'read', difficulty: 2, verdict: 'pass', source: 'smoke', ts: new Date(now).toISOString() });
    const ownLevel = sc.summarize({ source: 'smoke' }).filter((g) => g.model === 'b5-bench');
    assert.equal(sc.recommend({ category: 'read', difficulty: 2, summary: ownLevel }).model, 'b5-bench');
    assert.equal(sc.recommend({ category: 'read', difficulty: 1, summary: ownLevel }), null, 'benchmark evidence does not flow down a level');
    const extrapolated = sc.recommend({ category: 'read', difficulty: 3, summary: ownLevel });
    assert.equal(extrapolated.model, 'b5-bench');
    assert.match(extrapolated.reason, /extrapolated from level 2 \(benchmark evidence\)/);

    for (let i = 0; i < 3; i++) replay({ id: `b5-smoke-pass-${i}`, model: 'b5-override', category: 'debug', difficulty: 2, verdict: 'pass', source: 'smoke', ts: new Date(now).toISOString() });
    replay({ id: 'b5-live-fail', model: 'b5-override', category: 'debug', difficulty: 2, verdict: 'fail', ts: new Date(now).toISOString() });
    const override = sc.summarize().find((g) => g.model === 'b5-override' && g.category === 'debug');
    assert.deepEqual({ quality: override.quality, liveQuality: override.liveQuality, smokeQuality: override.smokeQuality, rated: override.rated }, { quality: 0, liveQuality: 0, smokeQuality: 1, rated: 4 });
    assert.equal(sc.recommend({ category: 'debug', difficulty: 2, summary: [override] }), null, 'one live rating owns quality over smoke in the same cell');
    assert.equal(sc.benchedCells([override]).length, 1, 'benchMinSamples still uses the evidence count');

    const fortyFiveDaysAgo = new Date(now - 45 * 24 * 3600e3).toISOString();
    for (let i = 0; i < 2; i++) replay({ id: `b5-aging-${i}`, model: 'b5-aging', category: 'review', difficulty: 1, verdict: 'pass', ts: fortyFiveDaysAgo });
    const atHalfLife = sc.summarize({ source: 'live' }).find((g) => g.model === 'b5-aging');
    assert.equal(atHalfLife.weightedRated, 1);
    assert.equal(sc.recommend({ category: 'review', difficulty: 1, summary: [atHalfLife] }).model, 'b5-aging');
    t.mock.method(Date, 'now', () => now + 24 * 3600e3);
    const retired = sc.summarize({ source: 'live' }).find((g) => g.model === 'b5-aging');
    assert.ok(retired.weightedRated < 1);
    assert.equal(sc.recommend({ category: 'review', difficulty: 1, summary: [retired] }), null);

    const noShipped = process.env.CONDUCTOR_NO_SHIPPED;
    delete process.env.CONDUCTOR_NO_SHIPPED;
    try {
      const shipped = sc.summarize({ source: 'smoke' }).find((g) => g.shipped);
      assert.ok(shipped && shipped.smokeRated === shipped.rated && shipped.smokeWeightedRated > 0, 'shipped cells are benchmark evidence');
    } finally { process.env.CONDUCTOR_NO_SHIPPED = noShipped; }
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B7: formatScoresShort memo key includes a minute bucket', async (t) => {
  const { getLimits } = await import('../../core/limits.mjs');
  const cfg = loadConfig().scorecard;
  const limits = getLimits();
  const previous = limits.providers.codex;
  const source = 'L42-memo';
  const now = Date.parse('2026-09-23T10:30:00');
  try {
    saveConfig({ scorecard: { usePriors: false, classCap: { subscription: 80 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    limits.providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 10, resetsAt: now + 8 * 3600e3 }] };
    for (let i = 0; i < 3; i++) {
      run({ id: `${source}-${i}`, source, model: 'gpt-5.6-terra', effort: 'medium', category: 'review', difficulty: 1 });
      sc.rateTask(`${source}-${i}`, 'pass');
    }
    t.mock.method(Date, 'now', () => now);
    const a = sc.formatScoresShort({ source });
    assert.match(a, /gpt-5\.6-terra/);
    const stamp = limits.updatedAt;
    limits.providers.codex.windows[0].usedPercent = 99;
    limits.updatedAt = stamp;
    t.mock.method(Date, 'now', () => now + 30_000);
    assert.equal(sc.formatScoresShort({ source }), a, 'same minute keeps the memo');
    t.mock.method(Date, 'now', () => now + 60_000);
    const b = sc.formatScoresShort({ source });
    assert.notEqual(b, a, 'new minute misses the memo');
    assert.match(b, /review@1: capped: codex:gpt-5\.6-terra:medium until/);
  } finally {
    limits.providers.codex = previous;
    saveConfig({ scorecard: cfg });
  }
});

test('D8: short view memo key includes a future provider reset but not a past one', () => {
  const now = Date.parse('2026-09-23T10:30:00Z');
  const base = { updatedAt: 'D8', providers: { codex: { windows: [{ id: 'primary', usedPercent: 100, resetsAt: now - 1 }] } } };
  const future = { updatedAt: 'D8', providers: { codex: { windows: [{ id: 'primary', usedPercent: 100, resetsAt: now + 60_000 }] } } };
  assert.notEqual(sc.shortMemoKey({ source: 'D8', limits: base, now }), sc.shortMemoKey({ source: 'D8', limits: future, now }));
});

test('short view memo key changes when a model-scoped confirmed limit expires', () => {
  const now = Date.parse('2026-09-23T10:30:00Z');
  const blockedUntil = now + 60_000;
  const limits = { updatedAt: 'confirmed-limit', providers: { codex: { windows: [], confirmedLimit: { blockedUntil } } } };
  assert.notEqual(
    sc.shortMemoKey({ source: 'confirmed-limit', limits, now }),
    sc.shortMemoKey({ source: 'confirmed-limit', limits, now: blockedUntil + 1 }),
  );
});

test('archived selections split main and archived views without changing the ledger or active retry verdict', () => {
  const cfg = loadConfig().scorecard;
  const source = 'archive-views';
  try {
    saveConfig({ scorecard: { archived: [], minSamples: 1, benchMinSamples: 3, usePriors: false } });
    run({ id: `${source}-old`, source, model: 'gpt-5.6-luna', effort: 'low', category: 'debug', difficulty: 3 });
    sc.rateTask(`${source}-old`, 'fail');
    run({ id: `${source}-new`, source, model: 'gpt-5.6-terra', effort: 'medium', category: 'debug', difficulty: 3, retryOf: `${source}-old` });
    sc.rateTask(`${source}-new`, 'pass');

    const before = JSON.stringify(sc.summarize({ source }));
    const beforeShort = sc.formatScoresShort({ source });
    assert.ok(JSON.parse(before).some((g) => g.steps === 2));
    saveConfig({ scorecard: { archived: ['CoDeX:GpT-5.6-LuNa'] } });

    const main = sc.summarize({ source }), archived = sc.summarize({ source, archived: true });
    assert.deepEqual(main.map((g) => g.sel), ['codex:gpt-5.6-terra:medium']);
    assert.equal(main[0].pass, 1, 'the active retry keeps its own verdict');
    assert.ok(archived.some((g) => g.sel === 'codex:gpt-5.6-luna:low'));
    assert.ok(archived.some((g) => g.steps === 2 && g.sel.includes('gpt-5.6-terra')));
    assert.ok(!archived.some((g) => g.steps === 1 && g.model === 'gpt-5.6-terra'));
    assert.deepEqual(sc.errorRates({ source }).byModel.map((g) => g.key), ['codex:gpt-5.6-terra:medium']);
    assert.deepEqual(sc.errorRates({ source, archived: true }).byModel.map((g) => g.key), ['codex:gpt-5.6-luna:low']);
    assert.ok(sc.runRows().some((r) => r.taskId === `${source}-old`), 'archive never filters runRows()');
    assert.equal(sc.scoresCsv({ source, archived: true }).trim().split('\n').length, archived.length + 1);
    assert.doesNotMatch(sc.formatScores({ source, archived: true }), /Plans \(/);
    saveConfig({ scorecard: { archived: ['codex:gpt-5.6-luna', 'codex:gpt-5.6-terra'] } });
    assert.notEqual(sc.formatScoresShort({ source }), beforeShort, 'config change invalidates the short-view memo');

    saveConfig({ scorecard: { archived: ['codex:gpt-5.6-luna'] } });
    assert.equal(sc.recommend({ category: 'debug', difficulty: 3, source }).model, 'gpt-5.6-terra');
    assert.equal(sc.recommend({ category: 'debug', difficulty: 3, source, escalate: true }).model, 'gpt-5.6-terra');
    saveConfig({ scorecard: { archived: [] } });
    assert.equal(JSON.stringify(sc.summarize({ source })), before, 'unarchiving restores the summary byte-for-byte');
    assert.equal(sc.formatScoresShort({ source }), beforeShort, 'unarchiving restores the memoized short view');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('one pass qualifies, while benching and failed-below prior suppression require benchMinSamples', () => {
  const cfg = loadConfig().scorecard;
  const reg = { providers: { codex: { status: 'ok' } }, models: [{ provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent', efforts: ['low'] }] };
  try {
    saveConfig({ scorecard: { archived: [], usePriors: true, minSamples: 1, benchMinSamples: 3, classOrder: ['subscription'] } });
    run({ id: 'qualify-one-pass', source: 'qualify-one', category: 'implement', difficulty: 2 });
    sc.rateTask('qualify-one-pass', 'pass');
    const qualified = sc.recommend({ category: 'implement', difficulty: 2, source: 'qualify-one', reg });
    assert.equal(qualified.model, 'gpt-5.6-luna');
    assert.ok(qualified.plan, 'one rated pass is measured evidence, not a prior-only pick');

    run({ id: 'bench-one-fail', source: 'bench-threshold', category: 'implement', difficulty: 2 });
    sc.rateTask('bench-one-fail', 'fail');
    const afterOne = sc.recommend({ category: 'implement', difficulty: 2, source: 'bench-threshold', reg });
    assert.equal(afterOne.model, 'gpt-5.6-luna', 'one failure does not suppress the prior');
    assert.match(afterOne.reason, /prior only/);
    assert.doesNotMatch(sc.formatScoresShort({ source: 'bench-threshold' }), /Benched/);

    for (const i of [2, 3]) {
      run({ id: `bench-${i}-fail`, source: 'bench-threshold', category: 'implement', difficulty: 2 });
      sc.rateTask(`bench-${i}-fail`, 'fail');
    }
    assert.equal(sc.recommend({ category: 'implement', difficulty: 2, source: 'bench-threshold', reg }), null, 'three failures suppress the prior');
    assert.match(sc.formatScoresShort({ source: 'bench-threshold' }), /Benched \(quality < 0\.75 over >= 3 recency-weighted rated/);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B10: manual eligibility blocks measured and prior picks; latest allow lifts a bench and explains why', () => {
  const cfg = loadConfig().scorecard;
  const reg = { providers: { codex: { status: 'ok' } }, models: [{ provider: 'codex', id: 'manual', kind: 'agent', efforts: ['low'] }] };
  const sel = 'codex:manual:low';
  try {
    saveConfig({ scorecard: {
      coldStart: 'priors', shippedBatteries: false, minSamples: 1, benchMinSamples: 3,
      classOrder: ['free'], classes: { codex: 'free' }, providerWeight: { codex: 0 },
      prices: { 'codex:manual': { in: 1, out: 1 } }, priors: { 'codex:manual': { default: 'B' } },
    } });
    assert.equal(sc.recommend({ category: 'other', difficulty: 2, summary: [], reg }).model, 'manual');
    assert.match(sc.formatScores({ summary: [] }), /hand-picked prior/);

    for (let i = 0; i < 3; i++) {
      run({ id: `eligibility-fail-${i}`, source: 'eligibility-bench', provider: 'codex', model: 'manual', effort: 'low', category: 'other', difficulty: 2 });
      sc.rateTask(`eligibility-fail-${i}`, 'fail');
    }
    assert.equal(sc.recommend({ category: 'other', difficulty: 2, source: 'eligibility-bench', reg }), null, 'bench suppresses the prior');
    sc.setEligibility(sel, 'other', 'allow', 'owner accepts this model here');
    const allowed = sc.recommend({ category: 'other', difficulty: 2, source: 'eligibility-bench', reg, explain: true });
    assert.equal(allowed.pick.model, 'manual');
    assert.match(allowed.explain.reason, /manual allow: owner accepts this model here/);

    sc.setEligibility(sel, 'other', 'block', 'known bad fit');
    const blocked = sc.recommend({ category: 'other', difficulty: 2, source: 'eligibility-bench', reg, explain: true });
    assert.equal(blocked.pick, null);
    assert.equal(blocked.explain.status, 'eligibility');
    assert.match(blocked.explain.reason, /known bad fit/);
    assert.equal(sc.eligibilityOverrides({ category: 'other' }).find((r) => r.sel === sel).action, 'block', 'latest decision wins');

    sc.setEligibility(sel, 'other', 'allow', 're-enabled after review');
    assert.equal(sc.recommend({ category: 'other', difficulty: 2, source: 'eligibility-bench', reg }).model, 'manual');

    run({ id: 'eligibility-measured-pass', source: 'eligibility-measured', provider: 'codex', model: 'manual', effort: 'low', category: 'review', difficulty: 2 });
    sc.rateTask('eligibility-measured-pass', 'pass');
    sc.setEligibility(sel, 'review', 'block', 'manual measured block');
    assert.equal(sc.recommend({ category: 'review', difficulty: 2, source: 'eligibility-measured', reg }), null);
    assert.match(sc.formatScoresShort({ source: 'eligibility-bench' }), /ALLOW codex:manual:low for other: re-enabled after review/);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('close counts as zero quality without changing accept or errorRate', () => {
  const id = 'close-is-not-accepted';
  run({ id, category: 'conductor', difficulty: 4 });
  sc.rateTask(id, 'close');
  const row = sc.summarize({ shipped: false }).find((g) => g.category === 'conductor' && g.difficulty === 4);
  assert.equal(row.close, 1);
  assert.equal(row.quality, 0);
  assert.equal(row.accept, 0);
  assert.equal(row.errorRate, 0);
  assert.match(sc.formatScores({ category: 'conductor' }), /pass\/fix\/close\/fail\/phantom/);
  assert.match(sc.scoresCsv().split('\n')[0], /,close,/);
});
