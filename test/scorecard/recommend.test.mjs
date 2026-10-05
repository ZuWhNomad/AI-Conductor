import { HOME } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sc, pr, loadConfig, saveConfig, DEFAULTS, getModels,
  registryModels, USAGE, run, seed,
  join, appendNdjson, statePath, writeJson,
} from './_helpers.mjs';

let n = 0;

test('ledger rows for a removed provider cannot be routed', () => {
  const source = 'removed-provider-ledger';
  run({ id: source, source, provider: 'ollama', model: 'old-local', effort: null, category: 'review', difficulty: 2 });
  sc.rateTask(source, 'pass');
  const reg = { providers: { ollama: { status: 'ok' } }, models: [{ provider: 'ollama', id: 'old-local', kind: 'agent' }] };
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, source, reg, overflowApi: true }), null);
});

test('smoke repeats remain per-run evidence while pass^k controls the measured cell', (t) => {
  const models = ['consistency-aged-pass', 'consistency-aged-flaky'];
  registryModels(t, models.map((model) => ['codex', model]));
  const cfg = loadConfig().scorecard;
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const old = new Date(now - 5 * 24 * 3600e3).toISOString();
  t.mock.method(Date, 'now', () => now);
  const replay = ({ id, model, verdict }) => {
    appendNdjson(statePath('scorecard.ndjson'), {
      op: 'run', ts: old, taskId: id, followUpOf: null, retryOf: null, source: 'smoke', provider: 'codex', model, requestedModel: model,
      effort: 'low', category: 'debug', difficulty: 7, status: 'done', tokens: { in: 1, out: 1, cached: 0, write: 0, v: 2 }, durationMs: 1,
      smokeId: 'debug-7-consistency',
    });
    appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: old, taskId: id, verdict });
  };
  try {
    saveConfig({ scorecard: {
      shippedBatteries: false, usePriors: false, minSamples: 1, benchMinSamples: 1, quality: 0.75,
      reservePct: 0, hourlyUsd: 0, wasteStrength: 0, providerWeight: { codex: 1 },
      classes: { codex: 'subscription' }, classOrder: ['subscription'],
      prices: Object.fromEntries(models.map((model) => [`codex:${model}`, { in: 1, out: 1, cached: 0 }])),
    } });
    for (let i = 0; i < 3; i++) replay({ id: `consistency-aged-pass-${i}`, model: models[0], verdict: 'pass' });
    replay({ id: 'consistency-aged-flaky-0', model: models[1], verdict: 'pass' });
    replay({ id: 'consistency-aged-flaky-1', model: models[1], verdict: 'pass' });
    replay({ id: 'consistency-aged-flaky-2', model: models[1], verdict: 'fail' });

    const rows = sc.summarize({ source: 'smoke', shipped: false }).filter((g) => g.category === 'debug' && g.difficulty === 7);
    const passing = rows.find((g) => g.model === models[0]);
    const flaky = rows.find((g) => g.model === models[1]);
    assert.equal(passing.rated, 3); assert.equal(passing.smokeRated, 3); assert.ok(passing.weightedRated >= 1); assert.ok(passing.smokeWeightedRated >= 1); assert.equal(passing.quality, 1);
    const pick = sc.recommend({ category: 'debug', difficulty: 7, source: 'smoke', summary: [passing, flaky] });
    assert.equal(pick?.model, models[0]);
    assert.doesNotMatch(pick.reason, /extrapolated|escalation/);
    assert.equal(flaky.rated, 3); assert.equal(flaky.smokeRated, 3); assert.equal(flaky.quality, 0);
    assert.equal(sc.recommend({ category: 'debug', difficulty: 7, source: 'smoke', summary: [flaky] }), null);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('one aged passing run qualifies a model under the default minSamples', (t) => {
  const model = 'single-pass-aged';
  registryModels(t, [['codex', model]]);
  const cfg = loadConfig().scorecard;
  const now = Date.parse('2026-09-30T12:00:00.000Z');
  const old = new Date(now - 10 * 24 * 3600e3).toISOString();
  t.mock.method(Date, 'now', () => now);
  try {
    saveConfig({ scorecard: {
      shippedBatteries: false, usePriors: false, minSamples: DEFAULTS.scorecard.minSamples, quality: 0.75,
      reservePct: 0, hourlyUsd: 0, wasteStrength: 0, providerWeight: { codex: 1 },
      classes: { codex: 'subscription' }, classOrder: ['subscription'], prices: { [`codex:${model}`]: { in: 1, out: 1, cached: 0 } },
    } });
    appendNdjson(statePath('scorecard.ndjson'), {
      op: 'run', ts: old, taskId: 'single-pass-aged-0', followUpOf: null, retryOf: null, source: 'smoke', provider: 'codex', model, requestedModel: model,
      effort: 'low', category: 'debug', difficulty: 7, status: 'done', tokens: { in: 1, out: 1, cached: 0, write: 0, v: 2 }, durationMs: 1, smokeId: 'debug-7-single',
    });
    appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts: old, taskId: 'single-pass-aged-0', verdict: 'pass' });
    const cell = sc.summarize({ source: 'smoke', shipped: false }).find((g) => g.model === model);
    assert.ok(cell.weightedRated < 1 && cell.weightedRated >= DEFAULTS.scorecard.minSamples); // decayed below one run, still above the bar
    const pick = sc.recommend({ category: 'debug', difficulty: 7, source: 'smoke', summary: [cell] });
    assert.equal(pick?.model, model);
    assert.doesNotMatch(pick.reason, /extrapolated|escalation/);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('escalate picks the highest measured quality, not the next cheap rung', () => {
  // implement@2 after seeding: Terra (1.0, $0.23), Astra (1.0, $1.15), deepseek-chat (1.0, $0) -> value pick is deepseek-chat; escalation ties on quality, then utility -> still deepseek-chat;
  // exclude the free one and Terra: value pick would be a Luna-first ladder, escalation goes straight to Astra alone.
  // That seeding and the list-price config used to be the previous test, now in report.test.mjs.
  const prev = loadConfig();
  saveConfig({ scorecard: { minSamples: 3, providerWeight: { codex: 1, claude: 1, deepseek: 0 }, reservePct: 0, qualityValueUsd: 5 } });
  const ids = [
    ...seed('codex', 'gpt-5.6-luna', 'low', 'implement', 2, ['pass', 'pass', 'pass', 'fixable', 'fail']),
    ...seed('codex', 'gpt-5.6-terra', 'medium', 'implement', 2, ['pass', 'pass', 'pass']),
    ...seed('codex', 'gpt-6-astra', 'medium', 'implement', 2, ['pass', 'pass', 'pass']),
    ...seed('deepseek', 'deepseek-chat', null, 'implement', 2, ['pass', 'pass', 'pass']),
  ];
  try {
    const r = sc.recommend({ category: 'implement', difficulty: 2, exclude: ['deepseek:deepseek-chat', 'codex:gpt-5.6-terra'], escalate: true });
    assert.deepEqual(r.plan.steps, ['codex:gpt-6-astra:medium']);
    assert.match(r.reason, /escalation/);
  } finally {
    for (const id of ids) sc.voidTask(id, 'fixture moved with the value test');
    saveConfig(prev);
  }
});

test('escalation ranks live evidence count across classes', () => {
  saveConfig({ scorecard: { qualityValueUsd: 5, reservePct: 0, providerWeight: { deepseek: 0, codex: 0.6, claude: 1 }, classes: { codex: 'subscription', deepseek: 'free' }, classOrder: ['free', 'included', 'subscription', 'conductor', 'api'], classCap: { free: 100, included: 100, subscription: 100, conductor: 95, api: 100 } } });
  // A free model with five live attempts and a subscription model with three perfect attempts.
  seed('deepseek', 'deepseek-chat', null, 'test', 2, ['pass', 'pass', 'pass', 'pass', 'fail']);
  seed('codex', 'gpt-6-astra', 'medium', 'test', 2, ['pass', 'pass', 'pass']);
  const value = sc.recommend({ category: 'test', difficulty: 2 });
  assert.equal(value.provider, 'deepseek'); assert.equal(value.class, 'free');       // best value: free class wins the class walk
  const esc = sc.recommend({ category: 'test', difficulty: 2, escalate: true });
  assert.equal(esc.provider, 'deepseek'); assert.equal(esc.model, 'deepseek-chat');             // five live attempts outrank Astra's three
  assert.equal(esc.plan.steps.length, 1);
  assert.match(esc.reason, /escalation: strongest evidence/);
});

test('recommend alternatives exclude the chosen plan', () => {
  const prev = loadConfig().scorecard;
  saveConfig({ scorecard: { qualityValueUsd: 5, reservePct: 0, minSamples: 1, providerWeight: { deepseek: 0, codex: 0.6 }, classes: { deepseek: 'free', codex: 'subscription' }, classOrder: ['subscription', 'free'], classCap: { free: 100, included: 100, subscription: 100, conductor: 95, api: 100 } } });
  try {
    seed('deepseek', 'deepseek-chat', null, 'debug', 2, ['pass', 'pass', 'pass']);
    seed('codex', 'gpt-6-astra', 'medium', 'debug', 2, ['pass', 'pass', 'pass']);
    const r = sc.recommend({ category: 'debug', difficulty: 2 });
    assert.equal(r.provider, 'codex');
    assert.equal(r.class, 'subscription');
    const chosen = r.plan.steps.join(' then on fail ') + ':';
    assert.ok(r.alternatives.length);
    for (const a of r.alternatives) assert.ok(!a.startsWith(chosen), a);
    assert.ok(r.alternatives.some((a) => a.startsWith('deepseek:deepseek-chat')), r.alternatives.join('\n'));
  } finally { saveConfig({ scorecard: prev }); }
});

test('a higher effort within the cost slack dominates the lower effort of the same model', (t) => {
  registryModels(t, [['codex', 'gpt-5.6-sol']]);
  // docs@2: Luna low and Luna max both 3/3 pass at ~$0.023 -> max wins despite equal utility; with slack 0 the cheaper (low) wins again.
  seed('codex', 'gpt-5.6-luna', 'low', 'docs', 2, ['pass', 'pass', 'pass']);
  seed('codex', 'gpt-5.6-luna', 'max', 'docs', 2, ['pass', 'pass', 'pass'], { usage: { input_tokens: 100_100, cached_input_tokens: 50_000, output_tokens: 10_000 } });
  assert.equal(sc.recommend({ category: 'docs', difficulty: 2 }).effort, 'max');
  saveConfig({ scorecard: { effortSlackUsd: 0, effortSlackPct: 0 } });
  assert.equal(sc.recommend({ category: 'docs', difficulty: 2 }).effort, 'low');
  // relative slack: Sol xhigh ~8% dearer than Sol low at docs@3 -> dominates at 10%, not at 5%
  seed('codex', 'gpt-5.6-sol', 'low', 'docs', 3, ['pass', 'pass', 'pass'], { usage: { input_tokens: 100_000, cached_input_tokens: 50_000, output_tokens: 10_000 } });
  seed('codex', 'gpt-5.6-sol', 'xhigh', 'docs', 3, ['pass', 'pass', 'pass'], { usage: { input_tokens: 100_000, cached_input_tokens: 50_000, output_tokens: 11_500 } });
  saveConfig({ scorecard: { effortSlackUsd: 0, effortSlackPct: 10 } });
  assert.equal(sc.recommend({ category: 'docs', difficulty: 3 }).effort, 'xhigh');
  saveConfig({ scorecard: { effortSlackUsd: 0, effortSlackPct: 5 } });
  assert.equal(sc.recommend({ category: 'docs', difficulty: 3 }).effort, 'low');
  saveConfig({ scorecard: { effortSlackUsd: 0.01, effortSlackPct: 10 } });
});

test('thin cells pool harder levels until the sample floor is met', () => {
  // one run each at refactor 2, 3, 4 -> level-2 evidence pools all three; level-4 evidence is a single run (not enough)
  saveConfig({ scorecard: { minSamples: 3 } }); // was left set by 'recommend: value not cheapness' (now in report.test.mjs)
  seed('codex', 'gpt-5.6-terra', 'low', 'refactor', 2, ['pass']);
  seed('codex', 'gpt-5.6-terra', 'low', 'refactor', 3, ['fixable']);
  seed('codex', 'gpt-5.6-terra', 'low', 'refactor', 4, ['pass']);
  const r = sc.recommend({ category: 'refactor', difficulty: 2 });
  assert.equal(r.model, 'gpt-5.6-terra');
  assert.match(r.reason, /levels 2–4 pooled/);
  assert.ok(Math.abs(r.plan.quality - 2.5 / 3) < 1e-9);
  const r4 = sc.recommend({ category: 'refactor', difficulty: 4 });
  assert.match(r4.reason, /extrapolated from level 2/);
  assert.equal((r4.reason.match(/extrapolated/g) || []).length, 1);
  saveConfig({ scorecard: { minSamples: 1 } });
});

test('prior fallback routes by public tier only when enabled', () => {
  assert.equal(sc.recommend({ category: 'design', difficulty: 5 }), null);
  saveConfig({ scorecard: { usePriors: true } });
  const r = sc.recommend({ category: 'design', difficulty: 5 });
  assert.equal(r.model, 'gpt-6-astra'); // only tier A among the seeded registry models with a price (Astra $10/$50)
  assert.match(r.reason, /prior only/);
  assert.equal(sc.recommend({ category: 'design', difficulty: 2 }).model, 'deepseek-chat'); // reason tier B covers 3; cheapest priced (deepseek-chat: tier D)
  assert.equal(sc.recommend({ category: 'summarize', difficulty: 2 }).model, 'deepseek-chat'); // Luna's read tier is D: long-context recall
  assert.equal(sc.recommend({ category: 'design', difficulty: 1 }).provider, 'deepseek');    // tier D covers 1; $0
  saveConfig({ scorecard: { usePriors: false } });
});

test('cold-start effort scales with difficulty, clamped to the model\'s efforts', () => {
  const full = ['low', 'medium', 'high', 'xhigh', 'max'];
  assert.equal(sc.priorEffort(full, 1), 'low');
  assert.equal(sc.priorEffort(full, 2), 'medium');
  assert.equal(sc.priorEffort(full, 3), 'medium');
  assert.equal(sc.priorEffort(full, 4), 'high');   // the bug: a hard cold-start task now gets high, not a hardcoded medium
  assert.equal(sc.priorEffort(full, 5), 'xhigh');
  assert.equal(sc.priorEffort(['low', 'medium'], 4), 'medium'); // clamped to what the model actually offers
  assert.equal(sc.priorEffort(['high', 'max'], 2), 'high');     // nothing at/below the target -> lowest available
  assert.equal(sc.priorEffort([], 4), null);
});

test('smoke repeats use pass^k task cells, ignore voids, and leave live cells unchanged', (t) => {
  const models = ['consistency-all', 'consistency-flaky', 'consistency-void', 'consistency-cell', 'consistency-run-flaky'];
  registryModels(t, models.map((id) => ['codex', id]));
  let id = 0;
  const smoke = (model, smokeId, verdict, category = 'read', difficulty = 1) => {
    const taskId = `consistency-${++id}`;
    run({ id: taskId, source: 'smoke', model, smokeId, category, difficulty });
    if (verdict === 'void') sc.voidTask(taskId, 'test harness');
    else sc.rateTask(taskId, verdict);
  };
  for (let i = 0; i < 3; i++) smoke('consistency-all', 'read-1', 'pass');
  smoke('consistency-flaky', 'read-1', 'pass'); smoke('consistency-flaky', 'read-1', 'pass'); smoke('consistency-flaky', 'read-1', 'fail');
  smoke('consistency-void', 'read-1', 'pass'); smoke('consistency-void', 'read-1', 'void');
  smoke('consistency-cell', 'read-1', 'pass'); smoke('consistency-cell', 'read-1', 'pass');
  smoke('consistency-cell', 'read-2', 'fail'); smoke('consistency-cell', 'read-2', 'fail');
  smoke('consistency-run-flaky', 'read-1', 'pass'); smoke('consistency-run-flaky', 'read-1', 'fail');
  smoke('consistency-run-flaky', 'read-2', 'pass'); smoke('consistency-run-flaky', 'read-2', 'fail');
  run({ id: 'consistency-live', source: 'live', model: 'consistency-all', category: 'read', difficulty: 1 }); sc.rateTask('consistency-live', 'pass');

  const rows = sc.summarize({ source: 'smoke', shipped: false });
  const row = (model) => rows.find((g) => g.model === model && g.category === 'read' && g.difficulty === 1);
  assert.deepEqual(
    ((() => { const g = row('consistency-all'); return { rated: g.rated, pass: g.pass, fail: g.fail, quality: g.quality, consistency: g.consistency, repeats: g.repeats }; })()),
    { rated: 3, pass: 1, fail: 0, quality: 1, consistency: 1, repeats: { min: 3, max: 3 } },
  );
  const flaky = row('consistency-flaky');
  assert.equal(flaky.rated, 3); assert.equal(flaky.pass, 0); assert.equal(flaky.fail, 1); assert.equal(flaky.quality, 0); assert.equal(flaky.consistency, 2 / 3); assert.deepEqual(flaky.repeats, { min: 3, max: 3 });
  const voided = row('consistency-void');
  assert.equal(voided.rated, 1); assert.equal(voided.pass, 1); assert.equal(voided.consistency, 1); assert.deepEqual(voided.repeats, { min: 1, max: 1 });
  const cell = row('consistency-cell');
  assert.equal(cell.rated, 4); assert.equal(cell.pass, 1); assert.equal(cell.fail, 1); assert.equal(cell.quality, 0.5); assert.equal(cell.consistency, 0.5); assert.deepEqual(cell.repeats, { min: 2, max: 2 });
  const live = sc.summarize({ source: 'live', shipped: false }).find((g) => g.model === 'consistency-all');
  assert.equal(live.quality, 1); assert.equal(live.consistency, null); assert.equal(live.repeats, null);

  const previous = loadConfig();
  try {
    saveConfig({ scorecard: { shippedBatteries: false, quality: 0.5, minSamples: 1, classOrder: ['subscription'], classes: { codex: 'subscription' } } });
    const candidates = rows.filter((g) => ['consistency-cell', 'consistency-run-flaky'].includes(g.model));
    const pick = sc.recommend({ category: 'read', difficulty: 1, source: 'smoke', summary: candidates });
    assert.equal(pick?.model, 'consistency-cell');
  } finally { saveConfig(previous); }
});

test('provider weight: included subscriptions are near-free until their window fills; blocked providers are never picked', async () => {
  seed('codex', 'gpt-5.6-terra', 'low', 'review', 2, ['pass', 'pass', 'pass']);                       // list ~$0.23 -> weighted 0.046 at 0.2
  saveConfig({ scorecard: { prices: { 'deepseek:deepseek-flash': { in: 0.3, out: 1.2, cached: 0.006 } }, providerWeight: { codex: 0.2, deepseek: 1 }, reservePct: 0, classes: { codex: 'api', deepseek: 'api' } } }); // same class: compare on weighted value
  seed('deepseek', 'deepseek-flash', null, 'review', 2, ['pass', 'pass', 'pass']);                     // list ~$0.027 at full weight
  assert.equal(sc.providerWeight('codex'), 0.2);
  assert.equal(sc.providerWeight('deepseek'), 1);
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'deepseek');             // 0.027 < 0.046
  saveConfig({ scorecard: { providerWeight: { codex: 0.05 } } });
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'codex');                // 0.0115 < 0.027
  const lim = await import('../../core/limits.mjs');
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', label: 'Codex weekly', usedPercent: 90, resetsAt: Date.now() + 3.6e6 }] };
  assert.equal(sc.providerWeight('codex'), 1);                                                        // quota pressure -> full price
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'deepseek');
  lim.getLimits().providers.deepseek = { provider: 'deepseek', blocked: true, blockedUntil: Date.now() + 3.6e6, windows: [] };
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'codex');                // blocked provider excluded outright
  lim.getLimits().providers.deepseek = { provider: 'deepseek', blocked: false, windows: [] };
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] };
  saveConfig({ scorecard: { providerWeight: { deepseek: 0, codex: 0.2, antigravity: 0.2, grok: 0.2, claude: 1 }, classes: { codex: 'subscription', deepseek: 'api' } } });
});

