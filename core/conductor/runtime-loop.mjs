// Loop runtime: the OpenAI-compatible tool loop. History is compacted between turns.
import { readJson, writeJson } from '../paths.ts';
import { runTimeoutMs } from '../config.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import { conductorToolDefs, toolsAsFunctions } from '../tools.mjs';
import { runOpenAICompat } from '../workers/openai-compat.mjs';
import { compactForNextTurn, compactHistory, contextWindowFor, recordLearnedContextWindow, estimateTokens } from '../compaction.ts';
import { PROMPT, PROMPT_LOOP } from './prompt.mjs';
import { HIST, emit, honoredEffort } from './sessions.mjs';

export async function runLoopTurn(s, text, { cfg, ac, onEvent, mine }) {
  let r;
  const p = PROVIDERS[s.provider];
  const wc = p.workerConfig();
  if (mine() && s.history == null) s.history = readJson(HIST(s.id, 'loop'), null);
  const timeoutMs = runTimeoutMs(cfg.conductor.turnTimeoutMinutes);
  const compaction = compactForNextTurn({ history: s.history, prompt: text, provider: s.provider, model: s.model, lastPromptTokens: s.lastPromptTokens, lastRequestAt: s.lastRequestAt, config: cfg });
  if (mine() && compaction.reason) {
    s.history = compaction.history;
    writeJson(HIST(s.id, 'loop'), s.history);
    emit(s, 'compaction', { reason: compaction.reason, beforeTokens: compaction.beforeTokens, afterTokens: compaction.afterTokens });
  }
  const history = compaction.history;
  r = await runOpenAICompat({ id: `conductor:${s.id}`, cwd: s.cwd, prompt: text, history: history || undefined, system: `${PROMPT}\n\n${PROMPT_LOOP}`, model: s.model, effort: honoredEffort(s.provider, s.model, s.effort) || undefined, ...wc, provider: s.provider, extraTools: toolsAsFunctions(conductorToolDefs({ sessionId: s.id, cwd: s.cwd })).filter((x) => !(cfg.conductor.loopToolsSkip || []).includes(x.def.name)), signal: ac.signal, onEvent, maxIterations: cfg.conductor.maxTurns, ...(timeoutMs ? { timeoutMs } : {}) });
  if (mine()) {
    s.history = r.messages || history;
    s.lastPromptTokens = r.lastPromptTokens || r.lastRequestTokens || (s.history ? estimateTokens(s.history) : null);
    s.lastRequestAt = r.lastRequestAt || Date.now();
    writeJson(HIST(s.id, 'loop'), s.history);
  }
  if (r.error && /context (length|window)|maximum context|too many tokens|context_length_exceeded/i.test(r.error)) {
    recordLearnedContextWindow(s.provider, s.model, r.lastRequestTokens || r.lastPromptTokens || estimateTokens(history));
    if (s.history) {
      const window = contextWindowFor(s.provider, s.model, cfg);
      const compacted = compactHistory(s.history, window * Number(cfg.conductor.compactTo ?? 0.4));
      if (compacted.compacted) {
        s.history = compacted.messages;
        writeJson(HIST(s.id, 'loop'), s.history);
        emit(s, 'compaction', { reason: 'error', beforeTokens: r.lastRequestTokens || r.lastPromptTokens || compacted.beforeTokens, afterTokens: compacted.afterTokens });
      }
    }
    r.error += ' — the chat history no longer fits this model; start a new chat (history is kept on disk).';
  }
  if (r.ok && r.finalMessage && !s.messages.some((m) => m.role === 'assistant' && m.blocks?.[0]?.text === r.finalMessage)) onEvent('item', { item: { type: 'agent_message', text: r.finalMessage }, phase: 'completed' });
  return r;
}
