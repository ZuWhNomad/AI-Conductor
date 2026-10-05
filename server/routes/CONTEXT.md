# server/routes/ — one HTTP resource per file

Rules: `AGENTS.md`. This file is the brief for work in this folder. The server lifecycle stays in `server/index.mjs`.

**Purpose.** JSON route handlers split out of `index.mjs` so a path change is a one-file brief. Each module exports `async function handle(ctx)` and returns `true` when it answered the request, `false` when the path is not its resource.

**Entry points.** `handle` in each `*.mjs`. `_http.mjs` exports `json` and `readBody` (redacted JSON; bodies over 5 MB are 413, invalid JSON is 400). `index.mjs` calls the handlers in this fixed order after SSE: `jobs`, then `state`, `sessions`, `tasks`, `models-limits`, `scores`, `settings`, `improvements`, `providers`, `cli-update`, `misc`.

**Direction.** Routes import `core/` and `_http.mjs`. They do not import `../index.mjs` (that would cycle). Lifecycle state that a route mutates stays in `index.mjs` and is passed on `ctx`: `watchSignIn`, `chainShell`, `beginShutdown`, `applySettings`, `doctorReport`, `relaunchPort`, `scheduleRelaunch`, `workInFlight`, `setPendingRelaunch`, `publishUpdateWaiting`, `deferPendingRelaunch`, plus `version` and `boot`. `ctx` also carries `req`, `res`, `url`, `p`, `m`, `seg`.

**Invariants.**
- `jobs` is special: an unmatched `/api/jobs…` method returns `false` from `route()` so the static-file fallthrough still runs. Do not put `jobs` in the ordinary handler list.
- SSE (`GET /api/events`) stays inline in `index.mjs`. `test/server/server.test.mjs` evals that block through the `seg[1] === 'jobs'` marker.
- The relogin shell join (`win32 ? '&' : ';'`) stays in `index.mjs` as `chainShell`. The same test matches that source.
- Unknown `/api/*` still ends as `{ error: "no route …" }` with status 404 from `index.mjs`. Thrown errors still become `{ error }` with `e.status || 500` in `startServer`.

**How to test.** `node --test test/server/`
