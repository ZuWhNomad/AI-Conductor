// Scorecard recommend: turn the summary rows into a *plan* for a category at a difficulty — one model, or a ladder
// (cheap first, stronger on fail) — by utility = value-of-quality − expected cost, walked by budget class. Also the
// provider-side cost model that feeds it: class, availability, weight, waste discount, scheduled resets, efforts.
import { getLimits, groupOf, modelBlockedUntil, providerWindows, isSession, withLimitsSnapshot } from '../limits.mjs';
import { getModels } from '../models.mjs';
import { loadConfig, DEFAULTS } from '../config.mjs';
import { priceFor, priorFor, TIER_CEILING, KIND } from '../priors.mjs';
import { PROVIDERS } from '../providers/index.mjs';
import {
  ROUTED_MAX_DIFFICULTY, EFFORTS, selOf, parseSel, scorecardModelId, isArchived, archivedSet, modelInRegistry,
  evidenceRated, eligibilityOverrides, eligibilityKey,
} from './ledger.mjs';
import { summarize, RELIABILITY_TOTALS, SMOKE_TOTALS } from './summary.mjs';

/**
 * Best plan for a category at a difficulty: max utility = valueOfQuality × expected quality − expected
 * cost ($ at API list prices + optional $/hour of wall clock). Plans are single models that clear the
 * quality bar, observed ladders, and estimated ladders (cheap first step, qualified fallback; assumes
 * independent failures). Returns null when nothing measured qualifies (then the prior fallback, if enabled).
 */
export function recommend(opts = {}) {
  const explanation = opts.explain ? {} : null;
  const eligibility = new Map(eligibilityOverrides({ category: opts.category }).map((r) => [eligibilityKey(r.sel, r.category), r]));
  const pick = withLimitsSnapshot(() => recommendPlan({ ...opts, _explain: explanation, _eligibility: eligibility }));
  if (!opts.explain) return pick;
  const manualEligibility = [...eligibility.values()];
  if (pick) return { pick, explain: { status: 'picked', reason: pick.reason, capped: [], manualEligibility } };
  if (explanation.status) return { pick: null, explain: { ...explanation, manualEligibility } };
  const blocked = manualEligibility.filter((r) => r.action === 'block');
  if (blocked.length) return { pick: null, explain: { status: 'eligibility', reason: blocked.map((r) => `${r.sel} manually blocked: ${r.reason}`).join('; '), capped: [], manualEligibility } };
  return { pick: null, explain: { status: 'no-match', reason: `no qualified selection for ${opts.category}@${opts.difficulty ?? 2}`, capped: [], manualEligibility } };
}

