# Conductor 2.0 — General Correctness & Design Review (Opus 4.8)

Scope: `core/` engine, `core/workers/`, `core/providers/`, `server/`, `ui/app.js`. Lens: general
correctness & design (bugs, edge cases, races, state integrity, parsing, resource leaks). Security /
hardcode / framework / budgeting lenses deliberately not duplicated. Read-only; nothing changed.
`npm test` (135) is green; tests were read to gauge coverage. Findings ranked by severity.

Confidence: **high** = traced through the code precisely; **medium** = path clear, real-world trigger
or an external API shape not verified here; **low** = suspicion.

---

## P2 — Canceled tasks are scored into the scorecard and skew cost/selection

**Files:** `core/tasks.mjs:236`, `core/scorecard.mjs:62-73` (`recordRun`), aggregation
`core/scorecard.mjs:115-201`. **Confidence: high.**

`run()` scores every terminal task except limit hits:

```js
if (TERMINAL.has(t.status) && !t.limitHit) score(t, limitsBefore, concurrent);   // tasks.mjs:236
```

`TERMINAL = {done, failed, canceled}`. When the conductor/user calls `cancelTask`, the worker is
aborted; every worker runtime **returns** `{ok:false, error:'aborted'}` on abort (codex.mjs:25,
claude.mjs:12/60, openai-compat.mjs:132, vendor-cli.mjs:46), so `run()` reaches line 218
(`if (t.status === 'canceled') { /* keep */ }`), keeps `status:'canceled'`, then falls through to
line 236 and **scores it**. `recordRun` has no status guard (only `if (t.imageOptions) return`), so a
`op:'run'` row is written for the canceled task.

Failure scenario: a task is canceled after ~10s having done little work. If a Codex turn never
completed, `t.result.usage` is null → `normalizeUsage` → `tokens:null`. In `summarize`/`rootRuns` the
canceled attempt gets `verdict:null` (not counted as a fail, correctly) **but its tokens/pct/duration
are folded into the group means** (`_tok`, `_usd`, `_pct`, `_dur` at scorecard.mjs:181-184). A
near-zero-token canceled run drags `avgUsd` **down**, and `costOf(g)` (scorecard.mjs:221) uses
`g.avgUsd`, so the model looks cheaper than it is → higher utility → **over-selected** by
`recommend`. The row is also returned by `runRows()` and feeds `measuredCostByWindow` in the budget
gate (its `pct` is real if the aborted run consumed any quota).

`limitHit` runs are explicitly excluded from scoring for exactly this reason; canceled runs should be
too. Fix: add `&& t.status !== 'canceled'` to the line-236 gate (or exclude `status:'canceled'` rows
in `rootRuns`). Confirmed by tracing; not currently covered by a test.

---

## P2 — `conductor review` re-runs a live server's journaled tasks (no open-task guard)

**Files:** `bin/conductor.mjs:132-144` (`review`), vs `bin/conductor.mjs:78-79` (`bench --run`) and
`110-111` (`smoke`); `core/tasks.mjs:31-39` (journal reload), `147` (`schedule`). **Confidence: high
on the code path; medium on real-world frequency.**

The task journal is shared on disk but each process keeps its own in-memory `Map` and its own
scheduler. On module load, `tasks.mjs` reads **every** `tasks/*.json` and resets `running`/`parked` →
`queued` + `resume`. `smoke` and `bench --run` guard against a running server by refusing to start when
the journal holds open tasks:

```js
const open = listTasks(...).filter((t) => !['done','failed','canceled'].includes(t.status));
if (open.length) { console.error('refusing to run: ... a running server owns them'); process.exit(2); }
```

`conductor review` has **no such guard**. It calls `runOnce` → the conductor delegates → `createTask`
→ `schedule()`, which iterates *all* queued tasks in this process's Map — including the server's
pre-existing queued/parked tasks (now reset to `queued`). Both processes then spawn workers for the
same task ids and `persist()` (writeJson) the same files concurrently → **double execution + racing
journal writes**. The developers clearly know the hazard (the two other commands guard it and
MEMORY notes "one smoke process at a time"); `review` was missed. Same point-in-time weakness affects
smoke/bench if the server is momentarily idle at their startup check and then receives a delegation.

Fix: apply the same open-task guard to `review`, or add a cross-process lock file in `stateDir()`.

---

## P3 — `refreshModels` coalesces scoped and full refreshes into one promise

**File:** `core/models.mjs:16-17`. **Confidence: high.**

```js
let inflight = null;
export function refreshModels({ only = null } = {}) { if (inflight) return inflight; ... }
```

Unlike `limits.mjs`, which keys in-flight polls by scope (`inflightByScope`, limits.mjs:14/34), this
coalesces **all** calls regardless of `only`. Scenario: a background `refreshModels({only:['ollama']})`
(from `install_model`/`pullModel`) is in flight when the UI "Refresh" button calls `refreshModels()`
(full). The full refresh returns the ollama-only promise and **silently never re-polls the other
providers**; the registry stays stale until the next 15-min poll. Fix: key `inflight` by scope like
limits.mjs does.

## P3 — `saveConfig` freezes all defaults onto disk; future default changes never reach the user

**File:** `core/config.mjs:135`. **Confidence: high.**

```js
const next = normalize(deepMerge(loadConfig(), clean));  // loadConfig() is already DEFAULTS-merged
writeJson(FILE(), next);
```

Because `loadConfig()` returns the fully DEFAULTS-merged config, saving *any* setting once writes the
**entire** config (every default inlined) to `config.json`. From then on, every future change to
`DEFAULTS` (new models, changed caps, new scorecard knobs) is shadowed by the stale value baked into
the user's file — an upgrade silently has no effect on keys they never touched. Fix: persist only the
diff against `DEFAULTS`, or store the raw patch and merge at read time.

