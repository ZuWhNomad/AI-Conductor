import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { appendNdjson, statePath, writeJson } from '../core/paths.mjs';

// Registries are loaded at import time: seed them before importing the scorecard.
writeJson(join(HOME, 'models.json'), { updatedAt: 'x', providers: { codex: { status: 'ok' }, claude: { status: 'ok' }, ollama: { status: 'ok' } }, models: [
  { provider: 'ollama', id: 'qwen', kind: 'agent', cost: 'free-local' },
  { provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'codex', id: 'gpt-5.6-terra', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'codex', id: 'gpt-6-astra', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'claude', id: 'haiku', kind: 'agent', cost: 'subscription' },
  ...[
    ['claude', 'opus'], ['claude', 'sonnet'],
    ['deepseek', 'deepseek-flash'], ['antigravity', 'flash'],
  ].map(([provider, id]) => ({ provider, id, kind: 'agent' })),
] });
writeJson(join(HOME, 'limits.json'), { updatedAt: 'x', providers: {
  codex: { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] },
} });

const sc = await import('../core/scorecard.mjs');
const pr = await import('../core/priors.mjs');
const { loadConfig, saveConfig } = await import('../core/config.mjs');
const { getModels } = await import('../core/models.mjs');
const registryModels = (t, models) => {
  const reg = getModels(), previous = reg.models;
  reg.models = [...previous, ...models.map(([provider, id]) => ({ provider, id, kind: 'agent' }))];
  t.after(() => { reg.models = previous; });
};

let n = 0;
const USAGE = { input_tokens: 100_000, cached_input_tokens: 50_000, output_tokens: 10_000 }; // 50k uncached in, 50k cached, 10k out
const run = ({ before, ...o }) => sc.recordRun({ id: o.id || `t${++n}`, title: 't', status: 'done', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'implement', difficulty: 2, result: { usage: USAGE, durationMs: 1000 }, ...o }, { before });
const seed = (provider, model, effort, category, difficulty, verdicts, { usage = USAGE, retryOf = null } = {}) => {
  const ids = [];
  for (const v of verdicts) {
    const id = `s${++n}`; ids.push(id);
    run({ id, provider, model, effort, category, difficulty, retryOf, result: { usage, durationMs: 1000 } });
    if (v) sc.rateTask(id, v);
  }
  return ids;
};

test('priors: price and tier lookup, config override, shadow dollars', () => {
  assert.equal(pr.priorFor('codex', 'gpt-5.6-luna').tier, 'B');
  assert.equal(pr.priorFor('codex', 'gpt-5.6-luna', 'implement').tier, 'B');   // code: Terminal-Bench 84.7
  assert.equal(pr.priorFor('codex', 'gpt-5.6-luna', 'summarize').tier, 'D');   // read: MRCR 41%
  assert.equal(pr.priorFor('grok', 'grok-4.6', 'review').tier, 'B');           // reason: GDPval 1730
  assert.equal(pr.priorFor('grok', 'grok-4.6', 'debug').tier, 'D');
  assert.equal(pr.priorFor('claude', 'claude-fable-5-1[1m]').tier, 'A');
  assert.equal(pr.priorFor('antigravity', 'gemini-3.8-flash-low').tier, 'A');
  assert.equal(pr.priorFor('ollama', 'qwen3.8:latest').price.in, 0);
  assert.equal(pr.priorFor('codex', 'gpt-5.3-codex-spark').price, null);
  assert.equal(pr.priorFor('nope', 'x'), null);
  assert.deepEqual(pr.priceFor('codex', 'gpt-5.6-luna'), { in: 0.2, out: 1.2, cached: 0.02 });
  assert.deepEqual(pr.priceFor('codex', 'gpt-5.3-codex-spark', { scorecard: { prices: { 'codex:gpt-5.3-codex-spark': { in: 1, out: 2 } } } }), { in: 1, out: 2, cached: 0.1 });
  // 50k uncached @0.2 + 50k cached @0.02 + 10k out @1.2 = 0.01 + 0.001 + 0.012
  assert.ok(Math.abs(pr.usdFor({ in: 50_000, cached: 50_000, out: 10_000 }, { in: 0.2, out: 1.2, cached: 0.02 }) - 0.023) < 1e-9);
  assert.equal(pr.usdFor({ in: 1 }, null), null);
});

test('usage shapes normalize to uncached in / out / cached', () => {
  assert.deepEqual(sc.normalizeUsage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 }), { in: 60, out: 20, cached: 40, v: 2 });
  assert.deepEqual(sc.normalizeUsage({ 'claude-x': { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7 }, 'claude-y': { inputTokens: 1, outputTokens: 1 } }), { in: 6, out: 7, cached: 7, v: 2 });
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

