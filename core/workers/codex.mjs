// Astra / GPT worker: drives `codex exec --json` (ChatGPT subscription) and parses its JSONL events.
import { spawnCodex, killTree, onLines } from '../proc.mjs';
import { bus } from '../bus.mjs';
import { codexMcpArgs } from '../mcp.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readTail } from '../paths.mjs';
import { logImprovement } from '../improve.mjs';

// Codex's own fixed usage-limit sentence, anchored at the start of the turn error (recorded in rollouts 2026-09-06..25:
// "You've hit your usage limit. Upgrade…", "… limit. Visit…", "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch…").
// Used only when the session log is missing, and logged; never a keyword set.
export const CODEX_USAGE_LIMIT = /^You've hit your usage limit(?: for \S+)?\.(?:\s|$)/;

/**
 * Deterministic failure class of a failed Codex turn: 'limit', 'auth' or null. No keyword matching. `codex exec --json`
 * carries only a message (turn.failed.error.message, codex-cli 0.153.4), so the structured signal is the session
 * rollout's `codex_error_info` (usage_limit_exceeded | unauthorized | http_connection_failed.http_status_code | other),
 * then a JSON error body's `status`, then the fixed prefix of Codex's HTTP client, "unexpected status NNN …".
 * 429 → limit; 401/403 → auth.
 */
export function codexFailure({ message = '', info = null } = {}) {
  if (info === 'usage_limit_exceeded') return 'limit';
  if (info === 'unauthorized') return 'auth';
  let status = Number(info?.http_connection_failed?.http_status_code) || null;
  const text = String(message || '').trim();
  if (!status && text.startsWith('{')) { try { status = Number(JSON.parse(text).status) || null; } catch {} }
  if (!status) status = Number(/^unexpected status (\d{3})\b/.exec(text)?.[1]) || null;
  return status === 429 ? 'limit' : status === 401 || status === 403 ? 'auth' : null;
}

/** codex_error_info of the last finished turn in the thread's rollout (~/.codex/sessions/Y/M/D/rollout-…-<thread>.jsonl). */
export function rolloutErrorInfo(threadId, home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId || '')) return null;
  const born = parseInt(threadId.replace(/-/g, '').slice(0, 12), 16); // UUIDv7: ms timestamp; the folder is its local date
  const pad = (n) => String(n).padStart(2, '0');
  for (const shift of [0, -1, 1]) {
    const d = new Date(born + shift * 86_400_000);
    const dir = join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    let name; try { name = readdirSync(dir).find((n) => n.endsWith(`${threadId}.jsonl`)); } catch {}
    if (!name) continue;
    for (const line of readTail(join(dir, name), 256 * 1024).split('\n').reverse()) {
      if (!line.includes('"task_complete"')) continue;
      try { const p = JSON.parse(line).payload; if (p?.type === 'task_complete') return p.error?.codex_error_info ?? null; } catch {}
    }
    return null;
  }
  return null;
}

/**
 * Run one Codex turn (new thread, or a follow-up on an existing thread).
 * @param {object} t
 * @param {string} t.id            task id (for events)
 * @param {string} t.cwd           project directory
 * @param {string} t.prompt        full prompt (sent on stdin)
 * @param {string} [t.model]       e.g. 'gpt-6-astra'
 * @param {string} [t.effort]      low|medium|high|xhigh|max|ultra
 * @param {string} [t.sandbox]     read-only|workspace-write|danger-full-access
 * @param {boolean} [t.network]    allow network in workspace-write
 * @param {string[]} [t.writableRoots] extra writable directories (codex exec --add-dir, 0.153.4)
 * @param {string} [t.resumeThreadId]
 * @param {AbortSignal} [t.signal]
 * @param {number} [t.timeoutMs]
 * @param {Record<string,{url:string}>} [t.mcp]   streamable-HTTP MCP servers to attach (conductor mode)
 * @param {(event:string, data:object)=>void} [t.onEvent]  extra listener besides the bus
 */
