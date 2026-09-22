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
- `vendor-cli.mjs` — the generic runner for the `core/providers/vendors.mjs` subscription CLIs.
- `image.mjs` — image generation.

**Invariants.**
- A worker resolves to `{ ok, finalMessage, items, usage, error, limitHit, retryAfterMs?, threadId? }`. `limitHit`
  runs are never scored; on a real limit the scheduler fails over or parks (`core/tasks.mjs`).
- No shell for spawns — go through `core/proc.mjs` (`spawnCli` unwraps npm `.cmd`; `spawnCodex` never uses a shell).
- The openai-compat `run` tool is disabled by default (`worker.shell: false`). Explicit `true` or an allow-list
  trusts host execution: permitted programs can read/write outside the workspace. `shellDenied` filters commands,
  not their filesystem access. This setting does not change Codex sandbox defaults or per-model exceptions.
- File tools check canonical workspace containment via `safe()`, including symlinks/junctions and new-file
  ancestors. These checks cannot prevent concurrent link swaps (TOCTOU); they are not an OS sandbox.
- Prefer stdin / a prompt-file for long prompts (Windows argv limit); emit UI events through `core/bus.mjs`.

**How to test.** `test/workers/`: `openai-compat.test.mjs`, `shell-safety.test.mjs` (spawn/allow-list),
`vendor-cli.test.mjs`, `codex-args.test.mjs` / `codex-parse.test.mjs`. `CONDUCTOR_HOME`-isolated.
