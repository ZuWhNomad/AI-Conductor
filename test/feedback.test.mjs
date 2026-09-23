import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { feedbackBundle, redact, writeFeedback } from '../core/feedback.mjs';
import { logImprovement, resolveImprovement } from '../core/improve.mjs';

test('feedback exports only safe improvement metadata, never free text or context', () => {
  const entries = [
    logImprovement('error', 'DB_PASS=hunter2x', 'fetch failed: {"password":"hunter22x","api_key":"abcd1234efgh"}', { password: 'tiny', nested: { pwd: 'short' } }),
    logImprovement('idea', 'redis://:hunter2@localhost', 'password is short', { text: 'context-secret' }),
    logImprovement('friction', 'private-source', 'private-message', 'private-context'),
    logImprovement('secret-in-kind', 'source', 'message', { text: 'oversized-context-secret'.repeat(4000) }),
  ];
  resolveImprovement(entries[0].id);
  const expected = entries.map(({ id, ts, kind }, i) => ({ id, ts, kind: i === 3 ? null : kind, resolved: i === 0 }));
  assert.deepEqual(feedbackBundle().improvements, expected);
  const written = JSON.parse(readFileSync(writeFeedback(HOME), 'utf8'));
  assert.deepEqual(written.improvements, expected);
});

test('feedback removes provider and limit free text and redacts URL userinfo', async () => {
  const { getModels } = await import('../core/models.mjs');
  const { getLimits } = await import('../core/limits.mjs');
  getModels().providers.fixture = { status: 'error', error: 'http://user:pass@localhost:1234' };
  getLimits().providers.fixture = { blocked: true, blockedReason: 'http://user:pass@127.0.0.1', error: 'private' };
  const bundle = feedbackBundle();
  assert.deepEqual(bundle.providers.fixture, { status: 'error', plan: undefined, installed: undefined, loggedIn: undefined });
  assert.deepEqual(bundle.limits.fixture, { blocked: true, windows: [] });
  assert.equal(redact('http://user:pass@localhost:1234'), 'http://***@localhost:1234');
  delete getModels().providers.fixture;
  delete getLimits().providers.fixture;
});
