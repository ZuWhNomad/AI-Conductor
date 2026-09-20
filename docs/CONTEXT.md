# docs/ — product documentation only

**New here? Read the root `AGENTS.md` first** (repo rules). This folder is **product** documentation: what the thing
is and how to use it. The **project** — plans, reviews, backlogs, research, dated logs — lives in the user's notes
location and **never in this repo**. A hygiene test fails the build if notes appear here.

The line to apply: *would a stranger who cloned this repo need it?* Yes → `docs/`. No (it is about how we decided,
what to do next, or what went wrong on one machine) → the notes location.

| file | is |
|---|---|
| `ARCHITECTURE.md` | The codebase overview: goal, how it works, directory map, external programs. **Current state only** — update it in the same commit as the change it describes. |
| `DRIVE-CONDUCTOR.md` | How another agent drives a running Conductor over HTTP. No machine-specific values. |
| `REVIEW-FRAMEWORK.md` | How a review pass is run (the method, not any one review's findings). |
| `ROADMAP-capabilities.md` | Where the capability index is going. |
| `video-briefing-finance-prompt.md` | Operator-facing prompt that pairs with `core/policy/recipes/video-briefing-finance.md`. |

**Invariants.** No absolute paths, user names, machine names or e-mail addresses — the hub's leak hook rejects a push
that carries them. No dated "what we did" entries: that is the project log's job.
