# test/smoke/ — tests for core/smoke/ (the self-check battery)

Start with `../CONTEXT.md` (layout, isolation, `_env.mjs`) and the root `AGENTS.md`. Import `../_env.mjs` first.

**What this is not.** It does **not** run the battery against real models — that costs money and needs logins. It
tests the battery's own machinery: that every fixture has a `setup`/`spec`/`check`/`solve`, that `solve()` makes
`check()` pass (a fixture whose check cannot be satisfied would score every model zero), and that results land in the
scorecard in the shape `recommend()` expects. For levels 6-7 it also proves the graders bite: every mutant in
`core/smoke/private/` fails and every variant passes; the canary, the neutral scratch names and titles, the level-7
timeout, routing ignoring difficulty > 5 and the L6/L7 rows in the scores table have their own tests. Mutants that fail only by timing out (about 20-60 s each) run
only with `CONDUCTOR_SMOKE_SLOW=1`; refactor-6's untouched-fixture proof alone costs about 20-30 s.

Running the real thing is a deliberate, paid act: `node bin/conductor.mjs smoke --tasks <ids>`.

**Invariant.** A new battery fixture ships with its `solve()` in the same commit. Deterministic `check()` first; a
judge pass only where quality is genuinely subjective.
