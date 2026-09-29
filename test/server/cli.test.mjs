import '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDir } from '../_env.mjs';
import { REPO_ROOT, statePath } from '../../core/paths.mjs';

const runCli = (args, env = {}) => spawnSync(process.execPath, ['bin/conductor.mjs', ...args], {
  cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env },
});

test('help lists stop and stop removes a stale pid file without taskkill', () => {
  const help = runCli(['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /conductor stop/);
  writeFileSync(statePath('server.pid'), JSON.stringify({ pid: 2147483646, port: 9, url: 'http://127.0.0.1:9' }));
  const stop = runCli(['stop']);
  assert.equal(stop.status, 0, stop.stderr + stop.stdout);
  assert.match(stop.stderr + stop.stdout, /stale pid file removed/);
  assert.equal(existsSync(statePath('server.pid')), false);
});

test('openBrowser uses rundll32 FileProtocolHandler on Windows', () => {
  const src = readFileSync(join(REPO_ROOT, 'bin', 'conductor.mjs'), 'utf8');
  assert.match(src, /rundll32.*url\.dll,FileProtocolHandler/);
  assert.doesNotMatch(src, /cmd.*\/c.*start/);
});

test('server stop fallbacks target the server PID without traversing its descendants', () => {
  const cli = readFileSync(join(REPO_ROOT, 'bin', 'conductor.mjs'), 'utf8');
  const launcher = readFileSync(join(REPO_ROOT, 'scripts', 'launcher', 'Conductor.cs'), 'utf8');
  assert.match(cli, /killServerFallback\(info\.pid\)/);
  assert.doesNotMatch(cli, /taskkill[^\r\n]*\/T/i);
  assert.match(launcher, /p\.Kill\(\)/);
  assert.doesNotMatch(launcher, /taskkill[^\r\n]*\/T/i);
});

test('job CLI documents --gpu and passes it to POST /api/jobs', () => {
  const help = runCli(['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /job start \[--cwd DIR\] \[--gpu\]/);
  const src = readFileSync(join(REPO_ROOT, 'bin', 'conductor.mjs'), 'utf8');
  assert.match(src, /gpu:\s*\{\s*type:\s*'boolean'\s*\}/);
  assert.match(src, /call\('POST',\s*'\/api\/jobs',\s*\{\s*command:[\s\S]*?gpu:\s*!!flags\.gpu\s*\}\)/);
});

test('share falls back when Desktop does not exist', () => {
  const home = tmpDir('nodesktop');
  const share = runCli(['share'], { USERPROFILE: home, HOME: home, ONEDRIVE: '' });
  if (share.status !== 0) {
    assert.match(share.stderr, /share needs git|git checkout/, share.stderr + share.stdout);
    return;
  }
  assert.equal(existsSync(join(home, 'Desktop')), false);
  assert.ok(existsSync(join(home, 'Conductor-2.0-share.zip')), share.stdout);
});
