// Dispatch a task to the worker runtime for its provider and normalize the result shape.
import { getProvider } from '../providers/index.mjs';
import { loadConfig } from '../config.mjs';
import { runCodex } from './codex.mjs';
import { runClaude } from './claude.mjs';
import { runOpenAICompat } from './openai-compat.mjs';
import { runVendorCli } from './vendor-cli.mjs';
import { mcpServersFor, forClaudeSdk } from '../mcp.mjs';
import { readJson, writeJson, statePath, redactDeep } from '../paths.mjs';

/**
 * @param {object} t { id, cwd, prompt, provider, model, effort, threadId, timeoutMs, system }
 * @returns {Promise<{ok, threadId, finalMessage, items, usage, costUsd, error, limitHit, authFailed, retryAfterMs, durationMs}>}
 */
export async function runWorker(t, { signal } = {}) {
  const p = getProvider(t.provider);
  const cfg = loadConfig();
  const mcp = mcpServersFor(t.category, cfg); // scoped by category: a data MCP is not loaded into a refactor
  const base = { id: t.id, cwd: t.cwd, prompt: t.prompt, model: t.model || undefined, effort: t.effort || undefined, signal, timeoutMs: t.timeoutMs, provider: p.id, mcp, mcpServers: forClaudeSdk(mcp), maxIterations: cfg.worker.maxIterations, sandbox: t.sandbox || null, writableRoots: t.writableRoots || [] };
  let r;
  switch (p.kind) {
    case 'codex':
      r = await runCodex({ ...base, sandbox: t.sandbox || cfg.worker.codexSandbox, network: cfg.worker.codexNetwork, resumeThreadId: t.threadId || undefined });
      break;
    case 'claude':
      r = await runClaude({ ...base, permissionMode: cfg.worker.claudePermissionMode, resumeSessionId: t.threadId || undefined, maxTurns: cfg.worker.maxTurns });
      r.threadId = r.sessionId;
      break;
    case 'openai-compat':
      r = await withLoopHistory(t, (history) => runOpenAICompat({ ...base, ...p.workerConfig(), system: t.system, history }));
      break;
    case 'vendor-cli':
      r = await runVendorCli(p.spec, { ...base, resumeThreadId: t.threadId || undefined });
      break;
    default:
      throw new Error(`provider ${p.id} has unknown kind ${p.kind}`);
  }
  // Redacted at the source: a CLI can echo a key (OpenAI's 401 names the key it was given), and this result feeds the
  // task record, the conductor's report and the scorecard.
  return {
    ok: !!r.ok, threadId: r.threadId || null, finalMessage: redactDeep(r.finalMessage || ''), items: redactDeep(r.items || []), usage: r.usage || null,
    costUsd: r.costUsd || 0, error: redactDeep(r.error || null), limitHit: !!r.limitHit, authFailed: !!r.authFailed, envFailed: !!r.envFailed, retryAfterMs: r.retryAfterMs || null, durationMs: r.durationMs || 0, files: r.files || undefined,
    turns: Number.isInteger(r.turns) ? r.turns : null, httpStatus: Number.isInteger(r.httpStatus) ? r.httpStatus : null, exitCode: Number.isInteger(r.exitCode) ? r.exitCode : null, timedOut: typeof r.timedOut === 'boolean' ? r.timedOut : null,
  };
}

/**
 * Chat-completions loops have no server-side thread, so the conversation is kept on disk per thread (the first task's
 * id) and replayed on follow-ups; the result carries threadId so fix rounds work like they do for codex/claude.
 */
async function withLoopHistory(t, run) {
  const threadId = t.threadId || t.id;
  const history = t.threadId ? readJson(statePath('history', `${threadId}.worker.json`), null) : null;
  const r = await run(history?.length ? history : undefined);
  if (r.messages?.length) { try { writeJson(statePath('history', `${threadId}.worker.json`), r.messages); } catch {} }
  r.threadId = threadId;
  return r;
}
