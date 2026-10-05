# server/ — HTTP + SSE + static UI

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** `index.mjs` is the local HTTP server between the browser UI and `core/`: bind, the SSE event stream, static
files from `ui/`, a minimal MCP endpoint for Codex conductors, relaunch, update checks, the lag monitor, and sign-in
watches. JSON routes live in `routes/` (one resource per file; see `routes/CONTEXT.md`). Binds to 127.0.0.1 only.
Domain state stays in `core/`. Lifecycle flags a route mutates (sign-in watches, relaunch, a pending update) stay in
`index.mjs` and are passed in on `ctx` — `routes/` does not import `index.mjs`.

**Entry points.** `startServer({ port })` (used by `bin/conductor.mjs` and the tests), `doctorReport()`,
`scheduleRelaunch()` (self-restart after an update), `stopBackgroundWork()`. Server start/stop owns the liveness
watchdog interval and starts one-shot recovery of interrupted resumable turns; the watchdog may wake an idle chat but
never restarts the server.
Each start calls `recoverTasks()` and records chat restart notes; relaunch drains dispatches before handover.
The update gate counts running chats and running/queued tasks, excluding parked and stale work.

**Routes.** `route()` parses the URL, answers SSE itself, then tries each `routes/*.mjs` `handle(ctx)` until one returns true. Find a path by its file, or grep `/api/<resource>` / `seg[1] === '<resource>'`.

| route | file | does | core module |
|---|---|---|---|
| `GET /api/state` | `routes/state.mjs` | everything the UI needs at boot / resync | all |
| `GET /api/events?since=` | `index.mjs` | SSE stream with ring-buffer replay | `bus` |
| `/api/sessions[/<id>[/messages\|interrupt\|stop\|queue/<qid>\|permission\|title\|model\|effort\|mode\|overflow\|parallel\|rate]]` | `routes/sessions.mjs` | chat sessions, queued-message cancellation and operator scorecard ratings | `conductor`, `scorecard` |
| `/api/tasks[/<id>[/cancel\|rerun]]` | `routes/tasks.mjs` | worker tasks; `POST` = direct-to-worker (`/worker …`); rerun queues stale work | `tasks` |
| `/api/jobs[/<id>[/cancel]]` | `routes/jobs.mjs` | detached long jobs; an unmatched method falls through to static files | `jobs` |
| `GET /api/models`, `POST /api/models/refresh` | `routes/models-limits.mjs` | model registry | `models` |
| `GET /api/limits`, `POST /api/limits/refresh` | `routes/models-limits.mjs` | provider windows (+ synthetic "estimated" window: `limitsWithEstimates`) | `limits`, `usage-estimate` |
| `POST /api/providers/<id>/usage` | `routes/models-limits.mjs` | user check-in that calibrates the usage estimate | `usage-estimate` |
| `POST /api/providers/<id>/{install,login,relogin}` | `routes/providers.mjs` | opens a visible terminal (`openTerminal`) | `providers/*` |
| `GET /api/scores`, `GET /api/bench` | `routes/scores.mjs` | scorecard table; models due a re-benchmark | `scorecard`, `bench` |
| `POST /api/scores/eligibility` | `routes/scores.mjs` | manual allow or block for one selection and category | `scorecard` |
| `GET\|POST /api/settings` | `routes/settings.mjs` | config (redacted by `publicConfig`); a save re-applies polling, update checks + `schedule()` | `config` |
| `/api/improvements[/<id>/resolve]`, `POST /api/review` | `routes/improvements.mjs` | improvement log; open a self-review session | `improve` |
| `GET /api/browse` | `routes/misc.mjs` | folder picker (async; UNC refused; 404 for missing paths or files) | — |
| `GET\|POST /api/update` | `routes/misc.mjs` | update status; pull + self-restart | `update` |
| `GET\|POST /api/cli-update` | `routes/cli-update.mjs` | worker CLI update status; check or background install | `cli-update` |
| `GET /api/doctor`, `POST /api/shutdown` | `routes/misc.mjs` | environment check; the UI Quit button | — |
| `POST /mcp/<session>` | `index.mjs` | MCP (JSON-RPC over HTTP) exposing the conductor tools to a Codex conductor | `tools` |
| anything else | `index.mjs` | static file from `ui/` (`serveStatic`; path must stay inside `ui/`) | — |

**Boundaries.** May import `core/`. Must not import `bin/` or `ui/` — the UI is served as static files, not code.
Enforced by `test/boundaries.test.mjs`.

**Invariants.**
- Host must be `127.0.0.1` / `localhost` / `[::1]` on the bound port, a present Origin must match, a present
  `sec-fetch-site` must be `same-origin` or `none`, and a `POST` must be `application/json` (403 / 403 / 403 / 415).
  Bodies over 5 MB get a real 413. Keep these checks in front of `route()`.
- `/api/browse` is async fs and refuses UNC paths (`\\host` / `//host`).
- Errors thrown by a route become `{ error }` with `e.status || 500`; 5xx are logged to the improvement log.
- The UI is served from `REPO_ROOT/ui` with a MIME map that has `.js` but no `.mjs`: browser modules stay `.js`.
- Background work (polling, scheduled review, update checks) starts only when `CONDUCTOR_NO_POLL` is unset.

**How to test.** `node --test test/server/`
(`startServer({ port: 0 })` on a temp `CONDUCTOR_HOME`).
