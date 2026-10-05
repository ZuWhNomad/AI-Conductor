import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME, join, readJson, noteHttp, noteLimitAvailable, noteLimitHit, noteRateLimitEvent, blockedUntil, getLimits,
  groupOf, mergePoll, modelBlock, modelBlockedUntil, providerWindows, windowModels, normalizeUsage, windowFromEvent,
  familyRe, PROVIDERS, assertStoredEvent,
} from './_helpers.mjs';

test('quota groups are derived from the windows that meter each model', () => {
  const id = 'quota-groups';
  getLimits().providers[id] = { provider: id, windows: [
    { id: 'shared', label: 'shared' },
    { id: 'gemini', label: 'Gemini', models: '^gemini' },
    { id: 'third-party', label: 'Claude and GPT', models: '^(claude|gpt)' },
  ] };
  try {
    assert.deepEqual(groupOf(id, 'gemini-pro').ids, ['gemini', 'shared']);
    assert.deepEqual(groupOf(id, 'claude-sonnet'), {
      ids: ['shared', 'third-party'],
      own: [{ id: 'third-party', label: 'Claude and GPT', models: '^(claude|gpt)' }],
    });
    assert.deepEqual(groupOf(id, 'claude-sonnet').ids, groupOf(id, 'gpt-oss').ids);
    assert.notDeepEqual(groupOf(id, 'claude-sonnet').ids, groupOf(id, 'gemini-pro').ids);
    getLimits().providers[id].windows = [];
    assert.deepEqual(groupOf(id, 'anything').ids, [id]);
  } finally { delete getLimits().providers[id]; }
});

test('modelBlock reports window, retry-after, and guess sources without changing timestamps', (ctx) => {
  const now = Date.now(); ctx.mock.method(Date, 'now', () => now);
  const resetProvider = 'model-block-window', retryProvider = 'model-block-retry', guessProvider = 'model-block-guess';
  const reset = now + 60_000;
  try {
    for (const id of [resetProvider, retryProvider, guessProvider]) PROVIDERS[id] = { id, pollLimits: async () => ({ provider: id, windows: [], blocked: false }) };
    getLimits().providers[resetProvider] = { provider: resetProvider, blocked: false, windows: [{ id: 'weekly', usedPercent: 100, resetsAt: reset }] };
    assert.deepEqual(modelBlock(resetProvider), { until: reset, source: 'window' });
    assert.equal(modelBlockedUntil(resetProvider), reset);

    getLimits().providers[retryProvider] = { provider: retryProvider, blocked: false, windows: [] };
    const retryUntil = noteLimitHit(retryProvider, { retryAfterMs: 45_000 });
    assert.deepEqual(modelBlock(retryProvider), { until: retryUntil, source: 'retry-after' });
    assert.equal(modelBlockedUntil(retryProvider), retryUntil);

    getLimits().providers[guessProvider] = { provider: guessProvider, blocked: true, windows: [] };
    const legacy = blockedUntil(guessProvider);
    const guessed = modelBlock(guessProvider);
    assert.deepEqual(guessed, { until: legacy, source: 'guess' });
    assert.equal(modelBlockedUntil(guessProvider), legacy);
  } finally {
    delete getLimits().providers[resetProvider]; delete getLimits().providers[retryProvider]; delete getLimits().providers[guessProvider];
    for (const id of [resetProvider, retryProvider, guessProvider]) delete PROVIDERS[id];
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
    assert.deepEqual(result.windows.map(({ scope, ...w }) => w), windows);
    assert.deepEqual(result.windows.map((w) => w.scope), windows.map(() => 'other'));
  }
});

