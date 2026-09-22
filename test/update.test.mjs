import { tmpDir } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import fs, { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { runInNewContext } from 'node:vm';
import { findCli } from '../core/proc.mjs';
import { REPO_ROOT } from '../core/paths.mjs';
import { bus } from '../core/bus.mjs';
const { updateStatus, applyUpdate, formatUpdate, npmCommand } = await import('../core/update.mjs');

const git = findCli('git');
const run = (cwd, ...args) => execFileSync(git, args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const setup = () => {
  const origin = tmpDir('origin'); run(origin, 'init', '--quiet', '--bare', '-b', 'main');
  const a = tmpDir('clone-a'); run(a, 'clone', '--quiet', origin, '.');
  for (const d of [a]) { run(d, 'config', 'user.email', 't@example.com'); run(d, 'config', 'user.name', 't'); }
  writeFileSync(join(a, 'f.txt'), '1'); run(a, 'add', '.'); run(a, 'commit', '--quiet', '-m', 'one'); run(a, 'push', '--quiet', '-u', 'origin', 'main');
  const b = tmpDir('clone-b'); run(b, 'clone', '--quiet', origin, '.'); run(b, 'config', 'user.email', 't@example.com'); run(b, 'config', 'user.name', 't');
  return { origin, a, b };
};

for (const [label, npmInstalled, npmError] of [
  ['failed dependency install', false, 'dependency unavailable'],
  ['successful dependency install', true, null],
  ['unchanged lockfile', false, null],
]) test(`update CLI: ${label}`, () => {
  const result = { updated: true, from: 'abc123', to: 'def456', commits: 1, npmInstalled, npmError, restartNeeded: true };
  const child = spawnSync(process.execPath, ['--import', './test/_env.mjs', '--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import { registerHooks, syncBuiltinESMExports } from 'node:module';
    let calls = 0;
    const unexpectedIO = [];
    const rejectIO = () => { unexpectedIO.push('external I/O'); throw new Error('unexpected external I/O'); };
    globalThis.fetch = rejectIO;
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = rejectIO;
    syncBuiltinESMExports();
    globalThis.mockApplyUpdate = () => { calls++; return ${JSON.stringify(result)}; };
    process.on('exit', () => { assert.equal(calls, 1); assert.deepEqual(unexpectedIO, []); });
    registerHooks({ load(url, context, nextLoad) {
      if (url === new URL('./core/update.mjs', import.meta.url).href) return {
        format: 'module', shortCircuit: true,
        source: "export const updateStatus = () => ({ git: true, behind: 1 }); export const formatUpdate = () => '1 update(s) available'; export const applyUpdate = globalThis.mockApplyUpdate;",
      };
      return nextLoad(url, context);
    } });
    // parseArgs skips only argv[0] under --eval.
    process.argv = [process.execPath, 'update'];
    await import('./bin/conductor.mjs');
  `], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, npmError ? 1 : 0, child.stderr || child.stdout);
  if (npmError) {
    assert.match(child.stderr, /Partial update: code updated abc123.*def456/);
    assert.match(child.stderr, /dependency install failed: dependency unavailable/);
    assert.ok(child.stderr.includes(REPO_ROOT), child.stderr);
    assert.match(child.stderr, /npm install/);
    assert.match(child.stderr, /restart only after.*succeeds/i);
    assert.doesNotMatch(child.stdout + child.stderr, /Restart Conductor to run the new version/);
  } else {
    assert.equal(child.stderr, '');
    assert.match(child.stdout, /Updated abc123.*def456 \(1 commit\(s\)\)/);
    assert.match(child.stdout, /Restart Conductor to run the new version/);
    assert.equal(child.stdout.includes('dependencies installed'), npmInstalled);
  }
});

test('update: status counts commits behind the remote and applyUpdate fast-forwards', { skip: !git && 'git not installed' }, () => {
  const { a, b } = setup();
  assert.equal(updateStatus({ cwd: b }).behind, 0);
  writeFileSync(join(a, 'f.txt'), '2'); run(a, 'commit', '--quiet', '-am', 'two'); run(a, 'push', '--quiet');
  const st = updateStatus({ cwd: b });
  assert.equal(st.behind, 1); assert.equal(st.dirty, 0); assert.match(formatUpdate(st), /1 update\(s\) available/);
  const r = applyUpdate({ cwd: b, exec: () => assert.fail('unchanged lockfile must not run npm') });
  assert.equal(r.updated, true); assert.equal(r.commits, 1); assert.equal(r.restartNeeded, true);
  assert.equal(r.npmInstalled, false); assert.equal(r.npmError, null);
  assert.equal(run(b, 'rev-parse', 'HEAD'), run(a, 'rev-parse', 'HEAD'));
  assert.equal(applyUpdate({ cwd: b, npm: false }).updated, false);
});

test('update: refuses over modified TRACKED files or unpushed commits, and explains a non-git folder', { skip: !git && 'git not installed' }, () => {
  const { a, b } = setup();
  writeFileSync(join(a, 'f.txt'), '3'); run(a, 'commit', '--quiet', '-am', 'three'); run(a, 'push', '--quiet');
  writeFileSync(join(b, 'f.txt'), 'edited'); // a modified TRACKED file must block the fast-forward
  assert.throws(() => applyUpdate({ cwd: b, npm: false }), /not committed/);
  run(b, 'checkout', '--', 'f.txt'); // discard the tracked edit
  writeFileSync(join(b, 'local.txt'), 'x'); run(b, 'add', '.'); run(b, 'commit', '--quiet', '-m', 'mine');
  assert.throws(() => applyUpdate({ cwd: b, npm: false }), /push them first/);
  const plain = tmpDir('plain');
  assert.equal(updateStatus({ cwd: plain }).git, false);
  assert.match(formatUpdate(updateStatus({ cwd: plain })), /clone the repo/);
});

test('update: untracked files do NOT block a fast-forward (dirty:0, applyUpdate proceeds)', { skip: !git && 'git not installed' }, () => {
  const { a, b } = setup();
  writeFileSync(join(a, 'f.txt'), '4'); run(a, 'commit', '--quiet', '-am', 'four'); run(a, 'push', '--quiet');
  // b has untracked files present (the real-world case: logs, local notes, docs/plans/*.md) — these must not gate the pull
  writeFileSync(join(b, 'note.md'), 'local note'); writeFileSync(join(b, 'scratch.log'), 'x');
  const st = updateStatus({ cwd: b });
  assert.equal(st.dirty, 0);           // gate value ignores untracked
  assert.equal(st.untracked, 2);       // still reported, informationally
  assert.equal(st.behind, 1);
  assert.match(formatUpdate(st), /2 untracked/);
  const r = applyUpdate({ cwd: b, npm: false }); // proceeds despite the untracked files
  assert.equal(r.updated, true); assert.equal(r.commits, 1);
  assert.equal(run(b, 'rev-parse', 'HEAD'), run(a, 'rev-parse', 'HEAD'));
  assert.equal(run(b, 'status', '--porcelain'), '?? note.md\n?? scratch.log'); // untracked files survived the pull
});

const bundledNpm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
test('update: bundled npm runs through Node without a shell', { skip: !existsSync(bundledNpm) && 'no npm bundled beside Node' }, () => {
  const n = npmCommand();
  assert.deepEqual(n, { command: process.execPath, args: [bundledNpm], shell: false });
  const version = execFileSync(n.command, [...n.args, '--version'], { encoding: 'utf8', windowsHide: true, shell: n.shell }).trim();
  assert.equal(version, JSON.parse(readFileSync(join(dirname(bundledNpm), '..', 'package.json'), 'utf8')).version);
});

test('update: a lockfile change runs npm through the injected exec; a failing install is reported, never thrown', { skip: !git && 'git not installed' }, () => {
  const { a, b } = setup();
  writeFileSync(join(a, 'package-lock.json'), '{"v":1}'); run(a, 'add', '.'); run(a, 'commit', '--quiet', '-m', 'lock'); run(a, 'push', '--quiet');
  const calls = [];
  const r = applyUpdate({ cwd: b, exec: (cmd, args, opts) => { calls.push({ cmd, args, opts }); } });
  assert.equal(r.updated, true); assert.equal(r.npmInstalled, true); assert.equal(r.npmError, null);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].args.slice(-3), ['install', '--no-fund', '--no-audit']); assert.equal(calls[0].opts.cwd, b);
  if (existsSync(bundledNpm)) {
    assert.equal(calls[0].cmd, process.execPath); assert.equal(calls[0].args[0], bundledNpm); assert.equal(calls[0].opts.shell, false);
  }
  writeFileSync(join(a, 'package-lock.json'), '{"v":2}'); run(a, 'commit', '--quiet', '-am', 'lock2'); run(a, 'push', '--quiet');
  const bad = applyUpdate({ cwd: b, exec: () => { throw new Error('spawn npm.cmd EINVAL'); } });
  assert.equal(bad.updated, true); assert.equal(bad.npmInstalled, false); assert.match(bad.npmError, /EINVAL/);
  assert.equal(run(b, 'rev-parse', 'HEAD'), run(a, 'rev-parse', 'HEAD')); // HEAD moved anyway: the caller must not restart blindly
});

test('update: failed npm install reaches the HTTP response and UI without relaunching', { skip: !git && 'git not installed' }, async (ctx) => {
  const { a, b } = setup();
  writeFileSync(join(a, 'package-lock.json'), '{"v":1}'); run(a, 'add', '.'); run(a, 'commit', '--quiet', '-m', 'lock'); run(a, 'push', '--quiet');
  const { startServer, stopBackgroundWork } = await import('../server/index.mjs');
  const { server, url } = await startServer({ port: 0 });
  const exec = childProcess.execFileSync, read = fs.readFileSync;
  const seq = bus.seq;
  // Exercise the real route and updater, redirecting checkout reads/git to the temporary clone only.
  ctx.mock.method(fs, 'readFileSync', (file, ...args) => read(file === join(REPO_ROOT, 'package-lock.json') ? join(b, 'package-lock.json') : file, ...args));
  const npmCalls = [];
  ctx.mock.method(childProcess, 'execFileSync', (cmd, args, opts) => {
    if (cmd === git) return exec(cmd, args, { ...opts, cwd: opts.cwd === REPO_ROOT ? b : opts.cwd });
    npmCalls.push({ cmd, args });
    throw new Error('npm install failed: dependency unavailable');
  });
  const spawn = ctx.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected relaunch'); });
  syncBuiltinESMExports();
  try {
    const response = await fetch(url + '/api/update', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    const r = await response.json();
    assert.equal(r.updated, true); assert.equal(r.npmInstalled, false); assert.match(r.npmError, /dependency unavailable/);
    assert.equal(r.relaunching, false); assert.equal(spawn.mock.callCount(), 0);
    assert.equal(npmCalls.length, 1); assert.deepEqual(npmCalls[0].args.slice(-3), ['install', '--no-fund', '--no-audit']);
    assert.equal(run(b, 'rev-parse', 'HEAD'), run(a, 'rev-parse', 'HEAD'));
    const event = bus.since(seq).find((e) => e.type === 'update');
    assert.equal(event.updated, true); assert.equal(event.npmInstalled, false); assert.equal(event.npmError, r.npmError);

    // Run the browser's update handlers with a minimal DOM; both SSE and the response use noteUpdate.
    const source = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
    const button = { hidden: false, classList: { remove() {} } }, lines = [];
    const ui = { S: {}, $: () => button, addSys: (text, cls) => { const line = { textContent: text, className: 'sysline ' + cls, isConnected: true }; lines.push(line); return line; } };
    runInNewContext(source.slice(source.indexOf('// ---------- update affordance ----------'), source.indexOf('// ---------- SSE ----------')), ui);
    ui.noteUpdate(event);
    assert.match(lines[0].textContent, /run "npm install" in the Conductor folder, then restart/);
    ui.noteUpdate(r);
    assert.equal(lines.length, 1); assert.equal(lines[0].className, 'sysline warn');
    assert.match(lines[0].textContent, /dependency unavailable/);
    assert.equal(button.hidden, true);
  } finally {
    ctx.mock.restoreAll(); syncBuiltinESMExports();
    stopBackgroundWork();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
