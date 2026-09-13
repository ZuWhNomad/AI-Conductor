# Conductor 2.0 — engineering review (Grok)

Local workbench: ESM, Node >= 22, Windows-first. The per-window admit gate, Codex stdin spawn, and `publicConfig()` key redaction are the right shapes. The holes below are in how those shapes are applied.

Probes (this machine, Node v24.18.0): `admit` at 94% of a 95% session target with a 2% task returns `{n:0, until:null}`; `estimateUsage` with `budgetTokens: 10_000_000` stays at 50% after a 17% check-in; `spawn`/`execFile` of a `.cmd` without a shell throws `EINVAL`.

---

## High

### 1. Budget gate can stall a queue forever

`schedule()` parks only when `admit()` returns a reset timestamp. `admit()` returns `until` only when a window is already **at or over** its target. A window that is **under** target but too tight for the next task (`n=0`, `until=null`) is skipped and left `queued`. Nothing wakes it: no task starts, so usage never reaches the target, so `nextResetWindows` never fires.

```165:171:core/tasks.mjs
    if (budget) {
      const windows = providerWindows(t.provider, t.model);
      const committed = (runningCost[t.provider] || 0) + (dispatched[t.provider] || 0);
      const a = admit(windows, [{ cost: perTaskCost(t) }], { runningCost: committed, maxParallel: 1 });
      if (!a.n) { // no headroom under the per-window targets (session 95% / weekly 100%): park until the window resets
        if (a.until) park(t, a.until, `provider ${t.provider} within its usage buffer (${a.reason}); waiting for reset`);
        continue;
```

```122:139:core/sweep.mjs
export function nextResetWindows(windows) {
  const full = (windows || []).filter((w) => (Number(w.usedPercent) || 0) >= targetFor(w) - 0.01 && w.resetsAt);
  return full.length ? Math.min(...full.map((w) => Number(w.resetsAt))) : null;
}
// ...
  if (free <= 0) return { n: 0, until: nextResetWindows(windows), reason: `no headroom (...)` };
  const g = planGreedy(pending.map((p) => p.cost || 0), { usedPct: 100 - free, bufferPct: 0, maxParallel });
  return { n: g.n, order: g.order, until: g.n ? null : nextResetWindows(windows), reason: g.reason };
```

Probed: 5-hour at 94% (target 95%), cost 2% → `{n:0, until:null}`. Weekly at 92% (target 100%), cost 10% → same. At 95% exactly, `until` is set and parking works.

`test/sweep.test.mjs:103–104` asserts `n===0` on the 94%/2% case and comments "park"; it does not assert `until`. The stall is untested.

Fix: if `!a.n`, park until `a.until || nextResetWindows(windows) || Date.now()+poll` (or re-queue on the next limits refresh). Do not `continue` a live `queued` task that can never admit.

### 2. Unknown-cost isolation is lost in the one-at-a-time loop

`planGreedy` will run a cost-0 task alone. `schedule()` calls `admit` with a **single** pending task, then:

```173:173:core/tasks.mjs
      dispatched[t.provider] = (dispatched[t.provider] || 0) + perTaskCost(t);
```

`perTaskCost` is 0 when the scorecard has no window delta. The next queued task of the same provider is admitted the same way. Up to `maxWorkerConcurrency` (default 8) unmeasured tasks start together on a provider that reports windows. That is the opposite of `planGreedy`'s "unknown cost: one probe alone" (`core/sweep.mjs:81`) and of the architecture note.

Fix: treat cost 0 as occupying the remaining free headroom for this pass (`dispatched[p] += free` or skip further same-provider tasks once a probe is dispatched).

### 3. Windows: vendor CLIs put the full prompt on argv; only Grok has an escape hatch

Architecture: prefer stdin for long prompts. Codex does (`core/workers/codex.mjs:73`). Vendor runner has `stdinPrompt` (`core/workers/vendor-cli.mjs:38,70`) but **no spec sets it**.

| Vendor | Prompt transport | Windows-safe? |
|---|---|---|
| grok | `-p` if `length <= 8000`, else `--prompt-file` in `tmpdir` | yes, threshold is conservative vs CreateProcess 32 767 |
| agy | `-p`, t.prompt (`vendors.mjs:90`) | no |
| kimi | `-p`, t.prompt (`vendors.mjs:192`) | no |
| qwen-code | prompt as argv[0] (`vendors.mjs:163`) | no |

A worker prompt is `worker.md` + `msw.md` (~4 k) plus optional recipe (modeling default 8.7 k) plus CONTEXT plus spec. Real tasks blow 8 k; large ones blow 32 k. Grok's own comment at `vendors.mjs:134–136` records the failure mode (instant empty result).

The prompt-file Grok writes is never unlinked.

### 4. Windows: `findCli` prefers `.cmd`, then `spawn`/`execFile` without a shell

