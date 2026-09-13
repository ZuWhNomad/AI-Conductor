# Conductor 2.0 — Grok convergence pass (general)

Read-only review of the post-fix tree (HEAD `9e8acb4` and the prior ~9 commits on `core/`, `bin/`, `ui/`). Lens: remaining correctness or fix-induced regression. Not a re-litigation of issues the recent commits actually closed.

`node --test`: **136 pass / 0 fail**. Probes used an isolated `CONDUCTOR_HOME` (never `~/.conductor2`).

**Convergence signal: not clean.** One remaining **P2** (probe-confirmed). No P1.

---

## Ranked findings

### 1. P2 — Window scoping is only half-applied: a maxed *scoped* Claude window still hard-blocks the whole provider

**Files:** `core/providers/anthropic.mjs:147` (`blocked`), `core/limits.mjs:68-74` (`earliestReset` / `mergePoll`), `core/limits.mjs:118-123` (`blockedUntil`), `core/tasks.mjs:170-171` (`schedule` park), `core/scorecard.mjs:314` (`providerAvailable`).
**Confidence: HIGH** (probed).

Commit `9e8acb4` generalized family scoping so `seven_day_opus` / `seven_day_sonnet` / `seven_day_fable` / `model_scoped[]` carry a `models` field. That part works:

| Model | Windows seen after `normalizeUsage` |
|---|---|
| `claude-fable-5-1[1m]` | `five_hour`, `seven_day`, `seven_day_fable`, `model:Fable` — **not** Opus weekly |
| `claude-opus-4-7` | `five_hour`, `seven_day`, `seven_day_opus`, `model:Opus` |

`admit` / `providerWindows` therefore no longer charge Fable against an Opus bucket.

The live **block** path was not updated. `normalizeUsage` still sets

```js
blocked: windows.some((w) => (w.usedPercent ?? 0) >= 100)
```

over **every** window, scoped or not. `mergePoll` copies that onto `blockedUntil`. `schedule()` parks on `blockedUntil(t.provider)` **before** it looks at per-model windows. `providerAvailable` returns false on the same flag with no model argument.

**Failure scenario (probed):** poll/limits with `seven_day_opus` at 100%, `five_hour` 40%, `seven_day` 55% (Fable weekly untouched). Then:

- `blockedUntil('claude')` is the Opus reset timestamp.
- `providerAvailable('claude', { model: 'claude-fable-5-1[1m]' })` is **false**.
- `schedule()` of a Fable task → **`parked`**, error `provider claude is at its usage limit`.

Fable (the default conductor model) and Sonnet workers stop until the *Opus* weekly resets, even though their own buckets have room. Recommend will not hand Claude any new work (`blockedUntil` short-circuits). This is the user-visible half of prior BUD1; the `models` field does not reach it.

The tests cover Fable **label** scoping (`providerUsedPct`) and conductor **session-only** caps; they never set `blocked: true` from a scoped window, so this hole is green.

Fix (not applied): derive `blocked` / `blockedUntil` from windows that apply to the model in question (or stop hard-parking on a scoped window — sequential-throttle + failover already handle a real provider limit). `blockedUntil` needs a model, or `schedule` must use `providerWindows` instead of the whole-provider flag.

---

## What holds (checked so it is not re-opened)

**Scheduler / planner**

- Over-target `admit` → `n=0` no longer stalls the queue. `schedule()` degrades to one-in-flight per provider and keeps issuing (`tasks.mjs:180-186`). No livelock, no drop, no same-id double-dispatch (status flips to `running` synchronously before the next queued item).
- Missing-key probe gate holds: `isUnmeasured` + `probing[provider]` admits one unmeasured windowed task and holds the rest. Windowless providers (grok/ollama) stay ungated, as documented.
- Per-window costs: 13% of 5h + 3% of weekly fits; charging 10% of a 9% weekly headroom does not. Grouped Antigravity running tally is per window id.
- Concurrency divisor (`run()` `tasks.mjs:207-215`) now counts only co-runners that share a window id. A Gemini 8% delta with `concurrent: 0` records 8%/task. (Old rows that stored cross-group `concurrent: 3` still divide 8/4=2; that is ledger history, not the live counter.)

**`wasteDiscount`**

