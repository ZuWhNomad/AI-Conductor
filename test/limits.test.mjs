import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { noteHttp, noteRateLimitEvent, blockedUntil, getLimits, mergePoll } = await import('../core/limits.mjs');
const { normalizeUsage, windowFromEvent } = await import('../core/providers/anthropic.mjs');

test('429 blocks until retry-after; a later 2xx unblocks', () => {
  noteHttp('deepseek', 429, { 'Retry-After': '60' });
  assert.ok(blockedUntil('deepseek') > Date.now());
  noteHttp('deepseek', 200, { 'x-ratelimit-remaining-requests': '50', 'x-ratelimit-limit-requests': '100' });
  assert.equal(blockedUntil('deepseek'), null);
  assert.equal(getLimits().providers.deepseek.windows[0].usedPercent, 50);
});

test('SDK rate-limit events update windows and block/unblock', () => {
  noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 600 });
  assert.ok(blockedUntil('claude') > Date.now());
  const w = getLimits().providers.claude.windows.find((x) => x.id === 'five_hour');
  assert.equal(w.usedPercent, 100);
  noteRateLimitEvent('claude', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 });
  assert.equal(blockedUntil('claude'), null);
  assert.equal(getLimits().providers.claude.windows.find((x) => x.id === 'five_hour').usedPercent, 50);
  assert.equal(windowFromEvent({}), null);
});

test('usage control response normalizes into windows', () => {
  const r = normalizeUsage({ subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 42, resets_at: '2026-09-08T00:00:00Z' }, seven_day: { utilization: 100, resets_at: '2026-09-10T00:00:00Z' }, model_scoped: [{ display_name: 'Fable', utilization: 10, resets_at: null }] } });
  assert.equal(r.plan, 'max');
  assert.equal(r.blocked, true);
  assert.equal(r.windows.length, 3);
  assert.equal(r.windows[0].usedPercent, 42);
  assert.equal(typeof r.windows[0].resetsAt, 'number');
});

test('retry-after HTTP dates block until the given date', () => {
  const until = Date.now() + 3600e3;
  noteHttp('deepseek', 429, { 'retry-after': new Date(until).toUTCString() });
  assert.ok(Math.abs(blockedUntil('deepseek') - until) < 60_000);
  for (const retry of ['nonsense', new Date(Date.now() - 3600e3).toUTCString()]) {
    noteHttp('deepseek', 429, { 'retry-after': retry });
    assert.ok(Math.abs(blockedUntil('deepseek') - Date.now() - 60_000) < 1000);
  }
});

test('only usable unscoped request windows can clear an active HTTP block', () => {
  const prev = { blocked: true, blockedReason: '429', blockedUntil: Date.now() + 3600e3 };
  const empty = { provider: 'deepseek', blocked: false, windows: [] };
  const kept = mergePoll(prev, empty);
  assert.equal(kept.blocked, true);
  assert.equal(kept.blockedUntil, prev.blockedUntil);
  assert.equal(kept.blockedReason, '429');
  const cleared = mergePoll(prev, { ...empty, windows: [{ id: 'requests', usedPercent: 50 }] });
  assert.equal(cleared.blocked, false);
  assert.equal(cleared.blockedUntil, null);
  assert.equal(mergePoll({ ...prev, blockedUntil: Date.now() - 1000 }, empty).blocked, false);
  assert.equal(empty.blocked, false);
  for (const windows of [
    [{ id: 'deepseek:budget', usedPercent: 0 }],
    [{ id: 'requests', usedPercent: 50, models: 'opus' }],
    [{ id: 'requests', usedPercent: 50, status: 'rejected' }],
    [{ id: 'requests', usedPercent: 50, resetsAt: Date.now() - 1 }],
    ...[undefined, null, NaN, -1, 100].map((usedPercent) => [{ id: 'requests', usedPercent }]),
  ]) {
    const result = mergePoll(prev, { ...empty, windows });
    assert.equal(result.blockedUntil, prev.blockedUntil);
    assert.equal(result.blockedReason, '429');
    assert.deepEqual(result.windows, windows);
  }
});

