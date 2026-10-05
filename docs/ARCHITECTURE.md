# Conductor 2.0 — Architecture

A local, multi-model agent workbench: a Claude Code clone whose selected Claude model is the
**conductor** (plans, delegates, reviews) and whose grunt work goes to cheaper workers
(GPT-6 Astra via the Codex CLI on your ChatGPT subscription, Antigravity and Grok CLIs,
or the DeepSeek API). Browser UI with speech-to-text. Node >= 22.18, two runtime
dependencies (`@anthropic-ai/claude-agent-sdk`, `zod`).

## Ladder decisions (why it is built this way)

| Need | Decision | Why |
|---|---|---|
| Claude agent loop, tools, subagents, sessions, subscription auth | `@anthropic-ai/claude-agent-sdk` | It *is* Claude Code as a library. Rewriting it would be worse. |
| GPT-6 Astra on the ChatGPT subscription | `codex exec --json` (work) + `codex app-server` (limits/models) | Official non-interactive surfaces of the installed Codex CLI. |
| Speech-to-text | Browser Web Speech API | Free, native in Edge/Chrome on `http://localhost`. No model to install. |
| DeepSeek | Generic OpenAI-compatible tool loop over `fetch` | Shared chat-completions API runner. |
| UI | Vanilla HTML/JS served by a Node HTTP server, SSE for streaming | No build step, no framework, shareable by zipping the folder. |

## Process model

```
conductor (bin)  -> server/  -> browser UI (SSE stream + JSON API) + /mcp/<session> (MCP over HTTP)
                 -> core/conductor.mjs : one chat session = one conductor runtime
                        claude : Agent SDK query() — Claude Code tools, subagents, in-process MCP tools
                        codex  : one `codex exec` turn per message (thread resumed); tools via /mcp/<session>
                        loop   : OpenAI-compatible tool loop (DeepSeek) with the same tools as functions
                        tools (core/tools.mjs, defined once): delegate, follow_up, await_task, task_status,
                          cancel_task, worktree_cleanup, job_start, job_status, job_cancel, watch_job, allow_command, rate_task,
                          model_scores, smoke_test, list_tasks, list_models, limits, log_improvement,
                          context_tree, run_plan, plan_status
                 -> core/workers/*  : codex | claude-sdk | openai-compat | vendor-cli
                 -> core/providers/*: detect / listModels / pollLimits per vendor
                    providers/vendors.mjs: one spec per subscription CLI (Antigravity `agy`, Grok) — binary lookup, install + login commands, auth probe, model list, headless args,
                    output parser. workers/vendor-cli.mjs runs any spec; server exposes
                    POST /api/providers/<id>/{install,login} which open a terminal for the user.
```

Selections are written `provider:model:effort` everywhere (UI, config, API, CLI); the effort is only
the last segment when it is a known effort word, preserving colons in model ids.

Every worker run is a **task** journaled under `~/.conductor2/tasks/<id>.json` (spec, provider,
thread/session id, status, result, usage). The same folder holds a human-readable brief, `tasks/<id>.md`, written once with the spec at creation and appended once with the result when the task finishes. States are `queued`, `running`, `parked`, `stale`, `done`, `failed`,
and `canceled`; `stale` is non-terminal and waits for the user. Tasks that die at a provider limit are parked with a
`resumeAt` and resumed automatically (`codex exec resume`, `claude --resume`). The git reads around a run (`status`
before and after, `diff --stat`) are asynchronous through `execFile`. Ledger parsing and journal I/O remain
synchronous; scorecard `runRows` reads are cached by file size and mtime. `/api/doctor` reports the loop's p99 lag,
and a friction entry is logged when a minute's p99 exceeds `server.lagWarnMs`.

### Queue and restarts

