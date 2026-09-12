import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeJson } from '../core/paths.mjs';

// Registries are loaded at import time: seed them before importing the scorecard.
writeJson(join(HOME, 'models.json'), { updatedAt: 'x', providers: { codex: { status: 'ok' }, claude: { status: 'ok' }, ollama: { status: 'ok' } }, models: [
  { provider: 'ollama', id: 'qwen', kind: 'agent', cost: 'free-local' },
  { provider: 'codex', id: 'gpt-5.6-luna', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'codex', id: 'gpt-5.6-terra', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'codex', id: 'gpt-6-astra', kind: 'agent', cost: 'subscription', efforts: ['low', 'medium'] },
  { provider: 'claude', id: 'haiku', kind: 'agent', cost: 'subscription' },
] });
writeJson(join(HOME, 'limits.json'), { updatedAt: 'x', providers: {
  codex: { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] },
} });

const sc = await import('../core/scorecard.mjs');
const pr = await import('../core/priors.mjs');
const { loadConfig, saveConfig } = await import('../core/config.mjs');

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

test('a higher effort within the cost slack dominates the lower effort of the same model', () => {
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

test('reservation: capacity proven at high levels is held back for high levels; the cheap tier does the grunt work', () => {
  // Two providers with identical list cost and quality at level 1: antigravity (weight 0.1, ceiling 1) vs codex Terra (weight 0.6, ceiling 4).
  saveConfig({ scorecard: { prices: { 'antigravity:flash': { in: 2, out: 12, cached: 0.2 } }, providerWeight: { antigravity: 0.1, codex: 0.6, claude: 1, ollama: 0 }, reservePct: 0.5 } });
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
  assert.equal(sc.providerAvailable('claude'), true);
  lim.getLimits().providers.claude.windows[0].usedPercent = 96;
  assert.equal(sc.providerAvailable('claude'), false);
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', label: 'Codex weekly', usedPercent: 99, resetsAt: 1000 }] };
  assert.equal(sc.providerAvailable('codex'), true);   // subscriptions run to 100%
  lim.getLimits().providers.codex = { provider: 'codex', windows: [{ id: 'codex:primary', usedPercent: 12, resetsAt: 1000 }, { id: 'codex:secondary', usedPercent: 40, resetsAt: 2000 }] };
  delete lim.getLimits().providers.claude;
});

test('modeling is a first-class category (journaled and scored as itself, not as other)', () => {
  assert.ok(sc.CATEGORIES.includes('modeling'));
  run({ id: 'mod1', category: 'modeling', difficulty: 4 });
  sc.rateTask('mod1', 'fixable');
  assert.ok(sc.summarize().some((g) => g.category === 'modeling' && g.difficulty === 4));
});

test('a hand-routed model without an effort gets the higher of the configured default and the difficulty target', () => {
  const reg = { models: [{ provider: 'codex', id: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }, { provider: 'antigravity', id: 'gemini-3.8-flash-low', efforts: [] }] };
  assert.equal(sc.effortForTask({ provider: 'codex', model: 'gpt-6-astra', difficulty: 4, defaultEffort: 'medium', reg }), 'high');   // the bug: medium default, hard task
  assert.equal(sc.effortForTask({ provider: 'codex', model: 'gpt-6-astra', difficulty: 2, defaultEffort: 'high', reg }), 'high');     // never below the configured default
  assert.equal(sc.effortForTask({ provider: 'codex', model: 'gpt-6-astra', difficulty: 5, defaultEffort: 'high', reg }), 'xhigh');
  assert.equal(sc.effortForTask({ provider: 'antigravity', model: 'gemini-3.8-flash-low', difficulty: 4, defaultEffort: 'high', reg }), 'high'); // no effort levels: default passes through
  assert.equal(sc.effortForTask({ provider: 'codex', model: 'nope', difficulty: 4, defaultEffort: null, reg }), null);
});
