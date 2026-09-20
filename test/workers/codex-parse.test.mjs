import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../_env.mjs';

const { applyCodexEvent, summarizeItem } = await import('../../core/workers/codex.mjs');

// Real events captured from `codex exec --json` (codex-cli 0.153.4).
const EVENTS = [
  { type: 'thread.started', thread_id: '01a07e0a-5969-7373-b10d-a9788db15d94' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I will create add.js.' } },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'powershell -Command ...', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'powershell -Command ...', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'add.js', kind: 'add' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Created add.js.' } },
  { type: 'turn.completed', usage: { input_tokens: 53340, cached_input_tokens: 48128, output_tokens: 227 } },
];

test('codex JSONL folds into thread, final message, items and usage', () => {
  const res = { threadId: null, finalMessage: '', error: null, limitHit: false, usage: null };
  const items = new Map(); const seen = [];
  for (const ev of EVENTS) applyCodexEvent(ev, res, items, (e) => seen.push(e));
  assert.equal(res.threadId, '01a07e0a-5969-7373-b10d-a9788db15d94');
  assert.equal(res.finalMessage, 'Created add.js.');
  assert.equal(res.usage.output_tokens, 227);
  assert.equal(items.size, 4);
  assert.equal(items.get('item_1').exit_code, 0);
  assert.deepEqual(summarizeItem(items.get('item_2')).changes, [{ path: 'add.js', kind: 'add' }]);
  assert.ok(seen.includes('thread') && seen.includes('turn.completed'));
});

test('limit and failure events are classified', () => {
  const res = { threadId: null, finalMessage: '', error: null, limitHit: false, usage: null };
  applyCodexEvent({ type: 'turn.failed', error: { message: '{"status":429,"error":{"message":"You have hit your usage limit"}}' } }, res, new Map());
  assert.equal(res.limitHit, true);
  assert.match(res.error, /usage limit/);
  const res2 = { threadId: null, finalMessage: '', error: null, limitHit: false, usage: null };
  applyCodexEvent({ type: 'item.completed', item: { id: 'e', type: 'error', message: 'Model metadata not found' } }, res2, new Map());
  assert.equal(res2.limitHit, false);
  assert.equal(res2.error, 'Model metadata not found');
});
