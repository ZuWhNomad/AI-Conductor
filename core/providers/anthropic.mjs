// Claude provider (the conductor's own vendor): models, account and plan limits via the Agent SDK's
// control channel. No tokens are spent: these are control requests on an idle session.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const id = 'claude';
export const label = 'Claude (Anthropic subscription)';
export const kind = 'claude';
export const auth = { type: 'subscription', setup: 'Run `claude auth login` in a terminal (one time).' };
export const loginCommand = () => 'claude auth login';
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
  const out = (aliases || []).map((m) => ({
    provider: id, id: m.value, resolved: m.resolvedModel || null, label: m.displayName, description: m.description || '',
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

export function normalizeUsage(u) {
  const rl = u?.rate_limits || {};
  const win = (key, label) => rl[key] ? [{ id: key, label, usedPercent: rl[key].utilization, resetsAt: rl[key].resets_at ? Date.parse(rl[key].resets_at) : null }] : [];
  const windows = [
    ...win('five_hour', '5-hour'), ...win('seven_day', 'weekly'), ...win('seven_day_opus', 'weekly Opus'), ...win('seven_day_sonnet', 'weekly Sonnet'),
    ...(rl.model_scoped || []).map((m) => ({ id: `model:${m.display_name}`, label: `weekly ${m.display_name}`, usedPercent: m.utilization, resetsAt: m.resets_at ? Date.parse(m.resets_at) : null })),
  ];
  return {
    provider: id, plan: u?.subscription_type || null, available: !!u?.rate_limits_available,
    blocked: windows.some((w) => (w.usedPercent ?? 0) >= 100), windows,
    extraUsage: rl.extra_usage || null,
    session: u?.session ? { costUsd: u.session.total_cost_usd, modelUsage: u.session.model_usage } : null,
  };
}

/** Translate a live SDKRateLimitInfo (from a running session) into a window update. */
export function windowFromEvent(info) {
  if (!info?.rateLimitType) return null;
  const labels = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet', seven_day_overage_included: 'weekly (overage)', overage: 'overage' };
  return { id: info.rateLimitType, label: labels[info.rateLimitType] || info.rateLimitType, usedPercent: info.utilization != null ? Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1)) : null, resetsAt: info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : null, status: info.status };
}