test('default reservation holds capacity proven at high levels back for high levels; the cheap tier does the grunt work', () => {
  // Two providers with identical list cost and quality at level 1: antigravity (weight 0.1, ceiling 1) vs codex Terra (weight 0.6, ceiling 4).
  saveConfig({ scorecard: { prices: { 'antigravity:flash': { in: 2, out: 12, cached: 0.2 } }, providerWeight: { antigravity: 0.1, codex: 0.6, claude: 1, deepseek: 0 }, reservePct: null } });
  seed('antigravity', 'flash', null, 'docs', 1, ['pass', 'pass', 'pass']);
  seed('codex', 'gpt-5.6-terra', 'low', 'docs', 1, ['pass', 'pass', 'pass']);
  seed('codex', 'gpt-5.6-terra', 'low', 'docs', 4, ['pass', 'pass', 'pass']);
  const r1 = sc.recommend({ category: 'docs', difficulty: 1 });
  assert.equal(r1.provider, 'antigravity');
  assert.match(sc.recommend({ category: 'docs', difficulty: 1, exclude: ['antigravity:flash'] }).reason, /reserve ×1\.9/); // 1 + 0.5 × 0.6 × (4 − 1)
  assert.equal(sc.recommend({ category: 'docs', difficulty: 4 }).provider, 'codex');                                       // only Terra is proven at 4; no reserve premium there
  // when antigravity proves level 4 too, it earns the same reservation (nothing hard-coded to a name)
  seed('antigravity', 'flash', null, 'docs', 4, ['pass', 'pass', 'pass']);
  assert.equal(sc.recommend({ category: 'docs', difficulty: 4 }).provider, 'antigravity');
  saveConfig({ scorecard: { providerWeight: { antigravity: 0.1, grok: 0.1, deepseek: 0.3, codex: 0.6, claude: 1 }, classes: { codex: 'subscription' } } });
});

test('class walk: the first budget class proven at the level wins; capped classes are skipped; APIs only with overflow', async () => {
  saveConfig({ scorecard: { classes: { codex: 'subscription' }, classOrder: ['free', 'included', 'subscription', 'conductor', 'api'], classCap: { included: 95, subscription: 80, conductor: 95 }, reservePct: 0, prices: { 'antigravity:flash': { in: 2, out: 12, cached: 0.2 }, 'deepseek:deepseek-flash': { in: 0.3, out: 1.2, cached: 0.006 } } } });
  assert.equal(sc.providerClass('antigravity'), 'included');
  assert.equal(sc.providerClass('codex'), 'subscription');
  assert.equal(sc.providerClass('claude'), 'conductor');
  assert.equal(sc.providerClass('deepseek'), 'api');
  const lim = await import('../../core/limits.mjs');
  lim.getLimits().providers.antigravity = { provider: 'antigravity', windows: [] };
  // refactor@2: antigravity (included) proven at 2, codex Terra proven at 2 and 4, deepseek proven at 2 but cheapest of all
  seed('antigravity', 'flash', null, 'refactor', 2, ['pass', 'pass', 'pass']);
  seed('codex', 'gpt-5.6-terra', 'low', 'refactor', 2, ['pass', 'pass', 'pass']);
  seed('codex', 'gpt-5.6-terra', 'low', 'refactor', 4, ['pass', 'pass', 'pass']);
  seed('deepseek', 'deepseek-flash', null, 'refactor', 2, ['pass', 'pass', 'pass']);
  let r = sc.recommend({ category: 'refactor', difficulty: 2 });
  assert.equal(r.provider, 'antigravity'); assert.equal(r.class, 'included');            // included beats subscription and API regardless of price
  r = sc.recommend({ category: 'refactor', difficulty: 4 });
  assert.equal(r.provider, 'codex'); assert.equal(r.class, 'subscription');              // only Codex is proven at 4
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 85, resetsAt: Date.now() + 3.6e6 }] };
  assert.equal(sc.recommend({ category: 'refactor', difficulty: 4 }), null);               // Codex past its 80% cap, APIs off -> nothing (conductor takes it)
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] };
  lim.getLimits().providers.antigravity = { provider: 'antigravity', windows: [{ id: 'g', usedPercent: 97, resetsAt: Date.now() + 3.6e6 }] };
  r = sc.recommend({ category: 'refactor', difficulty: 2 });
  assert.equal(r.provider, 'codex');                                                       // included class capped -> next class
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 85, resetsAt: Date.now() + 3.6e6 }] };
  assert.equal(sc.recommend({ category: 'refactor', difficulty: 2 }), null);               // both capped, overflow off
  assert.equal(sc.recommend({ category: 'refactor', difficulty: 2, overflowApi: true }).provider, 'deepseek'); // overflow on -> API class
  lim.getLimits().providers.antigravity = { provider: 'antigravity', windows: [] };
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] };
  saveConfig({ scorecard: { reservePct: 0.5, classes: { deepseek: 'free' }, classCap: { free: 100, included: 100, subscription: 100, conductor: 95, api: 100 } } });
});

test("the conductor's plan is capped on its session window only; weekly (Fable weekly included) may run to 100%", async () => {
  const lim = await import('../../core/limits.mjs');
  lim.getLimits().providers.claude = { provider: 'claude', windows: [{ id: 'claude:5h', label: '5-hour', usedPercent: 50 }, { id: 'claude:w', label: 'weekly', usedPercent: 99 }, { id: 'claude:wf', label: 'weekly Fable', usedPercent: 100 }] };
  assert.equal(sc.providerClass('claude'), 'conductor');
  assert.equal(sc.providerAvailable('claude', { model: 'opus' }), true);
  assert.equal(sc.providerAvailable('claude', { model: 'fable' }), false);
  lim.getLimits().providers.claude.windows[0].usedPercent = 96;
  assert.equal(sc.providerAvailable('claude'), false);
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', label: 'Codex weekly', usedPercent: 99, resetsAt: 1000 }] };
  assert.equal(sc.providerAvailable('codex'), true);   // subscriptions run to 100%
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] };
  delete lim.getLimits().providers.claude;
});

