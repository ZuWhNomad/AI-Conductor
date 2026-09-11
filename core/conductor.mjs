// Conductor chat sessions. Three runtimes, one contract:
//   claude — a long-lived Agent SDK query (Claude Code harness, subagents, in-process MCP tools)
//   codex  — one `codex exec` turn per message (thread resumed), tools via the /mcp HTTP endpoint
//   loop   — the OpenAI-compatible tool loop (Ollama / API models) with the same tools as functions
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { statePath, readJson, writeJson, nowIso, shortId, REPO_ROOT } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { bus } from './bus.mjs';
import { mcpServers, forClaudeSdk } from './mcp.mjs';
import { setSessionFlags, sessionFlags } from './session-flags.mjs';
import { conductorTools, conductorToolDefs, toolsAsFunctions, CONDUCTOR_AGENTS } from './tools.mjs';
import { logImprovement } from './improve.mjs';
import { PROVIDERS } from './providers/index.mjs';
import * as ollama from './providers/ollama.mjs';
import { runCodex } from './workers/codex.mjs';
import { runOpenAICompat } from './workers/openai-compat.mjs';
import { getModels } from './models.mjs';

const prompt = (f) => readFileSync(join(REPO_ROOT, 'core', 'prompts', f), 'utf8');
const PROMPT = prompt('conductor.md') + '\n\n' + prompt('orchestration.md'); // policy + the structural playbook (model-agnostic)
const PROMPT_CODEX = prompt('conductor-codex.md');
const PROMPT_LOOP = prompt('conductor-loop.md');
const FILE = () => statePath('sessions.json');
const HIST = (id, kind) => statePath('history', `${id}.${kind}.json`);
const sessions = new Map();
let serverUrl = 'http://127.0.0.1:47474';
export function setServerUrl(u) { serverUrl = u; }

for (const s of readJson(FILE(), [])) sessions.set(s.id, { ...s, runtime: s.runtime || runtimeFor(s.provider || 'claude'), status: 'idle', query: null, inbox: null, pending: new Map(), messages: [], turnAbort: null, history: null });

/** Which runtime conducts for a provider; throws for worker-only providers (images). */
export function runtimeFor(provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}"`);
  if (p.kind === 'claude') return 'claude';
  if (p.kind === 'codex') return 'codex';
  if (p.kind === 'ollama' || p.kind === 'openai-compat') return 'loop';
  throw new Error(`${provider} (${p.kind}) cannot conduct; it is a worker-only provider`);
}

function persistAll() {
  writeJson(FILE(), [...sessions.values()].map(publicSession));
}

export function publicSession(s) {
  return { id: s.id, cwd: s.cwd, title: s.title, provider: s.provider || 'claude', runtime: s.runtime, model: s.model, effort: s.effort, selection: `${s.provider || 'claude'}:${s.model || 'default'}:${s.effort || 'default'}`, permissionMode: s.permissionMode, overflowApi: !!s.overflowApi, sdkSessionId: s.sdkSessionId || null, threadId: s.threadId || null, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt, costUsd: s.costUsd || 0 };
}

const EFFORT_WORDS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'none', 'default']);
/**
 * "provider:model:effort" -> { provider, model, effort }. Model ids may contain colons (Ollama's
 * "qwen3.8:latest"), so the effort is only the LAST segment when it is a known effort word, and the
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

function defaultModelFor(provider) {
  const ms = getModels().models.filter((m) => m.provider === provider && m.kind === 'agent');
  return (ms.find((m) => m.isDefault) || ms[0])?.id || null;
}

export function listSessions() {
  return [...sessions.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(publicSession);
}

export async function getSession(id) {
  const s = sessions.get(id); if (!s) return null;
  if (!s.messages.length) await loadHistory(s);
  return { ...publicSession(s), messages: s.messages, pending: [...s.pending.values()].map((p) => p.request) };
}

class Inbox {
  #q = []; #w = []; #closed = false;
  push(m) { this.#q.push(m); const w = this.#w.shift(); if (w) w(); }
  close() { this.#closed = true; for (const w of this.#w.splice(0)) w(); }
  /** Take back messages not yet consumed by the SDK (used when the process is restarted mid-queue). */
  drain() { return this.#q.splice(0); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.#q.length) { yield this.#q.shift(); continue; }
      if (this.#closed) return;
      await new Promise((r) => this.#w.push(r));
    }
  }
}

