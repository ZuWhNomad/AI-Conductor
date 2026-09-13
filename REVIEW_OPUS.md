# Engineering Review — Conductor 2.0 + Conductor-Benchmarks

Read-only senior review. Opus 4.8, 2026-09-13. Scope: `F:\Conductor 2.0` (engine, server, providers, workers, sweep/scheduler, usage estimator, scorecard) and `F:\Conductor-Benchmarks\cookie-cutter` (image→STL benchmark). No code was changed.

Overall: the codebase is unusually disciplined — atomic writes, append-only ledgers, a localhost-only server with Host/Origin/content-type guards, secret redaction in `publicConfig`, and genuinely good test coverage of the budget math. The findings below are mostly edge cases and one real trust-boundary gap. Severity is my own ranking.

---

## 1. Correctness bugs & edge cases

### HIGH — Non-Codex API/Ollama workers get an unsandboxed shell on the host
`core/workers/openai-compat.mjs:50-88`. This loop is the runtime for **every** OpenAI-compatible worker: DeepSeek, Kimi, Grok, Qwen, Gemini, and Ollama (the default `harness: 'openai-compat'`). Its tools run **in the Conductor server process**, not a subprocess sandbox. The `safe()` guard (`:51`) constrains `read_file`/`write_file`/`edit_file`/`list_dir`/`search` to `cwd` — but the `run` tool (`:74-87`) does `spawn(command, { cwd, shell: true })` with **no path restriction and no allow-list**. `shell: true` means the model can `cd` anywhere, exfiltrate via `curl`, or `rm -rf` outside the workspace.

Contrast: Codex workers run under an OS sandbox (`core/workers/codex.mjs:29-31`, `-s workspace-write`), and Claude workers run through Claude Code (`core/workers/claude.mjs`). Only the openai-compat path grants unrestricted host shell — and it is the path used for the cheapest, least-trusted third-party models. A prompt-injected or adversarial API model has arbitrary code execution on the user's machine. `fetch_url` (`:24-32`) compounds it as a ready exfil channel. This is largely "autonomy by design," but the sandbox asymmetry is undocumented and worth a deliberate decision (e.g. run these workers behind the same sandbox as Codex, or gate `run` behind an allow-list/confirmation for `api`-class providers).

### MEDIUM — `search` regex and file tools run in-process (ReDoS / event-loop stalls)
`core/workers/openai-compat.mjs:66-69`. `new RegExp(pattern)` is model-supplied and executed line-by-line over the tree in the server process. A catastrophic-backtracking pattern (or a `read_file` of a 60 KB minified line) blocks the whole Node event loop — every chat session and SSE stream stalls, not just that worker. Same in-process concern as the `run` tool above.

### MEDIUM — Anthropic utilization unit inconsistency (can falsely block the conductor)
`core/providers/anthropic.mjs`. `pollLimits`→`normalizeUsage` stores `usedPercent: rl[key].utilization` **raw** (`:127`), assuming a 0–100 scale (that assumption is load-bearing: `blocked: windows.some(w => usedPercent >= 100)` at `:135`, and `providerUsedPct < classCap` in the scorecard). But the live-event path `windowFromEvent` (`:144`) scales `utilization * (utilization <= 1 ? 100 : 1)` — i.e. it assumes utilization may be a 0–1 fraction. The two code paths cannot both be right for the same wire value. If a `rate_limit_event` ever reports a genuine ≤1% utilization, `windowFromEvent` multiplies it to ~100% and the conductor's own class cap (`classCap.conductor = 95`) will falsely mark Claude unavailable. Pin the unit from the SDK types and make both paths agree.

### LOW — `git status`/`diff` run synchronously inside the dispatch hot path
`core/tasks.mjs:193, 200-201` call `gitStatus`/`gitDiffStat` → `execFileSync` (`:264`). In `run()` these execute **before the first `await`**, so each task dispatch synchronously blocks the event loop on a `git` subprocess. Under a burst of dispatches this serializes and adds latency to the server. Correctness is fine; throughput isn't.

### LOW — `shortId()` collisions overwrite journals
`core/paths.mjs:41` — 8 chars of base36 from `Math.random()`. Task and session ids share it; a collision silently overwrites `tasks/<id>.json`. Probability is low but the failure is silent data loss. Consider `randomUUID()` (already imported elsewhere) or a collision check on `tasks.has(id)`.