function recommendPlan({ category, difficulty = 2, exclude = [], source = null, summary = null, escalate = false, overflowApi = false, providers = null, reg = getModels(), _noExtrap = false, _allowLowerBenchmark = false, _failedBelow = null, _taskDifficulty = null, _explain = null, _eligibility = new Map() } = {}) {
  const cfg = loadConfig().scorecard;
  const archive = archivedSet(cfg);
  const taskDifficulty = _taskDifficulty ?? difficulty;
  // Per-call memos: availability and weight read the limits registry (a stat each); the summary has hundreds of rows per sel.
  const memo = (fn) => { const m = new Map(); return (...a) => { const k = a.join('|'); if (!m.has(k)) m.set(k, fn(...a)); return m.get(k); }; };
  const avail = memo((provider, model) => providerAvailable(provider, { overflowApi, cfg, model }));
  const weight = memo((provider, model) => providerWeight(provider, cfg, model));
  const waste = memo((provider, model) => wasteDiscount(provider, cfg, model));
  const lambda = cfg.qualityValueUsd, hourly = cfg.hourlyUsd;
  const excluded = (sel) => sel.split('>').some((s) => { const { provider, model } = parseSel(s); return exclude.includes(s) || exclude.includes(`${provider}:${model || 'default'}`); });
  const blockedSel = (sel) => sel.split('>').some((s) => {
    const { provider, model } = parseSel(s);
    // A transient registry error retains cached models; explicit unavailability or removal does not.
    return !Object.hasOwn(PROVIDERS, provider) || reg.providers[provider]?.status === 'unavailable' || modelInRegistry(reg, provider, model)?.kind !== 'agent' || !avail(provider, model);
  });
  const unavailable = (g) => {
    const { provider, model } = g;
    if (reg.providers[provider]?.status === 'unavailable') return { sel: g.sel, reason: 'provider unavailable', resetAt: null };
    if (modelInRegistry(reg, provider, model)?.kind !== 'agent') return { sel: g.sel, reason: 'model unavailable', resetAt: null };
    const blockedUntil = modelBlockedUntil(provider, model);
    if (blockedUntil) return { sel: g.sel, reason: 'provider limit', resetAt: blockedUntil };
    const cls = providerClass(provider, cfg);
    if (cls === 'api' && !overflowApi) return { sel: g.sel, reason: 'API overflow off', resetAt: null };
    const cap = cfg.classCap?.[cls] ?? 100;
    const windows = providerWindows(provider, model).filter((w) => (!w.resetsAt || w.resetsAt > Date.now()) && (cls !== 'conductor' || isSession(w)));
    const capped = windows.filter((w) => (Number(w.usedPercent) || 0) >= cap);
    const resets = capped.map((w) => Number(w.resetsAt)).filter((t) => Number.isFinite(t) && t > Date.now());
    return { sel: g.sel, reason: capped.length ? `${cls} class cap` : 'unavailable', resetAt: resets.length ? Math.min(...resets) : null };
  };
  const all = (summary || summarize({ source })).filter((g) => g.difficulty <= ROUTED_MAX_DIFFICULTY && !g.sel.split('>').some((s) => { const p = parseSel(s); return isArchived(p.provider, p.model, archive, p.effort); }));
  const cellLiveN = (g) => g.liveN ?? (g.smokeN != null ? 0 : g.n ?? 0); // old and hand-built summaries without source counts are live
  const cellLiveRated = (g) => g.liveRated ?? (g.smokeRated != null ? 0 : g.rated ?? cellLiveN(g));
  const cellSmokeRated = (g) => g.smokeRated ?? 0;
  const cellLiveWeightedRated = (g) => g.liveWeightedRated ?? cellLiveRated(g);
  const cellSmokeWeightedRated = (g) => g.smokeWeightedRated ?? cellSmokeRated(g);
  const benchmarkOnly = (g) => cellLiveRated(g) <= 0 && (cellSmokeRated(g) > 0 || g.shipped);
  const benchmarkAllowed = (g) => !benchmarkOnly(g) || g.difficulty === taskDifficulty || (_allowLowerBenchmark && KIND[category] !== 'visual' && g.difficulty === difficulty);
  const allowed = (sel) => !providers || sel.split('>').every((s) => providers.includes(s.split(':')[0])); // access gate: only these providers may take the task
  const decision = (sel) => _eligibility.get(eligibilityKey(sel, category));
  const manuallyBlocked = (sel) => sel.split('>').some((s) => decision(s)?.action === 'block');
  const gate = passGate(category, reg);
  const rows = all.filter((g) => g.category === category && evidenceRated(g) > 0 && benchmarkAllowed(g) && !excluded(g.sel) && !manuallyBlocked(g.sel) && !blockedSel(g.sel) && allowed(g.sel) && gate(g.sel));
  // Reservation capacity is live-only and shared only by models metered by the same quota/window group.
  const quotaGroup = (provider, model) => `${provider}|${groupOf(provider, model).ids.join(',')}`;
  const ceiling = new Map();
  for (const g of all) if ((g.category === 'conductor') === (category === 'conductor') && g.steps === 1 && cellLiveWeightedRated(g) >= cfg.minSamples && (g.liveQuality ?? g.quality) >= cfg.quality) {
    const key = quotaGroup(g.provider, g.model);
    ceiling.set(key, Math.max(ceiling.get(key) || 0, g.difficulty));
  }
  const ceilingFor = (provider, model = null) => ceiling.get(quotaGroup(provider, model)) || 0;
  const reserve = (provider, model = null) => { const w = weight(provider, model); const gap = Math.max(0, ceilingFor(provider, model) - taskDifficulty); return 1 + cfg.reservePct * w * gap; };
  const costOf = (g) => {
    const costs = g.stepCosts || [g];
    if (costs.some((c) => c.avgUsd == null)) return null;
    return costs.reduce((sum, c) => {
      const { provider, model } = parseSel(c.sel.split('>').at(-1));
      const scale = weight(provider, model) * reserve(provider, model) * waste(provider, model);
      return sum + c.avgUsd * scale + hourly * (c.avgDurationMs || 0) / 3.6e6;
    }, 0);
  };
  // Evidence per selection: the cell nearest the requested level (not below), pooling harder cells only until
  // the sample floor is met. A well-sampled failing cell at or below the level disqualifies it as a final step.
  // Keep the original request's disqualifications when extrapolating; priors cannot override them either.
  const failedBelow = _failedBelow || new Set(all.filter((g) => g.category === category && g.difficulty <= difficulty && benchmarkAllowed(g) && evidenceRated(g) >= cfg.benchMinSamples && g.quality < cfg.quality && decision(g.sel)?.action !== 'allow').map((g) => g.sel));
  const bySel = new Map();
  for (const g of rows) {
    const m = bySel.get(g.sel) || { sel: g.sel, steps: g.steps, cells: [] };
    if (g.difficulty >= difficulty) m.cells.push(g);
    bySel.set(g.sel, m);
  }
  const evidence = [...bySel.values()].filter((m) => m.cells.length).map((m) => ({ ...m, ref: pool(m.cells.sort((a, b) => a.difficulty - b.difficulty), cfg.minSamples) })).filter((m) => evidenceRated(m.ref) >= cfg.minSamples);
  const finals = evidence.filter((m) => m.ref.quality >= cfg.quality && !failedBelow.has(m.sel) && !failedBelow.has(m.sel.split('>').at(-1)));
  // M4: extrapolation may build a plan from a lower-level pool. Once this selection has enough evidence at the
  // task's actual level, that cell owns the estimated ladder's probability of accepting the first step.
  const taskLevelAccept = (m) => m.cells.find((c) => c.difficulty === taskDifficulty && evidenceRated(c) >= cfg.minSamples)?.accept ?? m.ref.accept;
  const plans = [];
  for (const m of finals) {
    if (m.steps === 1) {
      plans.push({ steps: m.ref.sel.split('>'), quality: m.ref.quality, usd: costOf(m.ref), estimated: false, ref: m.ref });
      continue;
    }
    // Observed A>B is B given A failed (and costs both steps). Combine with A's single-step stats.
    const aSel = m.sel.split('>')[0];
    const aEv = evidence.find((x) => x.steps === 1 && x.sel === aSel);
    if (!aEv) {
      plans.push({ steps: m.ref.sel.split('>'), quality: m.ref.quality, usd: costOf(m.ref), estimated: false, ref: m.ref });
      continue;
    }
    const pA = aEv.ref.accept ?? 0;
    const quality = aEv.ref.quality + (1 - pA) * m.ref.quality;
    const cA = costOf(aEv.ref);
    const cB = m.ref.stepCosts?.length > 1 ? costOf({ ...m.ref, stepCosts: m.ref.stepCosts.slice(1) }) : (cA != null && costOf(m.ref) != null ? costOf(m.ref) - cA : null);
    const usd = cA == null || cB == null ? null : cA + (1 - pA) * cB;
    plans.push({ steps: m.ref.sel.split('>'), quality, usd, estimated: false, ref: m.ref });
  }
  for (const a of evidence.filter((m) => m.steps === 1 && costOf(m.ref) != null)) {
    for (const b of finals.filter((m) => m.steps === 1 && m.sel !== a.sel && costOf(m.ref) != null)) {
      if (evidence.some((m) => m.sel === `${a.sel}>${b.sel}`)) continue; // observed ladder has minSamples — keep the estimate only while it does not
      const pA = taskLevelAccept(a);
      const combinedQuality = a.ref.quality + (1 - pA) * b.ref.quality;
      // H2/B1: only push the estimated pair when its combined quality clears the bar.
      // A below-bar first step whose combination still clears the bar is allowed.
      if (combinedQuality < cfg.quality) continue;
      plans.push({ steps: [a.sel, b.sel], quality: combinedQuality, usd: costOf(a.ref) + (1 - pA) * costOf(b.ref), estimated: true, ref: a.ref, fallbackRef: b.ref });
    }
  }
  // OB7: unknown-cost plans are eligible but rank after every priced eligible plan. costUnknown marks them.
  for (const p of plans) {
    if (p.usd == null) { p.utility = lambda * p.quality; p.costUnknown = true; }
    else { p.utility = lambda * p.quality - p.usd; }
  }
  if (_allowLowerBenchmark) {
    const livePlans = plans.filter((p) => p.utility > -Infinity && cellLiveRated(p.ref) > 0);
    if (livePlans.length) plans.splice(0, plans.length, ...livePlans);
  }
  // Effort dominance: a higher effort of the same model that costs within effortSlackUsd and is at least as good
  // makes the lower effort pointless (Luna's efforts differ by fractions of a cent; the higher one held up on real work).
  const slackOf = (usd) => Math.max(cfg.effortSlackUsd, usd * (cfg.effortSlackPct / 100)); // absolute floor for cheap models, relative for dear ones
  const dominated = new Set();
  for (const a of plans) for (const b of plans) {
    if (a === b || a.steps.length !== 1 || b.steps.length !== 1 || a.usd == null || b.usd == null) continue;
    // B1: use parseSel so model ids containing ':' parse correctly.
    const { provider: pa, model: ma, effort: ea } = parseSel(a.steps[0]), { provider: pb, model: mb, effort: eb } = parseSel(b.steps[0]);
    if (pa !== pb || ma !== mb || EFFORTS.indexOf(eb) <= EFFORTS.indexOf(ea)) continue;
    if (b.usd <= a.usd + slackOf(a.usd) && b.quality >= a.quality) dominated.add(a);
  }
  for (const p of plans) if (dominated.has(p) || p.steps.some((st) => dominated.has(plans.find((x) => x.steps.length === 1 && x.steps[0] === st)))) p.utility = -Infinity;
  // OB7: sort — priced eligible plans before unknown-cost ones; within each group, value ordering applies.
  const eligible = (p) => p.utility > -Infinity;
  const evidenceRank = (p) => {
    const live = cellLiveWeightedRated(p.ref);
    return live > 0 ? { live: 1, count: live, consistency: p.ref.consistency ?? -1 } : { live: 0, count: cellSmokeWeightedRated(p.ref), consistency: p.ref.consistency ?? -1 };
  };
  const tier = (p) => TIER_CEILING[p.ref.priorTier] || 0;
  const sortCmp = escalate
    ? (x, y) => (evidenceRank(y).live - evidenceRank(x).live) || (evidenceRank(y).count - evidenceRank(x).count) || (evidenceRank(y).consistency - evidenceRank(x).consistency) || (tier(y) - tier(x)) || (y.utility - x.utility)
    : (x, y) => {
        if (eligible(x) !== eligible(y)) return eligible(x) ? -1 : 1;
        if (eligible(x) && x.costUnknown !== y.costUnknown) return x.costUnknown ? 1 : -1; // priced first
         return y.utility - x.utility || (y.quality - x.quality) || ((y.ref.consistency ?? -1) - (x.ref.consistency ?? -1)) || ((x.ref.avgDurationMs ?? 0) - (y.ref.avgDurationMs ?? 0));
      };
  plans.sort(sortCmp);
  // Class walk: the first budget class (in configured order) that holds a viable plan wins; value already ordered the plans.
  const classOf = (p) => providerClass(p.steps[0].split(':')[0], cfg);
  let best = null, bestClass = null;
  if (escalate) {
    // Escalation is the last rung before the conductor does it itself: cells with live rated evidence rank first by
    // that count; otherwise smoke-only cells rank by smoke evidence. Prior tier and utility break the remaining ties,
    // regardless of budget class. Prefer a single model so a cheap-first ladder does not re-dispatch a failed rung.
    best = plans.find((p) => p.utility > -Infinity && p.steps.length === 1) || plans.find((p) => p.utility > -Infinity) || null;
    bestClass = best ? classOf(best) : null;
  } else {
    // B7: a class must be listed in classOrder to be eligible — no fallback for unlisted classes.
    for (const cls of cfg.classOrder || []) { best = plans.find((p) => p.utility > -Infinity && classOf(p) === cls); if (best) { bestClass = cls; break; } }
  }
  if (!best) {
    // A provider proven at this level exists but is capped/blocked/excluded: hand the task back (the conductor does it or
    // waits for a reset) rather than extrapolating to a weaker class. Extrapolate only when nothing at all is proven here.
    // B5: also require allowed(g.sel) so a blocked but disallowed provider does not prevent extrapolation.
    // B2: ignore cells whose model is not a registered agent — an old removed model must not prevent extrapolation.
    const capped = all.filter((g) => g.category === category && g.steps === 1 && g.difficulty >= difficulty && benchmarkAllowed(g) && evidenceRated(g) >= cfg.minSamples && g.quality >= cfg.quality && !excluded(g.sel) && !manuallyBlocked(g.sel) && allowed(g.sel) && gate(g.sel) && modelInRegistry(reg, g.provider, g.model)?.kind === 'agent' && blockedSel(g.sel));
    if (capped.length) {
      if (_explain) {
        const bySel = new Map(capped.map((g) => [g.sel, unavailable(g)]));
        _explain.status = 'capped';
        _explain.reason = `qualified selections for ${category}@${difficulty} are unavailable`;
        _explain.capped = [...bySel.values()].sort((a, b) => (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity) || a.sel.localeCompare(b.sel));
      }
      return _noExtrap ? { capped: true } : null;
    }
    // Nothing proven at this level or above: extrapolate from the nearest lower level (flagged) before the prior.
    // At difficulty 6-7, fall back to the best available model by quality (as escalation does) rather than refusing.
    const fallbackEscalate = escalate || difficulty >= 6;
    for (let d = difficulty - 1; d >= 1 && !_noExtrap; d--) {
      const lower = recommendPlan({ category, difficulty: d, exclude, source, summary: all, escalate: fallbackEscalate, overflowApi, providers, reg, _noExtrap: true, _allowLowerBenchmark: true, _failedBelow: failedBelow, _taskDifficulty: taskDifficulty, _explain, _eligibility });
      if (lower?.capped) return null;
      if (lower?.plan) return { ...lower, reason: `${lower.reason}; extrapolated from level ${d}${lower.evidence?.source === 'bench' ? ' (benchmark evidence)' : ''} — nothing measured at level ${difficulty}+ yet` };
    }
    return priorFallback({ category, difficulty, exclude, cfg, overflowApi, providers, reg, failedBelow, escalate, eligibility: _eligibility });
  }
  const first = parseSel(best.steps[0]);
  const money = (v) => (v == null ? 'cost unknown' : `$${v.toFixed(v < 0.1 ? 3 : 2)}`);
  const describe = (p) => { const lastSel = p.steps[p.steps.length - 1]; const { provider: prov, model: provModel } = parseSel(lastSel); const rs = reserve(prov, provModel); return `${p.steps.join(' then on fail ')}: expected quality ${p.quality.toFixed(2)} at ${money(p.usd)}${p.estimated ? ' (est.)' : ''}${p.ref.cells > 1 ? ` [levels ${p.ref.difficulty}–${p.ref.difficultyMax} pooled]` : ''}${rs > 1 ? ` [reserve ×${rs.toFixed(2)}: ${prov} window group proven to level ${ceilingFor(prov, provModel)}]` : ''}`; };
  const single = plans.find((p) => p.steps.length === 1);
  const alt = plans.filter((p) => p !== best).slice(0, 3).map(describe);
  return {
    provider: first.provider, model: first.model, effort: first.effort,
    fallback: best.fallbackRef ? { provider: best.fallbackRef.provider, model: best.fallbackRef.model, effort: best.fallbackRef.effort } : best.steps.length > 1 ? parseSel(best.steps[1]) : null,
    plan: { steps: best.steps, quality: best.quality, usd: best.usd, estimated: best.estimated, utility: best.utility },
    evidence: { n: best.ref.rated, weightedN: evidenceRated(best.ref), last: best.ref.last || null, source: cellLiveRated(best.ref) > 0 ? 'live' : 'bench', shipped: !!best.ref.shipped,
      consistency: best.ref.consistency ?? null, repeats: best.ref.repeats ?? null,
      errorRate: best.ref.errorRate ?? null, toolErrorRate: best.ref.toolErrorRate ?? null, avgTurns: best.ref.avgTurns ?? null, thrash: best.ref.thrash ?? null, timeouts: best.ref.timeouts ?? null, costPerSuccess: best.ref.costPerSuccess ?? null },
    class: bestClass,
    reason: `${bestClass ? `class ${bestClass} · ` : ''}${escalate ? 'escalation: strongest evidence (live first, count, prior tier, utility; any class)' : 'best value'} for ${category}@${difficulty} (λ=${lambda}/quality point): ${describe(best)}${best.steps.length > 1 && single && single !== best ? `; best single model ${describe(single)}` : ''}${best.estimated ? '; ladder estimate assumes independent failures' : ''}${best.costUnknown ? ' [cost unknown]' : ''}${decision(best.steps[0])?.action === 'allow' ? ` [manual allow: ${decision(best.steps[0]).reason}]` : ''}`,
    alternatives: alt,
  };
}

