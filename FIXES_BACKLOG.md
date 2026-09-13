# Conductor 2.0 — fix backlog

Consolidated from the 2026-09-13 reviews. **Nothing here is applied yet** — this is the approved-to-note list.
Grok's review findings will be appended once it finishes and the user approves; then we work through everything.

Legend: severity — **BUG** / CRIT / HIGH / MED / LOW · effort/risk in (S=small, M=med).

---

## Bugs (real defects, not churn)

- [ ] **B1 — `EFFORT_LADDER` omits `ultra`.** `core/scorecard.mjs:340` — `EFFORT_LADDER` is missing `ultra`, unlike `EFFORT` (`:245`), `EFFORT_WORDS`, and sweep's `FALLBACK_LADDER`. `priorEffort`/`effortForTask` rank via `EFFORT_LADDER.indexOf`, so `ultra` scores `-1`: Codex Astra/Sol (the models the modeling recipe wants at `ultra`) can never cold-start there, and a hand-set `worker.effort:'ultra'` ranks below `low`. Fix: one exported `EFFORTS` constant imported everywhere. (S/S)

## Security

- [ ] **S1 — Third-party / Ollama workers get an unsandboxed host shell.** `core/workers/openai-compat.mjs:74-87` — the `run` tool is `spawn(cmd, {shell:true})` with no path/allow-list; runs in-process. `safe()` guards file tools but not `run`. This is the runtime for DeepSeek/Kimi/Grok/Qwen/Gemini — arbitrary host code execution, unlike Codex (OS sandbox) and Claude workers. Fix: sandbox or allow-list the `run` tool. (HIGH)
- [ ] **S2 — Feedback bundle leak surface = the free-text improvement log.** `core/feedback.mjs` correctly excludes `cfg.providers`, but embeds ~300 improvement-log entries (worker error bodies, server stack traces, vendor 4xx bodies, uncaught exceptions), redacted only by prefix regex. Bundle is shared via GitHub issue. Fix: exclude or entropy-redact error/friction bodies. (MED)

## Benchmark integrity (Conductor-Benchmarks repo)

- [ ] **BM1 — Anti-cheat depends on an unenforced sandbox.** `cookie-cutter/workspace.mjs` scopes only what's copied in, never confines the process. `judge/reference_v4.stl` sits one dir above `work/<id>/`, and `workspace.mjs:30-33` junctions `tools/` from outside the workspace, so out-of-workspace paths resolve. A model can `trimesh.load(r"..\..\judge\reference_v4.stl")` and re-emit it. Integrity currently rests entirely on the Codex OS sandbox (Codex-only). Fix: enforce an FS boundary, or verify non-Codex passes out-of-band. (CRIT)
- [ ] **BM2 — STL gate doesn't enforce inner-impression-line topology.** `evaluate.mjs:64` — `mid.area/cut.area ≥ 1.4` is satisfied (~1.5) by the outer wall taper alone with zero inner lines; and `gate()` parses but never checks `cut.polys`/`mid.polys`, so full-height inner walls also pass. The two rules that look like they enforce the design enforce nothing. Fix: check polygon counts / inner-line presence. (HIGH)
- [ ] **BM3 — Grader runs bare `py`, workspace pins Python 3.12.** The scored gate can run under a different trimesh than the build used, flipping results. Fix: grader uses the same pinned interpreter. (MED)

## Scheduler correctness

- [ ] **SC1 — `admit()` liveness stall.** `core/sweep.mjs:134-140` + `core/tasks.mjs:169-172` — when headroom is positive but smaller than a task's cost and no window is at target, `admit` returns `{n:0, until:null}`; `schedule()` neither dispatches nor parks-with-timer. A lone over-cost task stalls until another event re-triggers `schedule()` (limit polling doesn't). Self-heals in a batch, hangs when solo. Fix: park-with-timer (or dispatch one) in this case. (MED)
- [ ] **SC2 — Unknown-cost tasks flood instead of probing singly.** `core/tasks.mjs:155-173` — `measuredCost` is 0 for unmeasured models, so `dispatched[provider]` never grows and up to `maxWorkerConcurrency` (8) probe tasks launch at once for a fresh/hand-pinned model, defeating the "one at a time until measured" invariant that protects a fresh window. Fix: treat unmeasured cost as a full probe slot. (MED)
- [ ] **SC3 — `measuredCost` applies one window's % against every window.** `core/sweep.mjs measuredCost` returns a single number (largest window delta ÷ concurrency) that `admit()` then checks against ALL of a provider's windows. A build's cost measured on a small 5h window (e.g. 13%) is wrongly charged to the weekly window too, so a task is refused even when the weekly has ample room. **This is what stalled the Sol-xhigh-from-grok-low build on 2026-09-13** (13% charged vs 9% weekly headroom at 91%; real weekly cost ~3%). Fix: cost per-window (each window's own measured delta), or scale cost by window length. Compounds SC1 (the refusal then never parks). (MED, real impact) [depends on the SC1 fix landing too]

## Config / flexibility (make hard-coded values tunable)

