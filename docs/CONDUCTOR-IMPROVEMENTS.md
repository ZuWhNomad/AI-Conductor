# Conductor 2.0 — pending improvements (NOTED, not yet implemented)

**Status:** capture-only. Do **not** apply piecemeal. We will implement these together with any
further changes the user proposes, then commit + push to GitHub in one batch.

Anchors below are `file:line`-ish pointers to the current code so implementation is quick later.

---

## 1. Worker review → escalation ladder (best model before conductor)

**Goal:** the conductor model is *not always the best model* — it should be the **final fallback**,
not the first escalation target. Insert a best-model escalation step between review rounds and the
conductor taking over.

**Current behavior**
- `core/config.mjs` — `conductor.claudePermissionMode: 'bypassPermissions'` (comment: "workers run
  autonomously; **the conductor reviews**") and `worker.maxRounds: 3` (comment: "review → follow_up
  rounds before escalation").
- `core/tasks.mjs` (~L88–94) — a follow-up task increments `t.rounds`; when
  `t.rounds > worker.maxRounds` it only sets a **warning** ("fix round N exceeds maxRounds=…;
  consider finishing this yourself"). Net effect today: after 3 rounds it **escalates straight back
  to the conductor**.
- `core/scorecard.mjs` — `recommend()` (utility = value-of-quality − cost) picks the worker model;
  failover skip in `core/tasks.mjs` (~L260).

**Desired behavior**
1. **Up to 3 review rounds** (conductor reviews worker output → follow-up "fix" task), as today
   (`maxRounds: 3`, keep configurable).
2. If still failing after 3 review rounds → **escalate to the best available model** (scorecard's
   top-*quality* pick, respecting provider limits + budget windows) for **escalation round(s)** —
   NOT straight to the conductor.
3. Only if the best-model escalation also fails → **conductor finishes it itself** (final fallback).
4. `scorecard.recommend()` must be able to return the **best-available model** (rank by quality,
   filtered by live limits/budget) for the escalation step — distinct from its normal
   best-*value* pick.

**Open question (TBD):** how many escalation rounds? User unsure. Proposed default: **1–2**
best-model escalation attempts, then conductor. Make it a config knob (e.g. `worker.escalationRounds`).

---

## 2. Grok usage %: always show an estimate in the UI

**Goal:** show Grok a usage **%** like the other providers even before the user reports real usage
(an estimate is fine); refine once real usage is entered.

**Current behavior**
- `server/index.mjs` — `limitsWithEstimates()` synthesizes an "estimated usage" window for providers
  whose CLI reports no window (Grok), but **only when `est.calibrated`** (needs ≥1 check-in or a
  budget). So Grok's bar is blank until calibrated.
- Estimate math: `core/usage-estimate.mjs`; window registry: `core/limits.mjs`; user check-in
  endpoint: `POST /api/providers/:id/usage {pct}`.

**Desired behavior**
- Render a Grok % bar unconditionally (fall back to a sensible default/uncalibrated estimate so it's
  never blank), matching how other providers display, and mark it as an estimate. Improve accuracy
  as check-ins arrive.

**Calibration data point (user-reported):** Grok "Weekly SuperGrok Limit" = **26% used**
("Grok Build" 26%), observed at **~2:48** (local), **resets 2026-09-19 21:58**. Use this to seed /
verify the estimate when implementing.

---

## 3. Antigravity effort selection bug (effort tagged on effort-less models)

**Symptom:** every Antigravity worker selection carries `:high` even though the model's effort is
already baked into its id. Observed this run:

| Phase | Recorded `provider:model:effort` | Actually dispatched |
|---|---|---|
| 3 | `antigravity:gemini-3.7-flash-high:high` | gemini-3.7-flash-**high** |
| 4A | `antigravity:gemini-3.6-flash-low:high` | gemini-3.6-flash-**low** |
| 4B | `antigravity:gemini-3.8-flash-low:high` | gemini-3.8-flash-**low** |
| 5 | `antigravity:gemini-3.6-flash-medium:high` | gemini-3.6-flash-**medium** |

**Root cause (scorecard):** `core/scorecard.mjs` → `effortForTask()` (~L421):
`if (!efforts.length) return defaultEffort || null;` — a model with **no** effort dimension
(`efforts: []`) still gets the default effort (`high`) attached. Antigravity models all report
`efforts: []` (`core/providers/vendors.mjs:96`), so they always get a spurious `:high`.

**Why it's silent, not fatal:** the executor already handles it correctly —
`core/providers/vendors.mjs` `headlessArgs` (L97–104) passes only `--model`, never `--effort`
(comment: *"agy … rejects a conflicting --effort; only pass it for plain ids"*). So the effort tag
is **never dispatched** — but it **is** persisted on the task and in the scorecard `sel`
(`provider:model:effort`), which (a) misleads the UI/logs and (b) pollutes measured rows with
nonsensical keys like `gemini-3.6-flash-low:high` that then get re-recommended.

**Correct target:** effort for Antigravity lives in the **model id** (`-low`/`-medium`/`-high`).
To run "high effort" you pick `gemini-3.x-flash-high`, not `-low` + `:high`. Appending `--effort`
as a flag is not an option (agy rejects it).

**Options (do it cleanly, minimize regression):**
- **A — source fix (minimal, recommended):** in `effortForTask()`, return `null` when
  `!efforts.length`. A model with no effort dimension must never carry an effort. One line, exact
  bug. Then audit other assignment sites for the same missing `m.efforts` check.
- **B — central normalization (defensive, pair with A):** a single `normalizeSelection()` (or
  extend `parseSelection`) that strips `effort` whenever the resolved model's `efforts` is empty,
  applied everywhere a selection is built for dispatch **and** for recording. Catches the bug on
  every path and future-proofs it.
- **C — model family + effort → id at dispatch (cleanest, larger) — ✅ CHOSEN (user decision):**
  represent `gemini-3.x-flash`
  as one logical model with `efforts:[low,medium,high]` and map `(family, effort) → -low/-medium/-high`
  in the executor. Lets the scorecard reason about effort uniformly (effort dominance, cold-start)
  and actively pick the right variant for a desired effort. This is the clean version of the
  "conductor picks model+effort, code appends before execution" idea — the append is into the
  **id**, not a flag.
- **D — fail-fast guard (safety net, cheap):** in `createTask`/dispatch, if `effort` is set but the
  model's `efforts` is empty, strip it + log (or reject). Stops a nonsensical combo ever being
  recorded.

**DECISION (user): implement Method C.** Represent each Antigravity effort-family
(`gemini-3.x-flash`, `gemini-3.1-pro`, etc.) as one logical model exposing `efforts:[low,medium,high]`,
and translate `(family, effort) → concrete id` (`-low`/`-medium`/`-high`) in the executor at dispatch.
The scorecard then reasons about effort uniformly and actively picks the right variant. Fold in **D**
as a dispatch guard (strip/reject an effort a model can't honor) so a bad combo can never be recorded.
**Data hygiene:** existing scorecard rows keyed `…-low:high` etc. are polluted by the old bug —
normalize/void those `sel`s as part of the change so they stop being recommended.

Implementation touch-points to work through when we build it: `core/providers/vendors.mjs`
(family model list + `(family,effort)→id` mapping in `headlessArgs`), `core/models.mjs` (surface the
collapsed family models with real `efforts`), `core/scorecard.mjs` (`effortForTask`/`priorFallback`
and `sel` handling), and a migration pass over stored scorecard rows/tasks.

## Further proposals (running list — append as the user adds them)

- **UI: pin "Providers & Limits" to the top of the sidebar** — it currently sits *below* the
  scrollable chats list and scrolls away. Make it a fixed/pinned region (top of the sidebar,
  outside the scroll area) so it's always visible; the chats list should be the only part that
  scrolls. Touch-points: `ui/index.html` (`aside#sidebar` panel order —
  `section.panel.providers-panel` / `#providers` / `#refresh-meta`, currently after
  `section.panel.grow`, the chats list) and `ui/styles.css` (sidebar flex layout; move the
  `grow`/scroll to the chats panel and keep providers pinned).

---

## Also pending (ops, not code)

- Delete the old `D:\claude-conductor` install (superseded by Conductor 2.0). _(In progress this
  session.)_
