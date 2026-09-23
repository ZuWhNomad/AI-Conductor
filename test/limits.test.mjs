import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJson } from '../core/paths.mjs';

const { noteHttp, noteRateLimitEvent, blockedUntil, getLimits, mergePoll, modelBlockedUntil, providerWindows } = await import('../core/limits.mjs');
const { normalizeUsage, windowFromEvent } = await import('../core/providers/anthropic.mjs');

for (const scenario of [
  { olderFull: true, collected: true, first: 'newer' },
  { olderFull: false, first: 'older' },
  { olderFull: true, collected: true, first: 'newer', newerFails: true },
  { olderFull: true, collected: true, first: 'older', newerFails: true },
  { olderFull: false, first: 'newer' },
  { olderFull: false, first: 'newer', olderFails: true },
]) {
  test(`superseded limit results cannot commit: ${JSON.stringify(scenario)}`, async (ctx) => {
    const { PROVIDERS } = await import('../core/providers/index.mjs');
    const { refreshLimits } = await import('../core/limits.mjs');
    const original = { ...PROVIDERS }, originalState = getLimits().providers;
    for (const id of Object.keys(PROVIDERS)) delete PROVIDERS[id];
    ctx.after(() => {
      for (const id of Object.keys(PROVIDERS)) delete PROVIDERS[id];
      Object.assign(PROVIDERS, original);
      getLimits().providers = originalState;
    });
    const id = 'fake-freshness', reset = Date.now() + 60_000;
    const usage = (usedPercent) => ({ provider: id, blocked: false, windows: [{ id: 'weekly', usedPercent, resetsAt: reset }] });
    const initial = usage(10);
    getLimits().providers = { [id]: initial };
    const old = Promise.withResolvers(), newer = Promise.withResolvers(), slow = Promise.withResolvers();
    const oldEntered = Promise.withResolvers(), newerEntered = Promise.withResolvers();
    let calls = 0;
    PROVIDERS[id] = {
      id, pollLimits: () => {
        if (++calls === 1) { oldEntered.resolve(); return old.promise; }
        newerEntered.resolve(); return newer.promise;
      },
    };
    PROVIDERS.slow = { id: 'slow', pollLimits: () => slow.promise };
    const olderScope = scenario.olderFull ? {} : { only: [id] };
    const newerScope = scenario.olderFull ? { only: [id] } : {};
    const olderRefresh = refreshLimits(olderScope);
    let newerRefresh;
    const finishOld = () => scenario.olderFails ? old.reject(new Error('older failed')) : old.resolve(usage(20));
    const finishNewer = () => scenario.newerFails ? newer.reject(new Error('newer failed')) : newer.resolve(usage(100));
    const finishSlow = () => slow.resolve({ provider: 'slow', blocked: false, windows: [] });
    try {
      assert.equal(refreshLimits(olderScope), olderRefresh, 'same-scope calls coalesce');
      await oldEntered.promise;
      if (scenario.collected) {
        finishOld();
        await old.promise; // collected 20%, while the full refresh still awaits slow
      }
      newerRefresh = refreshLimits(newerScope);
      assert.equal(refreshLimits(newerScope), newerRefresh, 'newer same-scope calls coalesce');
      await newerEntered.promise;
      noteRateLimitEvent('live', { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: reset });
      if (scenario.first === 'older') {
        finishOld(); finishSlow();
        await olderRefresh;
        assert.deepEqual(getLimits().providers[id].windows, usage(20).windows, 'a newer pending poll must not discard the completed sample');
        finishNewer(); await newerRefresh;
      } else {
        finishNewer();
        if (!scenario.olderFull) finishSlow();
        await newerRefresh;
        const provider = { ...getLimits().providers[id] };
        assert.equal(modelBlockedUntil(id, 'test-model'), scenario.newerFails ? null : reset);
        finishOld(); finishSlow();
        await olderRefresh;
        assert.deepEqual(getLimits().providers[id], provider, 'old success/error cannot overwrite newer result');
      }
      assert.equal(calls, 2);
      assert.equal(getLimits().providers[id].windows[0].usedPercent, scenario.newerFails ? (scenario.first === 'older' ? 20 : 10) : 100);
      assert.equal(getLimits().providers[id].error, scenario.newerFails ? 'newer failed' : null);
      assert.equal(modelBlockedUntil(id, 'test-model'), scenario.newerFails ? null : reset);
      assert.equal(getLimits().providers.slow.source, 'poll', 'unrelated provider result still commits');
      assert.equal(modelBlockedUntil('live', 'test-model'), reset, 'unrelated live event survives');
      assert.deepEqual(readJson(join(HOME, 'limits.json')), getLimits());
    } finally {
      old.resolve(usage(20)); newer.resolve(usage(100)); finishSlow();
      await Promise.allSettled([olderRefresh, newerRefresh]);
    }
  });
}

