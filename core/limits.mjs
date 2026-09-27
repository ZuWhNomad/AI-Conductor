// Limit registry: per-provider usage windows. Never assumed static — polled, updated from live
// rate-limit events and HTTP headers, and re-derived on every refresh.
import { PROVIDERS } from './providers/index.mjs';
import { windowFromEvent } from './providers/anthropic.mjs';
import { statSync } from 'node:fs';
import { readJson, writeJson, statePath, nowIso } from './paths.mjs';
import { bus } from './bus.mjs';
import { loadConfig } from './config.mjs';

const blockedMs = () => (loadConfig().scorecard.blockedMinutes) * 60_000; // how long a provider is assumed blocked after a limit hit with no retry-after

const pruneUnknown = (providers) => {
  const cfg = loadConfig().providers || {};
  return Object.fromEntries(Object.entries(providers || {}).filter(([id]) => Object.hasOwn(PROVIDERS, id) || Object.hasOwn(cfg, id)));
};

const FILE = () => statePath('limits.json');
let cache = readJson(FILE(), { updatedAt: null, providers: {} });
cache.providers = pruneUnknown(cache.providers);
const inflightByScope = new Map(); // coalesce concurrent polls, keyed by scope so a codex-only poll is never returned to a full refresh
let refreshGeneration = 0;
const committedByProvider = new Map(); // a newer pending poll must not discard a post-completion sample
const observationsByProvider = new Map();
const BLOCK = Symbol('provider block');
const HTTP = Symbol('HTTP response');
let seenMtime = fileMtime();

function observe(provider, key) {
  if (!observationsByProvider.has(provider)) observationsByProvider.set(provider, new Map());
  observationsByProvider.get(provider).set(key, ++refreshGeneration);
}

function fileMtime() { try { const st = statSync(FILE()); return `${st.mtimeMs}:${st.size}`; } catch { return '0'; } } // mtime alone misses two writes in the same tick

// A window at its limit is re-polled when its reset passes. Before this, nothing re-read it then: the registry kept
// "100%, resets <hours ago>" until the next interval poll (never, with autoRefresh off; not while that poll errored),
// and the limits tool showed full windows with reset times in the past (Antigravity, 2026-09-15). One timer, for the
// earliest such reset; a provider that still reports a past reset is not re-armed, so nothing loops.
let resetTimer = null;
export const RESET_POLL_GRACE_MS = 5000;
function scheduleResetPoll() {
  if (process.env.CONDUCTOR_NO_POLL) return;
  const now = Date.now(); let next = null;
  for (const [id, p] of Object.entries(cache.providers)) {
    for (const w of p?.windows || []) {
      if (w.resetsAt > now && (w.status === 'rejected' || (w.usedPercent ?? 0) >= 100) && !(next?.at <= w.resetsAt)) next = { at: w.resetsAt, id };
    }
  }
  clearTimeout(resetTimer); resetTimer = null;
  if (!next) return;
  resetTimer = setTimeout(() => { resetTimer = null; refreshLimits({ only: [next.id] }).catch(() => {}); }, Math.min(2 ** 31 - 1, next.at - now + RESET_POLL_GRACE_MS));
  resetTimer.unref?.();
}

/** Session/5-hour windows (the conductor's classCap applies to these; weekly/budget windows do not). */
export const isSession = (w) => /hour|session/i.test(w.label || '') || !!(w.windowMinutes && w.windowMinutes <= 600);

let restatHold = 0;
/** The registry, re-read when another process (a smoke run, `conductor limits`, a helper script) wrote limits.json since we last did. */
export function getLimits() {
  if (!restatHold) {
    const m = fileMtime();
    if (m !== seenMtime) { seenMtime = m; const fresh = readJson(FILE(), null); if (fresh?.providers) { cache.updatedAt = fresh.updatedAt; cache.providers = pruneUnknown(fresh.providers); } }
  }
  return cache;
}
/** Refresh once, then reuse the in-memory registry until `fn` returns (nested calls share the snapshot). */
export function withLimitsSnapshot(fn) {
  getLimits();
  restatHold++;
  try { return fn(); }
  finally { restatHold--; }
}