### LOW — `/mcp/<session>` endpoint is unauthenticated
`server/index.mjs:40-61`. Any localhost process that knows an 8-char session id can call `tools/call` → `delegate` → spawn workers with workspace-write in the session cwd. Mitigated by 127.0.0.1 binding + Host/Origin checks, so this is defense-in-depth only; the session id functions as a bearer capability. Acceptable for a local tool, noted for completeness.

---

## 2. Budget/sweep planner + `admit()` gate

The core math is **sound and well-tested**. `targetFor` (session→95, else→100, `core/sweep.mjs:105`), `headroomFor` (tightest window binds, `:108-112`), `planGreedy` (cheapest-first fill, `:73-87`), and `admit` (`:134-140`) all behave as the tests assert (`test/sweep.test.mjs:77-105`). No off-by-one in the target arithmetic itself: `nextResetWindows` uses `>= targetFor(w) - 0.01` (`:124`) which correctly treats a window exactly at target as "full." Below are the real gaps.

### MEDIUM (liveness) — A task can be neither dispatched nor parked, and stall
`core/sweep.mjs:134-140` + `core/tasks.mjs:169-172`. When a provider has **positive** headroom that is **smaller than the task's cost**, and **no window is yet at/over its target**, `admit` returns `{ n: 0, until: nextResetWindows(...) = null }` (no window qualifies as "full," so `nextResetWindows` is null). In `schedule()`:
```
if (!a.n) { if (a.until) park(t, a.until, ...); continue; }
```
`a.until` is null → the task is **not** parked with a wake timer, just `continue`d. Reproduction (mirrors `test/sweep.test.mjs:103-104`): session window at 94% (target 95 → 1% headroom), task cost 2%. `n:0`, and `nextResetWindows` excludes the 94% window (94 < 94.99) → `until:null`. The task re-evaluates only when some *other* event calls `schedule()` (a sibling task completing, a new `createTask`, or a settings save). Nothing else calls it — limit polling (`startLimitPolling`) does **not** call `schedule()`. So a *lone* over-budget-headroom task stalls indefinitely. In a batch it self-heals (siblings finish and re-trigger), which is why it hides. Fix: when `n===0` and `until===null`, still schedule a re-check (e.g. park until the earliest `resetsAt` among applicable windows, or a short retry timer).

### MEDIUM — Unknown-cost tasks flood instead of probing one-at-a-time
`core/tasks.mjs:155-173`. `perTaskCost(t)` returns `measuredCost(...) = 0` for any provider/model with no scorecard rows (`core/sweep.mjs:29-42`). In the schedule loop, `dispatched[provider] += perTaskCost(t)` therefore stays **0** for unmeasured tasks. Each per-task `admit([{cost:0}], …)` calls `planGreedy([0])` which returns `n:1` ("unknown cost: run it alone", `sweep.mjs:81`) — but because `dispatched` never grows, the *next* queued unmeasured task also sees full headroom and is admitted too. Result: for a brand-new or hand-pinned provider/model with no measured cost, up to `maxWorkerConcurrency` (default 8) tasks launch **concurrently**, defeating the "one at a time until a probe measures it" invariant the sweep design relies on to avoid blowing a fresh window. Delegated tasks usually route to a *proven* model (so cost is known), which is why this is Medium not High — but the framework gate does not enforce the invariant it claims to.

### MEDIUM — Claude weekly Opus/Sonnet windows are not model-scoped → over-restriction
`core/scorecard.mjs:308-311` (`providerWindows`) scopes a window to a model via `w.models` **or** a label heuristic that matches only `/fable/i`. But `core/providers/anthropic.mjs:128-131` emits `weekly Opus`, `weekly Sonnet`, and `weekly <model>` windows with **no `models` regex** and labels that don't match `fable`. So `scope()` returns null and those windows apply to **every** Claude model. When the budget gate evaluates a Claude *worker* task (`tasks.mjs:166`, `providerWindows(t.provider, t.model)` over *all* windows via `headroomFor`), a near-full "weekly Sonnet" window will bind/park a task running on Haiku or Fable. The recent commit correctly scoped Fable; Opus/Sonnet weekly windows were left unscoped. Give those windows a `models` regex in `normalizeUsage`, mirroring the Fable handling.

### LOW — In-flight vs polled double-count race
`core/tasks.mjs:158, 251-255`. `runningCost` sums `measuredCost` of in-flight tasks to compensate for consumption the polled `usedPercent` doesn't yet reflect. But on completion the task is removed from `running` (runningCost drops) *before* the async `refreshLimits()` in `score()` updates `usedPercent`. In that gap, neither the running-cost estimate nor the polled percent accounts for the just-finished task → the gate can transiently under-count and admit slightly too much. Bounded and self-correcting; noted.

