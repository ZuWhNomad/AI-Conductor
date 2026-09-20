# ui/ — the browser app

**Purpose.** The workbench UI: vanilla HTML/JS/CSS served as static files by `server/index.mjs`. No framework, no build
step, no bundler; edits are live on the next page reload.

**Files.** `index.html` (layout: `#sidebar`, `#main`, `#fleet`, modals), `app.js` (everything below), `stt.js`
(speech-to-text via the Web Speech API: `createSTT`, `insertAtCaret`), `styles.css`.

**`app.js` index.** One file, 13 sections; each starts with a banner `// ---------- <name> ----------`. Grep the
banner and read only that section.

| banner | what is in it |
|---|---|
| (top, no banner) | `$`, `el`, the `api` fetch helper, the single state object `S` |
| `markdown-lite` | `esc`, `md`: the tiny markdown renderer for assistant text |
| `rendering: sidebar` | chat list (`renderSessions`, rename), **Providers & limits** panel (`renderProviders`, meters) |
| `budget headline` | the Budget block: which window applies to the selected conductor (`windowScope`, `planWindow`, `renderBudget`) |
| `model chip (header)` | `renderChip`: the header chip showing the conductor model |
| `conductor picker: provider : model : effort` | the three linked selects, for New chat and for the header popover (`fillPicker`, `refreshNewPicker`, `refreshHeaderPicker`, `savedSelection`) |
| `rendering: transcript` | chat messages: streaming deltas, tool calls/results, permission prompts, history replay |
| `fleet dock` | worker task cards on the right (`renderTasks`, `taskCard`, `updateTask`, `openTask`) |
| `sessions` | open / create a chat, status pill, `send` (also the `/worker …` direct-to-worker shortcut) |
| `update affordance` | `renderUpdate`: the flashing **⬇ Update** button |
| `SSE` | `resync` (full refetch of `/api/state`), `connect` (EventSource, one handler per event type), `onSessionEvent` |
| `modals` | `openModal`, folder browser, Settings, Improvements log, run review |
| `quit / misc` | Quit button, model popover, SYSTEM drawer, scores modal |
| `boot` | wires every DOM event handler, then `resync()` + `connect()` |

**Invariants.**
- All state lives in `S`; render functions read `S` and rebuild their DOM. Sections call each other freely (there are
  ~80 cross-section references), which is why the file is not split yet.
- Data arrives two ways only: `api.get/post/del` (JSON, throws on a non-2xx with the server's `error`) and the SSE
  stream `/api/events`. A changed `boot` id in the `hello` event means the server restarted: `resync()`, then reconnect.
  Bursts of `models` / `limits` / `settings` / `improvement` events are coalesced into one refetch.
- Build DOM with `el()` and `textContent`; model/worker text goes through `md()` (which escapes first). Never assign
  unescaped text to `innerHTML`.
- Files stay `.js`: the server's MIME map has no `.mjs`.
- Every `id` that `app.js` looks up with `$('#…')` must exist in `index.html`.

**How to test.** There are no UI unit tests. `npm test` covers serving (`test/server/server.test.mjs`: `/` and `/app.js`).
For a UI change: `node bin/conductor.mjs`, reload the page, exercise the changed section, and check the browser console.
