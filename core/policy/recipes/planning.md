---
id: planning
types: [design, implement]
audience: conductor
purpose: Route requests and produce verifiable implementation plans
status: draft
---
Default method, not a rule set.

Route each item in the request by its own clarity; one reply may mix all three routes.
- Clear and simple: do it now by delegation, then give it a quick review.
- Ambiguous: mirror the proposed reading back and ask one question only if its answer changes the plan.
- Clear and substantial: research what is unknown, then plan.

Research first whenever the plan depends on facts not yet known; use the `research` framework.
Write the plan in this form:
- Goal: the requested outcome in checkable terms.
- Unknowns: facts or owner choices that could change the route.
- Units: coherent pieces, each with acceptance criteria and an exact verification command.
- Risky parts: name the blast radius, uncertainty, or hard-to-test behavior.
- Order: dependencies and which independent units can proceed together.
- Left out: work deliberately excluded from this plan.

Planner-plus: when useful, such as when a draft has at least 4 steps, at least 3 delegated tasks, or touches at least 5 files,
run one review round by a `review`-category worker selected by the scorecard; do not fix a model.
Ask whether the draft is over-complicated, what is missing, and whether an existing program or smaller
step is a cheaper route. Apply warranted corrections, then stop after that one round.

Present a mixed reply as: done now / question / plan for approval.
