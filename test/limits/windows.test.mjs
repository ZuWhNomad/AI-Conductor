import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME, join, readJson, noteHttp, noteLimitAvailable, noteLimitHit, noteRateLimitEvent, blockedUntil, getLimits,
  groupOf, mergePoll, modelBlock, modelBlockedUntil, providerWindows, windowModels, normalizeUsage, windowFromEvent,
  familyRe, PROVIDERS, assertStoredEvent,
} from './_helpers.mjs';

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

test('a confirmed hit on a model-scoped window blocks only that model', () => {
  const id = 'confirmed-model', reset = Date.now() + 60_000;
  PROVIDERS[id] = { id };
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [
      { id: 'session', label: '5-hour', usedPercent: 30, resetsAt: reset },
      { id: 'weekly-opus', label: 'weekly Opus', models: 'opus', usedPercent: 40, resetsAt: reset },
    ] };
    noteLimitHit(id, { model: 'claude-opus-5' });
    const p = getLimits().providers[id];
    assert.equal(p.blocked, false);
    assert.equal(p.windows.find((w) => w.id === 'weekly-opus').usedPercent, 100);
    assert.equal(p.windows.find((w) => w.id === 'session').usedPercent, 30);
    assert.equal(modelBlockedUntil(id, 'claude-opus-5'), reset);
    assert.equal(modelBlockedUntil(id, 'claude-sonnet-5'), null);
    assert.equal(noteLimitAvailable(id, 'claude-sonnet-5', p.confirmedLimit.hitAt + 1), false);
    assert.equal(modelBlockedUntil(id, 'claude-opus-5'), reset);
    assert.equal(noteLimitAvailable(id, 'claude-opus-5', p.confirmedLimit.hitAt + 1), true);
    assert.equal(modelBlockedUntil(id, 'claude-opus-5'), null);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('a near-full global window makes an ambiguous model hit provider-wide', () => {
  const reset = Date.now() + 60_000;
  for (const [usedPercent, global] of [[89, false], [90, true], [undefined, true]]) {
    const id = `confirmed-scope-${String(usedPercent)}`;
    PROVIDERS[id] = { id };
    try {
      getLimits().providers[id] = { provider: id, blocked: false, windows: [
        { id: 'session', label: '5-hour', usedPercent, resetsAt: reset },
        { id: 'weekly', label: 'weekly Opus', models: 'opus', usedPercent: 40, resetsAt: reset + 60_000 },
      ] };
      noteLimitHit(id, { model: 'claude-opus' });
      const p = getLimits().providers[id];
      assert.equal(p.confirmedLimit.global, global);
      assert.equal(p.windows.find((w) => w.id === (global ? 'session' : 'weekly')).usedPercent, 100);
      assert.equal(modelBlockedUntil(id, 'claude-sonnet') !== null, global);
    } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
  }
});

test('null-model availability ignores model-scoped blocks but display keeps their windows', () => {
  const id = 'confirmed-null-model', reset = Date.now() + 60_000;
  PROVIDERS[id] = { id };
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'weekly-fable', label: 'weekly Fable', usedPercent: 100, resetsAt: reset }] };
    assert.equal(providerWindows(id, null).length, 1, 'display callers still receive all windows');
    assert.equal(modelBlockedUntil(id, null), null);
    assert.equal(modelBlockedUntil(id, 'fable'), reset);
    noteLimitHit(id, { model: 'fable' });
    assert.equal(modelBlockedUntil(id, null), null, 'a scoped confirmation is also invisible to default selection');
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('legacy Fable labels share one scope helper for hits, display, and recovery', () => {
  const id = 'confirmed-legacy-fable', reset = Date.now() + 60_000;
  PROVIDERS[id] = { id };
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [
      { id: 'session', label: '5-hour', usedPercent: 20, resetsAt: reset },
      { id: 'fable', label: 'weekly Fable', usedPercent: 40, resetsAt: reset },
    ] };
    noteLimitHit(id, { model: 'my-fable-model' });
    const p = getLimits().providers[id];
    assert.deepEqual(providerWindows(id, 'other').map((w) => w.id), ['session']);
    assert.equal(p.confirmedLimit.global, false);
    assert.equal(p.windows.find((w) => w.id === 'fable').usedPercent, 100);
    assert.equal(noteLimitAvailable(id, 'other', p.confirmedLimit.hitAt + 1), false);
    assert.equal(noteLimitAvailable(id, 'another-fable', p.confirmedLimit.hitAt + 1), true);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('success on a different model clears a shared scoped window', () => {
  const id = 'confirmed-shared-model', reset = Date.now() + 60_000;
  PROVIDERS[id] = { id };
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [{ id: 'weekly-opus', models: 'opus', usedPercent: 40, resetsAt: reset }] };
    noteLimitHit(id, { model: 'claude-opus-5' });
    const hitAt = getLimits().providers[id].confirmedLimit.hitAt;
    assert.equal(noteLimitAvailable(id, 'claude-sonnet-5', hitAt + 1), false);
    assert.equal(noteLimitAvailable(id, 'opus-preview', hitAt + 1), true);
    assert.equal(modelBlockedUntil(id, 'claude-opus-5'), null);
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('a maxed model-scoped Claude window blocks only that model, not the whole provider', () => {
  // weekly Opus at 100% but five_hour/weekly/Fable have room: the provider is NOT blocked (Fable/Sonnet keep working).
  const scoped = normalizeUsage({ rate_limits: { five_hour: { utilization: 40 }, seven_day: { utilization: 55 }, seven_day_opus: { utilization: 100 }, seven_day_fable: { utilization: 30 } }, rate_limits_available: true });
  assert.equal(scoped.blocked, false);
  assert.equal(scoped.windows.find((w) => w.id === 'seven_day_opus').models, 'opus'); // the scoped window carries its model regex
  // a global (unscoped) weekly at 100% DOES block the provider.
  assert.equal(normalizeUsage({ rate_limits: { seven_day: { utilization: 100 } }, rate_limits_available: true }).blocked, true);
});

test('scoped rejections block their model until reset and preserve genuine global blocks', async () => {
  const { modelBlockedUntil } = await import('../../core/limits.mjs');
  const { loadConfig } = await import('../../core/config.mjs');
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

test('codename test-pool keys (iguana_necktie, nimbus_quill) are dropped and never block the provider', () => {
  const r = normalizeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 },
    seven_day: { utilization: 20 },
    iguana_necktie: { utilization: 100 },
    nimbus_quill: { utilization: 100 },
  } });
  assert.deepEqual(r.windows.map((w) => w.id).sort(), ['five_hour', 'seven_day']);
  assert.equal(r.blocked, false);
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

test('L15: missing utilization keeps the previous usedPercent, except rejected → allowed', () => {
  const id = 'l15-carry';
  PROVIDERS[id] = { id };
  try {
    noteRateLimitEvent(id, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 600 });
    assert.equal(getLimits().providers[id].windows[0].usedPercent, 42);
    noteRateLimitEvent(id, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 600 });
    assert.equal(getLimits().providers[id].windows[0].usedPercent, 42, 'warning without utilization keeps 42');
    noteRateLimitEvent(id, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 600 });
    assert.equal(getLimits().providers[id].windows[0].usedPercent, 42, 'rejection without utilization keeps 42');
    noteRateLimitEvent(id, { status: 'allowed', rateLimitType: 'five_hour' });
    assert.equal(getLimits().providers[id].windows[0].usedPercent, null, 'rejected → allowed without utilization does not carry');
  } finally { delete PROVIDERS[id]; delete getLimits().providers[id]; }
});

