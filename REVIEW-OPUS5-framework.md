# Conductor 2.0 — Framework / Guidelines Adherence Review

Lens: does the code follow the project's own stated rules (CLAUDE.md / AGENTS.md) and the
contracts in `docs/ARCHITECTURE.md`? Read-only; no code changed.

Reviewer: Opus 4.8 · 2026-09-13

## Verdict

The hard, security-relevant invariants are honored across the board: two runtime
dependencies and nothing else, no build step, secrets redacted everywhere they reach a
client, and Windows-first shell-less spawning. The gaps are documentation/consistency drift,
not correctness or safety. The one systematic violation is CONTEXT.md coverage.

---

## Findings (ranked)

### 1. CONTEXT.md is missing from almost every folder — including the two most contract-heavy ones
**Severity: Medium · Confidence: High**
**Guideline:** CLAUDE.md / AGENTS.md — "When you add a folder or module, add a short
`CONTEXT.md` (purpose, entry points, invariants, how to test)."

Present: `core/recipes/CONTEXT.md`, `core/smoke/CONTEXT.md`, `test/CONTEXT.md` (all three are
accurate and current — the symbols they cite exist).

Missing:
- `core/` (the top-level engine: ~25 modules, the bulk of the system)
- `core/providers/` and `core/workers/` — the exact two directories CLAUDE.md's "Adding a
  provider" instructions point a new contributor at. A contributor following the docs lands in
  dirs the docs say should be self-describing and finds nothing.
- `core/prompts/`, `server/`, `ui/`, `bin/`, `scripts/`, `docs/`

**Why it matters:** the CONTEXT.md convention is one of only ~9 rules the project states about
itself, and it is also load-bearing at runtime — `core/context.mjs` injects the nearest
CONTEXT.md into worker specs, so missing files mean workers touching `core/providers` or
`server` get no scoped guidance. The rule is being followed for two small leaf dirs and skipped
for the whole core.
**Fix:** add a short CONTEXT.md to at least `core/`, `core/providers/`, `core/workers/`,
`server/`, and `ui/`; the provider/worker ones can lift the contract text that already lives in
the header comments of `core/providers/index.mjs:1-2` and `core/workers/index.mjs:1`.

### 2. Doc/code drift: ARCHITECTURE says `admit` parks over-target tasks until reset; the code deliberately does not park
**Severity: Medium · Confidence: High**
**Contract:** `docs/ARCHITECTURE.md:204-208` — "`schedule()` calls `admit(...)` before
dispatching ANY queued task: it sizes how many tasks of a provider may start now under the
per-window targets ... and **parks the rest until the binding window resets**
(`nextResetWindows`)."

Actual behavior in `core/tasks.mjs:181-189`: when `admit` returns `n=0` (over the per-window
target) or the cost is still unmeasured, the scheduler explicitly comments "we DON'T pause" and
"Never a queued-forever park" — it degrades to **sequential-per-provider** and keeps issuing,
holding a task only while that provider already has one in flight, and relies on real-limit
**failover** downstream. Parking to `nextResetWindows` happens on the *known-blocked* path
(`core/tasks.mjs:171-172`, `blockedUntil`), not on the per-window-target overflow the doc
describes.

**Why it matters:** this is precisely the "docs describe the gate doing X, code does Y" drift
the review brief flagged (the planBatch-vs-admit example). The behavioral difference is
material — "park until reset" vs "keep dispatching sequentially and fail over" are different
budget policies — and a reader trusting ARCHITECTURE.md would mis-model the system.
**Fix:** update ARCHITECTURE.md:204-208 to describe the actual policy (over-target ⇒ serialize
per provider + rely on failover; hard-park only on a known block / no-headroom), or reconcile
the code to the doc. The code's behavior looks intentional, so the doc is the thing to fix.

### 3. Stale ARCHITECTURE directory map
**Severity: Low · Confidence: High**
**Contract:** `docs/ARCHITECTURE.md:46-71` "Directory map".

Modules that exist but are absent from the map: `core/bench.mjs`, `core/feedback.mjs`,
`core/recipes.mjs` + the whole `core/recipes/` dir, `core/session-flags.mjs`,
`core/update.mjs`, `core/usage-estimate.mjs`, and the top-level `scripts/` dir.
(`core/plans.mjs` and `core/sweep.mjs` have their own prose sections but are also missing from
the map itself; `core/priors.mjs` is referenced only in the scorecard prose.)
**Why it matters:** the map is the first orientation a contributor (or a delegated worker)
gets; a third of `core/` is invisible in it.
**Fix:** regenerate the map from `core/*.mjs`.

### 4. `codex` provider module omits the `kind` export the contract requires
**Severity: Low · Confidence: High**
**Contract:** CLAUDE.md "Adding a provider: one module in `core/providers/` exporting
`id, label, kind, auth, detect(), listModels(), pollLimits()`."

