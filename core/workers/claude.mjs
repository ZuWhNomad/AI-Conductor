// Claude-harness worker: a one-shot Agent SDK run. Also used for Ollama models, which speak the
// Anthropic Messages API natively, so local models get the full Claude Code toolset for free.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { bus } from '../bus.mjs';

const LIMIT_RE = /usage limit|rate limit|limit reached|too many requests|\b429\b/i;

// 2026-09-25: a worker ran `taskkill //F //IM node.exe` to stop its own script and killed the Conductor server.
// Killing by image or name hits every process of that name on the machine; only a PID the agent started is safe.
const KILL_BY_NAME = [
  /\btaskkill(\.exe)?\b[^;&|\n]*\s[/-]{1,2}(im|fi)\b/i,                               // taskkill /IM, //IM, -im, /FI "IMAGENAME eq …"
  /\b(stop-process|spps|kill)\b[^;&|\n]*\s-(name|processname)\b/i,                    // Stop-Process -Name node
  /\b(get-process|gps)\b(?![^|;\n]*\s-id\b)[^|;\n]*\|\s*(stop-process|spps|kill)\b/i, // Get-Process node | Stop-Process
  /(^|[\s;&|(`"'])(pkill|killall)(\.exe)?(\s|$)/i,
  /\bwmic\b[^;&|\n]*\bprocess\b[^;&|\n]*\bname\s*=/i,
];
export const killByNameDenied = (command) => typeof command === 'string' && KILL_BY_NAME.some((re) => re.test(command))
  ? 'Blocked by Conductor: never kill processes by name or image; it also kills the Conductor itself. Kill only a PID you started (taskkill /PID <pid> /T /F, Stop-Process -Id <pid>, kill <pid>).'
  : null;
// PreToolUse hooks run before the permission mode, so this holds under bypassPermissions; covers Bash, PowerShell, Monitor.
export const KILL_GUARD_HOOKS = { PreToolUse: [{ hooks: [async (input) => {
  const reason = killByNameDenied(input?.tool_input?.command);
  return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
}] }] };

/**
 * @param {object} t { id, cwd, prompt, model, effort, env, permissionMode, resumeSessionId, signal, maxTurns, timeoutMs, provider }
 */
export async function runClaude(t) {
  if (t.signal?.aborted) return { ok: false, error: 'aborted' };
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  t.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = t.timeoutMs ? setTimeout(() => abort.abort(), t.timeoutMs) : null;
  const res = { ok: false, provider: t.provider || 'claude', sessionId: t.resumeSessionId || null, finalMessage: '', items: [], usage: null, costUsd: 0, error: null, limitHit: false };
  const emit = (event, data) => bus.publish('worker', { taskId: t.id, provider: res.provider, event, ...data });
  const started = Date.now();
  const bypass = (t.permissionMode || 'bypassPermissions') === 'bypassPermissions';
  const readOnly = t.sandbox === 'read-only';
  let sawRejectedLimit = false;
  try {
    const q = query({
      prompt: t.prompt,
      options: {
        cwd: t.cwd,
        model: t.model || undefined,
        effort: t.effort || undefined,
        env: t.env ? { ...process.env, ...t.env } : undefined,
        permissionMode: bypass ? 'bypassPermissions' : (t.permissionMode || 'acceptEdits'),
        allowDangerouslySkipPermissions: bypass || undefined,
        permissionPrompts: 'none',
        resume: t.resumeSessionId || undefined,
        maxTurns: t.maxTurns || 500,
        settingSources: ['project'],
        mcpServers: t.mcpServers && Object.keys(t.mcpServers).length ? t.mcpServers : undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        abortController: abort,
        hooks: KILL_GUARD_HOOKS,
        // Agent SDK supports disallowedTools; read-only drops write/edit/Bash rather than relying on plan mode.
        ...(readOnly ? { disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit'] } : {}),
      },
    });
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') { res.sessionId = m.session_id; emit('session', { sessionId: m.session_id, model: m.model }); }
      else if (m.type === 'assistant') {
        if (m.error) { res.error = m.error; if (m.error === 'rate_limit') res.limitHit = true; }
        for (const b of m.message.content || []) {
          if (b.type === 'text' && b.text) { res.items.push({ type: 'agent_message', text: b.text }); emit('item', { item: { type: 'agent_message', text: b.text }, phase: 'completed' }); }
          if (b.type === 'tool_use') { res.items.push({ type: 'tool_use', name: b.name, input: b.input }); emit('item', { item: { type: 'tool_use', name: b.name, input: summarizeInput(b.input) }, phase: 'started' }); }
        }
      }
      else if (m.type === 'rate_limit_event') {
        const info = m.rate_limit_info || {};
        bus.publish('rate_limit', { provider: res.provider, info });
        const overage = !!(info.isUsingOverage || /overage/i.test(String(info.status || '')));
        if (info.status === 'rejected' && !overage) sawRejectedLimit = true;
      }
      else if (m.type === 'result') {
        res.finalMessage = m.subtype === 'success' ? m.result : (m.errors || []).join('; ');
        res.usage = m.modelUsage || m.usage || null; res.costUsd = m.total_cost_usd || 0;
        if (m.is_error || m.subtype !== 'success') res.error = res.error || res.finalMessage || m.subtype;
        // Only an ERROR result can mean a limit; a successful report that merely mentions "rate limit" must not park the task.
        if ((m.is_error || m.subtype !== 'success') && LIMIT_RE.test(res.finalMessage || '')) res.limitHit = true;
      }
    }
    res.ok = !res.error;
    if (res.ok) res.limitHit = false;
    else if (sawRejectedLimit) res.limitHit = true;
  } catch (e) {
    res.error = res.error || (abort.signal.aborted ? (t.timeoutMs ? 'timeout' : 'aborted') : String(e?.message || e));
    if (LIMIT_RE.test(res.error)) res.limitHit = true;
  } finally {
    if (timer) clearTimeout(timer);
    t.signal?.removeEventListener('abort', onAbort);
  }
  res.durationMs = Date.now() - started;
  return res;
}

function summarizeInput(input) {
  try { const s = JSON.stringify(input); return s.length > 300 ? s.slice(0, 300) + '…' : s; } catch { return ''; }
}
