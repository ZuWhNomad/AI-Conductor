import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { watchSignIn, stopSignInWatch, staleAuthProviders } = await import('../../server/index.mjs');

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('a sign-in watch re-probes until the provider comes back ok, then stops', async () => {
  let calls = 0, status = 'unavailable';
  const w = watchSignIn('grok', { intervalMs: 1, maxMs: 5000, refresh: async () => { calls++; if (calls >= 3) status = 'ok'; }, statusOf: () => status });
  await settle();
  assert.equal(w.stopped, true);
  assert.equal(calls, 3);            // stopped at the first success, not after a fixed number of tries
});

test('a sign-in watch gives up when its window runs out', async () => {
  let calls = 0;
  const w = watchSignIn('grok', { intervalMs: 1, maxMs: 5, refresh: async () => { calls++; }, statusOf: () => 'unavailable' });
  await settle();
  assert.equal(w.stopped, true);
  const seen = calls;
  await settle(20);
  assert.equal(calls, seen);         // and really stops probing
});

test('stopping a watch (Quit) ends it', async () => {
  let calls = 0;
  const w = watchSignIn('grok', { intervalMs: 1, maxMs: 5000, refresh: async () => { calls++; }, statusOf: () => 'unavailable' });
  stopSignInWatch('grok');
  const seen = calls;
  await settle(20);
  assert.equal(w.stopped, true);
  assert.equal(calls, seen);
});

test('the slow sweep re-probes installed-but-signed-out providers only', () => {
  assert.deepEqual(staleAuthProviders({
    grok: { installed: true, loggedIn: false },      // signed out: a sign-in elsewhere is exactly what we watch for
    kimi: { installed: true, loggedIn: true },       // fine
    sd: { installed: false },                        // not installed: an install won't happen behind our back
    xai: { installed: true, configured: false },     // missing API key: arrives through Settings, which refreshes
  }), ['grok']);
});