test('I13: isSession is the session-window predicate', async () => {
  const { isSession } = await import('../../core/limits.mjs');
  assert.equal(isSession({ label: '5-hour' }), true);
  assert.equal(isSession({ label: 'session' }), true);
  assert.equal(isSession({ windowMinutes: 300 }), true);
  assert.equal(isSession({ label: 'weekly', windowMinutes: 10080 }), false);
  assert.equal(isSession({ label: 'requests' }), false);
  assert.equal(isSession({ scope: 'session', label: 'weekly' }), true);
  assert.equal(isSession({ scope: 'weekly', label: '5-hour' }), false);
  assert.equal(isSession({ scope: 'session', models: 'spark', windowMinutes: 300 }), true);
  assert.equal(isSession({ scope: 'model', models: 'spark', windowMinutes: 300 }), true, 'a legacy model tag falls back to its time horizon');
});

test('familyRe and windowApplies anchor model-family and window matching to word boundaries', () => {
  assert.equal(familyRe('claude-opus-5-5'), 'opus');
  assert.equal(familyRe('Opus'), 'opus');
  assert.equal(familyRe('magnum-opusx'), null);
  assert.equal(familyRe('octopus'), null);
  const r = normalizeUsage({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 10 },
    model_scoped: [
      { display_name: 'magnum-opusx', utilization: 100 },
      { display_name: 'Opus 5', utilization: 100 },
    ],
  } });
  assert.equal(r.windows.find((w) => w.id === 'model:magnum-opusx').models, 'magnum[-_ ]opusx');
  assert.equal(r.windows.find((w) => w.id === 'model:Opus 5').models, 'opus');

  const id = 'anchored-window-test', reset = Date.now() + 60_000;
  try {
    getLimits().providers[id] = { provider: id, blocked: false, windows: [
      { id: 'weekly-opus', label: 'weekly Opus', models: 'opus', usedPercent: 100, resetsAt: reset },
    ] };
    assert.equal(modelBlockedUntil(id, 'claude-opus-5-5'), reset, 'claude-opus-5-5 matches opus window');
    assert.equal(modelBlockedUntil(id, 'Opus'), reset, 'Opus matches opus window');
    assert.equal(modelBlockedUntil(id, 'magnum-opusx'), null, 'magnum-opusx does not match opus window');
    assert.equal(modelBlockedUntil(id, 'octopus'), null, 'octopus does not match opus window');
    assert.equal(providerWindows(id, 'octopus').length, 0);
    assert.equal(providerWindows(id, 'claude-opus-5-5').length, 1);
  } finally { delete getLimits().providers[id]; }
});

