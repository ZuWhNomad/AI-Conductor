import { HOME, tmpDir } from './_env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { writeJson, readJson } from '../core/paths.mjs';

writeJson(join(HOME, 'sessions.json'), [{
  id: 'restored-e12', cwd: HOME, title: 'restored', provider: 'claude', runtime: 'claude',
  model: null, effort: 'high', permissionMode: 'acceptEdits', sdkSessionId: 'sdk-e12',
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
}]);

const sdkUrl = 'data:text/javascript,' + encodeURIComponent(`
  export function query({ prompt }) {
    return (async function* () {
      if (globalThis.__claudeEndWithoutResult) {
        for await (const msg of prompt) { (globalThis.__claudeInbox ||= []).push(msg); return; }
      }
      for await (const msg of prompt) {
        (globalThis.__claudeInbox ||= []).push(msg);
        const gate = (globalThis.__claudeGates || []).shift();
        if (gate) await gate.promise;
        yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, duration_ms: 1, num_turns: 1, queued_turn_count: (globalThis.__claudeGates || []).length };
      }
    })();
  }
  export async function getSessionMessages() {
    globalThis.__histCalls = (globalThis.__histCalls || 0) + 1;
    if (globalThis.__histHold) await globalThis.__histHold.promise;
    return [{ type: 'user', parent_tool_use_id: null, message: { content: 'restored hello' } }];
  }
  export function tool(name, description, schema, handler) { return { name, description, schema, handler }; }
  export function createSdkMcpServer(config) { return { type: 'sdk', ...config }; }
`);
const codexUrl = 'data:text/javascript,' + encodeURIComponent(`
  export async function runCodex(t) {
    globalThis.__codexStarted?.resolve?.();
    if (globalThis.__codexHold) await globalThis.__codexHold.promise;
    if (t.signal?.aborted) return { ok: false, error: 'aborted', usage: {} };
    return { ok: true, finalMessage: 'ok', threadId: 'th-1', usage: { input_tokens: 1, output_tokens: 1 } };
  }
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: sdkUrl, shortCircuit: true };
    if (specifier === './workers/codex.mjs' && context.parentURL?.includes('conductor.mjs')) return { url: codexUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { createSession, deleteSession, getSession, sendMessage, setEffort, listSessions } = await import('../core/conductor.mjs');
const { bus } = await import('../core/bus.mjs');
const { getModels } = await import('../core/models.mjs');

function onceSession(id, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bus.off('event', h); reject(new Error(`timed out waiting for session ${kind}`)); }, 10_000);
    const h = (e) => {
      if (e.type === 'session' && e.sessionId === id && e.kind === kind) {
        clearTimeout(timer); bus.off('event', h); resolve(e);
      }
    };
    bus.on('event', h);
  });
}

afterEach(() => {
  for (const s of listSessions()) if (s.id !== 'restored-e12') deleteSession(s.id);
  for (const g of globalThis.__claudeGates || []) try { g.resolve(); } catch {}
  globalThis.__claudeGates = [];
  globalThis.__claudeInbox = [];
  globalThis.__claudeEndWithoutResult = false;
  globalThis.__histHold?.resolve?.();
  globalThis.__histHold = null;
  globalThis.__codexHold?.resolve?.();
  globalThis.__codexHold = null;
});

test('queued Claude message keeps the session running so setEffort does not drop it', async () => {
  const g1 = Promise.withResolvers(), g2 = Promise.withResolvers();
  globalThis.__claudeGates = [g1, g2];
  const s = createSession({ cwd: tmpDir('e6') });
  const result1 = onceSession(s.id, 'result');
  await sendMessage(s.id, 'first');
  await sendMessage(s.id, 'second');
  g1.resolve();
  await result1;
  assert.equal((await getSession(s.id)).status, 'running');
  setEffort(s.id, 'high');
  const result2 = onceSession(s.id, 'result');
  g2.resolve();
  await result2;
  const live = await getSession(s.id);
  assert.equal(live.messages.filter((m) => m.role === 'user').length, 2);
});

test('a Claude query that ends without a result does not leave the session running', async () => {
  globalThis.__claudeEndWithoutResult = true;
  const s = createSession({ cwd: tmpDir('no-result') });
  const idle = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { bus.off('event', h); reject(new Error('timed out waiting for idle')); }, 10_000);
    const h = (e) => {
      if (e.type === 'session' && e.sessionId === s.id && e.kind === 'status' && e.status === 'idle') {
        clearTimeout(timer); bus.off('event', h); resolve(e);
      }
    };
    bus.on('event', h);
  });
  await sendMessage(s.id, 'hello');
  await idle;
  assert.equal((await getSession(s.id)).status, 'idle');
});

test('deleting a Codex session mid-turn does not rewrite history or emit for the deleted id', async () => {
  globalThis.__codexHold = Promise.withResolvers();
  globalThis.__codexStarted = Promise.withResolvers();
  const s = createSession({ cwd: tmpDir('e9'), provider: 'codex', model: 'gpt-6-astra' });
  await sendMessage(s.id, 'hello');
  await globalThis.__codexStarted.promise;
  const hist = join(HOME, 'history', `${s.id}.messages.json`);
  deleteSession(s.id);
  const after = [];
  const h = (e) => { if (e.type === 'session' && e.sessionId === s.id) after.push(e.kind); };
  bus.on('event', h);
  globalThis.__codexHold.resolve();
  await new Promise((r) => setTimeout(r, 50));
  bus.off('event', h);
  assert.equal(existsSync(hist), false, 'deleted history must not be rewritten');
  assert.ok(!after.includes('result') && !after.includes('status') && !after.includes('error'));
});

test('concurrent getSession loads restored Claude history once', async () => {
  globalThis.__histHold = Promise.withResolvers();
  globalThis.__histCalls = 0;
  const a = getSession('restored-e12');
  const b = getSession('restored-e12');
  assert.equal(globalThis.__histCalls, 1);
  globalThis.__histHold.resolve();
  const [sa, sb] = await Promise.all([a, b]);
  const n = (sess) => sess.messages.filter((m) => m.role === 'user' && m.text === 'restored hello').length;
  assert.equal(n(sa), 1);
  assert.equal(n(sb), 1);
  assert.equal(globalThis.__histCalls, 1);
});

test('auto-titling a new chat emits updated and persists the title', async () => {
  const s = createSession({ cwd: tmpDir('u7') });
  const updated = onceSession(s.id, 'updated');
  await sendMessage(s.id, 'Hello sidebar');
  const ev = await updated;
  assert.equal(ev.session.title, 'Hello sidebar');
  assert.equal(listSessions().find((x) => x.id === s.id).title, 'Hello sidebar');
  assert.equal(readJson(join(HOME, 'sessions.json')).find((x) => x.id === s.id).title, 'Hello sidebar');
});

test('Claude sessions clamp unsupported ultra effort to max', () => {
  const cwd = tmpDir('u13');
  const s = createSession({ cwd, effort: 'ultra' });
  assert.equal(s.effort, 'max');
  setEffort(s.id, 'ultra');
  assert.equal(listSessions().find((x) => x.id === s.id).effort, 'max');
  getModels().models.push(
    { provider: 'claude', id: 'u13-opus', kind: 'agent', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { provider: 'claude', id: 'u13-haiku', kind: 'agent', efforts: [] },
  );
  const listed = createSession({ cwd, model: 'u13-opus', effort: 'ultra' });
  assert.equal(listed.effort, 'max');
  setEffort(listed.id, 'high');
  assert.equal(listSessions().find((x) => x.id === listed.id).effort, 'high');
  const empty = createSession({ cwd, model: 'u13-haiku', effort: 'ultra' });
  assert.equal(empty.effort, null, 'a model that lists no efforts never carries one (honoredEffort)');
});
