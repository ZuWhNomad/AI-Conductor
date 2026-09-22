import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { exactModels } = await import('../core/providers/anthropic.mjs');

test('the Claude model list holds exact ids only: aliases become the model they resolve to', () => {
  const sdk = [
    { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001' },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', supportedEffortLevels: ['low', 'high'] }, // already exact: keeps [1m]
    { value: 'mystery' },                                                                                        // unresolvable alias: dropped
  ];
  const api = [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { id: 'claude-opus-5', label: 'Claude Opus 5' }, { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }];
  const list = exactModels(sdk, api);
  assert.deepEqual(list.map((m) => m.id), ['claude-opus-5-5[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1[1m]', 'claude-opus-5-5', 'claude-opus-5']);
  const by = Object.fromEntries(list.map((m) => [m.id, m]));
  assert.equal(by['claude-opus-5-5[1m]'].label, 'Claude Opus 5.5 (1M context)');
  assert.deepEqual(by['claude-sonnet-5'].efforts, ['low', 'medium', 'high'], 'the alias entry keeps the efforts the CLI reports');
  assert.equal(by['claude-fable-5-1[1m]'].label, 'Claude Fable 5.1 (1M context)');
  assert.ok(list.every((m) => m.provider === 'claude' && m.kind === 'agent' && !('resolved' in m)));
});
