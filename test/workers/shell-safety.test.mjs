// Regressions for the 2026-09-13 Astra review: the Windows .cmd shell path and the worker.shell allow-list must
// not let an argument or a chained operator become a second host command.
import { tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { DEFAULTS, loadConfig, saveConfig } from '../../core/config.mjs';
import { resolveNpmShim, winArgEscape, spawnCli } from '../../core/proc.mjs';
import { shellDenied, runDescription, runEnv, runOpenAICompat } from '../../core/workers/openai-compat.mjs';

const WIN = process.platform === 'win32';

function requestCommands(ctx, commands) {
  let n = 0;
  ctx.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: ++n === 1
    ? { role: 'assistant', tool_calls: commands.map((command, i) => ({ id: 'c' + i, function: { name: 'run', arguments: JSON.stringify({ command }) } })) }
    : { role: 'assistant', content: 'done' } }] }));
}

test('S2: default worker config denies interpreter and package-manager execution without spawning', async (ctx) => {
  assert.equal(DEFAULTS.worker.shell, false);
  assert.equal(loadConfig().worker.shell, false);
  requestCommands(ctx, ['node --version', 'python --version', 'npm --version']);
  const spawn = ctx.mock.method(childProcess, 'spawn', () => { throw new Error('must not spawn'); });
  syncBuiltinESMExports();
  try {
    const r = await runOpenAICompat({ cwd: tmpDir('shell-default'), baseUrl: 'http://unused.test', model: 'test', prompt: 'x' });
    assert.equal(r.ok, true);
    const results = r.messages.filter((m) => m.role === 'tool');
    assert.equal(results.length, 3);
    for (const result of results) assert.match(result.content, /^run disabled:/);
    assert.equal(spawn.mock.callCount(), 0);
  } finally { spawn.mock.restore(); syncBuiltinESMExports(); }
});

for (const shell of [true, ['node']]) test(`S2: explicit worker.shell ${JSON.stringify(shell)} preserves host execution`, async (ctx) => {
  const previous = loadConfig().worker.shell;
  saveConfig({ worker: { shell } });
  requestCommands(ctx, ['node --version']);
  const spawn = ctx.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    queueMicrotask(() => { child.stdout.emit('data', 'stub process output'); child.emit('close', 0); });
    return child;
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(loadConfig().worker.shell, shell);
    const r = await runOpenAICompat({ cwd: tmpDir('shell-opt-in'), baseUrl: 'http://unused.test', model: 'test', prompt: 'x' });
    assert.equal(r.ok, true);
    assert.equal(r.messages.find((m) => m.role === 'tool').content, 'exit 0\nstub process output');
    assert.equal(spawn.mock.callCount(), 1);
    assert.equal(spawn.mock.calls[0].arguments[0], 'node --version');
    assert.equal(spawn.mock.calls[0].arguments[1].shell, true);
    assert.equal(spawn.mock.calls[0].arguments[1].env.NoDefaultCurrentDirectoryInExePath, '1');
  } finally { saveConfig({ worker: { shell: previous } }); spawn.mock.restore(); syncBuiltinESMExports(); }
});

test('worker.shell allow-list blocks operators, chaining and prefix bypasses', () => {
  const AL = ['git', 'python', 'node'];
  assert.equal(shellDenied(true, 'anything & rm -rf /'), null);            // true = unrestricted
  assert.match(shellDenied(false, 'git status'), /disabled/);              // false = off
  assert.equal(shellDenied(AL, 'git status'), null);                        // listed, simple
  assert.equal(shellDenied(AL, 'python verify.py out/x.stl'), null);
  assert.match(shellDenied(AL, 'git --version & echo BYPASS'), /operators/);// & chaining
  assert.match(shellDenied(AL, 'git log | grep x'), /operators/);           // pipe
  assert.match(shellDenied(AL, 'node x && rm -rf /'), /operators/);         // &&
  assert.match(shellDenied(AL, 'git x > /dev/null'), /operators/);          // redirect
  assert.match(shellDenied(AL, 'C:/tmp/git-unlisted.cmd'), /not a path/);   // path-qualified, even if basename looks listed
  assert.match(shellDenied(AL, 'gitfoo --x'), /not in/);
});

