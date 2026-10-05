# ui/modules/ — browser ES modules

Rules: `AGENTS.md`, then `../CONTEXT.md`. No build step. The page loads `../app.js` as a module; these files are imported from it. The server serves them as static `.js`.

**Purpose.** The workbench UI split by the old `app.js` banners. `../app.js` is only boot: it imports these modules, wires DOM handlers, then runs the original boot body (`applyState`, then `connect()`; `resync` runs on a hello gap).

**Entry points.** `../app.js`. `../stt.js` stays put; boot imports `./stt.js`.

**Import order.** Acyclic. A file imports only from earlier files in this list:

1. `core.js` — `$`, `el`, `api` (`ok` stays private), `S`, `authTimers`, `saveProviderView`, `asBtn`, `showStatus`, `act`, `openModal`, `closeModal`. `loadProviderView()` runs on load. `newSessionPromise` is not here: `sessions.js` reassigns that binding.
2. `markdown.js` — `esc`, `md`
3. `budget.js` — `meterClass`, `windowScope`, `renderBudget`
4. `chip.js` — `renderChip`
5. `picker.js` — `ALL`, `composite`, `resolveOther`, `pickerValue`, `fillPicker`, `savedSelection`, `refreshNewPicker`, `refreshHeaderPicker`
6. `sidebar.js` — `renderProviders`
7. `transcript.js` — transcript DOM helpers (`T`, `addUser`, `addSys`, `renderHistory`, and the rest of the message builders)
8. `fleet.js` — fleet cards except `updateTask` (`renderTasks`, `taskCard`, `renderFleetHead`, `terminalTask`, `refreshRunningCards`, `lastAction`)
9. `update.js` — `renderUpdate`, `noteUpdate`
10. `sessions.js` — session actions, plus `renderSessions`, `renameSession`, `updateTask`, `onSessionEvent`
11. `sse.js` — `applyState`, `applyAutoRefresh`, `seedNewChatDefaults`, `connect`, `refreshImprovements`
12. `misc.js` — `quitServer`, `toggleModelPop`, `openSystem`, `revealProviders`, `openScores`
13. `modals.js` — `browse`, `openSettings`, `openImprovements`, `runReview`
14. `../app.js` — boot only

**Why a few functions left their banner.** `renderSessions` calls `openSession`, which calls `onSessionEvent`, which calls `clearCurrent`, which calls `renderSessions`. Those four live in `sessions.js`. `updateTask` calls `renderSessions` and the fleet helpers, so it lives in `sessions.js` too. `refreshImprovements` lives in `sse.js` so modals can import SSE without SSE importing modals. `openModal` / `closeModal` live in `core.js` so fleet and misc do not import modals. `meterClass` lives in `budget.js` next to `windowScope`; sidebar imports it back. `newSessionPromise` stays in `sessions.js` because an imported binding cannot be reassigned.

**Invariants.** One `S` object, imported, never copied. Call sites stay bare names. DOM is still built with `el` / `textContent`; assistant HTML still goes through `md`.

**How to test.** `npm test`, which includes `test/ui/imports.test.mjs`: every relative import resolves to a `.js` file, the import graph is acyclic, and a name declared at top level in another module is imported here. `node --check` on each file. `npm run check` does not cover `ui/` (`tsconfig.json` includes `core/`, `server/`, `bin/`, and `test/` only). Do not start the workbench server on port 47480.
