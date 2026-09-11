// Claude-harness worker: a one-shot Agent SDK run. Also used for Ollama models, which speak the
// Anthropic Messages API natively, so local models get the full Claude Code toolset for free.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { bus } from '../bus.mjs';

const LIMIT_RE = /usage limit|rate limit|limit reached|too many requests|\b429\b/i;

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
        maxTurns: t.maxTurns || 150,
        settingSources: ['project'],
        mcpServers: t.mcpServers && Object.keys(t.mcpServers).length ? t.mcpServers : undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        abortController: abort,
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
      else if (m.type === 'rate_limit_event') { bus.publish('rate_limit', { provider: res.provider, info: m.rate_limit_info }); if (m.rate_limit_info?.status === 'rejected') res.limitHit = true; }
      else if (m.type === 'result') {
        res.finalMessage = m.subtype === 'success' ? m.result : (m.errors || []).join('; ');
        res.usage = m.modelUsage || m.usage || null; res.costUsd = m.total_cost_usd || 0;
        if (m.is_error || m.subtype !== 'success') res.error = res.error || res.finalMessage || m.subtype;
        // Only an ERROR result can mean a limit; a successful report that merely mentions "rate limit" must not park the task.
        if ((m.is_error || m.subtype !== 'success') && LIMIT_RE.test(res.finalMessage || '')) res.limitHit = true;
      }
    }
    res.ok = !res.error;
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