Importing `tasks.mjs` only loads the journal; each `startServer()` calls `recoverTasks()` after binding.
Fresh queued work stays queued. Running work requeues with `resume` and increments `recoveries`; the second
interruption makes it `stale` instead (the crash guard). Running recoveries and graceful `queued` + `resume`
requeues share creation-time ordering, spaced by `worker.resumeStaggerSeconds` with park reason `restart stagger`;
graceful requeues do not increment `recoveries`. Future parks keep their `resumeAt` and get a new timer;
expired parks requeue. Terminal tasks and stale tasks stay unchanged, except open `source: 'smoke'` tasks are canceled.
Stale work is never dispatched: Re-run (`POST /api/tasks/:id/rerun`) resets the crash count and queues it;
Discard uses the cancel route. Affected chats receive a restart note, held in `pendingNote` for the next turn.

Graceful shutdown journals `queued` + `resume` + `interruptedAt` before aborting workers. `scheduleRelaunch()`
sets draining to stop new dispatches during handover. The update gate counts only running and queued worker tasks
(plus running chats); parked and stale tasks do not count as busy.

Detached jobs survive a Conductor stop; to keep a long-lived service independent of Conductor, start it from its own launcher, not from a worker shell. On Windows, `detached: true` starts the job wrapper with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`; `windowsHide` hides its console and the wrapper's child inherits that process group.

Conductor source does not create an external Windows Job Object. Node/libuv creates an internal kill-on-close Job Object for the Node process and explicitly adds non-detached worker children to it; detached job wrappers skip that internal job. Libuv does not request `CREATE_BREAKAWAY_FROM_JOB`, so a separately assigned parent Job Object with kill-on-close can still terminate a detached job. Conductor cannot override that host policy through Node's spawn options.

## Directory map

```
bin/conductor.mjs        CLI: start (default), doctor, models [--refresh], limits, scores, smoke, bench, review, feedback, share, update, stop, experiment
core/
  paths.mjs              state dir (CONDUCTOR_HOME | <repo>/.state if present | ~/.conductor2), atomic JSON, ndjson append
  config.mjs             defaults + load/save
  bus.mjs                event bus with ring buffer (SSE replay)
  conductor.mjs          re-export façade over conductor/ (keeps `./conductor.mjs` imports working)
  conductor/             prompt.mjs (policy prompts) → sessions.mjs (session store) → common.mjs (shared Codex/loop
                         events) → runtime-claude.mjs → runtime-codex.mjs → runtime-loop.mjs → turns.mjs (send / interrupt / stop)
  tools.mjs              re-export façade over tools/ (keeps `./tools.mjs` imports working)
  tools/                 _shared.mjs (selection, task-wait registry, escalation, formatters) → delegation.mjs
                         (delegate, follow_up, await_task, task_status, cancel_task, worktree_cleanup, rate_task) →
                         jobs.mjs (job_start, job_status, watch_job, job_cancel, allow_command) → plans.mjs
                         (run_plan, plan_status) → info.mjs (scores, models, limits, smoke, list, log, context) →
                         index.mjs (conductorToolDefs and the MCP / function adapters)
  tasks.mjs              worker task journal, scheduler, run lifecycle, park/resume on limits; re-exports tasks/
  tasks/                 stateless leaves of tasks.mjs: view.mjs (publicTask, taskSummary, describeTask), prompt.mjs
                         (buildPrompt), git.mjs (git helpers, worktree links, repo size)
  jobs.mjs               detached commands that survive turns and server restarts
  watchdog.mjs           liveness verdicts/actions, persisted watches, restart-safe idle-chat wake-ups
  plans.mjs              re-export façade over plans/ (keeps `./plans.mjs` imports working)
  plans/                 validate.mjs (plan shape) → findings.mjs (findings, verdicts, tallies) → expand.mjs
                         ({{goal}}, {{seen}}, {{item}}, {{results:<stage>}}) → executor.mjs (runPlan, registry, journal)
  policy/                orchestration policy and shipped data:
    prompts/             conductor.md (+ -codex, -loop), orchestration.md, worker.md, msw.md
    recipes/             category → instruction set handed to a worker (e.g. image-to-3d-model)
    capabilities.json    shared catalogue of programs / access rules per category (path-free; machine entries live in config)
    priors.json           hand-picked cold-start tiers (category → kind → default; config overrides are exact selections)
  workers/               codex.mjs, claude.mjs, openai-compat.mjs, vendor-cli.mjs, index.mjs
  providers/             anthropic.mjs, codex.mjs, openai-compat.mjs, vendors.mjs (subscription-CLI specs), index.mjs
  models.mjs             model registry: merges provider lists, auto-poll + force refresh
  limits.mjs             limit registry: per-provider windows, never assumed static
  context.mjs            CONTEXT.md discovery + path-scoped injection into worker specs
  improve.mjs            error/improvement log + review runner (self-iteration)
  mcp.mjs                conductor-wide MCP registry (Codex + Claude user configs + config.json)
  scorecard.mjs          re-export façade over scorecard/ (keeps `./scorecard.mjs` imports working)
  scorecard/             ledger.mjs (append-only ndjson + identity helpers) → summary.mjs (attempts, chains, cells, shipped
                         batteries) → recommend.mjs (plans by utility, provider cost model) → report.mjs (grid, text, CSV)
  experiment.mjs         A/B experiment records + compare of tagged scorecard run rows
  priors.mjs             API list prices + shipped/configured hand-picked tiers, a cold-start expectation
  sweep.mjs              the admit() budget gate: measured per-window cost vs per-window targets
  usage-estimate.mjs     advisory plan-% estimate for providers whose CLI reports no window (e.g. Grok)
  recipes.mjs            loads policy/recipes/ (category → recipe, variants)
  capabilities.mjs       capability index: policy/capabilities.json + config tools.index; detect (async), spec lines per category, access gates, research on a miss
  feedback.mjs           redacted feedback bundle (versions, limits, improvement log, scorecard)
  bench.mjs              durable new-model seen-set + per-provider benchmark lanes
  session-flags.mjs      per-session toggles (API overflow, parallel), seeded from every session at start and create
  update.mjs             self-update via git + npm (node/npm-cli.js, no shell); the server hands over only to a child that signalled it can start
  cli-update.mjs         worker CLI updates (codex, agy, grok; the Agent SDK in dev): daily check, install when idle, verify, roll back
  proc.mjs               spawn/owner registry, portable CPU/RAM process snapshots, PID-scoped tree kills
  smoke/                 self-checking battery that seeds the scorecard (battery.mjs, index.mjs; private/ = hidden grader material)
