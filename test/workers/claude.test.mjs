import '../_env.mjs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sdkUrl = 'data:text/javascript,' + encodeURIComponent(`
  export function query(opts) {
    globalThis.__claudeQueryOpts = opts;
    return (async function* () {
      for (const m of globalThis.__claudeMessages || []) yield m;
    })();
  }
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: sdkUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { runClaude } = await import('../../core/workers/claude.mjs');

test('rate_limit_event with isUsingOverage does not set limitHit; rejected only marks a failed run', async () => {
  globalThis.__claudeMessages = [
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', isUsingOverage: true } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0 },
  ];
  const overage = await runClaude({ id: 't', cwd: process.cwd(), prompt: 'x' });
  assert.equal(overage.ok, true, overage.error);
  assert.equal(overage.limitHit, false);

  globalThis.__claudeMessages = [
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0 },
  ];
  const okRejected = await runClaude({ id: 't', cwd: process.cwd(), prompt: 'x' });
  assert.equal(okRejected.ok, true, okRejected.error);
  assert.equal(okRejected.limitHit, false);

  globalThis.__claudeMessages = [
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
    { type: 'result', subtype: 'error', is_error: true, result: 'rate limited', errors: ['rate limited'] },
  ];
  const failed = await runClaude({ id: 't', cwd: process.cwd(), prompt: 'x' });
  assert.equal(failed.ok, false);
  assert.equal(failed.limitHit, true);
});

test('read-only sandbox maps to Claude disallowedTools for write/edit/Bash', async () => {
  globalThis.__claudeMessages = [
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0 },
  ];
  await runClaude({ id: 't', cwd: process.cwd(), prompt: 'x', sandbox: 'read-only' });
  const tools = globalThis.__claudeQueryOpts.options.disallowedTools;
  assert.ok(tools.includes('Bash') && tools.includes('Edit') && tools.includes('Write'));
  globalThis.__claudeMessages = [
    { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0 },
  ];
  await runClaude({ id: 't', cwd: process.cwd(), prompt: 'x' });
  assert.equal(globalThis.__claudeQueryOpts.options.disallowedTools, undefined);
});
