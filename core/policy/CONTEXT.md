# core/policy — how the conductor and its workers behave (text only)

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** Everything here is prose read at runtime; there is no code. Change behaviour by editing these files,
not `core/*.mjs`.

- `prompts/` — the system prompts: `conductor.md` (Claude Code harness), `conductor-codex.md`, `conductor-loop.md`
  (Ollama / API tool loop), `orchestration.md` (the `run_plan` playbook), `worker.md` (every worker's preamble),
  `msw.md` (the MSW kernel appended to it when `worker.msw` is on). Loaded by `core/conductor.mjs` and `core/tasks.mjs`.
- `recipes/` — per-category instruction sets appended to a worker's spec (see `recipes/CONTEXT.md`). Loaded by
  `core/recipes.mjs`; a new recipe is registered there.
- `capabilities.json` — the shared capability index: one entry per program, MCP server or access rule, with the task
  categories it serves, what it does better than a model, how to invoke it (path-free), how to detect it and the
  official installer link. Loaded by `core/capabilities.mjs`; only installed entries reach a worker's spec (after the
  recipe, using separate character budgets: `worker.recipeChars` / `worker.toolLineChars`). Machine-specific entries
  go in config `tools.index`, not here.

**Invariants.** Machine-independent: no absolute paths, no user names, tools referenced by name. Keep each file short
enough that a small local model can hold it with the tools' schemas. Path-free: the loaders build paths from
`REPO_ROOT`, so a folder move here means changing them (`conductor.mjs`, `tasks.mjs`, `recipes.mjs`).

**How to test.** `npm test`: `test/hygiene.test.mjs` covers the recipe registry and variants; the prompts are exercised
by the conductor and selection tests. `conductor smoke` measures the effect of a prompt change.