test('funded balance refresh preserves a 429 deadline until expiration', async (t) => {
  const { refreshLimits } = await import('../core/limits.mjs');
  const { loadConfig, saveConfig } = await import('../core/config.mjs');
  const original = loadConfig().providers.deepseek;
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: '10', currency: 'USD' }] }) };
  });
  try {
    saveConfig({ providers: { deepseek: { apiKey: 'test-only', baseUrl: '' } } });
    noteHttp('deepseek', 429, { 'Retry-After': '60' });
    const until = blockedUntil('deepseek');
    await refreshLimits({ only: ['deepseek'] });
    assert.equal(getLimits().providers.deepseek.balance.amount, 10);
    assert.equal(getLimits().providers.deepseek.windows[0].id, 'deepseek:budget');
    assert.equal(blockedUntil('deepseek'), until);
    t.mock.method(Date, 'now', () => until);
    assert.equal(blockedUntil('deepseek'), null);
    assert.equal(getLimits().providers.deepseek.blockedReason, null);
  } finally { saveConfig({ providers: { deepseek: original || { apiKey: '', baseUrl: '' } } }); }
});

test('empty and failed refreshes preserve the active HTTP retry deadline', async () => {
  const { refreshLimits } = await import('../core/limits.mjs');
  const { PROVIDERS } = await import('../core/providers/index.mjs');
  const id = 'fake-http-retry';
  try {
    noteHttp(id, 429, { 'Retry-After': '60' });
    const until = blockedUntil(id);
    for (const pollLimits of [
      async () => ({ provider: id, blocked: false, windows: [] }),
      async () => { throw new Error('offline'); },
    ]) {
      PROVIDERS[id] = { id, pollLimits };
      await refreshLimits({ only: [id] });
      assert.equal(blockedUntil(id), until);
      assert.equal(getLimits().providers[id].blockedReason, '429');
    }
    assert.equal(getLimits().providers[id].error, 'offline');
  } finally { delete PROVIDERS[id]; }
});

test('request recovery from an in-flight poll does not clear a newer HTTP block', async () => {
  const { refreshLimits } = await import('../core/limits.mjs');
  const { PROVIDERS } = await import('../core/providers/index.mjs');
  const id = 'fake-http-recovery';
  let resolvePoll;
  const pending = new Promise((resolve) => { resolvePoll = resolve; });
  try {
    PROVIDERS[id] = { id, pollLimits: () => pending };
    noteHttp(id, 429, { 'Retry-After': '60' });
    const refresh = refreshLimits({ only: [id] });
    noteHttp(id, 429, { 'Retry-After': '120' });
    const until = blockedUntil(id);
    resolvePoll({ provider: id, blocked: false, windows: [{ id: 'requests', usedPercent: 50 }] });
    await refresh;
    assert.equal(blockedUntil(id), until);
    assert.equal(getLimits().providers[id].blockedReason, '429');
    await refreshLimits({ only: [id] });
    assert.equal(blockedUntil(id), null, 'a subsequent request-limit poll can establish recovery');
  } finally { delete PROVIDERS[id]; }
});

test('poll merging keeps the stronger global block without globalizing model quotas', async () => {
  const { modelBlockedUntil } = await import('../core/limits.mjs');
  const until = Date.now() + 60_000;
  const prev = { blocked: true, blockedReason: '429', blockedUntil: until };
  const scoped = { id: 'seven_day_opus', models: 'opus', usedPercent: 100, resetsAt: until + 60_000 };
  for (const reset of [until - 1, until + 1]) {
    const result = mergePoll(prev, { blocked: true, windows: [{ id: 'requests', usedPercent: 100, resetsAt: reset }, scoped] });
    assert.equal(result.blockedUntil, Math.max(until, reset));
    assert.deepEqual(result.windows[1], scoped);
    assert.equal(mergePoll(result, { blocked: false, windows: [{ id: 'deepseek:budget', usedPercent: 0 }] }).blockedUntil, until);
  }
  const indefinite = mergePoll(prev, { blocked: true, blockedReason: 'balance exhausted', windows: [] });
  assert.equal(indefinite.blocked, true);
  assert.equal(indefinite.blockedUntil, null);
  assert.equal(indefinite.blockedReason, 'balance exhausted');
  assert.equal(mergePoll(indefinite, { blocked: false, windows: [{ id: 'deepseek:budget', usedPercent: 0 }] }).blockedUntil, until);
  assert.equal(mergePoll(indefinite, { blocked: false, windows: [{ id: 'requests', usedPercent: 50 }] }).blocked, false);
  const id = 'fake-http-scoped';
  try {
    getLimits().providers[id] = indefinite;
    noteHttp(id, 200);
    assert.equal(getLimits().providers[id].blockedReason, 'balance exhausted');
    assert.equal(mergePoll(getLimits().providers[id], { blocked: false, windows: [{ id: 'deepseek:budget', usedPercent: 0 }] }).blocked, false);
    getLimits().providers[id] = mergePoll(prev, { blocked: false, windows: [{ id: 'requests', usedPercent: 50 }, scoped] });
    assert.equal(blockedUntil(id), null);
    assert.equal(modelBlockedUntil(id, 'opus'), scoped.resetsAt);
    assert.equal(modelBlockedUntil(id, 'sonnet'), null);
  } finally { delete getLimits().providers[id]; }
});

