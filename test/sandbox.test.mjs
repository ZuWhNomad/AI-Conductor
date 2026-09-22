import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

// Per-model Codex sandbox exceptions. gpt-6-astra runs with full access by default because under workspace-write the
// Codex sandbox is denied the geometry libraries' DLLs, and Astra (correctly) stops instead of improvising.
const { codexSandboxFor, DEFAULTS } = await import('../core/config.mjs');
const { createTask } = await import('../core/tasks.mjs');

test('Astra gets full access by default; every other Codex model keeps the default sandbox', () => {
  assert.equal(DEFAULTS.worker.codexSandboxByModel['gpt-6-astra'], 'danger-full-access');
  assert.equal(codexSandboxFor('gpt-6-astra'), 'danger-full-access');
  assert.equal(codexSandboxFor('gpt-5.6-sol'), DEFAULTS.worker.codexSandbox);
  assert.equal(codexSandboxFor(null), DEFAULTS.worker.codexSandbox, 'a task with no model gets the default');
});

test('a garbage exception value falls back to the default instead of reaching the Codex CLI', () => {
  const cfg = { worker: { codexSandbox: 'workspace-write', codexSandboxByModel: { 'gpt-6-astra': 'yolo' } } };
  assert.equal(codexSandboxFor('gpt-6-astra', cfg), 'workspace-write');
});

test('the task record shows the sandbox it will run under, and an explicit sandbox always wins', () => {
  const base = { cwd: tmpdir(), spec: 'noop', provider: 'codex' };
  assert.equal(createTask({ ...base, model: 'gpt-6-astra' }).sandbox, 'danger-full-access');
  assert.equal(createTask({ ...base, model: 'gpt-5.6-sol' }).sandbox, DEFAULTS.worker.codexSandbox);
  assert.equal(createTask({ ...base, model: 'gpt-6-astra', sandbox: 'read-only' }).sandbox, 'read-only', 'a read-only review stays read-only');
});

test('non-Codex providers are untouched: their sandbox stays unset', () => {
  assert.equal(createTask({ cwd: tmpdir(), spec: 'noop', provider: 'claude', model: 'opus[1m]' }).sandbox, null);
});