test('a confirmed limit survives an estimated refresh until real availability is reported', async (ctx) => {
  const { refreshLimits } = await import('../../core/limits.mjs');
  const { PROVIDERS } = await import('../../core/providers/index.mjs');
  const id = 'confirmed-estimate', reset = Date.now() + 60_000;
  let estimated = true;
  PROVIDERS[id] = { id, pollLimits: async () => ({ provider: id, blocked: false, windows: [{ id: `${id}:estimated`, label: 'estimated usage', usedPercent: 20, resetsAt: reset, estimated }] }) };
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [] };
    noteLimitHit(id, { model: 'grok-4.6', resetsAt: reset });
    await refreshLimits({ only: [id] });
    assert.equal(blockedUntil(id), reset);
    assert.equal(getLimits().providers[id].blockedReason, 'limit_hit');
    assert.equal(getLimits().providers[id].windows[0].usedPercent, 100);
    assert.equal(noteLimitAvailable(id, 'grok-4.5', getLimits().providers[id].confirmedLimit.hitAt + 1), true, 'a successful run on a globally blocked provider establishes recovery');
    assert.equal(blockedUntil(id), null);
    noteLimitHit(id, { model: 'grok-4.6', resetsAt: reset });
    estimated = false;
    await refreshLimits({ only: [id] });
    assert.equal(blockedUntil(id), null, 'a later real below-limit window establishes recovery');
    assert.equal(getLimits().providers[id].confirmedLimit, undefined);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('a confirmed limit expires at blockedUntil', (ctx) => {
  const id = 'confirmed-expiry', now = Date.now(), reset = now + 60_000;
  PROVIDERS[id] = { id };
  let clock = now;
  ctx.mock.method(Date, 'now', () => clock);
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [] };
    noteLimitHit(id, { model: 'grok-4.6', resetsAt: reset });
    assert.equal(blockedUntil(id), reset);
    clock = reset;
    assert.equal(blockedUntil(id), null);
    assert.equal(getLimits().providers[id].confirmedLimit, undefined);
    assert.deepEqual(getLimits().providers[id].windows, []);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('confirmed recovery requires every recorded window and reset evidence for each', () => {
  const id = 'confirmed-reset-proof', reset = Date.now() + 60_000;
  PROVIDERS[id] = { id };
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [
      { id: 'weekly-a', models: 'opus', usedPercent: 60, resetsAt: reset },
      { id: 'weekly-b', models: 'opus', usedPercent: 70, resetsAt: reset },
    ] };
    noteLimitHit(id, { model: 'opus' });
    const hit = structuredClone(getLimits().providers[id]);
    const poll = (windows) => ({ provider: id, blocked: false, windows });
    const lagging = mergePoll(hit, poll([
      { id: 'weekly-a', models: 'opus', usedPercent: 50, resetsAt: reset },
      { id: 'weekly-b', models: 'opus', usedPercent: 60, resetsAt: reset },
    ]), hit);
    assert.ok(lagging.confirmedLimit, 'a small utilization change in the same window is not a reset');
    const missing = mergePoll(hit, poll([{ id: 'weekly-a', models: 'opus', usedPercent: 20, resetsAt: reset }]), hit);
    assert.ok(missing.confirmedLimit, 'every recorded real window must be present');
    const recovered = mergePoll(hit, poll([
      { id: 'weekly-a', models: 'opus', usedPercent: 40, resetsAt: reset },
      { id: 'weekly-b', models: 'opus', usedPercent: 69, resetsAt: reset + 60_000 },
    ]), hit);
    assert.equal(recovered.confirmedLimit, undefined);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('a hit refreshes confirmation even when the model was already blocked', (ctx) => {
  const id = 'confirmed-existing', now = Date.now(), reset = now + 60_000;
  PROVIDERS[id] = { id };
  let clock = now; ctx.mock.method(Date, 'now', () => clock);
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'weekly', models: 'opus', usedPercent: 100, resetsAt: reset }] };
    assert.equal(noteLimitHit(id, { model: 'opus' }), reset);
    assert.equal(getLimits().providers[id].confirmedLimit.hitAt, now);
    clock++;
    assert.equal(noteLimitHit(id, { model: 'opus', resetsAt: now + 1000 }), reset);
    assert.equal(getLimits().providers[id].confirmedLimit.hitAt, clock);
    assert.equal(getLimits().providers[id].confirmedLimit.blockedUntil, reset);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('confirmed deadlines use targeted resets and only shorten for retry-after', (ctx) => {
  const now = Date.now(), sessionReset = now + 5 * 60 * 60_000, weeklyReset = now + 7 * 24 * 60 * 60_000;
  ctx.mock.method(Date, 'now', () => now);
  for (const id of ['confirmed-target-reset', 'confirmed-short-retry', 'confirmed-long-retry']) PROVIDERS[id] = { id };
  const state = (id) => { getLimits().providers[id] = { provider: id, blocked: false, windows: [
    { id: 'session', label: '5-hour', usedPercent: 40, resetsAt: sessionReset },
    { id: 'weekly', label: 'weekly Opus', models: 'opus', usedPercent: 40, resetsAt: weeklyReset },
  ] }; };
  try {
    state('confirmed-target-reset');
    assert.equal(noteLimitHit('confirmed-target-reset', { model: 'opus' }), weeklyReset);
    state('confirmed-short-retry');
    assert.equal(noteLimitHit('confirmed-short-retry', { model: 'opus', retryAfterMs: 60_000 }), now + 60_000);
    state('confirmed-long-retry');
    assert.equal(noteLimitHit('confirmed-long-retry', { model: 'opus', retryAfterMs: 8 * 24 * 60 * 60_000 }), weeklyReset);
  } finally {
    for (const id of ['confirmed-target-reset', 'confirmed-short-retry', 'confirmed-long-retry']) {
      delete PROVIDERS[id];
      delete getLimits().providers[id];
    }
  }
});

test('clearing confirmation does not overwrite newer utilization', () => {
  const id = 'confirmed-newer-usage', reset = Date.now() + 60_000;
  PROVIDERS[id] = { id };
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'weekly', models: 'opus', usedPercent: 40, resetsAt: reset }] };
    noteLimitHit(id, { model: 'opus' });
    const p = getLimits().providers[id], startedAt = p.confirmedLimit.hitAt + 1;
    p.windows[0].usedPercent = 55;
    assert.equal(noteLimitAvailable(id, 'opus', startedAt), true);
    assert.equal(p.windows[0].usedPercent, 55);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('a full fresh poll retains pre-hit utilization for later clearing', () => {
  const id = 'confirmed-retain-prior', reset = Date.now() + 60_000;
  PROVIDERS[id] = { id };
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'weekly', models: 'opus', usedPercent: 40, resetsAt: reset }] };
    noteLimitHit(id, { model: 'opus' });
    const hit = structuredClone(getLimits().providers[id]);
    const retained = mergePoll(hit, { provider: id, blocked: false, windows: [{ id: 'weekly', models: 'opus', usedPercent: 100, resetsAt: reset }] }, hit);
    assert.equal(retained.confirmedLimit.windows[0].usedPercent, 40);
    getLimits().providers[id] = retained;
    assert.equal(noteLimitAvailable(id, 'opus', retained.confirmedLimit.hitAt + 1), true);
    assert.equal(retained.windows[0].usedPercent, 40);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('poll merging keeps the stronger global block without globalizing model quotas', async () => {
  const { modelBlockedUntil } = await import('../../core/limits.mjs');
  const until = Date.now() + 60_000;
  const prev = { blocked: true, blockedReason: '429', blockedUntil: until };
  const scoped = { id: 'seven_day_opus', models: 'opus', usedPercent: 100, resetsAt: until + 60_000 };
  for (const reset of [until - 1, until + 1]) {
    const result = mergePoll(prev, { blocked: true, windows: [{ id: 'requests', usedPercent: 100, resetsAt: reset }, scoped] });
    assert.equal(result.blockedUntil, Math.max(until, reset));
    assert.deepEqual(result.windows[1], { ...scoped, scope: 'other' });
    assert.equal(mergePoll(result, { blocked: false, windows: [{ id: 'deepseek:budget', usedPercent: 0 }] }).blockedUntil, until);
  }
  const indefinite = mergePoll(prev, { blocked: true, blockedReason: 'balance exhausted', windows: [] });
  assert.equal(indefinite.blocked, true);
  assert.equal(indefinite.blockedUntil, null);
  assert.equal(indefinite.blockedReason, 'balance exhausted');
  assert.equal(mergePoll(indefinite, { blocked: false, windows: [{ id: 'deepseek:budget', usedPercent: 0 }] }).blockedUntil, until);
  assert.equal(mergePoll(indefinite, { blocked: false, windows: [{ id: 'requests', usedPercent: 50 }] }).blocked, false);
  const id = 'fake-http-scoped';
  const { PROVIDERS } = await import('../../core/providers/index.mjs');
  PROVIDERS[id] = { id };
  try {
    getLimits().providers[id] = indefinite;
    noteHttp(id, 200);
    assert.equal(getLimits().providers[id].blockedReason, 'balance exhausted');
    assert.equal(mergePoll(getLimits().providers[id], { blocked: false, windows: [{ id: 'deepseek:budget', usedPercent: 0 }] }).blocked, false);
    getLimits().providers[id] = mergePoll(prev, { blocked: false, windows: [{ id: 'requests', usedPercent: 50 }, scoped] });
    assert.equal(blockedUntil(id), null);
    assert.equal(modelBlockedUntil(id, 'opus'), scoped.resetsAt);
    assert.equal(modelBlockedUntil(id, 'sonnet'), null);
  } finally {
    delete PROVIDERS[id];
    delete getLimits().providers[id];
  }
});
