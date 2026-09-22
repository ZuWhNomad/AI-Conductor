import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { loadConfig, saveConfig, publicConfig, DEFAULTS } = await import('../core/config.mjs');

test('defaults load, patches deep-merge, secrets redact', () => {
  const c = loadConfig();
  assert.equal(c.port, DEFAULTS.port);
  assert.equal(c.worker.provider, 'codex');
  saveConfig({ providers: { deepseek: { apiKey: 'sk-test' } }, worker: { effort: 'high' } });
  const c2 = loadConfig();
  assert.equal(c2.providers.deepseek.apiKey, 'sk-test');
  assert.equal(c2.worker.effort, 'high');
  assert.equal(c2.worker.provider, 'codex', 'untouched keys keep defaults');
  assert.equal(c2.providers.ollama.baseUrl, DEFAULTS.providers.ollama.baseUrl);
  assert.equal(publicConfig(c2).providers.deepseek.apiKey, '••••');
  assert.equal(publicConfig(c2).providers.xai.apiKey, null);
});

test('masked MCP URLs round-trip without replacing the real URLs', () => {
  const mcpServers = {
    query: { url: 'https://example.test/mcp?token=query-secret', env: { TOKEN: 'env-secret' } },
    userinfo: { url: 'https://operator:password@example.test/mcp' },
    both: { url: 'https://operator:password@example.test/mcp?key=query-secret' },
    malformed: { url: 'not-a-url?key=query-secret' },
    disabled: null,
  };
  saveConfig({ mcpServers });
  const patch = { mcpServers: publicConfig().mcpServers };
  for (const name of ['query', 'userinfo', 'both', 'malformed']) {
    assert.notEqual(patch.mcpServers[name].url, mcpServers[name].url, name);
    assert.ok(!patch.mcpServers[name].url.includes('secret'), name);
  }
  patch.mcpServers.query.categories = ['search'];
  const originalPatch = structuredClone(patch);
  saveConfig(patch);
  assert.deepEqual(patch, originalPatch, 'save does not mutate its caller');
  const stored = loadConfig().mcpServers;
  for (const [name, server] of Object.entries(mcpServers)) {
    if (server) assert.equal(stored[name].url, server.url, name);
  }
  assert.equal(stored.query.env.TOKEN, 'env-secret');
  assert.deepEqual(stored.query.categories, ['search']);
  assert.equal(stored.disabled, null);
  for (const mask of ['••••', encodeURIComponent('••••').toLowerCase()]) {
    saveConfig({ mcpServers: { query: { url: `https://example.test/mcp?token=${mask}` } } });
    assert.equal(loadConfig().mcpServers.query.url, mcpServers.query.url);
  }
  const replacement = 'https://example.test/new?token=replacement-secret';
  saveConfig({ mcpServers: { query: { url: replacement } } });
  assert.equal(loadConfig().mcpServers.query.url, replacement, 'unmasked edits still save');
  saveConfig({ mcpServers: { query: { url: '' } } });
  assert.equal(loadConfig().mcpServers.query.url, '', 'an explicit empty URL still saves');
});

test('settings reject nonobjects, preserve subtrees and normalize positive numbers', () => {
  for (const patch of ['x', null, [], 42]) assert.throws(() => saveConfig(patch), { status: 400 });
  saveConfig({ conductor: null });
  assert.equal(loadConfig().conductor.provider, 'claude');
  for (const value of ['abc', '3', 0, -1, Infinity, NaN, null]) {
    saveConfig({ pollMinutes: value, conductor: { maxWorkerConcurrency: value }, worker: { timeoutMinutes: value, maxRounds: value } });
    const c = loadConfig();
    assert.equal(c.pollMinutes, 15);
    assert.equal(c.conductor.maxWorkerConcurrency, DEFAULTS.conductor.maxWorkerConcurrency);
    assert.equal(c.worker.timeoutMinutes, DEFAULTS.worker.timeoutMinutes);
    assert.equal(c.worker.maxRounds, DEFAULTS.worker.maxRounds);
  }
  saveConfig({ conductor: { model: null } });
  assert.equal(loadConfig().conductor.model, null);
});

test('turn budgets default high and reject non-positive values', () => {
  assert.equal(DEFAULTS.conductor.maxTurns, 9999);
  assert.equal(DEFAULTS.worker.maxTurns, 500);
  assert.equal(DEFAULTS.conductor.maxWorkerConcurrency, 100);
  saveConfig({ conductor: { maxTurns: 0 }, worker: { maxTurns: -5 } });
  assert.equal(loadConfig().conductor.maxTurns, 9999);
  assert.equal(loadConfig().worker.maxTurns, 500);
  saveConfig({ conductor: { maxTurns: 20000 } });
  assert.equal(loadConfig().conductor.maxTurns, 20000);
  saveConfig({ conductor: { maxTurns: 9999 } });
});

test('timer and loop settings accept positive finite numbers and otherwise use DEFAULTS', () => {
  const keys = {
    conductor: ['turnTimeoutMinutes', 'updateQuietMinutes'], // updateCheckHours and detectMinutes: 0 means off, tested below
    worker: ['maxIterations', 'maxTurnsLocal', 'longRunMinutes'],
    scorecard: ['blockedMinutes'], server: ['lagWarnMs'],
  };
  for (const value of [0, -1, '3', null, Infinity, -Infinity, NaN, 1.5]) {
    const patch = Object.fromEntries(Object.entries(keys).map(([group, names]) => [group, Object.fromEntries(names.map((key) => [key, value]))]));
    patch.scorecard.windowTargets = { session: value, other: value };
    const saved = saveConfig(patch);
    for (const cfg of [saved, loadConfig()]) {
      for (const [group, names] of Object.entries(keys)) for (const key of names) {
        assert.equal(cfg[group][key], value === 1.5 ? value : DEFAULTS[group][key], `${group}.${key}`);
      }
      for (const key of ['session', 'other']) assert.equal(cfg.scorecard.windowTargets[key], value === 1.5 ? value : DEFAULTS.scorecard.windowTargets[key]);
    }
  }
  for (const value of ['bad', []]) {
    saveConfig({ scorecard: { windowTargets: value } });
    assert.deepEqual(loadConfig().scorecard.windowTargets, DEFAULTS.scorecard.windowTargets);
  }
  saveConfig(Object.fromEntries(Object.keys(keys).map((group) => [group, DEFAULTS[group]])));
});

