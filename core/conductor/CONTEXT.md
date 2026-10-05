# core/conductor/ — chat sessions

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** One conductor chat across three runtimes. A change to one runtime is one file. Seven modules in a
strict order; each imports only the ones before it. `../conductor.mjs` re-exports all of them so older imports keep
working — new code imports the module it needs.

**Entry points.**
- `prompt.mjs` — `PROMPT` (policy + framework index + orchestration playbook) and the per-runtime variants
  `PROMPT_CODEX`, `PROMPT_LOOP`. No session state.
- `sessions.mjs` — the session Map, hydrated from `sessions.json` at import, and its public shape: `publicSession`,
  `parseSelection`, `runtimeFor`, `listSessions`, `getSession`, `createSession`, `deleteSession`, the title / effort /
  model / permission / parallel / overflow setters, queued-message removal, watchdog check-ins, restart notes,
  permission resurfacing, `reloadSessions`, `sessionContext`. `stop()` lives here (it only clears session fields).
- `common.mjs` — `turnEventMapper`, the Codex/loop worker-event → UI message translation both runtimes share.
- `runtime-claude.mjs` — one long-lived Agent SDK query per session (`start`). Streaming input goes through `Inbox`.
- `runtime-codex.mjs` — one `codex exec` turn (`runCodexTurn`). Imports `runCodex` from `../workers/codex.mjs`.
  `setServerUrl` lives here; that string is read only when a Codex turn attaches its `/mcp` endpoint.
- `runtime-loop.mjs` — one OpenAI-compatible tool-loop turn (`runLoopTurn`), including history compaction.
- `turns.mjs` — `sendMessage`, `interrupt`, `stopSession`, `shutdownSessions`, `resumeInterruptedTurns`, `runOnce`.
  Picks the runtime, drains a non-Claude queue only while the turn still owns the session.

**Boundaries.** `prompt` → `sessions` → `common` → `runtime-claude` → `runtime-codex` → `runtime-loop` → `turns`,
never backwards. Outside this folder the modules import `paths`, `config`, `bus`, `mcp`, `session-flags`, `tools`,
`plans`, `improve`, `providers/index`, `recipes`, `workers/claude`, `workers/openai-compat`, `proc`, `models`,
`compaction.ts`, `workers/codex`, and `@anthropic-ai/claude-agent-sdk`. Nothing from `server/`, `bin/`, `ui/` or
`test/`. Enforced by `test/boundaries.test.mjs`.

**Invariants.**
- The session Map and the `serverUrl` string each live in exactly one module (`sessions.mjs`, `runtime-codex.mjs`).
- `runtime-codex.mjs` imports `runCodex` from `../workers/codex.mjs`.
- Non-Claude follow-ups sit in the session queue and the transcript together. A turn drains the whole queue only
  while it still owns the session (`turnAbort`). Claude keeps using its SDK inbox.
- `stop()` clears `turnAbort` before the aborted turn's `finally` runs, so a session deleted mid-turn does not
  rewrite its history files.

**How to test.** `node --import ./test/_env.mjs --test test/conductor.test.mjs test/compaction.test.mjs
test/selection.test.mjs test/parallel.test.mjs test/mcp.test.mjs test/recipes.test.mjs` (state is isolated via
`CONDUCTOR_HOME`). Full: `npm test`.