export function createSession({ cwd, provider = null, model = null, effort = null, permissionMode = null, title = null, overflowApi = null } = {}) {
  try { if (typeof cwd !== 'string' || !statSync(cwd).isDirectory()) throw new Error(); }
  catch { throw Object.assign(new Error('cwd must be an existing directory'), { status: 400 }); }
  if (permissionMode !== null && !['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'].includes(permissionMode)) throw Object.assign(new Error('invalid permissionMode'), { status: 400 });
  const cfg = loadConfig();
  // `model` may be a composite "provider:model:effort". With an explicit provider the model is a bare id
  // (which may itself contain colons, e.g. "qwen3.8:latest"), so compose the selection instead of parsing it.
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
  const s = {
    id: shortId(), cwd: cwd || process.cwd(), title: String(title ?? 'New chat').slice(0, 120), provider: sel.provider, runtime, model: sel.model, effort: sel.effort,
    permissionMode: permissionMode ?? cfg.conductor.permissionMode, overflowApi: overflowApi ?? !!cfg.conductor.overflowApi, sdkSessionId: null, threadId: null, status: 'idle', createdAt: nowIso(), updatedAt: nowIso(),
    costUsd: 0, query: null, inbox: null, pending: new Map(), messages: [], abort: null, restartPending: false, turnAbort: null, history: null,
  };
  sessions.set(s.id, s);
  persistAll();
  bus.publish('session', { sessionId: s.id, kind: 'created', session: publicSession(s) });
  return publicSession(s);
}

export function deleteSession(id) {
  const s = sessions.get(id); if (!s) return false;
  stop(s);
  sessions.delete(id); persistAll();
  for (const kind of ['messages', 'loop']) { try { rmSync(HIST(id, kind), { force: true }); } catch {} }
  bus.publish('session', { sessionId: id, kind: 'deleted' });
  return true;
}

function emit(s, kind, data = {}) {
  bus.publish('session', { sessionId: s.id, kind, ...data });
}

function pushMessage(s, m) {
  s.messages.push({ ts: Date.now(), ...m });
  if (s.messages.length > 2000) s.messages.splice(0, s.messages.length - 2000);
}

// ---------------------------------------------------------------- claude runtime
function start(s) {
  const abort = new AbortController();
  const inbox = new Inbox();
  const bypass = s.permissionMode === 'bypassPermissions';
  const q = query({
    prompt: inbox,
    options: {
      cwd: s.cwd,
      model: s.model || undefined,
      effort: s.effort || undefined,
      permissionMode: s.permissionMode || 'acceptEdits',
      allowDangerouslySkipPermissions: bypass || undefined,
      canUseTool: bypass ? undefined : (toolName, input, o) => askPermission(s, toolName, input, o),
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT },
      mcpServers: { ...forClaudeSdk(mcpServers(), { skip: ['claude'] }), conductor: conductorTools({ sessionId: s.id, cwd: s.cwd }) },
      allowedTools: ['mcp__conductor', ...Object.keys(mcpServers()).map((n) => `mcp__${n}`)],
      agents: CONDUCTOR_AGENTS,
      settingSources: ['user', 'project', 'local'],
      resume: s.sdkSessionId || undefined,
      abortController: abort,
      maxTurns: 1000,
      title: s.title !== 'New chat' ? s.title : undefined,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'conductor/2.0.0' },
    },
  });
  s.query = q; s.inbox = inbox; s.abort = abort;
  void pump(s, q);
}

