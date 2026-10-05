# core/tools/ — conductor tool definitions

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** The tools a conductor session gets, split by group so a change to one group is a one-file brief.
`conductorToolDefs` assembles them in the order models already see. `../tools.mjs` re-exports the folder so older
imports keep working — new code imports the module it needs.

**Entry points.**
- `_shared.mjs` — what the groups share. `selOf` (re-exported), the task-wait registry (`taskWaits`, `waitingTasks`),
  `resumeAt`, `escalationState`, `atCeiling`, `formatModels`, `formatLimits`.
- `delegation.mjs` — `defs`: `delegate`, `follow_up`, `await_task`, `task_status`, `cancel_task`, `worktree_cleanup`,
  `rate_task`. `rate_task` is last in this array; `index.mjs` lists it after the job tools. Imports `awaitTask`
  from `../tasks.mjs`, `recommend` from `../scorecard.mjs`, and the capability readers from `../capabilities.mjs`.
- `jobs.mjs` — `defs`: `job_start`, `job_status`, `watch_job`, `job_cancel`, `allow_command`.
- `plans.mjs` — `defs`: `run_plan`, `plan_status`. Imports `runPlan` and `getPlan` from `../plans.mjs`, and
  `recommend` from `../scorecard.mjs`.
- `info.mjs` — `defs`: `model_scores`, `model_eligibility`, `framework`, `smoke_test`, `list_tasks`, `list_models`,
  `limits`, `log_improvement`, `context_tree`.
- `index.mjs` — `conductorToolDefs` (concatenates the groups), `conductorTools`, `toolsAsMcp`, `toolsAsFunctions`,
  `CONDUCTOR_AGENTS`. `../tools.mjs` re-exports the folder.

**Boundaries.** `_shared` → `delegation` → `jobs` → `plans` → `info` → `index`, never backwards. A module imports
only earlier ones in that list (it does not have to import the one immediately before it). Outside this folder they
import `tasks`, `models`, `limits`, `improve`, `context`, `providers/index`, `config`, `scorecard`, `smoke/index`,
`plans`, `paths`, `session-flags`, `capabilities`, `recipes`, `jobs`, `watchdog`, `resources`, and `bench` (dynamic)
— never `server/`, `bin/`, `ui/` or `test/`. Enforced by `test/boundaries.test.mjs`.

**Invariants.**
- `conductorToolDefs` order is delegation except `rate_task`, then the job tools, then `rate_task`, then the info
  tools, then the plan tools. That is the order the single-file table had.
- Each group exports `defs({ sessionId, cwd, maxBlockMs })` and returns only its own tools. The offered-capability
  set lives in `delegation.mjs`; the task-wait map lives in `_shared.mjs`. Neither is copied.
- `export *` from `../tools.mjs` drops `defs` (four modules export it). Import a group's `defs` from that module.
  `conductorToolDefs` and `conductorTools` come from `index.mjs`. Every name the old `tools.mjs` exported is
  still exported from the facade.
- `delegation.mjs` and `plans.mjs` import `awaitTask`, `recommend`, `runPlan`, `getPlan` and the capability
  readers themselves.
- `worker.reportInTool` defaults to `full`. `compact` makes the `delegate` / `await_task` / `task_status` text
  (`describeTask`) keep the first 12 non-empty lines of a finished report and the brief path. The brief file is
  written either way.

**How to test.** `node --import ./test/_env.mjs --test test/tools.test.mjs test/escalation.test.mjs test/mcp.test.mjs
test/capabilities.test.mjs` (state under `CONDUCTOR_HOME`). Full: `npm test`.
