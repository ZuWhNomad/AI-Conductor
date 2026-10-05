// Turn lifecycle. send / interrupt / stop pick a runtime; a non-Claude turn drains the queue it still owns.
import { writeJson, nowIso, shortId } from '../paths.mjs';
import { loadConfig } from '../config.mjs';
import { bus } from '../bus.mjs';
import { abortPlans } from '../plans.mjs';
import { logImprovement } from '../improve.mjs';
import { turnEventMapper } from './common.mjs';
import { sessions, HIST, ensureHistory, persistAll, publicSession, pushMessage, emit, removeQueuedMessages, stop, createSession } from './sessions.mjs';
import { start } from './runtime-claude.mjs';
import { runCodexTurn } from './runtime-codex.mjs';
import { runLoopTurn } from './runtime-loop.mjs';

function drainQueuedTurn(s) {
  if (!sessions.has(s.id) || s.runtime === 'claude' || s.status !== 'idle' || !s.queue?.length) return false;
  const queued = s.queue.splice(0);
  const ids = queued.map((q) => q.id);
  const queuedIds = new Set(ids);
  for (const message of s.messages) if (queuedIds.has(message.id)) delete message.queued;
  const text = queued.map((q) => q.text).join('\n\n');
  s.turn = { startedAt: nowIso(), text };
  s.status = 'running';
  s.updatedAt = nowIso();
  persistAll();
  if (s.historyLoaded) writeJson(HIST(s.id, 'messages'), s.messages);
  emit(s, 'dequeued', { ids });
  emit(s, 'status', { status: 'running' });
  void runTurn(s, text);
  return true;
}

/** On boot, report every interrupted turn and resume a durable Claude/Codex thread once. */
export async function resumeInterruptedTurns() {
  const resumed = [];
  for (const s of sessions.values()) {
    if (s.turn) {
      await ensureHistory(s);
      const turn = s.turn; s.turn = null;
      const note = `Conductor restarted during your turn (started ${turn.startedAt}). Continue from the current state of the files; do not redo finished work.`;
      pushMessage(s, { role: 'watchdog', text: note });
      const resumable = s.runtime === 'claude' ? !!s.sdkSessionId : s.runtime === 'codex' ? !!s.threadId : false;
      persistAll();
      writeJson(HIST(s.id, 'messages'), s.messages);
      if (resumable) { await sendMessage(s.id, note); resumed.push(s.id); }
    }
    if (s.status === 'idle' && s.queue?.length) {
      await ensureHistory(s);
      drainQueuedTurn(s);
    }
  }
  return resumed;
}

async function runTurn(s, text) {
  const cfg = loadConfig();
  const ac = new AbortController();
  s.turnAbort = ac;
  const mine = () => s.turnAbort === ac;
  const t0 = Date.now();
  const onEvent = turnEventMapper(s);
  let r;
  try {
    if (s.runtime === 'codex') r = await runCodexTurn(s, text, { cfg, ac, onEvent, mine });
    else r = await runLoopTurn(s, text, { cfg, ac, onEvent, mine });
    // Loop runtimes already record 429s via the http_rate event (with retry-after); only Codex needs an explicit note.
    if (r.limitHit && s.runtime === 'codex') bus.publish('rate_limit', { provider: s.provider, info: { status: 'rejected', rateLimitType: 'codex', resetsAt: r.retryAfterMs ? (Date.now() + r.retryAfterMs) / 1000 : undefined } });
    const interrupted = ac.signal.aborted && s.interrupted;
    const msg = { role: 'result', subtype: interrupted ? 'interrupted' : r.ok ? 'success' : 'error', isError: !r.ok, text: interrupted || (r.ok ? '' : (r.error || 'turn failed')), costUsd: 0, durationMs: Date.now() - t0, numTurns: 1, usage: r.usage ? { [s.model || s.provider]: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, cacheReadInputTokens: r.usage.cached_input_tokens || 0 } } : null };
    if (interrupted) s.interrupted = false;
    if (sessions.has(s.id)) { pushMessage(s, msg); emit(s, 'result', msg); }
    if (!r.ok && !ac.signal.aborted) logImprovement('error', `conductor:${s.runtime}`, `turn failed: ${r.error}`, { sessionId: s.id, model: s.model });
  } catch (e) {
    const m = String(e?.message || e);
    if (!ac.signal.aborted && sessions.has(s.id)) { emit(s, 'error', { message: m }); logImprovement('error', `conductor:${s.runtime}`, m, { sessionId: s.id }); }
    const msg = { role: 'result', subtype: ac.signal.aborted ? 'interrupted' : 'error', isError: true, text: ac.signal.aborted ? (s.interrupted || 'interrupted') : m, durationMs: Date.now() - t0, numTurns: 1 };
    if (ac.signal.aborted) s.interrupted = false;
    if (sessions.has(s.id)) { pushMessage(s, msg); emit(s, 'result', msg); }
  } finally {
    // E9: if the session was deleted mid-turn (mine() is false because stop() cleared turnAbort),
    // do not rewrite history files or emit events for the deleted id.
    const current = mine();
    if (current) { s.turnAbort = null; s.turn = null; s.status = 'idle'; s.updatedAt = nowIso(); persistAll(); emit(s, 'status', { status: 'idle' }); }
    if (current) drainQueuedTurn(s);
    if (sessions.has(s.id)) writeJson(HIST(s.id, 'messages'), s.messages);
  }
}

