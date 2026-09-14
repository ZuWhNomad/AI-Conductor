# Conductor 2.0 — improvements, iteration 2 (NEXT batch, NOT the current pass)

**Status:** capture-only, for the *next* conductor-edits iteration. The current in-flight pass is
`docs/CONDUCTOR-IMPROVEMENTS.md`. New conductor UI/logic comments from the user land **here** until
we start iteration 2.

---

## 1. Providers panel: consistent, dynamic usage-bar ordering

**Goal:** in the "Providers & Limits" block, order each provider's usage bars the same way so a user
can scan them at a glance — **session limit at the top, weekly limit at the bottom**:

1. **Top — 5-hour / session limit** (the current rolling session window)
2. **Middle — model-specific limits** (per-model or per-model-group windows)
3. **Bottom — weekly limit** (the long-horizon window)

**Must be fully dynamic — render only the buckets a provider actually reports, in this fixed order:**
- **Codex (Pro):** session (5-hour) bar on top, general **weekly** bar on the bottom.
- **Codex (Plus):** shows both the **5-hour** and the **weekly** bar (plan-dependent — don't
  hardcode which windows exist; derive from what the provider reports).
- **Grok:** only a weekly limit exists → show **only** the weekly bar (no empty session/model slots).
- Any future provider, however it exposes limits, slots into the same top→bottom order automatically.