test('fix rounds fold into an attempt; retries fold attempts into a chain with the last verdict', () => {
  run({ id: 'root', category: 'edit', before: [{ id: 'codex:primary', usedPercent: 10, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] });
  run({ id: 'fix1', category: 'edit', followUpOf: 'root', result: { usage: { input_tokens: 500, output_tokens: 100 }, durationMs: 500 } });
  sc.rateTask('fix1', 'fixable');
  let c = sc.rootRuns().find((r) => r.taskId === 'root');
  assert.equal(c.verdict, 'fixable');
  sc.rateTask('root', 'pass', 'fine');
  c = sc.rootRuns().find((r) => r.taskId === 'root');
  assert.equal(c.verdict, 'pass');
  assert.deepEqual(c.tokens, { in: 50_500, out: 10_100, cached: 50_000 });
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
  assert.equal(sc.recordRun({ id: 'img', imageOptions: {} }), null);
  assert.throws(() => sc.rateTask('root', 'meh'), { status: 400 });
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

test('recommend: value not cheapness — a dearer model wins only when its extra quality is worth it', () => {
  saveConfig({ scorecard: { providerWeight: { codex: 1, claude: 1, ollama: 0 }, reservePct: 0 } }); // list-price economics for this scenario
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
  seed('ollama', 'qwen', null, 'implement', 2, ['pass', 'pass']);
  assert.equal(sc.recommend({ category: 'implement', difficulty: 2 }).model, 'gpt-5.6-terra');
  seed('ollama', 'qwen', null, 'implement', 2, ['pass']);
  assert.equal(sc.recommend({ category: 'implement', difficulty: 2 }).provider, 'ollama');
  // ...unless wall clock is priced: qwen took 1000 ms like the others here, so make it slow
  assert.equal(sc.recommend({ category: 'docs', difficulty: 1 }), null);

  const text = sc.formatScores();
  assert.match(text, /implement@2/);
  assert.match(text, /- implement@3: class [a-z]+ · best value/);
  assert.match(text, /\| B$/m);
  assert.match(sc.formatScores({ category: 'review' }), /empty|none/);
});

test('escalate picks the highest measured quality, not the next cheap rung', () => {
  // implement@2 after seeding: Terra (1.0, $0.23), Astra (1.0, $1.15), qwen (1.0, $0) -> value pick is qwen; escalation ties on quality, then utility -> still qwen;
  // exclude the free one and Terra: value pick would be a Luna-first ladder, escalation goes straight to Astra alone.
  const r = sc.recommend({ category: 'implement', difficulty: 2, exclude: ['ollama:qwen', 'codex:gpt-5.6-terra'], escalate: true });
  assert.deepEqual(r.plan.steps, ['codex:gpt-6-astra:medium']);
  assert.match(r.reason, /escalation/);
});

test('escalation returns the best AVAILABLE model by quality across classes — distinct from best value', () => {
  saveConfig({ scorecard: { qualityValueUsd: 5, reservePct: 0, providerWeight: { ollama: 0, codex: 0.6, claude: 1 }, classes: { codex: 'subscription' }, classOrder: ['free', 'included', 'subscription', 'conductor', 'api'], classCap: { free: 100, included: 100, subscription: 100, conductor: 95, api: 100 } } });
  // A free model that clears the bar (0.8) and a subscription model that is strictly better (1.0).
  seed('ollama', 'qwen', null, 'test', 2, ['pass', 'pass', 'pass', 'pass', 'fail']);
  seed('codex', 'gpt-6-astra', 'medium', 'test', 2, ['pass', 'pass', 'pass']);
  const value = sc.recommend({ category: 'test', difficulty: 2 });
  assert.equal(value.provider, 'ollama'); assert.equal(value.class, 'free');       // best value: free class wins the class walk
  const esc = sc.recommend({ category: 'test', difficulty: 2, escalate: true });
  assert.equal(esc.provider, 'codex'); assert.equal(esc.model, 'gpt-6-astra');       // escalation: highest-quality single model, any class
  assert.equal(esc.plan.steps.length, 1);                                            // a strong single model, never a cheap-first ladder
  assert.match(esc.reason, /escalation: best available/);
  assert.notEqual(esc.provider, value.provider);                                     // the two picks are genuinely distinct
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
});

test('prior fallback routes by public tier only when enabled', () => {
  assert.equal(sc.recommend({ category: 'design', difficulty: 5 }), null);
  saveConfig({ scorecard: { usePriors: true } });
  const r = sc.recommend({ category: 'design', difficulty: 5 });
  assert.equal(r.model, 'gpt-6-astra'); // only tier A among the seeded registry models with a price (Astra $10/$50)
  assert.match(r.reason, /prior only/);
  assert.equal(sc.recommend({ category: 'design', difficulty: 2 }).model, 'gpt-5.6-luna'); // reason tier B covers 3; cheapest priced (qwen: tier D)
  assert.equal(sc.recommend({ category: 'summarize', difficulty: 2 }).model, 'gpt-5.6-terra'); // Luna's read tier is D: long-context recall
  assert.equal(sc.recommend({ category: 'design', difficulty: 1 }).provider, 'ollama');    // tier D covers 1; $0
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

test('source filter separates smoke from live runs', () => {
  run({ id: 'sm1', source: 'smoke', category: 'read', difficulty: 1 });
  sc.rateTask('sm1', 'pass');
  assert.ok(sc.rootRuns({ source: 'smoke' }).every((r) => r.source === 'smoke'));
  assert.ok(!sc.rootRuns({ source: 'live' }).some((r) => r.taskId === 'sm1'));
});

test('scorecard config is normalized', () => {
  const cfg = loadConfig();
  assert.equal(cfg.scorecard.minSamples, 3);
  assert.equal(cfg.scorecard.quality, 0.75);
  assert.equal(cfg.scorecard.qualityValueUsd, 5);
  assert.equal(cfg.scorecard.hourlyUsd, 0);
  const bad = saveConfig({ scorecard: { quality: 5, minSamples: -1, qualityValueUsd: 'x', hourlyUsd: -3, prices: 'x', usePriors: 'yes' }, smoke: { timeoutMinutes: 0 } });
  assert.equal(bad.scorecard.quality, 0.75);
  assert.equal(bad.scorecard.minSamples, 3);
  assert.equal(bad.scorecard.qualityValueUsd, 5);
  assert.equal(bad.scorecard.hourlyUsd, 0);
  assert.deepEqual(bad.scorecard.prices, {});
  assert.equal(bad.scorecard.usePriors, true);
  assert.equal(bad.smoke.timeoutMinutes, 10);
  saveConfig({ scorecard: { usePriors: false } });
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

test('provider weight: included subscriptions are near-free until their window fills; blocked providers are never picked', async () => {
  seed('codex', 'gpt-5.6-terra', 'low', 'review', 2, ['pass', 'pass', 'pass']);                       // list ~$0.23 -> weighted 0.046 at 0.2
  saveConfig({ scorecard: { prices: { 'deepseek:deepseek-flash': { in: 0.3, out: 1.2, cached: 0.006 } }, providerWeight: { codex: 0.2, deepseek: 1 }, reservePct: 0, classes: { codex: 'api', deepseek: 'api' } } }); // same class: compare on weighted value
  seed('deepseek', 'deepseek-flash', null, 'review', 2, ['pass', 'pass', 'pass']);                     // list ~$0.027 at full weight
  assert.equal(sc.providerWeight('codex'), 0.2);
  assert.equal(sc.providerWeight('deepseek'), 1);
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'deepseek');             // 0.027 < 0.046
  saveConfig({ scorecard: { providerWeight: { codex: 0.05 } } });
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'codex');                // 0.0115 < 0.027
  const lim = await import('../core/limits.mjs');
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', label: 'Codex weekly', usedPercent: 90, resetsAt: Date.now() + 3.6e6 }] };
  assert.equal(sc.providerWeight('codex'), 1);                                                        // quota pressure -> full price
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'deepseek');
  lim.getLimits().providers.deepseek = { provider: 'deepseek', blocked: true, blockedUntil: Date.now() + 3.6e6, windows: [] };
  assert.equal(sc.recommend({ category: 'review', difficulty: 2, overflowApi: true }).provider, 'codex');                // blocked provider excluded outright
  lim.getLimits().providers.deepseek = { provider: 'deepseek', blocked: false, windows: [] };
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] };
  saveConfig({ scorecard: { providerWeight: { ollama: 0, codex: 0.2, antigravity: 0.2, grok: 0.2, kimi: 0.2, 'qwen-code': 0.2, claude: 1 }, classes: { codex: 'subscription', deepseek: 'api' } } });
});

test('default reservation holds capacity proven at high levels back for high levels; the cheap tier does the grunt work', () => {
  // Two providers with identical list cost and quality at level 1: antigravity (weight 0.1, ceiling 1) vs codex Terra (weight 0.6, ceiling 4).
  saveConfig({ scorecard: { prices: { 'antigravity:flash': { in: 2, out: 12, cached: 0.2 } }, providerWeight: { antigravity: 0.1, codex: 0.6, claude: 1, ollama: 0 }, reservePct: null } });
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
  saveConfig({ scorecard: { providerWeight: { ollama: 0, antigravity: 0.1, grok: 0.1, kimi: 0.1, 'qwen-code': 0.1, deepseek: 0.3, codex: 0.6, claude: 1 }, classes: { codex: 'subscription' } } });
});

test('class walk: the first budget class proven at the level wins; capped classes are skipped; APIs only with overflow', async () => {
  saveConfig({ scorecard: { classes: { codex: 'subscription' }, classOrder: ['free', 'included', 'subscription', 'conductor', 'api'], classCap: { included: 95, subscription: 80, conductor: 95 }, reservePct: 0, prices: { 'antigravity:flash': { in: 2, out: 12, cached: 0.2 }, 'deepseek:deepseek-flash': { in: 0.3, out: 1.2, cached: 0.006 } } } });
  assert.equal(sc.providerClass('ollama'), 'free');
  assert.equal(sc.providerClass('antigravity'), 'included');
  assert.equal(sc.providerClass('codex'), 'subscription');
  assert.equal(sc.providerClass('claude'), 'conductor');
  assert.equal(sc.providerClass('deepseek'), 'api');
  const lim = await import('../core/limits.mjs');
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
  saveConfig({ scorecard: { reservePct: 0.5, classCap: { free: 100, included: 100, subscription: 100, conductor: 95, api: 100 } } });
});

test('bench: lists models with no battery or a stale one', async () => {
  const { writeJson } = await import('../core/paths.mjs');
  const { join } = await import('node:path');
  const { dueForBench, formatBench } = await import('../core/bench.mjs');
  const reg = { updatedAt: 'x', providers: { codex: { status: 'ok' }, ollama: { status: 'ok' }, kimi: { status: 'unavailable' } }, models: [
    { provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent', efforts: ['low', 'high'] },
    { provider: 'codex', id: 'brand-new', kind: 'agent', efforts: ['low'] },
    { provider: 'ollama', id: 'qwen', kind: 'agent', efforts: [] },
    { provider: 'kimi', id: 'kimi-k3', kind: 'agent', efforts: [] },
  ] };
  run({ id: 'smk1', source: 'smoke', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'read', difficulty: 1 }); sc.rateTask('smk1', 'pass');
  const due = dueForBench({ days: 21, reg });
  assert.deepEqual(due.map((d) => `${d.provider}:${d.model}`), ['codex:brand-new', 'ollama:qwen']);   // luna is fresh; kimi unavailable
  assert.match(formatBench(due), /2 selection\(s\) due/);
  assert.equal(dueForBench({ days: -1, reg }).length, 3);                                              // cutoff in the future: everything stale
});

test("the conductor's plan is capped on its session window only; weekly (Fable weekly included) may run to 100%", async () => {
  const lim = await import('../core/limits.mjs');
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
  const { getLimits, noteRateLimitEvent } = await import('../core/limits.mjs');
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

test('modeling is a first-class category (journaled and scored as itself, not as other)', () => {
  assert.ok(sc.CATEGORIES.includes('modeling'));
  run({ id: 'mod1', category: 'modeling', difficulty: 4 });
  sc.rateTask('mod1', 'fixable');
  assert.ok(sc.summarize().some((g) => g.category === 'modeling' && g.difficulty === 4));
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

test('a run recorded from outside Conductor (unmeasured tokens) counts for quality but is unpriced', async () => {
  const { appendNdjson, statePath } = await import('../core/paths.mjs');
  appendNdjson(statePath('scorecard.ndjson'), { op: 'run', ts: new Date().toISOString(), taskId: 'ext1', source: 'live', provider: 'codex', model: 'gpt-6-astra', effort: 'ultra', category: 'modeling', difficulty: 4, status: 'done', tokens: { in: 0, out: 0, cached: 0, v: 2 }, costUsd: 0, durationMs: 0, unmeasured: true, title: 'external' });
  sc.rateTask('ext1', 'pass', 'recorded from an external run');
  const a = sc.rootRuns().flatMap((c) => c.attempts).find((x) => x.taskId === 'ext1');
  assert.equal(a.verdict, 'pass'); assert.equal(a.usd, null);
  const g = sc.summarize().find((x) => x.category === 'modeling' && x.difficulty === 4 && /astra/.test(x.sel));
  assert.equal(g.pass, 1); assert.equal(g.avgUsd, null);
});

test('modeling: only a recorded pass is routable, at the effort that passed', async () => {
  const p = await import('../core/priors.mjs');
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

test('wasteDiscount: a soon-resetting subscription window with unused quota is discounted', async () => {
  const { wasteDiscount } = await import('../core/scorecard.mjs');
  const { getLimits } = await import('../core/limits.mjs');
  const cfg = { wasteHorizonHours: 48, wasteStrength: 0.9, classes: { codex: 'subscription' }, providerWeight: {} };
  const lim = getLimits();
  const wk = (usedPercent, hoursToReset) => { lim.providers.codex = { windows: [{ id: 'codex:primary', label: 'Codex weekly', usedPercent, resetsAt: Date.now() + hoursToReset * 3600e3, windowMinutes: 10080 }] }; };
  wk(20, 6); assert.ok(wasteDiscount('codex', cfg, null) < 0.5, 'near reset with 80% headroom -> heavy discount');
  wk(20, 100); assert.equal(wasteDiscount('codex', cfg, null), 1, 'far from reset -> no discount');
  wk(95, 6); assert.ok(wasteDiscount('codex', cfg, null) > 0.9, 'near reset but little headroom -> tiny discount');
  // 5-hour windows churn; they are ignored.
  lim.providers.codex = { windows: [{ id: 'codex:5h', label: '5-hour', usedPercent: 10, resetsAt: Date.now() + 1 * 3600e3, windowMinutes: 300 }] };
  assert.equal(wasteDiscount('codex', cfg, null), 1, '5-hour window is not a waste source');
  // API / conductor classes are never discounted (no wasted quota / keep a buffer).
  assert.equal(wasteDiscount('claude', cfg, null), 1);
});

test('nextScheduledReset + wasteDiscount apply to a windowless provider on a configured schedule', async () => {
  const { nextScheduledReset, wasteDiscount } = await import('../core/scorecard.mjs');
  const cfg = { usageResets: { grok: { periodHours: 24, resetHour: 18 } }, classes: { grok: 'included' }, wasteHorizonHours: 48, wasteStrength: 0.9, providerWeight: {} };
  const now = Date.parse('2026-09-15T10:00:00'); // local morning; next reset is 18:00 LOCAL today
  const nr = nextScheduledReset('grok', cfg, now);
  assert.ok(nr > now && (nr - now) / 3600e3 < 24, 'next reset stepped forward');
  assert.equal(new Date(nr).getHours(), 18, 'reset is at the configured local wall-clock hour (system timezone)');
  assert.ok(wasteDiscount('grok', cfg, null, now) < 0.5, 'a windowless provider near its scheduled reset is discounted (plow through it)');
  assert.equal(nextScheduledReset('codex', cfg, now), null, 'no schedule configured -> null');
});

test('method-c migration voids antigravity rows whose sel carried a spurious effort, idempotently', async () => {
  const { appendNdjson, statePath } = await import('../core/paths.mjs');
  const row = (taskId, model, effort) => appendNdjson(statePath('scorecard.ndjson'), { op: 'run', ts: new Date().toISOString(), taskId, source: 'live', provider: 'antigravity', model, effort, category: 'edit', difficulty: 2, status: 'done', tokens: { in: 100, out: 10, cached: 0, v: 2 }, durationMs: 100, title: 'x' });
  row('agy-bad', 'gemini-3.6-flash-low', 'high'); // raw effort-in-id model + spurious effort (the old bug)
  row('agy-good', 'gemini-3.8-flash', 'high');    // Method-C shape: family id + real effort
  sc.rateTask('agy-bad', 'pass'); sc.rateTask('agy-good', 'pass');
  assert.equal(sc.migrateScorecard(), 1);                                        // exactly the polluted row is voided
  assert.equal(sc.migrateScorecard(), 0);                                        // idempotent: nothing left to void
  assert.equal(sc.rootRuns().find((c) => c.taskId === 'agy-bad'), undefined);    // dropped from the aggregates
  assert.ok(sc.rootRuns().find((c) => c.taskId === 'agy-good'));                  // the clean family row survives
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

test('phantom verdict is distinct: scored 0, counted, surfaced in error rates', () => {
  sc.recordRun({ id: 'ph1', title: 'p', status: 'failed', failKind: 'phantom', provider: 'codex', model: 'gpt-5.6-luna', effort: 'low', category: 'test', difficulty: 2, result: { usage: { input_tokens: 10, output_tokens: 1 }, durationMs: 1 } }, {});
  sc.rateTask('ph1', 'phantom');
  const g = sc.summarize().find((x) => x.sel === 'codex:gpt-5.6-luna:low' && x.category === 'test' && x.difficulty === 2);
  assert.equal(g.phantom, 1); assert.equal(g.fail, 0); assert.equal(g.quality, 0); assert.equal(g.errorRate, 1); assert.equal(g.phantomRate, 1);
  const er = sc.errorRates();
  assert.ok(er.byProvider.find((e) => e.key === 'codex' && e.phantom >= 1));
  assert.ok(er.byModel.find((e) => e.key === 'codex:gpt-5.6-luna:low' && e.phantom >= 1));
  assert.doesNotThrow(() => sc.rateTask('ph1', 'phantom'));
  assert.throws(() => sc.rateTask('ph1', 'meh'), { status: 400 });
});

test('formatScores surfaces the phantom column and error-rate section', () => {
  const text = sc.formatScores();
  assert.match(text, /pass\/fix\/fail\/phantom/);
  assert.match(text, /Error rates/);
});

test('ui is a first-class category and classifyCategory tags UI/frontend work', () => {
  assert.ok(sc.CATEGORIES.includes('ui'));
  assert.equal(pr.KIND.ui, 'code');                                  // ui rides the code priors for cold-start defaults
  assert.equal(pr.priorFor('codex', 'gpt-6-astra', 'ui').tier, 'A'); // sensible default via the code kind
  for (const s of ['fix the CSS layout of the sidebar', 'the modal button style is broken', 'update styles.css', 'React component re-renders', 'make the panel responsive']) assert.equal(sc.classifyCategory(s), 'ui', s);
  for (const s of ['refactor the scheduler', 'add a retry to the API client', 'summarize the docs', '']) assert.equal(sc.classifyCategory(s), null, s);
});

test('short view: best pick + runner-up per category, levels collapsed, same top pick as recommend(); benched cells; csv', () => {
  const short = sc.formatScoresShort();
  const full = sc.formatScores();
  assert.ok(short.length < full.length / 2, 'short ' + short.length + ' vs full ' + full.length);
  const cfg = loadConfig().scorecard;
  for (const c of sc.CATEGORIES) for (const d of [1, 2, 3, 4, 5]) {
    const r = sc.recommend({ category: c, difficulty: d });
    if (!r) continue;
    const line = short.split('\n').find((l) => new RegExp('^- ' + c + '@(\\d-)?' + d + ':|^- ' + c + '@' + d + '-').test(l) || new RegExp('^- ' + c + '@(\\d)-(\\d):').test(l) && (() => { const m = /@(\d)-(\d):/.exec(l); return Number(m[1]) <= d && d <= Number(m[2]); })());
    assert.ok(line, 'no short line for ' + c + '@' + d);
    assert.ok(line.includes(r.provider + ':' + (r.model || 'default') + ':' + (r.effort || 'default')), line);
    assert.match(line, /runner-up/);
  }
  assert.match(short, /@\d-\d:/);                                     // identical levels collapsed into a range
  const bad = sc.summarize().find((g) => g.steps === 1 && g.rated >= cfg.minSamples && g.quality != null && g.quality < cfg.quality);
  if (bad) assert.ok(short.includes('- ' + bad.sel + ' ' + bad.category + '@' + bad.difficulty + ':'), 'benched cell listed');
  assert.equal(sc.formatScoresShort(), short);                           // memoised: same inputs, same text
  const csv = sc.scoresCsv();
  assert.match(csv.split('\n')[0], /^sel,category,difficulty,/);
  assert.equal(csv.trim().split('\n').length, sc.summarize().length + 1);
});

test('B1: a winning observed ladder dispatches its exact first worker, including tagged model IDs', (t) => {
  registryModels(t, [['ollama', 'qwen3.8:latest']]);
  for (const effort of [null, 'high']) {
    const source = `B1-${effort}`;
    for (const i of [1, 2, 3]) {
      const id = `${source}-${i}`;
      run({ id, source, provider: 'ollama', model: 'qwen3.8:latest', effort, category: 'edit' });
      sc.rateTask(id, 'fail');
      run({ id: `${id}-retry`, source, retryOf: id, model: 'gpt-5.6-terra', effort: 'medium', category: 'edit' });
      sc.rateTask(`${id}-retry`, 'pass');
    }
    const r = sc.recommend({ category: 'edit', difficulty: 2, source });
    assert.equal(r.plan.estimated, false);
    assert.deepEqual(r.plan.steps, [`ollama:qwen3.8:latest:${effort || 'default'}`, 'codex:gpt-5.6-terra:medium']);
    assert.deepEqual({ provider: r.provider, model: r.model, effort: r.effort }, { provider: 'ollama', model: 'qwen3.8:latest', effort });
    assert.deepEqual(r.fallback, { provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium' });
  }
});

test('B6: observed mixed-provider costs are weighted per step, including paid then local and pooled levels', async (t) => {
  registryModels(t, [['claude', 'paid'], ['codex', 'fallback'], ['ollama', 'local:latest']]);
  const cfg = loadConfig().scorecard;
  const { getLimits } = await import('../core/limits.mjs');
  const limits = getLimits();
  const previous = { ...limits.providers };
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    saveConfig({ scorecard: { classOrder: ['conductor', 'subscription', 'free'], providerWeight: { claude: 0.5, codex: 0.2, ollama: 0 }, reservePct: 0.5, hourlyUsd: 3.6, wasteStrength: 0.9, wasteHorizonHours: 48, prices: { 'claude:paid': { in: 1, out: 0, cached: 0 }, 'codex:fallback': { in: 1, out: 0, cached: 0 }, 'ollama:local:latest': { in: 1, out: 0, cached: 0 } } } });
    limits.providers.claude = { windows: [] };
    limits.providers.ollama = { windows: [] };
    limits.providers.codex = { windows: [{ id: 'weekly', label: 'weekly', usedPercent: 20, resetsAt: now + 6 * 3600e3 }] };
    for (const provider of ['ollama', 'codex']) {
      const source = `B6-${provider}`, model = provider === 'ollama' ? 'local:latest' : 'fallback';
      for (const i of [1, 2, 3]) {
        const id = `${source}-${i}`, difficulty = i === 1 ? 2 : 3;
        run({ id, source, provider: 'claude', model: 'paid', effort: null, category: 'edit', difficulty, result: { usage: { input_tokens: i * 1e6 }, durationMs: i * 1000 } });
        sc.rateTask(id, 'fail');
        run({ id: `${id}-retry`, source, retryOf: id, provider, model, effort: null, category: 'edit', difficulty, result: { usage: { input_tokens: i * 2e6 }, durationMs: i * 2000 } });
        sc.rateTask(`${id}-retry`, 'pass');
        run({ id: `${id}-ceiling`, source, provider: 'claude', model: 'paid', effort: null, category: 'read', difficulty: 5 });
        sc.rateTask(`${id}-ceiling`, 'pass');
      }
      const summary = sc.summarize({ source });
      const r = sc.recommend({ category: 'edit', difficulty: 2, summary });
      assert.deepEqual(r.plan.steps, ['claude:paid:default', `${provider}:${model}:default`]);
      assert.equal(r.plan.estimated, false);
      const paid = (2 + 0.002) * 0.5 * (1 + 0.5 * 0.5 * (5 - 2));
      const fallback = provider === 'ollama' ? 0 : (4 + 0.004) * 0.2 * (1 - (1 - 6 / 48) * 0.8 * 0.9); // thin cells do not establish a provider ceiling
      assert.ok(Math.abs(r.plan.usd - paid - fallback) < 1e-9, `${provider}: ${r.plan.usd} vs ${paid + fallback}`);
      assert.deepEqual(summary.filter((g) => g.steps === 2).map((g) => g.avgUsd), [3, 7.5], 'display keeps raw shadow dollars');
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
        run({ id, source, provider: 'ollama', model: 'qwen', effort: null, category: 'edit', difficulty: 2 });
        sc.rateTask(id, observed ? 'fail' : 'pass');
        run({ id: `${id}-fallback`, source, retryOf: observed ? id : null, model: 'gpt-5.6-terra', effort: 'medium', category: 'edit', difficulty: 2 });
        sc.rateTask(`${id}-fallback`, 'pass');
        run({ id: `${id}-fail`, source, provider: 'ollama', model: 'qwen', effort: null, category: 'edit', difficulty: 3 });
        sc.rateTask(`${id}-fail`, 'fail');
      }
      const request = { category: 'edit', difficulty: 3, source };
      const ladder = sc.recommend(request);
      assert.deepEqual(ladder.plan.steps, ['ollama:qwen:default', 'codex:gpt-5.6-terra:medium']);
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
    const local = { ...request, difficulty: 1, providers: ['ollama'] };
    assert.equal(sc.selOf(sc.recommend(local)), 'ollama:qwen:default');
    assert.equal(sc.recommend({ ...local, exclude: ['ollama:qwen:default'] }), null, 'models without effort use the canonical default selection');
  } finally {
    saveConfig({ scorecard: cfg });
  }
});

test('R2H1: tagged measured selections honor whole-model exclusions and scoped quotas', async (t) => {
  registryModels(t, [['ollama', 'qwen3.8:latest']]);
  const { getLimits } = await import('../core/limits.mjs');
  const limits = getLimits(), previous = limits.providers.ollama;
  const cfg = loadConfig().scorecard;
  const source = 'R2H1';
  try {
    saveConfig({ scorecard: { usePriors: false } });
    limits.providers.ollama = { windows: [] };
    for (const i of [1, 2, 3]) {
      run({ id: `${source}-${i}`, source, provider: 'ollama', model: 'qwen3.8:latest', effort: 'high' });
      sc.rateTask(`${source}-${i}`, 'pass');
      run({ id: `${source}-other-${i}`, source, provider: 'ollama', model: 'qwen', effort: null });
      sc.rateTask(`${source}-other-${i}`, 'pass');
    }
    const request = { category: 'implement', difficulty: 2, source, exclude: ['ollama:qwen'] };
    assert.equal(sc.recommend(request).model, 'qwen3.8:latest');
    for (const excluded of ['ollama:qwen3.8:latest', 'ollama:qwen3.8:latest:high']) {
      assert.equal(sc.recommend({ ...request, exclude: [...request.exclude, excluded] }), null);
    }
    assert.equal(sc.recommend({ ...request, exclude: [...request.exclude, 'ollama:qwen3.8:latest:low'] }).model, 'qwen3.8:latest');
    limits.providers.ollama.windows = [{ id: 'tagged', models: ':latest$', usedPercent: 100, resetsAt: Date.now() + 60_000 }];
    assert.equal(sc.recommend(request), null, 'full tagged-model window blocks the measured selection');
    assert.equal(sc.recommend({ ...request, exclude: [] }).model, 'qwen', 'unmetered model stays usable');
    limits.providers.ollama.windows[0].usedPercent = 0;
    limits.providers.ollama.windows[0].status = 'rejected';
    assert.equal(sc.recommend(request), null, 'rejected scoped window also blocks');
    limits.providers.ollama.windows[0].resetsAt = Date.now() - 1;
    assert.equal(sc.recommend(request).model, 'qwen3.8:latest', 'expired scoped windows do not block');
  } finally { limits.providers.ollama = previous; saveConfig({ scorecard: cfg }); }
});

test('R2B2: every measured plan step must remain usable in the registry, including aliases', async () => {
  const { getModels } = await import('../core/models.mjs');
  const { getLimits } = await import('../core/limits.mjs');
  const reg = getModels(), limits = getLimits();
  const previous = { models: reg.models, providers: reg.providers, limits: limits.providers };
  const cfg = loadConfig().scorecard;
  const local = 'ollama:qwen:default', remote = 'codex:gpt-5.6-terra:medium';
  const cell = (steps) => ({ sel: steps.join('>'), steps: steps.length, provider: steps.length === 1 ? steps[0].split(':')[0] : undefined,
    category: 'edit', difficulty: 2, rated: 3, n: 3, quality: 1, accept: 1, avgUsd: 0.01, avgDurationMs: 0 });
  try {
    saveConfig({ scorecard: { usePriors: false } });
    reg.models = [{ provider: 'ollama', id: 'qwen', kind: 'agent' }, { provider: 'codex', id: 'terra-alias', resolved: 'gpt-5.6-terra', kind: 'agent' }];
    reg.providers = { ollama: { status: 'ok' }, codex: { status: 'ok' } };
    limits.providers = {};
    const pick = (summary) => sc.recommend({ category: 'edit', difficulty: 2, summary });
    assert.equal(pick([cell([remote])]).model, 'gpt-5.6-terra', 'resolved registry aliases are usable');
    for (const steps of [[local], [local, remote], [remote, local]]) {
      const summary = [cell(steps)];
      assert.ok(pick(summary), `available plan ${steps}`);
      reg.providers.ollama.status = 'unavailable';
      assert.equal(pick(summary), null, `unavailable provider anywhere in ${steps}`);
      reg.providers.ollama.status = 'error';
      assert.ok(pick(summary), 'transient errors retain cached measured models');
      delete reg.providers.ollama;
      assert.ok(pick(summary), 'unknown provider status does not reject a listed measured model');
      reg.providers.ollama = { status: 'ok' };
      const model = reg.models.shift();
      assert.equal(pick(summary), null, `removed model anywhere in ${steps}`);
      reg.models.unshift(model);
      model.kind = 'image';
      assert.equal(pick(summary), null, 'non-agent entries cannot execute a measured worker plan');
      model.kind = 'agent';
    }
    reg.providers.ollama.status = 'unavailable';
    assert.equal(pick([cell([local]), cell([remote])]).provider, 'codex', 'qualified available alternative wins');
  } finally { reg.models = previous.models; reg.providers = previous.providers; limits.providers = previous.limits; saveConfig({ scorecard: cfg }); }
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

test('R2B6: voids invalidate cached admission costs and are filtered on stat fallback', async (t) => {
  const { measuredCostByWindow, admit } = await import('../core/sweep.mjs');
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const provider = 'r2b6-fixture';
  for (const [taskId, delta] of [['R2B6-valid', 3], ['R2B6-void', 90]]) {
    appendNdjson(statePath('scorecard.ndjson'), { op: 'run', taskId, provider, pct: { weekly: delta } });
  }
  const windows = [{ id: 'weekly', label: 'weekly', usedPercent: 50 }];
  const cost = () => measuredCostByWindow(sc.runRows(), provider);
  assert.deepEqual(cost(), { weekly: 90 });
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

test('D7: a run with no reported usage is unknown cost, except a zero list price is really $0', () => {
  run({ id: 'D7-missing', source: 'D7-missing', category: 'read', difficulty: 1, result: { durationMs: 1000 } });
  sc.rateTask('D7-missing', 'pass');
  const missing = sc.rootRuns({ source: 'D7-missing' }).find((c) => c.taskId === 'D7-missing');
  assert.equal(missing.usd, null);
  assert.equal(missing.attempts[0].usd, null);
  assert.equal(sc.summarize({ source: 'D7-missing' }).find((g) => g.sel === 'codex:gpt-5.6-luna:low').avgUsd, null);

  run({ id: 'D7-local', source: 'D7-local', provider: 'ollama', model: 'qwen', effort: null, category: 'read', difficulty: 1, result: { durationMs: 1000 } });
  sc.rateTask('D7-local', 'pass');
  const local = sc.rootRuns({ source: 'D7-local' }).find((c) => c.taskId === 'D7-local');
  assert.equal(local.usd, 0);
  assert.equal(sc.summarize({ source: 'D7-local' }).find((g) => g.provider === 'ollama').avgUsd, 0);
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

test('escalate: priced plan wins a quality tie against an unknown-cost plan', () => {
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
    assert.equal(r.model, 'gpt-5.6-luna', 'priced luna wins the quality tie over unknown-cost terra');
  } finally { saveConfig({ scorecard: cfg }); }
});

test('B5: provenButCapped honors the caller providers allow-list so a blocked excluded provider does not block extrapolation', async () => {
  const { getLimits } = await import('../core/limits.mjs');
  const cfg = loadConfig().scorecard;
  const limits = getLimits();
  const previous = limits.providers.codex;
  const source = 'B5-allow';
  try {
    saveConfig({ scorecard: { usePriors: false, reservePct: 0 } });
    for (const i of [1, 2, 3]) {
      run({ id: `${source}-codex-${i}`, source, provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', category: 'implement', difficulty: 4 });
      sc.rateTask(`${source}-codex-${i}`, 'pass');
      run({ id: `${source}-ollama-${i}`, source, provider: 'ollama', model: 'qwen', effort: null, category: 'implement', difficulty: 2 });
      sc.rateTask(`${source}-ollama-${i}`, 'pass');
    }
    limits.providers.codex = { ...(previous || {}), provider: 'codex', blocked: true, blockedUntil: Date.now() + 3.6e6, windows: previous?.windows || [] };
    const r = sc.recommend({ category: 'implement', difficulty: 4, source, providers: ['ollama'] });
    assert.equal(r.provider, 'ollama');
    assert.match(r.reason, /extrapolated from level 2/);
  } finally {
    limits.providers.codex = previous;
    saveConfig({ scorecard: cfg });
  }
});

test('B1: effort dominance uses parseSel so model ids containing a colon still dominate', (t) => {
  registryModels(t, [['ollama', 'qwen3.8:latest']]);
  const cfg = loadConfig().scorecard;
  saveConfig({ scorecard: { usePriors: false, reservePct: 0, effortSlackUsd: 0.01, effortSlackPct: 10 } });
  t.after(() => saveConfig({ scorecard: cfg }));
  const cell = (effort) => ({
    sel: `ollama:qwen3.8:latest:${effort}`, steps: 1, provider: 'ollama', model: 'qwen3.8:latest', effort,
    category: 'docs', difficulty: 1, rated: 3, n: 3, quality: 1, accept: 1, avgUsd: 0, avgDurationMs: 0,
  });
  const r = sc.recommend({ category: 'docs', difficulty: 1, summary: [cell('low'), cell('high')] });
  assert.equal(r.model, 'qwen3.8:latest');
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
    assert.equal(chain.usd, chain.attempts[0].usd);

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
    run({ id: `${source}-local`, source, provider: 'ollama', model: 'qwen', effort: null, category: 'search', difficulty: 1, result: { durationMs: 1000 } });
    sc.rateTask(`${source}-local`, 'pass');
    assert.equal(sc.summarize({ source }).find((g) => g.provider === 'ollama').avgUsd, 0);
  } finally { saveConfig({ scorecard: cfg }); }
});

