# Tests

Rules: `AGENTS.md`. This file is the brief for work in this folder.

Node's built-in test runner. Run `npm test` from the repository root (it preloads `test/_env.mjs` with `--import`), or one
file / folder: `node --import ./test/_env.mjs --test test/tasks/`, `… test/workers/`.

**Layout mirrors the source folders that have tests:** `test/workers/` (`core/workers/*`), `test/tasks/` (`core/tasks.mjs` and
`core/tasks/`), `test/scorecard/` (`core/scorecard/`, through the facade), `test/limits/` (`core/limits.mjs`), `test/plans/`
(`core/plans.mjs`), `test/smoke/` (`core/smoke/`), `test/server/` (`server/`), `test/ui/` (`ui/`). Each folder has a
`_helpers.mjs` for shared setup (not a test file; it still imports `../_env.mjs` first) and a `CONTEXT.md` saying what each file
covers. Tests for the other flat `core/*.mjs` modules and the cross-cutting ones (`hygiene`, `boundaries`, `git`,
`selection`, `escalation`, `journal`, `size`) stay at the root. Put a new test beside the tests of the folder its module lives in.
`ui-settings.test.mjs` runs the settings renderer and Save handler against a minimal DOM stub: configured values
must reach the form and an unset usage reset must never acquire a guessed hour. Run it with the same `_env.mjs` preload.
`proc.test.mjs` checks shell-free executable/npm-shim spawning, unresolved Windows script refusal in worker and
vendor-probe paths, and Codex environment forwarding. Fixtures live in temporary directories.
`models.test.mjs` exercises overlapping registry refreshes with deferred fake providers; it must never probe live providers.
`feedback.test.mjs` verifies that bundles and written feedback export only safe improvement metadata, including
when messages, sources, kinds and context contain credentials.

`_env.mjs` isolates state (`CONDUCTOR_HOME` = a temp dir, scheduling and polling off) and supplies `HOME` and
`tmpDir()`. Every test file still imports it first (`./_env.mjs` or `../_env.mjs`) — `test/hygiene.test.mjs` fails
otherwise — so a file run on its own is isolated too. Scheduler tests must restore the flags they change. Use temporary
repositories for Git checks and stubs for worker/API calls; never the live state directory or server.