**Implementation notes**
- Drive ordering from **data, not label string-guessing.** Tag each usage window with a
  `scope`/`cadence` at the source — `session` (≈5h) | `model` | `weekly` | `other` — in
  `core/limits.mjs` (and each provider's `limits()` in `core/providers/*` / `vendors.mjs`), and
  where estimates are synthesized in `server/index.mjs` `limitsWithEstimates()`. Each window already
  carries `{ id, label, usedPercent, resetsAt, estimated, note }`; add the `scope` tag.
- In the UI (`ui/` provider-render code + `ui/styles.css`, `#providers` block), sort each provider's
  windows by a fixed `scope` order (session → model → weekly → other) and render only present ones.
  Missing buckets collapse (no blank rows), so a weekly-only provider shows a single bar.
- Keep it resilient: an unknown/untagged window falls to `other` (rendered last) rather than being
  dropped, so a new provider's limits still appear even before we tag them.

## 2. Scorecard: per-model error/hallucination rate → correction-cost penalty

> **Status — logging DONE (2026-09-13 pass).** Live worker runs now train the scorecard, and
> "phantom work" is auto-detected and recorded as a distinct `phantom` verdict. The correction-cost
> *penalty math* in `recommend()` is still deferred (the fields are wired for it). See
> _Implemented — 2026-09-13 pass_ at the bottom.

**Idea (user):** track each model's error/hallucination rate and fold a **correction cost** into
scorecard selection — the **inverse of the use-it-or-lose-it discount**. Where the waste discount
*lowers* a model's effective cost as its subscription window nears reset, the error penalty *raises*
effective cost by the expected reviewer+redo cost of fixing that model's bad output.

**Mechanism sketch**
- `effective_cost ≈ base_cost − wasteDiscount + errorPenalty`, where
  `errorPenalty ≈ error_rate × E[correction cost]` (reviewer tokens to catch + follow-up/worker
  tokens to redo), expressed in the same $/utility units `recommend()` already uses
  (`utility = value-of-quality − cost`, `qualityValueUsd`). Error-prone models deprioritize
  automatically — the mirror image of the reset discount.
- **Log the correction cost per incident** so the penalty is measured, not guessed.
- **Track error rate** per model id **and** rolled up to provider/family (see evidence — the pattern
  spans variants). Open question: keep error rate separate from the quality score, or fold in.

**Observed failure mode = "phantom work / unverified completion":** the worker *reports* a
diff/file-write as done that never hit disk. Caught by verifying the output actually landed
(`git status` / re-read), not by content plausibility. Suggest the harness **auto-verify
worker-reported writes** and record a distinct verdict when they didn't persist.

**Evidence (2 incidents — same provider+family, different ids):**
1. `antigravity:gemini-3.8-flash-low` (first OCR pass, Phase 4B): claimed it updated
   `docs/BENCHMARK.md`; it hadn't — the conductor rewrote it.
2. `antigravity:gemini-3.7-flash-medium` (OCR bug-fix pass, UI worker): reported a correct UI diff
   that never persisted; caught via `git status`, redone by hand, re-rated fail.

**Anchors:** `core/scorecard.mjs` (`recommend`, `wasteDiscount`, `providerWindows`,
`qualityValueUsd`); the attempts ledger / verdicts (pass/fail); `core/tasks.mjs` (rounds /
follow-up = the correction signal). Needs a place to record "reported-but-not-persisted" as its own
verdict.

**Open:** how to attribute correction cost (reviewer + redo-worker + conductor time); whether an
error *caught in review* counts fully (quality held, but cost rose) or partially.

## 3. Framework: multi-session orchestration + workspace isolation (routing)

**Idea (user):** let the external orchestrator **and the conductor itself** kick off additional
conductor sessions for split/parallel task management, so N unrelated requests each get their own
correctly-targeted session (correct `cwd`/workspace) — reducing cross-task contamination errors.
"Coming up with a proper framework for this may need some work."

**Problem evidence (cross-workspace bleed):**
- The two-conductor confusion (`D:\claude-conductor` vs `F:\Conductor 2.0`) and a job queued into the
  wrong system.
- OCR worker **strays writing into the wrong folder** (Phase 4A log: "Removed concurrent-worker
  strays `app/docs/BENCHMARK.md`, `app/samples/test_make_*.pdf`"). When a task's `cwd`/scope isn't
  pinned, files land in the wrong project.

**Requirements / design considerations:**
- **Session-per-workspace routing:** classify each incoming request → route to (or create) a session
  bound to the correct project `cwd`. Keep a registry of active sessions keyed by workspace.
- **Path isolation:** a session/worker must not write outside its task `cwd` (sandbox / path
  allow-list). Surfaces already exist: `createSession({cwd})`, `createTask({cwd, paths, sandbox})`.
- **Conductor-spawned sessions:** the conductor already spawns worker *tasks*; extend it to spawn or
  target *sessions* (or clearly-scoped task groups) for unrelated sub-threads.
- **Concurrency:** many sessions across workspaces run in parallel; ensure the budget-gated scheduler
  accounts for cross-session parallelism (not just per-provider caps).
- The HTTP API already supports one-session-per-project (`POST /api/sessions` per `cwd`; the external
  playbook `docs/DRIVE-CONDUCTOR.md` does this). Formalize it, let the conductor do it too, and add
  routing/classification + path isolation to prevent the bleed.

**Open:** when the conductor spawns a new *session* vs a *worker task*; how to present/track many
parallel sessions in the UI; guardrails so a session can't touch another project's files.

**Anchors:** `server/index.mjs` (`/api/sessions`, `/api/tasks`), `core/conductor.mjs`
(`createSession`), `core/tasks.mjs` (`createTask` `cwd`/`paths`/`sandbox`), `core/workers/*`,
`core/tools.mjs`, `core/session-flags.mjs`, `docs/DRIVE-CONDUCTOR.md`.

## Implemented — 2026-09-13 conductor-edits pass

Three items landed (verified by `npm test` — 156 pass, 0 fail). §1 (usage-bar ordering) and §3
(multi-session routing) stay **queued**. The two earlier "session robustness" items are **dropped**
(per the user — the session self-managed fine).

### §2 (partial): live verdict/perf logging + phantom detection — DONE (the "meantime")
- Every live worker run already reaches `recordRun`; its outcome now trains selection (not just the smoke battery).
- New distinct verdict **`phantom`** (scores 0, tracked apart from `fail`). `tasks.run()` auto-verifies a
  worker's claimed `file_change` writes against `git`; a claimed-but-not-landed success is marked failed
  and auto-rated `phantom` — the "reported-but-not-persisted" verdict §2 asked for.
- `recordRun` rows gain `failKind` + `rounds`; `summarize()` exposes `errorRate`/`phantomRate`; new
  `errorRates()` rolls up per model id **and** per provider/family; `formatScores()` surfaces both.
- **Deferred (later):** the correction-cost penalty inside `recommend()` — the fields are now wired to make it possible.
- Commit: `scorecard: log live worker verdicts + errors, detect phantom completions`.

### New — Quit did not stop the usage-check cmd windows — DONE (needs a manual verify)
- Usage/limit/model probes (`capture()`) are now tracked (`core/proc.mjs` `trackProbe`/`killProbes`) and
  killed on shutdown; `startModelPolling`/`startLimitPolling` gained `stop*` counterparts;
  `server/index.mjs` `stopBackgroundWork()` clears both pollers **and** kills in-flight probes, called from
  `/api/shutdown` and the CLI SIGINT/SIGTERM handler (`conductor stop` already tree-kills via `taskkill /T`).
  Probes stay `windowsHide:true`.
- **Manual check still required:** the no-window-after-Quit behavior can't be exercised by `npm test`;
  confirm with a real restart + Quit.
- Commit: `shutdown: stop usage-check probes on Quit …`.

### New — Providers & Limits: auto-refresh checkbox + frequency — DONE
- "auto" checkbox beside ↻ Refresh; when on, the panel re-fetches models+limits on a client-side interval.
  New `ui.autoRefresh` / `ui.autoRefreshMinutes` config (normalized, min 1 min, default off), persisted via
  `/api/settings`; settings gained the minutes field; `refresh-meta` shows both cadences. Distinct from
  `pollMinutes` (the server registry poll).
- Commit: `ui: providers-panel auto-refresh checkbox + interval setting`.

### Dropped
- The two "session robustness" items are dropped per the user (the session self-managed fine).

_(append further iteration-2 conductor comments below)_
