# test/tasks/ — tests for the task layer (`core/tasks.mjs`)

Start with `../CONTEXT.md` (layout, isolation, `_env.mjs`) and the root `AGENTS.md`. Import `../_env.mjs` first in
every test file. `_helpers.mjs` is the shared setup (provider and I/O mocks, task-module imports, `tasksWithGit`,
`tasksWithWorker`, `initRepo`); it is not a test file.

| file | covers |
|---|---|
| `journal-views.test.mjs` | Create and journal a task, input normalization, follow-up rules, await deadlines, and the list / describe / summary views. |
| `scheduler.test.mjs` | Dispatch, git not blocking the scheduler, scoped quotas, budget ownership, concurrency, the RAM guard, and the limits snapshot around a pass. |
| `failover.test.mjs` | Mid-run and queued limit failover: chains, retry fields, sandbox and access-gate pins, avoided families, and cancel or shutdown during a quota refresh. |
| `park.test.mjs` | Parking on a limit, efficiency-mode pins, confirmed hits, wake order, `reviewParked`, and await-through-park. |
| `recovery.test.mjs` | `recoverTasks`, stale tasks, draining, and graceful stop (requeue, abort, shutdown drain). |
| `isolation.test.mjs` | Worktrees, isolate links, cleanup, and git staying out of non-repo tasks. |
| `brief.test.mjs` | The per-task brief file: written once at create, `## Result` appended once at terminal, redacted; compact vs full `describeTask`. |
| `scoring.test.mjs` | What reaches the scorecard: phantoms, auth and environment failures, empty reports, accounting polls, and a persist that must not clobber a decided outcome. |

**How to test.** `node --import ./test/_env.mjs --test test/tasks/`. Full: `npm test`.
