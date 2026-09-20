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
  assert.equal(DEFAULTS.conductor.maxWorkerConcurrency, 8);
  saveConfig({ conductor: { maxTurns: 0 }, worker: { maxTurns: -5 } });
  assert.equal(loadConfig().conductor.maxTurns, 9999);
  assert.equal(loadConfig().worker.maxTurns, 500);
  saveConfig({ conductor: { maxTurns: 20000 } });
  assert.equal(loadConfig().conductor.maxTurns, 20000);
  saveConfig({ conductor: { maxTurns: 9999 } });
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
  assert.deepEqual(loadConfig().ui, { autoRefresh: false, autoRefreshMinutes: 15 });
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
  saveConfig({ scorecard: { usageResets: { grok: { resetDay: 1, resetHour: 18 } } } }); // restore defaults (shared CONDUCTOR_HOME)
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