/** Budget class of a provider: config override, else derived from how it authenticates. */
export function providerClass(provider, cfg = loadConfig().scorecard) {
  if (cfg.classes?.[provider]) return cfg.classes[provider];
  const p = PROVIDERS[provider];
  if (!p) return 'api';
  if (provider === 'claude' || p.kind === 'claude') return 'conductor';
  if (p.auth?.type === 'apiKey') return (getLimits().providers[provider]?.balance?.granted || 0) > 0 ? 'free' : 'api'; // granted credit is spent first, so it is free until gone
  return 'included';
}

/** Busiest window % of a provider (0 when unknown). `sessionOnly` looks at short (session/5-hour) windows only. */
export function providerUsedPct(provider, { sessionOnly = false, model = null } = {}) {
  const ws = providerWindows(provider, model).filter((w) => (!w.resetsAt || w.resetsAt > Date.now()) && (!sessionOnly || isSession(w)));
  return Math.max(0, ...ws.map((w) => Number(w.usedPercent) || 0));
}

/** May the router hand new work to this provider right now? Blocked, or past its class cap, means no. */
export function providerAvailable(provider, { overflowApi = false, cfg = loadConfig().scorecard, model = null } = {}) {
  if (!Object.hasOwn(PROVIDERS, provider)) return false;
  if (modelBlockedUntil(provider, model)) return false;
  const cls = providerClass(provider, cfg);
  if (cls === 'api' && !overflowApi) return false;
  // The conductor's plan is capped on its session window only (its weekly may run to 100%); other classes on their busiest window.
  return providerUsedPct(provider, { sessionOnly: cls === 'conductor', model }) < (cfg.classCap?.[cls] ?? 100);
}