test('conductor selection rejects exhausted or rejected scoped weekly windows, but allows other groups and expired windows', async () => {
  const { getLimits, noteRateLimitEvent } = await import('../../core/limits.mjs');
  const previous = getLimits().providers.claude;
  const scorecard = loadConfig().scorecard;
  const pick = (model) => sc.recommend({ category: 'other', difficulty: 2, providers: ['claude'], exclude: [model === 'opus' ? 'claude:sonnet' : 'claude:opus'] });
  try {
    saveConfig({ scorecard: { usePriors: false, classes: { claude: 'conductor' }, classCap: { conductor: 95 } } });
    seed('claude', 'opus', null, 'other', 2, ['pass', 'pass', 'pass']);
    seed('claude', 'sonnet', null, 'other', 2, ['pass', 'pass', 'pass']);
    getLimits().providers.claude = { provider: 'claude', blocked: false, windows: [
      { id: 'five_hour', label: '5-hour', usedPercent: 40 },
      { id: 'seven_day_opus', label: 'weekly Opus', models: 'opus', usedPercent: 100, resetsAt: Date.now() + 60_000 },
    ] };
    assert.equal(pick('opus'), null);
    assert.equal(pick('sonnet').model, 'sonnet');
    getLimits().providers.claude.windows[1].usedPercent = 99;
    assert.equal(pick('opus').model, 'opus');
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: Date.now() + 60_000 });
    assert.equal(pick('opus'), null);
    assert.equal(pick('sonnet').model, 'sonnet');
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_opus', utilization: 1, resetsAt: Date.now() - 1 });
    assert.equal(pick('opus').model, 'opus');
    getLimits().providers.claude.windows[0] = { id: 'five_hour', label: '5-hour', usedPercent: 100, resetsAt: Date.now() - 1 };
    assert.equal(pick('opus').model, 'opus');
  } finally { getLimits().providers.claude = previous; saveConfig({ scorecard }); }
});

