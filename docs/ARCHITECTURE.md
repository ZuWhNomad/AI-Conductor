# Conductor 2.0 — Architecture

A local, multi-model agent workbench: a Claude Code clone whose selected Claude model is the
**conductor** (plans, delegates, reviews) and whose grunt work goes to cheaper workers
(GPT-6 Astra via the Codex CLI on your ChatGPT subscription, local Ollama models, or any
OpenAI-compatible API). Browser UI with speech-to-text. Node >= 22, two runtime
dependencies (`@anthropic-ai/claude-agent-sdk`, `zod`).

## Ladder decisions (why it is built this way)

| Need | Decision | Why |
|---|---|---|
| Claude agent loop, tools, subagents, sessions, subscription auth | `@anthropic-ai/claude-agent-sdk` | It *is* Claude Code as a library. Rewriting it would be worse. |
| GPT-6 Astra on the ChatGPT subscription | `codex exec --json` (work) + `codex app-server` (limits/models) | Official non-interactive surfaces of the installed Codex CLI. |
| Speech-to-text | Browser Web Speech API | Free, native in Edge/Chrome on `http://localhost`. No model to install. |
| Other models (DeepSeek, Kimi, Grok, Qwen, Gemini) | Generic OpenAI-compatible tool loop over `fetch` | One 300-line loop covers every chat-completions API. |
| Local models | Ollama (`/api/tags`, `/v1/chat/completions`) | Already installed; zero cost. |
| UI | Vanilla HTML/JS served by a Node HTTP server, SSE for streaming | No build step, no framework, shareable by zipping the folder. |

## Process model

```
conductor (bin)  -> server/  -> browser UI (SSE stream + JSON API) + /mcp/<session> (MCP over HTTP)
                 -> core/conductor.mjs : one chat session = one conductor runtime
                        claude : Agent SDK query() — Claude Code tools, subagents, in-process MCP tools
                        codex  : one `codex exec` turn per message (thread resumed); tools via /mcp/<session>
                        loop   : OpenAI-compatible tool loop (Ollama / API models) with the same tools as functions
                        tools (core/tools.mjs, defined once): delegate, follow_up, await_task, task_status,
                          cancel_task, list_tasks, list_models, limits, log_improvement, context_tree,
                          install_model, generate_image
                 -> core/workers/*  : codex | claude-sdk | openai-compat | ollama | image | vendor-cli
                 -> core/providers/*: detect / listModels / pollLimits per vendor
                    providers/vendors.mjs: one spec per subscription CLI (Antigravity `agy`, Grok, Qwen Code,
                    Kimi) — binary lookup, install + login commands, auth probe, model list, headless args,
                    output parser. workers/vendor-cli.mjs runs any spec; server exposes
                    POST /api/providers/<id>/{install,login} which open a terminal for the user.
```

Selections are written `provider:model:effort` everywhere (UI, config, API, CLI); the effort is only
the last segment when it is a known effort word, so Ollama ids like `qwen3.8:latest` survive.

Every worker run is a **task** journaled under `~/.conductor2/tasks/<id>.json` (spec, provider,
thread/session id, status, result, usage). Tasks that die at a provider limit are parked with a
`resumeAt` and resumed automatically (`codex exec resume`, `claude --resume`). Everything on the dispatch path is
asynchronous: the git reads around a run (`status` before and after, `diff --stat`) go through `execFile`, so many tasks
starting or finishing together never stall the event loop; `/api/doctor` reports the loop's p99 lag and a friction entry
is logged when a minute's p99 exceeds `server.lagWarnMs`.

## Directory map

