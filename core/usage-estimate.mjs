// Estimate a provider's plan usage % from token spend, for providers whose CLI reports no window (e.g. Grok).
//
// The user's check-in is the truth: "Grok 36%" means the bar reads 36% now, whether that is up or down from what
// Conductor showed. From there the bar grows by tokens × a learned rate:
//
//     pct(now) = anchorPct + rate × (tokens spent since the anchor)
//
// The rate is measured from ASCENDING RUNS of check-ins only: split the history at every drop (a drop means the plan
// window reset, or the user corrected us), and each remaining run contributes one %-per-token measurement. So
// 0,10,50,70,0,50,0,23 yields three measurements, each from its own origin, and the median of them sharpens as more
// weeks are recorded. A reset is data, not noise.
//
// There is deliberately no window inference here: an earlier version fitted pct = rate × tokens through the origin
// over one inferred window, which cannot express "0% at 8.7M tokens" except as rate 0 — so a reset check-in was
// averaged against the old high readings and the bar crept down instead of dropping (100% → 11.8% over 15 clicks).
// A reset schedule is honoured only when the user configured one, because a wrong assumed reset is worse than none.
import { appendNdjson, readNdjson, statePath } from './paths.mjs';
import { runRows, prevScheduledReset, nextScheduledReset } from './scorecard.mjs';
import { loadConfig } from './config.mjs';
import { getLimits } from './limits.mjs';
import { PROVIDERS } from './providers/index.mjs';

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
  const gap = gapMs(provider);
  let startIdx = 0;
  for (let i = 1; i < runs.length; i++) if (runs[i].ts - runs[i - 1].ts > gap) startIdx = i;
  const startTs = runs.length ? runs[startIdx].ts : now;
  const spent = runs.slice(startIdx).reduce((s, r) => s + r.tokens, 0);
  return { spent, startTs, runs: runs.length - startIdx };
}

/** Cumulative provider tokens (in+out) up to an instant. The basis for every delta between check-ins: unlike
 *  window-relative counts it never moves when the window heuristic re-infers a boundary. */
function totalTokens(provider, upTo = Infinity) {
  return tokenRuns(provider).filter((r) => r.ts <= upTo).reduce((s, r) => s + r.tokens, 0);
}

/** Record a user check-in: the observed % now, with the cumulative token counter it was observed at. */
export function recordUsage(provider, pct, { at = Date.now() } = {}) {
  const { spent, startTs } = windowTokens(provider, at);
  // `total` is what the rate is measured from; `tokens`/`windowStart` stay for rows written before that existed.
  const row = { op: 'usage', provider, at: new Date(at).toISOString(), pct: Number(pct), tokens: spent, windowStart: new Date(startTs).toISOString(), total: totalTokens(provider, at) };
  appendNdjson(FILE(), row);
  return row;
}

