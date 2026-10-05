// Codex runtime: one `codex exec` turn per message (thread resumed). Tools come from the /mcp endpoint.
// runCodex is bound by ../conductor.mjs. The import stays there so the specifier `./workers/codex.mjs`
// resolves from a module URL containing `conductor.mjs` (test/conductor.test.mjs hooks that pair).
import { codexSandboxFor, runTimeoutMs } from '../config.mjs';
import { mcpServers } from '../mcp.mjs';
import { PROMPT, PROMPT_CODEX } from './prompt.mjs';

let serverUrl = 'http://127.0.0.1:47474';
export function setServerUrl(u) { serverUrl = u; }

let runCodex = null;
export function setRunCodex(fn) { runCodex = fn; }

export async function runCodexTurn(s, text, { cfg, ac, onEvent, mine }) {
  let r;
  const first = !s.threadId;
  const promptText = first ? `${PROMPT}\n\n${PROMPT_CODEX}\n\n# User request\n${text}` : text;
  const timeoutMs = runTimeoutMs(cfg.conductor.turnTimeoutMinutes);
  r = await runCodex({ id: `conductor:${s.id}`, cwd: s.cwd, prompt: promptText, model: s.model, effort: s.effort || undefined, sandbox: codexSandboxFor(s.model, cfg), network: cfg.worker.codexNetwork, resumeThreadId: s.threadId || undefined, mcp: { ...mcpServers(cfg), conductor: { url: `${serverUrl}/mcp/${s.id}` } }, signal: ac.signal, onEvent, ...(timeoutMs ? { timeoutMs } : {}) });
  if (mine()) s.threadId = r.threadId || s.threadId;
  return r;
}