---

## 3. Usage-estimate advisory model

Statistically reasonable and, importantly, **confirmed advisory-only — it cannot gate dispatch.** `estimateUsage` (`core/usage-estimate.mjs:47-63`) is consumed only by `limitsWithEstimates` (`server/index.mjs:167-179`), which builds a **copy** (`{ ...lim, providers: { ...lim.providers } }`) and injects a synthetic `<id>:estimated` window into that copy for the HTTP response. It never mutates the `getLimits()` cache, and `admit`/`providerWindows` read the real cache, which has no synthetic window. Providers that report no real windows (grok/ollama) are explicitly not gated (`admit([], …).n = 1`, `sweep.test.mjs:102`). So a wrong estimate can only mislead the human UI, never park a task. Good.

Model quality:
- **Through-origin least squares** (`:57`, `rate = Σ(pct·tok)/Σ(tok²)`) is a sound fit for a "0% at window start, linear in tokens" budget. The `tok²` denominator weights later (higher-token) check-ins more heavily, which is defensible — later readings are more informative about the cumulative rate.
- **Doc/behavior mismatch (LOW):** the JSDoc says "or the slope between the two most recent" (`:41-42`), but the code always does the full through-origin fit over all in-window observations; there is no two-point path. Cosmetic.
- **Edge case (LOW):** a check-in recorded at 0 tokens spent (e.g. right after a reset with no runs yet) makes `windowTokens` return `spent:0`, and the fallback `obs[last].pct / Math.max(1, tokens)` (`:57`) yields a huge %/token rate that then over-reads on the next token. Unusual input, advisory output.
- **`budgetTokens` override** (`:50-52`): flat 100%-at-N, clamped 0–100. Fine.

---

## 4. Windows-specific fragility

### MEDIUM — `agy` / `qwen` / `kimi` pass the full prompt as an argv element → Windows command-line limit
`core/providers/vendors.mjs`: `antigravity.headlessArgs` (`:89-90`, `['-p', t.prompt, …]`), `qwen-code` (`:162-163`, `[t.prompt, …]`), `kimi` (`:191-192`, `['-p', t.prompt]`). None set `stdinPrompt`, so `vendor-cli.mjs:38` spawns with `stdio: [... 'ignore' ...]` and the entire prompt (worker preamble + MSW kernel + injected CONTEXT.md + the spec — easily tens of KB) goes on the command line. Windows `CreateProcess` caps the command line at 32767 chars; large specs will truncate or fail the spawn. Only `grok` mitigates this, via `--prompt-file` past 8000 chars (`:136-138`) — the correct pattern the others lack. This also contradicts `CLAUDE.md` ("prefer stdin for long prompts"). Codex (stdin, `codex.mjs:73`) and Claude (SDK) are unaffected.

### Correct patterns (positive)
- `spawnCodex` bypasses the npm `.cmd` shim by running `codex.js` with `process.execPath` (`core/proc.mjs:56-63`), and treats a shim without its JS entry as "not installed" rather than falling back to a shell that can't safely carry `-c` overrides — good, and `assertShellSafe` (`:70-71`) backstops the dead shell branch.
- `killTree` uses `taskkill /T /F` on Windows (`:86`) to reap the native binary under the node shim.
- `agy /usage` is spawned without a shell specifically so Git Bash doesn't rewrite `/usage` into a path (`vendors.mjs:80`) — a nice Windows-aware detail.

### LOW — Hardcoded `Python312` path for the Kimi CLI lookup
`core/providers/vendors.mjs:16`. `pyScripts` only probes `Python312\Scripts`; a user on 3.11/3.13 won't have `kimi` located via that fallback (PATH lookup still works). Minor; consider globbing `Python3*`.

### py.cmd / py launcher (benchmark side)
The `py`-vs-`py.cmd` interpreter split is a real reproducibility hazard — see finding **B-M5** below.

---

## 5. Secret handling

Solid baseline: `publicConfig` redacts `apiKey` (`core/config.mjs:124-131`); `/api/state`, `/api/settings` return only `publicConfig`; API keys flow only as `Authorization: Bearer` to the vendor's own `baseUrl` (`workers/openai-compat.mjs:115`); the `http_rate` bus event forwards only `ratelimit`/`retry-after` **response** headers, never the request auth (`:118`); the Anthropic OAuth token is read from `~/.claude/.credentials.json` and sent only to `api.anthropic.com` (`providers/anthropic.mjs:83-97`); the `share` zip excludes `.conductor2`/`.git`/`node_modules` (`bin/conductor.mjs:165`). Server is 127.0.0.1-only with Host+Origin+content-type checks and a static-path-traversal guard (`server/index.mjs:240, 250-253`).

