# ui/ — the browser app

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** The workbench UI: vanilla HTML/JS/CSS served as static files by `server/index.mjs`. No framework, no build
step, no bundler; edits are live on the next page reload.

**Files.** `index.html` (layout: `#sidebar`, `#main`, `#fleet`, modals), `app.js` (boot only), `modules/` (one file per
former section; see `modules/CONTEXT.md`), `stt.js` (speech-to-text via the Web Speech API: `createSTT`,
`insertAtCaret`), `styles.css`.

**`app.js` index.** Banners remain (`// ---------- <name> ----------`); each banner lives in the file below.
`modules/CONTEXT.md` lists exports and the few functions that moved so the import graph stays acyclic.

| banner | file |
|---|---|
| (top, no banner) | `modules/core.js` — `$`, `el`, `api`, `S`; also `openModal` / `closeModal` |
| `markdown-lite` | `modules/markdown.js` |
| `rendering: sidebar` | `modules/sidebar.js` — `renderProviders`. Chat list is `modules/sessions.js`; `meterClass` is `modules/budget.js` |
| `budget headline` | `modules/budget.js` |
| `model chip (header)` | `modules/chip.js` |
| `conductor picker: provider : model : effort` | `modules/picker.js` |
| `rendering: transcript` | `modules/transcript.js` |
| `fleet dock` | `modules/fleet.js` — `updateTask` is `modules/sessions.js` |
| `sessions` | `modules/sessions.js` — also `renderSessions`, `renameSession`, `updateTask`, `onSessionEvent` |
| `update affordance` | `modules/update.js` |
| `SSE` | `modules/sse.js` — also `refreshImprovements`. `onSessionEvent` is `modules/sessions.js` |
| `modals` | `modules/modals.js` — `openModal` / `closeModal` are `modules/core.js` |
| `quit / misc` | `modules/misc.js` |
| `boot` | `app.js` |

**Boundaries.** Browser code: imports only its own files (`./stt.js`, `./modules/*.js`) and talks to `server/` over HTTP + SSE. No
`core/` import can work here, so none is attempted.

**Invariants.**
- All state lives in one `S` object, exported from `modules/core.js` and imported by the other modules (never copied).
  Cross-section calls are explicit imports. The graph is acyclic; see `modules/CONTEXT.md`.
- Data arrives two ways only: `api.get/post/del` (JSON, throws on a non-2xx with the server's `error`) and the SSE
  stream `/api/events`. A changed `boot` id or a replay gap (`hello.oldest > lastSeq + 1` for a nonzero cursor)
  triggers `resync()`, including the improvement count, then reconnects.
  Bursts of `models` / `limits` / `settings` / `improvement` events are coalesced into one refetch.
- Build DOM with `el()` and `textContent`; model/worker text goes through `md()` (which escapes first). Never assign
  unescaped text to `innerHTML`.
- Queued user bubbles come from `queued` events or `m.queued` history records; `dequeued` drops their controls, while queue
  removal deletes the bubble.
- Files stay `.js`: the server's MIME map has no `.mjs`.
- Every `id` that `app.js` or `modules/*.js` looks up with `$('#…')` must exist in `index.html`.

**How to test.** `npm test` covers serving (`test/server/server.test.mjs`: `/` and `/app.js`), settings rendering and
saving with a DOM stub (`test/ui-settings.test.mjs`), and browser regressions (`test/ui/layout.test.mjs`: responsive
geometry, quit icon, budget freshness and emphasis). Browser cases use a local Edge/Chrome installation or
`CONDUCTOR_TEST_BROWSER`; they explicitly skip when no browser is available. For a UI change: `node bin/conductor.mjs`,
reload the page, exercise the changed section, and check the browser console.
