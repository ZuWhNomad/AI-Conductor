# server/ — HTTP + SSE + static UI

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** One file, `index.mjs`: the local HTTP server between the browser UI and `core/`. JSON API, the SSE event
stream, static files from `ui/`, and a minimal MCP endpoint for Codex conductors. Binds to 127.0.0.1 only. It holds no
state of its own: every route is a thin call into a `core/` module.

**Entry points.** `startServer({ port })` (used by `bin/conductor.mjs` and the tests), `doctorReport()`,
`scheduleRelaunch()` (self-restart after an update), `stopBackgroundWork()`.

**Routes.** All in `route()`; find one by grepping its path (`/api/<resource>` or `seg[1] === '<resource>'`).

| route | does | core module |
|---|---|---|
| `GET /api/state` | everything the UI needs at boot / resync | all |
| `GET /api/events?since=` | SSE stream with ring-buffer replay | `bus` |
| `/api/sessions[/<id>[/messages\|interrupt\|stop\|permission\|title\|model\|effort\|mode\|overflow]]` | chat sessions | `conductor` |
| `/api/tasks[/<id>[/cancel]]` | worker tasks; `POST` = direct-to-worker (`/worker …`) | `tasks` |
| `GET /api/models`, `POST /api/models/refresh` | model registry | `models` |
| `GET /api/limits`, `POST /api/limits/refresh` | provider windows (+ synthetic "estimated" window: `limitsWithEstimates`) | `limits`, `usage-estimate` |
| `POST /api/providers/<id>/usage` | user check-in that calibrates the usage estimate | `usage-estimate` |
| `POST /api/providers/<id>/{install,login,relogin}` | opens a visible terminal (`openTerminal`) | `providers/*` |
| `GET /api/scores`, `GET /api/bench` | scorecard table; models due a re-benchmark | `scorecard`, `bench` |
| `GET\|POST /api/settings` | config (redacted by `publicConfig`); a save re-applies polling + `schedule()` | `config` |
| `/api/improvements[/<id>/resolve]`, `POST /api/review` | improvement log; open a self-review session | `improve` |
| `POST /api/ollama/pull`, `GET /api/browse` | pull a local model; folder picker | `providers/ollama` |
| `GET\|POST /api/update` | update status; pull + self-restart | `update` |
| `GET /api/doctor`, `POST /api/shutdown` | environment check; the UI Quit button | — |
| `POST /mcp/<session>` | MCP (JSON-RPC over HTTP) exposing the conductor tools to a Codex conductor | `tools` |
| anything else | static file from `ui/` (`serveStatic`; path must stay inside `ui/`) | — |

**Invariants.**
- Host must be `127.0.0.1` / `localhost` / `[::1]` on the bound port, a present Origin must match, and a `POST` must be
  `application/json` (403 / 403 / 415). Bodies over 5 MB get a real 413. Keep these checks in front of `route()`.
- Errors thrown by a route become `{ error }` with `e.status || 500`; 5xx are logged to the improvement log.
- The UI is served from `REPO_ROOT/ui` with a MIME map that has `.js` but no `.mjs`: browser modules stay `.js`.
- Background work (polling, scheduled review, update checks) starts only when `CONDUCTOR_NO_POLL` is unset.

**How to test.** `node --test test/server/`
(`startServer({ port: 0 })` on a temp `CONDUCTOR_HOME`).
