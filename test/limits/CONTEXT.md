# test/limits/ — tests for core/limits.mjs

Start with `../CONTEXT.md` (layout, isolation, `_env.mjs`) and the root `AGENTS.md`. Import `../_env.mjs` first in
every file. Shared fixtures live in `_helpers.mjs`, which also imports `../_env.mjs` first.

| file | covers |
|---|---|
| `windows.test.mjs` | Normalization, model-scoped windows, `familyRe`, and which model a full window blocks. |
| `polling.test.mjs` | Refresh coalescing, usage-scope tags, cross-process `limits.json` pickup, and HTTP notes. |
| `failover-scoping.test.mjs` | Window-ID groups, `blockedUntil`, and confirmed-limit resets. |

**Invariants.**
- No live provider calls. Polls, HTTP, and balance fetches are stubbed.
- A file run on its own stays isolated because it imports `../_env.mjs` before any repo module.

**How to test.** `node --import ./test/_env.mjs --test test/limits/`