test('a hand-routed model without an effort gets the higher of the configured default and the difficulty target', () => {
  const reg = { models: [{ provider: 'codex', id: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, { provider: 'antigravity', id: 'gemini-3.8-flash-low', efforts: [] }, { provider: 'antigravity', id: 'gemini-3.8-flash', efforts: ['low', 'medium', 'high'] }] };
  assert.equal(sc.effortForTask({ provider: 'codex', model: 'gpt-6-astra', difficulty: 4, defaultEffort: 'medium', reg }), 'high');   // the bug: medium default, hard task
  assert.equal(sc.effortForTask({ provider: 'codex', model: 'gpt-6-astra', difficulty: 2, defaultEffort: 'high', reg }), 'high');     // never below the configured default
  assert.equal(sc.effortForTask({ provider: 'codex', model: 'gpt-6-astra', difficulty: 5, defaultEffort: 'high', reg }), 'xhigh');
  assert.equal(sc.effortForTask({ provider: 'antigravity', model: 'gemini-3.8-flash-low', difficulty: 4, defaultEffort: 'high', reg }), null); // no effort dimension: never carries an effort (agy bakes it into the id)
  assert.equal(sc.effortForTask({ provider: 'antigravity', model: 'gemini-3.8-flash', difficulty: 4, defaultEffort: 'medium', reg }), 'high'); // collapsed family: effort scales with difficulty, clamped to low/medium/high
  assert.equal(sc.effortForTask({ provider: 'codex', model: 'nope', difficulty: 4, defaultEffort: null, reg }), null);
});

test('visual work: every automatic route honors the recorded-pass gate; nothing weaker when no pass is available', (t) => {
  const cfg = loadConfig().scorecard;
  const reg = getModels(), previous = reg.models;
  // The shared registry lists low/medium only: give the Codex models the efforts that passed, plus the live gpt-6-sol.
  const efforts = ['low', 'medium', 'high', 'xhigh', 'ultra'];
  reg.models = [...previous.map((m) => (m.provider === 'codex' ? { ...m, efforts } : m)), { provider: 'codex', id: 'gpt-6-sol', kind: 'agent', efforts }];
  t.after(() => { reg.models = previous; saveConfig({ scorecard: cfg }); });
  saveConfig({ scorecard: { usePriors: false, reservePct: 0 } });
  const pick = (r) => r && sc.selOf(r);

  // Cold start with priors off: the recorded pass at its effort, and nothing when it is unavailable.
  assert.equal(pick(sc.recommend({ category: 'modeling', difficulty: 4, summary: [] })), 'codex:gpt-6-astra:ultra');
  assert.equal(pick(sc.recommend({ category: 'drafting', difficulty: 4, summary: [] })), 'codex:gpt-6-astra:xhigh');
  for (const category of ['modeling', 'drafting']) assert.equal(sc.recommend({ category, difficulty: 4, summary: [], exclude: ['codex:gpt-6-astra'] }), null);
  assert.equal(sc.recommend({ category: 'design', difficulty: 4, summary: [] }), null, 'other categories keep the priors switch');

  // Measured: a cheap unbenchmarked model, a cheaper effort of Astra and a benched ladder candidate, all rated,
  // lose to Astra at ultra. `design` gets the same data ungated, as the control.
  const source = 'modeling-gate';
  const small = { input_tokens: 10_000, cached_input_tokens: 5_000, output_tokens: 1_000 };
  const rated = (model, effort, category, verdict, usage = USAGE) => {
    for (let i = 0; i < 3; i++) { const id = `${source}-${++n}`; run({ id, source, model, effort, category, difficulty: 2, result: { usage, durationMs: 1000 } }); sc.rateTask(id, verdict); }
  };
  for (const category of ['modeling', 'design']) {
    rated('gpt-5.6-luna', 'medium', category, 'pass', small);
    rated('gpt-6-astra', 'medium', category, 'pass', small);
    rated('gpt-5.6-terra', 'medium', category, 'fixable', small);
    rated('gpt-6-astra', 'ultra', category, 'pass');
  }
  assert.notEqual(pick(sc.recommend({ category: 'design', difficulty: 2, source })), 'codex:gpt-6-astra:ultra', 'control: ungated value picks a cheaper plan');
  const measured = sc.recommend({ category: 'modeling', difficulty: 2, source });
  assert.equal(pick(measured), 'codex:gpt-6-astra:ultra');
  assert.deepEqual(measured.plan.steps, ['codex:gpt-6-astra:ultra'], 'no cheap-first ladder');
  const extrapolated = sc.recommend({ category: 'modeling', difficulty: 4, source });
  assert.equal(pick(extrapolated), 'codex:gpt-6-astra:ultra');
  assert.match(extrapolated.reason, /extrapolated from level 2/);
  assert.equal(sc.recommend({ category: 'modeling', difficulty: 2, source, exclude: ['codex:gpt-6-astra'] }), null, 'rated passes of other models do not make them routable');
  // Drafting routes on its own verdict: Astra at xhigh, not at the modeling effort, and not a cheaper rated model.
  rated('gpt-5.6-luna', 'medium', 'drafting', 'pass', small);
  rated('gpt-6-astra', 'ultra', 'drafting', 'pass', small);
  rated('gpt-6-astra', 'xhigh', 'drafting', 'pass');
  assert.equal(pick(sc.recommend({ category: 'drafting', difficulty: 2, source })), 'codex:gpt-6-astra:xhigh');
});

test('GP2-02: visual routes require the passing effort in the supplied registry', async (t) => {
  const cfg = loadConfig().scorecard, globalReg = getModels();
  const previous = { models: globalReg.models, providers: globalReg.providers };
  const efforts = ['low', 'medium', 'high', 'xhigh', 'ultra'];
  const astra = { provider: 'codex', id: 'gpt-6-astra', kind: 'agent', efforts };
  Object.assign(globalReg, { models: [astra], providers: { codex: { status: 'ok' } } });
  saveConfig({ scorecard: { usePriors: false } });
  t.after(() => { Object.assign(globalReg, previous); saveConfig({ scorecard: cfg }); });
  for (const [category, effort] of [['drafting', 'xhigh'], ['modeling', 'ultra']]) await t.test(category, () => {
    const sel = `codex:gpt-6-astra:${effort}`;
    const cell = { sel, steps: 1, provider: 'codex', model: astra.id, effort, category, difficulty: 2,
      rated: cfg.minSamples, n: cfg.minSamples, quality: 1, accept: 1, avgUsd: 0.01, avgDurationMs: 0 };
    const reg = { models: [{ ...astra }], providers: { codex: { status: 'ok' } } };
    for (const route of [
      { name: 'measured', summary: [cell], difficulty: 2 },
      { name: 'extrapolated', summary: [cell], difficulty: 4 },
      { name: 'prior', summary: [], difficulty: 2 },
    ]) for (const escalate of [false, true]) {
      const request = { ...route, category, escalate, reg };
      globalReg.models = [{ ...astra, efforts: efforts.filter((e) => e !== effort) }];
      reg.models = [{ ...astra }];
      const supported = sc.recommend(request);
      assert.ok(supported, `${route.name}, escalate=${escalate}: use supplied support`);
      assert.equal(sc.selOf(supported), sel);
      assert.equal(!!supported.plan, route.name !== 'prior');
      globalReg.models = [astra];
      for (const offered of [efforts.filter((e) => e !== effort), [], undefined]) {
        reg.models = [{ ...astra, efforts: offered }];
        assert.equal(sc.recommend(request), null, `${route.name}, escalate=${escalate}: unsupported effort ${offered}`);
      }
    }
    // Measured resolved aliases use the same registry lookup as task effort normalization.
    reg.models = [{ ...astra, id: 'astra-alias', resolved: astra.id }];
    assert.equal(sc.selOf(sc.recommend({ category, summary: [cell], reg })), sel);
    reg.models[0].efforts = [];
    assert.equal(sc.recommend({ category, summary: [cell], reg }), null);
  });
});

test('GP2-02: every visual ladder step needs supported effort; supported alternatives remain eligible', () => {
  const cfg = loadConfig().scorecard;
  const models = ['gpt-6-astra', 'gpt-5.6-sol'].map((id) => ({ provider: 'codex', id, kind: 'agent', efforts: ['high', 'ultra'] }));
  const reg = { models, providers: { codex: { status: 'ok' } } };
  const selections = models.map((m) => `codex:${m.id}:ultra`);
  const cell = (steps, quality = 1, avgUsd = 0.01) => ({ sel: steps.join('>'), steps: steps.length,
    provider: 'codex', model: steps[0].split(':')[1], effort: 'ultra', category: 'modeling', difficulty: 2,
    rated: cfg.minSamples, n: cfg.minSamples, quality, accept: quality, avgUsd, avgDurationMs: 0 });
  const pick = (summary, options = {}) => sc.recommend({ category: 'modeling', summary, reg, ...options });
  for (const steps of [selections, [...selections].reverse()]) {
    reg.models = models;
    const observed = [cell(steps)];
    assert.deepEqual(pick(observed)?.plan?.steps, steps);
    for (const unsupported of models) {
      reg.models = models.map((m) => m === unsupported ? { ...m, efforts: ['high'] } : m);
      const alternative = selections.find((sel) => !sel.includes(unsupported.id));
      assert.equal(sc.selOf(pick(observed)), alternative, 'reject observed ladder and use supported prior');
      assert.equal(sc.selOf(pick([...observed, cell([alternative])])), alternative, 'supported measured single wins');
    }
    reg.models = models;
    const estimated = [cell([steps[0]], 0.5, 0), cell([steps[1]], 1, cfg.qualityValueUsd)];
    assert.deepEqual(pick(estimated)?.plan?.steps, steps);
    assert.equal(pick(estimated).plan.estimated, true);
    for (const unsupported of models) {
      reg.models = models.map((m) => m === unsupported ? { ...m, efforts: ['high'] } : m);
      const result = pick(estimated);
      assert.ok(!result || (result.plan ? result.plan.steps.every((sel) => !sel.includes(unsupported.id)) : result.model !== unsupported.id), 'estimated ladder drops unsupported step');
    }
    reg.models = models.map((m) => ({ ...m, efforts: ['high'] }));
    for (const summary of [observed, estimated]) for (const escalate of [false, true]) {
      assert.equal(pick(summary, { escalate }), null, 'no unsupported first or fallback step');
    }
  }
});

test('wasteDiscount: a soon-resetting subscription window is discounted regardless of used percent', async () => {
  const { wasteDiscount } = await import('../../core/scorecard.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  const cfg = { ...loadConfig().scorecard, wasteSteps: [[72, 0.5], [48, 0.8], [24, 1]], wasteStrength: 1, classes: { codex: 'subscription' } };
  const lim = getLimits();
  const wk = (usedPercent, hoursToReset) => { lim.providers.codex = { windows: [{ id: 'codex:primary', label: 'Codex weekly', usedPercent, resetsAt: Date.now() + hoursToReset * 3600e3, windowMinutes: 10080 }] }; };
  wk(20, 6); assert.equal(wasteDiscount('codex', cfg, null), 0, 'inside 24 hours is free');
  wk(20, 100); assert.equal(wasteDiscount('codex', cfg, null), 1, 'far from reset -> no discount');
  wk(95, 6); assert.equal(wasteDiscount('codex', cfg, null), 0, 'used percent does not scale the discount');
  for (const used of [-50, -Infinity, 0, 100, 150]) {
    wk(used, 0.001);
    const factor = wasteDiscount('codex', cfg, null);
    assert.ok(factor >= 1 - cfg.wasteStrength && factor <= 1, `usage ${used}: discount must remain bounded, got ${factor}`);
  }
  // 5-hour windows churn; they are ignored.
  lim.providers.codex = { windows: [{ id: 'codex:5h', label: '5-hour', usedPercent: 10, resetsAt: Date.now() + 1 * 3600e3, windowMinutes: 300 }] };
  assert.equal(wasteDiscount('codex', cfg, null), 1, '5-hour window is not a waste source');
  // API / conductor classes are never discounted (no wasted quota / keep a buffer).
  assert.equal(wasteDiscount('claude', cfg, null), 1);
  assert.equal(wasteDiscount('xai', { ...cfg, classes: { xai: 'api' } }, null), 1);
});

test('wasteDiscount uses absolute stepped boundaries and strength', async () => {
  const { wasteDiscount } = await import('../../core/scorecard.mjs');
  const { getLimits } = await import('../../core/limits.mjs');
  const limits = getLimits(), previous = limits.providers.codex;
  const now = Date.parse('2026-09-20T12:00:00Z');
  const cfg = { ...loadConfig().scorecard, wasteSteps: [[72, 0.5], [48, 0.8], [24, 1]], wasteStrength: 1, classes: { codex: 'subscription' } };
  const at = (hours, usedPercent = 25) => { limits.providers.codex = { windows: [{ id: 'weekly', label: 'weekly', usedPercent, resetsAt: now + hours * 3600e3, windowMinutes: 10080 }] }; };
  try {
    for (const usedPercent of [0, 50, 99]) {
      at(73, usedPercent); assert.equal(wasteDiscount('codex', cfg, null, now), 1);
      at(71, usedPercent); assert.equal(wasteDiscount('codex', cfg, null, now), 0.5);
      at(47, usedPercent); assert.ok(Math.abs(wasteDiscount('codex', cfg, null, now) - 0.2) < 1e-12);
      at(23, usedPercent); assert.equal(wasteDiscount('codex', cfg, null, now), 0);
    }
    at(23); assert.equal(wasteDiscount('codex', { ...cfg, wasteStrength: 0.5 }, null, now), 0.5);
    assert.equal(wasteDiscount('codex', { ...cfg, wasteStrength: 0 }, null, now), 1);
    at(80); assert.equal(wasteDiscount('codex', { ...cfg, wasteSteps: [[96, 0.5], [48, 0.8], [24, 1]] }, null, now), 0.5);
    at(36); assert.equal(wasteDiscount('codex', { ...cfg, wasteSteps: [[24, 0.5]] }, null, now), 1);
    at(20); assert.equal(wasteDiscount('codex', { ...cfg, wasteSteps: [[24, 1]] }, null, now), 0);
    const scheduled = { ...cfg, classes: { grok: 'included' }, usageResets: { grok: { periodHours: 168, anchorAt: new Date(now + 47 * 3600e3).toISOString() } } };
    assert.ok(Math.abs(wasteDiscount('grok', scheduled, null, now) - 0.2) < 1e-12, 'windowless schedule uses the same steps');
  } finally { limits.providers.codex = previous; }
});

test('nextScheduledReset + wasteDiscount apply to a windowless provider on a configured schedule', async () => {
  const { nextScheduledReset, wasteDiscount } = await import('../../core/scorecard.mjs');
  const cfg = { usageResets: { grok: { periodHours: 24, resetHour: 18 } }, classes: { grok: 'included' }, wasteSteps: [[48, 0.5], [24, 1]], wasteStrength: 0.9, providerWeight: {} };
  const now = Date.parse('2026-09-15T10:00:00'); // local morning; next reset is 18:00 LOCAL today
  const nr = nextScheduledReset('grok', cfg, now);
  assert.ok(nr > now && (nr - now) / 3600e3 < 24, 'next reset stepped forward');
  assert.equal(new Date(nr).getHours(), 18, 'reset is at the configured local wall-clock hour (system timezone)');
  assert.ok(wasteDiscount('grok', cfg, null, now) < 0.5, 'a windowless provider near its scheduled reset is discounted (plow through it)');
  assert.equal(nextScheduledReset('codex', cfg, now), null, 'no schedule configured -> null');
});

test('B1: a winning observed ladder dispatches its exact first worker, including tagged model IDs', (t) => {
  registryModels(t, [['deepseek', 'deepseek-chat:latest']]);
  for (const effort of [null, 'high']) {
    const source = `B1-${effort}`;
    for (const i of [1, 2, 3]) {
      const id = `${source}-${i}`;
      run({ id, source, provider: 'deepseek', model: 'deepseek-chat:latest', effort, category: 'edit' });
      sc.rateTask(id, 'fail');
      run({ id: `${id}-retry`, source, retryOf: id, model: 'gpt-5.6-terra', effort: 'medium', category: 'edit' });
      sc.rateTask(`${id}-retry`, 'pass');
    }
    const r = sc.recommend({ category: 'edit', difficulty: 2, source });
    assert.equal(r.plan.estimated, false);
    assert.deepEqual(r.plan.steps, [`deepseek:deepseek-chat:latest:${effort || 'default'}`, 'codex:gpt-5.6-terra:medium']);
    assert.deepEqual({ provider: r.provider, model: r.model, effort: r.effort }, { provider: 'deepseek', model: 'deepseek-chat:latest', effort });
    assert.deepEqual(r.fallback, { provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium' });
  }
});

test('B6: observed mixed-provider costs are weighted per step, including paid then API and pooled levels', async (t) => {
  registryModels(t, [['claude', 'paid'], ['codex', 'fallback'], ['deepseek', 'local:latest']]);
  const cfg = loadConfig().scorecard;
  const { getLimits } = await import('../../core/limits.mjs');
  const limits = getLimits();
  const previous = { ...limits.providers };
  const now = Date.parse('2026-09-28T16:20:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  try {
    saveConfig({ scorecard: { minSamples: 3, classOrder: ['conductor', 'subscription', 'free'], providerWeight: { claude: 0.5, codex: 0.2, deepseek: 0 }, reservePct: 0.5, hourlyUsd: 3.6, wasteStrength: 0.9, wasteHorizonHours: 48, prices: { 'claude:paid': { in: 1, out: 0, cached: 0 }, 'codex:fallback': { in: 1, out: 0, cached: 0 }, 'deepseek:local:latest': { in: 1, out: 0, cached: 0 } } } });
    limits.providers.claude = { windows: [] };
    limits.providers.deepseek = { windows: [] };
    limits.providers.codex = { windows: [{ id: 'weekly', label: 'weekly', usedPercent: 20, resetsAt: now + 6 * 3600e3 }] };
    for (const provider of ['deepseek', 'codex']) {
      const source = `B6-${provider}`, model = provider === 'deepseek' ? 'local:latest' : 'fallback';
      for (const i of [1, 2, 3]) {
        const id = `${source}-${i}`, difficulty = i === 1 ? 2 : 3;
        run({ id, source, provider: 'claude', model: 'paid', effort: null, category: 'edit', difficulty, result: { usage: { input_tokens: i * 1e6 }, durationMs: i * 1000 } });
        sc.rateTask(id, 'fail');
        run({ id: `${id}-retry`, source, retryOf: id, provider, model, effort: null, category: 'edit', difficulty, result: { usage: { input_tokens: i * 2e6 }, durationMs: i * 2000 } });
        sc.rateTask(`${id}-retry`, 'pass');
        run({ id: `${id}-ceiling`, source, provider: 'claude', model: 'paid', effort: null, category: 'read', difficulty: 5 });
        sc.rateTask(`${id}-ceiling`, 'pass');
      }
      if (provider === 'codex') {
        run({ id: `${source}-single-fail`, source, provider, model, effort: null, category: 'edit', difficulty: 2 });
        sc.rateTask(`${source}-single-fail`, 'fail'); // keep the discounted single outside the quality tie margin
      }
      const summary = sc.summarize({ source });
      const r = sc.recommend({ category: 'edit', difficulty: 2, summary });
      assert.deepEqual(r.plan.steps, ['claude:paid:default', `${provider}:${model}:default`]);
      assert.equal(r.plan.estimated, false);
      const paid = 2 * 0.5 * (1 + 0.5 * 0.5 * (5 - 2)) + 0.002; // hourly is not scaled by weight/reserve/waste
      const fallback = provider === 'deepseek' ? 0.004 : 4 * 0.2 * (1 - 0.9) + 0.004; // inner waste step; thin cells do not establish a provider ceiling
      assert.ok(Math.abs(r.plan.usd - paid - fallback) < 1e-9, `${provider}: ${r.plan.usd} vs ${paid + fallback}`);
      assert.deepEqual(summary.filter((g) => g.steps === 2).map((g) => g.avgUsd), provider === 'deepseek' ? [2, 5] : [3, 7.5], 'display keeps raw shadow dollars');
    }
  } finally {
    saveConfig({ scorecard: cfg });
    limits.providers = previous;
  }
});

test('B4: requested-level failures survive extrapolation and prior fallback', () => {
  const cfg = loadConfig().scorecard;
  const source = 'B4-sole';
  try {
    saveConfig({ scorecard: { usePriors: false } });
    for (const difficulty of [2, 3]) for (const i of [1, 2, 3]) {
      const id = `${source}-${difficulty}-${i}`;
      run({ id, source, effort: 'medium', category: 'edit', difficulty });
      sc.rateTask(id, difficulty === 2 ? 'pass' : 'fail');
    }
    const request = { category: 'edit', difficulty: 3, source, providers: ['codex'] };
    assert.equal(sc.recommend(request), null, 'three level-2 passes cannot override three level-3 failures');
    saveConfig({ scorecard: { usePriors: true } });
    assert.equal(sc.recommend({ ...request, exclude: ['codex:gpt-5.6-terra', 'codex:gpt-6-astra'] }), null, 'priors cannot revive the failed selection');
    const prior = sc.recommend(request);
    assert.equal(prior.model, 'gpt-5.6-terra', 'an unfailed prior candidate remains eligible');
    assert.equal(prior.plan, null);
  } finally {
    saveConfig({ scorecard: cfg });
  }
});

test('B4: extrapolated cheap-first ladders require an unfailed final worker', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { usePriors: false } });
    for (const observed of [false, true]) {
      const source = `B4-ladder-${observed}`;
      for (const i of [1, 2, 3]) {
        const id = `${source}-${i}`;
        run({ id, source, provider: 'deepseek', model: 'deepseek-chat', effort: null, category: 'edit', difficulty: 2 });
        sc.rateTask(id, observed ? 'fail' : 'pass');
        run({ id: `${id}-fallback`, source, retryOf: observed ? id : null, model: 'gpt-5.6-terra', effort: 'medium', category: 'edit', difficulty: 2 });
        sc.rateTask(`${id}-fallback`, 'pass');
        run({ id: `${id}-fail`, source, provider: 'deepseek', model: 'deepseek-chat', effort: null, category: 'edit', difficulty: 3 });
        sc.rateTask(`${id}-fail`, 'fail');
      }
      const request = { category: 'edit', difficulty: 3, source };
      const ladder = sc.recommend(request);
      assert.deepEqual(ladder.plan.steps, ['deepseek:deepseek-chat:default', 'codex:gpt-5.6-terra:medium']);
      assert.equal(ladder.plan.estimated, !observed);
      assert.match(ladder.reason, /extrapolated from level 2/);
      for (const i of [1, 2, 3]) {
        const id = `${source}-failed-final-${i}`;
        run({ id, source, model: 'gpt-5.6-terra', effort: 'medium', category: 'edit', difficulty: 3 });
        sc.rateTask(id, 'fail');
      }
      assert.equal(sc.recommend(request), null, 'a ladder cannot end with a worker proven to fail the requested level');
    }
  } finally {
    saveConfig({ scorecard: cfg });
  }
});

test('B5: prior fallback honors exact-effort and whole-model exclusions', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { usePriors: true } });
    const request = { category: 'edit', difficulty: 3, summary: [], providers: ['codex'] };
    assert.equal(sc.selOf(sc.recommend(request)), 'codex:gpt-5.6-luna:medium');
    for (const excluded of ['codex:gpt-5.6-luna:medium', 'codex:gpt-5.6-luna']) {
      assert.equal(sc.selOf(sc.recommend({ ...request, exclude: [excluded] })), 'codex:gpt-5.6-terra:medium');
    }
    assert.equal(sc.selOf(sc.recommend({ ...request, exclude: ['codex:gpt-5.6-luna:low'] })), 'codex:gpt-5.6-luna:medium', 'another effort is not excluded');
    const local = { ...request, difficulty: 1, providers: ['deepseek'] };
    assert.equal(sc.selOf(sc.recommend(local)), 'deepseek:deepseek-chat:default');
    assert.equal(sc.recommend({ ...local, exclude: ['deepseek:deepseek-chat:default'] }).model, 'deepseek-flash', 'models without effort use the canonical default selection');
  } finally {
    saveConfig({ scorecard: cfg });
  }
});

