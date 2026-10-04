// Model context sizes, prompt-size estimates and deterministic conversation compaction.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, statePath, writeJson, REPO_ROOT } from './paths.mjs';
import { loadConfig } from './config.mjs';

/** One chat-completions style message. `content` may be a string or text blocks; some runtimes use `text` / `blocks`. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | string;
  content?: string | Array<{ text?: string } | null | undefined>;
  text?: string;
  blocks?: Array<{ type?: string; text?: string } | null | undefined>;
}

/** The slice of config.json this module reads. */
export interface CompactionConfig {
  models?: { contextWindows?: Record<string, number | string> };
  conductor?: {
    cacheLifetimes?: Record<string, number | 'never' | string>;
    compactAt?: number;
    compactTo?: number;
  };
}

export interface CompactResult {
  messages: ChatMessage[];
  beforeTokens: number;
  afterTokens: number;
  compacted: boolean;
}

export type CompactReason = 'idle' | 'size' | null;

export interface CompactForNextTurnInput {
  history: ChatMessage[];
  prompt: unknown;
  provider: string;
  model: string | null | undefined;
  lastPromptTokens?: number | null;
  lastRequestAt?: number | null;
  now?: number;
  config?: CompactionConfig;
}

export interface CompactForNextTurnResult {
  history: ChatMessage[];
  reason: CompactReason;
  beforeTokens: number;
  afterTokens: number;
}

const SHIPPED: Record<string, number | string> = JSON.parse(readFileSync(join(REPO_ROOT, 'core', 'policy', 'context-windows.json'), 'utf8'));
const CACHE_TTL_MS: Record<string, number> = {
  anthropic: 5 * 60_000, claude: 5 * 60_000,
  codex: 60 * 60_000, // measured 2026-09-27: >=96% cached after 15-51 min idle, gone by ~86 min (15k Codex requests)
  grok: 10 * 60_000,
  deepseek: 60 * 60_000,
};
const keyFor = (provider: string, model: string | null | undefined): string => `${provider}:${model || 'default'}`;
const positive = (v: unknown): number | null => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

export function contextWindowFor<F = number>(provider: string, model: string | null | undefined, config: CompactionConfig = loadConfig(), fallback: F = 128_000 as F): number | F {
  const key = keyFor(provider, model);
  const override = positive(config?.models?.contextWindows?.[key]);
  if (override) return override;
  const learned: Record<string, unknown> = readJson(statePath('context-windows.json'), {});
  const known = positive(learned[key]);
  if (known) return known;
  const exact = positive(SHIPPED[key]);
  if (exact) return exact;
  for (const [pattern, value] of Object.entries(SHIPPED)) {
    if (pattern.endsWith(':*') && provider === pattern.slice(0, -2) && Number.isFinite(Number(value))) return Number(value);
    if (pattern.startsWith(`${provider}:~`) && model && new RegExp(pattern.slice(provider.length + 2)).test(model) && Number.isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

export function cacheLifetimeFor(provider: string, config: CompactionConfig = loadConfig()): number {
  const configured = config.conductor?.cacheLifetimes?.[provider];
  if (configured === 'never' || configured === Infinity) return Infinity;
  if (Number.isFinite(Number(configured)) && Number(configured) >= 0) return Number(configured) * 60_000;
  return CACHE_TTL_MS[provider] ?? Infinity;
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}

export function recordLearnedContextWindow(provider: string, model: string | null | undefined, requestTokens: unknown): number | null {
  const n = Math.ceil(Number(requestTokens));
  if (!(n > 0)) return null;
  const file = statePath('context-windows.json');
  const learned: Record<string, number> = readJson(file, {});
  learned[keyFor(provider, model)] = n;
  writeJson(file, learned);
  return n;
}

const textOf = (m: ChatMessage | null | undefined): string => {
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.map((x) => x?.text || '').join('');
  if (typeof m?.text === 'string') return m.text;
  if (Array.isArray(m?.blocks)) return m.blocks.filter((b) => b?.type === 'text').map((b) => b?.text || '').join('');
  return '';
};
const clip = (s: unknown, n: number): string => String(s || '').slice(0, n);

interface Turn { user: string; assistant: string }

function digestTurns(messages: ChatMessage[]): Turn[] {
  const turns: Turn[] = [];
  let turn: Turn | null = null;
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

const formatDigest = (dropped: ChatMessage[]): string =>
  `[Earlier conversation, compacted]\n${digestTurns(dropped).map((t) => `- User: ${clip(t.user, 300)}\n  Assistant: ${clip(t.assistant, 500)}`).join('\n')}`;

export function compactHistory(messages: ChatMessage[], targetTokens: number): CompactResult {
  if (!Array.isArray(messages) || messages.length < 3) return { messages, beforeTokens: estimateTokens(messages), afterTokens: estimateTokens(messages), compacted: false };
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const bodyStart = system.length;
  const boundaries: number[] = [];
  for (let i = bodyStart; i < messages.length; i++) if (messages[i].role === 'user') boundaries.push(i);
  if (boundaries.length < 2) return { messages, beforeTokens: estimateTokens(messages), afterTokens: estimateTokens(messages), compacted: false };
  const beforeTokens = estimateTokens(messages);
  let start = -1;
  for (const candidate of boundaries.slice(1)) {
    const next = [...system, { role: 'user', content: formatDigest(messages.slice(bodyStart, candidate)) }, ...messages.slice(candidate)];
    if (estimateTokens(next) <= targetTokens) { start = candidate; break; }
  }
  if (start < 0) start = boundaries.at(-1)!;
  const compacted = [...system, { role: 'user', content: formatDigest(messages.slice(bodyStart, start)) }, ...messages.slice(start)];
  return { messages: compacted, beforeTokens, afterTokens: estimateTokens(compacted), compacted: true };
}

export function compactForNextTurn({ history, prompt, provider, model, lastPromptTokens, lastRequestAt, now = Date.now(), config = loadConfig() }: CompactForNextTurnInput): CompactForNextTurnResult {
  const window = contextWindowFor(provider, model, config);
  const promptEstimate = estimateTokens(prompt);
  const beforeTokens = (Number(lastPromptTokens) || estimateTokens(history)) + promptEstimate;
  const compactAt = Number(config.conductor?.compactAt ?? 0.7);
  const compactTo = Number(config.conductor?.compactTo ?? 0.4);
  const ttl = cacheLifetimeFor(provider, config);
  const idle = Number.isFinite(ttl) && Number(lastRequestAt) > 0 && now - Number(lastRequestAt) > ttl;
  const reason: CompactReason = idle && beforeTokens > compactTo * window ? 'idle' : beforeTokens > compactAt * window ? 'size' : null;
  if (!reason) return { history, reason: null, beforeTokens, afterTokens: beforeTokens };
  const targetHistory = Math.max(0, compactTo * window - promptEstimate);
  const result = compactHistory(history, targetHistory);
  return { history: result.messages, reason: result.compacted ? reason : null, beforeTokens, afterTokens: result.afterTokens + promptEstimate };
}

export const cacheLifetimes: Readonly<Record<string, number>> = Object.freeze({ ...CACHE_TTL_MS });
