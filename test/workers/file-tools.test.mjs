import { tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getEventListeners, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative, sep } from 'node:path';
import threads from 'node:worker_threads';
import { loadConfig } from '../../core/config.mjs';
import { runOpenAICompat } from '../../core/workers/openai-compat.mjs';

function requestTools(ctx, cwd, calls, options = {}) {
  let sent = false;
  ctx.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: sent
    ? { role: 'assistant', content: 'done' }
    : (sent = true, { role: 'assistant', tool_calls: calls.map(([name, args], i) => ({ id: `c${i}`, function: { name, arguments: JSON.stringify(args) } })) }) }] }));
  return runOpenAICompat({ cwd, prompt: 'x', baseUrl: 'http://unused.test', model: 'test', sandbox: 'read-only', ...options });
}

const outputs = (result) => result.messages.filter((m) => m.role === 'tool').map((m) => m.content);

function forbidSyncWorkspaceIO(ctx, cwd) {
  const spies = ['readFileSync', 'readdirSync', 'realpathSync', 'lstatSync', 'statSync'].map((name) => {
    const original = fs[name];
    return ctx.mock.method(fs, name, (path, ...args) => {
      assert.ok(path !== cwd && !String(path).startsWith(cwd + sep), `synchronous ${name} in the tool loop`);
      return original(path, ...args);
    });
  });
  syncBuiltinESMExports();
  ctx.after(() => { spies.forEach((spy) => spy.mock.restore()); syncBuiltinESMExports(); });
}

function trackWorkers(ctx, prepare = (options) => options) {
  const OriginalWorker = threads.Worker; const records = [];
  const spy = ctx.mock.method(threads, 'Worker', function (url, options) {
    const worker = new OriginalWorker(url, prepare(options));
    const record = { worker, exited: false, terminate: ctx.mock.method(worker, 'terminate') };
    worker.once('exit', () => { record.exited = true; });
    records.push(record);
    return worker;
  });
  syncBuiltinESMExports();
  ctx.after(async () => {
    for (const { worker } of records) await worker.terminate();
    spy.mock.restore(); syncBuiltinESMExports();
  });
  return records;
}

function assertStopped(records) {
  assert.ok(records.length);
  for (const { worker, exited, terminate } of records) {
    assert.equal(exited, true, 'worker exits before the tool settles');
    assert.equal(worker.threadId, -1);
    assert.equal(terminate.mock.callCount(), 1);
    for (const event of ['message', 'error', 'exit']) assert.equal(worker.listenerCount(event), 0);
  }
}

