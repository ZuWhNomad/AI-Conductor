// Session store: one Map, hydrated from sessions.json at import. Public shape, selection parsing,
// queue edits, field setters, and stop(). stop() lives here so delete / effort / permission and the
// runtimes share it without an import cycle.
import { statSync, rmSync } from 'node:fs';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { statePath, readJson, writeJson, nowIso, shortId } from '../paths.ts';
import { loadConfig } from '../config.mjs';
import { bus } from '../bus.ts';
import { setSessionFlags } from '../session-flags.mjs';
import { abortPlans } from '../plans.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { getModels, findModel } from '../models.mjs';

const FILE = () => statePath('sessions.json');
export const HIST = (id, kind) => statePath('history', `${id}.${kind}.json`);
export const sessions = new Map();

function hydrateSession(rec) {
  return { ...rec, queue: Array.isArray(rec.queue) ? rec.queue : [], runtime: rec.runtime || runtimeFor(rec.provider || 'claude'), status: 'idle', query: null, inbox: null, pending: new Map(), messages: [], turnAbort: null, history: null, historyLoad: null, historyLoaded: false };
}
for (const rec of readJson(FILE(), [])) sessions.set(rec.id, hydrateSession(rec));
// The routing flags the delegate tools read live in a side map (no import cycle). Seed it from every session, not only
// when a toggle is clicked: a chat created with API overflow on, or any chat after a restart, used to read it as off.
const syncFlags = (s) => setSessionFlags(s.id, { overflowApi: !!s.overflowApi, parallelOverride: !!s.parallelOverride });
for (const s of sessions.values()) syncFlags(s);

/** Which runtime conducts for a provider; throws for worker-only providers. */
export function runtimeFor(provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}"`);
  if (p.kind === 'claude') return 'claude';
  if (p.kind === 'codex') return 'codex';
  if (p.kind === 'openai-compat') return 'loop';
  throw new Error(`${provider} (${p.kind}) cannot conduct; it is a worker-only provider`);
}

export function persistAll() {
  writeJson(FILE(), [...sessions.values()].map(publicSession));
}

export function publicSession(s) {
  return { id: s.id, cwd: s.cwd, title: s.title, provider: s.provider || 'claude', runtime: s.runtime, model: s.model, effort: s.effort, selection: `${s.provider || 'claude'}:${s.model || 'default'}:${s.effort || 'default'}`, permissionMode: s.permissionMode, overflowApi: !!s.overflowApi, parallelOverride: !!s.parallelOverride, sdkSessionId: s.sdkSessionId || null, threadId: s.threadId || null, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, costUsd: s.costUsd || 0, pendingCount: s.pending?.size ?? s.pendingCount ?? 0, watchdog: s.watchdog || null, turn: s.turn || null, queue: (s.queue || []).map((q) => ({ ...q })), pendingNote: s.pendingNote || null, lastPromptTokens: s.lastPromptTokens || null, lastRequestAt: s.lastRequestAt || null };
}

const EFFORT_WORDS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none', 'default']);
/**
 * "provider:model:effort" -> { provider, model, effort }. Model ids may contain colons, so the
 * effort is only the LAST segment when it is a known effort word, and the
 * provider is the first segment when there are at least two. Any part may be omitted or "default".
 */
export function parseSelection(sel, fallback = {}) {
  const out = { provider: fallback.provider || 'claude', model: fallback.model ?? null, effort: fallback.effort ?? null };
  if (!sel) return out;
  if (typeof sel === 'object') return { ...out, ...Object.fromEntries(Object.entries(sel).filter(([, v]) => v !== undefined)) };
  const parts = String(sel).split(':');
  if (parts.length === 1) { out.model = parts[0]; }
  else {
    out.provider = parts.shift() || out.provider;
    if (parts.length >= 2 && EFFORT_WORDS.has(parts[parts.length - 1])) out.effort = parts.pop();
    out.model = parts.join(':');
  }
  if (out.model === '' || out.model === 'default') out.model = null;
  if (out.effort === '' || out.effort === 'default') out.effort = null;
  return out;
}

/** U13: for the claude runtime, clamp an effort not in the model's listed efforts (or 'ultra') to 'max'. */
const clampClaudeEffort = (provider, model, effort) => {
  const listed = findModel(provider, model)?.efforts;
  return effort && (effort === 'ultra' || (listed?.length && !listed.includes(effort))) ? 'max' : effort;
};