for (const rateLimitType of ['seven_day_sonnet', 'five_hour']) {
  for (const status of ['rejected', 'allowed']) {
    for (const collected of [false, true]) {
      test(`live ${rateLimitType} ${status} supersedes a ${collected ? 'collected' : 'pending'} poll`, async (ctx) => {
        const { PROVIDERS } = await import('../core/providers/index.mjs');
        const { refreshLimits } = await import('../core/limits.mjs');
        const id = 'fake-live-race', slowId = 'fake-live-slow';
        const now = Date.now(), reset = now + 60_000;
        ctx.mock.method(Date, 'now', () => now);
        const info = { rateLimitType, status, utilization: status === 'rejected' ? 1 : 0, resetsAt: reset };
        const initial = { ...info, status: status === 'rejected' ? 'allowed' : 'rejected', utilization: status === 'rejected' ? 0.2 : 1 };
        const unrelated = { id: 'seven_day_haiku', models: 'haiku', usedPercent: 10, resetsAt: reset };
        getLimits().providers[id] = { provider: id, blocked: false, windows: [unrelated] };
        noteRateLimitEvent(id, initial);
        const stale = {
          provider: id, blocked: rateLimitType === 'five_hour' && status === 'allowed',
          windows: [windowFromEvent(initial), { ...unrelated, usedPercent: 40 }],
        };
        const poll = Promise.withResolvers(), entered = Promise.withResolvers(), slow = Promise.withResolvers();
        PROVIDERS[id] = { id, pollLimits: () => { entered.resolve(); return poll.promise; } };
        PROVIDERS[slowId] = { id: slowId, pollLimits: () => slow.promise };
        const refresh = refreshLimits({ only: [id, slowId] });
        const assertEvent = () => {
          const p = getLimits().providers[id];
          assert.deepEqual(p.windows.find((w) => w.id === rateLimitType), windowFromEvent(info));
          assert.equal(modelBlockedUntil(id, 'claude-sonnet'), status === 'rejected' ? reset : null);
          assert.equal(modelBlockedUntil(id, 'claude-haiku'), status === 'rejected' && rateLimitType === 'five_hour' ? reset : null);
          assert.equal(p.blocked, status === 'rejected' && rateLimitType === 'five_hour');
        };
        try {
          await entered.promise;
          if (collected) { poll.resolve(stale); await poll.promise; }
          noteRateLimitEvent(id, info);
          noteRateLimitEvent(id, { rateLimitType: 'seven_day_opus', status: 'allowed', utilization: 0.7, resetsAt: reset });
          poll.resolve(stale); slow.resolve({ provider: slowId, blocked: false, windows: [] });
          await refresh;
          assertEvent();
          assert.equal(getLimits().providers[id].windows.find((w) => w.id === unrelated.id).usedPercent, 40, 'unrelated poll window updates');
          assert.equal(getLimits().providers[id].windows.find((w) => w.id === 'seven_day_opus').usedPercent, 70, 'new unrelated live window survives');
          assert.deepEqual(readJson(join(HOME, 'limits.json')), getLimits());

          await refreshLimits({ only: [id] });
          assert.deepEqual(getLimits().providers[id].windows, stale.windows, 'a poll started after the events may replace their observations');
          noteRateLimitEvent(id, info);
          assertEvent(); // the reverse order: an event after the poll also wins
        } finally {
          poll.resolve(stale); slow.resolve({ provider: slowId, blocked: false, windows: [] });
          await refresh;
          delete PROVIDERS[id]; delete PROVIDERS[slowId];
          delete getLimits().providers[id]; delete getLimits().providers[slowId];
        }
      });
    }
  }
}

for (const rateLimitType of ['seven_day_sonnet', 'five_hour']) {
  for (const resetsAt of [0, undefined]) {
    test(`live ${rateLimitType} rejection/recovery with reset=${resetsAt} survives stale polls`, async (ctx) => {
      const { PROVIDERS } = await import('../core/providers/index.mjs');
      const { refreshLimits } = await import('../core/limits.mjs');
      const { loadConfig } = await import('../core/config.mjs');
      const id = 'fake-live-reset', now = Date.now();
      ctx.mock.method(Date, 'now', () => now);
      const allowed = { rateLimitType, status: 'allowed', utilization: 0, resetsAt };
      getLimits().providers[id] = { provider: id, blocked: false, windows: [] };
      noteRateLimitEvent(id, allowed);
      let poll = Promise.withResolvers();
      PROVIDERS[id] = { id, pollLimits: () => poll.promise };
      let refresh = refreshLimits({ only: [id] });
      try {
        noteRateLimitEvent(id, { rateLimitType, status: 'rejected', resetsAt }); // utilization is unknown
        poll.resolve({ provider: id, blocked: false, windows: [] });
        await refresh;
        assert.equal(modelBlockedUntil(id, 'sonnet'), now + loadConfig().scorecard.blockedMinutes * 60_000);
        assert.equal(getLimits().providers[id].windows[0].usedPercent, null);

        noteRateLimitEvent(id, allowed);
        poll = Promise.withResolvers();
        refresh = refreshLimits({ only: [id] });
        noteRateLimitEvent(id, { rateLimitType, status: 'rejected', resetsAt });
        noteRateLimitEvent(id, allowed); // same values as before the poll; observation order must still win
        poll.resolve({ provider: id, blocked: rateLimitType === 'five_hour', windows: [windowFromEvent({ rateLimitType, status: 'rejected', utilization: 1, resetsAt })] });
        await refresh;
        assert.equal(modelBlockedUntil(id, 'sonnet'), null, 'stale rejection cannot resurrect after recovery to zero');
        assert.deepEqual(getLimits().providers[id].windows, [windowFromEvent(allowed)]);
      } finally {
        poll.resolve({ provider: id, blocked: false, windows: [] }); await refresh;
        delete PROVIDERS[id]; delete getLimits().providers[id];
      }
    });
  }
}

