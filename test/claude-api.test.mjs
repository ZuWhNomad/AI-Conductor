import { HOME } from './_env.mjs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendNdjson, statePath } from '../core/paths.ts';

// Fake Agent SDK: records the options a worker passes and replays canned messages.
const sdkUrl = 'data:text/javascript,' + encodeURIComponent(`
  export function query(opts) {
    globalThis.__claudeQueryOpts = opts;
    return (async function* () { for (const m of globalThis.__claudeMessages || []) yield m; })();
  }
`);
registerHooks({ resolve: (specifier, context, next) => specifier === '@anthropic-ai/claude-agent-sdk' ? { url: sdkUrl, shortCircuit: true } : next(specifier, context) });

const { saveConfig, publicConfig } = await import('../core/config.mjs');
const api = await import('../core/providers/claude-api.mjs');
const { getProvider, providerSummaries } = await import('../core/providers/index.mjs');
const { runWorker } = await import('../core/workers/index.mjs');
const { getModels, refreshModels } = await import('../core/models.mjs');
const sc = await import('../core/scorecard.mjs');
const { withBorrowedEvidence, providerClass, providerAvailable } = await import('../core/scorecard/recommend.mjs');
const { describeTask } = await import('../core/tasks/view.mjs');

// Obviously fake, not key-shaped. Each scenario uses its own value: the credit probe is cached per key for a minute.
const FAKE = (tag) => `fake-claude-api-key-for-tests-${tag}`;
const setKey = (tag) => saveConfig({ providers: { 'claude-api': { apiKey: tag ? FAKE(tag) : null } } });

/** fetch stub for the Anthropic API: the Models list, then the 1-token probe answered with `probe`. */
function stubApi(t, { models = 200, probe = { status: 200, body: '{}' } } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }] }), { status: models });
    return new Response(probe.body, { status: probe.status });
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

test('registered as its own provider: Claude harness, API-key auth, billed per token, key redacted', () => {
  const p = getProvider('claude-api');
  assert.equal(p.kind, 'claude');
  assert.equal(p.auth.type, 'apiKey');
  assert.ok(providerSummaries().some((s) => s.id === 'claude-api'));
  setKey('redact');
  assert.equal(publicConfig().providers['claude-api'].apiKey, '••••');
  assert.equal(providerClass('claude-api'), 'api');
  assert.equal(providerClass('claude'), 'conductor');
  assert.equal(providerAvailable('claude-api'), false, 'pay-per-token: only with API overflow on');
});

test('fake CLI: the apiKeyHelper command, run the way Claude Code runs it, prints the key from config.json', () => {
  setKey('helper');
  const { env, settings } = api.workerOptions();
  assert.ok(existsSync(env.CLAUDE_CONFIG_DIR) && env.CLAUDE_CONFIG_DIR.startsWith(HOME), 'own config folder inside the state dir');
  const childEnv = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v != null));
  const ok = spawnSync(settings.apiKeyHelper, { shell: true, env: childEnv, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, FAKE('helper'));
  setKey(null);
  const none = spawnSync(settings.apiKeyHelper, { shell: true, env: childEnv, encoding: 'utf8' });
  assert.equal(none.status, 1);
  assert.equal(none.stdout, '');
});