test('the live prompt budgets are settings; the retired shared budget is absent', () => {
  assert.equal(DEFAULTS.worker.recipeChars, 6000);
  assert.equal(DEFAULTS.worker.toolLineChars, 1500);
  assert.ok(!('specAppendChars' in DEFAULTS.worker));
  saveConfig({ worker: { recipeChars: 7000, toolLineChars: 2000 } });
  assert.equal(loadConfig().worker.recipeChars, 7000);
  assert.equal(loadConfig().worker.toolLineChars, 2000);
  saveConfig({ worker: { recipeChars: DEFAULTS.worker.recipeChars, toolLineChars: DEFAULTS.worker.toolLineChars } });
});

test('worker.escalationRounds defaults to 2, allows 0 (disable), rejects negatives and non-integers', () => {
  assert.equal(DEFAULTS.worker.escalationRounds, 2);
  saveConfig({ worker: { escalationRounds: 0 } });
  assert.equal(loadConfig().worker.escalationRounds, 0, '0 is a valid choice: skip escalation, go straight to the conductor');
  for (const bad of [-1, 1.5, 'x', null, NaN]) {
    saveConfig({ worker: { escalationRounds: bad } });
    assert.equal(loadConfig().worker.escalationRounds, 2);
  }
});

test('providers panel auto-refresh settings default and normalize', () => {
  assert.deepEqual(loadConfig().ui, { autoRefresh: false, autoRefreshMinutes: 15, detectMinutes: 5 });
  saveConfig({ ui: { autoRefresh: 'yes', autoRefreshMinutes: 0 } });
  assert.equal(loadConfig().ui.autoRefresh, true);
  assert.equal(loadConfig().ui.autoRefreshMinutes, 15);
  saveConfig({ ui: { autoRefreshMinutes: 2 } });
  assert.equal(loadConfig().ui.autoRefreshMinutes, 2);
  saveConfig({ ui: { autoRefreshMinutes: 99999 } });
  assert.equal(loadConfig().ui.autoRefreshMinutes, 1440);
  saveConfig({ ui: { autoRefresh: false, autoRefreshMinutes: 15 } });
});

test('grok weekly usage-reset day and hour persist as numbers and clamp', () => {
  saveConfig({ scorecard: { usageResets: { grok: { resetDay: 3, resetHour: 9 } } } });
  const g = loadConfig().scorecard.usageResets.grok;
  assert.equal(g.resetDay, 3);
  assert.equal(g.resetHour, 9);
  assert.equal(typeof g.resetDay, 'number');
  assert.equal(typeof g.resetHour, 'number');
  assert.equal(g.periodHours, 168);
  saveConfig({ scorecard: { usageResets: { grok: { resetDay: 9, resetHour: 99 } } } });
  const g2 = loadConfig().scorecard.usageResets.grok;
  assert.equal(g2.resetDay, 6);
  assert.equal(g2.resetHour, 23);
  // No schedule is shipped (a plan's reset can move, so nothing is assumed): it exists only once the user sets it,
  // and "not set" is written as periodHours 0.
  assert.deepEqual(DEFAULTS.scorecard.usageResets, {});
  saveConfig({ scorecard: { usageResets: { grok: { periodHours: 0 } } } });
  assert.equal(loadConfig().scorecard.usageResets.grok.periodHours, 0);
});

test('state dir: CONDUCTOR_HOME wins; otherwise a .state/ folder beside the code, else ~/.conductor2', async () => {
  const { resolveStateDir, REPO_ROOT } = await import('../core/paths.mjs');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  assert.equal(resolveStateDir(), process.env.CONDUCTOR_HOME);
  const saved = process.env.CONDUCTOR_HOME; delete process.env.CONDUCTOR_HOME;
  try { assert.equal(resolveStateDir(), existsSync(join(REPO_ROOT, '.state')) ? join(REPO_ROOT, '.state') : join(homedir(), '.conductor2')); }
  finally { process.env.CONDUCTOR_HOME = saved; }
});

test('0 is a documented off switch for updateCheckHours and detectMinutes, so validation must keep it', async () => {
  const { saveConfig, loadConfig, DEFAULTS } = await import('../core/config.mjs');
  saveConfig({ conductor: { updateCheckHours: 0 }, ui: { detectMinutes: 0 } });
  assert.equal(loadConfig().conductor.updateCheckHours, 0, 'the periodic update check stays off');
  assert.equal(loadConfig().ui.detectMinutes, 0, 'the signed-out provider sweep stays off');
  saveConfig({ conductor: { updateCheckHours: -4 }, ui: { detectMinutes: 'soon' } });
  assert.equal(loadConfig().conductor.updateCheckHours, DEFAULTS.conductor.updateCheckHours, 'garbage still resets');
  assert.equal(loadConfig().ui.detectMinutes, DEFAULTS.ui.detectMinutes);
  saveConfig({ conductor: { updateCheckHours: DEFAULTS.conductor.updateCheckHours }, ui: { detectMinutes: DEFAULTS.ui.detectMinutes } });
});
