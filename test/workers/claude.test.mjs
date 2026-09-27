import '../_env.mjs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const sdkUrl = 'data:text/javascript,' + encodeURIComponent(`
  export function query(opts) {
    globalThis.__claudeQueryOpts = opts;
    return (async function* () {
      if (globalThis.__claudeThrow) throw new Error(globalThis.__claudeThrow);
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

const { runClaude, killByNameDenied, writeOutsideDenied, workerHooks } = await import('../../core/workers/claude.mjs');
const { getModels, findModel } = await import('../../core/models.mjs');

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

test('SDK version-required errors mark the Claude model unavailable and return an environment failure', async () => {
  const model = 'claude-opus-version-test';
  getModels().models.push({ provider: 'claude', id: model, kind: 'agent' });
  globalThis.__claudeThrow = 'Claude Code version 1.2.3 or newer is required to use this model';
  try {
    const result = await runClaude({ id: 'version-required', provider: 'claude', model, cwd: process.cwd(), prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.envFailed, true);
    assert.equal(findModel('claude', model), null);
  } finally { globalThis.__claudeThrow = null; }
});

test('kill guard: process kills by name or image are denied, kills by PID are not', async () => {
  for (const cmd of [
    'taskkill //F //IM node.exe', 'taskkill /F /IM node.exe', 'taskkill -f -im node.exe', 'TASKKILL.EXE /im node.exe /t',
    'cd x && taskkill /F /IM node.exe', 'cmd /c "taskkill /F /FI \\"IMAGENAME eq node.exe\\""',
    'Stop-Process -Name node -Force', 'Get-Process node | Stop-Process -Force', 'gps node* | kill', 'kill -Name node',
    'pkill node', 'pkill -f server.mjs', 'killall node', 'sleep 1; killall -9 node', 'wmic process where name="node.exe" delete',
  ]) assert.ok(killByNameDenied(cmd), cmd);
  for (const cmd of [
    'taskkill /PID 1234 /T /F', 'taskkill //F //PID 1234', 'Stop-Process -Id 1234', 'kill 1234', 'kill -9 $PID',
    'Get-Process -Id 1234 | Stop-Process', 'Get-Process node', 'npm test', 'git log --grep killall-bug', undefined,
  ]) assert.equal(killByNameDenied(cmd), null, String(cmd));

  globalThis.__claudeMessages = [{ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0 }];
  await runClaude({ id: 't', cwd: process.cwd(), prompt: 'x' });
  const hook = globalThis.__claudeQueryOpts.options.hooks.PreToolUse[0].hooks[0];
  for (const tool_name of ['Bash', 'PowerShell', 'Monitor']) {
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command: 'taskkill //F //IM node.exe' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', tool_name);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /PID/);
  }
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'taskkill /PID 42 /F' } }), {});
  assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } }), {});
});

test('Claude worker write guard confines writes to task, writable roots, and tmpdir', async () => {
  const cwd = process.cwd();
  const roots = [cwd, path.join(cwd, 'writable-root'), os.tmpdir()];
  assert.equal(writeOutsideDenied('Write', { file_path: path.join(cwd, 'inside.txt') }, roots), null);
  assert.equal(writeOutsideDenied('Write', { file_path: path.join(cwd, '..cache', 'x') }, roots), null);
  assert.equal(writeOutsideDenied('Edit', { file_path: 'inside.txt' }, roots), null);
  assert.match(writeOutsideDenied('Write', { file_path: path.resolve(cwd, '..', 'outside.txt') }, roots), /outside this task's folder/);
  assert.match(writeOutsideDenied('Write', { file_path: `${cwd}-sibling/file.txt` }, roots), /outside this task's folder/);
  assert.equal(writeOutsideDenied('MultiEdit', { file_path: path.join(roots[1], 'file.txt') }, roots), null);
  assert.equal(writeOutsideDenied('NotebookEdit', { notebook_path: path.join(os.tmpdir(), 'file.ipynb') }, roots), null);
  assert.equal(writeOutsideDenied('Read', { file_path: path.resolve(cwd, '..', 'read.txt') }, roots), null);
  assert.equal(writeOutsideDenied('Bash', { command: 'touch outside.txt' }, roots), null);
  assert.equal(writeOutsideDenied('Write', { file_path: '' }, roots), null);

  const differentlyCased = path.join(cwd.toUpperCase(), 'inside.txt');
  const caseResult = writeOutsideDenied('Write', { file_path: differentlyCased }, [cwd]);
  if (process.platform === 'win32') assert.equal(caseResult, null);
  else assert.match(caseResult, /outside this task's folder/);
});

test('worker hook denies outside writes and allows inside writes', async () => {
  const cwd = process.cwd();
  const hook = workerHooks({ cwd }).PreToolUse[0].hooks[0];
  const denied = await hook({ tool_name: 'Write', tool_input: { file_path: path.resolve(cwd, '..', 'outside.txt') } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /outside this task's folder/);
  assert.deepEqual(await hook({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'inside.txt') } }), {});
});
