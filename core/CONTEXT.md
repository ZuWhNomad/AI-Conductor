# core/ — the engine

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** Everything the workbench does between the HTTP layer (`server/`) and the vendor CLIs: task
scheduling, budget-aware model selection, limits, the chat conductor, and the tool surface.

**Modules.** One row per module. Open the brief to learn it; this file only routes.

| module | one line | brief |
|---|---|---|
| `tasks.mjs` | Stateful task journal and scheduler; re-exports `tasks/`. | `tasks/CONTEXT.md` |
| `tasks/` | Stateless `brief.mjs`, view, prompt, and git leaves. | `tasks/CONTEXT.md` |
| `sweep.mjs` | Budget math: `admit` (every window under target — session 95%, weekly/budget 100%), `measuredCostByWindow`, `targetFor`. | this file |
| `experiment.mjs` | A/B records (`conductor experiment` new, list, report) over scorecard rows tagged by `CONDUCTOR_EXPERIMENT=<id>:<arm>`. | this file |
| `scorecard.mjs` | Re-exports `scorecard/`. | `scorecard/CONTEXT.md` |
| `scorecard/` | Ledger and `recommend()` (utility = value-of-quality − cost): `wasteDiscount`, `providerWindows`, `nextScheduledReset`. `migrateScorecard` voids pre-Method-C polluted antigravity rows at server boot. | `scorecard/CONTEXT.md` |
| `limits.mjs` | Per-provider window registry (polled, scope-keyed refresh). | this file |
| `usage-estimate.mjs` | Advisory % for windowless providers (never gates dispatch). | this file |
| `conductor.mjs` | Re-exports `conductor/` (chat sessions: Agent SDK / Codex / API). | `conductor/CONTEXT.md` |
| `conductor/` | One chat across the Claude, Codex, and API-loop runtimes. | `conductor/CONTEXT.md` |
| `tools.mjs` | Re-exports `tools/`. | `tools/CONTEXT.md` |
| `tools/` | Conductor tools by group. `conductorToolDefs` keeps the model-visible order. | `tools/CONTEXT.md` |
| `bus.mjs` | Event bus (2000-entry / 8MB byte-bound ring, SSE replay). | this file |
| `paths.mjs` | State dir, atomic JSON, and `redact` (the one secret redactor: every `writeJson`/`appendNdjson`, `bus.publish`, API answer, worker result, and the crash log). | this file |
| `jobs.mjs` | Detached jobs (`job_start` / `job_status` / `job_cancel`, `/api/jobs`, `conductor job`): a command that outlives the worker and a server restart; record + log in `<state>/jobs/`, cancel by PID. On Windows the wrapper starts detached with hidden stdio, giving it a new console process group. GPU-marked jobs are exclusive; starts also obey the shared RAM guard in `resources.mjs`. Detached jobs survive a Conductor stop; to keep a long-lived service independent of Conductor, start it from its own launcher, not from a worker shell. | this file |
| `resources.mjs` | System RAM headroom for task/job starts and `/api/state` / limits output; transitions logged once. `setMemoryReader()` injects readings for tests. | this file |
| `watchdog.mjs` | Server-owned liveness loop. It combines bus activity, bounded file walks and one shared OS process/CPU snapshot into deterministic verdicts; journals task `aliveAt` without a `task` event; applies graduated stuck kills and one nudge per looping Claude chat episode (other runtimes are alert-only); persists detached-job/output watches; and wakes an idle chat once after its whole background batch is terminal. It never restarts the server. | this file |
| `cli-update.mjs` | Worker CLI updates. `RECIPES` per provider (current `--version`, latest stable release, exact-version install, rollback); `dailyCheck` (server boot + the signed-out re-probe timer), `applyCliUpdate` (idle gate → hold the provider's queue → install → verify version, sign-in and a read-1 task → roll back and `logImprovement` on failure), `cliVersionOf` (the cached version every scorecard run row records). `providers.<id>.cliUpdate`: off, notify, or auto. | this file |
| `config.mjs` | DEFAULTS + load/save. | this file |
| `recipes.mjs` | Loads `policy/recipes/` (category → recipe, variants). | this file |
| `capabilities.mjs` | Capability index: programs per category, detected not assumed; access gates; research on a miss. | this file |
| `feedback.mjs` | Redacted feedback bundle. | this file |
| `bench.mjs` | Durable new-model seen-set and per-provider benchmark lanes. | this file |
| `update.mjs` | Self-update via git + npm; the server hands over only to a child that signalled it can start. | this file |
| `mcp.mjs` | Conductor-wide MCP registry (scoped by category). | this file |
| `context.mjs` | `CONTEXT.md` discovery and path-scoped injection into worker specs. | this file |
| `improve.mjs` | Error/improvement log and the review runner. | this file |
| `session-flags.mjs` | Per-session toggles (API overflow, parallel), seeded from every session at start and create. | this file |
| `plans.mjs` | Multi-stage plans (the `run_plan` tool) on the task scheduler; re-exports `plans/`. | `plans/CONTEXT.md` |
| `plans/` | Multi-stage plans: validate, findings, expand, executor. | `plans/CONTEXT.md` |
| `models.mjs` | Model registry: merges provider lists, auto-poll and force refresh. | this file |
| `priors.mjs` | API list prices and shipped/configured cold-start tiers. | this file |
| `proc.mjs` | Spawn/owner registry, portable CPU/RAM snapshots, PID-scoped tree kills. No shell. | this file |
| `compaction.ts` | Conductor history stays append-only between deliberate compaction cut points. | this file |
| `policy/` | Orchestration policy and shipped data (text and JSON only). | `policy/CONTEXT.md` |
| `providers/` | Per-vendor detect, `listModels`, and `pollLimits`. | `providers/CONTEXT.md` |
| `workers/` | One runner per provider kind. | `workers/CONTEXT.md` |
| `smoke/` | Self-checking battery that seeds the scorecard. | `smoke/CONTEXT.md` |

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
| the worker got the wrong instructions (notes, recipe, MCP servers, programs) | `tasks/prompt.mjs` (where the spec is built), `context.mjs`, `recipes.mjs` + `policy/recipes/`, `mcp.mjs` (scoped by category), `capabilities.mjs` + `policy/capabilities.json`, `prompts/worker.md` |
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
deliberate compaction cut points (`compaction.ts`); worker prompt order lives in `tasks/prompt.mjs` (`buildPrompt`), with
worker/MSW instructions before MCP and project context, then the resume note, task, recipe and capabilities. `plans.mjs`
keeps a `for_each` stage's title and shared spec before each vote's item JSON, lens and vote index.

**Boundaries.** `core/` imports other `core/` modules and the two runtime deps — never `server/`, `bin/`, `ui/` or
`test/`. Leaves `paths.mjs`, `proc.mjs`, `bus.mjs` import nothing of the repo but `paths.mjs`. `policy/` is text and
JSON only. `workers/` never imports the orchestration layer (`tasks`, `scorecard`, `sweep`, `limits`, `plans`, `tools`,
`conductor`, `watchdog`, `jobs`, `bench`); `providers/` never imports `workers/`. Enforced by `test/boundaries.test.mjs`.

**Invariants.**
- All UI-visible events go through `bus.publish(type, data)` with small payloads.
- Non-Claude chat follow-ups live in the session queue and transcript together; a turn drains the whole queue only while it still owns the session. Claude continues to use its SDK inbox.
- State lives in the state dir via `paths.mjs` (atomic `writeJson`): `CONDUCTOR_HOME`, else `<repo>/.state/` when that folder exists (a dev checkout), else `~/.conductor2`. Tests set `CONDUCTOR_HOME`.
- Graceful stop / relaunch aborts worker tasks and probes; it never cancels detached jobs. The forced stop fallback targets the server PID alone. On Windows, Node/libuv's internal kill-on-close Job Object contains non-detached worker children, while `detached: true` job wrappers skip it; detached does not break out of an external kill-on-close Job Object.
- `config.json` holds only the user's overrides; `loadConfig()` folds `DEFAULTS` in at read time, so a new default reaches every user. Secrets live only in config and are never logged; `publicConfig()` masks them for the settings UI, and `redact()` strips key shapes and configured key values from everything else written or shown.
- The usage estimate is advisory — it is never fed to the `admit` gate.
- Two runtime deps only (`@anthropic-ai/claude-agent-sdk`, `zod`); no build step. Walk the ladder before adding code.
- A window is model-scoped when it has a `models` regex, or when that field is absent and the label matches Fable (`windowModels` in `limits.mjs`). `measuredCostByWindow` uses the same helper, so the gate charges a Fable window only for runs whose model matches. Limit failover excludes models sharing the failed model's window-ID group on the same provider, or the whole provider when the failed model has no window group.
- conductor chat ratings stay out of worker recommendation ceilings, and `activeRunRows()` keeps their budget and token-usage inputs worker-only. `escalate:true` bypasses the class walk to return the best-*available* single model by quality, for the review→escalation ladder. When extrapolating nonvisual work, the nearest lower benchmark-only cell can qualify; eligible live evidence wins, and modeling/drafting keep their recorded-pass gate.

**How to test.** `npm test` (`node --test`) — every test isolates state via `test/_env.mjs` (`CONDUCTOR_HOME`);
never touch the real `~/.conductor2`. See `core/providers/CONTEXT.md` and `core/workers/CONTEXT.md` for those layers.