function stop(s) {
  try { s.inbox?.close(); } catch {}
  try { s.abort?.abort(); } catch {}
  try { s.turnAbort?.abort(); } catch {}
  s.query = null; s.inbox = null; s.abort = null;
  for (const p of s.pending.values()) p.resolve({ behavior: 'deny', message: 'session stopped' });
  s.pending.clear();
}

async function pump(s, q) {
  let streaming = null; // { block: 'text'|'thinking', text, parent }
  const abort = s.abort; // captured: stop() clears s.abort before the catch below runs
  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        s.sdkSessionId = m.session_id; s.updatedAt = nowIso(); persistAll();
        emit(s, 'init', { sdkSessionId: m.session_id, model: m.model, permissionMode: m.permissionMode, tools: m.tools?.length || 0, agents: m.agents || [] });
      } else if (m.type === 'stream_event') {
        const e = m.event;
        if (e.type === 'content_block_start') { streaming = { block: e.content_block?.type, text: '', parent: m.parent_tool_use_id }; }
        else if (e.type === 'content_block_delta') {
          const d = e.delta;
          const piece = d?.type === 'text_delta' ? d.text : d?.type === 'thinking_delta' ? d.thinking : null;
          if (piece != null) { streaming = streaming || { block: d.type === 'thinking_delta' ? 'thinking' : 'text', text: '', parent: m.parent_tool_use_id }; streaming.text += piece; emit(s, 'delta', { block: streaming.block, text: piece, parent: m.parent_tool_use_id }); }
        } else if (e.type === 'content_block_stop') { streaming = null; }
      } else if (m.type === 'assistant') {
        const blocks = (m.message.content || []).map((b) => b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b.type === 'thinking' ? { type: 'thinking', text: b.thinking || '' } : { type: b.type });
        const msg = { role: 'assistant', blocks, parent: m.parent_tool_use_id, error: m.error || null, subagent: m.subagent_type || null };
        pushMessage(s, msg); emit(s, 'assistant', msg);
        if (m.error) logImprovement('error', 'conductor', `assistant error: ${m.error}`, { sessionId: s.id });
      } else if (m.type === 'user') {
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'tool_result') {
              const textOut = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.type === 'text' ? c.text : `[${c.type}]`).join('\n');
              const msg = { role: 'tool_result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: textOut.slice(0, 4000), parent: m.parent_tool_use_id };
              pushMessage(s, msg); emit(s, 'tool_result', msg);
            }
          }
        }
      } else if (m.type === 'result') {
        s.status = 'idle'; s.costUsd = m.total_cost_usd || s.costUsd; s.updatedAt = nowIso(); persistAll();
        const msg = { role: 'result', subtype: m.subtype, isError: !!m.is_error, text: m.subtype === 'success' ? '' : (m.errors || [m.result]).filter(Boolean).join('; '), costUsd: m.total_cost_usd, durationMs: m.duration_ms, numTurns: m.num_turns, usage: m.modelUsage || null };
        if (s.interrupted) { s.interrupted = false; msg.subtype = 'interrupted'; msg.text = 'interrupted by user'; }
        pushMessage(s, msg); emit(s, 'result', msg); emit(s, 'status', { status: s.status });
        if (m.is_error && msg.subtype !== 'interrupted') logImprovement('error', 'conductor', `result error: ${msg.text}`, { sessionId: s.id });
        if (s.restartPending) { // e.g. effort/permission mode changed: restart the process (same session) without losing queued messages
          s.restartPending = false;
          const pending = s.inbox?.drain() || [];
          stop(s);
          if (pending.length) { start(s); for (const q2 of pending) s.inbox.push(q2); s.status = 'running'; emit(s, 'status', { status: 'running' }); }
        }
      } else if (m.type === 'rate_limit_event') {
        bus.publish('rate_limit', { provider: 'claude', info: m.rate_limit_info });
        if (m.rate_limit_info?.status !== 'allowed') emit(s, 'rate_limit', { info: m.rate_limit_info });
      } else if (m.type === 'system' && (m.subtype === 'task_started' || m.subtype === 'task_progress' || m.subtype === 'task_notification')) {
        emit(s, 'subagent', { subtype: m.subtype, taskId: m.task_id, description: m.description || m.summary || '', status: m.status || null, subagentType: m.subagent_type || null });
      } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
        emit(s, 'compact', { pre: m.compact_metadata?.pre_tokens, post: m.compact_metadata?.post_tokens });
      } else if (m.type === 'system' && m.subtype === 'status') {
        emit(s, 'sdk_status', { status: m.status, permissionMode: m.permissionMode });
      }
    }
  } catch (e) {
    const msg = String(e?.message || e);
    if (!abort?.signal.aborted && !/aborted/i.test(msg)) {
      emit(s, 'error', { message: msg });
      logImprovement('error', 'conductor', `session loop error: ${msg}`, { sessionId: s.id });
    }
  } finally {
    if (s.query === q) { s.query = null; s.inbox = null; s.abort = null; }
    if (s.query === q || s.query == null) { s.status = 'idle'; emit(s, 'status', { status: 'idle' }); }
  }
}