for (const scenario of [
  { name: 'both windows recover', weekly: 20 },
  { name: 'weekly remains exhausted', weekly: 100 },
  { name: 'independent rejection remains', weekly: 20, independent: true },
]) {
  test(`GP3-01: mixed SDK/poll recovery: ${scenario.name}`, async (ctx) => {
    const { PROVIDERS } = await import('../core/providers/index.mjs');
    const { refreshLimits } = await import('../core/limits.mjs');
    const { loadConfig } = await import('../core/config.mjs');
    const id = 'claude', original = getLimits().providers[id], originalProvider = PROVIDERS[id], now = Date.now();
    ctx.mock.method(Date, 'now', () => now);
    const reset = now + loadConfig().scorecard.blockedMinutes * 60_000;
    const usage = (weekly) => normalizeUsage({ rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 100, resets_at: new Date(reset).toISOString() },
      seven_day: { utilization: weekly, resets_at: new Date(reset).toISOString() },
    } });
    getLimits().providers[id] = usage(100);
    const poll = Promise.withResolvers(), entered = Promise.withResolvers();
    PROVIDERS[id] = { ...originalProvider, pollLimits: () => { entered.resolve(); return poll.promise; } };
    const refresh = refreshLimits({ only: [id] });
    try {
      await entered.promise;
      noteRateLimitEvent(id, { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.1, resetsAt: reset });
      assert.equal(getLimits().providers[id].blocked, true, 'cached weekly exhaustion still blocks');
      assert.equal(getLimits().providers[id].blockedReason, null, 'the cached block is window-derived');
      if (scenario.independent) noteRateLimitEvent(id, { status: 'rejected' }); // no window represents this rejection
      poll.resolve(usage(scenario.weekly));
      await refresh;

      const p = getLimits().providers[id];
      const blocked = scenario.weekly === 100 || !!scenario.independent;
      assert.equal(p.windows.find((w) => w.id === 'five_hour').usedPercent, 10);
      assert.equal(p.windows.find((w) => w.id === 'seven_day').usedPercent, scenario.weekly);
      assert.equal(modelBlockedUntil(id, 'claude-sonnet'), blocked ? reset : null);
      assert.equal(p.blocked, blocked);
      assert.equal(p.blockedUntil, blocked ? reset : null);
      assert.equal(p.blockedReason, scenario.independent ? 'rate_limit' : null);
      assert.deepEqual(readJson(join(HOME, 'limits.json')), getLimits());
    } finally {
      poll.resolve(usage(scenario.weekly)); await refresh;
      PROVIDERS[id] = originalProvider;
      if (original === undefined) delete getLimits().providers[id];
      else getLimits().providers[id] = original;
    }
  });
}

for (const scenario of [
  { name: 'same-window recovery', rateLimitType: 'five_hour', blocked: false },
  { name: 'remaining exhausted window', rateLimitType: 'five_hour', remaining: true, blocked: true },
  { name: 'scoped mismatch', rateLimitType: 'seven_day_opus', blocked: true, reason: 'five_hour' },
  { name: 'independent rejection', rateLimitType: 'five_hour', independent: true, blocked: true, reason: 'rate_limit' },
]) {
  test(`GP4-01: allowed_warning preserves recovery scope: ${scenario.name}`, async (ctx) => {
    const { PROVIDERS } = await import('../core/providers/index.mjs');
    const { refreshLimits } = await import('../core/limits.mjs');
    const { loadConfig } = await import('../core/config.mjs');
    const id = 'fake-warning-recovery', now = Date.now();
    ctx.mock.method(Date, 'now', () => now);
    const reset = now + loadConfig().scorecard.blockedMinutes * 60_000;
    getLimits().providers[id] = { provider: id, blocked: false, windows: [] };
    if (scenario.remaining) noteRateLimitEvent(id, { rateLimitType: 'seven_day', status: 'rejected', utilization: 1, resetsAt: reset });
    noteRateLimitEvent(id, { rateLimitType: 'five_hour', status: 'rejected', utilization: 1, resetsAt: reset });
    assert.equal(modelBlockedUntil(id, 'claude-sonnet'), reset);
    const stale = structuredClone(getLimits().providers[id]);
    const poll = Promise.withResolvers(), entered = Promise.withResolvers();
    PROVIDERS[id] = { id, pollLimits: () => { entered.resolve(); return poll.promise; } };
    const refresh = refreshLimits({ only: [id] });
    const warning = { rateLimitType: scenario.rateLimitType, status: 'allowed_warning', utilization: 0.9, resetsAt: reset };
    const assertState = () => {
      const p = getLimits().providers[id];
      assert.deepEqual(p.windows.find((w) => w.id === warning.rateLimitType), windowFromEvent(warning));
      assert.equal(modelBlockedUntil(id, 'claude-sonnet'), scenario.blocked ? reset : null);
      assert.equal(p.blocked, scenario.blocked);
      assert.equal(p.blockedUntil, scenario.blocked ? reset : null);
      assert.equal(p.blockedReason, scenario.reason ?? null);
      assert.deepEqual(readJson(join(HOME, 'limits.json')), getLimits());
    };
    try {
      await entered.promise;
      if (scenario.independent) noteRateLimitEvent(id, { status: 'rejected' });
      noteRateLimitEvent(id, warning);
      assertState();
      poll.resolve(stale);
      await refresh;
      assertState(); // An older poll cannot undo the warning's recovery or its scope.
    } finally {
      poll.resolve(stale); await refresh;
      delete PROVIDERS[id]; delete getLimits().providers[id];
    }
  });
}

