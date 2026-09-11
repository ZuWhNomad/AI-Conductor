# core/smoke — model smoke battery

**Purpose.** Seed the scorecard (`core/scorecard.mjs`) with automatically rated runs so worker
selection is empirical rather than assumed. Every battery task is a tiny scratch project with a
deterministic check.

**Entry points.** `runSmoke({ models, tasks })` in `index.mjs` (used by the `smoke_test` conductor
tool and `conductor smoke`); `BATTERY` in `battery.mjs` (the tasks); `formatSmoke(results)`.

**Invariants.**
- One task at a time per run, so the before/after limit delta belongs to that task.
- Every entry has `setup`, `check` and a reference `solve`; `test/smoke.test.mjs` proves each check
  fails on the untouched fixture and passes on the reference solution. Keep that true when adding tasks.
- Ids are `category-level`; difficulty 1–5 follows the rubric in `core/prompts/conductor.md`. Levels
  1–3 are sanity checks almost every model passes; 4–5 (`implement-4` evaluator, `test-4` mutant-killing
  suite, `debug-5` async pool) are where ceilings show. Add harder rungs when everything passes again.
- Checks must not trust the worker's report: inspect files or run `node --test`.
- Scratch dirs live in the OS temp dir and are removed unless `keep` is set.
- `conductor smoke` runs the task scheduler in its own process over the same journal as a running
  server. It refuses to start while any task is queued/running/parked; keep that guard. Do not start
  a second smoke process or restart the server mid-run: whoever loads the journal next resumes the
  in-flight smoke task and records it twice.

**How to test.** `node --test test/smoke.test.mjs` (no live models; the runner is driven with a
stub `execute`). A live run: `conductor smoke --models codex:gpt-5.6-luna:low --tasks read-1,edit-1`.
