# core/workers/ — how each provider kind executes a task

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** A worker runs one task (a spec in a cwd) on a given provider and returns a common result. One runner
per provider *kind*; `index.mjs` dispatches by kind. The catalog/limits layer is `core/providers/`.

**Entry points.**
- `index.mjs` — `runWorker(task)` picks the runner by the provider's `kind` (codex, claude, ollama,
  openai-compat, image, vendor-cli). Local Ollama-via-Claude-harness gets `worker.maxTurnsLocal`.
- `codex.mjs` — the Codex CLI (sandbox mode follows task/config, including per-model exceptions; prompt via stdin).
- `claude.mjs` — the Claude Agent SDK harness (also runs local models via `ollama.claudeHarnessEnv()`).
- `openai-compat.mjs` — the `/chat/completions` tool loop for API + Ollama models. Host execution is not limited
  to openai-compat `run`: Claude workers default to `bypassPermissions`, vendor CLIs run with auto-approve flags,
  and `gpt-6-astra` defaults to `danger-full-access`. `fetch_url` has an SSRF guard.
- `openai-compat-files.mjs` — async canonical-path checks and bounded file reads; the disposable search worker
  runs the entire traversal and regex off the server thread. Search terminates at the task deadline (or the configured
  worker-run timeout when none was supplied), and on cancellation. The tool waits for termination before settling.
- `vendor-cli.mjs` — the generic runner for the `core/providers/vendors.mjs` subscription CLIs.
- `image.mjs` — image generation.

**Invariants.**
- A worker resolves to `{ ok, finalMessage, items, usage, error, limitHit, authFailed, retryAfterMs?, threadId? }`.
  `limitHit` runs are never scored; on a real limit the scheduler fails over or parks (`core/tasks.mjs`). `authFailed`
  (a 401, a spent refresh token, not signed in) and `envFailed` (grok plan mode cancelling a tool) are the environment:
  the task fails with `failKind: 'auth'` / `'env'`, unscored.
- Limit and auth are decided from structured signals: Codex `codexFailure` (rollout `codex_error_info`, a JSON body's
  `status`, the "unexpected status NNN" prefix); grok `http_status` (402/429 limit, 401/403 auth); grok's own session
  `events.jsonl` for plan-mode cancels. agy, kimi and qwen give no structured status: their text patterns are the
  fallback, and each use is logged to the improvement log.
- `runWorker` redacts its result (keys a CLI echoes, e.g. OpenAI's 401) before anything records it; see `paths.mjs` `redact`.
- `writableRoots` (delegate `writable_roots`): extra writable directories — Codex `--add-dir`, Claude
  `additionalDirectories`, Antigravity `--add-dir`. Grok runs unsandboxed; the rest ignore it.
- No shell for spawns — go through `core/proc.mjs` (`spawnCli` unwraps npm `.cmd`; `spawnCodex` never uses a shell).
- The openai-compat `run` tool is disabled by default (`worker.shell: false`). Explicit `true` or an allow-list
  trusts host execution: permitted programs can read/write outside the workspace. `shellDenied` filters commands,
  not their filesystem access. The allow-list deliberately rejects operators even inside quotes; it does not strip
  quoted spans or parse shell-specific escapes. This setting does not change Codex sandbox defaults or per-model exceptions.
- File tools check canonical workspace containment via `safePath()`, including symlinks/junctions and new-file
  ancestors. These checks cannot prevent concurrent link swaps (TOCTOU); they are not an OS sandbox.
- Claude runs (workers and conductor chats) carry `KILL_GUARD_HOOKS`: a PreToolUse hook denies killing processes by
  name or image (`taskkill /IM`, `Stop-Process -Name`, `pkill`, `killall`), which would kill the Conductor itself.
  Vendor CLIs can't be hooked; `core/policy/prompts/worker.md` tells them the same rule.
- Prefer stdin / a prompt-file for long prompts (Windows argv limit); emit UI events through `core/bus.mjs`.

**How to test.** `test/workers/`: `openai-compat.test.mjs`, `file-tools.test.mjs` (responsiveness, bounds, cleanup), `shell-safety.test.mjs` (spawn/allow-list),
`vendor-cli.test.mjs`, `codex-args.test.mjs` / `codex-parse.test.mjs`, `codex-auth.test.mjs` (401 → authFailed, redaction). `CONDUCTOR_HOME`-isolated.
