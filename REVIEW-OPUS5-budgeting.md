# Conductor 2.0 — Budgeting & Model-Selection Review (Opus 4.8)

Read-only review. Lens: the sweep planner (`core/sweep.mjs`), the scheduler gate (`core/tasks.mjs schedule()`),
model selection (`core/scorecard.mjs`, `core/priors.mjs`), and the usage estimator (`core/usage-estimate.mjs`).
Confirmations were run against the real modules with an isolated `CONDUCTOR_HOME` (probes noted inline).

## What is correct (verified, so it doesn't get re-litigated)

- **Per-window "fit iff every window" math is sound.** `admitPerWindow` (`sweep.mjs:160-179`) charges each window its own
  cost against its own headroom, and the early guard blocks only when a window applicable to *this* model is at/over target.
  The regression tests (`test/sweep.test.mjs:116-120`) — 13% on the 5-hour but 3% on the weekly no longer over-blocks — pass.
- **Session 95% / weekly 100% targets land on the right windows.** `isSession` (`sweep.mjs:118`) keys off `/hour|session/`
  or `windowMinutes<=600`; Claude's `5-hour` (label match) and Codex's 300-min bucket are session, weekly/monthly are 100%.
- **Grouped-provider *running tally* is now per-window.** `schedule()` accumulates `runningByWindow`/`dispatchedByWindow`
  keyed by window id via `costByWindow()` which honours `w.models` (`tasks.mjs:155-164`, `sweep.mjs:47-49`). A Claude/GPT
  Antigravity task's % lands only on Claude/GPT window ids, never on Gemini's. (This closes the earlier "one provider's %
  charged to all its windows" concern.)
- **Headroom cannot go NaN** for the window shapes the providers actually emit; `Number(w.usedPercent)||0` guards the inputs,
  and negative headroom is intended (binding window).
- **The liveness stall (old SC1) is gone.** Over target, `schedule()` no longer parks — it degrades to sequential per
  provider and keeps issuing (`tasks.mjs:180-186`), so a task can't sit `queued` forever with `{n:0, until:null}`.
- **Unknown-cost flooding (old SC2) is gone.** The `probing[provider]` guard (`tasks.mjs:163-164,173,187`) admits exactly
  one probe for a windowed fresh/hand-pinned model and holds every other task on that provider until it returns. Traced:
  with 8 queued tasks on an unmeasured windowed model, only one dispatches. **`FIXES_BACKLOG.md` SC2 (`[ ]`) is stale.**
  (Windowless providers — grok/ollama — still flood, but that is the documented "not gated" behaviour.)
- **The usage estimator is advisory-only, confirmed structurally.** No module on the dispatch path imports
  `usage-estimate.mjs`; `server/index.mjs limitsWithEstimates()` (`:167-178`) builds a throwaway object and never `save()`s,
  so `getLimits()` (which `admit`/`providerWindows`/`providerWeight` read) never sees an estimate. The least-squares
  through-origin fit (`rate = Σpct·tok / Σtok²`) and the flat-budget path are both arithmetically correct.

---

## Findings, ranked

### P1 — Model-scoped Claude weekly windows (Opus / Sonnet) leak onto every Claude model
`core/scorecard.mjs:306-310` (`providerWindows`), `core/providers/anthropic.mjs:128-131,136` (`normalizeUsage`).
Confidence: **HIGH** on the logic (probe-confirmed); **MED** on how often the Opus/Sonnet weekly buckets are populated.

`providerWindows` derives a model scope only from an explicit `w.models` field **or** a `fable` label:
```js
const scope = (w) => w.models || (/fable/i.test(w.label || '') ? 'fable' : null);
```
But Anthropic's `normalizeUsage` emits `seven_day_opus`→label `"weekly Opus"` and `seven_day_sonnet`→`"weekly Sonnet"`
(and `model_scoped[]`→`"weekly <name>"`) **without** a `models` field. Only the *Fable* one gets scoped; the Opus/Sonnet
ones fall through to "applies to all models."

Probe (seeded limits.json, real `providerWindows`):
```
Fable  sees: [ five_hour, seven_day, seven_day_opus, model:Fable ]   <- wrongly gated by weekly Opus
Opus   sees: [ five_hour, seven_day, seven_day_opus ]
Sonnet sees: [ five_hour, seven_day, seven_day_opus ]                 <- wrongly gated by weekly Opus
```
Two concrete mis-budgets:
1. **False whole-provider block.** `normalizeUsage.blocked = windows.some(w => usedPercent >= 100)` (`anthropic.mjs:136`).
   If the user has burned their **Opus** weekly to 100% elsewhere, `blockedUntil('claude')` fires and `schedule()`
   (`tasks.mjs:170-171`) parks **every** Claude task — including the Fable conductor's own delegations and Sonnet workers —
   even though Fable/Sonnet have their own untouched buckets. `providerAvailable('claude', …)` also returns false, so the
   router stops recommending Claude entirely.
2. **Wrong headroom charge.** Even below 100%, a Fable/Sonnet task is charged against the Opus weekly window in the gate.

This is exactly the class of bug the recent commit *"Claude's weekly Fable window meters Fable models only"* set out to fix —
it was applied only to the Fable label and the symmetric Opus/Sonnet case was left open. It hits the conductor's own model
(config default `claude-fable-5-1[1m]`), which is why I rank it P1.

Fix: have `normalizeUsage` set `models` explicitly on every model-specific window (`seven_day_opus`→`^(claude-)?opus`,
`seven_day_sonnet`→`sonnet`, `model_scoped[m]`→a regex from `m.display_name`), and derive `blocked` per applicable model
rather than "any window ≥100". The general `seven_day` ("weekly") stays unscoped — correct as-is.

### P2 — Concurrency divisor understates per-task cost for grouped providers
`core/sweep.mjs:50` (`measuredCostByWindow`), fed by `core/tasks.mjs:207` (`concurrent`).
Confidence: **HIGH** (probe-confirmed).

```js
const per = d / ((r.concurrent || 0) + 1); // "the window moved for every task running at the time"
```
`r.concurrent` counts **same-provider** in-flight tasks (`tasks.mjs:207`: `provider === t.provider`), not tasks that share
the same window group. On Antigravity, a Gemini task shares its 5-hour window only with other Gemini tasks — but if 3
Claude/GPT tasks happen to be running, the Gemini delta is divided by 4.

Probe: a Gemini run that moved its 5-hour window **8%** with `concurrent:3` is recorded as **2%/task** — a 4× under-estimate.
```
measuredCostByWindow(rows, 'antigravity', {model:'gemini-3.8-flash'}) => { 'antigravity:5h': 2 }   // should be ~8
```
Effect: the gate believes Gemini tasks are 4× cheaper than they are, admits too many in parallel, saturates the real window,
then eats a failover/park burst — defeating the gate's purpose (avoid blowing the window) and corrupting the scorecard's
`%window/task` column. Homogeneous providers (Codex) are unaffected because all concurrent tasks do share the window.

Fix: divide by the count of concurrent tasks whose applicable window set includes this window id (i.e. same model group),
not by raw same-provider concurrency. Record enough on the row (e.g. `concurrentByWindow`) or recompute the group at record time.

### P2 — Claude poll `utilization` is not normalized like the live-event path
`core/providers/anthropic.mjs:127` vs `:144`. Confidence: **MED** (depends on the SDK's undocumented scale — flagged for verification, not asserted).

`normalizeUsage` (poll path) stores the control-request value raw:
```js
usedPercent: rl[key].utilization
```
while `windowFromEvent` (live rate-limit events) defensively rescales:
```js
usedPercent: Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1))
```
The `<=1 ? 100 : 1` strongly implies `utilization` can arrive as a 0–1 fraction. If the `usage_EXPERIMENTAL…` control
request uses the same convention, every Claude poll window under-reports ~100× (0.85 stored as `0.85%`): `blocked` (≥100)
never fires from a poll, and the budget gate/`providerAvailable` see near-zero usage and never throttle Claude. Live events
would still be correct, so the damage is limited to windows populated by polling (a fresh check before a batch, any provider
not currently streaming events). The two paths should share one normalizer regardless; today they disagree.

Action: confirm the control-request scale against the SDK, then route both through a single `normalizeUtilization()`.

### P3 — `docs/ARCHITECTURE.md` describes a gate that no longer exists
`docs/ARCHITECTURE.md:191-207`. Confidence: HIGH.

The doc says `planBatch` sizes batches from `targetFor`/`headroomFor` and that the framework gate "parks the rest until the
binding window resets (`nextResetWindows`)." Neither is true of production dispatch: the only live gate is
`admit`→`admitPerWindow`; `planBatch`/`nextBatch`/`nextReset` are **test-only** (grep: sole non-test caller of `admit` is
`tasks.mjs:179`; `planBatch`/`nextBatch` appear only in `test/sweep.test.mjs`), and `schedule()` deliberately does **not**
park on budget (sequential-throttle + failover, `tasks.mjs:180-186`). The named first client "cookiebench-trace runner"
is not in the tree. Update the doc so the budgeting section matches the shipped policy.

### P3 — Per-window reset math (`nextResetWindows`, `admit.until`) is dead on the framework path
`core/sweep.mjs:137-140,156,179`; `core/tasks.mjs:179` ignores `a.until`.

`schedule()` reads only `a.n` from `admit`; parking is driven entirely by the *real* provider limit (`blockedUntil` /
`run()`'s `limitHit`). So `until`/`nextResetWindows` never influence dispatch and are exercised only by tests. Not a bug
under the "issue until the real limit, then failover" policy, but it means the careful per-window reset selection buys
nothing today — either wire it into the sequential-throttle (sleep-until-reset when a real limit is near) or note it as
sweep-runner-only.

### P3 — `effortMultiplier` probe baseline can silently miss a real probe
`core/sweep.mjs:74-79`. Confidence: MED.

`probeEffort` defaults to `'low'`, but phase-1 probes run at each model's *cheapest offered* effort, which may be `medium`
(or the model's default) rather than `low`. When there are rows only at the default effort and none at `'low'`, `tok('low')`
is null and the function drops to the conservative `FALLBACK_LADDER` even though a measured baseline exists — over- or
under-estimating other efforts' cost. Pass the actual probe effort through, or fall back to "cheapest effort with rows."

### P3 — minor: `measuredCostByWindow` re-reads the limit registry per pct entry
`core/sweep.mjs:47-48` calls `getLimits()` (a `statSync` each time) inside the `for…pct` loop, once per window per row.
Hoist `getLimits().providers[provider]?.windows` out of the loop. Cosmetic/perf only.

### P3 — estimator edge (already in prior notes, confirmed)
`core/usage-estimate.mjs:60`: a check-in recorded at 0 tokens makes the no-`den` fallback
`obs[last].pct / max(1, tokens)` explode into a huge %/token rate. Advisory-only, so low impact; guard with a small floor.

---

## Selection logic (scorecard.mjs / priors.mjs) — assessment

- **Utility = λ·quality − cost picks sanely.** `recommend` (`:242`) maximizes `qualityValueUsd × quality − usd`; `costOf`
  folds `providerWeight` (subscription discount) and `reserve` (hold high-proven capacity for hard work). Directions correct.
- **Class walk is correct.** `classOrder` free→included→subscription→conductor→api; the first class holding a `utility>-∞`
  plan wins, value orders within (`:256-260`). `provenButCapped` (`:264`) correctly *declines* rather than extrapolating to
  a weaker class when a capable provider is only blocked/capped — matches the documented policy.
- **Effort ladder incl. `ultra` ranks right.** `EFFORTS` includes `ultra` (`:341`, with a comment about the prior -1 bug);
  `priorEffort`/`effortForTask`/effort-dominance all index into it consistently.
- **quotaPressurePct switch is coherent.** `providerWeight` (`:322-326`) jumps to full list price once the busiest
  applicable window passes 80%, so a near-full subscription stops looking artificially cheap — but the class walk still
  prefers it until it's actually blocked/capped. Consistent with "spend the subscription you already pay for."
- **Cold-start / prior fallback behaves.** With `usePriors:false` (default) and nothing measured, `recommend` returns null
  (conductor does it / configured default worker); `providerAvailable` first-lines `blockedUntil`, so a 100%-weekly Claude
  is unavailable regardless of the sessionOnly cap. (Caveat: this correctness rides on the P1 scoping — a leaked Opus window
  makes `blockedUntil('claude')` fire wrongly.)

## Top-of-file summary

1. **P1** Opus/Sonnet weekly windows leak onto all Claude models → false whole-provider block of the Fable conductor & wrong headroom charge (`scorecard.mjs:306`, `anthropic.mjs:128-136`). Probe-confirmed.
2. **P2** Grouped-provider per-task cost under-measured ~by cross-group concurrency (`sweep.mjs:50` + `tasks.mjs:207`) → over-dispatch/saturate/park on Antigravity. Probe-confirmed (8%→2%).
3. **P2** Claude poll `utilization` not rescaled like the event path (`anthropic.mjs:127` vs `:144`) → possible ~100× under-report if the API is 0–1. Verify + unify.
4. **P3** ARCHITECTURE.md budgeting section is stale (planBatch/park-on-budget); production gate is `admit` + sequential-throttle.
5. **P3** `admit.until`/`nextResetWindows` unused on the framework path; `effortMultiplier` probe-baseline mismatch; per-entry `getLimits()`; estimator 0-token rate blowup.

Positives: per-window admit math, session/weekly targeting, per-window running tally, SC1 & SC2 both resolved, and the
estimator's advisory-only contract all hold up under inspection.
