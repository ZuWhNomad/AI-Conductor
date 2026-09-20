# test/workers/ — tests for core/workers/ (how each provider executes a task)

Start with `../CONTEXT.md` (layout, isolation, `_env.mjs`) and the root `AGENTS.md`. Import `../_env.mjs` first in
every file.

| file | covers |
|---|---|
| `vendor-cli.test.mjs` | The subscription CLIs: model-list parsing, the auth probe, and **recorded** event shapes per vendor. |
| `codex-args.test.mjs`, `codex-parse.test.mjs` | The Codex argv Conductor builds, and its event stream. |
| `openai-compat.test.mjs` | The API/Ollama tool loop: tool schemas, malformed arguments, the repeat guard, SSRF. |
| `shell-safety.test.mjs` | The `run` allow-list and the operator denylist — the boundary for untrusted models. |
| `dangling.test.mjs` | Tool calls left open when a turn ends. |

**Invariant worth keeping.** A vendor's behaviour is pinned by **recorded** output — real lines from the real CLI,
pasted in with the date they were captured — never by a guess about the format. When a CLI changes, re-record and say
when. A test written from the docs instead of the binary is how a vendor spec rots without anyone noticing.

Never spawn a real vendor CLI here: the specs are exercised through stubs and fixtures, so the suite is offline,
free and fast.
