// Public priors: API list prices and benchmark tiers per model, gathered 2026-09-09. Prices turn
// measured tokens into shadow dollars (one currency across subscription, API and local providers);
// tiers are an *expectation* to compare the scorecard against, and an opt-in routing fallback before
// any measured data exists. Routing itself stays empirical. Override or add prices in config:
//   scorecard.prices["provider:model"] = { in, out, cached }   ($ per million tokens)
import { loadConfig } from './config.mjs';

export const AS_OF = '2026-09-09';
// Tier -> highest difficulty the model is expected to clear (used only by the opt-in prior fallback).
export const TIER_CEILING = { A: 5, B: 3, C: 2, D: 1 };

// Models specialise. Our categories map onto three kinds of public evidence:
//   code   (edit, implement, test, refactor, debug)  <- Terminal-Bench 2.1 / SWE-bench
//   read   (read, search, summarize, docs)           <- long-context recall (MRCR) + knowledge work (GDPval-AA)
//   reason (review, design, other)                   <- GDPval-AA, HLE, aggregate indices
// A rule's `tier` is the default; `tiers.{code,read,reason}` override it where the evidence differs.
export const KIND = { edit: 'code', implement: 'code', test: 'code', refactor: 'code', debug: 'code', ui: 'code', read: 'read', search: 'read', summarize: 'read', docs: 'read', review: 'reason', design: 'reason', drafting: 'visual', modeling: 'visual', other: 'reason' };

