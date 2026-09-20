# scripts/ — build helpers, not the app

**New here? Read the root `AGENTS.md` first** (repo rules). Plans, reviews and working notes belong in the user's
notes location, **never in this repo** — a hygiene test enforces it.

**Purpose.** Things that produce an artefact in the repo. Today one: `build-launcher.cmd`, which compiles
`Conductor.exe` (repo root) from `launcher/Conductor.cs` using the C# compiler that ships with Windows — no SDK, no
network, no new dependency. Run it only when the launcher source changes; the built `.exe` is committed.

**Invariants.**
- Nothing here runs at app start-up or on a user's machine. If it needs to run when Conductor runs, it belongs in
  `core/` or `bin/`.
- No new toolchain. The rule that keeps this buildable on a stock Windows box is "use what the OS already has".

**How to test.** Run `scripts\build-launcher.cmd`, then start the produced `Conductor.exe`: it should open the UI on
the configured port. Nothing here is covered by `npm test` (it builds a native binary), so it is checked by hand.