test('blockedUntil sees an external block without a prior explicit getLimits call', async () => {
  const { writeFileSync, utimesSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { HOME } = await import('./_env.mjs');
  const f = join(HOME, 'limits.json');
  const future = Date.now() + 600_000;
  writeFileSync(f, JSON.stringify({ updatedAt: new Date().toISOString(), providers: { grok: { provider: 'grok', blocked: true, blockedUntil: future, blockedReason: '429', windows: [] } } }));
  const t = new Date(Date.now() + 5000); utimesSync(f, t, t);
  assert.equal(blockedUntil('grok'), future);
});

test('live writers (noteHttp, noteRateLimitEvent) preserve externally updated unrelated providers', async () => {
  const { writeFileSync, readFileSync, utimesSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { HOME } = await import('./_env.mjs');
  const f = join(HOME, 'limits.json');
  writeFileSync(f, JSON.stringify({ updatedAt: new Date().toISOString(), providers: {} }));

  // External update introduces external-provider-1
  const j1 = JSON.parse(readFileSync(f, 'utf8'));
  j1.providers['ext-1'] = { provider: 'ext-1', plan: 'pro', windows: [{ id: 'w1', usedPercent: 10 }] };
  writeFileSync(f, JSON.stringify(j1));
  const t1 = new Date(Date.now() + 10_000); utimesSync(f, t1, t1);

  // Local noteHttp write
  noteHttp('deepseek', 429, { 'retry-after': '60' });
  const disk1 = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(disk1.providers['ext-1'], 'ext-1 must be preserved after noteHttp');
  assert.equal(disk1.providers['ext-1'].windows[0].usedPercent, 10);
  assert.equal(disk1.providers.deepseek.blocked, true);

  // External update introduces external-provider-2
  const j2 = JSON.parse(readFileSync(f, 'utf8'));
  j2.providers['ext-2'] = { provider: 'ext-2', plan: 'max', windows: [{ id: 'w2', usedPercent: 20 }] };
  writeFileSync(f, JSON.stringify(j2));
  const t2 = new Date(Date.now() + 20_000); utimesSync(f, t2, t2);

  // Local noteRateLimitEvent write
  noteRateLimitEvent('claude', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3 });
  const disk2 = JSON.parse(readFileSync(f, 'utf8'));
  assert.ok(disk2.providers['ext-2'], 'ext-2 must be preserved after noteRateLimitEvent');
  assert.equal(disk2.providers['ext-2'].windows[0].usedPercent, 20);
});

test('malformed/null poll result alongside valid provider records error and preserves valid result', async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { HOME } = await import('./_env.mjs');
  const { PROVIDERS } = await import('../core/providers/index.mjs');
  const { refreshLimits } = await import('../core/limits.mjs');
  const f = join(HOME, 'limits.json');
  writeFileSync(f, JSON.stringify({ updatedAt: new Date().toISOString(), providers: { 'fake-bad': { provider: 'fake-bad', plan: 'prev-plan', windows: [{ id: 'b1', usedPercent: 10 }] } } }));

  const origGood = PROVIDERS['fake-good'];
  const origBad = PROVIDERS['fake-bad'];
  try {
    PROVIDERS['fake-good'] = {
      id: 'fake-good',
      pollLimits: async () => ({ provider: 'fake-good', blocked: false, windows: [{ id: 'g1', usedPercent: 55 }] }),
    };
    PROVIDERS['fake-bad'] = {
      id: 'fake-bad',
      pollLimits: async () => null, // successful poll returning null, triggers TypeError in mergePoll
    };

    const res = await refreshLimits({ only: ['fake-good', 'fake-bad'] });
    assert.ok(res, 'refreshLimits should resolve even if a provider produces a malformed poll result');

    const disk = JSON.parse(readFileSync(f, 'utf8'));
    assert.equal(disk.providers['fake-good'].windows[0].usedPercent, 55);
    assert.equal(disk.providers['fake-good'].source, 'poll');
    assert.equal(disk.providers['fake-good'].error, null);

    assert.equal(disk.providers['fake-bad'].provider, 'fake-bad');
    assert.equal(disk.providers['fake-bad'].plan, 'prev-plan');
    assert.equal(disk.providers['fake-bad'].windows[0].usedPercent, 10);
    assert.equal(disk.providers['fake-bad'].source, 'poll');
    assert.ok(disk.providers['fake-bad'].error, 'malformed provider error must be recorded');
  } finally {
    if (origGood) PROVIDERS['fake-good'] = origGood; else delete PROVIDERS['fake-good'];
    if (origBad) PROVIDERS['fake-bad'] = origBad; else delete PROVIDERS['fake-bad'];
  }
});

