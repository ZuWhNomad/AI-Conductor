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
   - State dir = `$CONDUCTOR_HOME` if set, else `~/.conductor2` (Windows: `%USERPROFILE%\.conductor2`).
   - File: `<state-dir>/server.pid` → JSON `{ "pid", "port", "url", "startedAt" }`. Use its `url`.
2. **Fallback probe:** if the PID file is missing, try `http://127.0.0.1:47474` (the default port).
3. **Verify** with `GET /api/state` (see below). If it answers, you have the right base URL.

If nothing answers, the server isn't running — start it from the Conductor repo with `conductor`
(or `node bin/conductor.mjs`) and re-check. Do not assume a port; always confirm via `/api/state`.

```bash
# POSIX shell example — resolve BASE without hardcoding
STATE="${CONDUCTOR_HOME:-$HOME/.conductor2}"
BASE=$(node -e "try{console.log(require('$STATE/server.pid').url)}catch{console.log('http://127.0.0.1:47474')}")
curl -s "$BASE/api/state" >/dev/null && echo "up: $BASE" || echo "not running"
```

---

## 2. Orient: what models, providers, and folders exist

`GET /api/state` returns everything you need to make choices — no guessing:
- `.version`, `.config` (redacted), `.providers` (login status per vendor), `.models`
- `.sessions` (existing chats), `.tasks` (recent worker tasks)
- `.home` and `.repoRoot` (safe candidate working directories)

Model list also at `GET /api/models` (`POST /api/models/refresh` to re-poll). Each model has
`{ provider, id, kind:'agent', efforts:[...] }`. Build a **selection string** `provider:model:effort`
(e.g. `claude:claude-opus-4-8:max`, `codex:gpt-5.2:high`). Only pick a model whose provider shows
`status:'ok'` (logged in) in `.providers`.

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

`DELETE /api/sessions/:id` removes a chat.

## Direct-to-worker shortcut (no conductor tokens)

`POST /api/tasks` `{ cwd, spec, provider?, model?, effort? }` queues a single worker task straight
to the budget-gated scheduler, bypassing a conductor chat. Track it with `GET /api/tasks/:id`;
cancel with `POST /api/tasks/:id/cancel`.

## Notes

- State lives under `~/.conductor2` (override with `CONDUCTOR_HOME`). The server listens only on
  `127.0.0.1`.
- The `claude` provider runs via the Claude Agent SDK and needs `claude` to be logged in; check
  `/api/state.providers.claude.status === 'ok'` first (same for `codex`).
- Prefer discovery (`/api/state`, `/api/models`, the PID file) over constants so the same script
  runs on any machine.