test('R2H1: tagged measured selections honor whole-model exclusions and scoped quotas', async (t) => {
  registryModels(t, [['deepseek', 'deepseek-chat:latest']]);
  const { getLimits } = await import('../../core/limits.mjs');
  const limits = getLimits(), previous = limits.providers.deepseek;
  const cfg = loadConfig().scorecard;
  const source = 'R2H1';
  try {
    saveConfig({ scorecard: { usePriors: false } });
    limits.providers.deepseek = { windows: [] };
    for (const i of [1, 2, 3]) {
      run({ id: `${source}-${i}`, source, provider: 'deepseek', model: 'deepseek-chat:latest', effort: 'high' });
      sc.rateTask(`${source}-${i}`, 'pass');
      run({ id: `${source}-other-${i}`, source, provider: 'deepseek', model: 'deepseek-chat', effort: null });
      sc.rateTask(`${source}-other-${i}`, 'pass');
    }
    const request = { category: 'implement', difficulty: 2, source, exclude: ['deepseek:deepseek-chat'] };
    assert.equal(sc.recommend(request).model, 'deepseek-chat:latest');
    for (const excluded of ['deepseek:deepseek-chat:latest', 'deepseek:deepseek-chat:latest:high']) {
      assert.equal(sc.recommend({ ...request, exclude: [...request.exclude, excluded] }), null);
    }
    assert.equal(sc.recommend({ ...request, exclude: [...request.exclude, 'deepseek:deepseek-chat:latest:low'] }).model, 'deepseek-chat:latest');
    limits.providers.deepseek.windows = [{ id: 'tagged', models: ':latest$', usedPercent: 100, resetsAt: Date.now() + 60_000 }];
    assert.equal(sc.recommend(request), null, 'full tagged-model window blocks the measured selection');
    assert.equal(sc.recommend({ ...request, exclude: [] }).model, 'deepseek-chat', 'unmetered model stays usable');
    limits.providers.deepseek.windows[0].usedPercent = 0;
    limits.providers.deepseek.windows[0].status = 'rejected';
    assert.equal(sc.recommend(request), null, 'rejected scoped window also blocks');
    limits.providers.deepseek.windows[0].resetsAt = Date.now() - 1;
    assert.equal(sc.recommend(request).model, 'deepseek-chat:latest', 'expired scoped windows do not block');
  } finally { limits.providers.deepseek = previous; saveConfig({ scorecard: cfg }); }
});

test('R2B2: every measured plan step must remain usable in the registry, including aliases', async () => {
  const { getModels } = await import('../../core/models.mjs');
// Explicit fixture class and zero price keep routing/cost scenarios independent of a local provider.
saveConfig({ scorecard: { classes: { codex: 'subscription', deepseek: 'free' }, prices: { 'deepseek:deepseek-chat': { in: 0, out: 0, cached: 0 } } } });
  const { getLimits } = await import('../../core/limits.mjs');
  const reg = getModels(), limits = getLimits();
  const previous = { models: reg.models, providers: reg.providers, limits: limits.providers };
  const cfg = loadConfig().scorecard;
  const local = 'deepseek:deepseek-chat:default', remote = 'codex:gpt-5.6-terra:medium';
  const cell = (steps) => ({ sel: steps.join('>'), steps: steps.length, provider: steps.length === 1 ? steps[0].split(':')[0] : undefined,
    category: 'edit', difficulty: 2, rated: 3, n: 3, quality: 1, accept: 1, avgUsd: 0.01, avgDurationMs: 0 });
  try {
    saveConfig({ scorecard: { usePriors: false } });
    reg.models = [{ provider: 'deepseek', id: 'deepseek-chat', kind: 'agent' }, { provider: 'codex', id: 'terra-alias', resolved: 'gpt-5.6-terra', kind: 'agent' }];
    reg.providers = { deepseek: { status: 'ok' }, codex: { status: 'ok' } };
    limits.providers = {};
    const pick = (summary) => sc.recommend({ category: 'edit', difficulty: 2, summary });
    assert.equal(pick([cell([remote])]).model, 'gpt-5.6-terra', 'resolved registry aliases are usable');
    for (const steps of [[local], [local, remote], [remote, local]]) {
      const summary = [cell(steps)];
      assert.ok(pick(summary), `available plan ${steps}`);
      reg.providers.deepseek.status = 'unavailable';
      assert.equal(pick(summary), null, `unavailable provider anywhere in ${steps}`);
      reg.providers.deepseek.status = 'error';
      assert.ok(pick(summary), 'transient errors retain cached measured models');
      delete reg.providers.deepseek;
      assert.ok(pick(summary), 'unknown provider status does not reject a listed measured model');
      reg.providers.deepseek = { status: 'ok' };
      const model = reg.models.shift();
      assert.equal(pick(summary), null, `removed model anywhere in ${steps}`);
      reg.models.unshift(model);
      model.kind = 'image';
      assert.equal(pick(summary), null, 'non-agent entries cannot execute a measured worker plan');
      model.kind = 'agent';
    }
    reg.providers.deepseek.status = 'unavailable';
    assert.equal(pick([cell([local]), cell([remote])]).provider, 'codex', 'qualified available alternative wins');
  } finally { reg.models = previous.models; reg.providers = previous.providers; limits.providers = previous.limits; saveConfig({ scorecard: cfg }); }
});