server/index.mjs         HTTP + SSE + static UI
scripts/                 build the share/ launcher (not the app itself)
ui/                      index.html, app.js, stt.js, styles.css
share/                   install.cmd, install.sh (for friends)
test/                    node --test; mirrors the source folders that have tests (workers/, smoke/, server/, ui/), the rest flat
docs/                    product documentation: this file, DRIVE-CONDUCTOR, REVIEW-FRAMEWORK, video-briefing-finance-prompt
```

Every folder above also holds a `CONTEXT.md` — purpose, entry points, boundaries, invariants, how to test — which is
the brief an agent works from and what `core/context.mjs` injects into a worker's spec by path. The import boundaries
each brief states are enforced by `test/boundaries.test.mjs`. Project notes (plans, reviews,
backlogs, dated logs) are **not** in this repo; they live in the user's notes location, and `test/hygiene.test.mjs`
fails if any appear here.

## Plans (core/plans.mjs, `run_plan` tool)

The structural counterpart to Claude Code's Workflow tool, but provider-agnostic: the conductor
authors a plan (stages of parallel tasks; `for_each` stages that run a template per finding with
N votes/lenses; `until_dry` loops; templated specs with `{{goal}}`, `{{seen}}`, `{{item}}`,
`{{results:<stage>}}`) and the executor runs it on the task scheduler, parsing `findings[]` and
`{real, reason}` JSON blocks out of worker reports and tallying votes. No model is ever chosen by
the executor: each task carries the conductor's provider/model/effort, or nothing (auto-pick).
The playbook the conductor follows lives in `core/policy/prompts/orchestration.md`.

## Orchestration policy (summary; full text in core/policy/prompts/conductor.md)

1. The conductor's own tokens are the scarce resource. Anything that is mostly typing is delegated.
2. Delegation is a written spec: goal, files, constraints, acceptance criteria, verification command.
3. The conductor verifies every worker result itself (diff + tests) and sends review comments back
   to the *same* worker thread (cheap, keeps context) — max 3 rounds, then escalates or takes over.
4. Independent tasks run in parallel (`background: true` + `await_task`).
5. Collaboration incentives: workers know they are reviewed and scored; risky tasks get two
   independent attempts and a pick/merge; every handoff states how to verify.
6. Limits are checked before big batches; work shifts providers when one is near a limit.
7. Friction and errors are logged to the improvement log; `conductor review` turns them into patches.
8. Worker choice is measured, not assumed: delegations carry `category` + `difficulty`, the conductor
   rates results (`rate_task`), and the scorecard picks the cheapest model that clears the quality bar.

## Scorecard (worker selection is measured, not assumed)

`~/.conductor2/scorecard.ndjson` gets one `run` row per terminal worker task (tokens with uncached
input separated, duration, `pct` = per-window delta of the provider's usage limits between the start
of the run and a re-poll after it, concurrency) and one `rate` row per conductor verdict (`pass` 1 /
`fixable` 0.5 / `fail` 0). Fix rounds (`followUpOf`) fold into an *attempt*; attempts linked by
`retryOf` (a new model after a fail) fold into a *chain*, so ladders are measured as first-class
strategies (`sel` like `codex:gpt-5.6-luna:low>codex:gpt-5.6-terra:medium`).

Cost is one currency: tokens × API list price from `core/priors.mjs` (override in
`scorecard.prices`), which also carries public benchmark tiers as an *expectation* column — per kind
of work (code / read / reason), because models specialise (e.g. Luna is tier B on Terminal-Bench but
D on long-context recall). The window % stays as the availability guard and is shown, not ranked on.
`op: "void"` rows exclude a run the harness failed (`conductor scores --void-env`); the ledger is
never rewritten.

Shadow dollars are scaled by `scorecard.providerWeight` (local 0, included subscription CLIs 0.1, APIs 0.3,
Codex 0.6, Claude 1) because a token from a subscription you already pay for costs nothing until its window fills;
past `quotaPressurePct` (80%) a provider counts at full list price, and a blocked provider is never
proposed. **Budget classes** are the cross-provider rule: every provider belongs to a class derived from how it
authenticates (`free` granted API credit · `included` subscription CLIs such as Antigravity/Grok · `subscription`
= Codex, by config · `conductor` = the Claude plan the conductor itself runs on · `api` key-based), and
`recommend` walks `scorecard.classOrder` taking the first class that holds a plan proven at the task's
level and under its cap (`classCap`: subscriptions to 100%; the conductor's plan 95% of its *session*
window, weekly to 100%). APIs join the walk only when the chat's **API overflow** toggle is on
(`conductor.overflowApi` sets the default for new chats). A chat's **parallel** toggle copies onto every task it
delegates and makes the scheduler skip the budget gate for those tasks, so they run at once instead of one at a time
per provider; a provider that is actually blocked still parks them. A capable provider that is capped or blocked
does not trigger extrapolation to a weaker class: the tool returns no worker and the conductor does the
task itself or waits. Adding or dropping a subscription changes the walk by itself; nothing names a model.
A key-based provider whose account holds *granted* (promotional) credit is in the `free` class until that
credit is spent (DeepSeek draws granted balance before topped-up funds), then drops to `api`. DeepSeek's
off-peak rule (half price outside Mon-Fri 01-04 / 06-10 UTC) is applied to its list price at decision time.
`conductor bench [--run]` lists every offered effort below the 8-of-11 rated smoke-task coverage bar (or older than
`rebenchDays`), then sends explicit runs through restart-safe per-provider lanes. `bench.json` retains registry
selections, decisions and remaining task ids across list flaps and restarts. Fresh clones default
`bench.newModels` to `off`; archived selections are never auto-benched.
Pay-per-token API selections still require an explicit answer when the designated copy uses `auto`.

Limit windows may be scoped to a model group: Antigravity's `agy -p /usage --output-format json` reports separate
5-hour and weekly buckets for Gemini and for Claude/GPT, so each window carries a `models` regex and availability,
quota pressure and per-task % deltas are judged against the windows that meter the model in question.

Reservation is derived from data: a provider's cost on a task is multiplied by
`1 + reservePct × weight × (its measured ceiling − the task's difficulty)`, so capacity proven at
level 4–5 is held back for level 4–5 work and the cheap tiers do the grunt work — no model names
are hard-coded; a cheap provider that proves a high level earns the same reservation. When a provider hits its limit mid-task the scheduler *fails over*: the same spec is re-issued
on the next qualified provider as a `retryOf` chain, the original reports `failed over to task <id>`,
and the cut-off attempt is never scored. A task whose caller named both provider and model parks for that model's reset
instead (`efficiency_mode: false` on `delegate`/`run_plan` allows the failover).

`recommend(category, difficulty)` maximizes utility = `scorecard.qualityValueUsd` × expected quality
− expected $ (+ `hourlyUsd` × wall clock). Plans: a single model whose quality ≥ `scorecard.quality`
over ≥ `minSamples` rated runs at that level or above, with below-bar evidence disqualifying it only
after ≥ `benchMinSamples` rated runs; an observed
ladder; or an estimated ladder (any measured first step, qualified fallback; expected quality
q₁ + (1−p₁)q₂, cost c₁ + (1−p₁)c₂, assuming independent failures — flagged "est." until observed
chains replace it). `delegate` without provider/model runs the first step and tells the conductor
the fallback to use with `retry_of`. With `scorecard.coldStart: "priors"`, the shipped/configured hand-picked tier routes before any
data exists; otherwise a tagged delegate with no qualified plan is refused until a provider/model is
named explicitly (which always runs and seeds the scorecard) or small work is done directly. The legacy
`scorecard.usePriors` key is migrated. Append-only manual eligibility rows can block an automatic category pick or
allow a benched selection back into cold-start consideration; explicit probes remain available. `modeling` and `drafting` are gated on
every automatic route (measured plans, both ladder steps, extrapolation, cold start with or without
priors): only a selection with a recorded PASS at the effort that passed (pass / close / fail
verdicts in `core/priors.mjs` `MODELING` / `DRAFTING`) is routable, and with none available
`recommend` returns null; explicit pins are not gated. `smoke_test` / `conductor smoke` run
`core/smoke/` to seed a model; `conductor smoke --all-models` orders by prior price.

## A/B with experiment records

Keep a harness change only after a measured A/B. Arm A is one checkout, arm B another; they run sequentially, each with its own state dir, at least as many repeats as the record says. Start each arm's server with `CONDUCTOR_EXPERIMENT=<id>:<arm>` (`id` and `arm` each `[A-Za-z0-9_-]{1,40}`). Every run row that process writes then carries `experiment: { id, arm }`. Invalid values are ignored with one warning. Unset, the ledger is unchanged.

1. `conductor experiment new <id> --hypothesis "..." --mechanism "..." [--branch B] [--tasks t1,t2] [--heldout t3,t4] [--repeats 3]` writes `<state>/experiments/<id>.json`.
2. Run the tasks on A, then on B.
3. `conductor experiment report <id> --state-dir <A-state> --state-dir <B-state>` reads those scorecards (default: the current state dir) and prints, per arm and per category: runs, accepted count (pass + fixable), median and total uncached input / cached input / output tokens, median $/task, median duration. **B kept** only if accepted count is not lower in any category **and** median $/task is lower overall; otherwise **A kept**. Wall time is reported, never gated. `--json` prints the structure. `--verdict keep-a|keep-b|void --note "..."` stores the human verdict on the record (the rule is advice). A held-out task list on the record gets a second table; the report names model families per arm and warns when B's win rests on a single family or has no held-out rows.

## MCP (conductor-wide)

`core/mcp.mjs` builds one registry from the servers the user already configured for Codex
(`~/.codex/config.toml`) and Claude (`~/.claude.json`), plus `mcpServers` in
`~/.conductor2/config.json` (`name: null` removes an inherited one). Every runtime attaches it:
Claude conductor sessions (next to the workbench tools) and Claude workers via the Agent SDK,
Codex conductors and workers via `codex exec -c mcp_servers.*` (servers Codex already knows only
get `default_tools_approval_mode="approve"`, which exec mode needs). Workers are told which
servers they have in their preamble, so research that needs a data MCP can be delegated.

A `mcpServers` config entry may set `toolTimeoutSec` (default 3600) and `startupTimeoutSec` (default 30), passed to
Codex as `tool_timeout_sec` and `startup_timeout_sec`; these overrides do not apply to servers inherited from Codex
or to Claude SDK runtimes.

**Scoped to the task's category.** A server entry may carry `categories: [...]` (in config; `{ categories }` alone
tags a server inherited from Codex or Claude). A worker task gets every untagged server plus the ones tagged with
its category; untagged tasks and conductor sessions get everything. So a data MCP's tool schemas are not loaded
into a refactor (`mcpServersFor` in `core/mcp.mjs`).

