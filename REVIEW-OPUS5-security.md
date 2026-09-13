# Conductor 2.0 — Security Review (Opus 4.8)

Scope: security only. Local workbench, Node ≥22, plain ESM, Windows-first, HTTP bound to `127.0.0.1`.
Read-only review — no code changed. `npm test` reported green (135) by the caller; not re-run.

Threat model used: (a) a remote web page trying to reach the local server from the user's browser;
(b) a **worker model** (third-party API, local Ollama, or a subscription CLI) that is adversarial or
successfully prompt-injected via repo/web content it ingests; (c) leakage of secrets into logs, the
improvement log, the shared feedback bundle, or an HTTP response.

Bottom line: the recently-hardened command-exec and CSRF/rebinding surfaces **hold up** (details in
§"Verified-holding"). The material risks are (1) SSRF in `fetch_url`, (2) an unsandboxed worker shell
that can read the plaintext secrets file and exfiltrate every stored key to a third-party model, and
(3) a redaction gap in the feedback bundle.

---

## Findings (ranked)

### 1. `fetch_url` / `fetchUrlText` has no SSRF protection — P2, confidence HIGH
`core/workers/openai-compat.mjs:43-51` (tool def `:39`, wired `:90`).

`fetchUrlText` accepts any `http(s)` URL, with `redirect: 'follow'`, and does **no** filtering of the
destination host/IP. The only guard is the `^https?://` scheme check (`:44`). Any worker driven by the
openai-compat loop (DeepSeek, Kimi, Grok, Qwen, Gemini-compat, **Ollama**) can call `fetch_url` on:
- `http://169.254.169.254/latest/meta-data/...` — cloud-instance metadata (IAM creds if run on a cloud VM),
- `http://127.0.0.1:47474/api/state` and other loopback services — note the local server's Host check
  passes for a `fetch` whose Host is `127.0.0.1:<port>`, and there is no Origin header on a server-side
  fetch, so the Origin check passes too; `/api/state` returns redacted config but confirms internal layout,
- `http://192.168.x.x/...` / `http://<internal-host>/...` — internal-network reconnaissance and retrieval.

The fetched body is returned to the model, so this is a read/exfiltration primitive steerable by
prompt injection (see §3). `redirect: 'follow'` also means an allowed public URL can 302 into a private
one, so a scheme/host check would have to be re-applied per hop (or redirects disabled).

Exploit: a worker is told (by a poisoned web page or CONTEXT.md) to "fetch http://169.254.169.254/…";
it does, and the response is handed back into the loop / surfaced to the conductor.

Fix direction (not applied): resolve the host and reject loopback / link-local / private / ULA / `.local`
ranges before fetching, and re-validate after every redirect (or `redirect: 'manual'`).

### 2. Unsandboxed `run` shell + plaintext secrets file → cross-provider key exfiltration — P2 (P1 under a "don't trust the model provider" threat model), confidence HIGH
`core/workers/openai-compat.mjs:93-110` (gate `shellDenied` `:19-28`); secrets at `~/.conductor2/config.json`
(`core/config.mjs:87`, `core/paths.mjs:9-15`); redaction that only protects the *UI copy* at
`core/config.mjs:141-148`.

`worker.shell` defaults to `true` (`core/config.mjs:28`). In that mode the `run` tool does
`spawn(command, { cwd, shell: true })` with **no OS sandbox** and the server's full `process.env`. A
worker model therefore has arbitrary host command execution. `cwd` is only the starting directory —
`command` is unrestricted, so `type %USERPROFILE%\.conductor2\config.json` (or `cat ~/.conductor2/config.json`)
reads the file that stores **every provider's API key in plaintext**, and the output is returned into the
tool loop — i.e. shipped to the very model provider running the worker. The same shell can `curl`/
`Invoke-WebRequest` to exfiltrate anywhere, or read SSH keys, `.aws/credentials`, browser data, etc.

This is the documented "API/Ollama workers have no OS sandbox" trade-off (`core/config.mjs:24-28`), but the
security consequence is worth stating plainly: **delegating a task to any openai-compat provider hands that
provider an unsandboxed shell on the host and reachability to the plaintext key store for all other
providers.** The file-tool `safe()` sandbox (§ below) does *not* contain this, because `run` bypasses it.

