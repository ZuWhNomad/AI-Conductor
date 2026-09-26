---
name: conductor
description: Orchestrate work through Conductor 2.0 — become the conductor yourself and route each unit of work to its multi-provider workers (delegate / run_plan with scorecard auto-pick), to your own subagents, or to an autonomous conductor chat, following Conductor's delegation framework. Use when the user says to use/drive the conductor, delegate, fan out, or hand a job off to a worker.
---

# conductor (Conductor 2.0)

Conductor 2.0 is installed in `{{CONDUCTOR_DIR}}`. It runs a local server on `127.0.0.1`.

- **Find the server:** read `server.pid` in the state folder — `$CONDUCTOR_HOME` if set, else `~/.conductor2/`
  (Windows: `%USERPROFILE%\.conductor2\`) — and use its `url`; default `http://127.0.0.1:47474`. Verify with
  `GET /api/state`. If nothing answers, start Conductor (Windows: double-click / run `{{CONDUCTOR_DIR}}\Conductor.exe`;
  elsewhere: `node bin/conductor.mjs start` in that folder) and check again. Start it detached from your own session
  (e.g. via the desktop shell), so it doesn't stop when your session ends.
- **Follow `{{CONDUCTOR_DIR}}/docs/DRIVE-CONDUCTOR.md`** for the API: create a session, send the task, monitor it,
  controls, direct-to-worker tasks. Read it before the first call in a session.
- **Pick a model the user has signed in to:** `/api/state` → `models.providers.<id>.status == "ok"`; the selection is
  `provider:model:effort` from `/api/models`. Use the user's preferred defaults if they've told you any.

## You are the conductor

Follow Conductor's framework, not your own habits: read `{{CONDUCTOR_DIR}}/core/policy/prompts/conductor.md`
(economics, delegation protocol, fix-round → escalation ladder, rating) and `orchestration.md` beside it once per
session. Keep intent, decomposition, specs, review and final verification; send execution out. Route each unit of work:

- **Workers** (default) — execution, research, multi-provider fan-out, cross-family verification: **direct drive**
  (`DRIVE-CONDUCTOR.md` §7). One never-messaged session per project gives you the conductor's tools (`delegate`,
  `run_plan`, `follow_up`, `rate_task`, …) over `/mcp/<sessionId>`, called with
  `python {{CONDUCTOR_DIR}}/share/claude-skill/conductor/mcp.py`.
  `delegate` with `category` + `difficulty` and no model so the scorecard picks; verify with a different model family
  than the producer (`avoid_families` takes families such as `claude`, `gpt`, `grok`, `gemini` — not provider ids);
  escalate with `retry_of` = the last follow-up's id; `rate_task` every task.
- **Your own subagents** — work that needs your session's own tools or context.
- **A conductor chat** — a long autonomous job you won't supervise (below).

## Practical notes
- Make the HTTP calls from a script (Python `urllib`, Node `fetch`) rather than hand-written `curl` JSON — Windows
  backslash paths break hand-written JSON. Write each brief to a file and send its contents as `{"text": ...}`, or
  send a short message pointing the chat at the brief's path.
- Briefs must be self-contained: context, hard scope limits (what it may and may not touch), verification, and a
  final-report request. The conductor runs in its own process and survives your session.
- Poll `GET /api/sessions/<id>` until `status` is `idle`; to redirect a running chat, `POST .../interrupt` then send a
  new message. A chat that goes idle while waiting on its own background run is not woken automatically — send it a
  check-in message.
- Shut the server down cleanly with `POST /api/shutdown` and a JSON body (`content-type: application/json`, `{}`);
  in-flight worker tasks requeue and resume on the next start.
