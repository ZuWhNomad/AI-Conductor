import { HOME } from '../_env.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJson } from '../../core/paths.ts';

export { HOME, join, readJson };

export const {
  noteHttp, noteLimitAvailable, noteLimitHit, noteRateLimitEvent, blockedUntil, getLimits, groupOf, mergePoll,
  modelBlock, modelBlockedUntil, providerWindows, windowModels,
} = await import('../../core/limits.mjs');
export const { normalizeUsage, windowFromEvent, familyRe } = await import('../../core/providers/anthropic.mjs');
export const { PROVIDERS } = await import('../../core/providers/index.mjs');

export function assertStoredEvent(actual, info, scope) {
  const { scope: actualScope, ...window } = actual;
  assert.deepEqual(window, windowFromEvent(info));
  assert.equal(actualScope, scope);
}
