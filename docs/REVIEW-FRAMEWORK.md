# Conductor review framework

How the conductor runs review passes on a codebase, its own or any project's. `orchestration.md` has the generic
shapes and `run_plan` runs them. What makes it work, in priority order: **fix between passes**, **lenses plus a
general pass**, **different model families, kept independent**, **verify on evidence before fixing**. Examples name
Conductor's own files; for another project use its equivalents. `conductor review` and `POST /api/review` are the
improvement-log self-review, not this.

## Before a round

- **Pin the commit.** Record `git rev-parse HEAD`; every finding is against it.
- **Where stages run.** In the project's working clone, which is the chat's cwd. Stages go through `delegate` and
  `run_plan`. Change nothing there until verification ends. No extra copy is needed: the remote is the backup. The
  code under review must not be the code that is running (Conductor, for example: review the dev clone; the
  conductor runs from a separate installed copy). A project that runs from the clone under review reviews a
  detached worktree instead (`git worktree add --detach <path> <sha>`, then install its dependencies).
- **No stray writes.** Every review spec says: do not modify files or commit, do not read earlier review reports,
  stay out of `.state/` (a dev checkout's live state). Not every runner enforces `sandbox: "read-only"`, so compare
  `git status --porcelain --ignored` and a `.state/` listing (porcelain hides ignored folders' contents) before and
  after every stage. Revert anything unexpected before the next stage and note which runner wrote it.
- **Run code only in isolation.** Use `sandbox: "workspace-write"` in the clone (read-only removes exec), its own
  state dir and a free port, never the user's live instance or state. Conductor, for example:
  `CONDUCTOR_NO_POLL=1 CONDUCTOR_HOME=<temp dir> node bin/conductor.mjs start --port <free> --no-open`
  (otherwise it uses the clone's live `.state/`, or can auto-update the clone off the pinned commit); drive the UI
  headless as `test/ui/layout.test.mjs` does. It uses the host's signed-in CLIs: start worker tasks on it only when
  budgeted, and test update or relaunch only on purpose. Under the Codex sandbox keep temp and state dirs inside the
  clone in an ignored folder (system temp fails with EPERM), and remove them after the stage. The full test suite
  can stall under that sandbox: run it from another worker or yourself. A test failure seen while reviewers share a
  checkout is a finding only if it reproduces alone.
- **Ledger and decisions.** Read the target's ledger in the notes location the user names; re-verify its open,
  partial and deferred items first. Every finder and verifier spec gets the accepted risks, user decisions and
  deliberate deferrals: decisions only, never earlier findings. A settled item is re-raised only with new evidence.
- **Size it.** Check `limits`, and `model_scores` with `category: "review"`. Finding and verifying cost more than
  fixing: when budget is tight, group small lenses into one finder. A plan runs at most 200 tasks. Its
  `timeout_minutes` (default 45) is one deadline per stage, not reset by failover: raise it for long lenses. Each
  worker run is also killed at `worker.timeoutByCategory.review`, else `worker.timeoutMinutes` (45). No tool sets
  those and the Settings page shows only the latter: ask the user to raise them first (`POST /api/settings` with
  `{"worker":{"timeoutByCategory":{"review":<minutes>}}}`).

## A round

1. **Find.** Read-only lenses as one `run_plan` stage, `tasks[]` one per lens; code-running lenses as
   `workspace-write` `delegate` tasks alongside. Pin `provider`/`model`/`effort` so the finders span at least two
   families, and tag every review task `category: "review"` with a `difficulty` (failover and the review timeout
   need it). On "still running", poll `plan_status` with the `plan_id`. A lens with a `! task <id> <status>` line,
   or with no fenced findings block (it becomes one pseudo-finding), did not run: re-run it. An `Incomplete` stage
   keeps no findings at all: read each finished finder with `task_status` and re-run only the unfinished ones.
2. **Dedupe** by hand from the plan's full record (the path after `Full record:`, or `plans/<plan_id>.json` in the
   Conductor state dir) and the delegated tasks' reports, not from `{{results:<stage>}}` (some fields only, cut at
   4000 characters); for reviews this replaces the dedupe stage of `orchestration.md` §2. `run_plan` merges findings
   that share a file and the first 60 characters of title, even distinct ones: first count each finder's raw
   findings (`task_status`) against the record. "Found by" follows each finding's `source` through the `tasks:`
   line's failover chain to the model that ran.
3. **Verify** high and medium findings (below). Then a **critic**: one read-only task, given the lenses run, the
   module map and the verified list, asks which lens did not run, which module nobody read, which claim is
   unverified, which doc now lies. Its findings are verified the same way.
4. **Fix**, then **general passes** until clean (Convergence). Fixing first is deliberate: the general pass reviews
   the post-fix state, so it catches what the fixes broke.
5. **Report** and update the ledger.

## Lenses

Core lenses run on every codebase review; project lenses where the target has that surface. Lenses marked
*(runs code)* run in isolation (Before a round).

Core:
- **Subsystems (logic flaws)** — one lens per module in the target's module map (its architecture or `CONTEXT.md`
  docs), each applying the logic checklist below plus the performance and one-source-of-truth checks. These find
  most of the unique high and medium findings. The highest-stakes logic gets its own lens with probes *(runs code)*
  (Conductor: budget gate, routing, failover, per-window limits).
