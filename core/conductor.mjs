// Conductor chat sessions. Three runtimes, one contract:
//   claude — a long-lived Agent SDK query (Claude Code harness, subagents, in-process MCP tools)
//   codex  — one `codex exec` turn per message (thread resumed), tools via the /mcp HTTP endpoint
//   loop   — the OpenAI-compatible API tool loop with the same tools as functions
//
// Split into core/conductor/ (prompt → sessions → common → runtime-claude → runtime-codex →
// runtime-loop → turns; each imports only earlier modules). This file re-exports that surface.
//
// runCodex is imported here, not in runtime-codex.mjs: the conductor test mocks the specifier
// `./workers/codex.mjs` only when the parent URL contains `conductor.mjs`.
import { runCodex } from './workers/codex.mjs';
import { setRunCodex } from './conductor/runtime-codex.mjs';

setRunCodex(runCodex);

export * from './conductor/prompt.mjs';
export * from './conductor/sessions.mjs';
export * from './conductor/common.mjs';
export * from './conductor/runtime-claude.mjs';
export * from './conductor/runtime-codex.mjs';
export * from './conductor/runtime-loop.mjs';
export * from './conductor/turns.mjs';