export function runCodex(t) {
  if (t.signal?.aborted) return Promise.resolve({ ok: false, error: 'aborted' });
  for (const [key, re] of [['model', /^[A-Za-z0-9._\-:\/\[\]]+$/], ['effort', /^[a-z]+$/]]) {
    if (t[key] != null && (typeof t[key] !== 'string' || !re.test(t[key]))) return Promise.resolve({ ok: false, error: `invalid model/effort: ${key}=${t[key]}` });
  }
  const sandbox = t.sandbox || 'workspace-write';
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-C', t.cwd,
    '-c', 'approval_policy="never"',
    '-c', `sandbox_workspace_write.network_access=${t.network === false ? 'false' : 'true'}`];
  if (t.effort) args.push('-c', `model_reasoning_effort="${t.effort}"`);
  if (t.model) args.push('-c', `model="${t.model}"`);
  const mcp = codexMcpArgs(t.mcp); // conductor endpoint and/or the conductor-wide registry (core/mcp.mjs)
  args.push(...mcp.args);
  for (const dir of t.writableRoots || []) args.push('--add-dir', dir);
  args.push('-s', sandbox);
  if (t.resumeThreadId) args.push('resume', t.resumeThreadId, '-');
  else args.push('-');

  return new Promise((resolve) => {
    const started = Date.now();
    const res = { ok: false, provider: 'codex', threadId: t.resumeThreadId || null, finalMessage: '', items: [], usage: null, error: null, lastError: null, warnings: [], limitHit: false, authFailed: false, exitCode: null, stderr: '' };
    let child;
    try { child = spawnCodex(args, { cwd: t.cwd, env: { ...process.env, ...mcp.env } }); }
    catch (e) { res.error = e.message; return resolve(res); }

    const items = new Map();
    const emit = (event, data) => { bus.publish('worker', { taskId: t.id, provider: 'codex', event, ...data }); t.onEvent?.(event, data); };

    onLines(child.stdout, (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      applyCodexEvent(ev, res, items, emit);
    });
    onLines(child.stderr, (line) => { res.stderr = (res.stderr + line + '\n').slice(-4000); });

    const timer = t.timeoutMs ? setTimeout(() => { res.error = `timeout after ${t.timeoutMs}ms`; killTree(child); }, t.timeoutMs) : null;
    const onAbort = () => { res.error = res.error || 'aborted'; killTree(child); };
    t.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => { res.error = e.message; });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      t.signal?.removeEventListener('abort', onAbort);
      res.exitCode = code;
      res.items = [...items.values()];
      res.ok = code === 0 && !res.error;
      if (!res.ok && !res.error) res.error = `codex exited with code ${code}${res.lastError ? ` — ${res.lastError}` : ''}${res.stderr ? `: ${res.stderr.trim().slice(-500)}` : ''}`;
      // Error items/events are warnings; a 429 retry notice must not fail a successful run or trigger failover.
      const info = res.ok || !res.threadId ? null : rolloutErrorInfo(res.threadId, t.codexHome);
      let kind = res.ok ? null : codexFailure({ message: res.turnError || res.error, info });
      if (!res.ok && !kind && info == null && CODEX_USAGE_LIMIT.test(res.turnError || '')) {
        kind = 'limit';
        try { logImprovement('friction', 'worker:codex', 'usage limit recognised from the fixed Codex message: no session log (codex_error_info) for this thread', { taskId: t.id, threadId: res.threadId }); } catch {}
      }
      res.limitHit = kind === 'limit';
      res.authFailed = kind === 'auth';
      if (res.authFailed) res.error += ' — sign in again: codex login';
      res.durationMs = Date.now() - started;
      resolve(res);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(t.prompt);
  });
}

/** Fold one `codex exec --json` event into the result. Exported for tests. */
export function applyCodexEvent(ev, res, items, emit = () => {}) {
  switch (ev.type) {
    case 'thread.started': res.threadId = ev.thread_id; emit('thread', { threadId: ev.thread_id }); break;
    case 'turn.started': emit('turn.started', {}); break;
    case 'item.started': case 'item.updated': case 'item.completed': {
      const it = ev.item; if (!it) break;
      items.set(it.id, summarizeItem(it));
      if (it.type === 'agent_message' && ev.type === 'item.completed') res.finalMessage = it.text || res.finalMessage;
      if (it.type === 'error') noteCodexWarning(res, it.message);
      emit('item', { item: summarizeItem(it), phase: ev.type.split('.')[1] });
      break;
    }
    case 'turn.completed': res.usage = ev.usage || null; emit('turn.completed', { usage: ev.usage }); break;
    case 'turn.failed': res.error = res.turnError = ev.error?.message || 'turn failed'; if (codexFailure({ message: res.error }) === 'limit') res.limitHit = true; emit('turn.failed', { error: res.error }); break;
    case 'error': noteCodexWarning(res, ev.message); emit('error', { error: ev.message }); break;
    default: break;
  }
}

function noteCodexWarning(res, message) {
  const text = message || '';
  res.lastError = text || res.lastError;
  (res.warnings ||= []).push(text);
}

export function summarizeItem(it) {
  const s = { id: it.id, type: it.type, status: it.status };
  if (it.type === 'agent_message') s.text = it.text;
  if (it.type === 'reasoning') s.text = it.text;
  if (it.type === 'command_execution') { s.command = it.command; s.exitCode = it.exit_code; s.output = (it.aggregated_output || '').slice(-2000); }
  if (it.type === 'file_change') s.changes = it.changes;
  if (it.type === 'error') s.message = it.message;
  if (it.type === 'mcp_tool_call') { s.server = it.server; s.tool = it.tool; s.args = it.arguments; s.result = it.result != null ? (typeof it.result === 'string' ? it.result : JSON.stringify(it.result)).slice(0, 4000) : undefined; s.error = it.error ? (it.error.message || String(it.error)) : undefined; }
  if (it.type === 'web_search') s.query = it.query;
  return s;
}
