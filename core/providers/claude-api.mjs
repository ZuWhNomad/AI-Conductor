// Claude on an Anthropic API key (pay per token, from the account's API credits). Same Agent SDK harness as the
// subscription provider (kind 'claude'), but every run gets its own Claude config folder: in the normal one the CLI
// keeps its claude.ai login and ignores ANTHROPIC_API_KEY and apiKeyHelper (measured 2026-10-17). The key reaches the
// CLI through an apiKeyHelper that reads config.json at call time, so it is never in argv, the child's env or a log.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { statePath } from '../paths.ts';
import { effortsFor } from './anthropic.mjs';

export const id = 'claude-api';
export const label = 'Claude (Anthropic API, billed per token)';
export const kind = 'claude';
export const url = 'https://console.anthropic.com/settings/billing';
export const auth = { type: 'apiKey', setup: 'Paste an Anthropic API key in Settings. Every task is billed per token to that account\'s API credits.' };
/** Same models, same harness: the subscription's scorecard evidence stands for this provider until it has its own. */
export const evidenceOf = 'claude';

const API = 'https://api.anthropic.com/v1';
export const NO_CREDIT_RE = /credit balance is too low/i;
const NO_CREDIT = 'API credit balance is too low: add credits at console.anthropic.com/settings/billing';
const HELPER = fileURLToPath(new URL('./claude-api-key.mjs', import.meta.url));
// What a server started from inside a Claude session inherits: credentials (ANTHROPIC_API_KEY / AUTH_TOKEN,
// CLAUDE_CODE_OAUTH_TOKEN), the host's account and proxy (ANTHROPIC_BASE_URL) and its entrypoint: with
// CLAUDE_CODE_ENTRYPOINT=claude-desktop the CLI answered every key run "Credit balance is too low" while the same key
// worked on the API and in a clean env (measured 2026-10-18). Any of them beats the helper or bills the wrong account.
const HOST_ENV = /^ANTHROPIC_|^CLAUDE_CODE_(ENTRYPOINT|OAUTH|ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|SDK_HAS_HOST_AUTH)/;

export const apiKey = () => loadConfig().providers[id]?.apiKey || null;
const headers = (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });

/** What runClaude adds for this provider: the key-free config folder, the helper, and no inherited credentials. */
export function workerOptions() {
  const dir = statePath('claude-api');
  mkdirSync(dir, { recursive: true });
  return {
    env: { ...Object.fromEntries(Object.keys(process.env).filter((k) => HOST_ENV.test(k)).map((k) => [k, undefined])), CLAUDE_CONFIG_DIR: dir },
    settings: { apiKeyHelper: `"${process.execPath}" "${HELPER}"` },
  };
}

async function apiModels(key) {
  const r = await fetch(`${API}/models?limit=100`, { headers: headers(key), signal: AbortSignal.timeout(10_000) });
  if (r.status === 401 || r.status === 403) return { authFailed: `API key rejected (${r.status})` };
  if (!r.ok) throw new Error(`claude-api: models ${r.status}`);
  return { data: (await r.json()).data || [] };
}

/**
 * Credit status. The Models API and count_tokens answer without credit, so a 1-token call on the cheapest listed
 * model (a Haiku: ~$0.000001) is the only probe. Cached for a minute: detect and pollLimits both ask.
 */
let probed = { at: 0, key: null, value: null };
export async function creditStatus(key = apiKey()) {
  if (!key) return { ok: false, status: 'unavailable', error: 'no API key' };
  if (probed.key === key && Date.now() - probed.at < 60_000) return probed.value;
  const listed = await apiModels(key);
  let value;
  if (listed.authFailed) value = { ok: false, status: 'unavailable', error: listed.authFailed };
  else {
    const ids = listed.data.map((m) => m.id);
    const model = ids.find((m) => /haiku/.test(m)) || ids.at(-1);
    const r = await fetch(`${API}/messages`, { method: 'POST', headers: headers(key), body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(15_000) });
    const text = r.ok ? '' : await r.text();
    if (NO_CREDIT_RE.test(text)) value = { ok: false, status: 'no-credit', error: NO_CREDIT };
    else if (r.status === 401 || r.status === 403) value = { ok: false, status: 'unavailable', error: `API key rejected (${r.status})` };
    else value = { ok: true }; // 429 / 5xx: the key and its credit are fine, the API is busy
  }
  probed = { at: Date.now(), key, value };
  return value;
}

export async function detect() {
  if (!apiKey()) return { installed: true, configured: false };
  const c = await creditStatus();
  return { installed: true, configured: true, loggedIn: c.ok, ...(c.ok ? {} : { status: c.status, error: c.error }) };
}

export async function listModels() {
  const key = apiKey();
  if (!key) return [];
  const listed = await apiModels(key);
  return (listed.data || []).map((m) => ({ provider: id, id: m.id, label: m.display_name || m.id, description: 'Anthropic API, billed per token', efforts: effortsFor(m.id), kind: 'agent', cost: 'api' }));
}

/** No usage windows (it bills per token); missing credit blocks the provider, as DeepSeek's exhausted balance does. */
export async function pollLimits() {
  const key = apiKey();
  const base = { provider: id, plan: key ? 'api-key' : null, blocked: false, windows: [] };
  if (!key) return base;
  try {
    const c = await creditStatus(key);
    if (c.status === 'no-credit') return { ...base, blocked: true, blockedReason: 'credit balance too low' };
  } catch {}
  return base;
}
