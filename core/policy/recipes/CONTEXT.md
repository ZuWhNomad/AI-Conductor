# core/policy/recipes

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** Hand-curated frameworks by scorecard category. Worker and both-audience entries are appended to a
matching worker's spec through `core/tasks.mjs buildPrompt` and `core/recipes.mjs recipeFor(category, variant)`;
conductor entries appear as a compact index in the conductor prompt and full text is fetched through the `framework`
tool. Frameworks are optional starting methods, not rules.

**Entries.** `image-to-3d-model.b.md` (default for `modeling` and `drafting` in `RECIPES`) — recipe B, where B0.1 is the drafting stage that stops at an approved drawing. `RECIPE_VARIANTS` provides category variants: for `modeling` (`recipe-a`: `image-to-3d-model.md`, `recipe-b`: `image-to-3d-model.b.md`, `recipe-c`: `image-to-3d-model.c-build.md`, `recipe-c-trace`: `image-to-3d-model.c-trace.md`); for `summarize` (`video-general`: `video-briefing-general.md`, `video-finance`: `video-briefing-finance.md`). `summarize` has no default in `RECIPES`; video briefing tasks opt in explicitly by variant (e.g. via `youtube` in `capabilities.json`).

**Invariants.** Framework files may start with front matter (`id`, `types`, `audience`, `purpose`, `status`);
the registry scans shipped files here and state `recipes/`, where a matching id overrides the shipped entry.
Keep worker defaults and variants in `RECIPES` and `RECIPE_VARIANTS` stable: modeling and drafting use recipe B,
summarize has no default. `general.md` is tool fallback only and never enters a worker prompt.

**How to test.** `test/recipes.test.mjs` and `test/hygiene.test.mjs` check front matter, registry, worker attachment,
conductor index and lookup, defaults, and variants.