/** What a list-price dollar really costs on this provider: 0 local, ~0.2 on an included subscription with room left, 1 once its window is past quotaPressurePct or for pay-per-token APIs. */
export function providerWeight(provider, cfg = loadConfig().scorecard, model = null) {
  // These exported helpers also accept partial configs, so their missing-key fallbacks remain reachable.
  const base = cfg.providerWeight?.[provider] ?? 1;
  const used = providerUsedPct(provider, { model });
  return used >= (cfg.quotaPressurePct ?? DEFAULTS.scorecard.quotaPressurePct) ? 1 : base;
}

/**
 * Use-it-or-lose-it cost discount in [0, 1]. A subscription's weekly/monthly window that resets soon loses unused
 * quota at reset, so discount its cost by absolute time steps and let the planner prefer it while
 * quality still leads. Only fixed-quota subscription classes (not API, which bills per token, nor the conductor's own
 * plan, which keeps a buffer). 5-hour windows churn constantly and are ignored — the waste that matters is the weekly.
 */
export function wasteDiscount(provider, cfg = loadConfig().scorecard, model = null, now = Date.now()) {
  const cls = providerClass(provider, cfg);
  if (cls !== 'subscription' && cls !== 'included') return 1;
  const strength = Math.min(1, Math.max(0, cfg.wasteStrength));
  const steps = cfg.wasteSteps.map((s) => [...s]);
  const discount = (ms) => {
    const step = Math.max(0, ...steps.filter((s) => ms > 0 && ms <= s[0] * 3600e3).map((s) => s[1]));
    return 1 - step * strength;
  };
  let factor = 1;
  // B4: track whether any real (non-session) window with a resetsAt exists for this provider.
  let hasRealWindow = false;
  for (const w of providerWindows(provider, model)) {
    if (!w.resetsAt) continue;
    if (isSession(w)) continue; // ignore the 5-hour churn
    hasRealWindow = true;
    factor = Math.min(factor, discount(w.resetsAt - now));
  }
  // Windowless provider (Grok, …): no real weekly window drove a discount, so fall back to a configured reset schedule.
  // B4: apply the schedule fallback only when the provider has no real non-session window.
  if (!hasRealWindow) { const sched = nextScheduledReset(provider, cfg, now); if (sched) factor = discount(sched - now); }
  return factor;
}