## Limits and models (never static)

- Claude: SDK `rate_limit_event`s during sessions + `usage` control request (5h / 7d / per-model windows).
- Codex: app-server `account/rateLimits/read` (used %, window, resets) and `model/list`.
- API-key providers: models from `/models`; limits learned from 429 `retry-after`.
- Registry refreshes on startup, on the UI's **Refresh** button, and every `pollMinutes` (default 15) when `ui.autoRefresh` is enabled (default false).

## Liveness watchdog and restart recovery

One server-owned watchdog samples every running chat and worker at `watchdog.intervalMinutes` (30 by default). A
single portable process snapshot supplies parentage, CPU time and working set; each item's project directory gets a
bounded recent-file walk, while the event bus supplies output and tool-repeat signals. Verdicts distinguish
progress, owner/task waits, CPU-active quiet work, repeated loops and silence. Every sample is shown through the
`watchdog` event and saved on the item. Worker `aliveAt` writes are quiet, so they do not make auto-update activity
look newer.

Silence is graduated: stuck checks are logged and badged before `watchdog.killAfterStuckChecks` (3 by default) uses
the normal PID-scoped Stop/cancel path and records a worker as an unscored `failKind: "hung"`; zero disables that last
resort. Pending permissions, parked tasks, late ticks and unavailable OS samples are never treated as proven hangs.
Repeated identical tools or tool-less progress turns raise a looping verdict. A Claude chat with a live inbox gets one
nudge per looping episode; other runtimes report `alert only (runtime cannot take mid-turn input)`. Looping never
interrupts a chat; worker count caps remain their independent guard.

