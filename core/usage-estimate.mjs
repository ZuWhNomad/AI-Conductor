// Estimate a provider's plan usage % from token spend, for providers whose CLI reports no window (e.g. Grok).
// Calibrated by manual check-ins the user records ("Grok 17%"): each pairs an observed % with the tokens spent
// so far this window, giving a %-per-token rate the estimate extrapolates between check-ins. No timezone math —
// the window boundary is inferred from a long gap in the provider's own activity, and re-anchored on each reset.
import { appendNdjson, readNdjson, statePath } from './paths.mjs';
import { runRows, nextScheduledReset } from './scorecard.mjs';
import { loadConfig } from './config.mjs';

const FILE = () => statePath('usage-observations.ndjson');
// A gap this long in a provider's own activity starts a fresh usage window. Per-provider via config
// (scorecard.usageGapHours), so a daily-reset provider like Grok can use 24h instead of the 6h default.
const gapMs = (provider) => { const g = loadConfig().scorecard?.usageGapHours || {}; return (g[provider] ?? g.default ?? 6) * 3600_000; };

/** Provider run rows (in+out tokens) sorted oldest-first. Cached tokens are excluded — they barely move a plan window. */
function tokenRuns(provider) {
  return runRows().filter((r) => r.provider === provider && r.tokens).map((r) => ({ ts: Date.parse(r.ts), tokens: (r.tokens.in || 0) + (r.tokens.out || 0) })).filter((r) => r.ts).sort((a, b) => a.ts - b.ts);
}

/** The current usage window: cumulative provider tokens spent since the last long gap (window start). */
export function windowTokens(provider, now = Date.now()) {
  const runs = tokenRuns(provider);
  let startIdx = 0;
  for (let i = 1; i < runs.length; i++) if (runs[i].ts - runs[i - 1].ts > gapMs(provider)) startIdx = i;
  const startTs = runs.length ? runs[startIdx].ts : now;
  const spent = runs.slice(startIdx).reduce((s, r) => s + r.tokens, 0);
  return { spent, startTs, runs: runs.length - startIdx };
}

/** Record a user check-in: observed % now, paired with tokens spent this window. */
export function recordUsage(provider, pct, { at = Date.now() } = {}) {
  const { spent, startTs } = windowTokens(provider, at);
  const row = { op: 'usage', provider, at: new Date(at).toISOString(), pct: Number(pct), tokens: spent, windowStart: new Date(startTs).toISOString() };
  appendNdjson(FILE(), row);
  return row;
}

/** Most recent scheduled reset for a provider (the plan's real window floor), or null when it has no schedule. */
function lastScheduledReset(provider, now = Date.now()) {
  const cfg = loadConfig().scorecard;
  const next = nextScheduledReset(provider, cfg, now);
  if (next == null) return null;
  const period = (Number(cfg.usageResets?.[provider]?.periodHours) || 0) * 3600_000;
  return period > 0 ? next - period : null;
}

/** Provider tokens (in+out) spent since an absolute instant — the through-origin anchor for the estimate. */
function tokensSince(provider, sinceTs) {
  return tokenRuns(provider).filter((r) => r.ts >= sinceTs).reduce((s, r) => s + r.tokens, 0);
}

/** The latest persisted check-in still inside the current reset period (a durable calibration anchor), or null.
 * Anchoring the estimate to the check-in's OWN recorded window — not a freshly re-inferred activity-gap window — is
 * what makes a calibrated bar survive restarts and idle gaps. The gap heuristic drifts its window start PAST an older
 * check-in the moment the provider is idle longer than the gap (Grok's real plan is weekly, the default gap 6h), and
 * the estimate then silently reverted to the flat token budget (~1%). A scheduled reset (Grok = weekly) expires it. */
function latestCheckin(provider, now = Date.now()) {
  const floor = lastScheduledReset(provider, now);
  const obs = readNdjson(FILE()).filter((o) => o.op === 'usage' && o.provider === provider && Number.isFinite(Date.parse(o.at)) && (floor == null || Date.parse(o.at) >= floor));
  return obs.length ? obs.reduce((a, b) => (Date.parse(b.at) >= Date.parse(a.at) ? b : a)) : null;
}

/**
 * Estimate the provider's current plan % from token spend. Once the user has calibrated (a check-in exists in the
 * current window), the estimate is anchored to that check-in's recorded window and re-applied on every load — so a
 * calibrated value holds across restarts until the next check-in or a real reset. Before any check-in it falls back
 * to a flat token budget (advisory), or a config seed rate, else null. Advisory only — it never gates the scheduler.
 * @param {object} [o] `budgetTokens` (flat "100% at N tokens" fallback, pre-calibration only), `seedPctPerMToken`
 *   (a rate used before any check-in exists), `resetsAt` (shown on the bar), `now`.
 */
export function estimateUsage(provider, { now = Date.now(), budgetTokens = null, seedPctPerMToken = null, resetsAt = null } = {}) {
  // Overshoot: running this far PAST the projected 100% without the provider actually failing means the projection is
  // stale — the budget is too low, or the window reset earlier than expected. `needsCheck` asks the user to re-verify.
  const overshootAt = loadConfig().scorecard?.usageOvershootPct ?? 110;
  const flag = (rawPct) => ({ rawPct: Math.round(rawPct * 10) / 10, needsCheck: rawPct >= overshootAt });
  const round1 = (n) => Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;

  const anchor = latestCheckin(provider, now);
  if (anchor) {
    // Spend and rate are BOTH measured from the check-in's own window start (exactly as recordUsage measured its
    // `tokens`), so they stay consistent no matter how the activity-gap heuristic would re-infer the window now.
    const startTs = Date.parse(anchor.windowStart) || 0;
    const spent = tokensSince(provider, startTs);
    // Least-squares fit of pct = rate·tokens through the origin, over every check-in from THIS same window (robust to
    // whole-percent rounding and uneven spacing); a single check-in gives rate = pct / tokens.
    const obs = readNdjson(FILE()).filter((o) => o.op === 'usage' && o.provider === provider && o.windowStart === anchor.windowStart);
    let num = 0, den = 0; for (const o of obs) { num += o.pct * o.tokens; den += o.tokens * o.tokens; }
    const rate = den ? num / den : anchor.pct / Math.max(1, anchor.tokens);
    const raw = spent * rate;
    return { pct: round1(raw), rate, ratePctPerMToken: Math.round(rate * 1e6 * 100) / 100, spent, basis: 'fit', anchorPct: anchor.pct, anchorAt: anchor.at || null, points: obs.length, calibrated: true, advisory: true, resetsAt, ...flag(raw) };
  }

  // No calibration yet.
  const { spent } = windowTokens(provider, now);
  if (budgetTokens) { // flat budget: 100% at budgetTokens, advisory — ONLY until a check-in exists.
    const raw = (spent / budgetTokens) * 100;
    return { pct: round1(raw), rate: 1 / budgetTokens, ratePctPerMToken: Math.round(1e6 / budgetTokens * 100) / 100, spent, budgetTokens, basis: 'budget', anchorPct: null, points: 0, calibrated: false, advisory: true, resetsAt, ...flag(raw) };
  }
  if (seedPctPerMToken) { // config seed rate before any check-in
    const rate = seedPctPerMToken / 1e6; const raw = spent * rate;
    return { pct: round1(raw), rate, ratePctPerMToken: Math.round(rate * 1e6 * 100) / 100, spent, basis: 'fit', anchorPct: null, points: 0, calibrated: false, advisory: true, resetsAt, ...flag(raw) };
  }
  return null;
}
