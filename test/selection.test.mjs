import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseSelection, createSession, deleteSession } = await import('../core/conductor.mjs');

test('provider:model:effort parsing', () => {
  const cfg = { provider: 'claude', model: 'claude-fable-5-1[1m]', effort: 'high' };
  assert.deepEqual(parseSelection(null, cfg), cfg);
  assert.deepEqual(parseSelection('claude:sonnet:low', cfg), { provider: 'claude', model: 'sonnet', effort: 'low' });
  assert.deepEqual(parseSelection('claude:default:default', cfg), { provider: 'claude', model: null, effort: null });
  assert.deepEqual(parseSelection('sonnet', cfg), { provider: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(parseSelection('default', cfg), { provider: 'claude', model: null, effort: 'high' });
  assert.deepEqual(parseSelection('codex:gpt-6-astra', cfg), { provider: 'codex', model: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual(parseSelection('ollama:qwen3.8:latest:low', cfg), { provider: 'ollama', model: 'qwen3.8:latest', effort: 'low' });
  assert.deepEqual(parseSelection('ollama:qwen3.8:latest', cfg), { provider: 'ollama', model: 'qwen3.8:latest', effort: 'high' });
  assert.deepEqual(parseSelection('codex:gpt-6-astra:ultra', cfg), { provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' });
});

test('session creation validates directory, permission mode and model selection', () => {
  const cwd = tmpDir('sel-validation');
  assert.throws(() => createSession({ cwd: 123 }), { status: 400, message: 'cwd must be an existing directory' });
  assert.throws(() => createSession({ cwd: cwd + '/missing' }), { status: 400 });
  assert.throws(() => createSession({ cwd, permissionMode: 'bogus' }), { status: 400 });
  assert.throws(() => createSession({ cwd, provider: 'missing' }), { status: 400 });
  assert.throws(() => createSession({ cwd, model: 'codex::high' }), { status: 400 });
  assert.throws(() => createSession({ cwd, provider: 'codex' }), { status: 400, message: /No model known/ }); // explicit provider must not inherit the Claude default model
  const s = createSession({ cwd, title: 123 });
  assert.equal(s.title, '123'); deleteSession(s.id);
  const long = createSession({ cwd, title: 'x'.repeat(150) });
  assert.equal(long.title.length, 120); deleteSession(long.id);
});

test('sessions use the configured default; any agent provider can conduct, image providers cannot', () => {
  const cwd = tmpDir('sel');
  const s = createSession({ cwd });
  assert.equal(s.model, 'claude-fable-5-1[1m]');
  assert.equal(s.selection, 'claude:claude-fable-5-1[1m]:high');
  assert.equal(s.runtime, 'claude');
  deleteSession(s.id);
  const d = createSession({ cwd, model: 'default', effort: 'low' });
  assert.equal(d.model, null);
  assert.equal(d.selection, 'claude:default:low');
  deleteSession(d.id);
  const c = createSession({ cwd, model: 'codex:gpt-6-astra:high' });
  assert.equal(c.runtime, 'codex');
  assert.equal(c.selection, 'codex:gpt-6-astra:high');
  deleteSession(c.id);
  const o = createSession({ cwd, model: 'ollama:qwen3.8:low' });
  assert.equal(o.runtime, 'loop');
  deleteSession(o.id);
  // The UI posts provider + bare model id separately; a colon in the id must survive.
  const o2 = createSession({ cwd, provider: 'ollama', model: 'qwen3.8:latest', effort: 'low' });
  assert.equal(o2.model, 'qwen3.8:latest');
  assert.equal(o2.selection, 'ollama:qwen3.8:latest:low');
  deleteSession(o2.id);
  const c2 = createSession({ cwd, provider: 'codex', model: 'gpt-6-astra' });
  assert.equal(c2.selection, 'codex:gpt-6-astra:high');
  deleteSession(c2.id);
  assert.throws(() => createSession({ cwd, model: 'codex::high' }), /No model known/); // registry empty in tests
  assert.throws(() => createSession({ cwd, model: 'sd:x:low' }), /cannot conduct/);
});
