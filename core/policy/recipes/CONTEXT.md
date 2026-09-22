# core/policy/recipes

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** Hand-curated instruction sets per coarse task category, appended to a worker's spec by
`core/tasks.mjs buildPrompt` via `core/recipes.mjs recipeFor(category)`. A recipe says *how* to approach a
kind of work (tools, order of operations, what to verify, known anti-patterns); it never restates the task.

**Entries.** `image-to-3d-model.b.md` (default for `modeling` and `drafting` in `RECIPES`) — recipe B, where B0.1 is the drafting stage that stops at an approved drawing. `RECIPE_VARIANTS` provides category variants: for `modeling` (`recipe-a`: `image-to-3d-model.md`, `recipe-b`: `image-to-3d-model.b.md`, `recipe-c`: `image-to-3d-model.c-build.md`, `recipe-c-trace`: `image-to-3d-model.c-trace.md`); for `summarize` (`video-general`: `video-briefing-general.md`, `video-finance`: `video-briefing-finance.md`). `summarize` has no default in `RECIPES`; video briefing tasks opt in explicitly by variant (e.g. via `youtube` in `capabilities.json`).

**Invariants.** Recipes must be machine-independent (no absolute paths; tools referenced by name with a
"get it" line). Keep them short enough to sit under a spec without drowning it. Defaults are registered in
`RECIPES` and variants in `RECIPE_VARIANTS` (overridable in config `recipes.defaults` and `recipes.variants`).

**How to test.** `test/recipes.test.mjs` and `test/hygiene.test.mjs` check recipe resolution, defaults, variants, and registry.