- Scoped to `subscription` / `included` only; conductor and API return 1.
- 5-hour / session windows ignored; past reset ignored; full window (0 headroom) → 1.
- Default-path values in `(0, 1]`. Near-reset unused weekly → ~0.10 with `wasteStrength` 0.9. No divide-by-zero on a finite horizon. Quality bar (`quality ≥ 0.75`) still gates finals; a discount cannot promote a failing model.

**Security**

- SSRF: loopback, `localhost`, `::1`, link-local/metadata `169.254.169.254`, RFC1918, CGNAT `100.64/10`, `0.0.0.0`, multicast v4, IPv4-mapped v6, `file://` — all blocked. WHATWG canonicalizes `127.1` / `0x7f000001` / `2130706433` / `0177.0.0.1` to `127.0.0.1` before the check. Redirects are manual and re-checked per hop. Fail-closed on NXDOMAIN.
- `spawnCli` / `resolveNpmShim` / `winArgEscape`: npm `.cmd` unwraps to `node <entry>` with argv verbatim (test + this machine).
- `shellDenied` still rejects `& | ; ` $() <>` chaining and prefix-of-name tricks. Default `worker.shell` is the allow-list, not `true`. `allow_command` refuses shells (`bash`/`cmd`/`pwsh`/`env`/`wsl`/`ssh`).

**Anthropic family scoping (the half that landed)**

- `familyRe` on window key and `model_scoped.display_name` sets `models: opus|sonnet|haiku|fable`. Global `five_hour` / `seven_day` stay unscoped. New family-named keys (e.g. `five_hour_opus`) would be picked up without a code edit.

**Config / paths / limits / models**

- `publicConfig` masks MCP URL userinfo and query values.
- `saveConfig` drops `••••` sentinels for `providers.*.apiKey` and `mcpServers.*.env`.
- `writeJson` retries atomic rename only; no truncate-in-place fallback.
- `limits.mjs` and `models.mjs` both key in-flight polls by scope (`*` vs `only` list).
- Canceled tasks are no longer scored (`tasks.mjs:244`).

---

## P3 / residual (one line each; do not block convergence)

- `saveConfig` does not drop a masked MCP `url`; posting `publicConfig` back overwrites the real URL with `••••`. The settings UI does not currently send `mcpServers`, so the form path is safe.
- `wasteDiscount` is unclamped against `usedPercent < 0` (factor can go negative) and unvalidated `wasteHorizonHours: NaN` (factor NaN → those plans drop out of `recommend`). Neither is a shape providers emit.
- `models.mjs` snapshots the whole cache at refresh start; a scoped refresh finishing after a full one can clobber other providers until the next poll (limits.mjs merges per id after `getLimits()`; models does not).
- Allow-list `run` false-positives: `python -c "print(1); print(2)"`, `git commit -m "a; b"`, `npm run build && npm test` are blocked by `;`/`&`. Interpreters already on the default list (`python`, `node`) can still run arbitrary host code without those operators — documented trade-off, not a bypass of the recent fix.
- `familyRe` stores a bare `opus` string used as `/opus/i`, so any model id containing that substring inherits the Opus weekly window.

---

## Rejected claims (do not fix)

- `admit` `{n:0, until:null}` under a 95% session target with a 2% task — true of `admitPerWindow`, but `schedule()` no longer parks on `until`; it sequential-throttles. Old SC1 is gone on the live path.
- Poll `utilization` 0.85 stored raw vs event path rescaling 0.85→85 — tests assert poll `42` stays `42` and events `0.5` become `50`. Dual-scale is the tested contract; unifying them would break one path. Live SDK poll scale not re-verified here.
- `wasteDiscount` preferring a weaker same-class model whose weekly is about to reset — that is the stated use-it-or-lose-it policy, and failing models still cannot be finals.
- Zero-valued measured costs (`pct` delta 0) dispatch as “fits” rather than as probes — matches the “missing key = unmeasured” spec; integer-percent granularity, not a gate hole.

---

## Ranked summary

1. **P2 / HIGH** — `blocked` / `blockedUntil` / `schedule` park / `providerAvailable` still treat a 100% *scoped* Claude window as a whole-provider outage. Fable (and Sonnet) tasks park until the Opus weekly resets. Window *filtering* from `9e8acb4` is correct; the hard-block path was not updated. Probe-confirmed.

No P1. One P2 remains, so this is **not** the convergence stop. Everything else scrutinized in this pass (probe gate, sequential throttle, wasteDiscount bounds, SSRF, shim spawn, writeJson, sentinel redaction, scope-keyed refreshes) holds.