/**
 * Next reset for a provider whose CLI reports no window, from config `usageResets`. All times are the machine's
 * LOCAL (system) timezone — DST-aware — never a hard-coded zone. Two forms:
 *   { periodHours, resetHour[, resetMinute][, resetDay] } — a wall-clock schedule: daily at resetHour local
 *     (periodHours 24), or weekly at resetDay (0=Sun..6=Sat) + resetHour local (periodHours 168).
 *   { periodHours, anchorAt } — step the period from an explicit instant (anchorAt with no offset = local time).
 * Null when nothing is configured.
 */
export function nextScheduledReset(provider, cfg = loadConfig().scorecard, now = Date.now()) { return scheduledReset(provider, cfg, now, 1); }
/** The most recent reset at or before `now` (or null). Derived the same way as the next one, so the two can never
 *  disagree — the old "next − periodHours" could even land in the future when the day offset exceeded the period. */
export function prevScheduledReset(provider, cfg = loadConfig().scorecard, now = Date.now()) { return scheduledReset(provider, cfg, now, -1); }

function scheduledReset(provider, cfg, now, dir) {
  const s = cfg.usageResets?.[provider]; if (!s) return null;
  if (Number(s.periodHours) === 0) return null; // explicit "not set" (what Settings writes for "assume none")
  if (s.resetHour != null) {
    // Wall-clock schedule, recomputed from the settings on every call: change the day or the hour and the boundary
    // moves with it, no migration and no stored instant to go stale. Stepping by CALENDAR days rather than a fixed
    // millisecond period is what keeps 22:00 at 22:00 across a DST change.
    const step = s.resetDay != null ? 7 : 1;
    const resetHour = Number(s.resetHour) || 0, resetMinute = Number(s.resetMinute) || 0;
    const d = new Date(now);
    d.setHours(resetHour, resetMinute, 0, 0);
    if (s.resetDay != null) {
      const delta = (((Number(s.resetDay) - d.getDay()) % 7) + 7) % 7;
      d.setDate(d.getDate() + delta);
      // B10: re-apply setHours after setDate — DST spring-forward can shift the hour into the gap.
      d.setHours(resetHour, resetMinute, 0, 0);
    }
    if (dir > 0) { while (d.getTime() <= now) { d.setDate(d.getDate() + step); d.setHours(resetHour, resetMinute, 0, 0); } }        // first reset strictly after now
    else { while (d.getTime() > now) { d.setDate(d.getDate() - step); d.setHours(resetHour, resetMinute, 0, 0); } }                 // last reset at or before now
    return d.getTime();
  }
  const period = (Number(s.periodHours) || 0) * 3600e3; if (period <= 0) return null;
  const anchor = s.anchorAt ? Date.parse(s.anchorAt) : NaN; // explicit instant (no offset => local)
  if (!Number.isFinite(anchor)) return null;
  const next = anchor + Math.ceil((now - anchor) / period) * period;
  return dir > 0 ? (next <= now ? next + period : next) : (next <= now ? next : next - period);
}

