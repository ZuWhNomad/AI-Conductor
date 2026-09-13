// Estimate a provider's plan usage % from token spend, for providers whose CLI reports no window (e.g. Grok).
// Calibrated by manual check-ins the user records ("Grok 17%"): each pairs an observed % with the tokens spent
// so far this window, giving a %-per-token rate the estimate extrapolates between check-ins. No timezone math —
// the window boundary is inferred from a long gap in the provider's own activity, and re-anchored on each reset.
import { appendNdjson, readNdjson, statePath } from './paths.mjs';
import { runRows } from './scorecard.mjs';

const FILE = () => statePath('usage-observations.ndjson');
const GAP_MS = 6 * 3600_000; // a gap this long between a provider's runs starts a fresh usage window

/** Provider run rows (in+out tokens) sorted oldest-first. Cached tokens are excluded — they barely move a plan window. */
function tokenRuns(provider) {
  return runRows().filter((r) => r.provider === provider && r.tokens).map((r) => ({ ts: Date.parse(r.ts), tokens: (r.tokens.in || 0) + (r.tokens.out || 0) })).filter((r) => r.ts).sort((a, b) => a.ts - b.ts);
}

/** The current usage window: cumulative provider tokens spent since the last long gap (window start). */
export function windowTokens(provider, now = Date.now()) {
  const runs = tokenRuns(provider);
  let startIdx = 0;
  for (let i = 1; i < runs.length; i++) if (runs[i].ts - runs[i - 1].ts > GAP_MS) startIdx = i;
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

/** Observations for the provider that belong to the current window (same window start as now). */
function windowObservations(provider, now = Date.now()) {
  const { startTs } = windowTokens(provider, now);
  return readNdjson(FILE()).filter((o) => o.op === 'usage' && o.provider === provider && Date.parse(o.windowStart) >= startTs - GAP_MS && Date.parse(o.at) >= startTs - GAP_MS);
}

/**
 * Estimate the provider's current plan % from token spend. Rate = observed % / tokens at the latest check-in
 * (or the slope between the two most recent). Returns null when there is nothing to calibrate from.
 * @param {object} [o] optional `seedPctPerMToken` (a config default used before any check-in exists)
 */
export function estimateUsage(provider, { now = Date.now(), seedPctPerMToken = null, resetsAt = null } = {}) {
  const { spent } = windowTokens(provider, now);
  const obs = windowObservations(provider, now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // Least-squares fit of pct = rate·tokens through the origin (0% at the window start): robust to whole-percent
  // rounding and uneven check-in spacing, and uses every reading. Falls back to a config seed before any check-in.
  let rate; // % per token
  if (obs.length) { let num = 0, den = 0; for (const o of obs) { num += o.pct * o.tokens; den += o.tokens * o.tokens; } rate = den ? num / den : obs[obs.length - 1].pct / Math.max(1, obs[obs.length - 1].tokens); }
  else if (seedPctPerMToken) rate = seedPctPerMToken / 1e6;
  else return null;
  const latest = obs[obs.length - 1] || { tokens: 0, pct: 0 };
  const pct = Math.max(0, Math.min(100, spent * rate)); // through-origin: % scales with tokens spent this window
  return { pct: Math.round(pct * 10) / 10, rate, ratePctPerMToken: Math.round(rate * 1e6 * 100) / 100, spent, anchorPct: latest.pct, anchorAt: latest.at || null, points: obs.length, calibrated: obs.length > 0, resetsAt };
}
