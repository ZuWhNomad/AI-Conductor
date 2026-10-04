# core/tasks/ — stateless parts of the task layer

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** The pieces of the worker-task layer that hold no task state, split out of `../tasks.mjs`. The stateful core
stays in `../tasks.mjs`: the task Map and journal, `createTask`, `schedule()` and the budget gate, `run()` and scoring,
park / failover / wake, `awaitTask`, `recoverTasks`, and the worktree lifecycle that reads or journals tasks
(`prepareIsolation`, `finishIsolation`, `cleanupWorktree`, `listWorktrees`). It cannot move: tests re-import
`tasks.mjs?<query>` for a fresh instance, hook its own `./workers/index.mjs` and `./sweep.mjs` imports, and read its
source. `../tasks.mjs` re-exports all three modules here, so callers keep importing `tasks.mjs`.

**Entry points.**
- `view.mjs` — what a task looks like to readers: `publicTask` (record without the full spec), `taskSummary` (fleet /
  list payload: no paths, diff stat or item tail; 120-char previews), `describeTask` (the conductor-facing text),
  `countTools` (calls / errors / byName from a worker's items).
- `prompt.mjs` — `buildPrompt(t)`: worker preamble (`policy/prompts/worker.md`) and MSW kernel first, then MCP note,
  project `CONTEXT.md` notes, resume note, task, recipe and capability lines. Recipe and tool lines have separate
  budgets (`worker.recipeChars`, `worker.toolLineChars`); a follow-up gets only the follow-up wrapper.
- `git.mjs` — best-effort async git for the task path: `findGitRoot`, `gitExec`, `gitStatus` (porcelain + content
  fingerprints), `diffStatus`, `gitDiffStat`, `_git` (test surface), `repoSize` (ten-minute cache per cwd); the
  `isolate: true` link plumbing: `isolatedCwd`, `linkIsolateDirs` (junctions / symlinks of `worker.isolateLinks`, kept
  out of commits via `info/exclude`), `unlinkIsolateLinks`; `ageLabel`, `formatWorktrees`.

**Boundaries.** The three modules are leaves: none imports another, and none imports `../tasks.mjs`; `../tasks.mjs`
imports all three. Outside this folder they import only `paths`, `config`, `proc`, `context`, `improve`, `recipes`,
`capabilities`, `mcp` — nothing from `scorecard`, `sweep`, `limits`, `workers`, `plans`, `tools`, `conductor` or
`server`. Never add module state that must differ between `tasks.mjs` instances: it belongs in `../tasks.mjs`.
Enforced in part by `test/boundaries.test.mjs`.

**Invariants.**
- No synchronous git on the dispatch path; `execFile` is resolved per call so a patched `child_process` reaches it.
- Isolation cleanup unlinks every `isolateLinks` junction and verifies each link path is gone before
  `git worktree remove --force` (which follows junctions on Windows); a surviving link aborts the removal.
- Prompt order: shared, stable text first, task-specific text last (provider prompt caching).
- Views never include the full spec or item list in list payloads; detail endpoints and scoring keep the full record.

**How to test.** `node --import ./test/_env.mjs --test test/tasks.test.mjs test/journal.test.mjs test/git.test.mjs`.
Full: `npm test`.
