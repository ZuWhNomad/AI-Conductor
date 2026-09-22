// Claude provider (the conductor's own vendor): models, account and plan limits via the Agent SDK's
// control channel. No tokens are spent: these are control requests on an idle session.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { findCli } from '../proc.mjs';

export const id = 'claude';
export const label = 'Claude (Anthropic subscription)';
export const kind = 'claude';

/**
 * A runnable `claude` binary. Prefer a global install on PATH; otherwise fall back to the native binary the
 * Agent SDK bundles (a hard dependency of this repo), so sign-in works even when the user never installed
 * Claude Code globally. The SDK ships the platform binary as a sibling package: @anthropic-ai/claude-agent-sdk-<plat>-<arch>[-musl]/claude[.exe].
 */
export function claudeBin() {
  const onPath = findCli('claude');
  if (onPath) return onPath;
  try {
    const require = createRequire(import.meta.url);
    const scope = dirname(dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))); // resolves sdk.mjs → .../node_modules/@anthropic-ai
    const ext = process.platform === 'win32' ? '.exe' : '';
    const variants = process.platform === 'linux' ? [`linux-${process.arch}`, `linux-${process.arch}-musl`] : [`${process.platform}-${process.arch}`];
    for (const v of variants) { const p = join(scope, `claude-agent-sdk-${v}`, `claude${ext}`); if (existsSync(p)) return p; }
  } catch {}
  return null;
}

/** Quote the resolved binary so a path with spaces survives the terminal we hand it to. */
function claudeCmd(sub) {
  const bin = claudeBin() || 'claude';
  return `${/\s/.test(bin) ? `"${bin}"` : bin} ${sub}`;
}

export const auth = { type: 'subscription', setup: 'Click “Sign in” (or run `claude auth login` in a terminal).' };
export const loginCommand = () => claudeCmd('auth login');
export const logoutCommand = () => claudeCmd('auth logout');
export const installCommand = () => 'npm i -g @anthropic-ai/claude-code';

/** Open an idle SDK session, run control requests, close it. */
export async function withControl(fn, { cwd = process.cwd(), timeoutMs = 45000 } = {}) {
  const ac = new AbortController();
  let release; const gate = new Promise((r) => { release = r; });
  async function* input() { await gate; }
  const q = query({ prompt: input(), options: { abortController: ac, cwd, tools: [], settingSources: [], persistSession: false, maxTurns: 1 } });
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await q.initializationResult();
    return await fn(q);
  } finally {
    clearTimeout(timer);
    release();
    ac.abort();
    try { await q.return(); } catch {}
  }
}

export async function detect() {
  try {
    const info = await withControl((q) => q.accountInfo());
    return { installed: true, loggedIn: !!(info?.email || info?.subscriptionType), subscription: info?.subscriptionType || null, provider: info?.apiProvider || null };
  } catch (e) {
    return { installed: true, loggedIn: false, error: String(e?.message || e) };
  }
}

/** Effort levels by model generation (the SDK only reports them for its aliases). */
export function effortsFor(modelId) {
  const m = /claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(modelId);
  if (!m) return [];
  const [, family, major, minor] = m; const v = Number(major) + Number(minor || 0) / 10;
  if (family === 'haiku') return [];
  if (family === 'fable' || v >= 5 || (family === 'opus' && v >= 4.7)) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (v >= 4.6) return ['low', 'medium', 'high', 'max'];
  if (family === 'opus' && v >= 4.5) return ['low', 'medium', 'high'];
  return [];
}

/** The claude.ai login token Claude Code keeps on disk; used only against api.anthropic.com. */
function oauthToken() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const j = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8'));
    const t = j.claudeAiOauth?.accessToken;
    if (!t || (j.claudeAiOauth.expiresAt && j.claudeAiOauth.expiresAt < Date.now() + 60_000)) return null;
    return t;
  } catch { return null; }
}

/**
 * "claude-opus-4-5-20251101" -> "Claude Opus 4.5": the Models API's own naming, rebuilt for an id it does not list.
 * Words become the name, trailing numbers the version, a date suffix is dropped.
 */
function prettyName(id) {
  const words = [], ver = [];
  for (const part of String(id).replace(/-\d{8}$/, '').split('-')) (/^\d+$/.test(part) ? ver : words).push(part);
  if (!words.length) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') + (ver.length ? ' ' + ver.join('.') : '');
}

/** Every model the account can use, from the Models API (live: new models appear without an update). */
export async function listApiModels() {
  const token = oauthToken();
  if (!token) return [];
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id, createdAt: m.created_at || null }));
}

export async function listModels() {
  const [aliases, api] = await Promise.all([
    withControl((q) => q.supportedModels()),
    listApiModels().catch(() => []),
  ]);
  // The CLI's alias names ("Default (recommended)", "Opus (1M context)") read nothing like the Models API's
  // "Claude Opus 4.8", so one selector mixes two conventions. Name every alias after the model it resolves to,
  // and keep what the alias itself means as a suffix.
  const apiName = new Map(api.map((m) => [m.id, m.label]));
  const aliasLabel = (m) => {
    const resolved = m.resolvedModel || m.value;
    const base = resolved.replace(/\[1m\]$/, '');
    const name = apiName.get(base) || prettyName(base);
    if (!name) return m.displayName;
    const oneM = resolved.endsWith('[1m]') || m.value.endsWith('[1m]'); // fable-5-1[1m] resolves to an id without the marker
    return name + (oneM ? ' (1M context)' : '') + (m.value === 'default' ? ' · default' : '');
  };
  const out = (aliases || []).map((m) => ({
    provider: id, id: m.value, resolved: m.resolvedModel || null, label: aliasLabel(m), description: m.description || '',
    efforts: m.supportedEffortLevels || (m.supportsEffort ? ['low', 'medium', 'high'] : []), kind: 'agent', cost: 'subscription',
  }));
  const covered = new Set(out.flatMap((m) => [m.id, m.resolved, (m.resolved || '').replace(/\[1m\]$/, '')]).filter(Boolean));
  for (const m of api) {
    if (covered.has(m.id)) continue;
    out.push({ provider: id, id: m.id, resolved: null, label: m.label, description: 'from the Models API', efforts: effortsFor(m.id), kind: 'agent', cost: 'subscription' });
  }
  return out;
}