test('deferred stub poll success and failure do not discard external updates while awaiting', async () => {
  const { writeFileSync, readFileSync, utimesSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { HOME } = await import('./_env.mjs');
  const { PROVIDERS } = await import('../core/providers/index.mjs');
  const { refreshLimits } = await import('../core/limits.mjs');
  const f = join(HOME, 'limits.json');
  writeFileSync(f, JSON.stringify({ updatedAt: new Date().toISOString(), providers: {} }));

  const origFake = PROVIDERS['fake-poll'];
  const origErr = PROVIDERS['fake-err'];
  try {
    let resolvePoll;
    const pollPromise = new Promise((res) => { resolvePoll = res; });
    PROVIDERS['fake-poll'] = {
      id: 'fake-poll',
      pollLimits: async () => {
        await pollPromise;
        return { provider: 'fake-poll', blocked: false, windows: [] }; // empty success poll
      },
    };
    PROVIDERS['fake-err'] = {
      id: 'fake-err',
      pollLimits: async () => {
        await pollPromise;
        throw new Error('poll failed');
      },
    };

    const inflightRefresh = refreshLimits({ only: ['fake-poll', 'fake-err'] });

    // While refreshLimits is awaiting pollLimits, an external process writes limits.json
    // modifying fake-poll (active 429), fake-err (active block + windows), and an unrelated ext-during-poll
    const errReset = Date.now() + 1800_000;
    const poll429Until = Date.now() + 3600_000;
    const j = {
      updatedAt: new Date().toISOString(),
      providers: {
        'fake-poll': { provider: 'fake-poll', blocked: true, blockedUntil: poll429Until, blockedReason: '429', windows: [] },
        'fake-err': { provider: 'fake-err', blocked: true, blockedUntil: errReset, blockedReason: 'five_hour', windows: [{ id: 'fe:1', usedPercent: 95 }] },
        'ext-during-poll': { provider: 'ext-during-poll', plan: 'team', windows: [{ id: 'edp:1', usedPercent: 88 }] },
      },
    };
    writeFileSync(f, JSON.stringify(j));
    const t = new Date(Date.now() + 30_000); utimesSync(f, t, t);

    // Resolve the poll
    resolvePoll();
    await inflightRefresh;

    const disk = JSON.parse(readFileSync(f, 'utf8'));
    // 1. Unrelated entry preserved
    assert.ok(disk.providers['ext-during-poll'], 'ext-during-poll must not be discarded');
    assert.equal(disk.providers['ext-during-poll'].windows[0].usedPercent, 88);

    // 2. Successful empty poll preserves active external 429 block
    assert.equal(disk.providers['fake-poll'].source, 'poll');
    assert.equal(disk.providers['fake-poll'].blocked, true);
    assert.equal(disk.providers['fake-poll'].blockedUntil, poll429Until);
    assert.equal(disk.providers['fake-poll'].blockedReason, '429');

    // 3. Erroring provider retains latest block, reset, and windows from disk
    assert.equal(disk.providers['fake-err'].error, 'poll failed');
    assert.equal(disk.providers['fake-err'].source, 'poll');
    assert.equal(disk.providers['fake-err'].blocked, true);
    assert.equal(disk.providers['fake-err'].blockedUntil, errReset);
    assert.equal(disk.providers['fake-err'].blockedReason, 'five_hour');
    assert.equal(disk.providers['fake-err'].windows[0].usedPercent, 95);
  } finally {
    if (origFake) PROVIDERS['fake-poll'] = origFake; else delete PROVIDERS['fake-poll'];
    if (origErr) PROVIDERS['fake-err'] = origErr; else delete PROVIDERS['fake-err'];
  }
});

test('a maxed model-scoped Claude window blocks only that model, not the whole provider', () => {
  // weekly Opus at 100% but five_hour/weekly/Fable have room: the provider is NOT blocked (Fable/Sonnet keep working).
  const scoped = normalizeUsage({ rate_limits: { five_hour: { utilization: 40 }, seven_day: { utilization: 55 }, seven_day_opus: { utilization: 100 }, seven_day_fable: { utilization: 30 } }, rate_limits_available: true });
  assert.equal(scoped.blocked, false);
  assert.equal(scoped.windows.find((w) => w.id === 'seven_day_opus').models, 'opus'); // the scoped window carries its model regex
  // a global (unscoped) weekly at 100% DOES block the provider.
  assert.equal(normalizeUsage({ rate_limits: { seven_day: { utilization: 100 } }, rate_limits_available: true }).blocked, true);
});

test('DeepSeek balance polling stays on the configured vendor origin', async (t) => {
  const { make } = await import('../core/providers/openai-compat.mjs');
  const { loadConfig, saveConfig } = await import('../core/config.mjs');
  const original = loadConfig().providers.deepseek;
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ data: [{ id: 'custom-model' }], is_available: true, balance_infos: [{ total_balance: '10', currency: 'USD' }] }) };
  });
  const provider = make('deepseek');
  try {
    for (const baseUrl of ['https://proxy.example/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1']) {
      saveConfig({ providers: { deepseek: { apiKey: 'test-only', baseUrl } } });
      requests.length = 0;
      assert.equal((await provider.listModels())[0].id, 'custom-model');
      assert.equal(provider.workerConfig().baseUrl, baseUrl);
      assert.deepEqual((await provider.pollLimits()).windows, []);
      assert.deepEqual(requests, [`${baseUrl}/models`]);
    }
    for (const baseUrl of ['', 'https://api.deepseek.com/custom/v1']) {
      saveConfig({ providers: { deepseek: { apiKey: 'test-only', baseUrl } } });
      requests.length = 0;
      assert.equal((await provider.pollLimits()).balance.amount, 10);
      assert.deepEqual(requests, ['https://api.deepseek.com/user/balance']);
    }
  } finally { saveConfig({ providers: { deepseek: original || { apiKey: '', baseUrl: '' } } }); }
});