// 3D-modeling / visual-output tasks (STL, CAD, mesh, parametric geometry). No public benchmark covers these,
// so the only evidence is our own — the cookie-cutter benchmark, judged pass / close / fail. Few models pass, so
// the conductor should set expectations; the auto-pick routes only a recorded PASS (scorecard.mjs passGate). This is
// Conductor's distilled copy of the results (for model selection); the full run + assets live in the separate
// conductor-benchmarks repo: https://github.com/ZuWhNomad/conductor-benchmarks
// `drafting` is the 2-D half of the same work: turn a reference image into clean line art. It is judged the same
// way (pass / close / fail, table DRAFTING below), and the auto-pick routes only a recorded PASS for either
// category. Explicit pins are not gated, so several models can still be tried on a drawing to collect evidence.
export const MODELING = {
  caveat: 'Only a model with a recorded PASS may take 3D-modeling/STL work (currently codex:gpt-6-astra at ultra, and codex:gpt-5.6-sol at ultra when given the image->3D recipe); "close" results waste tokens exactly like fails. If no passing model is available (limit, class cap), tell the user and stop rather than trying a weaker model. Trace the reference image; never draw from a description alone.',
  best: ['codex:gpt-6-astra', 'codex:gpt-5.6-sol'], // models with a recorded pass (with the effort that passed, see results)
  // Recorded verdicts from cookie-cutter 2026-09-11. `re` matches provider:model lowercased (like PRIORS), so
  // both the alias (claude:opus) and the resolved id (claude:opus-5) resolve to the same verdict.
  results: [
    { re: /^claude:(opus|.*opus-5)/, model: 'claude:opus-5', verdict: 'close', effort: 'medium' },
    // 2026-09-12: ultra PASSED (operator verdict). Near-final in one pass from a traced outline; three follow-up revisions touched only the centre loop (off-SPEC 100 mm brief). One-shot medium was 'close'.
    // Astra only: a verdict is a model's own, and the gate routes on it — gpt-6-sol / gpt-6-luna are unbenchmarked.
    { re: /^codex:gpt-6-astra/, model: 'codex:gpt-6-astra', verdict: 'pass', effort: 'ultra' },
    { re: /^antigravity:gemini-3\.1-pro/, model: 'antigravity:gemini-3.1-pro', verdict: 'fail', effort: 'high' },
    { re: /^claude:(sonnet$|.*sonnet-5)/, model: 'claude:sonnet-5', verdict: 'fail', effort: 'medium' },
    { re: /^codex:.*5\.3-codex-spark/, model: 'codex:gpt-5.3-codex-spark', verdict: 'fail', effort: 'medium' },
    // 2026-09-12: the Codex mid-tier at its highest efforts — all clear the gate, all fail the visual comparison.
    { re: /^codex:.*5\.6-sol/, model: 'codex:gpt-5.6-sol', verdict: 'pass', effort: 'ultra' }, // 2026-09-12 rerun WITH the image->3D recipe: PASS (one-shot fail before it)
    { re: /^codex:.*5\.6-terra/, model: 'codex:gpt-5.6-terra', verdict: 'fail', effort: 'ultra' },
    { re: /^codex:.*5\.6-luna/, model: 'codex:gpt-5.6-luna', verdict: 'fail', effort: 'max' },
    { re: /^antigravity:gemini-3\.8-flash/, model: 'antigravity:gemini-3.8-flash', verdict: 'fail', effort: 'high' }, // no output — quota, not quality
  ],
};
// 2-D line art from the reference photos (cookie-cutter drafting rounds, benchmarks repo runs/2026-09-20-drafting and
// runs/2026-09-21-drafting-panel). Judged by eye there as good / weak / unusable = pass / close / fail here.
export const DRAFTING = {
  caveat: 'Only a model with a recorded drafting PASS may be auto-picked for line art (currently codex:gpt-6-astra at xhigh, claude:claude-fable-5-1 at high); "close" drawings waste the geometry built on them. To try other models, pin them explicitly.',
  results: [
    { re: /^codex:gpt-6-astra/, model: 'codex:gpt-6-astra', verdict: 'pass', effort: 'xhigh' },           // good x3: mountain, pine trees, penguin
    { re: /^claude:claude-fable-5-1/, model: 'claude:claude-fable-5-1', verdict: 'pass', effort: 'high' }, // good: most faithful (fine detail needs thinning at 100 mm)
    { re: /^codex:gpt-5\.6-sol/, model: 'codex:gpt-5.6-sol', verdict: 'close', effort: 'xhigh' },         // good x1, weak x2: stiff, crude shapes
    { re: /^claude:claude-opus-5$/, model: 'claude:claude-opus-5', verdict: 'close', effort: 'max' },      // weak: sawtooth treeline (ran as opus[1m], then Opus 5)
    { re: /^grok:grok-4\.7/, model: 'grok:grok-4.7', verdict: 'close', effort: 'high' },                   // weak
    { re: /^grok:grok-4\.6/, model: 'grok:grok-4.6', verdict: 'fail', effort: 'high' },                    // unusable: broken hairline fragments
  ],
};

// Verdict → prior tier for the visual kind. `fail` and unknown collapse to null so they are not routed on a
// public-code prior they never earned; `close` stays modest (ceiling 2) so nothing is trusted at high difficulty.
// Until models get better at this, only a recorded PASS is routable: 'close' wastes tokens just like 'fail'.
const VISUAL_TIER = { pass: 'A', close: null, fail: null };

