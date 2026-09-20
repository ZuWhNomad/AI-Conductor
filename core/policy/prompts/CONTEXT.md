# core/policy/prompts/ — what the conductor and workers are told

**New here? Read the root `AGENTS.md` first** (repo rules), then `docs/ARCHITECTURE.md`. Plans, reviews, backlogs and
working notes belong in the user's notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** Text only, no code. Behaviour changes here cost no tokens to review and no restart to reason about.
`conductor.md` + `orchestration.md` are the always-loaded system prompt for every conductor; `conductor-codex.md` and
`conductor-loop.md` are the per-runtime additions; `worker.md` and `msw.md` go to delegated workers.

**Invariants.**
- **Always-loaded text is paid for on every session.** Anything that matters only for one kind of work belongs in a
  looked-up recipe (`../recipes/`), not here.
- Runtime-specific files say only what differs for that runtime; shared rules stay in `conductor.md`.
- Never name a path, a machine or a vendor key here: these files ship to every user.
- A tool named in a prompt must exist in `core/tools.mjs` — a hand-kept tool list rots (one was deleted for that).

**How to test.** `test/context.test.mjs` (injection and budgets), `test/hygiene.test.mjs` (recipe and capability
budgets). A prompt change is a behaviour change: A/B it (`WORKSPACE.md` has the recipe) before keeping it.