test('scoped rejections block their model until reset and preserve genuine global blocks', async () => {
  const { modelBlockedUntil } = await import('../core/limits.mjs');
  const { loadConfig } = await import('../core/config.mjs');
  const original = getLimits().providers.claude;
  const reset = Date.now() + 60_000;
  try {
    getLimits().providers.claude = { provider: 'claude', blocked: false, windows: [] };
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: reset });
    assert.equal(blockedUntil('claude'), null);
    assert.equal(modelBlockedUntil('claude', 'claude-opus-4-8'), reset);
    assert.equal(modelBlockedUntil('claude', 'claude-sonnet-4-6'), null);
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: Date.now() - 1 });
    assert.equal(modelBlockedUntil('claude', 'claude-opus-4-8'), null);
    const before = Date.now();
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_opus' });
    const expiry = modelBlockedUntil('claude', 'opus');
    const duration = loadConfig().scorecard.blockedMinutes * 60_000;
    assert.ok(expiry >= before + duration && expiry <= Date.now() + duration);
    noteRateLimitEvent('claude', { status: 'allowed', rateLimitType: 'seven_day_opus', utilization: 0.5 });
    assert.equal(modelBlockedUntil('claude', 'opus'), null);
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset });
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: reset + 60_000 });
    assert.equal(blockedUntil('claude'), reset);
    noteRateLimitEvent('claude', { status: 'allowed', rateLimitType: 'seven_day_opus' });
    assert.equal(modelBlockedUntil('claude', 'sonnet'), reset);
    const merged = mergePoll({}, { blocked: true, windows: [{ usedPercent: 100, resetsAt: reset }, { models: 'opus', usedPercent: 100, resetsAt: reset - 1 }] });
    assert.equal(merged.blockedUntil, reset);
  } finally { getLimits().providers.claude = original; }
});
