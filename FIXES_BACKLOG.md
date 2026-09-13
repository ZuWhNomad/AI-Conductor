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

- [x] **SC1 — `admit()` liveness stall.** RESOLVED 2026-09-13 by the sequential-throttle policy change: `core/tasks.mjs schedule()` no longer parks on budget — over target it degrades to one-at-a-time per provider and keeps issuing, so a task can't sit queued-forever with `{n:0, until:null}`. (was: headroom positive but < task cost and no window at target → neither dispatch nor park.)
- [x] **SC2 (RESOLVED by the probe-gating fix) — Unknown-cost tasks flood instead of probing singly.** `core/tasks.mjs:155-173` — `measuredCost` is 0 for unmeasured models, so `dispatched[provider]` never grows and up to `maxWorkerConcurrency` (8) probe tasks launch at once for a fresh/hand-pinned model, defeating the "one at a time until measured" invariant that protects a fresh window. Fix: treat unmeasured cost as a full probe slot. (MED)
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

---

## Round 2 — Opus 5 lens fan-out (2026-09-13) — collect all 5, dedupe, verify, then fix

### Lens: hardcode → dynamic (REVIEW-OPUS5-hardcode.md)
- [ ] H1 — vendor model lists frozen (`vendors.mjs:167` qwen, `:195` kimi; `providers/index.mjs:15,23`): merge `providers.<id>.models` over the default. (this is the deferred C6)
- [ ] H2 — Grok 8000-char prompt-file cutoff (`vendors.mjs:146`): platform-aware `providers.grok.promptFileThreshold`.
- [ ] H3 — conductor turn timeout hard-coded 2h (`conductor.mjs:317,325`): `conductor.turnTimeoutMinutes`.
- [ ] H4 — maxTurns divergence: `workers/index.mjs:35` hard-codes 60 for Ollama-via-Claude; `workers/claude.mjs:33` dead `|| 150` vs documented 500. Add `worker.maxTurnsLocal`, align fallback.
- [ ] H5 — prior tiers + modeling-eligibility list code-only (`priors.mjs:24-82`): allow `scorecard.priors`/data-file merge.
- [ ] H6 — image params hard-coded (`workers/image.mjs:32` steps:25, `:17`): imageOptions + `providers.sd.steps`.
- [ ] H7 — MCP global timeout default (`mcp.mjs:65`): `mcp.toolTimeoutSec`/`startupTimeoutSec`.
- [ ] H8 — bench probe budget hard-coded + saveConfig round-trip smell (`bench.mjs:33,37,43`).
- [ ] H9 — HTTP 429 default 60s ignores blockedMinutes (`limits.mjs:104`): reuse `blockedMs()`.
- [ ] H10 — Claude effort thresholds (`anthropic.mjs:76-79`): low urgency (SDK shadows it).
- Leave-as-is (flagged, no churn): planBatch bufferPct/maxParallel (dead path), DIFFICULTY_EFFORT/FALLBACK_LADDER (already config-merged), EFFORTS order, smoke fixtures, CATALOG baseUrls.

### Lens: security (REVIEW-OPUS5-security.md)
- [ ] SEC1 — SSRF in fetch_url/fetchUrlText (`workers/openai-compat.mjs:43-51,90`): only `^https?://`, no host/IP filter, follows redirects → 169.254.169.254 metadata, loopback, internal hosts; body returned to model. Fix: block private/link-local/loopback IPs, don't follow redirects to private. (P2, high conf)
- [ ] SEC2 — unsandboxed `run` + plaintext key store → cross-provider exfiltration (`openai-compat.mjs:93-110`; keys in config.json). worker.shell defaults true; a worker can read all providers' keys and ship them back. Mitigation (allow-list) exists but isn't default. DECISION NEEDED: change default? (breaks benchmarks) — flag to user. (P2/P1)
- [ ] SEC3 — feedback redact misses AIzaSy (Google — the AIza branch needs a `[-_]` real keys lack), gsk_ (Groq), AKIA (AWS) (`feedback.mjs:19-27`). Easy, verified. (P3)
- [ ] SEC4 — publicConfig masks mcpServers env but NOT mcpServers[*].url (`config.mjs:141-148`); a token in an MCP URL leaks via /api/state. (P3)
- [ ] SEC5 — no local API auth (`server/index.mjs`): localhost-trust assumption; /api/browse enumerates dirs. By design — note, likely leave. (P3)
- [ ] SEC-prompt — context notes + fetched pages ingested as instructions (prompt injection); escalates with SEC1/SEC2. (P3)
- Verified holding: spawnCli/resolveNpmShim/winArgEscape, spawnCodex, shellDenied allow-list, static-file traversal, CSRF/DNS-rebind defenses, saveConfig sentinel.