- [ ] **C1 — Window targets 95/100 hard-coded** in `core/sweep.mjs:105 targetFor`; gates ALL dispatch yet not read from config. Add `scorecard.windowTargets`. (S/M)
- [ ] **C2 — `GAP_MS = 6h`** usage-window inference, `core/usage-estimate.mjs:9` — mis-anchors daily-reset providers like Grok. Make per-provider config. (S/S) [ties to Grok's daily reset]
- [ ] **C3 — Windows Python 3.12 path**, `core/providers/vendors.mjs:16` — breaks Kimi CLI discovery on other Python versions. Glob `Python3*/Scripts`. (S/S) [also fixes BM3 root]
- [ ] **C4 — Session-window heuristic** (`/hour|session/` + `windowMinutes<=600`) copy-pasted 3×: `sweep.mjs:95,104`, `scorecard.mjs:302`. Extract one helper. (S/S)
- [ ] **C5 — Cold-start maps** `DIFFICULTY_EFFORT` (`scorecard.mjs:343`) and `FALLBACK_LADDER` (`sweep.mjs:60`) — genuine tuning knobs; move to `config.scorecard`. (S/S)
- [ ] **C6 — Hard-coded Qwen/Kimi model lists** `vendors.mjs:159,187` — these CLIs can't self-enumerate; new vendor models need a code edit. Allow `providers.<id>.models` override. (S/S)
- [ ] **C7 — Recipe category→file maps** `core/recipes.mjs:10,13` — routing policy frozen in code; allow config override or auto-discover. (S/S)
- [ ] **C8 — "Assume blocked 30 min" magic number** repeated at `core/limits.mjs:84,118`, `tasks.mjs:211`. Consolidate to one constant/config. (S/S)
- [ ] **C9 — Grok 8000-char `--prompt-file` cutoff** `vendors.mjs:138` and stray `maxTurns:60` for Ollama-via-Claude `workers/index.mjs:35` — diverge from configurable `worker.maxTurns`. Make configurable. (S/S)
- [ ] **C10 — Windows argv prompt overflow for `agy`/`qwen`/`kimi`.** `vendors.mjs` headlessArgs put the whole prompt on the command line (no stdin); large specs exceed the 32767-char `CreateProcess` limit. Only `grok` mitigates via `--prompt-file`. Fix: prefer stdin / `--prompt-file` for all (per CLAUDE.md). (MED)

## Lower severity (from REVIEW_OPUS.md, note only)

- [ ] **L1 — In-process ReDoS** risk in redaction/parse regexes.
- [ ] **L2 — Anthropic utilization unit inconsistency.**
- [ ] **L3 — Synchronous git in the dispatch path.**
- [ ] **L4 — `shortId` collisions** possible.
- [ ] **L5 — Trace scoring**: SSIM / Hausdorff / resize handling issues in `trace/`.

---

## Excluded (decided NOT to fix)

- **Claude weekly Opus/Sonnet window model-scoping** (REVIEW_OPUS finding #6, relayed as #7).
  Reason (user, 2026-09-13): Opus and Sonnet do **not** have their own weekly windows unique to Fable —
  only Fable has a separate window. There is no distinct Opus/Sonnet weekly window to scope, so the fix is moot.
- **Making the server bind (`127.0.0.1`) configurable** — deliberate security choice; leave as-is (per REVIEW_FLEXIBILITY).

---

## Pending: Grok review (awaiting user approval to fold in)

Grok's reviews are written: `F:\Conductor 2.0\REVIEW_GROK.md` (conductor) and `F:\Conductor-Benchmarks\REVIEW_GROK.md` (benchmarks). Grok ran live probes on this machine. Headline findings (approve to promote into the list above):

- **G1 — confirms SC1** independently: probed `admit` at 94% of a 95% target with a 2% task returns `{n:0, until:null}`; notes `test/sweep.test.mjs:103-104` asserts `n===0` but never asserts `until`, so the stall is untested. Same root cause as our SC1/SC3.
- **G2 — `.cmd`/`.bat` spawned without a shell throws `EINVAL`** on Node v24 (`spawn`/`execFile`). Affects the `py.cmd` shim and any `.cmd` binary launched via `core/proc.mjs`. Overlaps C3/C10.
- **G3 — flat `budgetTokens` estimator quirk**: `estimateUsage` with `budgetTokens:10M` stayed at 50% after a 17% check-in — the flat path ignores calibration by design, but Grok flags the divergence as confusing; consider blending or labeling.
- **G4 (benchmarks) — visual grades aren't a reproducible measurement**: two incompatible scales coexist (`evaluate.mjs` 0-5 `visualScore` vs `pass/close/fail` in results.json); README says opus 5/5 & astra 4/5 for a run that results.json calls both "close"; no rubric / second rater; gate constants used for past grades (`maxExtentsMm [100,100,14.1]`) differ from the live harness (`110/100/16.1`) — a correct v4 part would have failed the 09-11 gate. Overlaps/extends BM1-BM2.
- **G5 (benchmarks) — trace ranking is circular**: ground truth is `judge/reference_v4_top.png` (a CAD top-view of a prior passing model), but the task is to trace the *photo* — so faithful photo traces are scored against a different drawing, biasing toward CAD-like ink. Extends L5.

_Once approved, promote the above into the ranked list and we work through everything._