- **Security** — threat model first. Actors: a prompt-injected worker or agent, a same-user process, a cross-site
  page, a hand-edited file. Trace all they can write to every place the host later trusts (config, git config and
  hooks, `import()`, shell). Request gates with headers missing; path forms (UNC, 8.3 short names, case, trailing
  dot); secrets in errors and logs; deny lists by name, not pattern. Set `kind` to `defect` or `posture`.
- **Broken paths and buttons, static** — every UI control, CLI command, API route and tool traced to its handler:
  payload shapes, errors caught and shown, double submit, UI defaults equal to server defaults. Equivalent paths
  (auto/manual, UI/CLI/route/tool, docs/UI) behave the same.
- **Broken paths and buttons, live** *(runs code; runnable targets)* — on an isolated instance, run every command
  and route and click every button headless; then degraded and lifecycle states: invalid or BOM config, stale pid,
  quit, restart with work in flight, update or relaunch mid-operation, failed create, permission denied. A
  "healthy" claim names what it tested.
- **Performance** — every finding carries a number (ms of event-loop block, bytes, call counts) at the sizes the
  conductor puts in the spec (task journal, ledger rows, chat length; it measures them read-only) and at 10x. Look
  for sync calls on request and timer paths and per-request work that grows with history.
- **Improvements, docs and tests** — simpler code; dead code (search the docs for external consumers first); one
  source of truth: a value stated in several places (literals, `||`/`??` fallbacks, UI defaults, prompts, docs),
  ranked by what breaks when the copies diverge; a new setting only with a case where today's value is wrong. Docs
  agents execute and prompts models act on, checked and rated like code. Tests that pin a bug, were weakened, or
  miss a path.

Project:
- **External contracts and platform** *(runs code)* — each CLI, SDK and API parser against the installed version's
  real output (warnings, errors, encodings), fixtures recorded; Windows encodings, BOMs and quoting; POSIX process
  groups.
- **Project rules** — the target's agent, contributor and architecture docs. A violation's fix adds a test that
  enforces the rule, so no lens checks it by hand again.
- **Verdict machinery** *(runs code)* — graders, gates, tallies (Conductor: `run_plan`, the tools, the scorecard):
  run the real one on the cheapest input that should fail and one that should pass.

**Logic checklist.** Runs twice at once; stopped, deleted or restarted halfway. Success read as failure (warnings,
limit messages). Errors, warnings and encoding variants in external or model output. Units (ms vs s, time zones)
and timers past 2^31 ms. Tool, route or CLI input not checked against an enum or range. A fallback or default that
gets around a rule. Waits, timeouts and caps that disagree across layers.

