// Limit registry: per-provider usage windows. Never assumed static — polled, updated from live
// rate-limit events and HTTP headers, and re-derived on every refresh.
import { PROVIDERS } from './providers/index.mjs';
import { windowFromEvent } from './providers/anthropic.mjs';
import { statSync } from 'node:fs';
import { readJson, writeJson, statePath, nowIso } from './paths.mjs';
import { bus } from './bus.mjs';
import { loadConfig } from './config.mjs';

const blockedMs = () => (loadConfig().scorecard?.blockedMinutes ?? 30) * 60_000; // how long a provider is assumed blocked after a limit hit with no retry-after

const FILE = () => statePath('limits.json');
let cache = readJson(FILE(), { updatedAt: null, providers: {} });
const inflightByScope = new Map(); // coalesce concurrent polls, keyed by scope so a codex-only poll is never returned to a full refresh
let seenMtime = fileMtime();

function fileMtime() { try { const st = statSync(FILE()); return `${st.mtimeMs}:${st.size}`; } catch { return '0'; } } // mtime alone misses two writes in the same tick

/** The registry, re-read when another process (a smoke run, `conductor limits`, a helper script) wrote limits.json since we last did. */
export function getLimits() {
  const m = fileMtime();
  if (m !== seenMtime) { seenMtime = m; const fresh = readJson(FILE(), null); if (fresh?.providers) { cache.updatedAt = fresh.updatedAt; cache.providers = fresh.providers; } }
  return cache;
}

function save(publish = true) {
  cache.updatedAt = nowIso();
  writeJson(FILE(), cache);
  seenMtime = fileMtime();
  if (publish) bus.publish('limits', { updatedAt: cache.updatedAt });
}

export function refreshLimits({ only = null } = {}) {
  const key = only ? [...only].sort().join(',') : '*';
  if (inflightByScope.has(key)) return inflightByScope.get(key);
  const inflight = (async () => {
    const targets = Object.values(PROVIDERS).filter((p) => p.pollLimits && (!only || only.includes(p.id)));
    const outcomes = await Promise.allSettled(targets.map(async (p) => {
      const before = { ...getLimits().providers[p.id] };
      try {
        const r = await p.pollLimits();
        return { id: p.id, ok: true, r, before };
      } catch (e) {
        return { id: p.id, ok: false, error: String(e?.message || e) };
      }
    }));
    getLimits();
    for (const outcome of outcomes) {
      if (outcome.status !== 'fulfilled') continue;
      const { id, ok, r, error, before } = outcome.value;
      const prev = cache.providers[id] || {};
      if (ok) {
        try {
          cache.providers[id] = { ...mergePoll(prev, r, before), source: 'poll', error: null, updatedAt: nowIso() };
        } catch (e) {
          cache.providers[id] = { ...prev, provider: id, source: prev.source || 'poll', error: String(e?.message || e), updatedAt: nowIso() };
        }
      } else {
        cache.providers[id] = { ...prev, provider: id, source: prev.source || 'poll', error, updatedAt: nowIso() };
      }
    }
    save();
    return cache;
  })().finally(() => { inflightByScope.delete(key); });
  inflightByScope.set(key, inflight);
  return inflight;
}

function earliestReset(windows = []) {
  const full = windows.filter((w) => (w.usedPercent ?? 0) >= 100 && w.resetsAt).map((w) => w.resetsAt);
  return full.length ? Math.min(...full) : null;
}

export function mergePoll(prev, r, before = prev) {
  const merged = { ...r, blockedUntil: r.blocked ? earliestReset(r.windows?.filter((w) => !w.models)) : null };
  const httpUntil = prev.httpRetryUntil || (prev.blockedReason === '429' ? prev.blockedUntil : null);
  // Balance or model-scoped usage says nothing about recovery from a global HTTP request limit.
  // A poll started before a newer 429 cannot establish recovery from that rejection either.
  const recovered = before.last429At === prev.last429At && before.blockedUntil === prev.blockedUntil
    && before.httpRetryUntil === prev.httpRetryUntil
    && r.windows?.some((w) => w.id === 'requests' && !w.models && w.status !== 'rejected'
      && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent < 100
      && (!w.resetsAt || w.resetsAt > Date.now()));
  if (prev.blocked && httpUntil > Date.now() && !recovered) {
    merged.last429At = prev.last429At;
    if (!r.blocked || (merged.blockedUntil && merged.blockedUntil < httpUntil)) {
      Object.assign(merged, { blocked: true, blockedUntil: httpUntil, blockedReason: '429' });
    } else {
      merged.httpRetryUntil = httpUntil; // Keep the HTTP deadline even while a stronger poll block takes precedence.
    }
  }
  return merged;
}