```
bin/conductor.mjs        CLI: start (default), doctor, models [--refresh], limits, scores, smoke, review, share
core/
  paths.mjs              state dir (CONDUCTOR_HOME | <repo>/.state if present | ~/.conductor2), atomic JSON, ndjson append
  config.mjs             defaults + load/save
  bus.mjs                event bus with ring buffer (SSE replay)
  conductor.mjs          chat sessions = Agent SDK queries with streaming input
  tools.mjs              MCP tools exposed to the conductor
  tasks.mjs              worker task journal, scheduler, park/resume on limits
  plans.mjs              multi-stage plans (the `run_plan` tool) executed on the task scheduler
  policy/                the orchestration policy, text only (no code):
    prompts/             conductor.md (+ -codex, -loop), orchestration.md, worker.md, msw.md
    recipes/             category → instruction set handed to a worker (e.g. image-to-3d-model)
    capabilities.json    shared catalogue of programs / access rules per category (path-free; machine entries live in config)
  workers/               codex.mjs, claude.mjs, openai-compat.mjs, image.mjs, vendor-cli.mjs, index.mjs
  providers/             anthropic.mjs, codex.mjs, ollama.mjs, openai-compat.mjs, vendors.mjs (subscription-CLI specs), index.mjs
  models.mjs             model registry: merges provider lists, auto-poll + force refresh
  limits.mjs             limit registry: per-provider windows, never assumed static
  context.mjs            CONTEXT.md discovery + path-scoped injection into worker specs
  improve.mjs            error/improvement log + review runner (self-iteration)
  mcp.mjs                conductor-wide MCP registry (Codex + Claude user configs + config.json)
  scorecard.mjs          per model × category × difficulty: verdicts, tokens, % of window; recommend()
  priors.mjs             public priors: API list prices (shadow dollars) + benchmark tiers, a cold-start expectation
  sweep.mjs              the admit() budget gate: measured per-window cost vs per-window targets
  usage-estimate.mjs     advisory plan-% estimate for providers whose CLI reports no window (e.g. Grok)
  recipes.mjs            loads policy/recipes/ (category → recipe, variants)
  capabilities.mjs       capability index: policy/capabilities.json + config tools.index; detect (async), spec lines per category, access gates, research on a miss
  feedback.mjs           redacted feedback bundle (versions, limits, improvement log, scorecard)
  bench.mjs              re-benchmark scheduler + new-model detection
  session-flags.mjs      per-session toggles (e.g. API overflow)
  update.mjs             self-update via git + npm (node/npm-cli.js, no shell); the server hands over only to a child that signalled it can start
  proc.mjs               spawn CLIs without a shell (Windows shim unwrap), kill trees
  smoke/                 self-checking battery that seeds the scorecard (battery.mjs, index.mjs)
server/index.mjs         HTTP + SSE + static UI
scripts/                 build the share/ launcher (not the app itself)
ui/                      index.html, app.js, stt.js, styles.css
share/                   install.cmd, install.sh (for friends)
test/                    node --test; mirrors the source folders that have tests (workers/, smoke/, server/), the rest flat
docs/                    this file
```

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

Shadow dollars are scaled by `scorecard.providerWeight` (local 0, included subscriptions 0.2, APIs and
Claude 1) because a token from a subscription you already pay for costs nothing until its window fills;
past `quotaPressurePct` (80%) a provider counts at full list price, and a blocked provider is never
proposed. **Budget classes** are the cross-provider rule: every provider belongs to a class derived from how it
authenticates (`free` local · `included` subscription CLIs such as Antigravity/Grok/Kimi · `subscription`
= Codex, by config · `conductor` = the Claude plan the conductor itself runs on · `api` key-based), and
`recommend` walks `scorecard.classOrder` taking the first class that holds a plan proven at the task's
level and under its cap (`classCap`: subscriptions to 100%; the conductor's plan 95% of its *session*
window, weekly to 100%). APIs join the walk only when the chat's **API overflow** toggle is on
(`conductor.overflowApi` sets the default for new chats). A capable provider that is capped or blocked
does not trigger extrapolation to a weaker class: the tool returns no worker and the conductor does the
task itself or waits. Adding or dropping a subscription changes the walk by itself; nothing names a model.
A key-based provider whose account holds *granted* (promotional) credit is in the `free` class until that
credit is spent (DeepSeek draws granted balance before topped-up funds), then drops to `api`. DeepSeek's
off-peak rule (half price outside Mon-Fri 01-04 / 06-10 UTC) is applied to its list price at decision time.
`conductor bench [--run]` lists selections with no battery or one older than `rebenchDays` (21) and
probes-then-batteries them; a registry refresh that lists new models logs an improvement entry.

Limit windows may be scoped to a model group: Antigravity's `agy -p /usage --output-format json` reports separate
5-hour and weekly buckets for Gemini and for Claude/GPT, so each window carries a `models` regex and availability,
quota pressure and per-task % deltas are judged against the windows that meter the model in question.

