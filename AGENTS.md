# Conductor 2.0 — rules for agents working on this repo

If `../WORKSPACE.md` exists, read it first (local workspace index; never commit it or copy its paths into this repo).

**The unit of work is a folder.** Every code folder has a `CONTEXT.md`: purpose, entry points, boundaries, invariants
and the test command. A task's brief is that file plus the tests it names — read it before the code, and stay inside
the folder's boundaries (`test/boundaries.test.mjs` enforces them). Open `docs/ARCHITECTURE.md` only when the work
spans folders; its directory map says which `CONTEXT.md` to read.

Invariants that hold everywhere:

- **No build step.** Plain ESM, Node >= 22.18: `.mjs` today, `.ts` where a module has been converted (Node strips the
  types at load; only erasable syntax, explicit extensions in imports). Two runtime dependencies
  (`@anthropic-ai/claude-agent-sdk`, `zod`); do not add more without a strong reason. Dev dependencies are
  `typescript` and `@types/node`, for `npm run check` only.
- **Ladder before code:** does it need to exist → stdlib → platform feature → existing dependency → one line → then
  write the minimum.
- **`npm test` and `npm run check` before reporting done.** Tests isolate state via `CONDUCTOR_HOME`
  (`test/_env.mjs`); never touch the real `~/.conductor2`. `check` is `tsc --noEmit` over the whole tree.
- **Events:** everything the UI sees goes through `core/bus.mjs` (`bus.publish(type, data)`). Small payloads.
- **Secrets** live only in `~/.conductor2/config.json`; `publicConfig()` redacts them. Never log them.
- **Windows first:** spawn CLIs without a shell (`core/proc.mjs`); prefer stdin for long prompts.
- **This repo is the product, not the project.** Plans, reviews, backlogs, research and dated logs go in the user's
  notes location (`../WORKSPACE.md` says where) — never in here. `docs/` is for what a stranger who cloned this repo
  would need. `test/hygiene.test.mjs` fails on a tracked `plans/`, `reviews/` or `notes/` folder.
- **A new folder gets a `CONTEXT.md` in the same commit** (the hygiene test checks it exists). A changed import
  boundary updates both the folder's `CONTEXT.md` and `test/boundaries.test.mjs`.