// Visual work (modeling, drafting): the auto-pick may route only a selection with a recorded cookie-cutter PASS, at
// the effort that passed AND is still supported (priors.mjs MODELING / DRAFTING; 'close' and 'fail' are not routable), on every path and
// every ladder step. An explicit provider/model pin is the caller's call and is not gated (benchmark runs need that).
const passGate = (category, reg) => (KIND[category] !== 'visual' ? () => true : (sel) => sel.split('>').every((s) => {
  const { provider, model, effort } = parseSel(s);
  const p = priorFor(provider, model, category);
  return !!p?.tier && !!effort && p.effort === effort && !!modelInRegistry(reg, provider, model)?.efforts?.includes(effort);
}));

/** Merge cells (sorted easiest first) until `floor` rated runs; smoke quality remains battery-task weighted. */
function pool(cells, floor) {
  const used = []; let weightedRated = 0;
  for (const c of cells) { used.push(c); weightedRated += evidenceRated(c); if (weightedRated >= floor) break; }
  const w = (k, by, cells = used) => { let num = 0, den = 0; for (const c of cells) { if (c[k] == null) continue; const weight = c[by] ?? (by === 'weightedRated' ? c.rated : 0); num += c[k] * weight; den += weight; } return den ? num / den : null; };
  const qualityWeight = (c) => c.liveRated ? (c.liveWeightedRated ?? c.liveRated) : (c[SMOKE_TOTALS]?.qualityWeightedRated || c.weightedRated || c.rated || 0);
  const weightedQuality = (key) => { let num = 0, den = 0; for (const c of used) { if (c[key] == null) continue; const weight = qualityWeight(c); num += c[key] * weight; den += weight; } return den ? num / den : null; };
  const base = used[0];
  const stepCosts = base.stepCosts?.map((s, i) => {
    const costs = used.map((c) => ({ ...c.stepCosts[i], n: c.n }));
    return { sel: s.sel, avgUsd: w('avgUsd', 'n', costs), avgDurationMs: w('avgDurationMs', 'n', costs) };
  });
  const total = (key, fallback = () => 0) => used.reduce((sum, c) => sum + (c[key] ?? fallback(c)), 0);
  const rel = used.map((c) => c[RELIABILITY_TOTALS] || null);
  const allRel = rel.every(Boolean);
  const reliability = allRel ? {
    toolCalls: rel.every((r) => r.toolCalls != null) ? rel.reduce((sum, r) => sum + r.toolCalls, 0) : null,
    toolErrors: rel.every((r) => r.toolErrors != null) ? rel.reduce((sum, r) => sum + r.toolErrors, 0) : null,
    turns: { sum: rel.reduce((sum, r) => sum + r.turns.sum, 0), count: rel.reduce((sum, r) => sum + r.turns.count, 0) },
    thrash: rel.every((r) => r.thrash != null) ? rel.reduce((sum, r) => sum + r.thrash, 0) : null,
    timeouts: rel.every((r) => r.timeouts != null) ? rel.reduce((sum, r) => sum + r.timeouts, 0) : null,
    costTotal: rel.every((r) => r.costTotal != null) ? rel.reduce((sum, r) => sum + r.costTotal, 0) : null,
  } : null;
  const pooled = {
    ...base, ...(stepCosts ? { stepCosts } : {}), cells: used.length, difficulty: base.difficulty, difficultyMax: used[used.length - 1].difficulty,
    rated: total('rated'), weightedRated, n: total('n'), liveN: total('liveN', (c) => c.smokeN != null ? 0 : c.n), liveRated: total('liveRated', (c) => c.smokeRated != null ? 0 : c.rated),
    liveWeightedRated: total('liveWeightedRated', (c) => c.liveRated ?? (c.smokeRated != null ? 0 : c.rated)),
    smokeN: total('smokeN'), smokeRated: total('smokeRated'), smokeWeightedRated: total('smokeWeightedRated', (c) => c.smokeRated ?? 0),
    quality: weightedQuality('quality'), accept: weightedQuality('accept'), avgUsd: w('avgUsd', 'n'), avgDurationMs: w('avgDurationMs', 'n'),
    consistency: (() => { const totals = used.map((c) => c[SMOKE_TOTALS]).filter(Boolean); const runs = totals.reduce((sum, t) => sum + t.runs, 0); return runs ? totals.reduce((sum, t) => sum + t.passes, 0) / runs : null; })(),
    repeats: (() => { const repeats = used.flatMap((c) => c.repeats ? [c.repeats.min, c.repeats.max] : []); return repeats.length ? { min: Math.min(...repeats), max: Math.max(...repeats) } : null; })(),
    pass: total('pass'), fixable: total('fixable'), close: total('close'), fail: total('fail'), phantom: total('phantom'),
    last: used.map((c) => c.last).filter(Boolean).sort().at(-1) || null,
    errorRate: total('rated') ? (total('fail') + total('fixable')) / total('rated') : null,
    toolErrorRate: reliability?.toolCalls > 0 && reliability.toolErrors != null ? reliability.toolErrors / reliability.toolCalls : null,
    avgTurns: reliability?.turns.count ? reliability.turns.sum / reliability.turns.count : null,
    thrash: reliability?.thrash ?? null, timeouts: reliability?.timeouts ?? null,
    costPerSuccess: total('pass') > 0 && reliability?.costTotal != null ? reliability.costTotal / total('pass') : null,
  };
  Object.defineProperty(pooled, RELIABILITY_TOTALS, { value: reliability });
  const smokeTotals = used.map((c) => c[SMOKE_TOTALS]).filter(Boolean);
  Object.defineProperty(pooled, SMOKE_TOTALS, { value: smokeTotals.length ? {
    passes: smokeTotals.reduce((sum, t) => sum + t.passes, 0), runs: smokeTotals.reduce((sum, t) => sum + t.runs, 0),
    repeats: smokeTotals.flatMap((t) => t.repeats), qualityWeightedRated: smokeTotals.reduce((sum, t) => sum + (t.qualityWeightedRated || 0), 0),
  } : { passes: 0, runs: 0, repeats: [] } });
  return pooled;
}

