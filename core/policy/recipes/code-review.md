---
id: code-review
types: [review]
audience: conductor
purpose: Evidence-led code review with adversarial verification
status: draft
---
Default method, not a rule set.

Use `docs/REVIEW-FRAMEWORK.md` for the full procedure; this is the short route through it.
Pin the review scope and commit or diff, then choose lenses that fit the surface: subsystem logic,
security, paths and interfaces, performance, external contracts, project rules, docs, and tests.
Run independent finders by lens. Require a final JSON block with this shape:
`{"findings":[{"id":"...","title":"...","file":"...","line":1,"severity":"high|medium|low|nit","kind":"defect|question|proposal|posture","detail":"...","evidence":"...","repro":"...","class":"...","siblings":[],"fix":"..."}]}`
Treat missing evidence or a missing findings block as an incomplete finder, not a clean result.

Run a dedupe stage across finder results before verification. Preserve distinct claims that happen
to share a file or title, and retain who found each one.
Give each actionable finding to a refuter from a different model family than its finder.
Set `avoid_families` so routing and failover cannot return to the finder's family.
Ask refuters to default to refuted, reproduce where feasible, judge impact, and return one verdict per finding.
Keep only findings that survive the evidence check; mark absent or failed verdicts unverified, never refuted.

Run one completeness critic against the lenses, scope, surviving findings, and files read: what lens
did not run, what claim lacks proof, what relevant file was missed, and what documentation now lies?
Verify any new finding by the same route.
Report the pinned scope, lenses and families used, surviving, refuted, and unverified findings,
what could not be executed, and whether the review's stated scope was covered.