// ---------------------------------------------------------------- shared API
export async function sendMessage(sessionId, text) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  await ensureHistory(s);
  if (s.status === 'running' && s.runtime !== 'claude') {
    const queued = { id: shortId(), text: String(text), queuedAt: nowIso() };
    s.queue.push(queued);
    s.updatedAt = nowIso();
    pushMessage(s, { role: 'user', text: queued.text, queued: true, id: queued.id });
    persistAll();
    writeJson(HIST(s.id, 'messages'), s.messages);
    emit(s, 'queued', { id: queued.id, text: queued.text, depth: s.queue.length });
    return publicSession(s);
  }
  const turnText = s.pendingNote ? `${s.pendingNote}\n\n${text}` : text;
  if (s.pendingNote) { s.pendingNote = null; persistAll(); }
  if (s.runtime === 'claude' && !s.query) start(s);
  const autoTitle = s.title === 'New chat';
  if (autoTitle) s.title = text.trim().slice(0, 60) || 'New chat';
  if (s.status !== 'running') { s.interrupted = false; s.turn = { startedAt: nowIso(), text: String(turnText) }; }
  s.status = 'running'; s.updatedAt = nowIso(); persistAll();
  if (autoTitle) emit(s, 'updated', { session: publicSession(s) }); // U7: persist then emit, same as setTitle
  const msg = { role: 'user', text };
  pushMessage(s, msg); emit(s, 'user', msg); emit(s, 'status', { status: 'running' });
  if (s.runtime === 'claude') {
    s.inbox.push({ type: 'user', message: { role: 'user', content: turnText }, parent_tool_use_id: null, session_id: s.sdkSessionId || undefined });
  } else void runTurn(s, turnText);
  return publicSession(s);
}

export async function interrupt(sessionId, reason = 'interrupted by user', { returnQueued = false } = {}) {
  const s = sessions.get(sessionId); if (!s) return { ok: false, returned: [] };
  abortPlans(sessionId); // X3: Stop also stops the chat's run_plan stages
  if (s.runtime !== 'claude') {
    const returned = returnQueued ? removeQueuedMessages(s).map((q) => q.text) : [];
    const active = s.turnAbort;
    if (active) { s.interrupted = reason; active.abort(); }
    return { ok: !!active, returned };
  }
  if (!s.query || s.status !== 'running') return { ok: false, returned: [] };
  s.interrupted = reason; // the SDK reports an interrupt as an error result; label it instead of logging it
  try { await s.query.interrupt(); } catch (e) { s.interrupted = false; emit(s, 'error', { message: `interrupt failed: ${e.message}` }); }
  return { ok: true, returned: [] };
}

export function stopSession(sessionId) {
  const s = sessions.get(sessionId); if (!s) return false;
  abortPlans(sessionId);
  removeQueuedMessages(s);
  stop(s); s.status = 'idle'; s.turn = null; s.updatedAt = nowIso(); persistAll(); emit(s, 'status', { status: 'idle' });
  return true;
}

/** Stop every live runtime and flush codex/loop transcripts (handoff before a relaunch). */
export function shutdownSessions() {
  for (const s of sessions.values()) {
    stop(s);
    // Only flush a transcript we have loaded — writing [] would wipe disk history for unopened chats.
    if ((s.runtime === 'codex' || s.runtime === 'loop') && s.historyLoaded) writeJson(HIST(s.id, 'messages'), s.messages);
  }
}

/** Headless helper used by `conductor review`: run one prompt to completion, streaming text to a callback. */
export async function runOnce({ cwd, prompt: text, model, effort, onText }) {
  const s = createSession({ cwd, model, effort, title: text.slice(0, 60) });
  const done = new Promise((resolve) => {
    const h = (e) => { if (e.type !== 'session' || e.sessionId !== s.id) return; if (e.kind === 'delta' && e.block === 'text') onText?.(e.text); if (e.kind === 'assistant' && s.runtime !== 'claude') for (const b of e.blocks || []) if (b.type === 'text') onText?.(b.text + '\n'); if (e.kind === 'result' || (e.kind === 'status' && e.status === 'idle')) { bus.off('event', h); resolve(e); } };
    bus.on('event', h);
  });
  await sendMessage(s.id, text);
  const r = await done;
  stopSession(s.id);
  return r;
}
