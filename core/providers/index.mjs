// Provider registry. A provider = { id, label, kind, auth, detect(), listModels(), pollLimits() }.
// kind decides which worker runs a model: claude | codex | ollama | openai-compat | image.
import * as anthropic from './anthropic.mjs';
import * as codex from './codex.mjs';
import * as ollama from './ollama.mjs';
import { CATALOG, make, apiKeyFor } from './openai-compat.mjs';
import { VENDORS, providerFor } from './vendors.mjs';
import { loadConfig } from '../config.mjs';

const imageProviders = {
  'openai-images': {
    id: 'openai-images', label: 'OpenAI Images (DALL-E / gpt-image)', kind: 'image',
    auth: { type: 'apiKey', env: 'OPENAI_API_KEY', setup: 'Uses the OpenAI API key from Settings.' },
    detect: async () => ({ installed: true, configured: !!apiKeyFor('openai') }),
    listModels: async () => apiKeyFor('openai') ? ['gpt-image-1', 'dall-e-3'].map((id) => ({ provider: 'openai-images', id, label: id, description: 'image generation', efforts: [], kind: 'image', cost: 'api' })) : [],
    pollLimits: async () => ({ provider: 'openai-images', plan: apiKeyFor('openai') ? 'api-key' : null, blocked: false, windows: [] }),
    workerConfig: () => ({ apiKey: apiKeyFor('openai') }),
  },
  stability: {
    id: 'stability', label: 'Stability AI', kind: 'image',
    auth: { type: 'apiKey', env: 'STABILITY_API_KEY', setup: 'Get a key at https://platform.stability.ai and paste it in Settings.' },
    detect: async () => ({ installed: true, configured: !!(loadConfig().providers.stability?.apiKey || process.env.STABILITY_API_KEY) }),
    listModels: async () => (loadConfig().providers.stability?.apiKey || process.env.STABILITY_API_KEY) ? [{ provider: 'stability', id: 'stable-image-core', label: 'Stable Image Core', description: 'image generation', efforts: [], kind: 'image', cost: 'api' }] : [],
    pollLimits: async () => ({ provider: 'stability', plan: null, blocked: false, windows: [] }),
    workerConfig: () => ({ apiKey: loadConfig().providers.stability?.apiKey || process.env.STABILITY_API_KEY }),
  },
  sd: {
    id: 'sd', label: 'Stable Diffusion (local A1111 API)', kind: 'image',
    auth: { type: 'none', setup: 'Run AUTOMATIC1111 with --api; set the URL in Settings.' },
    detect: async () => { try { const r = await fetch(`${loadConfig().providers.sd.baseUrl}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(1500) }); return { installed: r.ok, running: r.ok }; } catch { return { installed: false, running: false }; } },
    listModels: async () => { try { const r = await fetch(`${loadConfig().providers.sd.baseUrl}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(3000) }); if (!r.ok) return []; return (await r.json()).map((m) => ({ provider: 'sd', id: m.model_name, label: m.title || m.model_name, description: 'local image generation', efforts: [], kind: 'image', cost: 'free-local' })); } catch { return []; } },
    pollLimits: async () => ({ provider: 'sd', plan: 'local', blocked: false, windows: [] }),
    workerConfig: () => ({ baseUrl: loadConfig().providers.sd.baseUrl }),
  },
};

export const PROVIDERS = {
  claude: anthropic,
  codex: { ...codex, kind: 'codex' },
  ...Object.fromEntries(Object.values(VENDORS).map((v) => [v.id, providerFor(v)])), // agy, grok, qwen-code, kimi (subscription CLIs)
  ollama,
  ...Object.fromEntries(Object.keys(CATALOG).map((id) => [id, make(id)])),
  ...imageProviders,
};

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown provider "${id}". Known: ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

export const PROVIDER_URLS = { claude: 'https://claude.ai', codex: 'https://chatgpt.com/codex', ollama: 'https://ollama.com', antigravity: 'https://antigravity.google', grok: 'https://grok.com', kimi: 'https://www.kimi.com', 'qwen-code': 'https://qwen.ai', 'openai-images': 'https://platform.openai.com', stability: 'https://platform.stability.ai', sd: 'http://127.0.0.1:7860' };
export function providerSummaries() {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label, kind: p.kind, auth: p.auth, url: p.url || PROVIDER_URLS[p.id] || null, canInstall: !!p.installCommand?.(), canLogin: !!p.loginCommand?.(), canRelogin: !!p.loginCommand?.() }));
}
