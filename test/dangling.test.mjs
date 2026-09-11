import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { closeDanglingToolCalls } = await import('../core/workers/openai-compat.mjs');

test('an interrupted tool-call turn is closed so strict APIs accept the replayed history', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'run', arguments: '{}' } }, { id: 'b', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'ok' },
  ];
  closeDanglingToolCalls(messages, 'not executed: aborted');
  assert.equal(messages.length, 5);
  assert.deepEqual(messages[4], { role: 'tool', tool_call_id: 'b', content: 'not executed: aborted' });
  closeDanglingToolCalls(messages); // idempotent
  assert.equal(messages.length, 5);
  const clean = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  closeDanglingToolCalls(clean);
  assert.equal(clean.length, 2);
});
