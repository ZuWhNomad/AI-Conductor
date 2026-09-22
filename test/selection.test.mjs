import { HOME, tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeJson } from '../core/paths.mjs';
import { bus } from '../core/bus.mjs';

// The registry is loaded at import time: seed the one model the no-effort test needs (no Codex models, on purpose).
writeJson(join(HOME, 'models.json'), { updatedAt: 'x', providers: {}, models: [{ provider: 'ollama', id: 'qwen2.5:3b', kind: 'agent', cost: 'free-local', efforts: [] }] });
const { parseSelection, createSession, deleteSession, setTitle, setEffort, sendMessage } = await import('../core/conductor.mjs');

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

test('setTitle renames a chat, trims and clamps, and rejects empty or unknown', () => {
  const cwd = tmpDir('sel-rename');
  const s = createSession({ cwd });
  assert.equal(s.title, 'New chat');
  assert.equal(setTitle(s.id, '  Refactor the parser  ').title, 'Refactor the parser'); // trimmed
  assert.equal(setTitle(s.id, 'y'.repeat(150)).title.length, 120); // clamped
  assert.throws(() => setTitle(s.id, '   '), { status: 400 }); // empty after trim
  assert.throws(() => setTitle('nope', 'x'), { status: 404 });
  deleteSession(s.id);
});

test('sessions use the configured default; any agent provider can conduct, image providers cannot', () => {
  const cwd = tmpDir('sel');
  const s = createSession({ cwd });
  assert.equal(s.model, 'claude-opus-5-5[1m]'); // DEFAULTS.conductor.model: an exact id, never an alias
  assert.equal(s.selection, 'claude:claude-opus-5-5[1m]:high');
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
  assert.throws(() => createSession({ cwd, model: 'codex::high' }), /No model known/); // no Codex models in the test registry
  assert.throws(() => createSession({ cwd, model: 'sd:x:low' }), /cannot conduct/);
});

test('a model that lists no efforts never carries one: not on the session, not in the loop request', async (ctx) => {
  const cwd = tmpDir('sel-noeffort');
  const d = createSession({ cwd, provider: 'ollama', model: 'qwen2.5:3b' }); // would inherit the configured default (high)
  assert.equal(d.effort, null);
  assert.equal(d.selection, 'ollama:qwen2.5:3b:default');
  deleteSession(d.id);
  const s = createSession({ cwd, provider: 'ollama', model: 'qwen2.5:3b', effort: 'high' }); // the UI picker always posts one
  assert.equal(s.effort, null);
  setEffort(s.id, 'high'); // the header picker (or a session saved before this guard) can still put one back
  let body;
  ctx.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (!String(url).endsWith('/chat/completions')) return Response.json({ version: 'test' }); // ensureRunning's ping: no spawn
    body = JSON.parse(opts.body);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'hi' } }] });
  });
  const idle = new Promise((r) => bus.on('event', function f(e) { if (e.sessionId === s.id && e.kind === 'status' && e.status === 'idle') { bus.off('event', f); r(); } }));
  await sendMessage(s.id, 'hello');
  await idle;
  assert.equal(body.model, 'qwen2.5:3b');
  assert.equal('reasoning_effort' in body, false);
  deleteSession(s.id);
});