```8:16:core/proc.mjs
export function findOnPath(name) {
  const exts = WIN ? ['.cmd', '.exe', '.bat', ''] : [''];
```

```38:38:core/workers/vendor-cli.mjs
    try { child = spawn(bin, args, { cwd: t.cwd, windowsHide: true, stdio: [spec.stdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, ...(spec.env?.() || {}) } }); }
```

`capture()` in `vendors.mjs:19–22` uses `execFile` the same way (auth probes, `agy /usage`, model lists).

Probed on this box: `spawn(hello.cmd)` and `execFile(hello.cmd)` both throw `Error: spawn EINVAL`. Codex unwraps `.cmd` to `node + codex.js` (`proc.mjs:56–61`). Vendor CLIs do not. `qwen-code` is an npm global (`qwen.cmd`). Detect, poll, and run all fail on that shim.

---

## Medium

### 5. `runningCost` is per provider, not per window / model group

`tasks.mjs:157–168` sums measured cost of every in-flight task on `t.provider` and subtracts it from the **current** model's headroom. Antigravity Gemini % is not Claude/GPT %. A Claude task's 10% of the 3p window is charged against Gemini's 5-hour headroom. Conservative over-block, not a leak, but the gate is not sound for grouped windows. `measuredCost` already honours `w.models` (`sweep.mjs:35–36`); the scheduler's running tally does not.

### 6. Two planners, two policies; architecture describes the old one as the new one

`planBatch` / `nextBatch` still use a flat `bufferPct=25` (`sweep.mjs:18–26,50–51`). `admit` / `planGreedyWindows` use session 95% / weekly 100% (`sweep.mjs:101–120`). Production dispatch uses only `admit`. `nextBatch` is test-only. `docs/ARCHITECTURE.md:194–196` still says `planBatch` sizes from `targetFor`. Cookiebench-trace (named as the first planner client) is not in this tree.

The 95/100 split itself is coherent: `isSession` is label `/hour|session/i` **or** `windowMinutes <= 600`. Codex weekly (`windowMinutes: 10080`, label `… weekly`) correctly targets 100%. Claude `5-hour` / Antigravity `… 5-hour` correctly target 95%. A label of `5h` with no `windowMinutes` would target 100% — Codex avoids that by always setting `windowMinutes` (`providers/codex.mjs:65–68`).

`classCap` (recommend) and `admit` (dispatch) are a second split: included class cap is 100, admit session target is 95. Recommend can pick a provider that admit then parks. Harmless if parking works; combined with finding 1 it is not.

### 7. `refreshLimits({only})` coalesces onto whatever poll is already in flight

```30:33:core/limits.mjs
export function refreshLimits({ only = null } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const targets = Object.values(PROVIDERS).filter((p) => p.pollLimits && (!only || only.includes(p.id)));
```

A scorecard `refreshLimits({only:['codex']})` makes a subsequent full UI refresh return the Codex-only result. Other providers go stale until the next interval.

### 8. Context injection uses a prefix `startsWith` without a separator

```19:19:core/context.mjs
    while (d.startsWith(root)) { dirs.add(d); if (d === root) break; d = dirname(d); }
```

`isInside` next to it uses `r + sep`. On Windows `F:\proj-backup\src` starts with `F:\proj`. A worker given an absolute path (or `..`) can ingest a sibling tree's `CONTEXT.md` / `CLAUDE.md`. `openai-compat` tools are correctly sandboxed; this path is not.

### 9. Kimi binary lookup is pinned to Python 3.12

```16:16:core/providers/vendors.mjs
const pyScripts = WIN ? [join(process.env.APPDATA || '', 'Python', 'Python312', 'Scripts'), join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts')] : [join(home, '.local', 'bin')];
```

`py -3` / 3.11 / 3.13 / 3.14 user-scripts dirs are ignored. If `kimi` is not already on PATH, detect reports not installed.

### 10. Secrets

**Keys in `config.json` / `publicConfig()`:** API keys are redacted to `••••` (`config.mjs:124–131`). The settings UI skips blank/`••••` password fields (`ui/app.js:466`). Direct `POST /api/settings` of a GET body would persist `apiKey: "••••"` as the real key (`saveConfig` deep-merges with no sentinel). Bound to 127.0.0.1 with origin/host checks (`server/index.mjs:249–252`).

**Not redacted:** `mcpServers.*.env` (and inherited Codex/Claude MCP env) round-trip through `GET /api/state` and `GET /api/settings`. `publicConfig()` only walks `providers.*.apiKey`.

**Feedback bundle:** `redact()` strips home, username, emails, and `sk|xai|ghp|gho|github_pat|AIza|key|token` plus labeled `authorization/api_key/token/secret/password` (`feedback.mjs:19–26`). Misses `ghs_` / `ghu_`, unlabeled bearer tokens, and MCP env values that are not key-shaped. The bundle includes the improvement log (`feedback.mjs:40`); worker/HTTP errors are sliced to 4 k and not pre-redacted (`improve.mjs:16`, `tasks.mjs:217`, `openai-compat.mjs:119–120`). `redact()` runs on the JSON text, so `sk-…` in an error still gets caught.

