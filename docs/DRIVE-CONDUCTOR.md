# Driving Conductor 2.0 from a Claude Code or Codex session

This is a portable playbook for an **external AI coding session** (Claude Code, Codex, or any agent
that can run shell commands and make HTTP requests) to **drive Conductor 2.0** — create autonomous
conductor chats, hand them a task, and monitor them — without opening the browser UI.

**No hardcoded paths.** Everything below discovers the server URL, the state directory, and the
working directories at runtime. It works on Windows, macOS, and Linux.

---

## 1. Confirm the server is up and find its URL

Conductor 2.0 binds to `127.0.0.1` on a fixed port. Discover the URL in this order:

1. **Read the PID file** (authoritative — it records the live `url` and `port`):
   - State dir = `$CONDUCTOR_HOME` if set, else `<repo>/.state` if that folder exists, else `~/.conductor2`
     (Windows: `%USERPROFILE%\.conductor2`).
   - File: `<state-dir>/server.pid` → JSON `{ "pid", "port", "url", "startedAt" }`. Use its `url`.
2. **Fallback probe:** if the PID file is missing, try `http://127.0.0.1:47474` (the default port).
3. **Verify** with `GET /api/state` (see below). If it answers, you have the right base URL.

If nothing answers, the server isn't running — start it from the Conductor repo with `conductor`
(or `node bin/conductor.mjs`) and re-check. Do not assume a port; always confirm via `/api/state`.

```bash
# POSIX shell example — run from the Conductor repo root
BASE=$(node -e '
const fs = require("node:fs"), { join } = require("node:path"), { homedir } = require("node:os");
const local = join(process.cwd(), ".state");
const state = process.env.CONDUCTOR_HOME || (fs.existsSync(local) ? local : join(homedir(), ".conductor2"));
const path = join(state, "server.pid");
try { console.log(JSON.parse(fs.readFileSync(path, "utf8")).url); }
catch { console.log("http://127.0.0.1:47474"); }
')
curl -s "$BASE/api/state" >/dev/null && echo "up: $BASE" || echo "not running"
```

---

## 2. Orient: what models, providers, and folders exist

`GET /api/state` returns everything you need to make choices — no guessing:
- `.version`, `.config` (redacted), `.providers` (summary array), `.models` (with `.providers[<id>].status` per vendor)
- `.sessions` (existing chats), `.tasks` (recent worker tasks)
- `.home` and `.repoRoot` (safe candidate working directories)

Model list also at `GET /api/models` (`POST /api/models/refresh` to re-poll). Each model has
`{ provider, id, kind:'agent', efforts:[...] }`. Build a **selection string** `provider:model:effort`
(e.g. `claude:claude-opus-4-8:max`, `codex:gpt-5.2:high`). Only pick a model whose provider shows
`status:'ok'` (logged in) in `.models.providers[<id>].status`.

---

## 3. Create a conductor session (chat)

`POST /api/sessions` with a JSON body. Fields (all optional except `cwd`):

