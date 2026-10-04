# core/ — the engine

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** Everything the workbench does between the HTTP layer (`server/`) and the vendor CLIs: task
scheduling, budget-aware model selection, limits, the chat conductor, and the tool surface.

**Entry points.**
- `tasks.mjs` — the worker-task journal + scheduler. `schedule()` is the framework budget gate: it admits queued
  tasks per-window and, over target, degrades to sequential per provider (never a park-until-reset stall); it also
  holds queued work while system RAM meets `resources.maxRamPct` and retries after one unrefed 30-second timer; a real
  provider limit fails over or parks. `run()` executes and scores; finished tasks retain budget reservations and
  probe exclusion until a post-completion limits poll and scoring settle, without holding worker concurrency slots.
  Import only loads the journal; server-owned `recoverTasks()` staggers crash/graceful resumes, keeps future parks,
  and makes a second crash recovery `stale` (Re-run or Discard). Graceful stop journals the requeue before aborting.
  `isolate: true` (delegate / run_plan / createTask): the scheduler creates `git worktree add --detach` under
  `statePath('worktrees', <attempt root id>)` before the worker starts, junctions/symlinks `worker.isolateLinks`
  (`node_modules`, `.venv`) from the source checkout, commits onto `conductor/<id>` when the worker ends, and
  exposes `cleanupWorktree` / `listWorktrees` (`conductor worktrees [--prune-days N]`). Cleanup unlinks those
  junctions and verifies every link path is gone before removal (`git worktree remove --force` follows them on
  Windows). Ignored (one warning) for a non-git
  cwd or `sandbox: 'read-only'`. Follow-ups reuse the dir; `retry_of` gets a new one.
- `sweep.mjs` — the budget math: `admit` (a task must fit EVERY window under its target — session 95%,
  weekly/budget 100%), `measuredCostByWindow`, `targetFor`.
- `experiment.mjs` — A/B records (`conductor experiment new|list|report`) over scorecard rows tagged by `CONDUCTOR_EXPERIMENT=<id>:<arm>`.
- `scorecard.mjs` — the ledger + `recommend()` (utility = value-of-quality − cost; conductor chat ratings stay out of worker recommendation ceilings, and `activeRunRows()` keeps their budget and token-usage inputs worker-only; `escalate:true` bypasses the class
  walk to return the best-*available* single model by quality, for the review→escalation ladder). `wasteDiscount`
  (use-it-or-lose-it), `providerWindows` (model-group scoping), `nextScheduledReset` (windowless resets),
  `migrateScorecard` (one-time void of pre-Method-C polluted antigravity rows, run at server boot).
  When extrapolating nonvisual work, the nearest lower benchmark-only cell can qualify; eligible live evidence wins,
  and modeling/drafting keep their recorded-pass gate.
- `limits.mjs` — per-provider window registry (polled, scope-keyed refresh). `usage-estimate.mjs` — advisory % for
  windowless providers (never gates dispatch).
- `conductor.mjs` — chat sessions (Agent SDK / Codex / API); busy Codex and loop chats persist follow-ups and drain them together after the current turn. `tools.mjs` — the tools a conductor session gets.
- `bus.mjs` — the event bus (2000-entry / 8MB byte-bound ring, SSE replay). `paths.mjs` — state dir + atomic JSON + `redact` (the one
  secret redactor: every `writeJson`/`appendNdjson`, `bus.publish`, API answer, worker result and the crash log use it).
- `jobs.mjs` — detached long jobs (`job_start` / `job_status` / `job_cancel`, `/api/jobs`, `conductor job`): a command
  that outlives the worker and a server restart; record + log in `<state>/jobs/`, cancel by PID. On Windows, the
  wrapper starts detached with hidden stdio, giving it a new console process group. GPU-marked jobs are exclusive;
  starts also obey the shared RAM guard in `resources.mjs`. Detached jobs survive a Conductor stop; to keep a
  long-lived service independent of Conductor, start it from its own launcher, not from a worker shell.
- `resources.mjs` — system RAM headroom for task/job starts and `/api/state` / limits output; transitions are logged
  once through the improvement log. `setMemoryReader()` injects readings for tests.
- `watchdog.mjs` — the server-owned liveness loop. It combines bus activity, bounded file walks and one shared OS
  process/CPU snapshot into deterministic verdicts; journals task `aliveAt` without a `task` event; applies graduated
  stuck kills and one nudge per looping Claude chat episode (other runtimes are alert-only); persists detached-job/output
  watches; and wakes an idle chat once after its whole background batch is terminal. It never restarts the server.
- `config.mjs` — DEFAULTS + load/save. `recipes.mjs`, `capabilities.mjs` (the capability index: programs per
  category, detected not assumed; access gates; research on a miss), `feedback.mjs`, `bench.mjs`, `update.mjs`,
  `mcp.mjs`, `context.mjs`, `improve.mjs`, `session-flags.mjs`.
