---
name: conductor
description: Delegate work to Conductor 2.0 — create autonomous conductor chats, hand them a task brief, and monitor them over its local HTTP API. Use when the user says to use/drive the conductor, delegate, fan out, or hand a job off to a worker.
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