### MEDIUM — Feedback bundle's only guard is regex redaction of free-text logs
`core/feedback.mjs`. The bundle (shared with friends via a GitHub issue) deliberately **excludes** `cfg.providers` (where keys live) and includes only window metadata and statuses — good. But it embeds `listImprovements({ includeResolved: true }).slice(-300)` (`:40`), and the improvement log is a sink for **arbitrary** text: worker error bodies (`tasks.mjs:217`), server stack traces (`server/index.mjs:258`), vendor 4xx response bodies, and `uncaughtException` dumps (`improve.mjs:44-45`). Redaction (`:19-26`) covers home/user/email plus `sk-|xai|ghp|AIza|…` prefixes and `authorization|api_key|token|secret|password` assignments — reasonable, but **pattern-based and not exhaustive** (e.g. a bare DashScope/Moonshot key with an unlisted prefix, or a secret echoed inside a vendor error message in an unanticipated shape, slips through). Because the bundle is meant to be shared, treat the improvement log as the primary leak surface: consider excluding `error`/`friction` bodies from the bundle by default, or redacting more aggressively (drop any long high-entropy token). The `worker: cfg.worker` block (`:37`) is safe (no keys there today) but is a full config subtree — worth an allow-list rather than a spread, so a future key added under `worker.*` isn't silently shipped.

### LOW — MCP env values passed as `-c` argv to Codex
`core/mcp.mjs:58-69` renders `mcp_servers.<n>.env.<K>=<v>` as `codex exec -c` arguments, which can include secret env values from the user's own Codex/Claude MCP config. They're visible in the local process list. Local-only, sourced from the user's own config; noted.

---

## 6. Benchmark methodology (`cookie-cutter`)

Findings from a full read of `SPEC.md`, `verify.py`, `workspace.mjs`, `evaluate.mjs`, `trace/score_trace.py`, `trace/evaluate-trace.mjs`, `judge/README.md`, and inspection of a live workspace + the trace reference PNG.

**How grading actually works:** there is **no direct STL-vs-reference comparison.** `verify.py` never loads `judge/reference_v4.stl`; it computes intrinsic stats on the candidate only (`trimesh.is_watertight`, body count via `split()`, `bounding_box.extents`, three horizontal cross-sections) and renders a human-only `preview.png`. The reference STL is only the *source of the SPEC numbers* and the human eyeball comparison. The trace stage compares 2-D line-art PNGs (SSIM/IoU/Hausdorff), not STLs. The gate is binary; the only quality axis is a human `visualScore` 0–5 (`evaluate.mjs:82`). **There are no A/B/C letter grades in code.** Exact gate cutoffs (`evaluate.mjs:20-25`): box `maxX 110, maxY 100, maxZ 16.1`; cutting-edge wall `[0.7,1.3]` mm; mid wall `[0.5,1.8]` mm; `minInnerRatio 1.4`; plus `watertight===true` and `bodies===1`.

### CRITICAL (B-C1) — Workspace "isolation" is copy-scoping, not a sandbox; the reference sits one directory up
`workspace.mjs` controls only what is **copied in** (`ALLOWED_FILES = ['SPEC.md','verify.py']`, `:11`); it never confines the model's process. Workspaces are `…\cookie-cutter\work\<id>\`; the answer is `…\cookie-cutter\judge\reference_v4.stl` — one level up. `CONTEXT.md`/`judge/README.md` claim "a model never sees `judge/` (anti-cheating)," but nothing here enforces it, and `workspace.mjs:30-33` deliberately junctions `tools/` from **outside** the workspace (`join(HERE,'..','tools')`) — proving the harness expects out-of-workspace path resolution to work. A model's `generate.py` could `trimesh.load(r"..\..\judge\reference_v4.stl")` and re-emit it, passing every gate perfectly. Exploitability hinges entirely on the **Codex sandbox's filesystem scope**, which this repo neither implements nor documents. **Must be verified out-of-band**: if the sandbox doesn't hard-restrict reads to `work/<id>/`, the anti-cheat claim is void.

### HIGH (B-H2) — The gate does not verify inner impression lines are PRESENT
`evaluate.mjs:64` gates on `mid.area / cut.area ≥ 1.4`. But the outer wall alone is 1.2 mm at mid vs 0.8 mm at the cutting edge (SPEC:48), giving ~1.5 for the same outline **with zero inner lines**. A plain tapered bucket passes the check that is supposed to enforce SPEC:89 ("mid section shows the outer loop PLUS all inner impression lines").