**Live surfaces:** SSE ring (2000 events, `bus.mjs:7–16`) replays worker tool I/O unredacted. `GET /api/tasks/:id` returns the full spec (`server/index.mjs:121`). Localhost-only, but anything on the box can read it. Grok `--prompt-file` leftovers in `%TEMP%` are the full worker prompt.

**Claude OAuth:** `oauthToken()` (`providers/anthropic.mjs:83–91`) is used only as an Authorization header to `api.anthropic.com`; not logged.

---

## Low

- `writeJson` `renameSync` over an existing file (`paths.mjs:21–26`) can `EPERM` on Windows if another handle has the dest open (limits/config/session journals).
- UI rate-limit toasts always do `utilization * 100` (`ui/app.js:397`). Poll path stores 0–100 (`anthropic.mjs:127`, `test/limits.test.mjs:28–32`); events store 0–1 scaled in `windowFromEvent` (`anthropic.mjs:144`). Toast is event-only, so currently OK; a 0–100 event would display 4200%.
- `park` caps `setTimeout` at `2**31-1` (`tasks.mjs:182`) — correct.
- Plans cap at 200 tasks (`plans.mjs:8,112`) and throw mid-run.

---

## (2) Per-window target logic — is it sound?

**The arithmetic is sound** for a single window and known costs:

- `targetFor`: session 95, else 100.
- `headroomFor`: min over windows of `target - usedPercent`.
- `admit`: `free = headroom - runningCost`, then greedy fill with `bufferPct: 0`.
- Empty windows → headroom 100 → `admit([], [{cost:5}]).n === 1`. Grok/Ollama are **not** gated. `limitsWithEstimates()` is a copy for HTTP only (`server/index.mjs:167–178`); `providerWindows` reads `getLimits()` (`scorecard.mjs:307–311`). The advisory contract for dispatch holds.

**It is not sound as a scheduler** because of findings 1, 2, and 5: no park when under-target-but-too-tight; unknown costs do not consume the pass; mixed model-group percents.

`usedPercent == null` is treated as 0 (`sweep.mjs:110`) — optimistic admit.

After a run, `schedule()` in `finally` (`tasks.mjs:228`) runs **before** `score()`'s async `refreshLimits` (`tasks.mjs:251–252`). In-flight `runningCost` drops immediately; live `usedPercent` does not rise until a poll. Combined with finding 1, a just-finished provider can look "tight but not full" on stale data.

---

## (5) Usage-estimate advisory model

Design: token spend since a 6 h activity gap, optional OLS-through-origin from check-ins, **never fed to `admit`**. That last part is true.

The default `scorecard.usageBudgets.grok = 10_000_000` (`config.mjs:66`) makes the rest of the design dead for the one provider it exists for:

```47:53:core/usage-estimate.mjs
export function estimateUsage(provider, { now = Date.now(), budgetTokens = null, seedPctPerMToken = null, resetsAt = null } = {}) {
  const { spent } = windowTokens(provider, now);
  const obs = windowObservations(provider, now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (budgetTokens) { // flat budget: 100% at budgetTokens, advisory
    const pct = Math.max(0, Math.min(100, (spent / budgetTokens) * 100));
    return { pct: ..., basis: 'budget', anchorPct: obs.at(-1)?.pct ?? null, points: obs.length, calibrated: true, advisory: true, resetsAt };
```

`limitsWithEstimates` always passes that budget (`server/index.mjs:173–174`). Probed: 5 M tokens + check-in 17% → budget path **50%**, fit path **17%**. The UI "Calibrate" button (`ui/app.js:87–91`) records a check-in that does not move the meter.

Other model issues (all advisory-only, so they mislead the UI / conductor-looking-at-the-sidebar, not dispatch):

- `GAP_MS = 6h` is not a Grok window. Idle 6 h inside a weekly window looks like a reset; a 5 h window with no 6 h gap never resets in the estimate.
- `calibrated: true` whenever `budgetTokens` is set, including zero check-ins.
- Conductor `limits` tool uses `getLimits()` (`tools.mjs:34`) — "no windows reported" — while the UI shows `~est`. Split-brain.

The 10 M figure has no measured source in this repo.

---

## Rejected claims (one line each)

- "Empty-window providers are gated by the estimate." — they are not; `getLimits()` has no synthetic windows.
- "Replace 95/100 with a single buffer." — the split matches the stated policy; the bug is parking, not the targets.
- "Feedback bundle dumps raw API keys." — key-shaped strings are redacted; MCP env and non-matching tokens are the real gap.
- "planBatch 25% buffer is the live gate." — it is not; `admit` is.