// Desired cold-start effort per difficulty. Hard tasks deserve more thinking; the measured path takes over
// (and can down-shift on cost via effort dominance) once verdicts exist. Clamped to what the model offers.
/** Cold-start effort: the highest effort the model offers that does not exceed the difficulty's target. */
export function priorEffort(efforts, difficulty) {
  const ranked = EFFORTS.filter((e) => (efforts || []).includes(e));
  if (!ranked.length) return null;
  const map = loadConfig().scorecard?.difficultyEffort || DEFAULTS.scorecard.difficultyEffort;
  const wantIdx = EFFORTS.indexOf(map[difficulty] || 'medium');
  let pick = ranked[0];
  for (const e of ranked) if (EFFORTS.indexOf(e) <= wantIdx) pick = e;
  return pick;
}

/** Effort for a task the conductor routed by hand without an effort: the higher of the configured default and the difficulty target, clamped to what the model offers. */
export function effortForTask({ provider, model, difficulty, defaultEffort = null, reg = getModels() } = {}) {
  const m = modelInRegistry(reg, provider, model);
  const efforts = m?.efforts || [];
  if (!efforts.length) return null; // a model with no effort dimension must never carry an effort (e.g. agy bakes it into the id)
  const want = difficulty ? priorEffort(efforts, difficulty) : null;
  const base = efforts.includes(defaultEffort) ? defaultEffort : null;
  const rank = (e) => EFFORTS.indexOf(e);
  if (want && base) return rank(want) > rank(base) ? want : base;
  return want || base || null;
}

