# core/smoke — model smoke battery

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** Seed the scorecard (`core/scorecard.mjs`) with automatically rated runs so worker
selection is empirical rather than assumed. Every battery task is a tiny scratch project with a
deterministic check.

**Entry points.** `runSmoke({ models, tasks })` in `index.mjs` (used by the `smoke_test` conductor
tool and `conductor smoke`); `BATTERY` in `battery.mjs` (the task definitions); `private/` (reference solutions, hidden tests,
mutants: see its `CONTEXT.md`); `formatSmoke(results)`.

**Invariants.**
- One task at a time per run, so the before/after limit delta belongs to that task.
- Every entry has `setup`, `check` and a reference `solve`; `test/smoke/smoke.test.mjs` proves each check
  fails on the untouched fixture and passes on the reference solution. Keep that true when adding tasks.
- Ids are `category-level`; difficulty 1–5 follows the rubric in `core/policy/prompts/conductor.md`. Levels
  1–3 are sanity checks almost every model passes; 4–5 (`implement-4` evaluator, `test-4` mutant-killing
  suite, `debug-5` async pool) are where ceilings show. Levels 6–7 (`refactor-6` speed under an equivalence
  contract, `implement-6` unified-diff applier, `implement-7` streaming multipart parser, `debug-7` async-cache
  races) grade against hidden tests counted from the TAP summary; their runs are recorded and shown in the
  scores, but `recommend()` ignores difficulty > 5, so they do not route yet (delegate stays 1–5).
- Tasks at difficulty 7+ get `smoke.hardTimeoutMinutes` (30); the rest `smoke.timeoutMinutes` (20).
- Checks must not trust the worker's report: inspect files or run `node --test`. Every check first fails a
  scratch dir holding a file that carries `CANARY` ("copied from the grader"). Hidden files are written only
  while `check()` runs and removed again.
- Nothing the worker sees names the battery: scratch dirs live in the OS temp dir as `w-XXXXXX` and the task title
  is the entry's plain `title` (no conductor, smoke or task id). Scratch dirs are removed unless `keep` is set.
- `conductor smoke` runs the task scheduler in its own process over the same journal as a running
  server. It refuses to start while any task is queued/running/parked; keep that guard. Do not start
  a second smoke process or restart the server mid-run: whoever loads the journal next resumes the
  in-flight smoke task and records it twice.

**How to test.** `node --test test/smoke/` (no live models; the runner is driven with a
stub `execute`; `CONDUCTOR_SMOKE_SLOW=1` adds the mutants that only fail by timing out). A live run: `conductor smoke --models codex:gpt-5.6-luna:low --tasks read-1,edit-1`.