test('a ladder with an unpriced step ranks as cost unknown after priced plans', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0, hourlyUsd: 0, providerWeight: { codex: 1 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    const ladder = {
      sel: 'codex:gpt-5.6-luna:low>codex:gpt-5.6-terra:medium', steps: 2,
      category: 'search', difficulty: 2, rated: 3, n: 3, quality: 0.95, accept: 0.95,
      avgUsd: 0.02, avgDurationMs: 0,
      stepCosts: [
        { sel: 'codex:gpt-5.6-luna:low', avgUsd: 0.02, avgDurationMs: 0 },
        { sel: 'codex:gpt-5.6-terra:medium', avgUsd: null, avgDurationMs: 0 },
      ],
    };
    const priced = {
      sel: 'codex:gpt-6-astra:medium', steps: 1, provider: 'codex', model: 'gpt-6-astra', effort: 'medium',
      category: 'search', difficulty: 2, rated: 3, n: 3, quality: 0.95, accept: 0.95, avgUsd: 0.50, avgDurationMs: 0,
    };
    const both = sc.recommend({ category: 'search', difficulty: 2, summary: [ladder, priced] });
    assert.equal(both.model, 'gpt-6-astra', 'priced single model beats a ladder whose later step has no price');
    assert.equal(both.plan.usd, 0.50);
    assert.doesNotMatch(both.reason, /cost unknown/);
    const only = sc.recommend({ category: 'search', difficulty: 2, summary: [ladder] });
    assert.deepEqual(only.plan.steps, ladder.sel.split('>'));
    assert.equal(only.plan.usd, null);
    assert.match(only.reason, /cost unknown/);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('OB7: unknown-cost plans stay eligible but rank after every priced eligible plan', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0, hourlyUsd: 0, providerWeight: { codex: 1 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    const cell = (model, effort, avgUsd, extra = {}) => ({
      sel: `codex:${model}:${effort}`, steps: 1, provider: 'codex', model, effort,
      category: extra.category || 'search', difficulty: extra.difficulty || 2, rated: 3, n: 3,
      quality: extra.quality ?? 1, accept: extra.accept ?? 1, avgUsd, avgDurationMs: 0,
    });
    const priced = cell('gpt-5.6-luna', 'low', 0.05);
    const unknown = cell('gpt-5.6-terra', 'medium', null);
    const both = sc.recommend({ category: 'search', difficulty: 2, summary: [unknown, priced] });
    assert.equal(both.model, 'gpt-5.6-luna', 'priced plan ranks first even when the unknown-cost plan has equal quality');
    assert.doesNotMatch(both.reason, /cost unknown/);
    const only = sc.recommend({ category: 'search', difficulty: 2, summary: [unknown] });
    assert.equal(only.model, 'gpt-5.6-terra');
    assert.equal(only.plan.usd, null);
    assert.match(only.reason, /cost unknown/);
    assert.equal(sc.recommend({ category: 'search', difficulty: 2, summary: [{ ...unknown, quality: 0.5 }] }), null, 'unknown cost does not skip the quality bar');
    const visual = { ...cell('gpt-5.6-luna', 'low', null), category: 'modeling' };
    assert.equal(sc.recommend({ category: 'modeling', difficulty: 2, summary: [visual], exclude: ['codex:gpt-6-astra', 'codex:gpt-5.6-sol'] }), null, 'unknown cost does not bypass the visual pass gate');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('escalate: prior tier breaks an evidence tie before price', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0, hourlyUsd: 0, providerWeight: { codex: 1 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    const cell = (model, effort, avgUsd) => ({
      sel: `codex:${model}:${effort}`, steps: 1, provider: 'codex', model, effort,
      category: 'search', difficulty: 2, rated: 3, n: 3, quality: 1, accept: 1, avgUsd, avgDurationMs: 0,
    });
    const priced = cell('gpt-5.6-luna', 'low', 0.05);
    const unknown = cell('gpt-5.6-terra', 'medium', null);
    const r = sc.recommend({ category: 'search', difficulty: 2, summary: [unknown, priced], escalate: true });
    assert.equal(r.model, 'gpt-5.6-terra', 'Terra\'s stronger search prior wins before price is considered');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B5: provenButCapped honors the caller providers allow-list so a blocked excluded provider does not block extrapolation', async () => {
  const { getLimits } = await import('../../core/limits.mjs');
  const cfg = loadConfig().scorecard;
  const limits = getLimits();
  const previous = limits.providers.codex;
  const source = 'B5-allow';
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0 } });
    for (const i of [1, 2, 3]) {
      run({ id: `${source}-codex-${i}`, source, provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', category: 'implement', difficulty: 4 });
      sc.rateTask(`${source}-codex-${i}`, 'pass');
      run({ id: `${source}-deepseek-${i}`, source, provider: 'deepseek', model: 'deepseek-chat', effort: null, category: 'implement', difficulty: 2 });
      sc.rateTask(`${source}-deepseek-${i}`, 'pass');
    }
    limits.providers.codex = { ...(previous || {}), provider: 'codex', blocked: true, blockedUntil: Date.now() + 3.6e6, windows: previous?.windows || [] };
    const r = sc.recommend({ category: 'implement', difficulty: 4, source, providers: ['deepseek'] });
    assert.equal(r.provider, 'deepseek');
    assert.match(r.reason, /extrapolated from level 2/);
  } finally {
    limits.providers.codex = previous;
    saveConfig({ scorecard: cfg });
  }
});

test('B1: effort dominance uses parseSel so model ids containing a colon still dominate', (t) => {
  registryModels(t, [['deepseek', 'deepseek-chat:latest']]);
  const cfg = loadConfig().scorecard;
  saveConfig({ scorecard: { usePriors: false, reservePct: 0, effortSlackUsd: 0.01, effortSlackPct: 10 } });
  t.after(() => saveConfig({ scorecard: cfg }));
  const cell = (effort) => ({
    sel: `deepseek:deepseek-chat:latest:${effort}`, steps: 1, provider: 'deepseek', model: 'deepseek-chat:latest', effort,
    category: 'docs', difficulty: 1, rated: 3, n: 3, quality: 1, accept: 1, avgUsd: 0, avgDurationMs: 0,
  });
  const r = sc.recommend({ category: 'docs', difficulty: 1, summary: [cell('low'), cell('high')] });
  assert.equal(r.model, 'deepseek-chat:latest');
  assert.equal(r.effort, 'high');
});

test('GP2: a no-usage attempt does not poison group avgUsd or the pick', () => {
  const cfg = loadConfig().scorecard;
  const source = 'GP2-avg';
  const lunaUsd = pr.usdFor({ in: 50_000, cached: 50_000, out: 10_000 }, pr.priceFor('codex', 'gpt-5.6-luna'));
  const terraUsd = pr.usdFor({ in: 50_000, cached: 50_000, out: 10_000 }, pr.priceFor('codex', 'gpt-5.6-terra'));
  try {
    saveConfig({ scorecard: { usePriors: false, minSamples: 3, quality: 0.75, qualityValueUsd: 5, reservePct: 0, hourlyUsd: 0, providerWeight: { codex: 1 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    for (let i = 0; i < 6; i++) {
      run({ id: `${source}-luna-${i}`, source, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'search', difficulty: 2 });
      sc.rateTask(`${source}-luna-${i}`, 'pass');
    }
    run({ id: `${source}-luna-fail`, source, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'search', difficulty: 2, result: { durationMs: 1000 } });
    sc.rateTask(`${source}-luna-fail`, 'fail');
    for (let i = 0; i < 3; i++) {
      run({ id: `${source}-astra-${i}`, source, provider: 'codex', model: 'gpt-6-astra', effort: 'medium', category: 'search', difficulty: 2 });
      sc.rateTask(`${source}-astra-${i}`, 'pass');
    }
    const sum = sc.summarize({ source });
    const luna = sum.find((g) => g.sel === 'codex:gpt-5.6-luna:low' && g.steps === 1 && g.category === 'search');
    assert.equal(luna.n, 7);
    assert.equal(luna.pass, 6);
    assert.ok(luna.avgUsd != null, 'one unpriced attempt must not null the group average');
    assert.ok(Math.abs(luna.avgUsd - lunaUsd) < 1e-9);
    const r = sc.recommend({ category: 'search', difficulty: 2, source });
    assert.equal(r.model, 'gpt-5.6-luna');
    assert.doesNotMatch(r.reason, /cost unknown/);

    run({ id: `${source}-chain-a`, source, category: 'search', difficulty: 3 });
    run({ id: `${source}-chain-b`, source, category: 'search', difficulty: 3, model: 'gpt-5.6-terra', effort: 'medium', retryOf: `${source}-chain-a`, result: { durationMs: 1000 } });
    const chain = sc.rootRuns({ source }).find((c) => c.taskId === `${source}-chain-a`);
    assert.ok(chain.attempts[0].usd != null);
    assert.equal(chain.attempts[1].usd, null);
    assert.equal(chain.usd, null);
    assert.equal(chain.partialCost, true);

    run({ id: `${source}-lad1a`, source, category: 'ui', difficulty: 2 });
    sc.rateTask(`${source}-lad1a`, 'fail');
    run({ id: `${source}-lad1b`, source, category: 'ui', difficulty: 2, model: 'gpt-5.6-terra', effort: 'medium', retryOf: `${source}-lad1a` });
    sc.rateTask(`${source}-lad1b`, 'pass');
    run({ id: `${source}-lad2a`, source, category: 'ui', difficulty: 2 });
    sc.rateTask(`${source}-lad2a`, 'fail');
    run({ id: `${source}-lad2b`, source, category: 'ui', difficulty: 2, model: 'gpt-5.6-terra', effort: 'medium', retryOf: `${source}-lad2a`, result: { durationMs: 1000 } });
    sc.rateTask(`${source}-lad2b`, 'pass');
    const ladder = sc.summarize({ source }).find((g) => g.steps === 2 && g.category === 'ui');
    assert.ok(ladder.stepCosts[1].avgUsd != null);
    assert.ok(Math.abs(ladder.stepCosts[1].avgUsd - terraUsd) < 1e-9);

    const thin = { sel: 'codex:gpt-5.6-luna:low', steps: 1, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'debug', difficulty: 2, rated: 1, n: 1, quality: 1, accept: 1, avgUsd: 0.02, avgDurationMs: 0 };
    const hard = { ...thin, difficulty: 3, rated: 3, n: 3, avgUsd: null };
    const pooled = sc.recommend({ category: 'debug', difficulty: 2, summary: [thin, hard] });
    assert.ok(pooled.plan.usd != null);
    assert.doesNotMatch(pooled.reason, /cost unknown/);

    run({ id: `${source}-spark`, source, provider: 'codex', model: 'gpt-5.3-codex-spark', effort: 'low', category: 'search', difficulty: 1, result: { usage: USAGE, durationMs: 1000 } });
    sc.rateTask(`${source}-spark`, 'pass');
    assert.equal(sc.summarize({ source }).find((g) => /spark/.test(g.sel)).avgUsd, null, 'no list price stays cost-unknown');
    run({ id: `${source}-local`, source, provider: 'deepseek', model: 'deepseek-chat', effort: null, category: 'search', difficulty: 1, result: { durationMs: 1000 } });
    sc.rateTask(`${source}-local`, 'pass');
    assert.equal(sc.summarize({ source }).find((g) => g.provider === 'deepseek').avgUsd, 0);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('H2/B1: estimated ladder is pushed only when combined quality clears the bar', () => {
  const cfg = loadConfig().scorecard;
  const source = 'H2B1';
  try {
    saveConfig({ scorecard: { usePriors: false, minSamples: 3, quality: 0.75, qualityValueUsd: 5, reservePct: 0, hourlyUsd: 0 } });
    for (const v of ['fixable', 'fixable', 'fixable']) {
      const id = `${source}-local-${++n}`;
      run({ id, source, provider: 'deepseek', model: 'deepseek-chat', effort: null, category: 'search', difficulty: 2 });
      sc.rateTask(id, v);
    }
    for (const v of ['pass', 'pass', 'fixable']) {
      const id = `${source}-terra-${++n}`;
      run({ id, source, model: 'gpt-5.6-terra', effort: 'medium', category: 'search', difficulty: 2 });
      sc.rateTask(id, v);
    }
    const r = sc.recommend({ category: 'search', difficulty: 2, source });
    assert.equal(r.provider, 'codex');
    assert.equal(r.model, 'gpt-5.6-terra');
    assert.equal(r.plan.estimated, false);
    assert.equal(r.plan.steps.length, 1);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B4 deterministic ledger replay changes H2 escalation and M4 estimated-ladder picks', (t) => {
  const cfg = loadConfig().scorecard;
  const models = ['replay-smoke', 'replay-live', 'replay-first', 'replay-fallback'];
  registryModels(t, models.map((model) => ['codex', model]));
  const rate = (id, model, category, difficulty, verdict, source = 'live') => {
    run({ id, source, provider: 'codex', model, effort: null, category, difficulty });
    sc.rateTask(id, verdict);
  };
  try {
    saveConfig({ scorecard: {
      usePriors: false, minSamples: 1, benchMinSamples: 3, quality: 0.75, qualityValueUsd: 5,
      reservePct: 0, hourlyUsd: 0, wasteStrength: 0, providerWeight: { codex: 1 },
      classes: { codex: 'subscription' }, classOrder: ['subscription'],
      prices: Object.fromEntries(models.map((model) => [`codex:${model}`, { in: 1, out: 1, cached: 0 }])),
    } });

    for (let i = 0; i < 5; i++) rate(`b4-h2-smoke-${i}`, 'replay-smoke', 'summarize', 2, 'pass', 'smoke');
    for (const [i, verdict] of ['pass', 'pass', 'pass', 'fixable'].entries()) rate(`b4-h2-live-${i}`, 'replay-live', 'summarize', 2, verdict);
    const h2Cells = sc.summarize().filter((g) => g.category === 'summarize' && ['replay-smoke', 'replay-live'].includes(g.model));
    const h2Before = [...h2Cells].sort((a, b) => b.quality - a.quality)[0].sel; // old quality-first comparator
    const h2After = sc.recommend({ category: 'summarize', difficulty: 2, summary: h2Cells, escalate: true }).plan.steps[0];
    assert.equal(sc.recommend({ category: 'summarize', difficulty: 2, summary: h2Cells.filter((g) => g.model === 'replay-smoke'), escalate: true }).model, 'replay-smoke', 'smoke-only evidence remains eligible at its own level');

    for (const [i, verdict] of ['fixable', 'fail'].entries()) rate(`b4-m4-first-l3-${i}`, 'replay-first', 'review', 3, verdict);
    for (let i = 0; i < 3; i++) rate(`b4-m4-first-l5-${i}`, 'replay-first', 'review', 5, 'fail');
    for (const [i, verdict] of ['pass', 'fixable'].entries()) rate(`b4-m4-fallback-l3-${i}`, 'replay-fallback', 'review', 3, verdict);
    const m4Cells = sc.summarize().filter((g) => g.category === 'review' && ['replay-first', 'replay-fallback'].includes(g.model));
    const lowerFirst = m4Cells.find((g) => g.model === 'replay-first' && g.difficulty === 3);
    const fallback = m4Cells.find((g) => g.model === 'replay-fallback');
    const legacyCombined = lowerFirst.quality + (1 - lowerFirst.accept) * fallback.quality;
    const m4Before = legacyCombined >= cfg.quality ? lowerFirst.sel : fallback.sel;
    const m4After = sc.recommend({ category: 'review', difficulty: 5, summary: m4Cells });

    assert.deepEqual({
      h2: { before: h2Before, after: h2After },
      m4: { before: m4Before, after: m4After.plan.steps[0] },
    }, {
      h2: { before: 'codex:replay-smoke:default', after: 'codex:replay-live:default' },
      m4: { before: 'codex:replay-fallback:default', after: 'codex:replay-first:default' },
    });
    assert.deepEqual(m4After.plan.steps, ['codex:replay-first:default', 'codex:replay-fallback:default']);
    assert.equal(m4After.plan.quality, 1, 'the task-level L5 accept=0, not the pooled L3 accept=0.5, drives the estimate');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('F1: extrapolation can use the nearest lower benchmark cell while preserving live and visual rules', (t) => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { usePriors: false, minSamples: 3, benchMinSamples: 3, quality: 0.75, reservePct: 0, hourlyUsd: 0, wasteStrength: 0,
      providerWeight: { codex: 1 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    const cell = ({ model, category = 'refactor', difficulty = 3, source = 'smoke', effort = 'medium', rated = 3, quality = 1, avgUsd = 0 }) => ({
      sel: `codex:${model}:${effort}`, steps: 1, provider: 'codex', model, effort, category, difficulty,
      n: rated, rated, weightedRated: rated,
      liveN: source === 'live' ? rated : 0, liveRated: source === 'live' ? rated : 0, liveWeightedRated: source === 'live' ? rated : 0,
      smokeN: source === 'smoke' ? rated : 0, smokeRated: source === 'smoke' ? rated : 0, smokeWeightedRated: source === 'smoke' ? rated : 0,
      quality, liveQuality: source === 'live' ? quality : null, accept: quality, avgUsd, avgDurationMs: 0,
    });
    const benchmark = cell({ model: 'gpt-5.6-terra', effort: 'high' });
    const extrapolated = sc.recommend({ category: 'refactor', difficulty: 4, summary: [benchmark] });
    assert.deepEqual(extrapolated.plan.steps, [benchmark.sel]);
    assert.equal(extrapolated.evidence.source, 'bench');
    assert.match(extrapolated.reason, /extrapolated from level 3 \(benchmark evidence\)/);

    const live = cell({ model: 'gpt-5.6-terra', source: 'live', effort: 'medium', avgUsd: 10 });
    const livePreferred = sc.recommend({ category: 'refactor', difficulty: 4, summary: [benchmark, live] });
    assert.equal(livePreferred.effort, live.effort, 'qualified live evidence wins even when the cheaper benchmark has a higher effort');
    assert.equal(livePreferred.evidence.source, 'live');
    assert.doesNotMatch(livePreferred.reason, /benchmark evidence/);

    const tooThin = cell({ model: 'gpt-5.6-terra', rated: 2 });
    assert.equal(sc.recommend({ category: 'refactor', difficulty: 4, summary: [tooThin] }), null, 'lower benchmark cells keep the minSamples floor');
    const belowBar = cell({ model: 'gpt-5.6-terra', quality: 0.5 });
    assert.equal(sc.recommend({ category: 'refactor', difficulty: 4, summary: [belowBar] }), null, 'lower benchmark cells keep the quality bar');

    const astraReg = { models: [{ provider: 'codex', id: 'gpt-6-astra', kind: 'agent', efforts: ['ultra'] }], providers: { codex: { status: 'ok' } } };
    const visualBench = cell({ model: 'gpt-6-astra', category: 'modeling', effort: 'ultra' });
    const modeling = sc.recommend({ category: 'modeling', difficulty: 4, summary: [visualBench], reg: astraReg });
    assert.equal(modeling.plan, null, 'lower benchmark evidence does not create a visual measured plan');
    assert.match(modeling.reason, /hand-picked prior only/);

    const proven = cell({ model: 'gpt-6-astra', difficulty: 4, source: 'live', avgUsd: 1 });
    const levelFour = sc.recommend({ category: 'refactor', difficulty: 4, summary: [benchmark, proven] });
    assert.equal(levelFour.model, proven.model);
    assert.equal(levelFour.evidence.source, 'live');
    assert.doesNotMatch(levelFour.reason, /extrapolated from level/);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B5 reservation ceiling uses live evidence only within the selected model window group', async (t) => {
  const { getLimits } = await import('../../core/limits.mjs');
  const cfg = loadConfig().scorecard;
  const limits = getLimits(), previous = limits.providers.antigravity;
  registryModels(t, [['antigravity', 'gemini-b5']]);
  try {
    saveConfig({ scorecard: { usePriors: false, minSamples: 1, reservePct: 0.5, hourlyUsd: 0, wasteStrength: 0, providerWeight: { antigravity: 0.1 }, classOrder: ['included'] } });
    limits.providers.antigravity = { windows: [
      { id: 'flash-group', models: '^flash$', usedPercent: 0, resetsAt: Date.now() + 3600e3 },
      { id: 'gemini-group', models: '^gemini', usedPercent: 0, resetsAt: Date.now() + 3600e3 },
    ] };
    const cell = (model, difficulty, source) => ({
      sel: `antigravity:${model}:default`, steps: 1, provider: 'antigravity', model, effort: null, category: 'docs', difficulty,
      n: 1, rated: 1, weightedRated: 1, liveN: source === 'live' ? 1 : 0, liveRated: source === 'live' ? 1 : 0,
      liveWeightedRated: source === 'live' ? 1 : 0, smokeN: source === 'smoke' ? 1 : 0, smokeRated: source === 'smoke' ? 1 : 0,
      smokeWeightedRated: source === 'smoke' ? 1 : 0, quality: 1, liveQuality: source === 'live' ? 1 : null,
      accept: 1, avgUsd: 1, avgDurationMs: 0,
    });
    const summary = [cell('flash', 1, 'live'), cell('flash', 5, 'smoke'), cell('gemini-b5', 5, 'live')];
    const r = sc.recommend({ category: 'docs', difficulty: 1, summary, exclude: ['antigravity:gemini-b5'] });
    assert.equal(r.model, 'flash');
    assert.doesNotMatch(r.reason, /reserve ×/, 'smoke capacity and another window group do not raise this model group ceiling');
  } finally { limits.providers.antigravity = previous; saveConfig({ scorecard: cfg }); }
});

test('H2 escalation orders live class, class evidence count, prior tier, then utility', () => {
  const cfg = loadConfig().scorecard;
  const cell = (model, effort, priorTier, avgUsd) => ({
    sel: `codex:${model}:${effort}`, steps: 1, provider: 'codex', model, effort,
    category: 'implement', difficulty: 2, n: 3, rated: 3, liveN: 3, liveRated: 3,
    smokeN: 0, smokeRated: 0, quality: 1, accept: 1, priorTier, avgUsd, avgDurationMs: 0,
  });
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0, wasteStrength: 0, providerWeight: { codex: 1 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    const astra = cell('gpt-6-astra', 'medium', 'A', 1);
    const luna = cell('gpt-5.6-luna', 'low', 'B', 0.01);
    assert.equal(sc.recommend({ category: 'implement', difficulty: 2, summary: [luna, astra], escalate: true }).model, 'gpt-6-astra');
    assert.equal(sc.recommend({ category: 'implement', difficulty: 2, summary: [luna, { ...astra, priorTier: 'B' }], escalate: true }).model, 'gpt-5.6-luna');
    const smokeMany = { ...astra, n: 5, rated: 5, liveN: 0, liveRated: 0, smokeN: 5, smokeRated: 5, priorTier: 'D' };
    const smokeFew = { ...luna, liveN: 0, liveRated: 0, smokeN: 3, smokeRated: 3, priorTier: 'A' };
    assert.equal(sc.recommend({ category: 'implement', difficulty: 2, summary: [smokeFew, smokeMany], escalate: true }).model, 'gpt-6-astra', 'smoke evidence count precedes prior tier');
    const liveOne = { ...luna, n: 1, rated: 1, liveN: 1, liveRated: 1, smokeN: 0, smokeRated: 0 };
    assert.equal(sc.recommend({ category: 'implement', difficulty: 2, summary: [smokeMany, liveOne], escalate: true }).model, 'gpt-5.6-luna', 'any live rated cell outranks a smoke-only cell');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B7: a class not listed in classOrder is not eligible (no any-plan fallback)', () => {
  const cfg = loadConfig().scorecard;
  const source = 'B7-class';
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0, classes: { deepseek: 'special' }, classOrder: ['subscription', 'conductor'] } });
    for (let i = 0; i < 3; i++) {
      const id = `${source}-${i}`;
      run({ id, source, provider: 'deepseek', model: 'deepseek-chat', effort: null, category: 'read', difficulty: 2 });
      sc.rateTask(id, 'pass');
    }
    assert.equal(sc.recommend({ category: 'read', difficulty: 2, source }), null, 'unlisted class must not win via fallback');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B8: cold-start prior sort skips candidates whose class is not in classOrder', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { usePriors: true, classOrder: ['subscription'], classes: { codex: 'subscription' } } });
    const r = sc.recommend({ category: 'design', difficulty: 1, summary: [] });
    assert.ok(r);
    assert.equal(r.provider, 'codex', 'free/unlisted class must not sort first via indexOf -1');
    assert.match(r.reason, /prior only/);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B2: a ledger model no longer in the registry does not veto extrapolation', async () => {
  const { getLimits } = await import('../../core/limits.mjs');
  const cfg = loadConfig().scorecard;
  const limits = getLimits();
  const prevDeepSeek = limits.providers.deepseek;
  const cell = (sel, difficulty, extra = {}) => ({ sel, steps: 1, ...extra, category: 'implement', difficulty, rated: 3, n: 3, quality: 1, accept: 1, avgUsd: 0.01, avgDurationMs: 0 });
  const gone = cell('codex:gone:low', 4, { provider: 'codex', model: 'gone', effort: 'low' });
  const live = cell('deepseek:deepseek-chat:default', 2, { provider: 'deepseek', model: 'deepseek-chat', effort: null });
  const reg = { models: [{ provider: 'deepseek', id: 'deepseek-chat', kind: 'agent' }], providers: { deepseek: { status: 'ok' }, codex: { status: 'ok' } } };
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0, classOrder: ['free', 'included', 'subscription', 'conductor', 'api'], classes: { codex: 'subscription', deepseek: 'free' } } });
    limits.providers.deepseek = { provider: 'deepseek', blocked: false, windows: [] };
    // Removed model stays unusable as a plan (R2B2); it must not freeze provenButCapped either.
    assert.equal(sc.recommend({ category: 'implement', difficulty: 4, summary: [gone], reg }), null);
    const r = sc.recommend({ category: 'implement', difficulty: 4, summary: [gone, live], reg });
    assert.equal(r.provider, 'deepseek');
    assert.match(r.reason, /extrapolated from level 2/);
  } finally { limits.providers.deepseek = prevDeepSeek; saveConfig({ scorecard: cfg }); }
});

test('B5: reserve() weights the step model, not the busiest window across groups', async () => {
  const { getLimits } = await import('../../core/limits.mjs');
  const cfg = loadConfig().scorecard;
  const limits = getLimits();
  const previous = limits.providers.antigravity;
  const source = 'B5-reserve';
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0.5, hourlyUsd: 0, wasteStrength: 0, quotaPressurePct: 80, providerWeight: { antigravity: 0.1 }, classOrder: ['included'] } });
    limits.providers.antigravity = { provider: 'antigravity', windows: [
      { id: 'gemini', label: 'weekly Gemini', models: 'gemini', usedPercent: 90, resetsAt: Date.now() + 100 * 3600e3, windowMinutes: 10080 },
      { id: 'flash', label: 'weekly Flash', models: 'flash', usedPercent: 10, resetsAt: Date.now() + 100 * 3600e3, windowMinutes: 10080 },
    ] };
    for (const difficulty of [1, 5]) for (let i = 0; i < 3; i++) {
      run({ id: `${source}-${difficulty}-${i}`, source, provider: 'antigravity', model: 'flash', effort: null, category: 'docs', difficulty });
      sc.rateTask(`${source}-${difficulty}-${i}`, 'pass');
    }
    const r = sc.recommend({ category: 'docs', difficulty: 1, source });
    assert.equal(r.provider, 'antigravity');
    assert.match(r.reason, /reserve ×1\.20/, 'model-scoped weight 0.1, not quota-pressure 1 from the other group');
  } finally { limits.providers.antigravity = previous; saveConfig({ scorecard: cfg }); }
});

test('B4: usageResets schedule fallback applies only when the provider has no real non-session window', async () => {
  const { wasteDiscount } = sc;
  const { getLimits } = await import('../../core/limits.mjs');
  const limits = getLimits();
  const previous = limits.providers.grok;
  const now = Date.parse('2026-09-15T10:00:00');
  const cfg = { usageResets: { grok: { periodHours: 24, resetHour: 18 } }, classes: { grok: 'included' }, wasteSteps: [[48, 0.5], [24, 1]], wasteStrength: 0.9, providerWeight: {} };
  try {
    limits.providers.grok = { windows: [{ id: 'weekly', label: 'weekly', usedPercent: 20, resetsAt: now + 100 * 3600e3, windowMinutes: 10080 }] };
    assert.equal(wasteDiscount('grok', cfg, null, now), 1, 'a real weekly window outside the horizon must not take the schedule discount');
    limits.providers.grok = { windows: [{ id: '5h', label: '5-hour', usedPercent: 10, resetsAt: now + 1 * 3600e3, windowMinutes: 300 }] };
    assert.ok(wasteDiscount('grok', cfg, null, now) < 0.5, 'session-only windows still allow the schedule fallback');
  } finally { limits.providers.grok = previous; }
});

test('B10: scheduled reset hour is reapplied after setDate (DST spring-forward)', () => {
  const local = (s) => new Date(s).getTime();
  const at = local('2026-03-08T04:00:00');
  // 2026-03-08 is the US spring-forward (02:00 is the gap). After the gap, the next 02:00 must
  // not carry 03:00 from setHours-into-the-gap then setDate.
  const weekly = new Date(sc.nextScheduledReset('spr', { usageResets: { spr: { resetDay: 0, resetHour: 2 } } }, at));
  assert.equal(weekly.getHours(), 2);
  assert.equal(weekly.getDay(), 0);
  const daily = new Date(sc.nextScheduledReset('spr', { usageResets: { spr: { resetHour: 2 } } }, at));
  assert.equal(daily.getHours(), 2);
  assert.equal(daily.getDate(), 9);
});

test('L11: a thin observed ladder keeps the estimate; a sampled one combines with A', () => {
  const cfg = loadConfig().scorecard;
  const lunaUsd = pr.usdFor({ in: 50_000, cached: 50_000, out: 10_000 }, pr.priceFor('codex', 'gpt-5.6-luna'));
  const terraUsd = pr.usdFor({ in: 50_000, cached: 50_000, out: 10_000 }, pr.priceFor('codex', 'gpt-5.6-terra'));
  const rate = (id, source, model, effort, verdict, extra = {}) => {
    run({ id, source, provider: 'codex', model, effort, category: 'read', difficulty: 2, ...extra });
    sc.rateTask(id, verdict);
  };
  try {
    saveConfig({ scorecard: { usePriors: false, minSamples: 3, quality: 0.75, qualityValueUsd: 1, reservePct: 0, hourlyUsd: 0, wasteStrength: 0, providerWeight: { codex: 1 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    const thin = 'L11-thin';
    for (const [i, v] of ['pass', 'pass', 'fail'].entries()) rate(`${thin}-luna-${i}`, thin, 'gpt-5.6-luna', 'low', v);
    for (const i of [0, 1, 2]) rate(`${thin}-terra-${i}`, thin, 'gpt-5.6-terra', 'medium', 'pass');
    rate(`${thin}-chain-a`, thin, 'gpt-5.6-luna', 'low', 'fail');
    rate(`${thin}-chain-b`, thin, 'gpt-5.6-terra', 'medium', 'pass', { retryOf: `${thin}-chain-a` });
    const thinPick = sc.recommend({ category: 'read', difficulty: 2, source: thin });
    assert.deepEqual(thinPick.plan.steps, ['codex:gpt-5.6-luna:low', 'codex:gpt-5.6-terra:medium']);
    assert.equal(thinPick.plan.estimated, true, 'one observed chain must not drop the estimate');

    const sampled = 'L11-sampled';
    for (const i of [1, 2, 3]) rate(`${sampled}-solo-${i}`, sampled, 'gpt-5.6-luna', 'low', 'pass');
    for (const i of [1, 2, 3]) {
      rate(`${sampled}-a${i}`, sampled, 'gpt-5.6-luna', 'low', 'fail');
      rate(`${sampled}-b${i}`, sampled, 'gpt-5.6-terra', 'medium', 'pass', { retryOf: `${sampled}-a${i}` });
    }
    const r = sc.recommend({ category: 'read', difficulty: 2, source: sampled });
    assert.equal(r.plan.estimated, false);
    assert.deepEqual(r.plan.steps, ['codex:gpt-5.6-luna:low', 'codex:gpt-5.6-terra:medium']);
    // qA = 0.5, pA = 0.5, q(A>B) = 1 → q = 1; usd = cA + 0.5·cB
    assert.ok(Math.abs(r.plan.quality - 1) < 1e-9);
    assert.ok(Math.abs(r.plan.usd - (lunaUsd + 0.5 * terraUsd)) < 1e-6, `combined usd ${r.plan.usd} vs ${lunaUsd + 0.5 * terraUsd}`);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('L12: a proven-but-capped level stops extrapolation instead of descending further', async () => {
  const { getLimits } = await import('../../core/limits.mjs');
  const cfg = loadConfig().scorecard;
  const limits = getLimits();
  const previous = limits.providers.codex;
  const source = 'L12-capped';
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0 } });
    for (let i = 0; i < 3; i++) {
      run({ id: `${source}-terra-${i}`, source, model: 'gpt-5.6-terra', effort: 'medium', category: 'implement', difficulty: 3 });
      sc.rateTask(`${source}-terra-${i}`, 'pass');
      run({ id: `${source}-deepseek-chat-${i}`, source, provider: 'deepseek', model: 'deepseek-chat', effort: null, category: 'implement', difficulty: 2 });
      sc.rateTask(`${source}-deepseek-chat-${i}`, 'pass');
    }
    const resetAt = Date.now() + 3.6e6;
    const picked = sc.recommend({ category: 'implement', difficulty: 3, source, explain: true });
    assert.equal(picked.explain.status, 'picked');
    assert.match(picked.explain.reason, /best value/);
    limits.providers.codex = { ...(previous || {}), provider: 'codex', blocked: true, blockedUntil: resetAt, windows: previous?.windows || [] };
    assert.equal(sc.recommend({ category: 'implement', difficulty: 4, source }), null, 'must not fall through to the level-2 model');
    const explained = sc.recommend({ category: 'implement', difficulty: 4, source, explain: true });
    assert.equal(explained.pick, null);
    assert.equal(explained.explain.status, 'capped');
    assert.deepEqual(explained.explain.capped, [{ sel: 'codex:gpt-5.6-terra:medium', reason: 'provider limit', resetAt }]);
  } finally {
    limits.providers.codex = previous;
    saveConfig({ scorecard: cfg });
  }
});

test('L38: extrapolation reserves against the original difficulty, not the evidence level', () => {
  const cfg = loadConfig().scorecard;
  const source = 'L38-reserve';
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0.5, hourlyUsd: 0, wasteStrength: 0, providerWeight: { codex: 0.6 }, classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    for (let i = 0; i < 3; i++) {
      run({ id: `${source}-docs-${i}`, source, model: 'gpt-5.6-terra', effort: 'medium', category: 'docs', difficulty: 2 });
      sc.rateTask(`${source}-docs-${i}`, 'pass');
      run({ id: `${source}-ceil-${i}`, source, model: 'gpt-5.6-terra', effort: 'medium', category: 'test', difficulty: 5 });
      sc.rateTask(`${source}-ceil-${i}`, 'pass');
    }
    const r = sc.recommend({ category: 'docs', difficulty: 4, source });
    assert.match(r.reason, /extrapolated from level 2/);
    assert.match(r.reason, /reserve ×1\.30/, 'gap is ceiling 5 − original 4, not − evidence 2');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('L40: escalation prior fallback sorts by tier, not cheapest price', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { usePriors: true } });
    const value = sc.recommend({ category: 'design', difficulty: 2, summary: [] });
    assert.equal(value.model, 'deepseek-chat', 'value walk still picks the cheapest covering tier');
    const esc = sc.recommend({ category: 'design', difficulty: 2, summary: [], escalate: true });
    assert.equal(esc.model, 'gpt-6-astra', 'escalate picks the best public tier');
    assert.match(esc.reason, /prior only/);
  } finally { saveConfig({ scorecard: cfg }); }
});

test('P6: extrapolation reuses the already-folded summary', () => {
  const cell = { sel: 'codex:gpt-5.6-terra:medium', steps: 1, provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', category: 'implement', difficulty: 2, rated: 3, n: 3, quality: 1, accept: 1, avgUsd: 0.01, avgDurationMs: 0 };
  const r = sc.recommend({ category: 'implement', difficulty: 4, summary: [cell], source: 'P6-absent' });
  assert.equal(r.model, 'gpt-5.6-terra');
  assert.match(r.reason, /extrapolated from level 2/);
});

test('I14: cold-start effort map comes from config with DEFAULTS fallback', () => {
  const cfg = loadConfig().scorecard;
  assert.equal(sc.priorEffort(['low', 'medium', 'high', 'xhigh', 'max'], 5), 'xhigh');
  saveConfig({ scorecard: { difficultyEffort: { 1: 'low', 2: 'medium', 3: 'medium', 4: 'high', 5: 'max' } } });
  assert.equal(sc.priorEffort(['low', 'medium', 'high', 'xhigh', 'max'], 5), 'max');
  saveConfig({ scorecard: { difficultyEffort: cfg.difficultyEffort } });
});

test('recommend excludes archived registry models from measured and prior-only routing', () => {
  const cfg = loadConfig().scorecard;
  const reg = { providers: { codex: { status: 'ok' } }, models: [
    { provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent', efforts: ['low'] },
    { provider: 'codex', id: 'gpt-5.6-terra', kind: 'agent', efforts: ['medium'] },
  ] };
  try {
    saveConfig({ scorecard: { archived: [], usePriors: false, minSamples: 1, benchMinSamples: 3, classOrder: ['subscription'] } });
    run({ id: 'archive-measured-luna', source: 'archive-measured', model: 'gpt-5.6-luna', effort: 'low', category: 'implement', difficulty: 1 });
    sc.rateTask('archive-measured-luna', 'pass');
    for (const [id, verdict] of [['archive-measured-terra-pass', 'pass'], ['archive-measured-terra-fix', 'fixable']]) {
      run({ id, source: 'archive-measured', model: 'gpt-5.6-terra', effort: 'medium', category: 'implement', difficulty: 1 });
      sc.rateTask(id, verdict);
    }
    assert.equal(sc.recommend({ category: 'implement', difficulty: 1, source: 'archive-measured', reg }).model, 'gpt-5.6-luna');
    assert.equal(sc.recommend({ category: 'implement', difficulty: 1, source: 'archive-measured', reg, escalate: true }).model, 'gpt-5.6-terra');

    saveConfig({ scorecard: { archived: ['CODEX:GPT-5.6-LUNA'], usePriors: true } });
    assert.equal(sc.recommend({ category: 'implement', difficulty: 1, source: 'archive-measured', reg }).model, 'gpt-5.6-terra');
    assert.equal(sc.recommend({ category: 'implement', difficulty: 1, source: 'archive-measured', reg, escalate: true }).model, 'gpt-5.6-terra');
    const prior = sc.recommend({ category: 'implement', difficulty: 1, source: 'archive-prior-empty', reg });
    assert.equal(prior.model, 'gpt-5.6-terra');
    assert.notEqual(prior.model, 'gpt-5.6-luna');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('[1m] scorecard rows group, price, route and satisfy bench hygiene as the base model', async (t) => {
  const cfg = loadConfig().scorecard;
  const source = 'alias-1m';
  registryModels(t, [['claude', 'claude-fable-5-1']]);
  try {
    saveConfig({ scorecard: { archived: [], usePriors: false, minSamples: 1, benchMinSamples: 3, classOrder: ['conductor'] } });
    run({ id: `${source}-live`, source, provider: 'claude', model: 'claude-fable-5-1[1m]', effort: 'low', category: 'docs', difficulty: 2 });
    sc.rateTask(`${source}-live`, 'pass');
    const row = sc.summarize({ source }).find((g) => g.steps === 1);
    assert.equal(row.model, 'claude-fable-5-1');
    assert.equal(row.sel, 'claude:claude-fable-5-1:low');
    assert.ok(row.avgUsd > 0, 'the suffixed run uses the base model price');
    assert.equal(sc.recommend({ category: 'docs', difficulty: 2, source }).model, 'claude-fable-5-1');

    const { BENCH_TASK_IDS, dueForBench } = await import('../../core/bench.mjs');
    for (const [i, smokeId] of BENCH_TASK_IDS.slice(0, 8).entries()) {
      run({ id: `${source}-smoke-${i}`, source: 'smoke', smokeId, provider: 'claude', model: 'claude-fable-5-1[1m]', effort: 'low', category: 'read', difficulty: 1 });
      sc.rateTask(`${source}-smoke-${i}`, 'pass');
    }
    saveConfig({ scorecard: { archived: ['claude:claude-opus-5-5[1m]'] } });
    const reg = { providers: { claude: { status: 'ok' } }, models: [
      { provider: 'claude', id: 'claude-fable-5-1', kind: 'agent', efforts: ['low'] },
      { provider: 'claude', id: 'claude-fable-5-1[1m]', kind: 'agent', efforts: ['low'] },
      { provider: 'claude', id: 'claude-opus-5-5[1m]', kind: 'agent', efforts: ['low'] },
    ] };
    assert.deepEqual(dueForBench({ days: 21, reg }), [], 'suffix/base duplicates are satisfied once and archived aliases are skipped');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('conductor rows stay out of worker routing ceilings and worker-only run reads', () => {
  const source = 'conductor-rating-isolation';
  for (let i = 0; i < 3; i++) {
    const id = `${source}-worker-${i}`;
    run({ id, source, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'docs', difficulty: 1 });
    sc.rateTask(id, 'pass');
  }
  const request = { category: 'docs', difficulty: 1, source };
  const before = sc.recommend(request);
  assert.ok(before, 'worker evidence produces a recommendation');

  const conductorIds = [];
  for (let i = 0; i < 3; i++) {
    const id = `${source}-chat-${i}`; conductorIds.push(id);
    run({ id, source, provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'conductor', difficulty: 5 });
    sc.rateTask(id, 'pass');
  }
  assert.deepEqual(sc.recommend(request), before);
  assert.ok(sc.runRows().some((r) => conductorIds.includes(r.taskId)), 'ratings remain in the scorecard ledger');
  assert.equal(sc.activeRunRows().some((r) => conductorIds.includes(r.taskId)), false, 'budget and usage inputs exclude conductor rows');
});

test('recommend() uses a 6-7 cell with measured passes', () => {
  const source = 'measured-6-7';
  seed('codex', 'gpt-6-astra', 'medium', 'refactor', 6, ['pass', 'pass', 'pass'], { source });
  seed('codex', 'gpt-6-astra', 'medium', 'implement', 7, ['pass', 'pass', 'pass'], { source });

  const r6 = sc.recommend({ category: 'refactor', difficulty: 6, source });
  assert.ok(r6);
  assert.equal(r6.provider, 'codex');
  assert.equal(r6.model, 'gpt-6-astra');
  assert.equal(r6.plan.steps[0], 'codex:gpt-6-astra:medium');
  assert.equal(r6.evidence.source, 'live');

  const r7 = sc.recommend({ category: 'implement', difficulty: 7, source });
  assert.ok(r7);
  assert.equal(r7.provider, 'codex');
  assert.equal(r7.model, 'gpt-6-astra');
  assert.equal(r7.plan.steps[0], 'codex:gpt-6-astra:medium');
  assert.equal(r7.evidence.source, 'live');
});

test('priors alone do not qualify at 6-7', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({ scorecard: { coldStart: 'priors', classes: { codex: 'subscription' }, classOrder: ['subscription'] } });
    const emptySource = 'priors-only-6-7';
    // gpt-6-astra has tier A, which covers levels 1-5 via TIER_CEILING, but must NOT qualify at 6 or 7
    const r5 = sc.recommend({ category: 'implement', difficulty: 5, source: emptySource });
    assert.ok(r5, 'prior qualifies up to level 5');
    assert.match(r5.reason, /hand-picked prior/);

    const r6 = sc.recommend({ category: 'implement', difficulty: 6, source: emptySource });
    assert.equal(r6, null, 'priors alone do not qualify at 6');

    const r7 = sc.recommend({ category: 'implement', difficulty: 7, source: emptySource });
    assert.equal(r7, null, 'priors alone do not qualify at 7');
  } finally {
    saveConfig({ scorecard: cfg });
  }
});

test('the no-qualified fallback at 7 picks the best-quality available model', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({
      scorecard: {
        usePriors: false,
        reservePct: 0,
        providerWeight: { deepseek: 0, codex: 0.6 },
        classes: { codex: 'subscription', deepseek: 'free' },
        classOrder: ['free', 'subscription'],
      },
    });
    const source = 'fallback-at-7';
    // Two models with runs at level 5:
    // deepseek-chat in 'free' class (would normally win by classOrder at level 5)
    seed('deepseek', 'deepseek-chat', null, 'implement', 5, ['pass', 'pass', 'pass'], { source });
    // gpt-6-astra in 'subscription' class, higher tier / quality
    seed('codex', 'gpt-6-astra', 'medium', 'implement', 5, ['pass', 'pass', 'pass'], { source });

    // At level 5, value routing picks the free class:
    const at5 = sc.recommend({ category: 'implement', difficulty: 5, source });
    assert.equal(at5.provider, 'deepseek');
    assert.equal(at5.class, 'free');

    // At level 7 with nothing qualified at 7, fallback picks the best-quality available model (as escalation does):
    const at7 = sc.recommend({ category: 'implement', difficulty: 7, source });
    assert.ok(at7);
    assert.equal(at7.provider, 'codex');
    assert.equal(at7.model, 'gpt-6-astra');
    assert.match(at7.reason, /extrapolated from level 5/);
    assert.match(at7.reason, /nothing measured at level 7\+ yet/);
    assert.match(at7.reason, /escalation/);
  } finally {
    saveConfig({ scorecard: cfg });
  }
});

test('reserve logic works with level 7 as the top level', () => {
  const cfg = loadConfig().scorecard;
  try {
    saveConfig({
      scorecard: {
        usePriors: false,
        reservePct: 0.5,
        providerWeight: { codex: 0.6 },
        classes: { codex: 'subscription' },
        classOrder: ['subscription'],
      },
    });
    const source = 'reserve-level-7';
    // Proven to level 7 with live runs:
    seed('codex', 'gpt-6-astra', 'medium', 'implement', 7, ['pass', 'pass', 'pass'], { source });
    // Also proven at level 2:
    seed('codex', 'gpt-5.6-luna', 'low', 'implement', 2, ['pass', 'pass', 'pass'], { source });

    // On a level 2 task, codex window group ceiling is 7.
    // Gap is ceiling (7) - taskDifficulty (2) = 5.
    // Reserve multiplier: 1 + 0.5 * 0.6 * 5 = 2.50
    const r = sc.recommend({ category: 'implement', difficulty: 2, source });
    assert.match(r.reason, /reserve ×2\.50: codex window group proven to level 7/);
  } finally {
    saveConfig({ scorecard: cfg });
  }
});