A chat turn is persisted while it is active. After a server restart, a Claude/Codex thread resumes once with a note
to continue from the files; a non-resumable runtime records the interruption and waits for the user. Worker recovery
follows the queue rules above. Detached `job_start` / `watch_job` work survives the turn and wakes an idle chat once
when its whole background batch is terminal. The watchdog never restarts the server.

## Context management

API workers using the OpenAI-compatible loop disable host commands by default (`worker.shell: false`).
Setting `worker.shell` to `true` allows any host shell command; an array of command names enables a command
filter that rejects shell control operators. Either opt-in trusts host execution: allowed interpreters and package
managers can access arbitrary host files. The filter does not sandbox those programs. File tools separately check
canonical workspace containment, including symlinks/junctions and new-file ancestors, but cannot prevent concurrent
link swaps. The `run` child gets an env without `*_API_KEY` / `*_TOKEN` / `*_SECRET`, and a command that names the state
dir is refused. Codex uses its own task/config sandbox selection, including per-model defaults; `worker.shell` does not
change it. Existing explicit `true` and array settings remain effective.

- `CLAUDE.md` at a project root is loaded by the SDK. Subfolders may carry `CONTEXT.md`.
- Worker specs automatically include the `CONTEXT.md` files closest to the paths in scope.
- The conductor is instructed to create/update `CONTEXT.md` when it adds a module.

