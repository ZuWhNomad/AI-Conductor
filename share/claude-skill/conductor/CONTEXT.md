# share/claude-skill/conductor/ — the /conductor Claude Code skill template

**New here? Read the root `AGENTS.md` first** (repo rules). Notes and plans live in the user's notes location, not here.

**Purpose.** `SKILL.md` is a machine-neutral template of a Claude Code skill that drives Conductor over its HTTP API.
`{{CONDUCTOR_DIR}}` is replaced with the install folder by the one-line install in `docs/DRIVE-CONDUCTOR.md`.

**Invariants.**
- No machine paths or personal names in the template; only `{{CONDUCTOR_DIR}}`.
- The install copies `SKILL.md` alone; keep anything else in this folder out of the installed skill.
- The API it describes must match `docs/DRIVE-CONDUCTOR.md` and `server/index.mjs`.

**How to test.** Run the install line from `docs/DRIVE-CONDUCTOR.md`, then ask Claude Code to "use the conductor".
Not covered by `npm test`.