### Lens: framework/guidelines (REVIEW-OPUS5-framework.md)
- [ ] FW1 — Missing CONTEXT.md across most folders (core/, providers/, workers/, prompts/, server/, ui/, bin/, scripts/); providers/ + workers/ are contract-heavy and context.mjs injects nearest CONTEXT.md at runtime. Add them. (Med/High)
- [ ] FW2 — ARCHITECTURE.md:204-208 says admit "parks the rest until reset"; code throttles-to-sequential + failover. Fix the doc. (doc)
- [ ] FW3 — ARCHITECTURE.md:46-71 dir map stale (omits bench, feedback, recipes, session-flags, update, usage-estimate, scripts). (doc)
- [ ] FW4 — codex.mjs doesn't export `kind` (patched in providers/index.mjs:39); only provider breaking the module shape. (Low)
- [ ] FW5 — stdin-for-long-prompts half-followed: agy/qwen/kimi pass prompt on argv (overlaps H2/C10). (Low/Med)
- [ ] FW6 (nit) — full agent-message text published to the 2000-ring bus unsliced (claude.mjs:45, vendor-cli.mjs:84). Likely necessary for UI. (nit)

### Lens: general correctness (REVIEW-OPUS5-general.md)
- [ ] GEN1 — Canceled tasks are scored (`tasks.mjs:236` gate `TERMINAL && !limitHit`; TERMINAL includes canceled). recordRun writes an op:run row with ~0 tokens → drags group avgUsd down → model looks cheaper → over-selected; pct also feeds measuredCostByWindow. Fix: exclude canceled like limitHit. (P2, high conf)
- [ ] GEN2 — `conductor review` re-runs a live server's journaled tasks (`bin/conductor.mjs:132-144`): smoke/bench guard against open journal tasks, review doesn't → double execution + racing writeJson. Add the guard. (P2, high conf)
- [ ] GEN3 — refreshModels coalesces scoped+full into one promise (`models.mjs:16`) — same bug limits.mjs just fixed; key by scope. (P3)
- [ ] GEN4 — saveConfig freezes all DEFAULTS to disk (`config.mjs:135`) so future default changes never reach that user. (P3)
- [ ] GEN5 — unbounded ndjson ledgers re-parsed in full on hot paths (`tasks.mjs:154` runRows() per schedule(); recommend→summarize per delegate) — rotation/caching. (P3)
- [ ] GEN6 — SSE gap beyond the 2000 ring lost with no resync (`ui/app.js:366`) — only boot-id change forces resync, not a seq gap. (P3)
- [ ] GEN7 — onLines has no max line length (`proc.mjs:134`) — un-newlined stream grows buf unbounded. (P3)

### Lens: budgeting & model selection (REVIEW-OPUS5-budgeting.md)
- [ ] **BUD1 (P1) — Opus/Sonnet weekly windows leak onto ALL Claude models.** `anthropic.mjs:128-136` emits seven_day_opus/seven_day_sonnet (labels "weekly Opus"/"weekly Sonnet") with NO `models` field; `providerWindows` (`scorecard.mjs:306-310`) only scopes windows with a models field or a fable label. Probe-confirmed a Fable model sees seven_day_opus. A maxed Opus weekly → whole Claude provider blocked → Fable delegations + Sonnet workers parked, Claude stops being recommended, for empty buckets. **CONTRADICTS the user's earlier exclusion (they believed Opus/Sonnet have no separate windows). NEEDS USER DECISION: scope each window to its model (if real) or drop them (if phantom on this plan).**
- [ ] BUD2 (P2) — concurrency divisor understates cost for grouped providers: `sweep.mjs:50` divides by (r.concurrent+1) but `concurrent` counts same-PROVIDER tasks, not same-window-GROUP. Gemini window moved 8% w/ 3 concurrent Claude/GPT → recorded 2%/task (4× under) → over-dispatch Antigravity groups. Fix: count tasks sharing the window group. (confirmed)
- [ ] BUD3 (P2) — Claude poll utilization not normalized like the event path (`anthropic.mjs:127` raw vs `:144` *100 when ≤1). If control-request scale is 0-1, polled Claude windows under-report ~100× → blocked never fires. NEEDS SDK-scale verification; share one normalizer. (flag)
- [ ] BUD4 (P3 batch) — ARCHITECTURE.md:191-207 stale (planBatch/park); admit.until/nextResetWindows dead on framework path; effortMultiplier probe baseline mismatch (sweep.mjs:74); per-entry getLimits() in loop; estimator 0-token rate blowup.
- Verified-correct: per-window "fit iff every window" math + session/weekly targeting; per-window running tally honors w.models; SC1 + SC2 RESOLVED (backlog SC2 stale); estimator advisory-only; selection logic coherent (rides on BUD1 fix).
