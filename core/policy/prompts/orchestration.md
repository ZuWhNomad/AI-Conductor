# Orchestration playbook (structure, not staffing)

This is a framework for *how* to approach non-trivial work. It never says which model does a step:
you choose every worker from the live registry, the limits, and the scorecard (or leave the slot
empty so the auto-pick fills it). Skip any step that a small task does not need — a one-file edit
is one `delegate` and a verification, nothing more.

## 0. Size the task first

Ask: how many files, how ambiguous, what is the blast radius, how easy is verification? Small and
clear → delegate directly. Large, ambiguous or risky → run the shapes below. Check `limits` before
committing to a wide fan-out; shift providers rather than stall.

## 1. Planner pass (optional; suggestion, not a rule)

For large or ambiguous work, spend one task on planning before any code: restate the goal, list
unknowns, decompose into independent units with acceptance criteria and verification commands,
and name the risky parts. A higher-tier model tends to pay for itself here because every later
task inherits the plan's quality — but that is your call per task, not a fixed rule. The plan is
an artifact: keep it in the chat and reuse it in specs.

## 2. Fan-out finders

Split a search (bugs, gaps, options, sources) into independent lenses — by subsystem, by concern
(correctness, security, performance, UX), by modality (read code, run it, grep history) — and run
them in parallel. Each finder returns structured findings (ask for a JSON block: title, location,
severity, evidence, proposed fix). Dedupe across lenses before spending anything on verification:
`run_plan` only merges exact duplicates, so when lenses overlap add a one-task "dedupe" stage that
reads `{{results:find}}` and returns the merged `findings[]`, then point the refuter stage at it.

## 3. Adversarial refuters

For each finding worth acting on, ask N independent workers to *refute* it ("default to refuted
unless the defect is unambiguous"), ideally with different lenses (read the code / reproduce it /
judge the impact). Keep what survives a majority. This is what separates real findings from
plausible ones; it is also where cheap models are most cost-effective.

## 4. Judge panel

When the solution space is wide (designs, approaches, rewrites), get several independent attempts
from different angles, have judges score them against explicit criteria, then synthesize from the
winner while grafting the best ideas of the runners-up. Beats iterating on a single attempt.

## 5. Loop-until-dry

For discovery of unknown size, keep running finder rounds — each told what was already found —
until K consecutive rounds add nothing new. Counting to a fixed N misses the tail; stop only when
the well is dry, and log what was deliberately left out (no silent caps). `run_plan` caps
`until_dry` loops at `max_rounds` (default 3): when the cap is reached while the last round still
produced fresh findings, the stage result includes `untilDry: { capped: true }` and the plan
report says so. Raise `max_rounds` or run another `run_plan` round when you see `capped: true`.

## 6. Completeness critic

Before reporting, one task asks: what is missing? A lens not run, a claim not verified, a file
nobody read, a doc that now lies. What it finds becomes the next round, or an explicit "left out"
line in the report.

## Running these shapes

`run_plan` executes stages deterministically (parallel tasks per stage, findings handed from stage
to stage, votes tallied, until-dry loops) so you spend one turn on the plan instead of dozens of
tool calls. You still write every spec and fill every provider/model/effort slot — or leave a slot
empty to let the auto-pick decide. `delegate`/`follow_up` remain right for single tasks and fix
rounds. Verify results yourself either way; a plan's report is evidence, not a verdict.
