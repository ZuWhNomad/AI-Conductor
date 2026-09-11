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
