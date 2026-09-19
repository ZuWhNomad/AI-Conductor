// 2026-09-11 log-review fixes: cross-process limits, bounded loop history, URL fetching, park semantics, loop follow-ups.
import { HOME } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';

test('limits.json written by another process is picked up on the next read', async () => {
  const lim = await import('../core/limits.mjs');
  lim.noteHttp('deepseek', 200, {}); // creates the file
  const f = join(HOME, 'limits.json');
  const j = JSON.parse(readFileSync(f, 'utf8'));
  j.providers.grok = { provider: 'grok', windows: [{ id: 'grok:w', label: 'weekly', usedPercent: 77 }] };
  writeFileSync(f, JSON.stringify(j));
  const t = new Date(Date.now() + 5000); utimesSync(f, t, t); // a different mtime, as another process's write would have
  assert.equal(lim.getLimits().providers.grok.windows[0].usedPercent, 77);
  delete lim.getLimits().providers.grok;
});

test('trimHistory keeps the system prompt and the newest turns, cut at a user message', async () => {
  const { trimHistory } = await import('../core/conductor.mjs');
  const msgs = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 50; i++) msgs.push({ role: 'user', content: `u${i}` }, { role: 'assistant', content: null, tool_calls: [{ id: `c${i}` }] }, { role: 'tool', tool_call_id: `c${i}`, content: 'x' }, { role: 'assistant', content: `a${i}` });
  const out = trimHistory(msgs, 10);
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'user');
  assert.ok(out.length <= 11 && out.length >= 8);
  assert.equal(trimHistory(msgs.slice(0, 5), 10).length, 5);
  assert.equal(trimHistory(null), null);
});

test('fetch_url returns page text with tags stripped and refuses non-http URLs', async () => {
  const { fetchUrlText } = await import('../core/workers/openai-compat.mjs');
  const srv = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<html><head><style>x{}</style><script>bad()</script></head><body><h1>Title</h1><p>Hello &amp; bye</p></body></html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const out = await fetchUrlText(`http://127.0.0.1:${srv.address().port}/`, { allowPrivate: true });
    assert.match(out, /^HTTP 200\n/);
    assert.match(out, /Title\s*\n?\s*Hello & bye/);
    assert.ok(!/bad\(\)|x\{\}/.test(out));
    // SSRF guard on by default: a private/loopback host is refused.
    await assert.rejects(fetchUrlText(`http://127.0.0.1:${srv.address().port}/`), /private\/reserved/);
  } finally { srv.close(); }
  await assert.rejects(fetchUrlText('file:///etc/passwd'), /only http/);
});

test('a task parked before it ever ran is not marked as interrupted', async () => {
  const tk = await import('../core/tasks.mjs');
  const lim = await import('../core/limits.mjs');
  lim.getLimits().providers.grok = { provider: 'grok', blocked: true, blockedUntil: Date.now() + 3.6e6, windows: [] };
  delete process.env.CONDUCTOR_NO_SCHEDULE; // let the scheduler see the blocked provider
  const t = tk.createTask({ cwd: HOME, title: 'parked early', spec: 'x', provider: 'grok' });
  process.env.CONDUCTOR_NO_SCHEDULE = '1';
  await new Promise((r) => setTimeout(r, 50));
  const j = tk.getTask(t.id);
  assert.equal(j.status, 'parked');
  assert.equal(j.resume, false);
  tk.cancelTask(t.id);
  delete lim.getLimits().providers.grok;
});

test("feedback bundle redacts home path, user name, e-mails and key-shaped strings", async () => {
  const { redact, writeFeedback } = await import("../core/feedback.mjs");
  const out = redact(String.raw`cwd C:\Users\jo.doe\proj by jo.doe <jo.doe@example.com> apiKey: sk-abcdefghijklmnopqrstuvwxyz1234 token=ghp_ABCDEFGHIJKLMNOPQRSTUV`, { home: String.raw`C:\Users\jo.doe`, user: 'jo.doe' });
  assert.equal(out, String.raw`cwd ~\proj by <user> <<email>> apiKey: <secret> token=<secret>`);
  const f = writeFeedback(HOME);
  const j = JSON.parse(readFileSync(f, "utf8"));
  assert.ok(j.version && j.node && Array.isArray(j.improvements) && typeof j.scores === "string");
  assert.ok(!JSON.stringify(j).includes(HOME), "state dir path redacted");
});

test('a category recipe is registered for modeling and reaches the worker spec', async () => {
  const { recipeFor, listRecipes } = await import('../core/recipes.mjs');
  assert.match(recipeFor('modeling'), /trace the reference|potrace/i);
  assert.equal(recipeFor('debug'), null);
  assert.ok(listRecipes().find((r) => r.category === 'modeling')?.present);
  const tk = await import('../core/tasks.mjs');
  const t = tk.createTask({ cwd: HOME, title: 'cutter', spec: 'make it', provider: 'ollama', model: 'x', category: 'modeling', difficulty: 4 });
  assert.equal(tk.getTask(t.id).category, 'modeling');
  tk.cancelTask(t.id);
});

test('recipe variants: a task variant selects the B recipe; unknown variants fall back to the default', async () => {
  const { recipeFor } = await import('../core/recipes.mjs');
  assert.match(recipeFor('modeling', 'recipe-b'), /Recipe B/);
  assert.match(recipeFor('modeling', 'recipe-a'), /Recipe: image/);
  assert.match(recipeFor('modeling', 'nope'), /Recipe B/);            // B is the default now
  assert.match(recipeFor('modeling'), /Recipe B/);
  assert.match(recipeFor('modeling', 'recipe-c'), /stage 2 \(build\)/);
  assert.match(recipeFor('modeling', 'recipe-c-trace'), /stage 1 \(trace\)/);
  assert.equal(recipeFor('debug', 'recipe-b'), null);
});

test('worker timeout can be raised per category; long runs are logged', async () => {
  const { loadConfig, saveConfig, DEFAULTS } = await import('../core/config.mjs');
  assert.equal(DEFAULTS.worker.timeoutByCategory.modeling, 240);
  saveConfig({ worker: { timeoutByCategory: 'x' } });
  assert.equal(loadConfig().worker.timeoutByCategory.modeling, 240);
  saveConfig({ worker: { timeoutByCategory: { modeling: 300 } } });
  assert.equal(loadConfig().worker.timeoutByCategory.modeling, 300);
  saveConfig({ worker: { timeoutByCategory: { modeling: 240 } } });
});

// Guards for folder moves: REPO_ROOT is computed from where core/paths.mjs sits, and a test that forgets _env.mjs
// touches the real ~/.conductor2.
test('REPO_ROOT points at the repo (package.json is there)', async () => {
  const { REPO_ROOT } = await import('../core/paths.mjs');
  assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).name, 'conductor');
});

test('every test file imports _env.mjs before any repo module', () => {
  const dir = import.meta.dirname;
  for (const f of readdirSync(dir, { recursive: true }).filter((n) => n.endsWith('.test.mjs'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    const env = src.search(/import\s[^;]*?['"](?:\.\.?\/)+_env\.mjs['"]/);
    const repo = src.search(/['"](?:\.\.\/)+(?:core|server|bin|ui)\//);
    assert.ok(env >= 0 && (repo < 0 || env < repo), `${f} must import _env.mjs first`);
  }
});
