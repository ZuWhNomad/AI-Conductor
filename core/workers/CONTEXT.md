# core/workers/ — how each provider kind executes a task

**Purpose.** A worker runs one task (a spec in a cwd) on a given provider and returns a common result. One runner
per provider *kind*; `index.mjs` dispatches by kind. The catalog/limits layer is `core/providers/`.

**Entry points.**
- `index.mjs` — `runWorker(task)` picks the runner by the model's `kind` (agent → codex/claude/vendor-cli;
  openai-compat for API + Ollama-via-its-own-endpoint; image). Local Ollama-via-Claude-harness gets
  `worker.maxTurnsLocal`.
- `codex.mjs` — the Codex CLI (OS-sandboxed; prompt via stdin).
- `claude.mjs` — the Claude Agent SDK harness (also runs local models via `ollama.claudeHarnessEnv()`).
- `openai-compat.mjs` — the `/chat/completions` tool loop for API + Ollama models. Its `run` tool is the only
  unsandboxed host surface; `fetch_url` has an SSRF guard.
- `vendor-cli.mjs` — the generic runner for the `core/providers/vendors.mjs` subscription CLIs.
- `image.mjs` — image generation.

**Invariants.**
- A worker resolves to `{ ok, finalMessage, items, usage, error, limitHit, retryAfterMs?, threadId? }`. `limitHit`
  runs are never scored; on a real limit the scheduler fails over or parks (`core/tasks.mjs`).
- No shell for spawns — go through `core/proc.mjs` (`spawnCli` unwraps npm `.cmd`; `spawnCodex` never uses a shell).
- The openai-compat `run` tool is the boundary for API/Ollama workers (no OS sandbox): gated by `worker.shell`
  (`true` | `false` | allow-list) via `shellDenied`; file tools stay sandboxed to the workspace via `safe()`.
- Prefer stdin / a prompt-file for long prompts (Windows argv limit); emit UI events through `core/bus.mjs`.

**How to test.** `test/openai-compat.test.mjs`, `test/shell-safety.test.mjs` (spawn/allow-list),
`test/vendor-cli.test.mjs`, `test/codex-args.test.mjs` / `codex-parse.test.mjs`. `CONDUCTOR_HOME`-isolated.
