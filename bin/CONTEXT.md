# bin/ — the CLI entry point

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** One file, `conductor.mjs`: the `conductor` command. It parses argv, calls into `core/` and `server/`, and
prints. No logic lives here that a route or a core module could not also use — the UI and the CLI must agree.

**Entry points.** `conductor start` (boots `server/index.mjs`), plus `doctor`, `models`, `limits` (same estimated
windows as the UI), `scores` (`--csv`), `smoke`, `bench`, `review`, `feedback`, `share`, `update`, `stop` (POST
`/api/shutdown` first; pid-file taskkill only if `/api/state` matches).

**Invariants.**
- Every command works headless: no prompt, no colour codes the user's terminal must support.
- Long-running commands (`smoke`, `bench`, `review`) refuse to run while a live server holds open journal tasks —
  two processes writing the same journal corrupts it.
- Exit codes matter: non-zero when the work failed, so a driver script can branch on it.

**How to test.** `node --test --import ./test/_env.mjs test/server/*.test.mjs` covers the server the CLI boots;
CLI-shaped behaviour is exercised through `test/smoke/` and `test/journal.test.mjs`. For a real check:
`node bin/conductor.mjs doctor`.
