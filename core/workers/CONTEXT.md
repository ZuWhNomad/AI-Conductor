# core/workers/ — how each provider kind executes a task

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** A worker runs one task (a spec in a cwd) on a given provider and returns a common result. One runner
per provider *kind*; `index.mjs` dispatches by kind. The catalog/limits layer is `core/providers/`.

**Prompt caching.** The OpenAI-compatible loop keeps request prefixes stable: old tool results are stubbed only when the
full ones exceed the budget (roughly 25% of the model's context window tokens × 4 chars/token clamped to [32k, 400k] chars;
fallback 120k), down to `worker.toolResultLowWater` of it (so requests are append-only between trims), and
the loop keeps stable request prefixes between trims.

**Entry points.**
- `index.mjs` — `runWorker(task)` picks the runner by the provider's `kind` (codex, claude,
  openai-compat, vendor-cli).
- `codex.mjs` — the Codex CLI (sandbox mode follows task/config, including per-model exceptions; prompt via stdin;
  a transient stream failure resumes the same thread once).
- `claude.mjs` — the Claude Agent SDK harness.
- `openai-compat.mjs` — the `/chat/completions` tool loop for DeepSeek. Host execution is not limited
  to openai-compat `run`: Claude workers default to `bypassPermissions`, vendor CLIs run with auto-approve flags,
  and `worker.codexSandboxByModel` can give a Codex model its own sandbox (empty by default). The `run` child env
  drops `*_API_KEY` / `*_TOKEN` / `*_SECRET`, and a command naming the state dir is refused. `fetch_url` has an SSRF guard.
- `openai-compat-files.mjs` — async canonical-path checks and bounded file reads; the disposable search worker
  runs the entire traversal and regex off the server thread. Search terminates at the task deadline (or a fixed
  10-minute tool deadline when the run is unlimited), and on cancellation. The tool waits for termination before settling.
- `vendor-cli.mjs` — the generic runner for the `core/providers/vendors.mjs` subscription CLIs
  (read-only tasks on git repos run in a disposable snapshot worktree via `readOnlyViaSnapshot`).

**Boundaries.** May import `../proc.ts`, `../bus.ts`, `../paths.ts`, `../config.mjs`, `../mcp.mjs`, `../models.mjs`,
`../improve.mjs`, `../context.mjs`, `../compaction.ts`. Must not import the orchestration layer (`tasks`, `scorecard`,
`sweep`, `limits`, `plans`, `tools`, `conductor`, `watchdog`, `jobs`, `bench`): a worker runs one task and knows nothing
about the queue. Enforced by `test/boundaries.test.mjs`.

**Invariants.**
- A worker resolves to `{ ok, finalMessage, items, usage, error, limitHit, authFailed, retryAfterMs?, threadId? }`.
  `limitHit` runs are never scored; on a real limit the scheduler fails over or parks (`core/tasks.mjs`). `authFailed`
  (a 401, a spent refresh token, not signed in) and `envFailed` (grok plan mode cancelling a tool) are the environment:
  the task fails with `failKind: 'auth'` / `'env'`, unscored.
- Limit and auth are decided from structured signals: Codex `codexFailure` (rollout `codex_error_info`, a JSON body's
  `status`, the "unexpected status NNN" prefix); grok `http_status` (402/429 limit, 401/403 auth); grok's own session
  `events.jsonl` for plan-mode cancels. agy gives no structured status: text patterns are the
  fallback, and each use is logged to the improvement log.
- `runWorker` redacts its result (keys a CLI echoes, e.g. OpenAI's 401) before anything records it; see `paths.ts` `redact`.
- `writableRoots` (delegate `writable_roots`): extra writable directories — Codex `--add-dir`, Claude
  `additionalDirectories`, Antigravity `--add-dir`. Grok runs unsandboxed; the rest ignore it.
- `isolate: true` is scheduler-owned (`core/tasks.mjs`): the worker just receives `cwd` pointing at the worktree.
- No shell for spawns — go through `core/proc.ts` (`spawnCli` unwraps npm `.cmd`; `spawnCodex` never uses a shell).
- Long-lived CLI/SDK children register their PID owner in `core/proc.ts`, which lets the watchdog attribute their
  process trees and CPU without killing by image/name.
- The openai-compat `run` tool is disabled by default (`worker.shell: false`). Explicit `true` or an allow-list
  trusts host execution: permitted programs can read/write outside the workspace. `shellDenied` filters commands,
  not their filesystem access. The allow-list deliberately rejects operators even inside quotes; it does not strip
  quoted spans or parse shell-specific escapes. This setting does not change Codex sandbox defaults or per-model exceptions.
- File tools check canonical workspace containment via `safePath()`, including symlinks/junctions and new-file
  ancestors. These checks cannot prevent concurrent link swaps (TOCTOU); they are not an OS sandbox.
- Claude runs (workers and conductor chats) carry `KILL_GUARD_HOOKS`: a PreToolUse hook denies killing processes by
  name or image (`taskkill /IM`, `Stop-Process -Name`, `pkill`, `killall`), which would kill the Conductor itself.
  Vendor CLIs can't be hooked; `core/policy/prompts/worker.md` tells them the same rule.
- Prefer stdin / a prompt-file for long prompts (Windows argv limit); emit UI events through `core/bus.ts`.

**How to test.** `test/workers/`: `openai-compat.test.mjs`, `file-tools.test.mjs` (responsiveness, bounds, cleanup), `shell-safety.test.mjs` (spawn/allow-list),
`vendor-cli.test.mjs`, `codex-args.test.mjs` / `codex-parse.test.mjs`, `codex-auth.test.mjs` (401 → authFailed, redaction). `CONDUCTOR_HOME`-isolated.