/** A model whose registry entry lists no efforts must never carry one (same guard as createTask). */
export const honoredEffort = (provider, model, effort) => (findModel(provider, model)?.efforts?.length === 0 ? null : effort);

function defaultModelFor(provider) {
  const ms = getModels().models.filter((m) => m.provider === provider && m.kind === 'agent');
  return (ms.find((m) => m.isDefault) || ms[0])?.id || null;
}

export function listSessions() {
  return [...sessions.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(publicSession);
}

export async function ensureHistory(s) {
  if (s.historyLoaded) return;
  // E12: one in-flight load, shared by getSession and sendMessage.
  if (!s.historyLoad) s.historyLoad = loadHistory(s).finally(() => { s.historyLoad = null; s.historyLoaded = true; });
  await s.historyLoad;
}

export async function getSession(id) {
  const s = sessions.get(id); if (!s) return null;
  await ensureHistory(s);
  return { ...publicSession(s), messages: s.messages, pending: [...s.pending.values()].map((p) => p.request) };
}

export function createSession({ cwd, provider = null, model = null, effort = null, permissionMode = null, title = null, overflowApi = null, parallelOverride = false } = {}) {
  try { if (typeof cwd !== 'string' || !statSync(cwd).isDirectory()) throw new Error(); }
  catch { throw Object.assign(new Error('cwd must be an existing directory'), { status: 400 }); }
  if (permissionMode !== null && !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(permissionMode)) throw Object.assign(new Error('invalid permissionMode'), { status: 400 });
  const cfg = loadConfig();
  // `model` may be a composite "provider:model:effort". With an explicit provider the model is a bare id
  // (which may itself contain colons), so compose the selection instead of parsing it.
  const sel = provider
    ? parseSelection(`${provider}:${model == null || model === '' ? 'default' : model}${effort ? `:${effort}` : ''}`, { ...cfg.conductor, provider, model: null })
    : parseSelection(model, cfg.conductor);
  if (effort) sel.effort = effort;
  let runtime;
  try {
    runtime = runtimeFor(sel.provider);
    if (!sel.model && runtime !== 'claude') sel.model = defaultModelFor(sel.provider);
    if (!sel.model && runtime !== 'claude') throw new Error(`No model known for provider ${sel.provider}; refresh models or pick one explicitly`);
  } catch (e) { throw Object.assign(e, { status: 400 }); }
  const hon = honoredEffort(sel.provider, sel.model, sel.effort);
  const s = {
    id: shortId((id) => sessions.has(id)), cwd: cwd || process.cwd(), title: String(title ?? 'New chat').slice(0, 120), provider: sel.provider, runtime, model: sel.model,
    effort: runtime === 'claude' ? clampClaudeEffort(sel.provider, sel.model, hon) : hon, // U13: the SDK has no 'ultra'
    permissionMode: permissionMode ?? cfg.conductor.permissionMode, overflowApi: overflowApi ?? !!cfg.conductor.overflowApi, parallelOverride: !!parallelOverride, sdkSessionId: null, threadId: null, status: 'idle', createdAt: nowIso(), updatedAt: nowIso(),
    costUsd: 0, watchdog: null, pendingNote: null, queue: [], query: null, inbox: null, pending: new Map(), messages: [], abort: null, restartPending: false, turnAbort: null, history: null, historyLoad: null, historyLoaded: false,
  };
  sessions.set(s.id, s); syncFlags(s);
  persistAll();
  bus.publish('session', { sessionId: s.id, kind: 'created', session: publicSession(s) });
  return publicSession(s);
}

export function stop(s) {
  try { s.inbox?.close(); } catch {}
  try { s.abort?.abort(); } catch {}
  try { s.turnAbort?.abort(); } catch {}
  s.turnAbort = null; // E9: clear so mine() returns false; the aborted turn's finally won't repersist history
  s.query = null; s.inbox = null; s.abort = null;
  for (const p of s.pending.values()) p.resolve({ behavior: 'deny', message: 'session stopped' });
  s.pending.clear();
}

export function deleteSession(id) {
  const s = sessions.get(id); if (!s) return false;
  abortPlans(id); // X3: a deleted chat's plans stop dispatching
  s.queue = [];
  stop(s);
  sessions.delete(id); persistAll();
  for (const kind of ['messages', 'loop']) { try { rmSync(HIST(id, kind), { force: true }); } catch {} }
  bus.publish('session', { sessionId: id, kind: 'deleted' });
  return true;
}

export function emit(s, kind, data = {}) {
  bus.publish('session', { sessionId: s.id, kind, ...data });
}

export function pushMessage(s, m) {
  s.messages.push({ ts: Date.now(), ...m });
  if (s.messages.length > 2000) s.messages.splice(0, s.messages.length - 2000);
}

export function removeQueuedMessages(s, queued = s.queue) {
  const ids = queued.map((q) => q.id);
  if (!ids.length) return [];
  const removed = new Set(ids);
  if (!s.historyLoaded) { s.messages = readJson(HIST(s.id, 'messages'), []); s.historyLoaded = true; }
  s.queue = s.queue.filter((q) => !removed.has(q.id));
  s.messages = s.messages.filter((m) => !(m.role === 'user' && m.queued && removed.has(m.id)));
  s.updatedAt = nowIso();
  persistAll();
  if (s.historyLoaded) writeJson(HIST(s.id, 'messages'), s.messages);
  emit(s, 'queue_removed', { ids });
  return queued;
}

/** Record a basic watchdog transcript line without starting or interrupting a model turn. */
export function recordWatchdogCheckIn(sessionId, watchdog) {
  const s = sessions.get(sessionId);
  if (!s || s.status !== 'running') return false;
  s.watchdog = watchdog;
  pushMessage(s, { role: 'watchdog', text: watchdog.summary });
  persistAll();
  if (s.historyLoaded) writeJson(HIST(s.id, 'messages'), s.messages);
  return true;
}

/** Put a recovery note in one chat's transcript and ahead of its next conductor turn. */
export async function recordTaskRestartNote(sessionId, text) {
  const s = sessions.get(sessionId); if (!s) return false;
  const note = String(text);
  s.pendingNote = note;
  persistAll();
  await ensureHistory(s);
  pushMessage(s, { role: 'watchdog', text: note });
  persistAll();
  writeJson(HIST(s.id, 'messages'), s.messages);
  return true;
}

/** Repeat pending permission cards so a waiting-owner verdict is visible again. */
export function resurfacePermissions(sessionId) {
  const s = sessions.get(sessionId); if (!s?.pending?.size) return false;
  for (const { request } of s.pending.values()) emit(s, 'permission', { request });
  return true;
}

/** Whether this running Claude turn has an inbox that can accept mid-turn input. */
export function canNudge(sessionId) {
  const s = sessions.get(sessionId);
  return !!s && s.status === 'running' && s.runtime === 'claude' && !!s.inbox;
}

/** A single corrective message for a repeated Claude loop; other runtimes cannot accept mid-turn input. */
export function nudgeRunaway(sessionId, text) {
  if (!canNudge(sessionId)) return false;
  const s = sessions.get(sessionId);
  const message = String(text || '[watchdog] Repeated progress without a tool call was detected. Call the necessary tool now or finish with a concrete result.');
  pushMessage(s, { role: 'watchdog', text: message });
  s.inbox.push({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null, session_id: s.sdkSessionId || undefined });
  return true;
}

export function answerPermission(sessionId, requestId, { allow, message = 'denied by user' }) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  const p = s.pending.get(requestId); if (!p) return false;
  s.pending.delete(requestId);
  p.resolve(allow ? { behavior: 'allow', updatedInput: p.request.input } : { behavior: 'deny', message });
  emit(s, 'permission_resolved', { id: requestId, allow });
  emit(s, 'updated', { session: publicSession(s) });
  return true;
}

