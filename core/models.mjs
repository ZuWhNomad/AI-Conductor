// Model registry: what every provider currently offers. Auto-polled, force-refreshable, cached on disk.
// PROVIDERS is imported lazily inside refreshModels() so that vendors.mjs (which needs findModel from here) can import
// this module without the providers/index -> vendors -> models -> providers/index cycle tripping over a TDZ at load.
import { readJson, writeJson, statePath, nowIso } from './paths.mjs';
import { bus } from './bus.mjs';

const FILE = () => statePath('models.json');
let cache = readJson(FILE(), { updatedAt: null, providers: {}, models: [] });
const inflightByScope = new Map(); // coalesce concurrent refreshes per scope so an ollama-only refresh isn't returned to a full one
let refreshGeneration = 0;
const committedByProvider = new Map(); // request order, not completion order, determines freshness

export function getModels() { return cache; }

const ORDER = ['claude', 'codex', 'ollama'];
const sortModels = (ms) => ms.sort((a, b) => (ORDER.indexOf(a.provider) + 1 || 99) - (ORDER.indexOf(b.provider) + 1 || 99) || a.id.localeCompare(b.id));

/** Re-detect providers and re-list their models. Concurrent calls share one run. */
export function refreshModels({ only = null } = {}) {
  const key = only ? [...only].sort().join(',') : '*';
  if (inflightByScope.has(key)) return inflightByScope.get(key);
  const generation = ++refreshGeneration;
  const inflight = (async () => {
    const { PROVIDERS } = await import('./providers/index.mjs');
    const fresh = {}, lists = {};
    const targets = Object.values(PROVIDERS).filter((p) => !only || only.includes(p.id));
    await Promise.allSettled(targets.map(async (p) => {
      const t0 = Date.now();
      try {
        const det = (await p.detect()) || {};
        // Logged-out subscription providers still list their models (the picker stays useful); only
        // missing installs / missing keys skip the call.
        const usable = det.installed !== false && det.configured !== false;
        const list = usable ? await p.listModels() : [];
        lists[p.id] = list;
        fresh[p.id] = { ...det, status: usable && det.loggedIn !== false ? 'ok' : 'unavailable', count: list.length, error: det.error || null, updatedAt: nowIso(), ms: Date.now() - t0 };
      } catch (e) {
        fresh[p.id] = { ...(cache.providers[p.id] || {}), status: 'error', error: String(e?.message || e), updatedAt: nowIso(), ms: Date.now() - t0 };
      }
    }));
    // A provider result can be superseded while this refresh waits for another provider.
    for (const { id } of targets) {
      if ((committedByProvider.get(id) || 0) > generation) { delete fresh[id]; delete lists[id]; }
      else committedByProvider.set(id, generation);
    }
    const before = cache;
    const providers = { ...cache.providers, ...fresh };
    const models = cache.models.filter((m) => !Object.hasOwn(lists, m.provider)).concat(...Object.values(lists));
    cache = { updatedAt: nowIso(), providers, models: sortModels(models) };
    writeJson(FILE(), cache);
    try { const { noteNewModels } = await import('./bench.mjs'); noteNewModels(before, cache); } catch {}
    bus.publish('models', { updatedAt: cache.updatedAt, count: cache.models.length });
    return cache;
  })().finally(() => { inflightByScope.delete(key); });
  inflightByScope.set(key, inflight);
  return inflight;
}

export function findModel(provider, id) {
  return cache.models.find((m) => m.provider === provider && (m.id === id || m.resolved === id)) || null;
}

let timer = null;
export function startModelPolling(minutes) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => refreshModels().catch(() => {}), Math.max(1, minutes) * 60_000);
  timer.unref();
}

export function stopModelPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}

// Model family, whichever provider serves it (antigravity serves several, so the id decides). Reviews use it to keep
// failover off a family already on the review (task option avoidFamilies).
const FAMILIES = [['claude', /^(?:claude|opus|sonnet|haiku|fable)\b/], ['gpt', /^(?:gpt|codex|o\d|astra|luna|sol|terra)\b/], ['grok', /^grok/], ['gemini', /^gemini/], ['deepseek', /^deepseek/], ['kimi', /^(?:kimi|moonshot)/], ['qwen', /^qwen/]];
const PROVIDER_FAMILY = { claude: 'claude', anthropic: 'claude', codex: 'gpt', openai: 'gpt', grok: 'grok', xai: 'grok', deepseek: 'deepseek', moonshot: 'kimi', kimi: 'kimi', gemini: 'gemini', qwen: 'qwen', 'qwen-code': 'qwen' };
export function familyOf(provider, model) {
  const id = String(model || '').toLowerCase().split('/').at(-1);
  if (id && id !== 'default') for (const [f, re] of FAMILIES) if (re.test(id)) return f;
  return PROVIDER_FAMILY[provider] || provider;
}
/** Lowercased, deduped family names; anything else is dropped. */
export const normFamilies = (fs) => [...new Set((Array.isArray(fs) ? fs : []).filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim().toLowerCase()))];
/** recommend() exclude list: every registry selection whose model is in one of `families`. */
export const selsInFamilies = (families, reg = cache) => reg.models.flatMap((m) => [m.id, m.resolved].filter((id) => id && families.includes(familyOf(m.provider, id))).map((id) => `${m.provider}:${id}`));