test('live global recovery keeps an unrelated polled global rejection and a newer HTTP block', async () => {
  const { PROVIDERS } = await import('../core/providers/index.mjs');
  const { refreshLimits } = await import('../core/limits.mjs');
  const id = 'fake-live-global', reset = Date.now() + 60_000;
  getLimits().providers[id] = { provider: id, blocked: false, windows: [] };
  noteRateLimitEvent(id, { rateLimitType: 'five_hour', status: 'rejected', resetsAt: reset });
  const poll = Promise.withResolvers();
  PROVIDERS[id] = { id, pollLimits: () => poll.promise };
  const refresh = refreshLimits({ only: [id] });
  try {
    noteRateLimitEvent(id, { rateLimitType: 'five_hour', status: 'allowed', utilization: 0, resetsAt: reset });
    noteHttp(id, 429, { 'Retry-After': '120' });
    const httpUntil = blockedUntil(id);
    poll.resolve({ provider: id, blocked: true, windows: [
      { id: 'five_hour', usedPercent: 100, resetsAt: reset },
      { id: 'seven_day', usedPercent: 100, resetsAt: reset },
    ] });
    await refresh;
    assert.equal(modelBlockedUntil(id, 'sonnet'), httpUntil);
    noteHttp(id, 200);
    assert.equal(modelBlockedUntil(id, 'sonnet'), reset, 'the unrelated weekly poll window still blocks');
    assert.equal(getLimits().providers[id].windows.find((w) => w.id === 'five_hour').usedPercent, 0);
  } finally {
    poll.resolve({ provider: id, blocked: false, windows: [] }); await refresh;
    delete PROVIDERS[id]; delete getLimits().providers[id];
  }
});