function askPermission(s, toolName, input, o) {
  return new Promise((resolve) => {
    const id = o.requestId || o.toolUseID || shortId();
    const request = { id, toolName, input, description: o.description || o.title || '', decisionReason: o.decisionReason || '', agentID: o.agentID || null, ts: Date.now() };
    s.pending.set(id, { request, resolve });
    emit(s, 'permission', { request });
    o.signal?.addEventListener('abort', () => { if (s.pending.delete(id)) { resolve({ behavior: 'deny', message: 'request aborted' }); emit(s, 'permission_resolved', { id }); } }, { once: true });
  });
}

export function answerPermission(sessionId, requestId, { allow, message = 'denied by user' }) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  const p = s.pending.get(requestId); if (!p) return false;
  s.pending.delete(requestId);
  p.resolve(allow ? { behavior: 'allow', updatedInput: p.request.input } : { behavior: 'deny', message });
  emit(s, 'permission_resolved', { id: requestId, allow });
  return true;
}

// ---------------------------------------------------------------- codex + loop runtimes
/** Translate worker-style events (codex items / loop tool calls) into the UI's message shapes. */
function turnEventMapper(s) {
  const seen = new Set();
  const say = (blocks) => { const msg = { role: 'assistant', blocks }; pushMessage(s, msg); emit(s, 'assistant', msg); };
  const result = (toolUseId, isError, text) => { const msg = { role: 'tool_result', toolUseId, isError: !!isError, text: String(text ?? '').slice(0, 4000) }; pushMessage(s, msg); emit(s, 'tool_result', msg); };
  return (event, data) => {
    if (event === 'item' && data.item) {
      const it = data.item; const done = data.phase === 'completed';
      if (it.type === 'agent_message') { if (done && it.text) say([{ type: 'text', text: it.text }]); }
      else if (it.type === 'reasoning') { /* not shown */ }
      else if (it.type === 'command_execution') {
        if (!seen.has(it.id)) { seen.add(it.id); say([{ type: 'tool_use', id: it.id, name: 'shell', input: { command: it.command } }]); }
        if (done) result(it.id, it.exitCode != null && it.exitCode !== 0, it.output || `exit ${it.exitCode}`);
      } else if (it.type === 'file_change') {
        if (done) { say([{ type: 'tool_use', id: it.id, name: 'edit', input: { files: (it.changes || []).map((c) => `${c.kind || ''} ${c.path}`.trim()) } }]); result(it.id, false, 'applied'); }
      } else if (it.type === 'mcp_tool_call') {
        if (!seen.has(it.id)) { seen.add(it.id); say([{ type: 'tool_use', id: it.id, name: `conductor:${it.tool}`, input: it.args || {} }]); }
        if (done) result(it.id, !!it.error, it.error || it.result || 'done');
      } else if (it.type === 'tool_use') { // loop runtime
        if (data.phase === 'started') say([{ type: 'tool_use', id: it.id, name: it.name, input: it.args || it.input || {} }]);
      } else if (it.type === 'web_search') {
        if (!seen.has(it.id)) { seen.add(it.id); say([{ type: 'tool_use', id: it.id, name: 'web_search', input: { query: it.query } }]); }
        if (done) result(it.id, false, 'done');
      } else if (it.type === 'error') { emit(s, 'error', { message: it.message }); }
    } else if (event === 'tool_result') { result(data.toolUseId, data.isError, data.text); }
    else if (event === 'turn.failed' || event === 'error') { if (data.error) emit(s, 'error', { message: data.error }); }
  };
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
    if (s.runtime === 'codex') {
      const first = !s.threadId;
      const promptText = first ? `${PROMPT}\n\n${PROMPT_CODEX}\n\n# User request\n${text}` : text;
      r = await runCodex({ id: `conductor:${s.id}`, cwd: s.cwd, prompt: promptText, model: s.model, effort: s.effort || undefined, sandbox: cfg.worker.codexSandbox, network: cfg.worker.codexNetwork, resumeThreadId: s.threadId || undefined, mcp: { ...mcpServers(cfg), conductor: { url: `${serverUrl}/mcp/${s.id}` } }, signal: ac.signal, onEvent, timeoutMs: 2 * 3600_000 });
      if (mine()) s.threadId = r.threadId || s.threadId;
    } else {
      const p = PROVIDERS[s.provider];
      let wc;
      if (p.kind === 'ollama') { await ollama.ensureRunning(); wc = { baseUrl: `${ollama.baseUrl()}/v1`, apiKey: 'ollama' }; }
      else wc = p.workerConfig();
      if (mine() && s.history == null) s.history = readJson(HIST(s.id, 'loop'), null);
      r = await runOpenAICompat({ id: `conductor:${s.id}`, cwd: s.cwd, prompt: text, history: trimHistory(s.history) || undefined, system: `${PROMPT}\n\n${PROMPT_LOOP}`, model: s.model, effort: s.effort || undefined, ...wc, provider: s.provider, extraTools: toolsAsFunctions(conductorToolDefs({ sessionId: s.id, cwd: s.cwd })), signal: ac.signal, onEvent, maxIterations: 120, timeoutMs: 2 * 3600_000 });
      if (mine()) { s.history = r.messages || s.history; writeJson(HIST(s.id, 'loop'), s.history); }
      if (r.error && /context|too many tokens|maximum.*length|token limit/i.test(r.error)) r.error += ' — the chat history no longer fits this model; start a new chat (history is kept on disk).';
      if (r.ok && r.finalMessage && !s.messages.some((m) => m.role === 'assistant' && m.blocks?.[0]?.text === r.finalMessage)) onEvent('item', { item: { type: 'agent_message', text: r.finalMessage }, phase: 'completed' });
    }
    // Loop runtimes already record 429s via the http_rate event (with retry-after); only Codex needs an explicit note.
    if (r.limitHit && s.runtime === 'codex') bus.publish('rate_limit', { provider: s.provider, info: { status: 'rejected', rateLimitType: 'codex', resetsAt: r.retryAfterMs ? (Date.now() + r.retryAfterMs) / 1000 : undefined } });
    const msg = { role: 'result', subtype: r.ok ? 'success' : 'error', isError: !r.ok, text: r.ok ? '' : (r.error || 'turn failed'), costUsd: 0, durationMs: Date.now() - t0, numTurns: 1, usage: r.usage ? { [s.model || s.provider]: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, cacheReadInputTokens: r.usage.cached_input_tokens || 0 } } : null };
    pushMessage(s, msg); emit(s, 'result', msg);
    if (!r.ok && !ac.signal.aborted) logImprovement('error', `conductor:${s.runtime}`, `turn failed: ${r.error}`, { sessionId: s.id, model: s.model });
  } catch (e) {
    const m = String(e?.message || e);
    if (!ac.signal.aborted) { emit(s, 'error', { message: m }); logImprovement('error', `conductor:${s.runtime}`, m, { sessionId: s.id }); }
    const msg = { role: 'result', subtype: 'error', isError: true, text: ac.signal.aborted ? 'interrupted' : m, durationMs: Date.now() - t0, numTurns: 1 };
    pushMessage(s, msg); emit(s, 'result', msg);
  } finally {
    if (mine()) { s.turnAbort = null; s.status = 'idle'; s.updatedAt = nowIso(); persistAll(); emit(s, 'status', { status: 'idle' }); }
    writeJson(HIST(s.id, 'messages'), s.messages);
  }
}