/**
 * Opt-in: before any measured data, route by public prior tier (cheapest priced model whose tier covers the level).
 * Visual work always takes this path, restricted by the pass gate: its benchmark verdicts are our own evidence, not a public prior.
 */
function priorFallback({ category, difficulty, exclude, cfg, overflowApi = false, providers = null, reg, failedBelow, escalate = false, eligibility = new Map() }) {
  if (category === 'conductor' || (cfg.coldStart !== 'priors' && KIND[category] !== 'visual')) return null;
  const gate = passGate(category, reg);
  const cands = [], seen = new Set(), archive = archivedSet(cfg);
  for (const m of reg.models) {
    const model = scorecardModelId(m.id), key = `${m.provider}:${model}`;
    if (seen.has(key) || isArchived(m.provider, model, archive)) continue;
    seen.add(key);
    if (m.kind !== 'agent' || reg.providers[m.provider]?.status !== 'ok' || !providerAvailable(m.provider, { overflowApi, cfg, model })) continue;
    if (exclude.includes(key) || (providers && !providers.includes(m.provider))) continue;
    const p = priorFor(m.provider, model, category);
    if (!p?.tier || (TIER_CEILING[p.tier] || 0) < difficulty) continue;
    const price = priceFor(m.provider, model, { scorecard: cfg });
    if (!price) continue;
    const efforts = (m.efforts || []).filter((e) => !isArchived(m.provider, model, archive, e));
    if (m.efforts?.length && !efforts.length) continue; // every effort is archived one by one
    const effort = (p.effort && efforts.includes(p.effort) ? p.effort : null) || priorEffort(efforts, difficulty);
    const sel = selOf({ provider: m.provider, model, effort });
    const manual = eligibility.get(eligibilityKey(sel, category));
    if (manual?.action === 'block' || exclude.includes(sel) || failedBelow.has(sel) || !gate(sel)) continue;
    const cls = (cfg.classOrder || []).indexOf(providerClass(m.provider, cfg));
    // B8: skip candidates whose class is not in classOrder (consistent with B7: unlisted = not eligible).
    if (cls < 0) continue;
    cands.push({ provider: m.provider, model, effort, tier: p.tier, proxy: price.in + price.out, cls });
  }
  cands.sort(escalate
    ? (a, b) => a.tier.localeCompare(b.tier) || a.cls - b.cls || a.proxy - b.proxy
    : (a, b) => a.cls - b.cls || a.proxy - b.proxy || a.tier.localeCompare(b.tier)); // escalate: best tier first; else class walk, then price
  const best = cands[0];
  if (!best) return null;
  const manual = eligibility.get(eligibilityKey(selOf(best), category));
  return { provider: best.provider, model: best.model, effort: best.effort, fallback: null, plan: null, reason: `hand-picked prior only (no measured data for ${category}@${difficulty}): ${KIND[category] === 'visual' ? `cheapest model with a recorded ${category} PASS, at the effort that passed (${best.effort})` : `cheapest model whose ${KIND[category] || 'reason'} tier ${best.tier} covers level ${difficulty}, at ${best.effort || 'default'} effort`}${manual?.action === 'allow' ? ` [manual allow: ${manual.reason}]` : ''}`, alternatives: cands.slice(1, 4).map((c) => `${c.provider}:${c.model} (tier ${c.tier})`) };
}
