# core/policy — how the conductor and its workers behave (text only)

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** Everything here is prose read at runtime; there is no code. Change behaviour by editing these files,
not `core/*.mjs`.

- `prompts/` — the system prompts: `conductor.md` (Claude Code harness), `conductor-codex.md`, `conductor-loop.md`
  (API tool loop), `orchestration.md` (the `run_plan` playbook), `worker.md` (every worker's preamble),
  `msw.md` (the MSW kernel appended to it when `worker.msw` is on). Loaded by `core/conductor/prompt.mjs` and `core/tasks/prompt.mjs`.
- `recipes/` — category frameworks: worker methods append to matching task specs; conductor methods are indexed in
  its prompt and fetched in full through the `framework` tool (see `recipes/CONTEXT.md`).
- `capabilities.json` — the shared capability index: one entry per program, MCP server or access rule, with the task
  categories it serves, what it does better than a model, how to invoke it (path-free), how to detect it and the
  official installer link. Loaded by `core/capabilities.mjs`; only installed entries reach a worker's spec (after the
  recipe, using separate character budgets: `worker.recipeChars` / `worker.toolLineChars`). Machine-specific entries
  go in config `tools.index`, not here.
- `priors.json` — shipped hand-picked scorecard tiers. Rules resolve category, then kind, then default; exact
  machine overrides live in `scorecard.priors`. `core/priors.mjs` retains the code table as the no-file fallback.

`context-windows.json` holds verified shipped model context sizes; `core/compaction.ts` loads it. Per-machine exact
overrides live in `models.contextWindows`, and learned ceilings live in state `context-windows.json`.

**Boundaries.** Text and JSON only — no `.mjs` here, ever. Enforced by `test/boundaries.test.mjs`.

**Invariants.** Machine-independent: no absolute paths, no user names, tools referenced by name. Keep each file short
enough that a small local model can hold it with the tools' schemas. Path-free: the loaders build paths from
`REPO_ROOT`, so a folder move here means changing them (`conductor/prompt.mjs`, `tasks/prompt.mjs`, `recipes.mjs`).

**How to test.** `npm test`: `test/hygiene.test.mjs` covers the recipe registry and variants; the prompts are exercised
by the conductor and selection tests. `conductor smoke` measures the effect of a prompt change.