The allow-list mode (`worker.shell: [...]`) is a real mitigation and its command-splitting is sound
(see Verified-holding), but the *default* is fully open, and even the allow-list can't stop an allow-listed
interpreter (`python`, `node`) from doing the same, since argument content isn't constrained.

Fix direction: default `worker.shell` to an allow-list (or `false`); scrub high-value secret paths from a
worker's reachable env/FS; document that openai-compat delegation = trusting that provider with host access.

### 3. Prompt injection: repo notes and fetched pages are ingested as instructions — P3, confidence HIGH
`core/context.mjs:38-42` (context block), `:11-36` (discovery); `fetchUrlText` output `:90`;
policy note `core/prompts/conductor.md:25`.

`contextBlock` injects `CONTEXT.md` / `CLAUDE.md` / `AGENTS.md` content **verbatim** into every worker
spec, and `fetch_url` returns arbitrary web-page text into the loop. Neither is delimited as untrusted
(the `<context file=…>` wrapper is cosmetic). A malicious note committed to a target repo, or a poisoned
web page, can redirect a worker. On its own this is the usual agent prompt-injection exposure; combined
with finding 2 (unsandboxed `run`) it escalates to steer-to-RCE / steer-to-exfiltration. Note that
`findContextFiles` itself is path-contained (`:19` walks only within `root`, absolute out-of-root paths in
a spec resolve to nothing), so this is content-injection, not file disclosure.

### 4. Feedback-bundle redaction misses common key formats — P3, confidence HIGH (reproduced)
`core/feedback.mjs:19-27` (`redact`), used by `writeFeedback` `:49` and any share of the bundle.

Reproduced against the real `redact`:
- `AIzaSyD…` (Google/Gemini API key) → **not redacted**. The `AIza` alternative at `:24` requires a
  `[-_]` separator immediately after (`(?:…|AIza|…)[-_]…`), but real Google keys are `AIza`+alphanumerics
  with no separator, so that branch never fires.
- `gsk_…` (Groq), `AKIA…` (AWS access-key id) → **not redacted** (no matching prefix; no label).
- `sk-ant-…`, `xai-…`, and `token=…` in a URL query → correctly redacted.

