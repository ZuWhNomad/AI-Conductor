// Model registry: what every provider currently offers. Auto-polled, force-refreshable, cached on disk.
// PROVIDERS is imported lazily inside refreshModels() so that vendors.mjs (which needs findModel from here) can import
// this module without the providers/index -> vendors -> models -> providers/index cycle tripping over a TDZ at load.
import { readJson, writeJson, statePath, nowIso } from './paths.mjs';
import { bus } from './bus.mjs';

const FILE = () => statePath('models.json');
let cache = readJson(FILE(), { updatedAt: null, providers: {}, models: [] });
const inflightByScope = new Map(); // coalesce concurrent refreshes per scope so an ollama-only refresh isn't returned to a full one

export function getModels() { return cache; }

const ORDER = ['claude', 'codex', 'ollama'];
const sortModels = (ms) => ms.sort((a, b) => (ORDER.indexOf(a.provider) + 1 || 99) - (ORDER.indexOf(b.provider) + 1 || 99) || a.id.localeCompare(b.id));

/** Re-detect providers and re-list their models. Concurrent calls share one run. */
export function refreshModels({ only = null } = {}) {
  const key = only ? [...only].sort().join(',') : '*';
  if (inflightByScope.has(key)) return inflightByScope.get(key);
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
