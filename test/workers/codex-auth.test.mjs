import { tmpDir } from '../_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

process.env.CONDUCTOR_CODEX = process.execPath; // spawn is replaced below; never a real codex
const previousHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = tmpDir('codex-home'); // rollout fixtures live here
after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; });
const realSpawn = childProcess.spawn;
const { runCodex, codexFailure, rolloutErrorInfo } = await import('../../core/workers/codex.mjs');
const { runWorker } = await import('../../core/workers/index.mjs');

// Recorded 2026-09-25 22:41Z (codex-cli 0.153.4, task jwyfr36e): turn.failed.error.message. OpenAI echoes the masked key.
const ECHO = 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac****************************fvMA. You can find your API key at https://platform.openai.com/account/api-keys., url: https://chatgpt.com/backend-api/codex/responses, cf-ray: a40d88db280c6aef-YYC, request id: f8a15828-f722-4fbe-baea-d6ca09ed7920';
// Recorded rollout lines (~/.codex/sessions/…/rollout-…-<thread>.jsonl): the structured codex_error_info of a failed turn.
const TASK_COMPLETE = {
  unauthorized: { message: 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.', codex_error_info: 'unauthorized' },   // 2026-09-25 22:42Z
  usage: { message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 6th, 2026 3:40 AM.", codex_error_info: 'usage_limit_exceeded' }, // 2026-09-06 04:51Z
  other401: { message: ECHO, codex_error_info: 'other' },                                                                                                                                         // 2026-09-25 22:41Z
};
let threadSeq = 0;
function rollout(error) {
  const ms = Date.now();
  const id = `${ms.toString(16).padStart(12, '0').replace(/^(.{8})(.{4})$/, '$1-$2')}-7000-8000-${String(++threadSeq).padStart(12, '0')}`;
  const d = new Date(ms), pad = (n) => String(n).padStart(2, '0');
  const dir = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-09-25T16-33-11-${id}.jsonl`), [
    { timestamp: d.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null } },
    { timestamp: d.toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', last_agent_message: null, error } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return id;
}
const fakeCodex = (lines, code = 1) => `for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l); process.exitCode = ${code};`;
function withFakeCodex(ctx, lines, code) {
  ctx.mock.method(childProcess, 'spawn', (_cmd, _args, opts) => realSpawn(process.execPath, ['-e', fakeCodex(lines, code)], { ...opts, shell: false }));
  syncBuiltinESMExports();
  ctx.after(() => { ctx.mock.restoreAll(); syncBuiltinESMExports(); });
}
const failed = (threadId, message) => [...(threadId ? [{ type: 'thread.started', thread_id: threadId }] : []), { type: 'turn.failed', error: { message } }];

test('codexFailure is decided by structured signals only', () => {
  assert.equal(codexFailure({ info: 'usage_limit_exceeded' }), 'limit');
  assert.equal(codexFailure({ info: 'unauthorized' }), 'auth');
  assert.equal(codexFailure({ message: ECHO, info: 'other' }), 'auth');
  assert.equal(codexFailure({ message: 'unexpected status 429 Too Many Requests: slow down' }), 'limit');
  assert.equal(codexFailure({ message: 'unexpected status 403 Forbidden' }), 'auth');
  assert.equal(codexFailure({ message: '{"status":429,"error":{"message":"You have hit your usage limit"}}' }), 'limit');
  assert.equal(codexFailure({ info: { http_connection_failed: { http_status_code: 429 } } }), 'limit');
  // No structured signal: no keyword guessing, whatever the text says.
  for (const message of ["You've hit your usage limit.", 'not logged in', 'Unauthorized', 'rate limit', 'System.UnauthorizedAccessException: Access to the path is denied.', 'unexpected status 500 Internal Server Error']) assert.equal(codexFailure({ message }), null, message);
  assert.equal(rolloutErrorInfo(rollout(TASK_COMPLETE.usage)), 'usage_limit_exceeded');
  assert.equal(rolloutErrorInfo('not-a-thread'), null);
});

test('Codex 401 (recorded): auth failure, not a limit, not a model fail', async (ctx) => {
  const thread = rollout(TASK_COMPLETE.other401);
  withFakeCodex(ctx, [{ type: 'error', message: 'Falling back from WebSockets to HTTPS transport. stream disconnected before completion: websocket closed by server before response.completed' }, ...failed(thread, ECHO)]);
  const r = await runCodex({ id: 'a1', cwd: tmpDir('codex-auth'), prompt: 'x' });
  assert.deepEqual([r.ok, r.authFailed, r.limitHit], [false, true, false]);
  assert.match(r.error, /codex login/);
});

test('Codex usage limit (recorded rollout usage_limit_exceeded) is a limit hit; a spent refresh token is auth', async (ctx) => {
  withFakeCodex(ctx, failed(rollout(TASK_COMPLETE.usage), TASK_COMPLETE.usage.message));
  const limited = await runCodex({ id: 'a2', cwd: tmpDir('codex-auth'), prompt: 'x' });
  assert.deepEqual([limited.limitHit, limited.authFailed], [true, false]);
  ctx.mock.restoreAll();
  withFakeCodex(ctx, failed(rollout(TASK_COMPLETE.unauthorized), TASK_COMPLETE.unauthorized.message));
  const signedOut = await runCodex({ id: 'a3', cwd: tmpDir('codex-auth'), prompt: 'x' });
  assert.deepEqual([signedOut.limitHit, signedOut.authFailed], [false, true]);
});

test('Codex 429 from the HTTP client prefix is a limit hit; a sandbox access denial is neither', async (ctx) => {
  withFakeCodex(ctx, failed(null, 'unexpected status 429 Too Many Requests: Rate limit reached for requests'));
  assert.equal((await runCodex({ id: 'a4', cwd: tmpDir('codex-auth'), prompt: 'x' })).limitHit, true);
  ctx.mock.restoreAll();
  withFakeCodex(ctx, failed(null, 'System.UnauthorizedAccessException: Access to the path is denied.'));
  const denied = await runCodex({ id: 'a5', cwd: tmpDir('codex-auth'), prompt: 'x' });
  assert.deepEqual([denied.limitHit, denied.authFailed], [false, false]);
});

test('runWorker redacts the echoed key at the source and passes authFailed on', async (ctx) => {
  withFakeCodex(ctx, [{ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: `saw ${ECHO}` } }, { type: 'turn.failed', error: { message: ECHO } }]);
  const r = await runWorker({ id: 'a6', provider: 'codex', cwd: tmpDir('codex-auth'), prompt: 'x' });
  assert.equal(r.authFailed, true);
  assert.doesNotMatch(JSON.stringify(r), /sk-svcac|fvMA/);
  assert.match(r.error, /Incorrect API key provided: \[redacted\]/);
});

test('no session log: the fixed Codex usage-limit sentence is a logged limit hit; other wording is not', async (ctx) => {
  const { readFileSync } = await import('node:fs');
  const { statePath } = await import('../../core/paths.mjs');
  // Recorded turn errors (rollouts 2026-09-06..25); the thread has no rollout file here, so only the fallback can decide.
  const recorded = [TASK_COMPLETE.usage.message, "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at 2:11 AM.", "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 27th, 2026 1:36 PM."];
  for (const [i, message] of recorded.entries()) {
    ctx.mock.restoreAll();
    withFakeCodex(ctx, failed(`01a0dab3-7ff9-7d53-a4f6-00000000000${i}`, message));
    assert.equal((await runCodex({ id: `u${i}`, cwd: tmpDir('codex-auth'), prompt: 'x' })).limitHit, true, message);
  }
  assert.match(readFileSync(statePath('improvements.ndjson'), 'utf8'), /usage limit recognised from the fixed Codex message/);
  for (const message of ['Rate limit reached, usage limit soon', "note: You've hit your usage limit. later"]) {
    ctx.mock.restoreAll();
    withFakeCodex(ctx, failed('01a0dab3-7ff9-7d53-a4f6-000000000009', message));
    assert.equal((await runCodex({ id: 'u9', cwd: tmpDir('codex-auth'), prompt: 'x' })).limitHit, false, message);
  }
});
