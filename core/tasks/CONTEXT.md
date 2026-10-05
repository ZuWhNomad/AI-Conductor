# core/tasks/ — stateless parts of the task layer

Rules: `AGENTS.md`. This file is the brief for work in this folder.

**Purpose.** The pieces of the worker-task layer that hold no task state, split out of `../tasks.mjs`. The stateful core
stays in `../tasks.mjs`: the task Map and journal, `createTask`, `schedule()` and the budget gate, `run()` and scoring,
park / failover / wake, `awaitTask`, `recoverTasks`, and the worktree lifecycle that reads or journals tasks
(`prepareIsolation`, `finishIsolation`, `cleanupWorktree`, `listWorktrees`). It cannot move: tests re-import
`tasks.mjs?<query>` for a fresh instance, hook its own `./workers/index.mjs` and `./sweep.mjs` imports, and read its
source. `../tasks.mjs` re-exports `view`, `prompt` and `git`; `brief.mjs` is called from `persist` and is not re-exported.

**The stateful core (`../tasks.mjs`).** `../tasks.mjs` keeps the stateful core and re-exports this folder — the worker-task
journal + scheduler. `schedule()` is the framework budget gate: it admits queued tasks per-window and, over target,
degrades to sequential per provider (never a park-until-reset stall); it also holds queued work while system RAM meets
`resources.maxRamPct` and retries after one unrefed 30-second timer; a real provider limit fails over or parks. `run()`
executes and scores; finished tasks retain budget reservations and probe exclusion until a post-completion limits poll
and scoring settle, without holding worker concurrency slots. Import only loads the journal; server-owned
`recoverTasks()` staggers crash/graceful resumes, keeps future parks, and makes a second crash recovery `stale`
(Re-run or Discard). Graceful stop journals the requeue before aborting. `isolate: true` (delegate / run_plan /
createTask): the scheduler creates `git worktree add --detach` under `statePath('worktrees', <attempt root id>)`
before the worker starts, junctions/symlinks `worker.isolateLinks` (`node_modules`, `.venv`) from the source checkout,
commits onto `conductor/<id>` when the worker ends, and exposes `cleanupWorktree` / `listWorktrees`
(`conductor worktrees [--prune-days N]`). Cleanup unlinks those junctions and verifies every link path is gone before
removal (`git worktree remove --force` follows them on Windows). Ignored (one warning) for a non-git cwd or
`sandbox: 'read-only'`. Follow-ups reuse the dir; `retry_of` gets a new one.

**Entry points.**
- `brief.mjs` — `briefPath`, `syncBrief`. The human-readable brief at `<state>/tasks/<id>.md`.
- `view.mjs` — what a task looks like to readers: `publicTask` (record without the full spec), `taskSummary` (fleet /
  list payload: no paths, diff stat or item tail; 120-char previews), `describeTask` (the conductor-facing text;
  a terminal task names the brief file, and `worker.reportInTool: 'compact'` keeps 12 report lines),
  `countTools` (calls / errors / byName from a worker's items).
- `prompt.mjs` — `buildPrompt(t)`: worker preamble (`policy/prompts/worker.md`) and MSW kernel first, then MCP note,
  project `CONTEXT.md` notes, resume note, task, recipe and capability lines. Recipe and tool lines have separate
  budgets (`worker.recipeChars`, `worker.toolLineChars`); a follow-up gets only the follow-up wrapper.
- `git.mjs` — best-effort async git for the task path: `findGitRoot`, `gitExec`, `gitStatus` (porcelain + content
  fingerprints), `diffStatus`, `gitDiffStat`, `_git` (test surface), `repoSize` (ten-minute cache per cwd); the
  `isolate: true` link plumbing: `isolatedCwd`, `linkIsolateDirs` (junctions / symlinks of `worker.isolateLinks`, kept
  out of commits via `info/exclude`), `unlinkIsolateLinks`; `ageLabel`, `formatWorktrees`.

**Boundaries.** The modules here are leaves: none imports `../tasks.mjs`, and none imports another except
`view.mjs`, which imports `brief.mjs` for the brief path. `../tasks.mjs` imports them and re-exports `view`,
`prompt` and `git`. Outside this folder they import only `paths`, `config`, `proc`, `context`, `improve`, `recipes`,
`capabilities`, `mcp` — nothing from `scorecard`, `sweep`, `limits`, `workers`, `plans`, `tools`, `conductor` or
`server`. Never add module state that must differ between `tasks.mjs` instances: it belongs in `../tasks.mjs`.
Enforced in part by `test/boundaries.test.mjs`.

**Invariants.**
- No synchronous git on the dispatch path; `execFile` is resolved per call so a patched `child_process` reaches it.
- Isolation cleanup unlinks every `isolateLinks` junction and verifies each link path is gone before
  `git worktree remove --force` (which follows junctions on Windows); a surviving link aborts the removal.
- Prompt order: shared, stable text first, task-specific text last (provider prompt caching).
- Views never include the full spec or item list in list payloads; detail endpoints and scoring keep the full record.
- The brief is written once (the spec) and appended once (`## Result` when the task is terminal). `persist` in
  `../tasks.mjs` is the only hook. A later persist does not rewrite earlier text. Everything in the file is redacted.

**How to test.** `node --import ./test/_env.mjs --test test/tasks/*.test.mjs test/journal.test.mjs test/git.test.mjs`.
Full: `npm test`.