### HIGH (B-H3) — The gate never enforces inner lines are ABSENT at the cutting edge (data parsed then discarded)
SPEC:88 requires the cutting-edge section to be a single outer loop with inner lines absent. `sectionOf` captures `polys` at both levels (`evaluate.mjs:32-34`) but `gate()` (`:55-66`) **never references `s.cut.polys`/`s.mid.polys`.** A model whose inner walls run full-height still passes. Combined with B-H2, the automated gate reduces to: watertight + 1 body + fits box + outer wall ≈0.8 mm at top. Fix both by gating on `mid.polys > cut.polys` (or a hole-count/area-delta isolating inner lines from the outer taper).

### HIGH (B-H4) — SSIM is the primary trace ranking key but barely discriminates sparse line masks
`evaluate-trace.mjs:29` sorts by `ssim` first; `score_trace.py:55` computes SSIM on 3-px-dilated binary masks with ~3–10% ink. Two mostly-empty masks score high SSIM from shared background regardless of line agreement. IoU (`:56-57`) is the meaningful metric but is only secondary. Demote SSIM below IoU.

### MEDIUM (B-M5) — Grader runs bare `py`; workspace pins `py.cmd`→Python 3.12 (non-reproducible gate)
`evaluate.mjs:76` / `evaluate-trace.mjs:24` `spawnSync('py', …)`, while `workspace.mjs:22-27` exists precisely because bare `py` misbehaves in the sandbox and 3.14 "intermittently access-violates," so it pins the workspace to `Python312\python.exe`. The scored gate can thus run under a **different** trimesh/manifold/shapely than the model self-verified with — `watertight`/`bodies`/section topology can flip, and native crashes are possible on the grader. Pin `evaluate*.mjs` to the same interpreter the workspace uses.

### MEDIUM (B-M6) — Trace scorer resizes candidate to the reference bbox, erasing aspect-ratio error
`score_trace.py:52-53` stretches the cropped candidate to the reference's exact H×W, so proportion errors are hidden (measured: ref aspect ≈1.28, sample candidate ≈1.26, forced identical). Letterbox to preserve aspect.

### MEDIUM (B-M7) — Manifold/quality signals computed then ignored
`verify.py:15` prints `winding_consistent`/`is_volume`; `evaluate.mjs:45` parses `windingConsistent` — but `gate()` checks neither, despite SPEC:56 demanding "watertight, manifold." `is_watertight` can be true for a self-intersecting/inverted mesh.

### MEDIUM (B-M8) / LOW (B-L9..L12)
- Hausdorff on skeleton point sets (`score_trace.py:59-62`) is a max-distance metric hypersensitive to a single stray pixel; only 3rd tiebreaker, and `linspace` subsampling makes it order-dependent.
- Dead "border/frame" safeguard comment with no implementation (`score_trace.py:90`) — harmless today (reference has no border ring), would silently corrupt a future framed reference.
- Cleanup swallows errors (`workspace.mjs:17-19`): a locked prior `out/` can leave stale artifacts in the new workspace, biasing the next run.
- `ink_ratio` compares mean ink across differently-sized masks (`score_trace.py:95`) — reported only.
- Fail-safe edges verified OK: `None` sections, zero-area cutting edge, binary-vs-ASCII/corrupt STL all fail closed via `trimesh.load(force="mesh")` → missing `watertight:` line → "STL did not load."

**Reproducibility:** the numeric gate is deterministic given a fixed interpreter/library set (no seeds, no rendering in the scored path); trace metrics are deterministic (fixed reference PNG). The two real threats are B-M5 (interpreter split) and the subjective human `visualScore`, which is the only quality signal once the loose gate passes.

---

## Priorities

1. **B-C1** — confirm and document the Codex sandbox FS scope; the entire anti-cheat claim rests on it (benchmark).
2. **HIGH (Conductor)** — decide the sandbox posture for openai-compat/Ollama workers; today any API model has host shell via `run`.
3. **B-H2/B-H3** — make the STL gate actually enforce inner-line topology (`mid.polys > cut.polys`).
4. **MEDIUM (Conductor)** — fix the `admit` `until:null` stall and the unknown-cost flood in `schedule()`; scope Claude weekly Opus/Sonnet windows by model.
5. **B-M5 / vendor argv prompts** — pin the grader interpreter; move `agy`/`qwen`/`kimi` prompts to stdin/`--prompt-file` like `grok`.
6. **B-H4/B-M6** — demote SSIM below IoU and letterbox the trace comparison.
