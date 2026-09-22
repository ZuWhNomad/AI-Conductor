// API-key providers that speak the OpenAI chat-completions protocol. Add a vendor = add a row.
import { loadConfig } from '../config.mjs';

export const CATALOG = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY', signup: 'https://platform.deepseek.com' },
  moonshot: { label: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.ai/v1', env: 'MOONSHOT_API_KEY', signup: 'https://platform.moonshot.ai' },
  xai: { label: 'Grok (xAI)', baseUrl: 'https://api.x.ai/v1', env: 'XAI_API_KEY', signup: 'https://console.x.ai' },
  qwen: { label: 'Qwen (DashScope)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', env: 'DASHSCOPE_API_KEY', signup: 'https://modelstudio.console.alibabacloud.com' },
  gemini: { label: 'Gemini (Google AI Studio, free tier)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY', signup: 'https://aistudio.google.com/apikey' },
  openai: { label: 'OpenAI API (key-based; also DALL-E / gpt-image)', baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', signup: 'https://platform.openai.com/api-keys' },
};

const NOT_CHAT = /embed|tts|whisper|audio|image|dall|moderation|realtime|transcribe|vision-preview|rerank|ocr|aqa|imagen|veo|embedding/i;

/** DeepSeek GET /user/balance -> { amount, currency, available }; null when the shape is unknown. */
export function parseDeepseekBalance(j) {
  const b = j?.balance_infos?.[0]; if (!b) return null;
  // DeepSeek spends granted (promotional/free) balance before topped-up funds; the router treats a provider with granted credit as free.
  return { amount: Number(b.total_balance), granted: Number(b.granted_balance) || 0, toppedUp: Number(b.topped_up_balance) || 0, currency: b.currency || 'USD', available: j.is_available !== false };
}

// Prepaid balance as a usage window: % of a budget consumed. The budget is providers.<id>.budgetUsd when set,
// else the highest balance seen this process (a fresh top-up raises it automatically).
const budgetSeen = new Map();
export function budgetWindow(pid, bal) {
  const configured = Number(loadConfig().providers[pid]?.budgetUsd) || 0;
  const seen = Math.max(budgetSeen.get(pid) || 0, bal.amount);
  budgetSeen.set(pid, seen);
  const budget = Math.max(configured, seen) || 1;
  return { id: `${pid}:budget`, label: `budget ${bal.currency} ${budget.toFixed(2)}`, usedPercent: Math.round(Math.max(0, Math.min(100, 100 * (1 - bal.amount / budget))) * 10) / 10, remaining: `${bal.currency} ${bal.amount.toFixed(2)} left`, resetsAt: null };
}

export function apiKeyFor(pid) {
  const cfg = loadConfig().providers[pid] || {};
  return cfg.apiKey || process.env[CATALOG[pid]?.env] || null;
}

export function baseUrlFor(pid) {
  return (loadConfig().providers[pid]?.baseUrl || CATALOG[pid].baseUrl).replace(/\/$/, '');
}

export function make(pid) {
  const c = CATALOG[pid];
  return {
    id: pid, label: c.label, kind: 'openai-compat',
    auth: { type: 'apiKey', env: c.env, setup: `Get a key at ${c.signup} and paste it in Settings (or set ${c.env}).` },
    detect: async () => ({ installed: true, configured: !!apiKeyFor(pid) }),
    listModels: async () => {
      const key = apiKeyFor(pid); if (!key) return [];
      const r = await fetch(`${baseUrlFor(pid)}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`${pid}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const j = await r.json();
      return (j.data || []).map((m) => String(m.id).replace(/^models\//, '')).filter((mid) => !NOT_CHAT.test(mid)).sort()
        .map((mid) => ({ provider: pid, id: mid, label: mid, description: '', efforts: [], kind: 'agent', cost: 'api' }));
    },
    url: c.signup,
    pollLimits: async () => {
      const base = { provider: pid, plan: apiKeyFor(pid) ? 'api-key' : null, blocked: false, windows: [] };
      const key = apiKeyFor(pid);
      if (pid === 'deepseek' && key) {
        try {
          if (new URL(baseUrlFor(pid)).origin !== new URL(c.baseUrl).origin) return base;
          const r = await fetch('https://api.deepseek.com/user/balance', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
          if (r.ok) { const b = parseDeepseekBalance(await r.json()); if (b) { base.balance = b; base.blocked = !b.available; if (!b.available) base.blockedReason = 'balance exhausted'; base.windows = [budgetWindow(pid, b)]; } }
        } catch {}
      }
      return base;
    },
    workerConfig: () => ({ baseUrl: baseUrlFor(pid), apiKey: apiKeyFor(pid) }),
  };
}
