# Conductor 2.0 — notes for agents working on this repo

Read `docs/ARCHITECTURE.md` first. Then:

- **No build step.** Plain ESM (`.mjs`), Node >= 22. Two runtime dependencies (`@anthropic-ai/claude-agent-sdk`, `zod`). Do not add more without a strong reason.
- **Ladder before code:** does it need to exist → stdlib → platform feature → existing dependency → one line → then write the minimum.
- **Run `npm test`** before reporting done. Tests isolate state via `CONDUCTOR_HOME` (see `test/_env.mjs`); never touch the real `~/.conductor2`.
- **Where things live:** `core/` engine, `core/workers/` how each provider executes a task, `core/providers/` how each vendor lists models and reports limits, `core/prompts/` the orchestration policy, `server/` HTTP+SSE, `ui/` the browser app (vanilla JS), `bin/` CLI.
- **Adding a provider:** one module in `core/providers/` exporting `id, label, kind, auth, detect(), listModels(), pollLimits()`; register it in `core/providers/index.mjs`; if `kind` is new, add a runner in `core/workers/`. A subscription **CLI** (agent binary with a headless mode) is just a spec in `core/providers/vendors.mjs` — verify its flags against the real binary and record the event shapes in `test/vendor-cli.test.mjs`.
- **Events:** everything the UI sees goes through `core/bus.mjs` (`bus.publish(type, data)`). Keep payloads small; the ring buffer replays the last 2000.
- **Secrets:** API keys live only in `~/.conductor2/config.json`; `publicConfig()` redacts them. Never log them.
- **Windows first:** spawn CLIs without a shell (see `core/proc.mjs`); prefer stdin for long prompts.
- When you add a folder or module, add a short `CONTEXT.md` (purpose, entry points, invariants, how to test).