test('P01: read_file bounds async reads by the 60k UTF-16 contract, preserving Unicode and closing handles', async (ctx) => {
  const cwd = tmpDir('file-prefix');
  const contents = [
    Buffer.alloc(60000 * 3 + 1, 'a'),
    Buffer.from('\u20ac'.repeat(60000) + 'tail'),
    Buffer.from('a'.repeat(59999) + '\u{1f642}tail'),
    Buffer.from([0x61, 0xe2, 0x82]), // incomplete UTF-8 at EOF keeps Node's replacement behaviour
    Buffer.alloc(0),
  ];
  contents.forEach((content, i) => fs.writeFileSync(join(cwd, `${i}.txt`), content));
  fs.writeFileSync(join(cwd, 'failure.txt'), 'read will fail');
  const opened = []; const originalOpen = fsp.open;
  ctx.mock.method(fsp, 'open', async (path, flags) => {
    const handle = await originalOpen(path, flags);
    const record = { path, bytes: 0, closed: false }; opened.push(record);
    return {
      async read(buffer, offset, length, position) {
        assert.equal(buffer.length, 60000 * 3, 'UTF-8 needs at most three bytes per UTF-16 unit');
        assert.ok(position + length <= buffer.length);
        if (path.endsWith('failure.txt')) throw new Error('read failure fixture');
        // Force short reads so the bounded reader must advance its offset correctly.
        const result = await handle.read(buffer, offset, Math.ceil(length / 2), position);
        record.bytes += result.bytesRead;
        return result;
      },
      async close() { await handle.close(); record.closed = true; },
    };
  });
  syncBuiltinESMExports();
  forbidSyncWorkspaceIO(ctx, cwd);
  const result = await requestTools(ctx, cwd, [
    ...contents.map((_, i) => ['read_file', { path: `${i}.txt` }]),
    ['read_file', { path: 'failure.txt' }],
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(outputs(result), [...contents.map((b) => b.toString('utf8').slice(0, 60000)), 'error: read failure fixture']);
  assert.equal(opened.length, contents.length + 1);
  opened.forEach((record, i) => {
    assert.equal(record.closed, true);
    if (i < contents.length) assert.equal(record.bytes, Math.min(contents[i].length, 60000 * 3));
  });
});

test('P01: list_dir is async and preserves depth, skipped folders and result formatting', async (ctx) => {
  const cwd = tmpDir('file-list');
  fs.mkdirSync(join(cwd, 'a/b/c'), { recursive: true });
  fs.mkdirSync(join(cwd, 'node_modules'));
  fs.writeFileSync(join(cwd, 'top.txt'), 'top');
  fs.writeFileSync(join(cwd, 'a/b/shown.txt'), 'shown');
  fs.writeFileSync(join(cwd, 'a/b/c/hidden.txt'), 'too deep');
  forbidSyncWorkspaceIO(ctx, cwd);
  const result = await requestTools(ctx, cwd, [['list_dir', {}]]);
  assert.equal(result.ok, true);
  assert.deepEqual(outputs(result)[0].split('\n').sort(), ['a/', join('a', 'b') + '/', join('a', 'b', 'c') + '/', join('a', 'b', 'shown.txt'), 'top.txt'].sort());
});

test('P01: worker search preserves regex results, file/hit bounds and cleanup after success or invalid regex', async (ctx) => {
  const cwd = tmpDir('file-search');
  fs.mkdirSync(join(cwd, 'nested/deeper'), { recursive: true });
  fs.mkdirSync(join(cwd, 'node_modules'));
  fs.writeFileSync(join(cwd, 'nested/deeper/match.txt'), 'nothing\n  needle here  \n');
  fs.writeFileSync(join(cwd, 'node_modules/ignored.txt'), 'needle ignored');
  fs.writeFileSync(join(cwd, 'large.txt'), 'oversized needle'); fs.truncateSync(join(cwd, 'large.txt'), 2e6);
  fs.writeFileSync(join(cwd, 'hits.txt'), Array(201).fill('hit').join('\n'));
  const records = trackWorkers(ctx);
  const ac = new AbortController();
  forbidSyncWorkspaceIO(ctx, cwd);
  const result = await requestTools(ctx, cwd, [
    ['search', { pattern: 'needle' }], ['search', { pattern: '^hit$' }],
    ['search', { pattern: 'oversized' }], ['search', { pattern: '[' }],
  ], { signal: ac.signal });
  assert.equal(result.ok, true);
  const out = outputs(result);
  assert.equal(out[0], `${join('nested', 'deeper', 'match.txt')}:2: needle here`);
  assert.deepEqual(out[1].split('\n'), Array.from({ length: 200 }, (_, i) => `hits.txt:${i + 1}: hit`));
  assert.equal(out[2], '(no matches)');
  assert.match(out[3], /^error: Invalid regular expression/);
  assertStopped(records);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
});

test('P01: asynchronous tools reject lexical escapes before reading or listing outside', async (ctx) => {
  const cwd = tmpDir('file-containment'); const outside = tmpDir('file-outside');
  fs.writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
  const calls = [
    ['read_file', { path: join(outside, 'secret.txt') }],
    ['list_dir', { path: relative(cwd, outside) }],
    ['search', { path: outside, pattern: 'outside-secret' }],
  ];
  const result = await requestTools(ctx, cwd, calls);
  assert.equal(result.ok, true);
  for (const out of outputs(result)) assert.match(out, /^error: path outside project:/);
});

for (const mode of ['task deadline', 'configured fallback', 'cancellation']) {
  test(`P01: pathological regex keeps the main loop responsive and terminates on ${mode}`, async (ctx) => {
    const cwd = tmpDir('file-redos');
    fs.writeFileSync(join(cwd, 'redos.txt'), 'a'.repeat(60000) + '!');
    const { port1, port2 } = new threads.MessageChannel();
    ctx.after(() => { port1.close(); port2.close(); });
    const running = once(port1, 'message');
    // A test-only preload signals immediately before the real pathological regex executes.
    // This avoids a guessed startup delay or terminating a worker that has not reached the regex.
    const preload = `import { workerData } from 'node:worker_threads';
      const original = RegExp.prototype.test;
      RegExp.prototype.test = function (text) {
        if (this.source === '(a+)+$') workerData.probe.postMessage('regex running');
        return original.call(this, text);
      };`;
    const records = trackWorkers(ctx, (options) => ({
      ...options, workerData: { ...options.workerData, probe: port2 }, transferList: [port2],
      execArgv: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`],
    }));
    // Advance the existing configured deadlines deterministically, without adding a test timing threshold.
    ctx.mock.timers.enable({ apis: ['setTimeout'] });
    const timers = ctx.mock.method(globalThis, 'setTimeout');
    const clears = ctx.mock.method(globalThis, 'clearTimeout');
    const ac = new AbortController();
    const timeoutMs = loadConfig().worker.timeoutMinutes * 60_000;
    let settled = false;
    const pending = requestTools(ctx, cwd, [['search', { pattern: '(a+)+$' }]], {
      signal: ac.signal, ...(mode === 'task deadline' ? { timeoutMs } : {}),
    }).then((result) => { settled = true; return result; });
    assert.deepEqual(await Promise.race([running, pending.then((r) => assert.fail(`search ended before regex: ${outputs(r)}`))]), ['regex running']);
    assert.equal(timers.mock.callCount(), 1);
    const timer = timers.mock.calls[0];
    assert.ok(timer.arguments[1] > 0 && timer.arguments[1] <= timeoutMs);
    const heartbeat = new Promise((resolve) => setTimeout(resolve, 0));
    ctx.mock.timers.tick(0);
    await heartbeat;
    assert.equal(settled, false, 'main-loop timer runs while the search is still busy');
    if (mode === 'cancellation') ac.abort(); else ctx.mock.timers.tick(timeoutMs);
    const result = await pending;
    assert.match(outputs(result)[0], mode === 'cancellation' ? /^error: aborted$/ : /^error: search timeout$/);
    assertStopped(records);
    assert.ok(clears.mock.calls.some((call) => call.arguments[0] === timer.result));
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });
}