export async function pollLimits() {
  const u = await withControl((q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
  return normalizeUsage(u);
}

// Claude model families used for label scoping in windowFromEvent and WINDOW_LABELS.
// A window key of the form five_hour_<suffix> or seven_day_<suffix> is scoped to <suffix> when the suffix is not
// a known non-model suffix (overage_included, overage). Global keys (five_hour, seven_day) remain unscoped.
// model_scoped rows are ALWAYS scoped to their own display_name (familyRe, else a regex-escaped name), never left
// unscoped, so a novel model window (e.g. "Nimbus Quill") never blocks the entire provider.
const CLAUDE_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const familyRe = (s) => CLAUDE_FAMILIES.find((f) => String(s || '').toLowerCase().includes(f)) || null;
// Vendor display names / key suffixes become models: regexes. Escape metacharacters and treat
// runs of [-_ ] as interchangeable so "Nimbus Quill" matches claude-nimbus-quill-1.
function escapeScope(s) {
  return String(s || '').toLowerCase().replace(/[-_ ]+/g, '\0').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\0/g, '[-_ ]');
}
const WINDOW_LABELS = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet', seven_day_haiku: 'weekly Haiku', seven_day_fable: 'weekly Fable', seven_day_overage_included: 'weekly (overage)', overage: 'overage' };
// Non-model suffixes in composite rate_limit keys — a suffix on this list is never used as a model scope.
const NON_MODEL_SUFFIXES = new Set(['overage_included', 'overage']);
// Global (unscoped) base keys; a composite key of the form <base>_<suffix> is scoped to its suffix.
const GLOBAL_BASE_KEYS = new Set(['five_hour', 'seven_day']);

/**
 * Derive a `models` scope for a rate_limits key. Returns the suffix for composite keys whose base is
 * a known global key and whose suffix is not a known non-model suffix. familyRe is tried first so
 * known families remain recognised; for unknown suffixes the suffix is regex-escaped as the scope.
 */
function modelsForKey(key) {
  for (const base of GLOBAL_BASE_KEYS) {
    if (key === base) return null; // global key — no scope
    if (key.startsWith(base + '_')) {
      const suffix = key.slice(base.length + 1);
      if (NON_MODEL_SUFFIXES.has(suffix)) return null;
      // Known family? Return it (for providerWindows regex matching). Otherwise a regex-escaped suffix.
      return familyRe(suffix) || escapeScope(suffix);
    }
  }
  return null; // unrecognised key format — no scope (treat as global)
}

export function normalizeUsage(u) {
  const rl = u?.rate_limits || {};
  const windows = [];
  // Emit EVERY reported rate-limit window (so a newly-added five_hour_opus / seven_day_haiku appears on its own),
  // each auto-scoped by modelsForKey; global windows (five_hour, seven_day) stay unscoped.
  for (const [key, val] of Object.entries(rl)) {
    if (key === 'model_scoped' || key === 'extra_usage' || !val || typeof val !== 'object' || val.utilization == null) continue;
    const models = modelsForKey(key);
    windows.push({ id: key, label: WINDOW_LABELS[key] || key.replace(/_/g, ' '), usedPercent: val.utilization, resetsAt: val.resets_at ? Date.parse(val.resets_at) : null, ...(models ? { models } : {}) });
  }
  // model_scoped rows: ALWAYS scope to display_name. familyRe extracts a known family for matching
  // breadth (e.g. "Opus 4.8" → "opus" so any opus model id is matched), else a regex-escaped name.
  for (const m of rl.model_scoped || []) {
    const models = familyRe(m.display_name) || escapeScope(m.display_name);
    windows.push({ id: `model:${m.display_name}`, label: `weekly ${m.display_name}`, usedPercent: m.utilization, resetsAt: m.resets_at ? Date.parse(m.resets_at) : null, models });
  }
  return {
    provider: id, plan: u?.subscription_type || null, available: !!u?.rate_limits_available,
    // Whole-provider block ONLY from an unscoped (global) window at 100%. A maxed model-scoped window (e.g. weekly
    // Opus) blocks just that model — via admit/providerWindows, which see the scoped window — not Fable/Sonnet.
    blocked: windows.some((w) => !w.models && (w.usedPercent ?? 0) >= 100), windows,
    extraUsage: rl.extra_usage || null,
    session: u?.session ? { costUsd: u.session.total_cost_usd, modelUsage: u.session.model_usage } : null,
  };
}

/** Translate a live SDKRateLimitInfo (from a running session) into a window update. */
export function windowFromEvent(info) {
  if (!info?.rateLimitType) return null;
  const models = familyRe(info.rateLimitType);
  return { id: info.rateLimitType, label: WINDOW_LABELS[info.rateLimitType] || info.rateLimitType, usedPercent: info.utilization != null ? Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1)) : null, resetsAt: info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : null, status: info.status, ...(models ? { models } : {}) };
}