test('P43: allow-list documents and refuses quoted operators and recorded quote/escape bypasses', () => {
  assert.match(runDescription(['git']), /operators are rejected even inside quotes/);
  for (const command of [
    'git commit -m "a; b"',                         // intentionally refused quoted literal
    'git log --format="%h|%s"',                    // intentionally refused quoted literal
    `git '"' | evil '"'`,                          // POSIX: single-quoted quote leaves a real pipe
    String.raw`git \"a | evil "#"`,                // POSIX: escaped opening quote
    'git ^"a | evil "',                            // cmd.exe: caret-escaped opening quote
  ]) assert.match(shellDenied(['git'], command), /operators .*are rejected even inside quotes/, command);
});

test('D9: allow-list rejects a path or dot-prefixed first token; a bare git is allowed', () => {
  const AL = ['git'];
  assert.match(shellDenied(AL, 'tools\\git.cmd status'), /not a path/);
  assert.match(shellDenied(AL, '.\\git status'), /not a path/);
  assert.match(shellDenied(AL, './git status'), /not a path/);
  assert.equal(shellDenied(AL, 'git status'), null);
});

test('OS2: allow_command refuses interpreters and script hosts, case-insensitive, extension-stripped', async () => {
  const { conductorToolDefs } = await import('../../core/tools.mjs');
  const previous = loadConfig().worker.shell;
  saveConfig({ worker: { shell: ['git'] } });
  try {
    const allow = conductorToolDefs({ sessionId: 'os2', cwd: tmpDir('os2') }).find((d) => d.name === 'allow_command').handler;
    for (const command of ['python', 'python3', 'py', 'PYTHON.EXE', 'node', 'node.cmd', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua', 'cscript', 'wscript', 'mshta', 'rundll32', 'regsvr32', 'npx', 'uvx', 'pipx']) {
      const msg = await allow({ command });
      assert.match(msg, /refused: .*shell, interpreter, or script host/, command);
    }
    const ok = await allow({ command: 'openscad' });
    assert.match(ok, /Added "openscad"/);
  } finally { saveConfig({ worker: { shell: previous } }); }
});

test('D9: runEnv sets NoDefaultCurrentDirectoryInExePath so a cwd shim cannot shadow a bare name', () => {
  const env = runEnv({ PATH: 'C:\\Windows', OTHER: 'keep' });
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, '1');
  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.OTHER, 'keep');
});

test('winArgEscape wraps and caret-escapes cmd metacharacters', () => {
  assert.equal(winArgEscape('plain'), '^"plain^"');
  const e = winArgEscape('a&b|c>d');
  assert.ok(e.startsWith('^"') && e.endsWith('^"'));
  for (const m of ['&', '|', '>']) assert.ok(e.includes(`^${m}`), `metachar ${m} caret-escaped`);
});

test('resolveNpmShim + spawnCli deliver a malicious argument verbatim, no injection', { skip: !WIN }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  mkdirSync(join(dir, 'node_modules', 'tool', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'tool', 'dist', 'cli.js'), 'for (const a of process.argv.slice(2)) console.log("ARGV="+JSON.stringify(a));');
  const shim = join(dir, 'tool.cmd');
  writeFileSync(shim, ['@ECHO off', 'SETLOCAL', `"${join('%~dp0', 'node.exe')}" "${join('%~dp0', 'node_modules', 'tool', 'dist', 'cli.js')}" %*`, ''].join('\r\n'));
  assert.ok(resolveNpmShim(shim), 'shim unwraps to its node entry');
  const evil = ['literal&echo PWNED', 'b|whoami', 'c">nul&calc'];
  const out = await new Promise((res) => { let s = ''; const c = spawnCli(shim, evil, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); c.stdout.on('data', (d) => s += d); c.stderr.on('data', (d) => s += d); c.on('close', () => res(s)); });
  const argvs = [...out.matchAll(/ARGV=(.+)/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(argvs, evil, 'every arg reaches the program exactly as sent');
  assert.ok(!/PWNED/.test(out.replace(/ARGV=.*/g, '')), 'no injected command output');
});
