// Dispatch a task to the worker runtime for its provider and normalize the result shape.
import { getProvider } from '../providers/index.mjs';
import * as ollama from '../providers/ollama.mjs';
import { loadConfig } from '../config.mjs';
import { runCodex } from './codex.mjs';
import { runClaude } from './claude.mjs';
import { runOpenAICompat } from './openai-compat.mjs';
import { runImage } from './image.mjs';
import { runVendorCli } from './vendor-cli.mjs';
import { mcpServers, forClaudeSdk } from '../mcp.mjs';
import { readJson, writeJson, statePath } from '../paths.mjs';

/**
 * @param {object} t { id, cwd, prompt, provider, model, effort, threadId, timeoutMs, system, imageOptions }
 * @returns {Promise<{ok, threadId, finalMessage, items, usage, costUsd, error, limitHit, retryAfterMs, durationMs}>}
 */
export async function runWorker(t, { signal } = {}) {
  const p = getProvider(t.provider);
  const cfg = loadConfig();
  const mcp = mcpServers(cfg);
  const base = { id: t.id, cwd: t.cwd, prompt: t.prompt, model: t.model || undefined, effort: t.effort || undefined, signal, timeoutMs: t.timeoutMs, provider: p.id, mcp, mcpServers: forClaudeSdk(mcp), maxIterations: cfg.worker.maxIterations };
  let r;
  switch (p.kind) {
    case 'codex':
      r = await runCodex({ ...base, sandbox: t.sandbox || cfg.worker.codexSandbox, network: cfg.worker.codexNetwork, resumeThreadId: t.threadId || undefined });
      break;
    case 'claude':
      r = await runClaude({ ...base, permissionMode: cfg.worker.claudePermissionMode, resumeSessionId: t.threadId || undefined, maxTurns: cfg.worker.maxTurns || 500 });
      r.threadId = r.sessionId;
      break;
    case 'ollama': {
      await ollama.ensureRunning();
      if (cfg.providers.ollama?.harness === 'claude') {
        // Opt-in: run the local model through the Claude Code harness (needs Ollama's Anthropic API compat).
        r = await runClaude({ ...base, env: ollama.claudeHarnessEnv(), permissionMode: cfg.worker.claudePermissionMode, resumeSessionId: t.threadId || undefined, maxTurns: 60 });
        r.threadId = r.sessionId;
      } else {
        r = await withLoopHistory(t, (history) => runOpenAICompat({ ...base, baseUrl: `${ollama.baseUrl()}/v1`, apiKey: 'ollama', system: t.system, history }));
      }
      break;
    }
    case 'openai-compat':
      r = await withLoopHistory(t, (history) => runOpenAICompat({ ...base, ...p.workerConfig(), system: t.system, history }));
      break;
    case 'image':
      r = await runImage({ ...base, ...p.workerConfig(), ...(t.imageOptions || {}) });
      break;
    case 'vendor-cli':
      r = await runVendorCli(p.spec, { ...base, resumeThreadId: t.threadId || undefined });
      break;
    default:
      throw new Error(`provider ${p.id} has unknown kind ${p.kind}`);
  }
  return {
    ok: !!r.ok, threadId: r.threadId || null, finalMessage: r.finalMessage || '', items: r.items || [], usage: r.usage || null,
    costUsd: r.costUsd || 0, error: r.error || null, limitHit: !!r.limitHit, retryAfterMs: r.retryAfterMs || null, durationMs: r.durationMs || 0, files: r.files || undefined,
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
