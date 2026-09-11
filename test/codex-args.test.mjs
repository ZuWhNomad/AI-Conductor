import { tmpDir } from './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

const previous = process.env.CONDUCTOR_CODEX;
process.env.CONDUCTOR_CODEX = process.platform === 'win32' ? 'C:\\definitely\\missing\\codex.exe' : '/definitely/missing/codex';
after(() => { if (previous === undefined) delete process.env.CONDUCTOR_CODEX; else process.env.CONDUCTOR_CODEX = previous; });
const { runCodex } = await import('../core/workers/codex.mjs');
const { runClaude } = await import('../core/workers/claude.mjs');
const { assertShellSafe, codexCommand } = await import('../core/proc.mjs');
const cwd = tmpDir('codex-args');

test('invalid Codex model and effort are rejected before spawning', async () => {
  for (const selection of [{ model: 'bad"model' }, { model: 'gpt-6-astra', effort: 'lo w' }, { effort: 'low"\nsandbox_mode="danger-full-access' }]) {
    const r = await runCodex({ cwd, prompt: 'x', ...selection });
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid/);
  }
});

test('already-aborted workers return without spawning', async () => {
  const ac = new AbortController(); ac.abort();
  for (const run of [runCodex, runClaude]) {
    const r = await run({ cwd, prompt: 'x', signal: ac.signal });
    assert.equal(r.ok, false);
    assert.match(r.error, /aborted/);
  }
});

test('cmd shim guard rejects shell metacharacters', () => {
  assert.throws(() => assertShellSafe(['-c', 'a="b"']), /unsafe argument/);
  for (const char of ['\r', '\n', '&', '|', '<', '>', '^', '%', '!']) assert.throws(() => assertShellSafe([`a${char}b`]), /unsafe argument/);
  assert.doesNotThrow(() => assertShellSafe(['exec', '-']));
});

test('app-server spawn failures reject without unhandled error events', async () => {
  const { withAppServer } = await import('../core/providers/codex.mjs');
  await assert.rejects(withAppServer(() => assert.fail('must not connect')), /ENOENT|spawn/i);
});

test('Windows detects the newest desktop-bundled Codex CLI after PATH and npm', { skip: process.platform !== 'win32' }, () => {
  const saved = Object.fromEntries(['PATH', 'APPDATA', 'LOCALAPPDATA', 'CONDUCTOR_CODEX'].map((k) => [k, process.env[k]]));
  const local = tmpDir('codex-app');
  try {
    process.env.PATH = ''; process.env.APPDATA = local; process.env.LOCALAPPDATA = local;
    delete process.env.CONDUCTOR_CODEX;
    const exes = ['older', 'newer'].map((name) => join(local, 'OpenAI', 'Codex', 'bin', name, 'codex.exe'));
    for (const [i, exe] of exes.entries()) {
      mkdirSync(join(exe, '..'), { recursive: true }); writeFileSync(exe, '');
      const date = new Date(Date.now() - (2 - i) * 60_000); utimesSync(exe, date, date);
    }
    assert.deepEqual(codexCommand(), { command: exes[1], args: [] });
    process.env.CONDUCTOR_CODEX = exes[0];
    assert.deepEqual(codexCommand(), { command: exes[0], args: [] });
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
