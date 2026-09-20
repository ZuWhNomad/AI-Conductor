# core/policy/recipes

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** Hand-curated instruction sets per coarse task category, appended to a worker's spec by
`core/tasks.mjs buildPrompt` via `core/recipes.mjs recipeFor(category)`. A recipe says *how* to approach a
kind of work (tools, order of operations, what to verify, known anti-patterns); it never restates the task.

**Entries.** `image-to-3d-model.md` (category `modeling`) — distilled from the cookie-cutter benchmark run that
passed (Astra ultra, 2026-09-12) versus the four that failed the same day. `video-briefing-finance.md` and
`video-briefing-general.md` (category `summarize`) — briefings of a video someone else watched.
The finance one is scoped to markets and adds a quantitative dossier, an editorial layer and a
QuantGPT claim-and-update pass; the general one is the older, broader prompt. They do different
jobs and are NOT graded against each other. Both self-scope: a non-video `summarize` task is told
to ignore them.

**Invariants.** Recipes must be machine-independent (no absolute paths; tools referenced by name with a
"get it" line). Keep them short enough to sit under a spec without drowning it. Registering a new one is a
one-line change in `RECIPES`.

**How to test.** `test/hygiene.test.mjs` checks the registry and that a tagged task keeps its category.
