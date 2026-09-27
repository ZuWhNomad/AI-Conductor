import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../core/bus.mjs';
const { pullModel, enabled } = await import('../core/providers/ollama.mjs');

test('enabled is opt-in (=== true)', async () => {
  const { saveConfig, loadConfig } = await import('../core/config.mjs');
  assert.equal(loadConfig().providers.ollama.enabled, false);
  assert.equal(enabled(), false);
  saveConfig({ providers: { ollama: { enabled: true } } });
  assert.equal(enabled(), true);
  saveConfig({ providers: { ollama: { enabled: false } } });
  assert.equal(enabled(), false);
});

test('pullModel skips malformed progress lines and throws j.error', async (t) => {
  const body = ['not-json', JSON.stringify({ status: 'pulling', completed: 1, total: 2 }), JSON.stringify({ error: 'no such model' })].join('\n') + '\n';
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/api/pull')) return new Response(body, { status: 200 });
    throw new Error(String(url));
  });
  const seq = bus.seq;
  await assert.rejects(() => pullModel('missing'), /no such model/);
  const pulls = bus.since(seq).filter((e) => e.type === 'model_pull');
  assert.ok(pulls.some((e) => e.status === 'pulling'));
  assert.ok(pulls.some((e) => e.error === 'no such model'));
  assert.ok(!pulls.some((e) => e.status === 'done'));
});