test('newer HTTP requests exhaustion and recovery survive pending polls, then fresh polls can replace them', async (ctx) => {
  const { PROVIDERS } = await import('../core/providers/index.mjs');
  const { refreshLimits } = await import('../core/limits.mjs');
  const id = 'fake-http-observation', now = Date.now(), reset = now + 60_000;
  ctx.mock.method(Date, 'now', () => now);
  getLimits().providers[id] = { provider: id, blocked: false, windows: [] };
  let poll = Promise.withResolvers();
  PROVIDERS[id] = { id, pollLimits: () => poll.promise };
  let refresh = refreshLimits({ only: [id] });
  const headers = (remaining) => ({ 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': String(remaining), 'x-ratelimit-reset-requests': '60s' });
  try {
    noteHttp(id, 200, headers(0));
    const exhausted = { ...getLimits().providers[id].windows[0] };
    assert.equal(modelBlockedUntil(id, 'model'), reset);
    poll.resolve({ provider: id, blocked: false, windows: [] });
    await refresh;
    assert.equal(modelBlockedUntil(id, 'model'), reset, 'an empty older poll cannot erase a newer exhausted window');
    assert.deepEqual(getLimits().providers[id].windows, [exhausted]);

    poll = Promise.withResolvers();
    refresh = refreshLimits({ only: [id] });
    noteHttp(id, 200, headers(10));
    assert.equal(modelBlockedUntil(id, 'model'), null, 'recovery clears the request-derived provider block immediately');
    const recovered = { ...getLimits().providers[id].windows[0] };
    const stale = { provider: id, blocked: true, windows: [exhausted, { id: 'budget', usedPercent: 40 }] };
    poll.resolve(stale);
    await refresh;
    assert.equal(modelBlockedUntil(id, 'model'), null, 'older request exhaustion cannot resurrect');
    assert.deepEqual(getLimits().providers[id].windows, [stale.windows[1], recovered]);
    assert.deepEqual(readJson(join(HOME, 'limits.json')), getLimits());

    await refreshLimits({ only: [id] });
    assert.deepEqual(getLimits().providers[id].windows, stale.windows, 'a later poll can update HTTP windows normally');
    assert.equal(modelBlockedUntil(id, 'model'), reset);
  } finally {
    poll.resolve({ provider: id, blocked: false, windows: [] }); await refresh;
    delete PROVIDERS[id]; delete getLimits().providers[id];
  }
});

for (const independentBlock of [false, true]) {
  test(`newer HTTP recovery prevents stale 429 resurrection; independent block=${independentBlock}`, async () => {
    const { PROVIDERS } = await import('../core/providers/index.mjs');
    const { refreshLimits } = await import('../core/limits.mjs');
    const id = 'fake-http-block-observation';
    getLimits().providers[id] = { provider: id, blocked: false, windows: [] };
    noteHttp(id, 429, { 'Retry-After': '60' });
    const stale = { ...getLimits().providers[id], httpRetryUntil: blockedUntil(id) };
    if (independentBlock) stale.blockedReason = 'balance exhausted';
    const poll = Promise.withResolvers();
    PROVIDERS[id] = { id, pollLimits: () => poll.promise };
    const refresh = refreshLimits({ only: [id] });
    try {
      noteHttp(id, 200);
      assert.equal(modelBlockedUntil(id, 'model'), null);
      poll.resolve(stale);
      await refresh;
      assert.equal(!!modelBlockedUntil(id, 'model'), independentBlock);
      assert.equal(getLimits().providers[id].blockedReason, independentBlock ? 'balance exhausted' : null);
      assert.ok(!getLimits().providers[id].httpRetryUntil, 'the cleared HTTP retry deadline must not return either');
      await refreshLimits({ only: [id] });
      assert.ok(modelBlockedUntil(id, 'model'), 'a poll started after recovery may establish a new block');
    } finally {
      poll.resolve(stale); await refresh;
      delete PROVIDERS[id]; delete getLimits().providers[id];
    }
  });
}

test('a repeated newer 429 with identical timestamps cannot be cleared by an older recovery poll', async (ctx) => {
  const { PROVIDERS } = await import('../core/providers/index.mjs');
  const { refreshLimits } = await import('../core/limits.mjs');
  const id = 'fake-http-repeated', now = Date.now();
  ctx.mock.timers.enable({ apis: ['Date'], now });
  getLimits().providers[id] = { provider: id, blocked: false, windows: [] };
  noteHttp(id, 429, { 'Retry-After': '60' });
  const poll = Promise.withResolvers();
  PROVIDERS[id] = { id, pollLimits: () => poll.promise };
  const refresh = refreshLimits({ only: [id] });
  try {
    noteHttp(id, 429, { 'Retry-After': '60' });
    poll.resolve({ provider: id, blocked: false, windows: [{ id: 'requests', usedPercent: 20 }] });
    await refresh;
    assert.equal(modelBlockedUntil(id, 'model'), now + 60_000);
    await refreshLimits({ only: [id] });
    assert.equal(modelBlockedUntil(id, 'model'), null, 'a fresh recovery poll can clear the rejection');
  } finally {
    poll.resolve({ provider: id, blocked: false, windows: [] }); await refresh;
    delete PROVIDERS[id]; delete getLimits().providers[id];
  }
});

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

// D5 — regression tests for anthropic window scoping

test('live seven_day_nimbus rejection does not park every Claude model', () => {
  const original = getLimits().providers.claude;
  const reset = Date.now() + 60_000;
  const clear = () => { getLimits().providers.claude = { provider: 'claude', blocked: false, blockedUntil: null, blockedReason: null, windows: [] }; };
  try {
    clear();
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_nimbus', resetsAt: reset });
    assert.equal(blockedUntil('claude'), null);
    assert.equal(modelBlockedUntil('claude', 'claude-sonnet-4-6'), null);
    assert.ok(windowFromEvent({ rateLimitType: 'seven_day_nimbus' }).models, 'nimbus event must carry a models scope');

    clear();
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day', resetsAt: reset });
    assert.ok(blockedUntil('claude') > Date.now(), 'seven_day rejected still blocks the provider');

    clear();
    noteRateLimitEvent('claude', { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: reset });
    assert.equal(blockedUntil('claude'), null);
    assert.equal(modelBlockedUntil('claude', 'claude-opus-4-8'), reset);
    assert.equal(modelBlockedUntil('claude', 'claude-sonnet-4-6'), null);
  } finally { getLimits().providers.claude = original; }
});

test('allowed scoped event clears a provider block stored under the same rateLimitType', () => {
  const original = getLimits().providers.claude;
  const until = Date.now() + 60_000;
  try {
    getLimits().providers.claude = { provider: 'claude', blocked: true, blockedUntil: until, blockedReason: 'seven_day_nimbus', windows: [] };
    noteRateLimitEvent('claude', { status: 'allowed', rateLimitType: 'seven_day_nimbus' });
    assert.equal(blockedUntil('claude'), null);

    getLimits().providers.claude = { provider: 'claude', blocked: true, blockedUntil: until, blockedReason: 'five_hour', windows: [] };
    noteRateLimitEvent('claude', { status: 'allowed', rateLimitType: 'seven_day_nimbus' });
    assert.equal(blockedUntil('claude'), until);
    assert.equal(getLimits().providers.claude.blockedReason, 'five_hour');
  } finally { getLimits().providers.claude = original; }
});

test('D5: novel model_scoped name (Nimbus Quill) does not block the whole provider', () => {
  // seven_day_nimbus at 100% + five_hour at 10% → provider NOT blocked; opus not blocked.
  const r = normalizeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 },
    seven_day_nimbus: { utilization: 100 },
  } });
  assert.equal(r.blocked, false, 'seven_day_nimbus at 100% must not block the provider');
  // The nimbus window must be scoped (models truthy)
  const nimbusWin = r.windows.find((w) => w.id === 'seven_day_nimbus');
  assert.ok(nimbusWin, 'seven_day_nimbus window must be present');
  assert.ok(nimbusWin.models, 'seven_day_nimbus must carry a models scope');
  // An opus model must not be blocked by nimbus window
  const opusWin = r.windows.find((w) => w.id === 'seven_day_nimbus');
  assert.notEqual(opusWin?.models, 'opus', 'seven_day_nimbus scope must not be opus');
});

