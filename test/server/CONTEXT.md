# test/server/ — tests for server/ (HTTP, SSE, restart, provider auth)

Start with `../CONTEXT.md` (layout, isolation, `_env.mjs`) and the root `AGENTS.md`. Import `../_env.mjs` first in
every file.

| file | covers |
|---|---|
| `server.test.mjs` | Routes end to end against a real server on port 0: sessions, tasks, settings, `/api/models/refresh` (with a body, without one, and with junk), plus the pure helpers (`lagVerdict`, `isIdle`, `doctorReport`). |
| `relaunch.test.mjs` | The self-restart handshake: the old process hands over only to a child that got far enough to signal it. |
| `shutdown.test.mjs` | Quit: background work stopped, in-flight tasks requeued, pid file removed. |
| `provider-auth.test.mjs` | Noticing a sign-in we did not cause: the post-login watch, the re-auth case, and which providers the slow sweep re-probes. |

**Invariants.**
- **Always `startServer({ port: 0 })`** — never a fixed port, or a test kills the user's running instance.
- Timers and watches must be injectable (`refresh`, `statusOf`, `spawnFn`, `exit`): a test that waits on a real
  five-second interval is a test nobody runs.
- No network and no real provider CLI. Probe functions are stubbed; the suite stays offline and free.