Impact is bounded because `feedbackBundle()` (`:30-43`) deliberately does **not** include
`cfg.providers` or `cfg.mcpServers`, so keys only reach the bundle if they leaked into the improvement
log or scorecard text (e.g. an error string echoing a Google key, or a worker's captured output). Given
finding 2 can put arbitrary secrets into worker output that then reaches the log, the gap is worth closing.
Fix direction: drop the mandatory `[-_]` for the prefix-based branch (match `prefix[-_]?…`), and add
`AIza[0-9A-Za-z_-]{16,}` / `AKIA[0-9A-Z]{16}` / high-entropy fallbacks.

### 5. `publicConfig` redacts MCP `env` but not MCP server `url` — P3, confidence HIGH
`core/config.mjs:141-148`.

`publicConfig` masks `providers[*].apiKey` and every `mcpServers[*].env` value, but leaves
`mcpServers[*].url` (and `command`/`args`) intact. A remote MCP configured with a bearer token in its
URL query string (`{ url: "https://mcp.example/sse?token=…" }`, a common pattern) is returned verbatim by
`GET /api/state` (`server/index.mjs:69`) and streamed to the UI. Exposure is loopback-only (UI/SSE), and
the feedback bundle omits `mcpServers` entirely, so severity is low — but it is an un-redacted secret path.
Fix direction: strip credentials from MCP `url`/`args` in `publicConfig`.

### 6. No local authentication on the server — P3, confidence HIGH (by design)
`server/index.mjs:248-262`, listen `:266`.

The server has no token/auth; authorization is "can you reach loopback and send the right Host/Origin/
Content-Type". On a shared/multi-user host, **any local user or process** can drive the full API —
including `POST /api/tasks` (arbitrary `cwd` + `spec`, `sandbox`, even `danger-full-access`) which runs a
worker, and `POST /api/sessions/:id/messages`. This is the standard localhost-trust model and is
reasonable for a single-user workbench; flagged so the assumption is explicit. The browser-facing threats
(CSRF, DNS-rebinding) are properly defended — see below.

### 7. `/api/browse` enumerates arbitrary directories — P3, confidence HIGH (intended)
`server/index.mjs:31-37`, `:142`.

`listDirs` returns child directory **names** for any path (defaults to `homedir()`), used by the UI folder
picker. It lists names only (no file contents), and is loopback + Origin-gated, so it's an intended
capability with minor directory-structure disclosure to whatever can reach the API (see finding 6).

---

## Verified-holding (prior hardening confirmed)

- **`spawnCli` / `resolveNpmShim` / `winArgEscape`** (`core/proc.mjs:75-110`): a real `.exe`/binary spawns
  with argv verbatim and **no shell**; a Windows `.cmd`/`.bat` is unwrapped to `node <entry.js>` (no shell,
  no `%*` re-parse); only an un-unwrappable `.cmd` falls back to the shell with double-layer MSVCRT +
  caret escaping. Prompt-derived args therefore never reach a shell parser on the normal path.
- **`spawnCodex`** (`core/proc.mjs:116-122`): `codexCommand()` (`:42-64`) never returns `shell:true` — it
  yields `{command, args}` or `{node, [entry.js]}`, and a broken `.cmd`-only install returns `null` rather
  than shelling out. The `assertShellSafe` branch is dead-code defense-in-depth. Codex `-c` overrides are
  passed as separate argv, not a shell string.
- **Codex model/effort validation** (`core/workers/codex.mjs:26-28`): `model` `^[A-Za-z0-9._\-:\/\[\]]+$`,
  `effort` `^[a-z]+$` — no quotes/spaces/metachars can break out of the `-c model="…"` TOML value (and
  there's no shell anyway).
- **`shellDenied` allow-list** (`core/workers/openai-compat.mjs:19-28`): rejects `& | ; \n \r ` $( < >`
  before running, validates only the first token by extension-insensitive **basename** (never a prefix),
  and rejects `FOO=bar cmd` style prefixes by failing closed. No operator-smuggling bypass found. (Caveat:
  the *default* is `true`, not an allow-list — finding 2.)
- **Static file serving** (`server/index.mjs:237-243`): `resolve(UI, rel)` + `file === UI ||
  file.startsWith(UI + sep)` correctly contains traversal (`..`, absolute) inside `ui/`.
- **CSRF / DNS-rebinding** (`server/index.mjs:250-253`): Host allow-list (`127.0.0.1|localhost|[::1]:port`)
  defeats DNS-rebinding; Origin allow-list + "POST must be `application/json`" (which forces a CORS
  preflight the server never satisfies) blocks cross-site writes; cross-site reads are opaque (no
  `Access-Control-Allow-Origin`). Solid. `/mcp/<session>` is behind the same checks and needs a valid
  session id.
- **`saveConfig` sentinel guard** (`core/config.mjs:129-138`): a `••••` mask round-tripped from the UI is
  dropped for both `providers[*].apiKey` and `mcpServers[*].env[*]`, so redisplay-then-save can't overwrite
  a real secret with the mask.
- **`publicConfig` key/env redaction** (`core/config.mjs:141-148`) and **feedback bundle scoping**
  (`core/feedback.mjs:30-43`, omits `providers`/`mcpServers`) work as intended — subject to findings 4/5.
- **SSE bus** (`core/bus.mjs`): plain ring buffer; carries whatever workers emit (tool output, command
  output) to loopback SSE only. No secret is added by the bus itself; the exposure is whatever a worker
  prints (finding 2), and it stays on the local machine.

---

## Notes / non-issues checked
- `mcpRoute` (`server/index.mjs:40-61`) parses tool args with zod (`d.schema.parse`) and is Host/Origin-gated.
- `openTerminal` (`server/index.mjs:181-198`) writes a `.cmd`/`.command` from **provider-fixed** commands
  (vendors.mjs), not user/HTTP input; `PROVIDERS[seg[2]]` gates the id. No injection from the request.
- `capture()` (`core/providers/vendors.mjs:24-30`) uses the shell only for a Windows `.cmd`/`.bat` with
  `quoteArg`, and its args are fixed probe/model-list flags, not prompts.
- `vendor-cli` passes full `process.env` to subscription CLIs (`workers/vendor-cli.mjs:37`) — expected for
  those trusted first-party agents; same host-access caveat as any agent CLI.
- `findContextFiles` path-containment (`core/context.mjs:19`) prevents out-of-root note disclosure.