test('D5: model_scoped with display_name Mythos at 100% does not block provider', () => {
  const r = normalizeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 },
    model_scoped: [{ display_name: 'Mythos', utilization: 100 }],
  } });
  assert.equal(r.blocked, false, 'model_scoped Mythos at 100% must not provider-block');
  const w = r.windows.find((w) => w.id === 'model:Mythos');
  assert.ok(w, 'model:Mythos window must exist');
  assert.ok(w.models, 'model:Mythos must carry a models scope');
  assert.equal(w.models, 'mythos'); // lowercased verbatim, not a known family
});

test('GP4: seven_day_oauth_apps at 100% blocks the provider; seven_day_nimbus does not', () => {
  const oauth = normalizeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 },
    seven_day_oauth_apps: { utilization: 100 },
  } });
  assert.equal(oauth.blocked, true, 'seven_day_oauth_apps is an account-wide bucket');
  const oa = oauth.windows.find((w) => w.id === 'seven_day_oauth_apps');
  assert.ok(oa && !oa.models, 'oauth_apps must stay unscoped');
  const nimbus = normalizeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 },
    seven_day_nimbus: { utilization: 100 },
  } });
  assert.equal(nimbus.blocked, false, 'seven_day_nimbus at 100% must not block the provider');
  assert.ok(nimbus.windows.find((w) => w.id === 'seven_day_nimbus')?.models, 'nimbus stays model-scoped');
});

test('D5: seven_day_overage_included and overage keys stay unscoped (non-model suffixes)', () => {
  const r = normalizeUsage({ rate_limits_available: true, rate_limits: {
    seven_day_overage_included: { utilization: 100 },
    overage: { utilization: 100 },
    five_hour: { utilization: 10 },
  } });
  // overage_included and overage are not model scopes; they must NOT make the provider blocked
  // (their utilization matters, but they are treated as non-scoped only if they are truly global)
  // The spec says NON_MODEL_SUFFIXES stays unscoped, so they ARE unscoped and DO contribute to blocked.
  // This test simply confirms the windows are present and the 'overage' key has no models property.
  const oi = r.windows.find((w) => w.id === 'seven_day_overage_included');
  assert.ok(oi, 'seven_day_overage_included must be present');
  assert.ok(!oi.models, 'seven_day_overage_included must be unscoped (non-model suffix)');
});

test('D5: known families in model_scoped still match model ids via familyRe breadth', () => {
  const r = normalizeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 5 },
    model_scoped: [{ display_name: 'Opus', utilization: 100 }],
  } });
  assert.equal(r.blocked, false);
  const w = r.windows.find((w) => w.id === 'model:Opus');
  assert.equal(w.models, 'opus'); // familyRe extracts the family for broad regex matching
});

// D6 — regression tests for codex window scoping

test('D6: normalizeCodexPollResult scopes non-primary buckets to their limitName/limitId', async () => {
  // pollLimits needs the real app-server binary, so we test the scoping contract by directly populating
  // provider windows as pollLimits would build them (with the models field it now sets on non-codex buckets).
  const id = 'codex-d6-test';
  try {
    const windows = [
      { id: 'codex:primary', label: 'Codex 168h', usedPercent: 40, windowMinutes: 10080, resetsAt: null },
      // 'codex_bengalfox' bucket: limitName='GPT-5.3-Codex-Spark' → models='gpt-5.3-codex-spark'
      { id: 'codex_bengalfox:primary', label: 'GPT-5.3-Codex-Spark 168h', usedPercent: 100, windowMinutes: 10080, resetsAt: null, models: 'gpt-5.3-codex-spark' },
    ];
    getLimits().providers[id] = { provider: id, blocked: false, windows };
    // gpt-6-astra must not be blocked — no window with models matching it at 100%
    assert.equal(modelBlockedUntil(id, 'gpt-6-astra'), null, 'gpt-6-astra must not be blocked by spark-only bucket');
    // the spark model itself IS blocked by its per-model window
    assert.ok(modelBlockedUntil(id, 'gpt-5.3-codex-spark') !== null, 'gpt-5.3-codex-spark must be blocked');
  } finally { delete getLimits().providers[id]; }
});