## Findings and severity

Finders end with this block (`run_plan` reads the last fenced `findings[]`). Ids are a lens prefix plus a number;
the ledger key adds a review tag (for example `R3-S1`).

```json
{"findings":[{"id":"S1","title":"…","file":"path/to/file","line":42,"severity":"high|medium|low|nit",
  "kind":"defect|question|proposal|posture","detail":"the claim","evidence":"quoted code, or command and output",
  "repro":"reproduced: <cmd> | traced | not run: <why>","class":"the pattern, and the search that finds its siblings",
  "siblings":["file:line, including equivalent paths"],"fix":"proposed change"}]}
```

- **High**: default config, normal path: loses work or data, runs commands on the host, crashes, gives a wrong
  result, or blocks a whole feature or provider.
- **Medium**: a real bug on a plausible path with a narrower trigger, an opt-in security path, or a measured
  inefficiency users feel.
- **Low**: doc drift, malformed hand edits, speculative inputs. **Nit**: style; reported, never sent to a fix worker.

Finder labels are input: the verifier sets severity after reproducing, recorded as `final: <severity>, set by
<provider:model:effort | conductor>`, with any disagreement.

## Verify

- **Cross-family.** A finding's verifier comes from a family that did not find it; a family verifying its own
  findings almost never refutes them. Self-rated confidence is not verification.
- **Tiered.** High and medium: one verifier from a family that did not find them, in batches of about 10–20
  findings per task. No third-family tiebreak: the conductor resolves a doubtful verdict itself, since it reads
  every diff afterwards. Low: no verification stage; the fix worker confirms each one before changing code and
  reports those it cannot reproduce, which are dropped. Nits never go to workers.
- **Batches, not votes.** Verifiers reproduce, so they run as `delegate` tasks with `workspace-write`; a target
  with nothing to run can use one read-only `run_plan` `tasks[]` stage. Do not use `for_each` votes here: the tally
  keeps a 200-character reason, reads `partial` as refuted, and one failed voter ends the plan with no verdicts.
- **Verifier spec.** Default to refuted. Reproduce when feasible (a script under the
  isolated state dir; the installed CLI or SDK for any claim about an external tool). Check intent with
  `git log -S` or blame and the decisions list: a fix that would undo a deliberate change goes to the user. Say
  whether the code or the doc is wrong. Judge the proposed fix: would it work, what would it break; a fix to a
  security filter gets a bypass attempt.
- **Verifier output.** A final fenced `{"findings":[…]}` block with one entry per finding: `id`, `file`, `title`,
  `real` (true or false), `severity`, `fix` (safe, incomplete or unsafe) and `reason` (what ran, and why). A partial
  hold is `real: true` with the narrowed claim in `reason`.
- **Read the raw replies** of every high and medium before accepting a verdict; a report is evidence, not a verdict.
  Findings in = verdicts out: a finding with no verdict, or whose verifier died, is unverified, never refuted.

## Fix

- **Triage.** Only verified defects and low defects go to fix workers. Questions and posture items go to the user
  once, with options (for example off / allow-list / on), instead of being hardened a little each round. Proposals
  go to the ledger. A refactor with no behaviour change defaults to "not now".
- **Fix the class.** The spec carries the finding, the verifier's notes, the class and its sibling search, "fix
  every hit", "do not commit" and the project's rules; for a low, "confirm it first and report it if it does not
  reproduce". Fixes are fresh `delegate` tasks in the working clone (`sandbox: "workspace-write"`), not
  `follow_up`s of review threads. A change to documented behaviour edits the doc in the same commit.
- **Read every diff before committing.** Batch by disjoint file sets; concurrent tasks in one cwd show up in each
  other's changed files, so read `git diff` per batch. Workers leave changes uncommitted (a worker's commit empties
  the diff stat); the conductor commits. An existing assertion changes only when the finding says the test pins the
  bug; no file outside the finding's scope changes; the project's rules hold. Every commit is green: test HEAD plus
  only that batch's files and check the exit code, not the summary.
