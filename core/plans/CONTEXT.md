# core/plans/ — multi-stage plans (`run_plan`)

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** Deterministic multi-stage plans (fan-out, refuter votes, judge panels, until-dry loops, critic)
executed on the task scheduler. Model-agnostic: every task carries the conductor's provider/model/effort, or
nothing (auto-pick). Four modules in a strict order; each imports only the ones before it. `../plans.mjs`
re-exports the surface so older imports keep working — new code imports the module it needs.

**Entry points.**
- `validate.mjs` — `SANDBOX_VALUES`, `validatePlan`. Imports nothing from this folder.
- `findings.mjs` — `findingsOf`, `findingKey`, `parseVerdict`, `tally`, and the scanners they share
  (`structuredOf`, `hasFindingObjects`, `findingLine`, `locOf`, `titleOf`). Imports nothing from this folder.
- `expand.mjs` — `expandStage` and the `{{goal}}` / `{{seen}}` / `{{item}}` / `{{results:<stage>}}` templating
  (`resultsText`, `RESULTS_CHARS`). Imports `findings.mjs` only.
- `executor.mjs` — `runPlan`, `getPlan`, `abortPlans`, `noWorkerReason`, and the in-flight registry plus the
  journal under `<state>/plans/`. It imports `awaitTask` from `../tasks.mjs` and `accessProviders` from
  `../capabilities.mjs`. Each evaluation of this module has its own registry.

**Boundaries.** `validate` → `findings` → `expand` → `executor`, never backwards. That internal order is a convention stated here. Outside this folder the
executor imports `tasks` (including `awaitTask`), `capabilities` (`accessProviders`), `paths`, `bus`, `models`,
`config`, `scorecard`, and `node:fs`. Nothing from `server`, `bin`, `ui`, or `test`. `workers/` must not import
`plans`. `test/boundaries.test.mjs` enforces the outward rules (what the folder may import from outside).

**Invariants.**
- The executor never chooses a model. A task carries provider/model/effort, or the caller's `recommend`.
- One stage shares one deadline; a failover continues that wait.
- `for_each` groups votes by the item object `expandStage` passed, not by a worker-supplied id.
- Plan journals are `<state>/plans/<id>.json`. In-flight state is the registry, not the file.
- Mutable plan state (`activePlans`, `livePlans`) lives only in `executor.mjs`, so each evaluation of that
  module has its own registry.

**How to test.** `node --import ./test/_env.mjs --test test/plans/` (`plans.warmupSeconds` is 0 there). Full: `npm test`.