/** Every check-in for a provider, oldest first. */
function checkins(provider) {
  return readNdjson(FILE())
    .filter((o) => o.op === 'usage' && o.provider === provider && Number.isFinite(Date.parse(o.at)) && Number.isFinite(Number(o.pct)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Tokens spent between two check-ins, or null when the two rows share no common basis (old rows from different
 *  inferred windows: their `tokens` counters are not comparable, so that pair simply teaches us nothing). */
function tokensBetween(a, b) {
  if (Number.isFinite(a.total) && Number.isFinite(b.total)) return b.total - a.total;
  if (a.windowStart && a.windowStart === b.windowStart) return (b.tokens || 0) - (a.tokens || 0);
  return null;
}

const MIN_RUN_TOKENS = 50_000; // a run shorter than this measures rounding, not a burn rate
const median = (xs) => { const s = [...xs].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

/** The %-per-token rate, measured once per ascending run of check-ins and medianed across runs (all history, so it
 *  keeps improving). Returns null until one run is long enough to mean anything. */
export function learnedRate(provider, obs = checkins(provider)) {
  const runs = [];
  let run = [];
  for (const o of obs) {
    const prev = run[run.length - 1];
    // A drop ends the run (the window reset, or we were corrected). So does a pair we cannot measure across: rows
    // written before `total` existed count tokens from their own inferred window, so a run spanning two of those
    // windows has no common basis — splitting keeps the measurable part instead of discarding the whole run.
    if (prev && (Number(o.pct) < Number(prev.pct) || tokensBetween(prev, o) == null)) { runs.push(run); run = []; }
    run.push(o);
  }
  runs.push(run);
  const slopes = [];
  for (const r of runs) {
    if (r.length < 2) continue;
    const first = r[0], last = r[r.length - 1];
    const dPct = Number(last.pct) - Number(first.pct);
    const dTok = tokensBetween(first, last);
    if (dPct > 0 && dTok != null && dTok >= MIN_RUN_TOKENS) slopes.push(dPct / dTok);
  }
  return slopes.length ? { rate: median(slopes), runs: slopes.length, lo: Math.min(...slopes), hi: Math.max(...slopes) } : null;
}

/** Most recent scheduled reset for a provider (the plan's real window floor), or null when it has no schedule.
 *  Read from the user's Settings on every call, so editing the day or hour moves the boundary immediately. */
const lastScheduledReset = (provider, now = Date.now()) => prevScheduledReset(provider, loadConfig().scorecard, now);

/** Provider tokens (in+out) spent since an absolute instant — the through-origin anchor for the estimate. */
function tokensSince(provider, sinceTs) {
  return tokenRuns(provider).filter((r) => r.ts >= sinceTs).reduce((s, r) => s + r.tokens, 0);
}

/**
 * Estimate the provider's current plan % from token spend. The last check-in the user recorded is the anchor — its
 * value is shown as-is and the bar grows from it at the learned rate, so a correction lands immediately and a reset
 * (type 0) really reads 0. A configured reset schedule moves the anchor to 0 at the scheduled instant; without one,
 * nothing is assumed. Before any check-in it falls back to a flat token budget (advisory), or a config seed rate,
 * else null. Advisory only — it never gates the scheduler.
 * @param {object} [o] `budgetTokens` (flat "100% at N tokens" fallback, pre-calibration only), `seedPctPerMToken`
 *   (a rate used before any check-in exists), `resetsAt` (shown on the bar), `now`.
 */
export function estimateUsage(provider, { now = Date.now(), budgetTokens = null, seedPctPerMToken = null, resetsAt = null } = {}) {
  // Overshoot: running this far PAST the projected 100% without the provider actually failing means the projection is
  // stale — the budget is too low, or the window reset earlier than expected. `needsCheck` asks the user to re-verify.
  const overshootAt = loadConfig().scorecard?.usageOvershootPct ?? 110;
  const flag = (rawPct) => ({ rawPct: Math.round(rawPct * 10) / 10, needsCheck: rawPct >= overshootAt });
  const pctPerM = (r) => Math.round(r * 1e6 * 100) / 100; // rate is percent-per-token; show it per million
  const round1 = (n) => Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;

  const obs = checkins(provider).filter((o) => Date.parse(o.at) <= now);
  const anchor = obs[obs.length - 1] || null;
  if (anchor) {
    let anchorPct = Number(anchor.pct), anchorTs = Date.parse(anchor.at), anchorFrom = 'checkin';
    // A reset schedule the user configured (only then does one exist) zeroes the bar at its instant and keeps the
    // rate. `<= now` matters: a day offset longer than the period puts the "last" reset in the future, which would
    // pin the bar at 0 until that date.
    const sched = lastScheduledReset(provider, now);
    if (sched != null && sched <= now && sched > anchorTs) { anchorPct = 0; anchorTs = sched; anchorFrom = 'reset'; }
    const spent = tokensSince(provider, anchorTs);
    const learned = learnedRate(provider, obs);
    // No ascending run yet = the burn rate is genuinely unknown, so fall back to the same advisory rate the
    // uncalibrated bar uses. Dividing this check-in's % by "tokens spent this window" would be a rate built on the
    // activity-gap guess this model exists to be rid of — one small window turns "50%" into 500%/M.
    const rate = learned?.rate ?? (seedPctPerMToken ? seedPctPerMToken / 1e6 : budgetTokens ? 100 / budgetTokens : 0);
    const raw = anchorPct + spent * rate;
    return {
      pct: round1(raw), rate, ratePctPerMToken: pctPerM(rate), spent, basis: 'fit',
      anchorPct, anchorAt: new Date(anchorTs).toISOString(), anchorFrom, points: obs.length,
      rateBasis: learned ? 'runs' : 'fallback', runs: learned?.runs || 0,
      rateLo: learned?.lo ?? null, rateHi: learned?.hi ?? null,
      calibrated: true, advisory: true, resetsAt, ...flag(raw),
    };
  }

  // No calibration yet.
  const { spent } = windowTokens(provider, now);
  if (budgetTokens) { // flat budget: 100% at budgetTokens, advisory — ONLY until a check-in exists.
    const raw = (spent / budgetTokens) * 100;
    return { pct: round1(raw), rate: 100 / budgetTokens, ratePctPerMToken: pctPerM(100 / budgetTokens), spent, budgetTokens, basis: 'budget', anchorPct: null, points: 0, calibrated: false, advisory: true, resetsAt, ...flag(raw) };
  }
  if (seedPctPerMToken) { // config seed rate before any check-in
    const rate = seedPctPerMToken / 1e6; const raw = spent * rate;
    return { pct: round1(raw), rate, ratePctPerMToken: pctPerM(rate), spent, basis: 'fit', anchorPct: null, points: 0, calibrated: false, advisory: true, resetsAt, ...flag(raw) };
  }
  return null;
}

/** Serve limits with a synthetic "estimated" window for subscription providers whose CLI reports no window (Grok):
 *  usage is estimated from token spend, calibrated by the user's check-ins (POST /api/providers/:id/usage). */
const pct1 = (n) => Math.round(n * 10) / 10; // %/M tokens, one decimal
export function limitsWithEstimates() {
  const lim = getLimits();
  const out = { ...lim, providers: { ...lim.providers } };
  for (const id of Object.keys(PROVIDERS)) {
    const p = out.providers[id] || {};
    if ((p.windows || []).length) continue; // real windows win
    const budgetTokens = loadConfig().scorecard?.usageBudgets?.[id] || null;
    const resetsAt = nextScheduledReset(id) || null; // from the configured reset schedule (usageResets), so the estimate shows a reset + drives the waste discount
    const est = estimateUsage(id, { budgetTokens, resetsAt });
    // Show the bar whenever we can produce ANY estimate — even before a real check-in (a flat token budget is a
    // sensible uncalibrated fallback) — so a subscription CLI like Grok never sits blank. It is clearly marked as an
    // estimate; a check-in refines it. Providers with neither a budget nor a check-in still produce no estimate.
    if (!est) continue;
    const note = est.needsCheck
      ? `past projected limit (~${est.rawPct}%) but still running — did it reset early, or is the budget too low? Re-check the real usage and calibrate.`
      : est.calibrated
        ? `${est.anchorPct}% ${est.anchorFrom === 'reset' ? 'at the scheduled reset' : 'recorded'}${est.anchorAt ? ` ${new Date(est.anchorAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''} + ~${est.ratePctPerMToken}%/M tokens since${est.rateBasis === 'runs' ? ` (${est.runs} measured run${est.runs > 1 ? 's' : ''}${est.runs > 1 ? `, ${pct1(est.rateLo * 1e6)}–${pct1(est.rateHi * 1e6)}` : ''})` : ' — burn rate not measured yet, record a second, higher % to learn it'}`
        : budgetTokens
          ? `uncalibrated estimate against a ${(budgetTokens / 1e6).toLocaleString()}M-token budget — record a real usage % to calibrate`
          : 'uncalibrated estimate — record a real usage % to calibrate';
    out.providers[id] = { ...p, provider: id, windows: [{ id: `${id}:estimated`, label: 'estimated usage', usedPercent: est.pct, resetsAt: est.resetsAt, estimated: true, calibrated: !!est.calibrated, needsCheck: !!est.needsCheck, note }] };
  }
  return out;
}