// Order matters: first matching rule wins. `re` is tested against `provider:model` lowercased.
// Sources: Terminal-Bench 2.1 (llm-stats.com), SWE-bench Verified + GDPval-AA (benchlm.ai), MRCR
// (vellum GPT-5.6 tier guide), OpenAI/Anthropic/Google/Moonshot/xAI/DeepSeek/Alibaba pricing pages.
export const PRIORS = [
  { re: /^codex:.*astra/, tier: 'A', price: { in: 10, out: 50, cached: 1 }, note: 'leads Terminal-Bench 4.0; ~1/3 of Sol tokens; #2 BenchLM composite' },
  { re: /^codex:gpt-5\.6-sol/, tier: 'A', tb21: 88.8, swev: 96.2, gdpval: 1743, mrcr: 91.5, price: { in: 5, out: 30, cached: 0.5 } },
  { re: /^codex:gpt-5\.6-terra/, tier: 'B', tb21: 87.4, gdpval: 1583, mrcr: 89.6, price: { in: 2, out: 12, cached: 0.2 } },
  { re: /^codex:gpt-5\.6-luna/, tier: 'B', tiers: { read: 'D' }, tb21: 84.7, gdpval: 1582, mrcr: 41.3, price: { in: 0.2, out: 1.2, cached: 0.02 }, note: 'weak long-context recall (MRCR 41%)' },
  { re: /^codex:gpt-5\.5/, tier: 'A', tb21: 88.0, price: { in: 5, out: 30, cached: 0.5 } },
  { re: /^codex:gpt-5\.3-codex-spark/, tier: 'C', tb20: 77.3, price: null, note: 'own rate-limit bucket; no public API price' },
  { re: /^codex:/, tier: null, price: null },
  { re: /^claude:.*(fable-5|mythos-5)/, tier: 'A', tb21: 91.4, swev: 95, gdpval: 1853, price: { in: 10, out: 50, cached: 0.25 } },
  { re: /^claude:(opus|.*opus-5|default)/, tier: 'A', tb21: 89.1, swev: 96, gdpval: 1862, price: { in: 5, out: 25, cached: 0.5 } },
  { re: /^claude:.*opus-4-[678]/, tier: 'B', tiers: { read: 'A' }, tb21: 74.6, swev: 88.6, gdpval: 1593, price: { in: 5, out: 25, cached: 0.5 }, note: 'Opus 4.6 led MRCR 8-needle at 1M' },
  { re: /^claude:.*opus-4-5/, tier: 'C', price: { in: 5, out: 25, cached: 0.5 } },
  { re: /^claude:(sonnet$|.*sonnet-5)/, tier: 'C', tb21: 80.4, swev: 85.2, gdpval: 1603, price: { in: 2, out: 10, cached: 0.2 } },
  { re: /^claude:.*sonnet-4-6/, tier: 'C', price: { in: 3, out: 15, cached: 0.3 } },
  { re: /^claude:.*sonnet-4-5/, tier: 'C', price: { in: 3, out: 15, cached: 0.3 } },
  { re: /^claude:.*haiku/, tier: 'D', swev: 73.3, price: { in: 1, out: 5, cached: 0.1 } },
  { re: /^antigravity:gemini-3\.8-flash/, tier: 'A', tiers: { read: 'B', reason: 'B' }, tb21: 89.4, gdpval: 1545, price: { in: 0.75, out: 3.75, cached: 0.075 }, note: 'intro price through 2026-12-31' },
  { re: /^antigravity:gemini-3\.7-flash/, tier: 'B', tb21: 85.8, price: { in: 0.75, out: 3.75, cached: 0.075 } },
  { re: /^antigravity:gemini-3\.6-flash/, tier: 'C', tb21: 78.0, price: { in: 0.75, out: 3.75, cached: 0.075 } },
  { re: /^antigravity:gemini-3\.1-pro/, tier: 'D', swev: 54.2, price: { in: 2, out: 12, cached: 0.2 } },
  { re: /^antigravity:claude-opus-4-6/, tier: 'B', price: { in: 5, out: 25, cached: 0.5 } },
  { re: /^antigravity:claude-sonnet-4-6/, tier: 'C', price: { in: 3, out: 15, cached: 0.3 } },
  { re: /^antigravity:gpt-oss/, tier: 'D', price: null },
  { re: /^kimi:kimi-k3/, tier: 'A', tiers: { read: 'B', reason: 'B' }, tb21: 88.3, swev: 93.4, gdpval: 1668, price: { in: 3, out: 15, cached: 0.3 } },
  { re: /^kimi:kimi-k2/, tier: 'D', swev: 76.8, price: null },
  { re: /^grok:grok-4\.6/, tier: 'D', tiers: { read: 'B', reason: 'B' }, gdpval: 1730, price: { in: 2, out: 6, cached: 0.5 }, note: 'strong knowledge work (GDPval 1730); no TB2.1 score found' },
  { re: /^deepseek:(deepseek-flash|.*v4(.1)?-flash|deepseek-chat)/, tier: 'B', tb21: 82.7, swev: 79, price: { in: 0.30, out: 1.20, cached: 0.006 }, note: 'deepseek-flash = V4.1 Flash (284B MoE, 13B active, 1M ctx); peak rate, off-peak is half; 92GB+ to run locally' },
  { re: /^deepseek:.*v4-pro|^deepseek:deepseek-reasoner/, tier: 'A', tb21: 87.9, swev: 80.6, price: { in: 1.32, out: 3.96, cached: 0.044 }, note: 'routes to V4.1 Flash at Flash pricing from 2026-09-14' },
  { re: /^(qwen|qwen-code):qwen3-coder-plus/, tier: 'D', price: { in: 0.65, out: 3.25, cached: 0.065 } },
  { re: /^(qwen|qwen-code):/, tier: 'D', price: null },
  { re: /^ollama:/, tier: 'D', price: { in: 0, out: 0, cached: 0 }, note: 'local; no per-token cost' },
];

