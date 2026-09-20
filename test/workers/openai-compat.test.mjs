import { tmpDir } from '../_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runOpenAICompat } = await import('../../core/workers/openai-compat.mjs');
const base = { cwd: tmpDir('compat'), prompt: 'x', baseUrl: 'http://unused.test', model: 'test' };

test('cancellation between tool calls prevents the next tool from running', async (ctx) => {
  const ac = new AbortController(); const ran = [];
  ctx.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { role: 'assistant', tool_calls: ['first', 'second'].map((name) => ({ id: name, function: { name, arguments: '{}' } })) } }] }));
  const r = await runOpenAICompat({ ...base, signal: ac.signal, extraTools: ['first', 'second'].map((name) => ({ def: { name, parameters: { type: 'object' } }, impl: () => { ran.push(name); ac.abort(); return 'done'; } })) });
  assert.equal(r.ok, false);
  assert.match(r.error, /aborted/);
  assert.deepEqual(ran, ['first']);
});

test('a hung fetch is aborted by the task deadline without a caller signal', async (ctx) => {
  let signal;
  ctx.mock.method(globalThis, 'fetch', async (_url, opts) => new Promise((_resolve, reject) => {
    signal = opts.signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const keepAlive = setTimeout(() => {}, 3000); // AbortSignal.timeout itself is unref'ed.
  try {
    const r = await runOpenAICompat({ ...base, timeoutMs: 10 });
    assert.equal(r.ok, false);
    assert.equal(signal.aborted, true);
    assert.match(r.error, /timeout/i);
    assert.ok(r.durationMs < 2500);
  } finally { clearTimeout(keepAlive); }
});

test('an unlimited task can fetch without a caller signal or timeout', async (ctx) => {
  ctx.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    assert.equal(signal.aborted, false);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
  });
  assert.equal((await runOpenAICompat(base)).ok, true);
});

test('DeepSeek balance parses and providers expose a homepage', async () => {
  const { parseDeepseekBalance } = await import('../../core/providers/openai-compat.mjs');
  const { providerSummaries } = await import('../../core/providers/index.mjs');
  assert.deepEqual(parseDeepseekBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.87' }] }), { amount: 4.87, granted: 0, toppedUp: 0, currency: 'USD', available: true });
  assert.equal(parseDeepseekBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] }).available, false);
  assert.equal(parseDeepseekBalance({}), null);
  const sums = providerSummaries();
  assert.equal(sums.find((p) => p.id === 'deepseek').url, 'https://platform.deepseek.com');
  assert.equal(sums.find((p) => p.id === 'codex').url, 'https://chatgpt.com/codex');
});

test('a prepaid balance becomes a budget window (% consumed, $ left)', async () => {
  const { budgetWindow } = await import('../../core/providers/openai-compat.mjs');
  const { saveConfig } = await import('../../core/config.mjs');
  saveConfig({ providers: { deepseek: { budgetUsd: 5 } } });
  const w = budgetWindow('deepseek', { amount: 4.79, currency: 'USD', available: true });
  assert.equal(w.id, 'deepseek:budget');
  assert.equal(w.usedPercent, 4.2);
  assert.equal(w.remaining, 'USD 4.79 left');
  saveConfig({ providers: { deepseek: { budgetUsd: null } } });
  assert.equal(budgetWindow('deepseek', { amount: 3, currency: 'USD', available: true }).label, 'budget USD 4.79'); // without a configured budget, the highest balance seen is the budget
});

test('balance: granted (free) credit is reported separately and makes the provider free-class until spent', async () => {
  const { parseDeepseekBalance } = await import('../../core/providers/openai-compat.mjs');
  const b = parseDeepseekBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '6.10', granted_balance: '1.67', topped_up_balance: '4.43' }] });
  assert.deepEqual(b, { amount: 6.1, granted: 1.67, toppedUp: 4.43, currency: 'USD', available: true });
  const lim = await import('../../core/limits.mjs');
  const sc = await import('../../core/scorecard.mjs');
  lim.getLimits().providers.deepseek = { provider: 'deepseek', balance: b, windows: [] };
  assert.equal(sc.providerClass('deepseek'), 'free');
  lim.getLimits().providers.deepseek.balance.granted = 0;
  assert.equal(sc.providerClass('deepseek'), 'api');
  delete lim.getLimits().providers.deepseek;
});

test('DeepSeek off-peak: half price outside Mon-Fri 01-04 / 06-10 UTC', async () => {
  const { priceFor, offPeakFactor } = await import('../../core/priors.mjs');
  assert.equal(offPeakFactor('deepseek', new Date('2026-09-09T02:30:00Z')), 1);   // Wednesday, peak
  assert.equal(offPeakFactor('deepseek', new Date('2026-09-09T12:00:00Z')), 0.5); // Wednesday, off-peak
  assert.equal(offPeakFactor('deepseek', new Date('2026-09-12T02:30:00Z')), 0.5); // Saturday
  assert.equal(offPeakFactor('codex', new Date('2026-09-09T02:30:00Z')), 1);
  const peak = priceFor('deepseek', 'deepseek-flash', undefined, new Date('2026-09-09T02:30:00Z'));
  const off = priceFor('deepseek', 'deepseek-flash', undefined, new Date('2026-09-09T12:00:00Z'));
  assert.equal(off.in, peak.in / 2); assert.equal(off.out, peak.out / 2); assert.equal(off.cached, peak.cached / 2);
});

test('runWorker persists and replays conversation history for API worker follow-ups', async (ctx) => {
  const { runWorker } = await import('../../core/workers/index.mjs');
  const { existsSync } = await import('node:fs');
  const { statePath, readJson } = await import('../../core/paths.mjs');

  const requests = [];
  ctx.mock.method(globalThis, 'fetch', async (_url, opts) => {
    const body = JSON.parse(opts.body);
    requests.push(body);
    return Response.json({ choices: [{ message: { role: 'assistant', content: `response to ${body.messages.at(-1).content}` } }] });
  });

  const task1 = { id: 'task-100', cwd: tmpDir('history1'), prompt: 'Hello first', provider: 'deepseek' };
  const r1 = await runWorker(task1);

  assert.equal(r1.ok, true);
  assert.equal(r1.threadId, 'task-100');

  const historyFile = statePath('history', 'task-100.worker.json');
  assert.equal(existsSync(historyFile), true);
  const savedHistory1 = readJson(historyFile);
  assert.equal(savedHistory1[0].role, 'system');
  assert.deepEqual(savedHistory1.slice(1), [
    { role: 'user', content: 'Hello first' },
    { role: 'assistant', content: 'response to Hello first' }
  ]);

  const task2 = { id: 'task-101', threadId: 'task-100', cwd: tmpDir('history2'), prompt: 'Follow up second', provider: 'deepseek' };
  const r2 = await runWorker(task2);

  assert.equal(r2.ok, true);
  assert.equal(r2.threadId, 'task-100');

  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages[0].role, 'system');
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: 'user', content: 'Hello first' },
    { role: 'assistant', content: 'response to Hello first' },
    { role: 'user', content: 'Follow up second' }
  ]);

  const savedHistory2 = readJson(historyFile);
  assert.equal(savedHistory2[0].role, 'system');
  assert.deepEqual(savedHistory2.slice(1), [
    { role: 'user', content: 'Hello first' },
    { role: 'assistant', content: 'response to Hello first' },
    { role: 'user', content: 'Follow up second' },
    { role: 'assistant', content: 'response to Follow up second' }
  ]);
});