| field | meaning |
|---|---|
| `cwd` | **required** — an existing directory the conductor works in (the project). Get candidates from `/api/state.home` / `.repoRoot`, or ask the user. |
| `provider` | `claude` \| `codex` \| `ollama` \| … (from `.providers`). Omit to use the configured default. |
| `model` | a model id from `/api/models`, or omit / `default`. |
| `effort` | one of the model's `efforts` (e.g. `low`,`medium`,`high`,`xhigh`,`max`), or omit. |
| `permissionMode` | `default` \| `acceptEdits` \| `bypassPermissions` \| `plan` \| `dontAsk` \| `auto`. **`bypassPermissions` = full autonomy** (the UI's "auto-approve"). |
| `title` | short label shown in the UI. |

Returns the session object, including its `id`. (You can also pass `provider`/`model`/`effort`
separately as above, or a single `model` selection string.)

```bash
SID=$(curl -s -X POST "$BASE/api/sessions" -H 'content-type: application/json' \
  -d '{"cwd":"<PROJECT_DIR>","provider":"claude","model":"claude-opus-4-8","effort":"max","permissionMode":"bypassPermissions","title":"My task"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).id))")
```

> `cwd` must already exist or the call returns HTTP 400. Substitute a real directory for
> `<PROJECT_DIR>` at runtime — never bake an absolute path into a reusable script.

---

## 4. Send the task

`POST /api/sessions/:id/messages` with `{ "text": "<the full task prompt>" }`. **Returns
immediately** — the turn runs inside the long-lived server process, so it keeps going after your
request returns and survives your own session ending.

```bash
curl -s -X POST "$BASE/api/sessions/$SID/messages" -H 'content-type: application/json' \
  -d "$(node -e "console.log(JSON.stringify({text: require('fs').readFileSync(process.argv[1],'utf8')}))" <PROMPT_FILE>)" >/dev/null
```

Write long prompts to a file and load them like this — it avoids shell-quoting damage. Give the
conductor a self-contained brief (context, phased steps, "commit after each phase", a final-report
request); it can then do the work itself or delegate to budget-scored worker sub-tasks.

---

## 5. Monitor and relay

- **Poll:** `GET /api/sessions/:id` → `{ status:'idle'|'running', messages:[...], costUsd, sdkSessionId }`.
  The turn is done when `status` returns to `idle` (in `bypassPermissions` there are no permission
  stalls). `costUsd` is 0 on subscription plans.
- **Live stream:** `GET /api/events?since=<seq>` is a Server-Sent-Events feed of all activity
  (`user`, `assistant`, tool results, `status`, `init`). Reconnect with the last `seq` you saw.

```bash
# one-shot status
curl -s "$BASE/api/sessions/$SID" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.status, (j.messages||[]).length+' msgs')})"
```

---

## 6. Controls (all `POST /api/sessions/:id/...`)

| path | body | effect |
|---|---|---|
| `/interrupt` | — | interrupt the current turn |
| `/stop` | — | stop the session process |
| `/model` | `{model}` | switch model live |
| `/effort` | `{effort}` | change effort (restarts the process, resumes the session) |
| `/mode` | `{permissionMode}` | change permission mode |
| `/permission` | `{requestId, allow, message}` | answer a permission prompt (only when **not** in bypass) |
| `/title` | `{title}` | rename |
| `/overflow` | `{overflowApi}` | allow paid-API overflow when subscription classes are capped |
| `/parallel` | `{parallelOverride}` | run this chat's workers in parallel: skip the budget gate (real provider limits still apply) |

`DELETE /api/sessions/:id` removes a chat.

## 7. Direct drive: be the conductor yourself

Instead of briefing a conductor chat, your own session can **be** the conductor: it calls the same workbench tools a
Codex conductor uses (`delegate`, `follow_up`, `await_task`, `rate_task`, `run_plan`, `plan_status`, `list_models`,
`limits`, `model_scores`, `log_improvement`, …) over the MCP endpoint. No conductor turn runs, so no conductor tokens
are spent, and every task still goes through the scorecard auto-pick, limit failover and rating.

1. **Get a session id for the project.** Tools run in a session's `cwd`, so keep one session per project, created
   with `POST /api/sessions` `{cwd, title}` and **never sent a message** (it never starts a model). Reuse it: look it up
   by `title` in `/api/state` `.sessions`.
2. **Call the tools** with JSON-RPC `tools/call` at `POST /mcp/<sessionId>` (`content-type: application/json`).
   The JSON-RPC method `tools/list` returns every schema. The reply text is in `result.content[0].text`;
   `result.isError` flags a failure.

   Client: `share/claude-skill/conductor/mcp.py` (stdlib Python; run it in place):
   `python mcp.py <base-url> <sessionId> <tool> '<json args>'` (or `@args.json` for long specs — no hand-quoted
   Windows paths), and `python mcp.py <base-url> <sessionId> tools/list` for every tool's schema.

   Claude Code can also mount the endpoint as a native MCP server for one run:
   `claude -p … --mcp-config <file>` with `{"mcpServers":{"conductor":{"type":"http","url":"<base>/mcp/<sessionId>"}}}`.
3. **Follow the conductor's own policy**, not your habits: `core/policy/prompts/conductor.md` (economics, delegation
   protocol, fix-round → escalation ladder, rating) and `core/policy/prompts/orchestration.md` (fan-out, refuters,
   judge panels, until-dry, critic — one `run_plan` per job, the shapes as its stages). In short:
   - `delegate` with `title`, `spec`, `category` and `difficulty`, and **no** provider/model: the scorecard picks.
     Pin a model only with a reason.
   - Verify the diff yourself; `follow_up` for fix rounds; to escalate, `delegate` with `retry_of` set to the **last
     follow-up task's id** (its spent rounds trip the escalation); `rate_task` the original task id.
   - A report saying `failed over to task <id>` means await that id.
   - `avoid_families` takes model families — `claude`, `gpt` (Codex/OpenAI), `grok`, `gemini`, `deepseek`, `kimi`,
     `qwen` — not provider ids; an unknown name is silently ignored.
   - Parallel tasks share the `cwd`: fan out read-only work, keep editors sequential (or give each a worktree via
     `writable_roots`).
   - Report workbench faults with `log_improvement`.