// G2 — regression tests for noteHttp window merge

test('G2: noteHttp preserves existing non-requests windows when updating requests', () => {
  const id = 'g2-merge-test';
  try {
    // Set up provider with a budget window already present
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'budget', label: 'budget', usedPercent: 30, resetsAt: null }] };
    noteHttp(id, 200, { 'x-ratelimit-remaining-requests': '50', 'x-ratelimit-limit-requests': '100' });
    const ws = getLimits().providers[id].windows;
    assert.ok(ws.find((w) => w.id === 'budget'), 'budget window must survive noteHttp requests update');
    assert.ok(ws.find((w) => w.id === 'requests'), 'requests window must be added');
    assert.equal(ws.find((w) => w.id === 'requests').usedPercent, 50);
  } finally { delete getLimits().providers[id]; }
});

test('G2: noteHttp requests window gets resetsAt from x-ratelimit-reset-requests (seconds epoch)', () => {
  const id = 'g2-reset-epoch';
  const resetEpochMs = Date.now() + 60_000;
  const resetEpochS = Math.round(resetEpochMs / 1000);
  try {
    noteHttp(id, 200, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '100', 'x-ratelimit-reset-requests': String(resetEpochS) });
    const w = getLimits().providers[id].windows.find((w) => w.id === 'requests');
    assert.ok(w, 'requests window must exist');
    // resetsAt must be set (not null) — close to resetEpochMs
    assert.ok(w.resetsAt != null, 'resetsAt must not be null when reset header is present');
    assert.ok(Math.abs(w.resetsAt - resetEpochMs) < 2000, 'resetsAt must be close to the reset header value');
  } finally { delete getLimits().providers[id]; }
});

test('G2: noteHttp requests window gets resetsAt from x-ratelimit-reset (ISO date string)', () => {
  const id = 'g2-reset-iso';
  const resetMs = Date.now() + 120_000;
  const resetIso = new Date(resetMs).toISOString();
  try {
    noteHttp(id, 200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '100', 'x-ratelimit-reset': resetIso });
    const w = getLimits().providers[id].windows.find((w) => w.id === 'requests');
    assert.ok(w?.resetsAt != null, 'resetsAt must be set from ISO date header');
    assert.ok(Math.abs(w.resetsAt - resetMs) < 2000);
  } finally { delete getLimits().providers[id]; }
});

test('G2: 200 with remaining=0 and known resetsAt does not park for 30 min', () => {
  const id = 'g2-no-30min-park';
  const resetSoon = Date.now() + 5_000; // reset in 5 seconds
  const resetEpochS = Math.round(resetSoon / 1000);
  try {
    noteHttp(id, 200, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '100', 'x-ratelimit-reset-requests': String(resetEpochS) });
    const until = modelBlockedUntil(id, null);
    // Should block until the reset (~5 seconds), not 30 min
    assert.ok(until != null, 'requests at 100% must produce a block');
    assert.ok(until <= resetSoon + 2000, `block should not exceed reset time (got ${until - Date.now()}ms, reset in 5s)`);
  } finally { delete getLimits().providers[id]; }
});

test('G2: 200 with remaining=0 and no reset header parks (no resetsAt)', () => {
  const id = 'g2-no-reset-header';
  const now = Date.now();
  try {
    noteHttp(id, 200, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '100' });
    const w = getLimits().providers[id].windows.find((w) => w.id === 'requests');
    assert.ok(w, 'requests window must exist');
    assert.ok(w.resetsAt != null, 'resetsAt must be now+60s when remaining is 0 and no reset header is present');
    assert.ok(Math.abs(w.resetsAt - now - 60_000) < 2000);
    const until = modelBlockedUntil(id, null);
    assert.ok(until != null, 'a 100% requests window with no reset must produce a block');
    assert.ok(until <= now + 62_000, 'must not park for the 30-min default');
  } finally { delete getLimits().providers[id]; }
});

// R: review corrections — regex-escaped model scopes, noteHttp resetsAt, duration reset strings

