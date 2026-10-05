# test/plans/ — tests for core/plans.mjs (`run_plan`)

Start with `../CONTEXT.md` (layout, isolation, `_env.mjs`) and the root `AGENTS.md`. Import `../_env.mjs` first in
every file. Shared fixtures and the delegate/`run_plan` tool harness live in `_helpers.mjs`, which also imports
`../_env.mjs` first.

| file | covers |
|---|---|
| `stages.test.mjs` | Sequential and parallel stage execution, templating (`{{goal}}`, `{{seen}}`, `{{results:x}}`), lenses, and dispatch defaults. |
| `for-each-votes.test.mjs` | Per-finding fan-out, vote tallies, and JSON block parsing. |
| `until-dry.test.mjs` | `until_dry` loops, `max_rounds`, and the capped flag. |
| `status-report.test.mjs` | Plan ids, persisted reports, cancellation, deadlines, and restart safety. |
| `routing.test.mjs` | Delegate retry ancestry: follow-ups, escalation depth, and chain exclusions. |

**Invariants.**
- Injected task runtimes stand in for workers. The harness mocks selection and task waits only; `createTask` still persists under `CONDUCTOR_HOME`.
- `plans.warmupSeconds` is 0 here so tests observe plan results, not worker warm-up.

**How to test.** `node --import ./test/_env.mjs --test test/plans/`
