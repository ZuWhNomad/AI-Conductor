# Conductor review framework

How the conductor reviews a codebase (its own, or any project). Convergence-gated, multi-lens, multi-model.
The efficacy comes from three mechanics, in priority order: **fix between passes**, **lens + general together**,
**rotate models across rounds**. It is capped by convergence and protected by two guardrails, so it hardens code
in ~2 rounds instead of burning budget on diminishing returns.

## A round

1. **Lens fan-out** — several focused reviewers in parallel, each with one lens (below). Focused reviewers go deep
   where a generalist skims.
2. **Dedupe** — merge overlapping findings across lenses into one list before any fixing (the same issue surfaces
   from multiple lenses; fix it once).
3. **Verify before fixing** — each finding is confirmed (the reviewer rates confidence, or a quick adversarial
   check runs) *before* it is implemented. Fixing unverified findings is the main budget sink and the main source
   of fix-induced regressions — guard it hard.
4. **Fix** — implement only confirmed findings. Run the tests.
5. **General pass** — one whole-project reviewer reads the *fixed* code. Catches cross-cutting issues a lens
   misses: a security fix that dents the budget logic, an architectural smell, a regression the fixes introduced.
6. **Fix** — implement confirmed general-pass findings. Run the tests.

Fixing between steps 4 and 5 is deliberate: the general pass reviews the post-fix state, so it catches what the
fixes broke.

## The lenses

- **Security** — auth, secrets, injection surfaces, the worker shell boundary, redaction.
- **Hardcode → dynamic** — magic values / identities / paths that should be configurable; distinguish "genuinely
  should be tunable" from "fine as a constant" (don't propose churn).
- **Framework / guidelines** — adherence to CLAUDE.md and docs/ARCHITECTURE.md (ESM, no build, the provider /
  worker / events / secrets contracts).
- **General correctness & design** — bugs, edge cases, coherence across modules.
- **Budgeting & model selection** — the sweep planner, `admit`, scorecard `recommend`, failover, per-window logic.

## Model rotation

Different models have different blind spots (observed: Grok reproduced the scheduler stall by probing; Opus found
the benchmark gate was hollow; each caught what the others missed). Rotate the reviewer models **across rounds**,
not within one — round 1 Opus lenses, round 2 (if needed) a Grok + Astra sweep. Diversity pays for the first two
rounds; by round three the same models mostly repeat themselves.

## Convergence (when to stop)

Do **not** pre-commit to a fixed number of rounds. Stop when a general pass returns **no confirmed high/medium
findings**. In practice:

- Round 1 gets the substantive issues.
- Round 2 gets fix-induced regressions plus subtler issues; run it only if round 1's general pass surfaced
  material problems, and rotate models.
- Round 3 is usually nits, style opinions, and a rising false-positive rate — more passes stop removing risk and
  start adding it (rewrite-of-fine-code churn, reviewer disagreement). Reach round 3 only with cause.

## Budget

Reviews are read-only and bounded — cheap. The cost is the *fix* cycles and re-review. Keep it efficient by
(1) capping at convergence, (2) deduping before fixing, (3) verifying before fixing. With those, a full multi-lens
+ general + rotation pipeline is a normal 2-round hardening, not overkill. Without them, it burns budget on
diminishing — sometimes negative — returns.

## Provenance

Adopted 2026-09-13 after a manual instance of exactly this loop: Opus + Grok + Astra reviews of Conductor 2.0 and
the cookiebench benchmarks, fixes between each, converging on a clean pass. A runnable pipeline (fan out the lenses
through the conductor API, dedupe, verify, report, gate on convergence) is the natural next build.
