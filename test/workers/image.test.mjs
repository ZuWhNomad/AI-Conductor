import { tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { trimHistory } = await import('../../core/conductor.mjs');
const { runImage } = await import('../../core/workers/image.mjs');

test('trimHistory keeps recent tool-loop turns when the window has no user message', () => {
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  for (let i = 0; i < 200; i++) {
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}` }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: 'x' });
  }
  const out = trimHistory(msgs, 9);
  assert.equal(out[0].role, 'system');
  assert.ok(out.length > 1, 'must keep recent messages, not only the system prompt');
  assert.notEqual(out[1].role, 'tool', 'must not start with an orphaned tool reply');
  assert.ok(out.some((m) => m.role === 'assistant'));
  assert.ok(out.some((m) => m.role === 'tool'));
});

test('outDir that resolves outside cwd is rejected', async () => {
  const cwd = tmpDir('img-out');
  const r = await runImage({ cwd, provider: 'sd', prompt: 'x', outDir: '..' });
  assert.equal(r.ok, false);
  assert.match(r.error, /outDir resolves outside project/);
});

test('sd txt2img fetch is aborted by the task signal', { timeout: 5_000 }, async (ctx) => {
  const ac = new AbortController();
  let saw;
  ctx.mock.method(globalThis, 'fetch', async (_url, opts) => {
    saw = opts.signal;
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const p = runImage({ cwd: tmpDir('sd-abort'), provider: 'sd', prompt: 'x', signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(saw?.aborted, true);
  assert.match(r.error, /abort/i);
});

test('OpenAI image URL download rejects a non-success response', async (ctx) => {
  ctx.mock.method(globalThis, 'fetch', async (url) => url === 'https://api.openai.com/v1/images/generations'
    ? Response.json({ data: [{ url: 'https://images.test/missing.png' }] })
    : new Response('denied', { status: 403 }));
  const r = await runImage({ cwd: tmpDir('img-url-status'), provider: 'openai-images', prompt: 'x', apiKey: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /403 denied/);
  assert.deepEqual(r.files, []);
});