`core/providers/anthropic.mjs:12` and `core/providers/ollama.mjs:13` export `kind`.
`core/providers/codex.mjs` does not; the registry patches it in at
`core/providers/index.mjs:39` (`codex: { ...codex, kind: 'codex' }`). So the one provider whose
`kind` equals its `id` is the one that violates the stated module shape, and the registry
silently compensates.
**Why it matters:** minor, but it means the documented "export these 7 things" contract is not
actually uniform, and a `kind`-derived check that trusts the module (rather than the registry
entry) would misbehave for codex.
**Fix:** add `export const kind = 'codex';` to `core/providers/codex.mjs` and drop the spread
patch in `index.mjs:39`, so every provider module is self-describing.

### 5. "Prefer stdin for long prompts" is honored only by the Codex worker; vendor CLIs pass the full prompt as an argv value
**Severity: Low · Confidence: Medium**
**Guideline:** CLAUDE.md "Windows first: spawn CLIs without a shell (see `core/proc.mjs`);
prefer stdin for long prompts."

`core/workers/codex.mjs:73` correctly feeds the prompt on `child.stdin.end(t.prompt)`.
Among the subscription CLIs, only `grok` mitigates a large prompt, and it does so with a temp
`--prompt-file` (`core/providers/vendors.mjs:146`) rather than stdin — with a comment noting a
large `-p` arg "fails on Windows (command-line length limit)". `antigravity`, `qwen-code`, and
`kimi` all pass `t.prompt` as a `-p`/positional argv value
(`vendors.mjs:97, 171, 200`), which hits the same Windows limit grok documents, with no
fallback.
**Why it matters:** the guideline exists because of the exact failure grok's comment describes;
three of four vendor CLIs don't follow it. It hasn't bitten yet only because vendor specs are
newer/less exercised.
**Fix:** where a vendor CLI supports stdin, use it; otherwise apply grok's `--prompt-file`
pattern past a threshold. (Genuinely blocked when a CLI supports neither — worth a note in the
vendor spec if so.)

### 6. (Nit) Full assistant-message text is published to the bus un-truncated
**Severity: Nit · Confidence: Medium**
**Guideline:** CLAUDE.md "Keep payloads small; the ring buffer replays the last 2000."

Tool inputs/outputs are sliced (300 / 2000 / 4000 chars — `core/workers/codex.mjs:101,104`,
`core/workers/vendor-cli.mjs:85-86`, `core/workers/claude.mjs:71`), but `agent_message` text is
emitted verbatim (`core/workers/claude.mjs:45`, `core/workers/vendor-cli.mjs:84`). A long model
message therefore sits full-length in the 2000-entry ring and replays to every late SSE
subscriber.
**Why it matters:** low — this is the content the UI must actually render, so truncating it is
undesirable; noted only for completeness against the "small payloads" rule. No change
recommended unless replay memory becomes a concern (then cap replay by bytes, not count).

---

## Verified clean (coverage the caller can rely on)

- **Dependencies:** only `@anthropic-ai/claude-agent-sdk` (4 imports) and `zod` (1) are imported
  anywhere in `core/ server/ bin/`; zero other bare imports; no `require()`. `package.json`
  lists exactly those two. (CLAUDE.md two-deps invariant: PASS.)
- **No build step:** no TS, no bundler/`*.config.js`/babel; `.mjs` throughout; Node `>=22`
  engine pin. `scripts/build-launcher.cmd` builds a Windows launcher, not the app. (PASS.)
- **Secrets:** `publicConfig()` (`core/config.mjs:141-149`) redacts `providers.*.apiKey` and every
  `mcpServers.*.env` value; it is used on every client-facing path
  (`server/index.mjs:69,126,127`); `saveConfig` guards the mask from round-tripping
  (`config.mjs:132-134`); no secret is logged anywhere (grep clean). (PASS.)
- **Windows-first spawn:** `core/proc.mjs` spawns real exes with argv (no shell), unwraps npm
  `.cmd` shims to `node <entry>` (`spawnCli`/`resolveNpmShim`), and only falls back to a shell
  with escaped args for an un-unwrappable `.cmd`, guarded by `assertShellSafe`. (PASS.)
- **Event bus:** `core/bus.mjs` — `publish(type, data)` shape and a 2000-entry ring with SSE
  replay, exactly as documented. (PASS.)
- **Provider/worker contracts:** `providerFor` (`vendors.mjs:221`) and the anthropic/ollama
  modules produce the full `{id,label,kind,auth,detect,listModels,pollLimits}` shape;
  `runWorker` (`core/workers/index.mjs`) dispatches by `kind` to `runCodex/runClaude/
  runOpenAICompat/runImage/runVendorCli` and normalizes one result shape. (PASS, except #4.)
- **The budget gate is `admit`, wired once:** `admit` is defined in `core/sweep.mjs:148` and
  called from `core/tasks.mjs:179` `schedule()`; there is no competing planBatch-as-live-gate.
  (The only issue is the doc wording in #2.)
