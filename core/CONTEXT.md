# core/ — the engine

**Purpose.** Everything the workbench does between the HTTP layer (`server/`) and the vendor CLIs: task
scheduling, budget-aware model selection, limits, the chat conductor, and the tool surface.

**Entry points.**
- `tasks.mjs` — the worker-task journal + scheduler. `schedule()` is the framework budget gate: it admits queued
  tasks per-window and, over target, degrades to sequential per provider (never a park-until-reset stall); a real
  provider limit fails over or parks. `run()` executes and scores.
- `sweep.mjs` — the budget math: `admit` (a task must fit EVERY window under its target — session 95%,
  weekly/budget 100%), `measuredCostByWindow`, `targetFor`.
- `scorecard.mjs` — the ledger + `recommend()` (utility = value-of-quality − cost; `escalate:true` bypasses the class
  walk to return the best-*available* single model by quality, for the review→escalation ladder). `wasteDiscount`
  (use-it-or-lose-it), `providerWindows` (model-group scoping), `nextScheduledReset` (windowless resets),
  `migrateScorecard` (one-time void of pre-Method-C polluted antigravity rows, run at server boot).
- `limits.mjs` — per-provider window registry (polled, scope-keyed refresh). `usage-estimate.mjs` — advisory % for
  windowless providers (never gates dispatch).
- `conductor.mjs` — chat sessions (Agent SDK / Codex / API). `tools.mjs` — the tools a conductor session gets.
- `bus.mjs` — the event bus (2000-entry ring, SSE replay). `paths.mjs` — state dir + atomic JSON.
- `config.mjs` — DEFAULTS + load/save. `recipes.mjs`, `feedback.mjs`, `bench.mjs`, `update.mjs`, `mcp.mjs`,
  `context.mjs`, `improve.mjs`, `session-flags.mjs`.

**Invariants.**
- All UI-visible events go through `bus.publish(type, data)` with small payloads.
- State lives under `~/.conductor2` via `paths.mjs` (atomic `writeJson`). Tests set `CONDUCTOR_HOME`.
- `config.json` holds only the user's overrides; `loadConfig()` folds `DEFAULTS` in at read time, so a new default
  reaches every user. Secrets live only in config and are never logged; `publicConfig()` redacts them.
- The usage estimate is advisory — it is never fed to the `admit` gate.
- Two runtime deps only (`@anthropic-ai/claude-agent-sdk`, `zod`); no build step. Walk the ladder before adding code.

**How to test.** `npm test` (`node --test`) — every test isolates state via `test/_env.mjs` (`CONDUCTOR_HOME`);
never touch the real `~/.conductor2`. See `core/providers/CONTEXT.md` and `core/workers/CONTEXT.md` for those layers.