## Sandboxing and read-only

How `sandbox: 'read-only'` is enforced depends on the worker runner:

- **Codex:** native `sandbox: "read-only"` CLI execution enforced by Codex's seatbelt/sandbox.
- **Claude SDK:** runs with `permissionMode: "plan"` (or SDK tool permission hooks).
- **OpenAI-compatible:** tool loop disables write, edit and command execution tools; `worker.shell` governs host shell access.
- **Vendor CLIs (Antigravity `agy`, xAI `grok`):** Subscription CLIs either cancel shell execution in their native plan modes or lack Windows sandbox enforcement. When `readOnlyViaSnapshot: true` is set on the vendor spec and the task `cwd` is in a git repository, the vendor runner runs the task in normal (non-plan, auto-approved) mode inside a disposable snapshot worktree: snapshots uncommitted tracked changes with `git stash create`, checks out a detached worktree via `git worktree add --detach <tmp dir> <sha>`, runs the CLI with `cwd` set to the snapshot (`writableRoots` cleared), and force-removes the worktree afterwards (`git worktree remove --force`) on completion, failure, or cancellation. Untracked files in the original workspace are not in the snapshot (since `git stash create` captures only tracked modifications). The snapshot is not a sandbox: the CLI runs auto-approved and can reach absolute paths. Stray files written to the snapshot are listed in the final task report (`Stray files in snapshot: ...`). Writes to the original project are detected and reported (`Stray writes to the project during a read-only run: ...`); they are not prevented or reverted. For a non-git `cwd`, it falls back to the vendor CLI's native plan-mode flags (`--mode plan`, `--permission-mode plan`, `--approval-mode plan`, `--plan`).