test('worker: own config folder + helper, no inherited credential, cost and tokens reported as billed', async (t) => {
  setKey('worker');
  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'fake-inherited-value-for-tests';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fake-inherited-token-for-tests';
  t.after(() => { for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; });
  const usage = { 'claude-haiku-5-5': { inputTokens: 12, outputTokens: 34, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0021 } };
  globalThis.__claudeMessages = [
    { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-5-5' },
    { type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.0021, modelUsage: usage },
  ];
  const r = await runWorker({ id: 'api-1', cwd: process.cwd(), prompt: 'x', provider: 'claude-api', model: 'claude-haiku-5-5' });
  const o = globalThis.__claudeQueryOpts.options;
  assert.equal(r.ok, true, r.error);
  assert.equal(o.env.CLAUDE_CONFIG_DIR, statePath('claude-api'));
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(k in o.env, false, k);
  assert.match(o.settings.apiKeyHelper, /claude-api-key\.mjs"$/);
  assert.equal(JSON.stringify(globalThis.__claudeQueryOpts).includes(FAKE('worker')), false, 'the key itself never reaches the CLI options');
  assert.equal(r.costUsd, 0.0021);
  assert.deepEqual(r.usage, usage);
  const view = describeTask({ id: 'api-1', status: 'done', provider: 'claude-api', result: { finalMessage: 'done', usage, costUsd: 0.0021, billed: true } });
  assert.match(view, /Cost: \$0\.0021 \(billed to API credits\)/);

  // The subscription worker is untouched: no config folder, no helper.
  await runWorker({ id: 'sub-1', cwd: process.cwd(), prompt: 'x', provider: 'claude' });
  assert.equal(globalThis.__claudeQueryOpts.options.env, undefined);
  assert.equal(globalThis.__claudeQueryOpts.options.settings, undefined);
});

test('worker: running out of credit is a limit hit (fail over or park), not a model failure', async () => {
  setKey('worker-credit');
  globalThis.__claudeMessages = [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'] }];
  const r = await runWorker({ id: 'api-2', cwd: process.cwd(), prompt: 'x', provider: 'claude-api', model: 'claude-haiku-5-5' });
  assert.equal(r.ok, false);
  assert.equal(r.limitHit, true);
  globalThis.__claudeMessages = [{ type: 'assistant', error: 'billing_error', message: { content: [] } }, { type: 'result', subtype: 'success', is_error: true, result: 'billing' }];
  assert.equal((await runWorker({ id: 'api-3', cwd: process.cwd(), prompt: 'x', provider: 'claude-api', model: 'claude-haiku-5-5' })).limitHit, true);
});

test('status: no key, low credit, rejected key and ok each report plainly; low credit blocks routing', async (t) => {
  setKey(null);
  assert.deepEqual(await api.detect(), { installed: true, configured: false });

  setKey('no-credit');
  const calls = stubApi(t, { probe: { status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}' } });
  const det = await api.detect();
  assert.equal(det.loggedIn, false);
  assert.equal(det.status, 'no-credit');
  assert.match(det.error, /credit balance is too low/);
  const probe = calls.find((c) => c.url.endsWith('/v1/messages'));
  assert.equal(JSON.parse(probe.init.body).model, 'claude-haiku-5-5', 'the probe uses the cheapest listed model');
  assert.equal(JSON.parse(probe.init.body).max_tokens, 1);
  assert.deepEqual(await api.pollLimits(), { provider: 'claude-api', plan: 'api-key', blocked: true, blockedReason: 'credit balance too low', windows: [] });
  const before = calls.length;
  await api.detect();
  assert.equal(calls.length, before, 'probe cached for a minute');
  const reg = await refreshModels({ only: ['claude-api'] });
  assert.equal(reg.providers['claude-api'].status, 'no-credit');
  assert.ok(reg.models.some((m) => m.provider === 'claude-api' && m.id === 'claude-opus-5-5' && m.cost === 'api'));

  setKey('rejected');
  stubApi(t, { models: 401 });
  assert.deepEqual(await api.detect(), { installed: true, configured: true, loggedIn: false, status: 'unavailable', error: 'API key rejected (401)' });

  setKey('busy');
  stubApi(t, { probe: { status: 529, body: 'overloaded' } });
  assert.deepEqual(await api.detect(), { installed: true, configured: true, loggedIn: true });
  setKey('ok');
  stubApi(t);
  assert.deepEqual(await api.detect(), { installed: true, configured: true, loggedIn: true });
  assert.equal((await refreshModels({ only: ['claude-api'] })).providers['claude-api'].status, 'ok');
});

test('scorecard: claude-api borrows the subscription\'s single-model evidence until it has its own cell', () => {
  const cell = (provider, extra = {}) => ({ provider, model: 'claude-opus-5-5', effort: 'high', sel: `${provider}:claude-opus-5-5:high`, steps: 1, category: 'debug', difficulty: 3, stepCosts: [{ sel: `${provider}:claude-opus-5-5:high`, avgUsd: 1 }], ...extra });
  const chain = { ...cell('claude'), sel: 'claude:claude-haiku-5-5:low>claude:claude-opus-5-5:high', steps: 2 };
  const out = withBorrowedEvidence([cell('claude'), chain]);
  const borrowed = out.find((g) => g.provider === 'claude-api');
  assert.equal(out.length, 3, 'chains are not borrowed');
  assert.equal(borrowed.sel, 'claude-api:claude-opus-5-5:high');
  assert.equal(borrowed.stepCosts[0].sel, 'claude-api:claude-opus-5-5:high');
  assert.equal(borrowed.borrowedFrom, 'claude:claude-opus-5-5:high');
  const own = cell('claude-api', { quality: 0 });
  assert.deepEqual(withBorrowedEvidence([cell('claude'), own]).filter((g) => g.provider === 'claude-api'), [own], 'its own cell wins');
});

test('recommend: with API overflow on and the subscription unavailable, the same Claude model routes to claude-api', (t) => {
  const reg = getModels();
  const before = structuredClone({ models: reg.models, providers: reg.providers });
  t.after(() => { reg.models = before.models; reg.providers = before.providers; });
  const model = 'claude-opus-5-5';
  reg.models = [...reg.models.filter((m) => m.provider !== 'claude' && m.provider !== 'claude-api'), ...['claude', 'claude-api'].map((provider) => ({ provider, id: model, kind: 'agent', efforts: ['low', 'medium', 'high'] }))];
  reg.providers = { ...reg.providers, claude: { status: 'unavailable' }, 'claude-api': { status: 'ok' } };
  const ts = new Date().toISOString();
  appendNdjson(statePath('scorecard.ndjson'), { op: 'run', ts, taskId: 'borrow-0', followUpOf: null, retryOf: null, source: 'smoke', provider: 'claude', model, requestedModel: model, effort: 'high', category: 'debug', difficulty: 3, status: 'done', tokens: { in: 1000, out: 1000, cached: 0, write: 0, v: 2 }, costUsd: 0.05, durationMs: 1, smokeId: 'debug-3-borrow' });
  appendNdjson(statePath('scorecard.ndjson'), { op: 'rate', ts, taskId: 'borrow-0', verdict: 'pass' });
  const ask = (overflowApi) => sc.recommend({ category: 'debug', difficulty: 3, source: 'smoke', overflowApi });
  assert.equal(ask(false), null, 'no API spend without overflow');
  assert.equal(sc.selOf(ask(true)), `claude-api:${model}:high`);
  reg.providers = { ...reg.providers, 'claude-api': { status: 'no-credit' } };
  assert.equal(ask(true), null, 'no credit, no route');
});