Reservation is derived from data: a provider's cost on a task is multiplied by
`1 + reservePct × weight × (its measured ceiling − the task's difficulty)`, so capacity proven at
level 4–5 is held back for level 4–5 work and the cheap tiers do the grunt work — no model names
are hard-coded; a cheap provider that proves a high level earns the same reservation. When a provider hits its limit mid-task the scheduler *fails over*: the same spec is re-issued
on the next qualified provider as a `retryOf` chain, the original reports `failed over to task <id>`,
and the cut-off attempt is never scored.

`recommend(category, difficulty)` maximizes utility = `scorecard.qualityValueUsd` × expected quality
− expected $ (+ `hourlyUsd` × wall clock). Plans: a single model whose quality ≥ `scorecard.quality`
over ≥ `minSamples` rated runs at that level or above with no failure at or below; an observed
ladder; or an estimated ladder (any measured first step, qualified fallback; expected quality
q₁ + (1−p₁)q₂, cost c₁ + (1−p₁)c₂, assuming independent failures — flagged "est." until observed
chains replace it). `delegate` without provider/model runs the first step and tells the conductor
the fallback to use with `retry_of`. With `scorecard.usePriors`, the public tier routes before any
data exists; otherwise the configured default worker does. `smoke_test` / `conductor smoke` run
`core/smoke/` to seed a model; `conductor smoke --all-models` orders by prior price.

## MCP (conductor-wide)

`core/mcp.mjs` builds one registry from the servers the user already configured for Codex
(`~/.codex/config.toml`) and Claude (`~/.claude.json`), plus `mcpServers` in
`~/.conductor2/config.json` (`name: null` removes an inherited one). Every runtime attaches it:
Claude conductor sessions (next to the workbench tools) and Claude workers via the Agent SDK,
Codex conductors and workers via `codex exec -c mcp_servers.*` (servers Codex already knows only
get `default_tools_approval_mode="approve"`, which exec mode needs). Workers are told which
servers they have in their preamble, so research that needs a data MCP can be delegated.

**Scoped to the task's category.** A server entry may carry `categories: [...]` (in config; `{ categories }` alone
tags a server inherited from Codex or Claude). A worker task gets every untagged server plus the ones tagged with
its category; untagged tasks and conductor sessions get everything. So a data MCP's tool schemas are not loaded
into a refactor (`mcpServersFor` in `core/mcp.mjs`).

## Limits and models (never static)

- Claude: SDK `rate_limit_event`s during sessions + `usage` control request (5h / 7d / per-model windows).
- Codex: app-server `account/rateLimits/read` (used %, window, resets) and `model/list`.
- Ollama: local, unlimited; models from `/api/tags`.
- API-key providers: models from `/models`; limits learned from 429 `retry-after`.
- Registry refreshes every `pollMinutes` (default 15) and on the UI's **Refresh** button.

## Context management

- `CLAUDE.md` at a project root is loaded by the SDK. Subfolders may carry `CONTEXT.md`.
- Worker specs automatically include the `CONTEXT.md` files closest to the paths in scope.
- The conductor is instructed to create/update `CONTEXT.md` when it adds a module.

## Self-iteration

`~/.conductor2/improvements.ndjson` collects errors (auto) and ideas (tool/UI). `conductor review`
(or the UI button, or the optional schedule) opens a conductor session *on this repo* with the log
as input, delegates fixes, runs `npm test`, and marks entries resolved.

## Sharing

`share/install.cmd` (Windows) / `share/install.sh`: checks Node, runs `npm install`, creates a
launcher. Friends log in to their own Claude / ChatGPT accounts once (`claude auth login`,
`codex login`). See README.

## The budget gate (`core/sweep.mjs`)

Every run's cost is measured in % of each provider window (the scorecard records the window deltas, divided by how
many tasks ran concurrently: `measuredCostByWindow`) and charged against a **target per window**: a session window
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
  only hard-parked on its real reported block (`blockedUntil`), not on a budget target.
- **A fresh window with no measured cost is a probe:** exactly one task of that provider runs at a time until its
  cost is measured, so a batch can't flood an unmetered window.

Providers that report no windows (grok, ollama) are not gated. Disable with `conductor.budgetGate: false`.
`admit` also returns `until` (the earliest reset among full windows, `nextResetWindows`); the scheduler does not use it today.