- **Close an item** only when its reproduction passes, its sibling search is clean, and a model other than the
  fixer confirmed the change meets the claim text. A fix checked only against mocks or `--help` stays "partial,
  live unverified" until one real run succeeds. `rate_task` each fix task.

## Models

- Choose from `list_models`, `limits` and `model_scores`; no fixed picks. Families have different blind spots and
  between them the reviewers cover most errors, so finders, verifiers and general passes mix families. Name every
  model by exact `provider:model:effort`.
- **Failover stays off the review's families.** Failover (tasks with `category` and `difficulty`) replaces a pinned
  model at a provider limit with another provider's. Reviewers and verifiers pass `avoid_families` (on `delegate`
  and on `run_plan` tasks): the finder's family and their own, so failover never lands on a family already on the
  review; when nothing outside them qualifies, the task parks until the reset.
- **Check what ran** anyway. Plan report stage lines read `<id> -> <failoverId>[status] provider:model:effort`;
  failover titles start `FAILOVER: `; `await_task` and `list_tasks` show each task's model. Re-run or re-verify a
  stage that changed family. Without `difficulty` a limit parks the task instead; if it cannot resume before the
  stage deadline, the stage ends incomplete and the run is not scored.

## Convergence

- **Fix cycle.** After each fix phase, re-pin at the new HEAD. A general pass reads `<base>..HEAD` plus
  everything that consumes what changed; its findings are verified like any other. Tell it the shapes fixes break:
  sync to async (re-entrancy, overlap), parser changes (complexity, old inputs), new counters or guards (stuck
  states), broader lookups (security), batch seams. The first pass runs on two families, reruns every sibling
  search, rechecks each "fixed" claim against its claim text, and live-smokes the fixed behaviour.
- Repeat until a pass confirms no high or medium. No fixed count: plan for up to about five diff-scoped passes;
  late ones still find real mediums. The pass that declares convergence is a fresh task (not a `follow_up`) from a
  different family than the pass before. A module with findings in two consecutive passes, or in three or more
  reviews, gets a design review (state table, invariants, regression or property tests) instead of another patch.
- **Reviews.** A converged fix cycle means the fixes are clean, not the codebase. The codebase is converged when an
  independent review (new model set, started after the previous fixes, no earlier findings in its specs) confirms
  no high or medium. Propose one release per converged fix cycle; merging, pushing and starting the next
  independent review are the user's call, and the report recommends them.
- **A budget stop** leaves a handoff: open and unverified items, and the unreviewed fix commits `A..B`, which the
  next session's first general pass covers.

## Report and ledger

The report goes to the notes location the user names, never into the reviewed repo; if the conductor cannot write
there, the report is its final message. It states the pinned commit, every model as dispatched, lenses run and not
run, what could not be executed, and counts; findings with final severity, who set it and who found them; refuted,
unverified and dropped lows listed separately; decisions for the user; the comparison with the previous review
(also found, still present, follow-on gaps from its fixes, new, missed); the fix record. Never "clean": say which
families reviewed and whether the fix cycle converged.

The ledger is one file per target in the same place. Each entry: key, severity, status (open, partial, fixed,
accepted-risk, refuted, deferred), fix commit, verified by. A deferral records the measured number and the size at
which to revisit it. Residuals and nits go on the ledger, not only into report text.

## Other targets

- **Plans and designs** — one parallel pass, no fix loop, three roles: flaws and blockers (assumptions checked
  against the code), a simpler alternative, reductions (delete rather than move). Adopt where reviewers agree.
- **Recipes and prompts** — wiring (who gets it, size against caps), the authority it grants, inputs that yield a
  confident wrong answer, A/B arms that differ only in the edit under test.

Provenance: refined from repeated multi-model reviews of this repo.