- `cli-update.mjs` — worker CLI updates. `RECIPES` per provider (current `--version`, latest stable release, exact-version
  install, rollback); `dailyCheck` (server boot + the signed-out re-probe timer), `applyCliUpdate` (idle gate → hold the
  provider's queue → install → verify version, sign-in and a read-1 task → roll back and `logImprovement` on failure),
  `cliVersionOf` (the cached version every scorecard run row records). `providers.<id>.cliUpdate`: off | notify | auto.

A window is model-scoped when it has a `models` regex, or when that field is absent and the label matches Fable
(`windowModels` in `limits.mjs`). `measuredCostByWindow` uses the same helper, so the gate charges a Fable window only
for runs whose model matches. Limit failover excludes models sharing the failed model's window-ID group on the same
provider, or the whole provider when the failed model has no window group.

**Symptom → file.** Start here instead of reading the folder.

| symptom | look in |
|---|---|
| a task sits queued, is parked, or did not resume / fail over | `tasks.mjs` (`schedule`, `park`, `failover`), then `sweep.mjs` (`admit`) and `limits.mjs` (`blockedUntil`) |
| the wrong worker model / effort was auto-picked | `scorecard.mjs` (`recommend`, `classifyCategory`); prices and tiers in `priors.mjs`; knobs in `config.mjs` `scorecard.*` |
| a worker "succeeded" but changed nothing, or a verdict / score looks wrong | `scorecard.mjs` (`isPhantomCompletion`, `recordRun`, `rateTask`), `tasks.mjs` `run()` |
| a usage bar is wrong, stale or missing | `providers/<vendor>.mjs` `pollLimits()` → `limits.mjs`; windowless providers (Grok): `usage-estimate.mjs` |
| a model is missing from the picker, or has the wrong efforts | `providers/<vendor>.mjs` `listModels()` → `models.mjs`; subscription CLIs: `providers/vendors.mjs` (`collapseEffortFamilies`) |
| a worker run fails, hangs or mis-parses output | `workers/<kind>.mjs` (see `workers/CONTEXT.md`); spawning / Windows shims / kill trees: `proc.mjs` |
| a check-in, detached watch or background-completion wake is wrong | `watchdog.mjs`, then `tasks.mjs` wake-consumption markers and `conductor.mjs` session state |
| the worker got the wrong instructions (notes, recipe, MCP servers, programs) | `tasks.mjs` (where the spec is built), `context.mjs`, `recipes.mjs` + `policy/recipes/`, `mcp.mjs` (scoped by category), `capabilities.mjs` + `policy/capabilities.json`, `prompts/worker.md` |
| the conductor chat misbehaves (streaming, permissions, model switch, history) | `conductor.mjs`; what it is told: `policy/prompts/conductor*.md`, `policy/prompts/orchestration.md` |
| a conductor tool is missing or returns the wrong thing | `tools.mjs` (defined once, served to all three runtimes) |
| a `run_plan` stage, vote or loop goes wrong | `plans.mjs` |
| the UI does not update | the event is not published: `bus.mjs` + the publishing module; then `ui/CONTEXT.md` |
| a setting does not apply or does not persist | `config.mjs` (`DEFAULTS`, `loadConfig`, `saveConfig`) |
| update / self-restart problems | `update.mjs`, then `server/index.mjs` (`scheduleRelaunch`, `startUpdateChecks`) |
| a worker CLI is stale, an update failed or was rolled back | `cli-update.mjs` (`RECIPES`, `applyCliUpdate`); history in `<state>/cli-updates.ndjson` |
| smoke battery, new-model detection or durable benchmark lanes | `smoke/` (see its `CONTEXT.md`), `bench.mjs` |
| improvement log, self-review, feedback bundle | `improve.mjs`, `feedback.mjs` |

**Prompt caching.** Put shared, stable text first and task-specific text last. Conductor history stays append-only between
deliberate compaction cut points (`compaction.mjs`); worker prompt order lives in `tasks.mjs` (`buildPrompt`), with
worker/MSW instructions before MCP and project context, then the resume note, task, recipe and capabilities. `plans.mjs`
keeps a `for_each` stage's title and shared spec before each vote's item JSON, lens and vote index.

**Boundaries.** `core/` imports other `core/` modules and the two runtime deps — never `server/`, `bin/`, `ui/` or
`test/`. Leaves `paths.mjs`, `proc.mjs`, `bus.mjs` import nothing of the repo but `paths.mjs`. `policy/` is text and
JSON only. `workers/` never imports the orchestration layer (`tasks`, `scorecard`, `sweep`, `limits`, `plans`, `tools`,
`conductor`, `watchdog`, `jobs`, `bench`); `providers/` never imports `workers/`. Enforced by `test/boundaries.test.mjs`.

**Invariants.**
- All UI-visible events go through `bus.publish(type, data)` with small payloads.
- Non-Claude chat follow-ups live in the session queue and transcript together; a turn drains the whole queue only while it still owns the session. Claude continues to use its SDK inbox.
- State lives in the state dir via `paths.mjs` (atomic `writeJson`): `CONDUCTOR_HOME`, else `<repo>/.state/` when that
  folder exists (a dev checkout), else `~/.conductor2`. Tests set `CONDUCTOR_HOME`.
- Graceful stop / relaunch aborts worker tasks and probes; it never cancels detached jobs. The forced stop fallback
  targets the server PID alone. On Windows, Node/libuv's internal kill-on-close Job Object contains non-detached
  worker children, while `detached: true` job wrappers skip it; detached does not break out of an external kill-on-close
  Job Object.
- `config.json` holds only the user's overrides; `loadConfig()` folds `DEFAULTS` in at read time, so a new default
  reaches every user. Secrets live only in config and are never logged; `publicConfig()` masks them for the settings
  UI, and `redact()` strips key shapes and configured key values from everything else written or shown.
- The usage estimate is advisory — it is never fed to the `admit` gate.
- Two runtime deps only (`@anthropic-ai/claude-agent-sdk`, `zod`); no build step. Walk the ladder before adding code.

**How to test.** `npm test` (`node --test`) — every test isolates state via `test/_env.mjs` (`CONDUCTOR_HOME`);
never touch the real `~/.conductor2`. See `core/providers/CONTEXT.md` and `core/workers/CONTEXT.md` for those layers.