const key = (provider, model) => `${provider}:${model || ''}`.toLowerCase();

/** Expectation for a model, for a task category when given: { tier, kind, tb21, swev, gdpval, mrcr, price, note } or null. */
export function priorFor(provider, model, category = null) {
  const k = key(provider, model);
  const p = PRIORS.find((r) => r.re.test(k));
  const kind = category ? KIND[category] || 'reason' : null;
  if (kind === 'visual') { // no public prior exists; the cookie-cutter benchmark is the only evidence
    const table = category === 'drafting' ? DRAFTING : MODELING;
    const r = table.results.find((x) => x.re.test(k));
    return { tier: r ? VISUAL_TIER[r.verdict] : null, kind, effort: r?.verdict === 'pass' ? r.effort || null : null, tb21: null, tb20: null, swev: null, gdpval: null, mrcr: null, price: p?.price || null, note: table.caveat };
  }
  if (!p) return null;
  const tier = (kind && p.tiers?.[kind]) || p.tier || null;
  return { tier, kind, tb21: p.tb21 ?? null, tb20: p.tb20 ?? null, swev: p.swev ?? null, gdpval: p.gdpval ?? null, mrcr: p.mrcr ?? null, price: p.price || null, note: p.note || null };
}

/** $ per million tokens {in, out, cached}; config `scorecard.prices` overrides the table. null when unknown. */
export function priceFor(provider, model, cfg = loadConfig(), now = new Date()) {
  const over = cfg.scorecard?.prices || {};
  const o = over[`${provider}:${model}`] || over[key(provider, model)];
  const p = o && Number.isFinite(o.in) && Number.isFinite(o.out) ? { in: o.in, out: o.out, cached: Number.isFinite(o.cached) ? o.cached : o.in / 10 } : priorFor(provider, model)?.price || null;
  if (!p) return null;
  const k = offPeakFactor(provider, now);
  return k === 1 ? p : { in: p.in * k, out: p.out * k, cached: p.cached * k };
}

/** DeepSeek bills half price outside peak hours (Mon-Fri 01:00-04:00 and 06:00-10:00 UTC). Everyone else: 1. */
export function offPeakFactor(provider, now = new Date()) {
  if (provider !== 'deepseek') return 1;
  const d = now.getUTCDay(), h = now.getUTCHours();
  const peak = d >= 1 && d <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
  return peak ? 1 : 0.5;
}

/** Shadow dollars for one run's tokens ({in: uncached input, out, cached}). null when unpriced. */
export function usdFor(tokens, price) {
  if (!tokens || !price) return null;
  return ((tokens.in || 0) * price.in + (tokens.out || 0) * price.out + (tokens.cached || 0) * (price.cached ?? price.in / 10)) / 1e6;
}