export function cancelQueuedMessage(sessionId, queueId) {
  const s = sessions.get(sessionId); if (!s) return false;
  const queued = s.queue.find((q) => q.id === queueId);
  if (!queued) return false;
  removeQueuedMessages(s, [queued]);
  return true;
}

export async function setModel(sessionId, model) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  s.model = model || null; persistAll();
  if (s.runtime === 'claude' && s.query) { try { await s.query.setModel(model || undefined); } catch (e) { emit(s, 'error', { message: `setModel failed: ${e.message}` }); } }
  emit(s, 'updated', { session: publicSession(s) });
}

/** Effort has no live control in the SDK: apply it by restarting the process (resumes the same session). */
export function setEffort(sessionId, effort) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  // U13: clamp unsupported effort (including 'ultra') to 'max' for claude runtime.
  s.effort = s.runtime === 'claude' ? clampClaudeEffort(s.provider, s.model, effort || null) : (effort || null);
  persistAll();
  if (s.runtime === 'claude' && s.query) { if (s.status === 'running') s.restartPending = true; else stop(s); }
  emit(s, 'updated', { session: publicSession(s) });
}

/** Rename a chat. A manual title sticks: sendMessage only auto-titles a chat while its title is still 'New chat'. */
export function setTitle(sessionId, title) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  const next = String(title ?? '').trim().slice(0, 120);
  if (!next) throw Object.assign(new Error('title must not be empty'), { status: 400 });
  s.title = next; s.updatedAt = nowIso(); persistAll();
  emit(s, 'updated', { session: publicSession(s) });
  return publicSession(s);
}