## P3 — Unbounded ndjson ledgers re-parsed in full on hot paths

**Files:** `core/tasks.mjs:154` (`runRows()` per `schedule()`), `core/scorecard.mjs:101/104-105`
(`readNdjson` whole file), `recommend`→`summarize`→`rootRuns` per `delegate`; `usage-estimate.mjs`
per limits render. **Confidence: high.**

`scorecard.ndjson`, `improvements.ndjson`, `usage-observations.ndjson` never rotate. Every
`schedule()` pass (each task create/finish) calls `runRows()` which reads and JSON-parses the entire
scorecard ledger; every `delegate` auto-pick folds the whole ledger into chains. On a long-lived
instance with thousands of runs this is O(ledger) per scheduling decision — steadily growing latency,
not a crash. Fix: cache parsed rows with an mtime check (as `limits.mjs`/`getLimits` already does), or
compact/rotate the ledger.

## P3 — SSE gap larger than the 2000-event ring buffer is lost with no resync

**Files:** `ui/app.js:366-369,379`, `core/bus.mjs:6-23`, `server/index.mjs:71-81`. **Confidence:
medium.**

On error the client does `es.close(); setTimeout(connect, 2000)` and reconnects with
`?since=S.lastSeq`. The server replays `bus.since(lastSeq)` from a **2000-entry ring**. If more than
2000 events were published during the disconnect, everything between `lastSeq` and
`newestSeq-2000` is dropped, and the client has no way to notice (only a *boot-id* change triggers a
full `resync()`; a seq gap does not). Session transcript deltas would be permanently missing until a
manual refresh. The `coalesce`d refetches for models/limits/settings/improvements mask it for those
panels, but not for chat/task streams. Fix: have the server include the oldest retained seq in the
`hello`/reconnect payload and force `resync()` when `since` precedes it.

## P3 — `onLines` has no maximum line length

**File:** `core/proc.mjs:134-147`. **Confidence: low/medium.**

`buf` accumulates until a `\n` is seen. A provider/CLI that emits a very large payload on a single
line (or never newline-terminates) grows `buf` without bound until the stream ends. In practice
bounded by output volume, but a pathological/hostile stream could balloon memory. Fix: cap `buf`
length and flush/emit-or-drop past a ceiling.

---

## Notes / lower-value observations (not ranked)

- **`bus.setMaxListeners(100)`** (bus.mjs:27): each SSE connection adds one `event` listener (cleaned
  up on `req.on('close')`, so no leak), plus internal per-module listeners. >~100 concurrent
  browser tabs would emit MaxListeners warnings. Fine for a local single-user tool.
- **`installGlobalErrorCapture`** (improve.mjs:43-45) swallows `uncaughtException`/`unhandledRejection`
  without exiting — deliberate for a local server, but leaves the process in possibly-undefined state;
  if `logImprovement`→`appendNdjson` itself throws inside the handler (disk full), the process crashes.
- **`isInside`** (context.mjs:62-65) compares resolved paths case-sensitively and does not `realpath`.
  On Windows a legitimate path differing only in drive-letter/segment case is wrongly rejected
  ("path outside project"); a symlink inside cwd pointing out passes. (Symlink escape is the security
  lens; the case-sensitivity is a correctness nuisance.)
- **`deepMerge` null-handling** (config.mjs:91): `b === null && plain(a)` returns `a`, so a nested
  object can never be nulled through `/api/settings`. `mcpServers: { name: null }` removal is handled
  elsewhere (mcp.mjs), so benign, but worth knowing.
- **codex `resetsAt: w.resetsAt * 1000`** (providers/codex.mjs:68) and Claude `resets_at` parsing
  assume seconds; unverified against the live app-server/usage API shapes. `windowFromEvent`
  (anthropic.mjs:144) *does* auto-detect ms-vs-s, so the surfaces are handled inconsistently by design
  — confirmed correct for the poll path by test/limits.test.mjs (utilization 42 → 42%).
- **`turnEventMapper` dedup scan** (conductor.mjs:328): `s.messages.some(...)` scans up to 2000
  messages every loop-runtime turn. Minor.
- **`extractJson`** (plans.mjs:33) bare-object fallback does `lastIndexOf('{')` then `JSON.parse` from
  there — fine for a trailing object, silently null for a `{` mid-prose; acceptable given the fenced
  path runs first.

## What is solid (verified, not a bug)

- `writeJson` atomic-rename with EPERM/EBUSY retry and tmp preservation (paths.mjs) is careful and
  correct; retry loop is bounded.
- `pump()` restart-on-`restartPending` correctly guards against clobbering a freshly-started query via
  the `s.query === q` checks in the loop's `finally` (conductor.mjs:227-232, 250-253).
- The `models` shared-variable reassignment in `refreshModels`'s `Promise.allSettled` is **not** a
  lost-update race: the read-filter-concat-assign is synchronous (the only `await` precedes it).
- `refreshLimits` coalesces per scope and re-reads the file (`getLimits`) before merging, so in-process
  polls don't clobber each other; cross-process last-writer-wins is acknowledged and mitigated by the
  15-min re-poll.
- `awaitTask`'s self-referential `done` in the timeout filter is safe (deferred closure).
- Worker abort/timeout paths clear timers, remove abort listeners, `killTree` the process tree, and run
  `cleanup()` for temp prompt files (vendor-cli.mjs, codex.mjs, openai-compat.mjs) — no obvious
  timer/child/handle leaks.
- `normalizeUsage` inclusive-vs-exclusive input handling is correct across codex/claude/loop/vendor
  shapes and matches the `exclusive` flag set by `usageInputExclusive` providers.