/** Live update from an SDK rate_limit_event (claude) — cheaper and fresher than polling. */
export function noteRateLimitEvent(providerId, info) {
  getLimits();
  const w = windowFromEvent(info);
  const p = cache.providers[providerId] || { provider: providerId, windows: [] };
  if (w) {
    if (info.status === 'rejected' && !w.resetsAt) w.resetsAt = Date.now() + blockedMs();
    p.windows = [...(p.windows || []).filter((x) => x.id !== w.id), w];
  }
  if (info?.status === 'rejected' && !w?.models) { p.blocked = true; p.blockedUntil = w?.resetsAt || Date.now() + blockedMs(); p.blockedReason = info.rateLimitType || 'rate_limit'; }
  else if (info?.status === 'allowed' && !w?.models && p.blockedReason === info.rateLimitType) { p.blocked = false; p.blockedUntil = null; p.blockedReason = null; }
  p.source = 'event'; p.updatedAt = nowIso();
  cache.providers[providerId] = p;
  save();
}

/** Learn from HTTP responses of API-key providers (429 + retry-after, x-ratelimit-* headers). */
export function noteHttp(providerId, status, headers = {}) {
  getLimits();
  const p = cache.providers[providerId] || { provider: providerId, windows: [] };
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (status === 429) {
    const raw = h['retry-after']; const seconds = Number(raw); const now = Date.now();
    const dateMs = Date.parse(raw) - now;
    const retry = raw != null && String(raw).trim() && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : dateMs > 0 ? dateMs : 60_000;  // a 429 with no retry-after backs off briefly (60s), deliberately shorter than the 30-min hard-block default
    p.blocked = true; p.blockedUntil = now + retry; p.blockedReason = '429'; p.last429At = nowIso();
    delete p.httpRetryUntil;
  } else if (status && status < 400) {
    delete p.httpRetryUntil;
    if (p.blockedReason === '429') { p.blocked = false; p.blockedUntil = null; p.blockedReason = null; }
  }
  const rem = h['x-ratelimit-remaining-requests'] ?? h['x-ratelimit-remaining'];
  const lim = h['x-ratelimit-limit-requests'] ?? h['x-ratelimit-limit'];
  if (rem != null && lim != null && Number(lim) > 0) {
    p.windows = [{ id: 'requests', label: 'requests', usedPercent: Math.round(100 * (1 - Number(rem) / Number(lim))), resetsAt: null }];
  }
  p.source = 'http'; p.updatedAt = nowIso();
  cache.providers[providerId] = p;
  save(false);
}

/** ms timestamp until which the provider should not be used, or null when usable. */
export function blockedUntil(providerId) {
  getLimits();
  const p = cache.providers[providerId];
  if (!p?.blocked) return null;
  if (p.blockedUntil && p.blockedUntil <= Date.now()) { p.blocked = false; p.blockedUntil = null; p.blockedReason = null; save(false); return null; }
  return p.blockedUntil || Date.now() + blockedMs();
}

/** Windows metered by this model; no model means all groups. */
export function providerWindows(provider, model = null) {
  const scope = (w) => w.models || (/fable/i.test(w.label || '') ? 'fable' : null);
  return (getLimits().providers[provider]?.windows || []).filter((w) => !scope(w) || !model || new RegExp(scope(w), 'i').test(model));
}

/** Actual limits apply independently of soft policy caps and parallel pacing overrides. */
export function modelBlockedUntil(provider, model = null) {
  const global = blockedUntil(provider);
  if (global) return global;
  const now = Date.now();
  const full = providerWindows(provider, model).filter((w) => (!w.resetsAt || w.resetsAt > now) && (w.status === 'rejected' || w.usedPercent >= 100));
  return full.length ? Math.min(...full.map((w) => w.resetsAt || now + blockedMs())) : null;
}

bus.on('event', (e) => {
  if (e.type === 'rate_limit' && e.provider) noteRateLimitEvent(e.provider, e.info);
  if (e.type === 'http_rate' && e.provider) noteHttp(e.provider, e.status, e.headers);
});

let timer = null;
export function startLimitPolling(minutes) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => refreshLimits().catch(() => {}), Math.max(1, minutes) * 60_000);
  timer.unref();
}

export function stopLimitPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}