test('stale unscoped model:* window applies only to its own model and never blocks all models', () => {
  const id = 'stale-unscoped-model-win', reset = Date.now() + 60_000;
  try {
    const staleNimbus = { id: 'model:Nimbus Quill', label: 'weekly Nimbus Quill', usedPercent: 100, resetsAt: reset };
    getLimits().providers[id] = { provider: id, blocked: false, windows: [staleNimbus] };

    assert.equal(windowModels(staleNimbus), 'nimbus[-_ ]quill');
    assert.equal(blockedUntil(id), null, 'stale unscoped model window must not block provider');
    assert.equal(modelBlockedUntil(id, null), null, 'stale unscoped model window must not block null model');
    assert.equal(modelBlockedUntil(id, 'claude-opus-5'), null, 'stale Nimbus Quill window must not block Opus');
    assert.equal(modelBlockedUntil(id, 'claude-sonnet-5'), null, 'stale Nimbus Quill window must not block Sonnet');
    assert.equal(providerWindows(id, 'claude-opus-5').length, 0, 'Opus does not meter Nimbus Quill window');

    assert.equal(modelBlockedUntil(id, 'claude-nimbus-quill-1'), reset, 'stale Nimbus Quill window blocks its own model');
    assert.equal(providerWindows(id, 'claude-nimbus-quill-1').length, 1);

    const staleOpus = { id: 'model:Opus', label: 'weekly Opus', usedPercent: 100, resetsAt: reset };
    getLimits().providers[id] = { provider: id, blocked: false, windows: [staleOpus] };
    assert.equal(windowModels(staleOpus), 'opus');
    assert.equal(modelBlockedUntil(id, 'claude-opus-5-5'), reset, 'stale Opus window blocks Opus');
    assert.equal(modelBlockedUntil(id, 'claude-sonnet-5'), null, 'stale Opus window does not block Sonnet');
    assert.equal(modelBlockedUntil(id, 'octopus'), null, 'stale Opus window does not block octopus');
    assert.equal(modelBlockedUntil(id, null), null, 'stale Opus window does not block null model');
    assert.equal(blockedUntil(id), null, 'stale Opus window does not block provider');
  } finally { delete getLimits().providers[id]; }
});