// ---------------------------------------------------------------- shared API
export async function sendMessage(sessionId, text) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  if (s.status === 'running' && s.runtime !== 'claude') throw Object.assign(new Error('the conductor is still working on the previous message; wait or press Stop'), { status: 409 });
  if (s.runtime === 'claude' && !s.query) start(s);
  if (s.title === 'New chat') { s.title = text.trim().slice(0, 60) || 'New chat'; }
  s.status = 'running'; s.updatedAt = nowIso(); persistAll();
  const msg = { role: 'user', text };
  pushMessage(s, msg); emit(s, 'user', msg); emit(s, 'status', { status: 'running' });
  if (s.runtime === 'claude') s.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: s.sdkSessionId || undefined });
  else void runTurn(s, text);
  return publicSession(s);
}

export async function interrupt(sessionId) {
  const s = sessions.get(sessionId); if (!s) return false;
  if (s.runtime !== 'claude') { s.turnAbort?.abort(); return !!s.turnAbort; }
  if (!s.query) return false;
  s.interrupted = true; // the SDK reports an interrupt as an error result; label it instead of logging it
  try { await s.query.interrupt(); } catch (e) { s.interrupted = false; emit(s, 'error', { message: `interrupt failed: ${e.message}` }); }
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
  s.effort = effort || null; persistAll();
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

/** Per-chat: may the router spend pay-per-token APIs once the subscription classes are capped? */
export function setOverflow(sessionId, on) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
  s.overflowApi = !!on; setSessionFlags(sessionId, { overflowApi: s.overflowApi }); persistAll();
  emit(s, 'updated', { session: publicSession(s) });
}