## Self-iteration

`~/.conductor2/improvements.ndjson` collects errors (auto) and ideas (tool/UI). `conductor review`
(or the UI button, or the optional schedule) opens a conductor session *on this repo* with the log
as input, delegates fixes, runs `npm test`, and marks entries resolved.

Feedback bundles include only improvement IDs, timestamps, recognized kinds and resolved flags; messages,
sources and context are omitted because free text can contain credentials that pattern-based redaction misses.

## Sharing

`share/install.cmd` (Windows) / `share/install.sh`: checks Node, runs `npm install`, creates a
launcher. Friends log in to their own Claude / ChatGPT accounts once (`claude auth login`,
`codex login`). See README.

## The budget gate (`core/sweep.mjs`)

Every run's cost is measured in % of each provider window (the scorecard records the window deltas, divided by how
many other tasks shared that particular window at dispatch: `concurrentByWindow`, with the legacy `concurrent`
scalar as fallback in `measuredCostByWindow`). The cost charged for a window is the average of the last 30
matching runs. It is charged against a **target per window**: a session window
(5-hour and the like) is used to 95%, everything else (weekly, monthly, a budget) to 100% (`targetFor`,
`scorecard.windowTargets`); so Codex with only a weekly window is planned against 100% of it.

**The gate is framework-level.** `core/tasks.mjs schedule()` calls `admit(windows, [{costs}], {runningByWindow})`
before dispatching ANY queued task. `admit` charges each task its own cost in EACH window (`measuredCostByWindow`) and
admits it only if it fits EVERY window under that window's target (session 95% / weekly 100%, `targetFor`), counting
what in-flight and this-pass tasks already consume per window. So a delegated task, a benchmark run, or a hand-pinned
model all obey the same budget. Two rules matter:

- **Over a per-window target we do NOT park — we degrade to sequential.** The scheduler keeps issuing, one task at a
  time per provider; a task that runs into the *real* provider limit then hands off via failover so another agent
  takes over. This replaced an earlier park-until-reset that could leave a lone task queued forever. A provider is
  only hard-parked on a real provider block or an applicable live window at 100% / rejected (`modelBlockedUntil`),
  including model-scoped windows. Reset windows no longer block; parallel overrides bypass pacing only.
- **A fresh window with no measured cost is a probe:** exactly one task of that provider runs at a time until its
  cost is measured, so a batch can't flood an unmetered window.

Providers that report no windows (grok) are not gated. Disable with `conductor.budgetGate: false`.
`admit` returns `{ n }`, how many of the pending tasks fit.