/**
 * Per-chat: skip Conductor's budget gate for the tasks this chat delegates, so they run in parallel instead of being
 * held to one-at-a-time when a provider's window is over its target or a task's cost is not yet measured. Hard limits
 * still apply: a provider that is actually rate-limited parks its tasks, and failover still hands them on.
 */
export function setParallel(sessionId, on) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  s.parallelOverride = !!on; syncFlags(s); persistAll();
  emit(s, 'updated', { session: publicSession(s) });
}

/** Per-chat: may the router spend pay-per-token APIs once the subscription classes are capped? */
export function setOverflow(sessionId, on) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  s.overflowApi = !!on; syncFlags(s); persistAll();
  emit(s, 'updated', { session: publicSession(s) });
}

export async function setPermissionMode(sessionId, mode) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  if (!['default', 'acceptEdits', 'bypassPermissions', 'plan'].includes(mode)) throw Object.assign(new Error('invalid permissionMode'), { status: 400 });
  const was = s.permissionMode;
  s.permissionMode = mode; persistAll();
  // bypass needs a fresh process (canUseTool wiring differs); other modes switch live. A running turn is
  // never killed for this: the restart happens after its result, like an effort change.
  if (s.runtime === 'claude' && s.query) {
    if (mode === 'bypassPermissions' || was === 'bypassPermissions') { if (s.status === 'running') s.restartPending = true; else stop(s); }
    else { try { await s.query.setPermissionMode(mode); } catch (e) { emit(s, 'error', { message: `setPermissionMode failed: ${e.message}` }); } }
  }
  emit(s, 'updated', { session: publicSession(s) });
}

/** Pick up sessions written to disk after this process imported sessions.json (relaunch child). */
export function reloadSessions() {
  const saved = new Map(readJson(FILE(), []).map((rec) => [rec.id, rec]));
  const live = (s) => s && (s.query || s.turnAbort || s.status === 'running');
  for (const [id, s] of sessions) if (!saved.has(id) && !live(s)) sessions.delete(id);
  for (const rec of saved.values()) {
    if (live(sessions.get(rec.id))) continue;
    const s = hydrateSession(rec);
    sessions.set(s.id, s);
    syncFlags(s);
  }
}

/** Session context for the /mcp endpoint (Codex conductors). */
export function sessionContext(sessionId) {
  const s = sessions.get(sessionId);
  return s ? { id: s.id, cwd: s.cwd } : null;
}

async function loadHistory(s) {
  if (s.runtime !== 'claude') { s.messages = readJson(HIST(s.id, 'messages'), []); return; }
  if (!s.sdkSessionId) return;
  try {
    const msgs = await getSessionMessages(s.sdkSessionId, { dir: s.cwd });
    for (const m of msgs) {
      if (m.parent_tool_use_id) continue;
      const c = m.message?.content;
      if (m.type === 'user') {
        if (typeof c === 'string') pushMessage(s, { role: 'user', text: c });
        else if (Array.isArray(c)) for (const b of c) { if (b.type === 'text') pushMessage(s, { role: 'user', text: b.text }); if (b.type === 'tool_result') pushMessage(s, { role: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: (typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('\n')).slice(0, 4000) }); }
      } else if (m.type === 'assistant' && Array.isArray(c)) {
        pushMessage(s, { role: 'assistant', blocks: c.filter((b) => b.type === 'text' || b.type === 'tool_use').map((b) => b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input }) });
      }
    }
  } catch (e) {
    pushMessage(s, { role: 'result', subtype: 'history', isError: false, text: `(history not loaded: ${e.message})` });
  }
}