export async function setPermissionMode(sessionId, mode) {
  const s = sessions.get(sessionId); if (!s) throw Object.assign(new Error('unknown session'), { status: 404 });
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

export function stopSession(sessionId) {
  const s = sessions.get(sessionId); if (!s) return false;
  stop(s); s.status = 'idle'; emit(s, 'status', { status: 'idle' });
  return true;
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

/** Headless helper used by `conductor review`: run one prompt to completion, streaming text to a callback. */
export async function runOnce({ cwd, prompt: text, model, effort, onText }) {
  const s = createSession({ cwd, model, effort, title: text.slice(0, 60) });
  const done = new Promise((resolve) => {
    const h = (e) => { if (e.type !== 'session' || e.sessionId !== s.id) return; if (e.kind === 'delta' && e.block === 'text') onText?.(e.text); if (e.kind === 'assistant' && s.runtime !== 'claude') for (const b of e.blocks || []) if (b.type === 'text') onText?.(b.text + '\n'); if (e.kind === 'result' || e.kind === 'error') { bus.off('event', h); resolve(e); } };
    bus.on('event', h);
  });
  await sendMessage(s.id, text);
  const r = await done;
  stopSession(s.id);
  return r;
}

/** Keep the system prompt plus the most recent turns (cut at a user message so no tool reply is orphaned). */
export function trimHistory(messages, max = 160) {
  if (!Array.isArray(messages) || messages.length <= max) return messages;
  const sys = messages[0]?.role === 'system' ? [messages[0]] : [];
  let start = messages.length - max;
  while (start < messages.length && messages[start].role !== 'user') start++;
  return [...sys, ...messages.slice(start)];
}
