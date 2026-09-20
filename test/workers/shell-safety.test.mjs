// Regressions for the 2026-09-13 Astra review: the Windows .cmd shell path and the worker.shell allow-list must
// not let an argument or a chained operator become a second host command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import '../_env.mjs';
import { resolveNpmShim, winArgEscape, spawnCli } from '../../core/proc.mjs';
import { shellDenied } from '../../core/workers/openai-compat.mjs';

const WIN = process.platform === 'win32';

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
  assert.match(shellDenied(AL, 'C:/tmp/git-unlisted.cmd'), /not in/);       // exact basename, not a prefix of "git"
  assert.match(shellDenied(AL, 'gitfoo --x'), /not in/);
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
