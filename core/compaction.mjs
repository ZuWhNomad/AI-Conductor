// Model context sizes, prompt-size estimates and deterministic conversation compaction.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, statePath, writeJson, REPO_ROOT } from './paths.mjs';
import { loadConfig } from './config.mjs';

const SHIPPED = JSON.parse(readFileSync(join(REPO_ROOT, 'core', 'policy', 'context-windows.json'), 'utf8'));
const CACHE_TTL_MS = {
  anthropic: 5 * 60_000, claude: 5 * 60_000,
  openai: 10 * 60_000, codex: 10 * 60_000,
  xai: 10 * 60_000, grok: 10 * 60_000,
  moonshot: 5 * 60_000, kimi: 5 * 60_000,
  qwen: 5 * 60_000, 'qwen-code': 5 * 60_000,
  gemini: 10 * 60_000, deepseek: 60 * 60_000, ollama: Infinity,
};
const keyFor = (provider, model) => `${provider}:${model || 'default'}`;

export function contextWindowFor(provider, model, config = loadConfig()) {
  const key = keyFor(provider, model);
  const override = config.models?.contextWindows?.[key];
  if (Number.isFinite(Number(override)) && Number(override) > 0) return Number(override);
  const learned = readJson(statePath('context-windows.json'), {});
  if (Number.isFinite(Number(learned[key])) && Number(learned[key]) > 0) return Number(learned[key]);
  const exact = SHIPPED[key];
  if (Number.isFinite(Number(exact)) && Number(exact) > 0) return Number(exact);
  for (const [pattern, value] of Object.entries(SHIPPED)) {
    if (pattern.endsWith(':*') && provider === pattern.slice(0, -2) && Number.isFinite(Number(value))) return Number(value);
    if (pattern.startsWith(`${provider}:~`) && model && new RegExp(pattern.slice(provider.length + 2)).test(model) && Number.isFinite(Number(value))) return Number(value);
  }
  return 128_000;
}

export function cacheLifetimeFor(provider, config = loadConfig()) {
  const configured = config.conductor?.cacheLifetimes?.[provider];
  if (configured === 'never' || configured === Infinity) return Infinity;
  if (Number.isFinite(Number(configured)) && Number(configured) >= 0) return Number(configured) * 60_000;
  return CACHE_TTL_MS[provider] ?? Infinity;
}

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

export function recordLearnedContextWindow(provider, model, requestTokens) {
  const n = Math.ceil(Number(requestTokens));
  if (!(n > 0)) return null;
  const file = statePath('context-windows.json');
  const learned = readJson(file, {});
  learned[keyFor(provider, model)] = n;
  writeJson(file, learned);
  return n;
}

const textOf = (m) => {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.map((x) => x?.text || '').join('');
  if (typeof m?.text === 'string') return m.text;
  if (Array.isArray(m?.blocks)) return m.blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
  return '';
};
const clip = (s, n) => String(s || '').slice(0, n);

function digestTurns(messages) {
  const turns = [];
  let turn = null;
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      if (turn) turns.push(turn);
      const text = textOf(m);
      if (text.startsWith('[Earlier conversation, compacted]')) {
        turn = null;
        for (const match of text.matchAll(/^- User: ([\s\S]*?)\n  Assistant: ([\s\S]*?)(?=\n- User: |$)/gm)) turns.push({ user: match[1], assistant: match[2] });
      } else turn = { user: text, assistant: '' };
    } else if (turn && m.role === 'assistant') {
      const text = textOf(m);
      if (text) turn.assistant = text;
    }
  }
  if (turn) turns.push(turn);
  return turns;
}

export function compactHistory(messages, targetTokens) {
  if (!Array.isArray(messages) || messages.length < 3) return { messages, beforeTokens: estimateTokens(messages), afterTokens: estimateTokens(messages), compacted: false };
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const bodyStart = system.length;
  const boundaries = [];
  for (let i = bodyStart; i < messages.length; i++) if (messages[i].role === 'user') boundaries.push(i);
  if (boundaries.length < 2) return { messages, beforeTokens: estimateTokens(messages), afterTokens: estimateTokens(messages), compacted: false };
  const beforeTokens = estimateTokens(messages);
  let start = -1;
  for (const candidate of boundaries.slice(1)) {
    const dropped = messages.slice(bodyStart, candidate);
    const digest = digestTurns(dropped);
    const formatted = `[Earlier conversation, compacted]\n${digest.map((t) => `- User: ${clip(t.user, 300)}\n  Assistant: ${clip(t.assistant, 500)}`).join('\n')}`;
    const next = [...system, { role: 'user', content: formatted }, ...messages.slice(candidate)];
    if (estimateTokens(next) <= targetTokens) { start = candidate; break; }
  }
  if (start < 0) start = boundaries.at(-1);
  const dropped = messages.slice(bodyStart, start);
  const digest = digestTurns(dropped);
  const formatted = `[Earlier conversation, compacted]\n${digest.map((t) => `- User: ${clip(t.user, 300)}\n  Assistant: ${clip(t.assistant, 500)}`).join('\n')}`;
  const compacted = [...system, { role: 'user', content: formatted }, ...messages.slice(start)];
  return { messages: compacted, beforeTokens, afterTokens: estimateTokens(compacted), compacted: true };
}

export function compactForNextTurn({ history, prompt, provider, model, lastPromptTokens, lastRequestAt, now = Date.now(), config = loadConfig() }) {
  const window = contextWindowFor(provider, model, config);
  const promptEstimate = estimateTokens(prompt);
  const beforeTokens = (Number(lastPromptTokens) || estimateTokens(history)) + promptEstimate;
  const compactAt = Number(config.conductor?.compactAt ?? 0.7);
  const compactTo = Number(config.conductor?.compactTo ?? 0.4);
  const ttl = cacheLifetimeFor(provider, config);
  const idle = Number.isFinite(ttl) && Number(lastRequestAt) > 0 && now - Number(lastRequestAt) > ttl;
  const reason = idle && beforeTokens > compactTo * window ? 'idle' : beforeTokens > compactAt * window ? 'size' : null;
  if (!reason) return { history, reason: null, beforeTokens, afterTokens: beforeTokens };
  const targetHistory = Math.max(0, compactTo * window - promptEstimate);
  const result = compactHistory(history, targetHistory);
  return { history: result.messages, reason: result.compacted ? reason : null, beforeTokens, afterTokens: result.afterTokens + promptEstimate };
}

export const cacheLifetimes = Object.freeze({ ...CACHE_TTL_MS });
