# Tests

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

Node's built-in test runner. Run `npm test` from the repository root (it preloads `test/_env.mjs` with `--import`), or one
file / folder: `node --import ./test/_env.mjs --test test/tasks.test.mjs`, `… test/workers/`.

**Layout mirrors the source folders that have tests:** `test/workers/` (`core/workers/*`), `test/smoke/` (`core/smoke/`),
`test/server/` (`server/`). Tests for the flat `core/*.mjs` modules and the cross-cutting ones (`hygiene`, `git`,
`selection`, `escalation`, `journal`) stay at the root. Put a new test beside the tests of the folder its module lives in.

`_env.mjs` isolates state (`CONDUCTOR_HOME` = a temp dir, scheduling and polling off) and supplies `HOME` and
`tmpDir()`. Every test file still imports it first (`./_env.mjs` or `../_env.mjs`) — `test/hygiene.test.mjs` fails
otherwise — so a file run on its own is isolated too. Scheduler tests must restore the flags they change. Use temporary
repositories for Git checks and stubs for worker/API calls; never the live state directory or server.