export function save(publish = true) {
  cache.providers = pruneUnknown(cache.providers);
  cache.updatedAt = nowIso();
  writeJson(FILE(), cache);
  seenMtime = fileMtime();
  scheduleResetPoll();
  if (publish) bus.publish('limits', { updatedAt: cache.updatedAt });
}

const scopeKey = (only) => only ? [...only].sort().join(',') : '*';

/** Per-call metadata without changing refreshLimits' shared promise or registry result. */
export function refreshLimitsWithMeta({ only = null } = {}) {
  const joined = inflightByScope.has(scopeKey(only));
  return { joined, promise: refreshLimits({ only }) };
}

export function refreshLimits({ only = null } = {}) {
  const key = scopeKey(only);
  if (inflightByScope.has(key)) return inflightByScope.get(key);
  const generation = ++refreshGeneration;
  const inflight = (async () => {
    const targets = Object.values(PROVIDERS).filter((p) => p.pollLimits && (!only || only.includes(p.id)));
    const outcomes = await Promise.allSettled(targets.map(async (p) => {
      const before = { ...getLimits().providers[p.id] };
      const observedAtStart = refreshGeneration;
      try {
        const r = await p.pollLimits();
        return { id: p.id, ok: true, r, before, observedAtStart };
      } catch (e) {
        return { id: p.id, ok: false, error: String(e?.message || e) };
      }
    }));
    getLimits();
    for (const outcome of outcomes) {
      if (outcome.status !== 'fulfilled') continue;
      const { id, ok, r, error, before, observedAtStart } = outcome.value;
      // Check at commit: this outcome may have waited for an unrelated slow provider.
      if ((committedByProvider.get(id) || 0) > generation) continue;
      committedByProvider.set(id, generation);
      const prev = cache.providers[id] || {};
      if (ok) {
        try {
          const observed = new Set([...(observationsByProvider.get(id) || [])].filter(([, version]) => version > observedAtStart).map(([key]) => key));
          cache.providers[id] = { ...mergePoll(prev, r, before, observed), source: 'poll', error: null, updatedAt: nowIso() };
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
  const full = windows.filter((w) => (w.status === 'rejected' || (w.usedPercent ?? 0) >= 100) && w.resetsAt).map((w) => w.resetsAt);
  return full.length ? Math.min(...full) : null;
}

/** `models` regex, or `fable` when that field is absent and the label names Fable. */
export const windowModels = (w) => w.models || (/fable/i.test(w.label || '') ? 'fable' : null);
const modelScoped = (w) => !!windowModels(w);
const globalWindowBlocks = (w) => !modelScoped(w) && (w.status === 'rejected' || w.usedPercent >= 100) && (!w.resetsAt || w.resetsAt > Date.now());

function windowApplies(w, model) {
  const models = windowModels(w);
  if (!models || !model) return true;
  try { return new RegExp(models, 'i').test(model); }
  catch { return String(model).toLowerCase().includes(String(models).toLowerCase()); }
}

const windowAvailable = (w) => w.status !== 'rejected' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent < 100;

function clearConfirmedLimit(p) {
  const hit = p.confirmedLimit;
  if (!hit) return false;
  for (const prior of hit.windows || []) {
    const i = (p.windows || []).findIndex((w) => w.id === prior.id);
    if (i < 0) continue;
    if (p.windows[i].usedPercent !== 100) continue;
    if (prior.synthetic) p.windows.splice(i, 1);
    else {
      const w = { ...p.windows[i] };
      if (prior.hadUsedPercent) w.usedPercent = prior.usedPercent;
      else delete w.usedPercent;
      p.windows[i] = w;
    }
  }
  delete p.confirmedLimit;
  if (p.blockedReason === 'limit_hit') {
    const full = (p.windows || []).filter(globalWindowBlocks);
    p.blocked = !!full.length; p.blockedUntil = earliestReset(full); p.blockedReason = null;
  }
  return true;
}

function preserveConfirmedLimit(prev, merged, r, before) {
  const hit = prev.confirmedLimit;
  if (!hit || hit.blockedUntil <= Date.now()) return merged;
  const real = (r.windows || []).filter((w) => !w.estimated && windowApplies(w, hit.model));
  const required = (hit.windows || []).filter((w) => !w.synthetic);
  const recovered = before.confirmedLimit?.hitAt === hit.hitAt && real.length && required.every((prior) => {
    const fresh = real.find((w) => w.id === prior.id);
    if (!fresh || !windowAvailable(fresh)) return false;
    const resetMoved = Number.isFinite(prior.resetsAt) && Number.isFinite(fresh.resetsAt) && fresh.resetsAt > prior.resetsAt;
    const usageDropped = Number.isFinite(prior.usedPercent) && Number.isFinite(fresh.usedPercent) && fresh.usedPercent <= prior.usedPercent - 20;
    return resetMoved || usageDropped;
  });
  if (recovered) return merged;
  const windows = [...(merged.windows || [])];
  const retained = [];
  for (const prior of hit.windows || []) {
    const w = (prev.windows || []).find((x) => x.id === prior.id);
    if (!w) continue;
    const i = windows.findIndex((x) => x.id === w.id);
    const reportedFull = i >= 0 && !windows[i].estimated && (windows[i].status === 'rejected' || windows[i].usedPercent >= 100);
    if (!reportedFull) {
      if (i < 0) windows.push(w); else windows[i] = w;
    }
    retained.push(prior);
  }
  merged.windows = windows;
  merged.confirmedLimit = { ...hit, windows: retained };
  if (hit.global && merged.blockedReason !== '429') Object.assign(merged, { blocked: true, blockedUntil: hit.blockedUntil, blockedReason: 'limit_hit' });
  return merged;
}

export function mergePoll(prev, r, before = prev, observed = new Set()) {
  const merged = { ...r, blockedUntil: r.blocked ? earliestReset(r.windows?.filter((w) => !w.models)) : null };
  if (observed.has(HTTP)) {
    delete merged.httpRetryUntil;
    if (prev.last429At != null) merged.last429At = prev.last429At;
    else delete merged.last429At;
    if (merged.blockedReason === '429') Object.assign(merged, { blocked: false, blockedUntil: null, blockedReason: null });
  }
  // Preserve only windows observed since this poll began, including allowed transitions.
  const live = (prev.windows || []).filter((w) => observed.has(w.id));
  if (live.length) merged.windows = [...(r.windows || []).filter((w) => !observed.has(w.id)), ...live];
  if (observed.has(BLOCK) || live.some((w) => !w.models)) {
    const full = (merged.windows || []).filter(globalWindowBlocks);
    const independentBlock = merged.blocked && !(r.windows || []).some(globalWindowBlocks) && !observed.has(BLOCK);
    // Window-derived aggregate blocks have no reason; window-backed rejections are already in full.
    const liveBlock = observed.has(BLOCK) && prev.blocked && prev.blockedReason && prev.blockedReason !== '429'
      && !full.some((w) => w.id === prev.blockedReason);
    merged.blocked = !!(independentBlock || liveBlock || full.length);
    merged.blockedUntil = liveBlock && !full.length ? prev.blockedUntil : merged.blocked ? earliestReset(full) : null;
    merged.blockedReason = liveBlock ? prev.blockedReason : independentBlock ? r.blockedReason : null;
  }
  const httpUntil = prev.httpRetryUntil || (prev.blockedReason === '429' ? prev.blockedUntil : null);
  // Balance or model-scoped usage says nothing about recovery from a global HTTP request limit.
  // A poll started before a newer 429 cannot establish recovery from that rejection either.
  const recovered = !observed.has(HTTP) && before.last429At === prev.last429At && before.blockedUntil === prev.blockedUntil
    && before.httpRetryUntil === prev.httpRetryUntil
    && r.windows?.some((w) => w.id === 'requests' && !w.models && w.status !== 'rejected'
      && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent < 100
      && (!w.resetsAt || w.resetsAt > Date.now()));
  if (prev.blocked && httpUntil > Date.now() && !recovered) {
    merged.last429At = prev.last429At;
    if (!merged.blocked || (merged.blockedUntil && merged.blockedUntil < httpUntil)) {
      Object.assign(merged, { blocked: true, blockedUntil: httpUntil, blockedReason: '429' });
    } else {
      merged.httpRetryUntil = httpUntil; // Keep the HTTP deadline even while a stronger poll block takes precedence.
    }
  }
  return preserveConfirmedLimit(prev, merged, r, before);
}

/** Persist a worker-confirmed usage-limit hit. Existing HTTP/SDK blocks remain authoritative. */
export function noteLimitHit(providerId, { model = null, retryAfterMs = null, resetsAt = null } = {}) {
  getLimits();
  const now = Date.now();
  const p = cache.providers[providerId] || { provider: providerId, windows: [] };
  const existing = modelBlockedUntil(providerId, model);
  const applicable = (p.windows || []).filter((w) => windowApplies(w, model));
  const scoped = model ? applicable.filter(modelScoped) : [];
  const globals = applicable.filter((w) => !modelScoped(w));
  const likelyGlobals = scoped.length ? globals.filter((w) => w.usedPercent == null || w.usedPercent >= 90) : [];
  let targets = scoped.length && !likelyGlobals.length ? scoped : likelyGlobals.length ? likelyGlobals : globals;
  const known = targets.map((w) => w.resetsAt).filter((at) => at > now);
  const windowUntil = known.length ? Math.min(...known) : resetsAt > now ? resetsAt : now + blockedMs();
  const retryUntil = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? now + retryAfterMs : null;
  let until = retryUntil && retryUntil < windowUntil ? retryUntil : windowUntil;
  until = Math.max(until, existing || 0, p.confirmedLimit?.blockedUntil || 0);
  if (!targets.length) {
    const synthetic = { id: `${providerId}:estimated`, label: 'estimated usage', usedPercent: 0, resetsAt: until, estimated: true };
    p.windows = [...(p.windows || []), synthetic]; targets = [synthetic];
  }
  const previous = p.confirmedLimit?.windows || [];
  const marked = targets.map((w) => {
    const prior = previous.find((x) => x.id === w.id);
    return {
      id: w.id,
      synthetic: prior?.synthetic ?? (!!w.estimated && w.id === `${providerId}:estimated`),
      hadUsedPercent: prior?.hadUsedPercent ?? Object.hasOwn(w, 'usedPercent'),
      usedPercent: prior?.usedPercent ?? w.usedPercent,
      resetsAt: w.resetsAt,
      models: windowModels(w),
      label: w.label,
    };
  });
  const ids = new Set(marked.map((w) => w.id));
  p.windows = (p.windows || []).map((w) => ids.has(w.id) ? { ...w, usedPercent: 100 } : w);
  const global = !scoped.length || !!likelyGlobals.length;
  p.confirmedLimit = { hitAt: now, model, global, blockedUntil: until, windows: marked };
  if (global && (!p.blockedReason || p.blockedReason === 'limit_hit')) {
    p.blocked = true; p.blockedUntil = until; p.blockedReason = 'limit_hit'; observe(providerId, BLOCK);
  }
  for (const w of targets) observe(providerId, w.id);
  p.source = 'worker'; p.updatedAt = nowIso();
  cache.providers[providerId] = p;
  save();
  return until;
}

/** A later successful worker run is positive availability evidence for its provider/model. */
export function noteLimitAvailable(providerId, model = null, startedAt = null) {
  getLimits();
  const p = cache.providers[providerId], hit = p?.confirmedLimit;
  const started = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  if (!hit || !Number.isFinite(started) || started <= hit.hitAt) return false;
  if (!hit.global && (!model || (model !== hit.model && !(hit.windows || []).some((w) => modelScoped(w) && windowApplies(w, model))))) return false;
  clearConfirmedLimit(p);
  p.source = 'worker'; p.updatedAt = nowIso();
  save();
  return true;
}

/** Live update from an SDK rate_limit_event (claude) — cheaper and fresher than polling. */
export function noteRateLimitEvent(providerId, info) {
  getLimits();
  const w = windowFromEvent(info);
  const p = cache.providers[providerId] || { provider: providerId, windows: [] };
  if (w) {
    if (info.status === 'rejected' && !w.resetsAt) w.resetsAt = Date.now() + blockedMs();
    const prev = (p.windows || []).find((x) => x.id === w.id);
    // Bundled CLI omits utilization on most events; dropping it would zero providerUsedPct until the next poll.
    if (w.usedPercent == null && prev?.usedPercent != null) {
      const rejectedToAllowed = prev.status === 'rejected' && (info.status === 'allowed' || info.status === 'allowed_warning');
      if (!rejectedToAllowed) w.usedPercent = prev.usedPercent;
    }
    p.windows = [...(p.windows || []).filter((x) => x.id !== w.id), w];
    observe(providerId, w.id);
  }
  if (info?.status === 'rejected' && !w?.models) {
    p.blocked = true; p.blockedUntil = w?.resetsAt || Date.now() + blockedMs(); p.blockedReason = info.rateLimitType || 'rate_limit';
    observe(providerId, BLOCK);
  } else if ((info?.status === 'allowed' || info?.status === 'allowed_warning') && (p.blockedReason === info.rateLimitType || (w && !w.models && !p.blockedReason))) {
    const full = (p.windows || []).filter(globalWindowBlocks);
    p.blocked = !!full.length; p.blockedUntil = earliestReset(full); p.blockedReason = null;
    observe(providerId, BLOCK);
  }
  p.source = 'event'; p.updatedAt = nowIso();
  cache.providers[providerId] = p;
  save();
}

/** OpenAI x-ratelimit-reset-* duration: "1s", "6m0s", "1h2m3.5s", "20ms". */
function parseDurationMs(s) {
  let rest = String(s), total = 0, any = false;
  const tok = /^(\d+(?:\.\d+)?)(ms|s|m|h)/;
  const mul = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  while (rest) {
    const m = tok.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * mul[m[2]];
    rest = rest.slice(m[0].length);
    any = true;
  }
  return any ? total : null;
}

function parseResetAt(rawReset, now) {
  if (rawReset == null) return null;
  const asNum = Number(rawReset);
  if (Number.isFinite(asNum) && asNum > 0) {
    // >= 1e12: epoch milliseconds; > 1e9: epoch seconds; else seconds from now.
    if (asNum >= 1e12) return asNum;
    if (asNum > 1e9) return asNum * 1000;
    return now + asNum * 1000;
  }
  const parsed = Date.parse(rawReset);
  if (Number.isFinite(parsed) && parsed > now) return parsed;
  const dur = parseDurationMs(rawReset);
  return dur != null ? now + dur : null;
}

/** Learn from HTTP responses of API-key providers (429 + retry-after, x-ratelimit-* headers). */
export function noteHttp(providerId, status, headers = {}) {
  getLimits();
  const p = cache.providers[providerId] || { provider: providerId, windows: [] };
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const now = Date.now();
  if (status === 429) {
    const raw = h['retry-after']; const seconds = Number(raw);
    const dateMs = Date.parse(raw) - now;
    const retry = raw != null && String(raw).trim() && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : dateMs > 0 ? dateMs : 60_000;  // a 429 with no retry-after backs off briefly (60s), deliberately shorter than the 30-min hard-block default
    p.blocked = true; p.blockedUntil = now + retry; p.blockedReason = '429'; p.last429At = nowIso();
    delete p.httpRetryUntil;
    observe(providerId, HTTP);
  } else if (status && status < 400) {
    delete p.httpRetryUntil;
    if (p.blockedReason === '429') { p.blocked = false; p.blockedUntil = null; p.blockedReason = null; }
    observe(providerId, HTTP);
  }
  const rem = h['x-ratelimit-remaining-requests'] ?? h['x-ratelimit-remaining'];
  const lim = h['x-ratelimit-limit-requests'] ?? h['x-ratelimit-limit'];
  if (rem != null && lim != null && Number(lim) > 0) {
    // Read a reset timestamp from the response so the requests window self-expires when the server said it would.
    // x-ratelimit-reset-requests is the preferred header; x-ratelimit-reset is a common alternative.
    const rawReset = h['x-ratelimit-reset-requests'] ?? h['x-ratelimit-reset'];
    let resetsAt = parseResetAt(rawReset, now);
    if (resetsAt == null) {
      if (status === 429) resetsAt = p.blockedUntil; // Retry-After deadline, so the window does not become a 30-min park
      else if (Number(rem) === 0) resetsAt = now + 60_000; // same brief backoff as a header-less 429
    }
    const reqWindow = { id: 'requests', label: 'requests', usedPercent: Math.round(100 * (1 - Number(rem) / Number(lim))), resetsAt, rate: true };
    const wasRequestBlock = p.blocked && !p.blockedReason && (p.windows || []).some((w) => w.id === 'requests' && globalWindowBlocks(w));
    // Merge by id — other windows (e.g. DeepSeek budget) must not be discarded.
    p.windows = [...(p.windows || []).filter((w) => w.id !== 'requests'), reqWindow];
    observe(providerId, 'requests');
    if (wasRequestBlock) {
      const full = p.windows.filter(globalWindowBlocks);
      p.blocked = !!full.length; p.blockedUntil = earliestReset(full);
    }
  }
  p.source = 'http'; p.updatedAt = nowIso();
  cache.providers[providerId] = p;
  save(false);
}

/** ms timestamp until which the provider should not be used, or null when usable. */
export function blockedUntil(providerId) {
  getLimits();
  const p = cache.providers[providerId];
  if (p?.confirmedLimit?.blockedUntil <= Date.now() && clearConfirmedLimit(p)) save(false);
  if (!p?.blocked) return null;
  if (p.blockedUntil && p.blockedUntil <= Date.now()) { p.blocked = false; p.blockedUntil = null; p.blockedReason = null; save(false); return null; }
  return p.blockedUntil || Date.now() + blockedMs();
}

/** Windows metered by this model; no model means all groups. */
export function providerWindows(provider, model = null) {
  return (getLimits().providers[provider]?.windows || []).filter((w) => windowApplies(w, model));
}

/** Actual limits apply independently of soft policy caps and parallel pacing overrides. */
export function modelBlockedUntil(provider, model = null) {
  const global = blockedUntil(provider);
  if (global) return global;
  const now = Date.now();
  const hit = getLimits().providers[provider]?.confirmedLimit;
  if (hit && hit.blockedUntil > now && (hit.global || (model && (model === hit.model || (hit.windows || []).some((w) => modelScoped(w) && windowApplies(w, model)))))) return hit.blockedUntil;
  const full = providerWindows(provider, model).filter((w) => (model != null || !modelScoped(w)) && (!w.resetsAt || w.resetsAt > now) && (w.status === 'rejected' || w.usedPercent >= 100));
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
