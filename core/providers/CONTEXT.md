# core/providers/ — how each vendor lists models and reports limits

**Purpose.** One module per vendor: detect whether it's installed/authed, list its models, and poll its usage
windows. This is the *catalog + meter* layer; how a task actually runs lives in `core/workers/`.

**Entry points.**
- `index.mjs` — the registry. Every provider is `{ id, label, kind, auth, detect(), listModels(), pollLimits() }`;
  register a new one here. Also holds the image providers and wires the subscription-CLI vendors.
- `anthropic.mjs`, `codex.mjs`, `ollama.mjs`, `openai-compat.mjs` — first-party / API providers.
- `vendors.mjs` — subscription **agent CLIs** (Antigravity `agy`, xAI `grok`, Qwen Code, Kimi). Each is a spec
  (`bin`, `login`, `probe`, `parseModels`, `pollLimits`, `headlessArgs`, `parse`); `providerFor(spec)` turns a spec
  into a provider. Verify a CLI's flags against the real binary before trusting a spec.

**Invariants.**
- A limit window may carry a `models` regex — it then meters only the models it names (Antigravity groups Gemini vs
  Claude+GPT; Claude's per-model weekly windows scope to their family via `familyRe`). `providerWindows(provider,
  model)` in `core/scorecard.mjs` applies that scoping; the whole-provider `blocked` flag comes only from *unscoped*
  windows, so a maxed per-model window blocks just that model.
- Secrets live only in `~/.conductor2/config.json`; never log them. `publicConfig()` redacts keys and MCP env/url.
- Windows-first: never spawn a CLI through a shell (`core/proc.mjs` `spawnCli` unwraps npm `.cmd` shims); long
  prompts go via stdin / `--prompt-file`, not argv.
- Model-list overrides: a CLI that can't self-list reads `providers.<id>.models` from config.

**How to test.** `test/vendor-cli.test.mjs` (record each CLI's event shapes), `test/limits.test.mjs`
(window normalization / block semantics), `test/selection.test.mjs`. Tests isolate state via `CONDUCTOR_HOME`.
