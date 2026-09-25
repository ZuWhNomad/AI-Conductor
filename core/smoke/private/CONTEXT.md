# core/smoke/private — the grader's hidden material

**New here? Read the root `AGENTS.md` first** (repo rules), then `../CONTEXT.md` (the battery). Plans, reviews,
backlogs and working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** Everything a smoke worker must not see: reference solutions (what `solve()` writes), hidden tests and
benchmark scripts (written into the scratch dir only while `check()` runs), test-4's mutants, and the mutants/variants
that prove the level 6-7 graders. Fixtures that are derived from a reference (a buggy file is its fix with the bug put
back) or share a harness with a hidden test live here too. Task definitions stay in `../battery.mjs`.

**Entry points.** `common.mjs` (`CANARY`, `bare`, `marked`, the seeded PRNG `RNG`/`rng`); `l1-5.mjs` (levels 1-5);
one module per level 6-7 task: `refactor-6.mjs`, `implement-6.mjs`, `implement-7.mjs`, `debug-7.mjs`, each exporting
its bodies plus `MUTANTS`, `VARIANTS` and, where a mutant only fails by timing out, `SLOW_MUTANTS`.

**Invariants.**
- Every module embeds `CANARY`, and so does every reference solution, hidden test, benchmark and mutant body (its
  first line). Every `check()` fails a scratch dir holding a file that contains it ("copied from the grader"), skipping
  only the task's own hidden files (`hidden` in the task definition).
- A body the worker receives (a fixture, a visible test) never carries the canary. Anything that stands in for worker
  output (`solve()`, the tests' mutants and variants) is written through `bare()`.
- Hidden tests never contain a reference solution, and they are removed again before `check()` returns.
- No module here imports `../battery.mjs` (it imports these).

**How to test.** `node --import ./test/_env.mjs --test test/smoke/` proves, per task: untouched fixture fails,
reference passes, every mutant fails, every variant passes, and the canary rules. `CONDUCTOR_SMOKE_SLOW=1` adds the
mutants that fail only by timing out (about 20-60 s each).
