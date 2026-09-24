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
}, {
  id: 'restored-l5', cwd: HOME, title: 'l5', provider: 'codex', runtime: 'codex',
  model: 'gpt-6-astra', effort: 'low', permissionMode: 'acceptEdits',
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
}]);
writeJson(join(HOME, 'history', 'restored-l5.messages.json'), [
  { ts: 1, role: 'user', text: 'prior turn' },
  { ts: 2, role: 'assistant', blocks: [{ type: 'text', text: 'prior reply' }] },
]);

const sdkUrl = 'data:text/javascript,' + encodeURIComponent(`
  export function query({ prompt, options }) {
    return (async function* () {
      if (globalThis.__claudeEndWithoutResult) {
        for await (const msg of prompt) { (globalThis.__claudeInbox ||= []).push(msg); return; }
      }
      for await (const msg of prompt) {
        (globalThis.__claudeInbox ||= []).push(msg);
        if (globalThis.__claudeAskPermission && options?.canUseTool) {
          const ac = new AbortController();
          options.canUseTool('Bash', { command: 'ls' }, { requestId: 'perm-1', description: 'list', signal: ac.signal });
          globalThis.__claudeAskPermission = false;
        }
        if (globalThis.__claudeStream) {
          globalThis.__claudeStream = false;
          const parent = null;
          yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } }, parent_tool_use_id: parent };
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } }, parent_tool_use_id: parent };
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: ' more' } }, parent_tool_use_id: parent };
          yield { type: 'stream_event', event: { type: 'content_block_stop' }, parent_tool_use_id: parent };
          yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } }, parent_tool_use_id: parent };
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }, parent_tool_use_id: parent };
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } }, parent_tool_use_id: parent };
          yield { type: 'stream_event', event: { type: 'content_block_stop' }, parent_tool_use_id: parent };
        }
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
    if (globalThis.__codexOnEventError) t.onEvent?.('error', { error: globalThis.__codexOnEventError });
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

const { createSession, deleteSession, getSession, sendMessage, setEffort, listSessions, interrupt, runOnce, shutdownSessions, reloadSessions, answerPermission } = await import('../core/conductor.mjs');
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
  for (const s of listSessions()) if (s.id !== 'restored-e12' && s.id !== 'restored-l5') deleteSession(s.id);
  for (const g of globalThis.__claudeGates || []) try { g.resolve(); } catch {}
  globalThis.__claudeGates = [];
  globalThis.__claudeInbox = [];
  globalThis.__claudeEndWithoutResult = false;
  globalThis.__claudeAskPermission = false;
  globalThis.__claudeStream = false;
  globalThis.__histHold?.resolve?.();
  globalThis.__histHold = null;
  globalThis.__codexHold?.resolve?.();
  globalThis.__codexHold = null;
  globalThis.__codexOnEventError = null;
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

test('L5: sendMessage loads on-disk history before pushing, so a restart send does not wipe it', async () => {
  const idle = onceSession('restored-l5', 'result');
  await sendMessage('restored-l5', 'new turn');
  await idle;
  const live = await getSession('restored-l5');
  const texts = live.messages.filter((m) => m.role === 'user').map((m) => m.text);
  assert.deepEqual(texts.slice(0, 2), ['prior turn', 'new turn']);
  const disk = readJson(join(HOME, 'history', 'restored-l5.messages.json'));
  assert.ok(disk.some((m) => m.role === 'user' && m.text === 'prior turn'));
  assert.ok(disk.some((m) => m.role === 'user' && m.text === 'new turn'));
});

test('L8: shutdownSessions flushes a live codex transcript; reloadSessions adds sessions not already in the map', async () => {
  globalThis.__codexHold = Promise.withResolvers();
  globalThis.__codexStarted = Promise.withResolvers();
  const s = createSession({ cwd: tmpDir('l8'), provider: 'codex', model: 'gpt-6-astra', title: 'live' });
  await sendMessage(s.id, 'in flight');
  await globalThis.__codexStarted.promise;
  const hist = join(HOME, 'history', `${s.id}.messages.json`);
  shutdownSessions();
  const flushed = readJson(hist, []);
  assert.ok(flushed.some((m) => m.role === 'user' && m.text === 'in flight'), 'mid-turn user message is on disk');
  const disk = readJson(join(HOME, 'sessions.json'));
  disk.push({
    id: 'reloaded-l8', cwd: HOME, title: 'from disk', provider: 'claude', runtime: 'claude',
    model: null, effort: 'high', permissionMode: 'acceptEdits',
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
  });
  writeJson(join(HOME, 'sessions.json'), disk);
  const beforeTitle = listSessions().find((x) => x.id === s.id)?.title;
  reloadSessions();
  assert.equal(listSessions().find((x) => x.id === s.id)?.title, beforeTitle, 'already-present sessions are not replaced');
  const added = await getSession('reloaded-l8');
  assert.equal(added?.title, 'from disk');
  globalThis.__codexHold.resolve();
});

test('L33: runOnce ignores a mid-turn error event and resolves on result', async () => {
  globalThis.__codexOnEventError = 'Reconnecting… 429';
  const r = await runOnce({ cwd: tmpDir('l33'), prompt: 'review this', model: 'codex:gpt-6-astra' });
  assert.equal(r.kind, 'result');
  assert.equal(r.subtype, 'success');
  assert.equal(r.isError, false);
});

test('L35: interrupt while idle returns false and does not label the next turn interrupted', async () => {
  const s = createSession({ cwd: tmpDir('l35') });
  const first = onceSession(s.id, 'result');
  await sendMessage(s.id, 'first');
  await first;
  assert.equal((await getSession(s.id)).status, 'idle');
  assert.equal(await interrupt(s.id), false);
  const second = onceSession(s.id, 'result');
  await sendMessage(s.id, 'second');
  const ev = await second;
  assert.equal(ev.subtype, 'success');
  assert.notEqual(ev.text, 'interrupted by user');
});

test('P18: one empty thinking delta per block; text deltas are unchanged', async () => {
  globalThis.__claudeStream = true;
  const s = createSession({ cwd: tmpDir('p18') });
  const deltas = [];
  const h = (e) => { if (e.type === 'session' && e.sessionId === s.id && e.kind === 'delta') deltas.push({ block: e.block, text: e.text, parent: e.parent }); };
  bus.on('event', h);
  const result = onceSession(s.id, 'result');
  await sendMessage(s.id, 'think');
  await result;
  bus.off('event', h);
  assert.deepEqual(deltas.filter((d) => d.block === 'thinking'), [{ block: 'thinking', text: '', parent: null }]);
  assert.deepEqual(deltas.filter((d) => d.block === 'text'), [
    { block: 'text', text: 'hi', parent: null },
    { block: 'text', text: ' there', parent: null },
  ]);
});

test('pendingCount is on publicSession and updated fires when a permission is added or resolved', async () => {
  globalThis.__claudeAskPermission = true;
  const g1 = Promise.withResolvers();
  globalThis.__claudeGates = [g1];
  const s = createSession({ cwd: tmpDir('i4'), title: 'perm-chat' });
  const updatedAdd = onceSession(s.id, 'updated');
  const perm = onceSession(s.id, 'permission');
  await sendMessage(s.id, 'need a tool');
  await perm;
  const added = await updatedAdd;
  assert.equal(added.session.pendingCount, 1);
  assert.equal(listSessions().find((x) => x.id === s.id).pendingCount, 1);
  const updatedResolved = onceSession(s.id, 'updated');
  assert.equal(answerPermission(s.id, 'perm-1', { allow: true }), true);
  const resolved = await updatedResolved;
  assert.equal(resolved.session.pendingCount, 0);
  g1.resolve();
  await onceSession(s.id, 'result');
});