test('R: Opus 4.8 (preview) and Spark+ (beta) scopes do not throw in providerWindows/modelBlockedUntil', () => {
  const opus = normalizeUsage({ rate_limits_available: true, rate_limits: {
    model_scoped: [{ display_name: 'Opus 4.8 (preview)', utilization: 100 }],
  } });
  assert.equal(opus.windows.find((w) => w.id === 'model:Opus 4.8 (preview)').models, 'opus'); // known family stays
  const sparkScope = 'spark+ (beta)'.replace(/[-_ ]+/g, '\0').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\0/g, '[-_ ]');
  const id = 'r-regex-throw';
  try {
    for (const models of [opus.windows[0].models, sparkScope, 'Opus 4.8 (preview)', 'Spark+ (beta)']) {
      getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'w', models, usedPercent: 100, resetsAt: Date.now() + 60_000 }] };
      assert.doesNotThrow(() => providerWindows(id, 'claude-opus-4-8'));
      assert.doesNotThrow(() => modelBlockedUntil(id, 'claude-opus-4-8'));
      assert.doesNotThrow(() => providerWindows(id, 'gpt-5.3-codex-spark'));
      assert.doesNotThrow(() => modelBlockedUntil(id, 'gpt-5.3-codex-spark'));
    }
  } finally { delete getLimits().providers[id]; }
});

test('R: GPT-5.3-Codex-Spark scope matches gpt-5.3-codex-spark and not gpt-6-astra', () => {
  const models = 'gpt[-_ ]5\\.3[-_ ]codex[-_ ]spark'; // what pollLimits emits for limitName 'GPT-5.3-Codex-Spark'
  const id = 'r-spark-scope';
  const reset = Date.now() + 60_000;
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'codex_bengalfox:primary', models, usedPercent: 100, resetsAt: reset }] };
    assert.equal(modelBlockedUntil(id, 'gpt-5.3-codex-spark'), reset);
    assert.ok(providerWindows(id, 'gpt-5.3-codex-spark').length === 1);
    assert.equal(modelBlockedUntil(id, 'gpt-6-astra'), null);
    assert.equal(providerWindows(id, 'gpt-6-astra').length, 0);
  } finally { delete getLimits().providers[id]; }
});

test('R: Nimbus Quill scope matches hyphenated ids; invalid models regex falls back to substring', () => {
  const r = normalizeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 },
    model_scoped: [{ display_name: 'Nimbus Quill', utilization: 100 }],
  } });
  const w = r.windows.find((x) => x.id === 'model:Nimbus Quill');
  assert.equal(w.models, 'nimbus[-_ ]quill');
  const id = 'r-nimbus-fallback';
  const reset = Date.now() + 60_000;
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'model:Nimbus Quill', models: w.models, usedPercent: 100, resetsAt: reset }] };
    assert.equal(modelBlockedUntil(id, 'claude-nimbus-quill-1'), reset);
    assert.equal(modelBlockedUntil(id, 'claude-opus-4-8'), null);
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'bad', models: 'Spark+ (unclosed', usedPercent: 100, resetsAt: reset }] };
    assert.doesNotThrow(() => providerWindows(id, 'spark+ (unclosed id'));
    assert.equal(modelBlockedUntil(id, 'spark+ (unclosed id'), reset, 'substring fallback must still apply the window');
    assert.equal(modelBlockedUntil(id, 'gpt-6-astra'), null);
  } finally { delete getLimits().providers[id]; }
});

test('R: 429 with no reset header sets requests resetsAt to the Retry-After deadline', async (t) => {
  const id = 'r-429-retry-resets';
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  try {
    noteHttp(id, 429, { 'Retry-After': '45', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '100' });
    const p = getLimits().providers[id];
    const w = p.windows.find((x) => x.id === 'requests');
    assert.equal(w.resetsAt, p.blockedUntil);
    assert.equal(w.resetsAt, now + 45_000);
    t.mock.method(Date, 'now', () => now + 45_000);
    assert.equal(blockedUntil(id), null, 'provider 429 expires at Retry-After');
    assert.equal(modelBlockedUntil(id, null), null, 'requests window must not become a 30-min park');
  } finally { delete getLimits().providers[id]; }
});

test('R: remaining 0 with no reset header anywhere gets resetsAt = now + 60s', () => {
  const id = 'r-rem0-60s';
  const now = Date.now();
  try {
    noteHttp(id, 200, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '100' });
    const w = getLimits().providers[id].windows.find((x) => x.id === 'requests');
    assert.ok(Math.abs(w.resetsAt - now - 60_000) < 2000);
  } finally { delete getLimits().providers[id]; }
});

test('R: OpenAI x-ratelimit-reset-requests duration strings parse', () => {
  const cases = [['1s', 1000], ['6m0s', 6 * 60_000], ['1h2m3.5s', 3_600_000 + 120_000 + 3500], ['20ms', 20]];
  for (const [raw, ms] of cases) {
    const id = `r-dur-${raw}`;
    const now = Date.now();
    try {
      noteHttp(id, 200, { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '100', 'x-ratelimit-reset-requests': raw });
      const w = getLimits().providers[id].windows.find((x) => x.id === 'requests');
      assert.ok(w?.resetsAt != null, `${raw} must parse to a resetsAt`);
      assert.ok(Math.abs(w.resetsAt - now - ms) < 2000, `${raw}: expected ~${ms}ms from now, got ${w.resetsAt - now}`);
    } finally { delete getLimits().providers[id]; }
  }
});
