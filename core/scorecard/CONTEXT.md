# core/scorecard/ — measured worker selection

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** What each model actually cost and how well it did, per task category × difficulty, and the `recommend()`
that turns that into a plan (one model, or a cheap-first ladder) by utility = value-of-quality − expected cost. Four
modules in a strict order; each imports only the ones before it. `../scorecard.mjs` re-exports all four so older
imports keep working — new code imports the module it needs.

**Entry points.**
- `ledger.mjs` — the append-only `scorecard.ndjson` and the identity helpers everything shares. Rows: `run`
  (`recordRun`, written by `tasks.mjs` after a limits re-poll), `rate` (`rateTask`), `void`, `amend`, `eligibility`
  (`setEligibility`). `runRows()` / `loadLedger()` parse once and cache on file size + mtime. `envFailure` /
  `reliabilityMetrics` decide from structured signals first, text patterns last (each text hit is logged as friction).
  Identity: `CATEGORIES`, `VERDICTS`, `EFFORTS`, `selOf` / `parseSel` (`provider:model:effort`, colons in model ids
  preserved), `scorecardModelId`, `isArchived`, `modelInRegistry`. `migrateScorecard()` voids historically mis-keyed
  rows at server boot (idempotent).
- `summary.mjs` — `rootRuns()` folds runs into *attempts* (a task + its `followUpOf` fix rounds) and *chains*
  (attempts linked by `retryOf`); `summarize()` aggregates one row per selection × category × difficulty with
  recency-weighted evidence, merges the shipped benchmark cells (`core/policy/batteries.json`, strict aggregate-only
  schema `validBatteriesDocument`), and `distillBatteries()` writes them. `errorRates()`. Both views memoise on a key
  built in one place (`scorecardMemoKey`): ledger, config, model registry, shipped file.
- `recommend.mjs` — `recommend()` and the provider cost model it needs: `providerClass` (derived from auth, config
  override), `providerAvailable` (blocked or past its class cap), `providerWeight`, `wasteDiscount` (use-it-or-lose-it
  before a weekly reset), `nextScheduledReset` / `prevScheduledReset` (windowless providers, local wall clock, DST-safe),
  `priorEffort` / `effortForTask`. `recommendPlan` pools cells upward to `minSamples`, builds single and ladder plans,
  applies effort dominance, sorts by utility, walks `classOrder`; a capped qualified provider returns null (no
  extrapolation to a weaker class); nothing proven → lower levels → `priorFallback` (opt-in, or always for visual work).
- `report.mjs` — presentation only: `scoresGrid` (category × level), `formatScoresShort` (what the conductor reads;
  memoised on `shortMemoKey`), `scoresCsv`, `formatScores`, `benchedCells`.

**Boundaries.** `ledger` → `summary` → `recommend` → `report`, never backwards. Outside this folder they import
`paths`, `limits`, `sweep`, `models`, `config`, `bus`, `improve`, `priors`, `providers/index`, `cli-update` — nothing
from `tasks`, `plans`, `tools`, `conductor` or `server`. Enforced by `test/boundaries.test.mjs`.

**Invariants.**
- The ledger is never rewritten: corrections are `void` / `amend` rows; `voided` runs stay in the chain graph for
  `retryOf` links but count in no aggregate.
- `limitHit` runs are never scored; a verdict from outside Conductor counts for quality, never for cost.
- Shadow dollars = tokens × API list price (`priors.mjs`) × provider weight; the window % is shown, never ranked on.
- No model name is hard-coded anywhere in the selection logic; classes come from how a provider authenticates.
- Memo keys must include every input a view depends on (ledger stat, config, registry `updatedAt`, shipped file).

**How to test.** `node --import ./test/_env.mjs --test test/scorecard/*.test.mjs test/selection.test.mjs
test/escalation.test.mjs` (the ledger fixtures are built under `CONDUCTOR_HOME`); `test/limits/*.test.mjs` for window
scoping. Full: `npm test`.
