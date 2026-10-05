// Claude runtime: one long-lived Agent SDK query per session. Streaming input goes through Inbox.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadConfig } from '../config.mjs';
import { bus } from '../bus.mjs';
import { mcpServers, forClaudeSdk } from '../mcp.mjs';
import { conductorTools, CONDUCTOR_AGENTS } from '../tools.mjs';
import { logImprovement } from '../improve.mjs';
import { KILL_GUARD_HOOKS } from '../workers/claude.mjs';
import { spawnTracked } from '../proc.mjs';
import { nowIso, shortId } from '../paths.mjs';
import { markUnavailable } from '../models.mjs';
import { PROMPT } from './prompt.mjs';
import { emit, persistAll, publicSession, pushMessage, stop } from './sessions.mjs';

const REQUIRED_VERSION_RE = /version\s+(\d+\.\d+\.\d+)\s+or newer is required/i;
function noteRequiredVersion(s, message) {
  const version = String(message || '').match(REQUIRED_VERSION_RE)?.[1];
  if (!version) return false;
  if (markUnavailable(s.provider || 'claude', s.model, String(message))) logImprovement('friction', `conductor:${s.runtime}`, `update @anthropic-ai/claude-agent-sdk (needs Claude Code >= ${version})`, { sessionId: s.id, model: s.model });
  return true;
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

// ---------------------------------------------------------------- claude runtime
export function start(s) {
  const abort = new AbortController();
  const inbox = new Inbox();
  const bypass = s.permissionMode === 'bypassPermissions';
  const servers = forClaudeSdk(mcpServers());
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
      mcpServers: { ...servers, conductor: conductorTools({ sessionId: s.id, cwd: s.cwd }) },
      strictMcpConfig: true,
      allowedTools: ['mcp__conductor', ...Object.keys(servers).map((n) => `mcp__${n}`)],
      agents: CONDUCTOR_AGENTS,
      settingSources: ['user', 'project', 'local'],
      resume: s.sdkSessionId || undefined,
      abortController: abort,
      spawnClaudeCodeProcess: (options) => spawnTracked(`conductor:${s.id}`, options),
      hooks: KILL_GUARD_HOOKS,
      maxTurns: loadConfig().conductor.maxTurns,
      title: s.title !== 'New chat' ? s.title : undefined,
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'conductor/2.0.0' },
    },
  });
  s.query = q; s.inbox = inbox; s.abort = abort;
  void pump(s, q);
}

async function pump(s, q) {
  let streaming = null; // { block: 'text'|'thinking', text, parent }
  const abort = s.abort; // captured: stop() clears s.abort before the catch below runs
  try {
    for await (const m of q) {
      // An SDK-initiated turn (subagent wake) has no user message: mark running on first non-result event.
      if (m.type !== 'result' && s.status === 'idle') { s.status = 'running'; emit(s, 'status', { status: 'running' }); }
      if (m.type === 'system' && m.subtype === 'init') {
        s.sdkSessionId = m.session_id; s.updatedAt = nowIso(); persistAll();
        emit(s, 'init', { sdkSessionId: m.session_id, model: m.model, permissionMode: m.permissionMode, tools: m.tools?.length || 0, agents: m.agents || [] });
      } else if (m.type === 'stream_event') {
        const e = m.event;
        if (e.type === 'content_block_start') {
          streaming = { block: e.content_block?.type, text: '', parent: m.parent_tool_use_id };
          if (streaming.block === 'thinking') emit(s, 'delta', { block: 'thinking', text: '', parent: streaming.parent });
        } else if (e.type === 'content_block_delta') {
          const d = e.delta;
          if (d?.type === 'thinking_delta') {
            if (!streaming) { streaming = { block: 'thinking', text: '', parent: m.parent_tool_use_id }; emit(s, 'delta', { block: 'thinking', text: '', parent: streaming.parent }); }
            streaming.text += d.thinking || '';
          } else if (d?.type === 'text_delta' && d.text != null) {
            streaming = streaming || { block: 'text', text: '', parent: m.parent_tool_use_id };
            streaming.text += d.text;
            emit(s, 'delta', { block: streaming.block, text: d.text, parent: m.parent_tool_use_id });
          }
        } else if (e.type === 'content_block_stop') { streaming = null; }
      } else if (m.type === 'assistant') {
        const blocks = (m.message.content || []).map((b) => b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b.type === 'thinking' ? { type: 'thinking', text: b.thinking || '' } : { type: b.type });
        const msg = { role: 'assistant', blocks, parent: m.parent_tool_use_id, error: m.error || null, subagent: m.subagent_type || null, usage: m.message?.usage || null };
        pushMessage(s, msg); emit(s, 'assistant', msg);
        noteRequiredVersion(s, m.error);
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
        const more = (m.queued_turn_count || 0) > 0;
        if (!more) { s.status = 'idle'; s.turn = null; }
        s.costUsd = m.total_cost_usd || s.costUsd; s.updatedAt = nowIso(); persistAll();
        const msg = { role: 'result', subtype: m.subtype, isError: !!m.is_error, text: m.subtype === 'success' && !m.is_error ? '' : (m.errors?.length ? m.errors : [m.result]).filter(Boolean).join('; '), costUsd: m.total_cost_usd, durationMs: m.duration_ms, numTurns: m.num_turns, usage: m.modelUsage || null };
        if (s.interrupted) { msg.subtype = 'interrupted'; msg.text = s.interrupted; s.interrupted = false; }
        pushMessage(s, msg); emit(s, 'result', msg); emit(s, 'status', { status: s.status });
        noteRequiredVersion(s, msg.text);
        if (m.is_error && msg.subtype !== 'interrupted') logImprovement('error', 'conductor', `result error: ${msg.text || m.subtype}`, { sessionId: s.id });
        if (s.restartPending && !more) { // e.g. effort/permission mode changed: restart the process (same session) without losing queued messages
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
    noteRequiredVersion(s, msg);
    if (!abort?.signal.aborted && !/aborted/i.test(msg)) {
      emit(s, 'error', { message: msg });
      logImprovement('error', 'conductor', `session loop error: ${msg}`, { sessionId: s.id });
    }
  } finally {
    if (s.query === q) { s.query = null; s.inbox = null; s.abort = null; s.restartPending = false; }
    if (s.query === q || s.query == null) { s.status = 'idle'; emit(s, 'status', { status: 'idle' }); }
  }
}

function askPermission(s, toolName, input, o) {
  return new Promise((resolve) => {
    const id = o.requestId || o.toolUseID || shortId();
    const request = { id, toolName, input, description: o.description || o.title || '', decisionReason: o.decisionReason || '', agentID: o.agentID || null, ts: Date.now() };
    s.pending.set(id, { request, resolve });
    emit(s, 'permission', { request });
    emit(s, 'updated', { session: publicSession(s) });
    o.signal?.addEventListener('abort', () => { if (s.pending.delete(id)) { resolve({ behavior: 'deny', message: 'request aborted' }); emit(s, 'permission_resolved', { id }); emit(s, 'updated', { session: publicSession(s) }); } }, { once: true });
  });
}