4. **Wait cheaply.** `delegate` and `follow_up` (without `background: true`) and `await_task` block until the task
   ends or about an hour passes; a reply ending `(still running — call await_task)` is not final, so call `await_task`
   again. `run_plan` likewise answers "still running" — then call `plan_status`. Run these calls in the background of
   your own harness and read one compact report, instead of polling `/api/tasks`.

**Raw tasks.** `POST /api/tasks` `{cwd, spec, title?, provider?, model?, effort?, sandbox?, category?, difficulty?}`
queues one task with **no** auto-pick (it falls back to the configured default worker) and no rating path. Track it with
`GET /api/tasks/:id` (the report is `result.finalMessage`; `changedFiles`, `diffStat`; statuses `queued`, `running`,
`parked`, `done`, `failed`, `canceled`) and cancel with `POST /api/tasks/:id/cancel`. Prefer the tools above.

## Optional: a `/conductor` skill for Claude Code

So that any Claude Code session can drive Conductor — as the conductor itself (§7), through its own subagents, or by
briefing a conductor chat — and knows to use this document, install the bundled skill into
your Claude Code skills folder. It is a template in `share/claude-skill/conductor/SKILL.md`; the command fills in your
Conductor folder. Run it **from the Conductor folder** (it overwrites an existing `conductor` skill — back that up first):

```powershell
# Windows (PowerShell)
$d=(Get-Location).Path; $t="$HOME\.claude\skills\conductor"; New-Item -ItemType Directory -Force $t | Out-Null; (Get-Content share\claude-skill\conductor\SKILL.md -Raw).Replace('{{CONDUCTOR_DIR}}',$d) | Set-Content "$t\SKILL.md" -Encoding UTF8
```

```bash
# macOS / Linux
mkdir -p ~/.claude/skills/conductor && sed "s|{{CONDUCTOR_DIR}}|$PWD|g" share/claude-skill/conductor/SKILL.md > ~/.claude/skills/conductor/SKILL.md
```

New Claude Code sessions then list `conductor` in their skills and invoke it when you say "use the conductor" /
"delegate this". Nothing else to install: the skill runs the `mcp.py` client from your Conductor folder.
Add your own defaults to the installed copy (preferred conductor model, where your briefs or project notes live) —
the template stays machine-neutral on purpose. To remove it, delete the `conductor` skill folder.

## Notes

- State lives under `~/.conductor2` (override with `CONDUCTOR_HOME`, or by creating `.state/` in the checkout). The server listens only on
  `127.0.0.1`.
- The `claude` provider runs via the Claude Agent SDK and needs `claude` to be logged in; check
  `/api/state.models.providers.claude.status === 'ok'` first (same for `codex`).
- Prefer discovery (`/api/state`, `/api/models`, the PID file) over constants so the same script
  runs on any machine.
- Before a long driven job: `POST /api/settings {"conductor":{"autoUpdate":"off"}}` (live, no restart), and turn it back on
  afterwards. An automatic update restarts the server only when it has been idle *and quiet* for
  `conductor.updateQuietMinutes` (default 15), but a job that pauses longer than that between passes would still be
  interrupted.
- Changing Conductor itself: never edit the checkout that is running your session (a restart would kill it).
  Run one checkout as the engine and edit a second one; give the second its own state dir (create `.state/` in it,
  with a `config.json` that sets another `port`), because two servers on one state dir run every task twice.
