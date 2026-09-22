# test/workers/ — tests for core/workers/ (how each provider executes a task)

Start with `../CONTEXT.md` (layout, isolation, `_env.mjs`) and the root `AGENTS.md`. Import `../_env.mjs` first in
every file.

| file | covers |
|---|---|
| `vendor-cli.test.mjs` | Subscription CLIs: model-list parsing, the auth probe, recorded stream shapes for **agy** (stream-json, 2026-09-08) and **grok** (streaming-messages-json, 2026-09-10). qwen-code and kimi have no recorded JSON event fixtures. |
| `codex-args.test.mjs`, `codex-parse.test.mjs` | The Codex argv Conductor builds, and its event stream. |
| `openai-compat.test.mjs` | The API/Ollama tool loop: tool schemas, malformed arguments, the repeat guard, SSRF. |
| `shell-safety.test.mjs` | Default `run` denial, explicit host-execution opt-ins, the command allow-list and operator denylist (not a filesystem sandbox). |
| `image.test.mjs` | The image runner: `outDir` containment and the SD request honouring the abort signal. |
| `dangling.test.mjs` | Tool calls left open when a turn ends. |

**Invariant worth keeping.** A vendor's behaviour is pinned by **recorded** output — real lines from the real CLI,
pasted in with the date they were captured — never by a guess about the format. When a CLI changes, re-record and say
when. A test written from the docs instead of the binary is how a vendor spec rots without anyone noticing.

Never spawn a real vendor CLI here: the specs are exercised through stubs and fixtures, so the suite is offline,
free and fast.
